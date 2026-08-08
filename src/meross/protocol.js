// -----------------------------------------------------------------------------
// Meross wire protocol: message envelope, signature, and the vocabulary
// (namespaces, methods) shared by BOTH transports.
//
// Meross devices speak the exact same JSON envelope whether it arrives over the
// cloud MQTT broker or over a direct HTTP POST on the LAN. That is what makes
// the dual-channel design possible: only the pipe changes, never the message.
//
//   {
//     "header": {
//       "messageId": "<32 hex chars>",
//       "namespace": "Appliance.Control.ToggleX",
//       "method": "SET",
//       "payloadVersion": 1,
//       "from": "/app/<userId>-<appId>/subscribe",
//       "timestamp": 1699999999,
//       "timestampMs": 0,
//       "sign": md5(messageId + key + timestamp)
//     },
//     "payload": { ... }
//   }
//
// The `key` is the per-account secret returned by the cloud login. A device
// only accepts messages signed with the key of the account it is bound to,
// which is why local control still requires a one-time cloud login.
//
// This module is pure (no I/O): it is the piece the unit tests pin down.
// -----------------------------------------------------------------------------

import { createHash, randomUUID } from 'node:crypto';

/** Namespaces used by this integration. */
export const NAMESPACE = {
  // System
  SYSTEM_ALL: 'Appliance.System.All',
  SYSTEM_ABILITY: 'Appliance.System.Ability',
  SYSTEM_ONLINE: 'Appliance.System.Online',
  // Actuators
  CONTROL_TOGGLE: 'Appliance.Control.Toggle',
  CONTROL_TOGGLEX: 'Appliance.Control.ToggleX',
  CONTROL_LIGHT: 'Appliance.Control.Light',
  GARAGE_DOOR_STATE: 'Appliance.GarageDoor.State',
  // Measurements
  CONTROL_ELECTRICITY: 'Appliance.Control.Electricity',
  CONTROL_CONSUMPTIONX: 'Appliance.Control.ConsumptionX',

  // Hubs (MSH300, MSH400...). A hub is a gateway: it owns no feature of its
  // own, it relays the state of the battery sensors and valves paired to it.
  // Every hub namespace carries an ARRAY of per-sub-device objects keyed by
  // `id` — where the other namespaces use `channel`.
  HUB_ONLINE: 'Appliance.Hub.Online',
  HUB_TOGGLEX: 'Appliance.Hub.ToggleX',
  HUB_BATTERY: 'Appliance.Hub.Battery',
  HUB_SUBDEVICE_LIST: 'Appliance.Hub.SubdeviceList',
  HUB_SENSOR_ALL: 'Appliance.Hub.Sensor.All',
  HUB_SENSOR_TEMPHUM: 'Appliance.Hub.Sensor.TempHum',
  HUB_SENSOR_ALERT: 'Appliance.Hub.Sensor.Alert',
  HUB_SENSOR_WATERLEAK: 'Appliance.Hub.Sensor.WaterLeak',
  HUB_MTS100_ALL: 'Appliance.Hub.Mts100.All',
  HUB_MTS100_TEMPERATURE: 'Appliance.Hub.Mts100.Temperature',
  HUB_MTS100_MODE: 'Appliance.Hub.Mts100.Mode',

  // Watering timers (MST100 behind an MSH400/MSH450 sprinkler hub).
  CONTROL_WATER: 'Appliance.Control.Water',
};

/**
 * Starting a watering, as captured from the Meross Android app:
 *
 *   POST http://<hub-ip>/config
 *   namespace: Appliance.Control.Water, method: SET
 *   { "control": [ { "channel": 0, "dura": 900, "onoff": 1, "subId": "<id>" } ] }
 *
 * Three details break every reasonable guess, which is why this namespace could
 * not be reverse-engineered by probing:
 *   - the payload key is `control`, NOT `water` after the namespace;
 *   - the sub-device is addressed by `subId`, NOT by `id` like every hub
 *     namespace;
 *   - stopping uses onoff: 2, NOT 0. Sending 0 is not "stop".
 * `dura` is the watering duration in SECONDS, and is omitted when stopping.
 */
export const WATER_ONOFF = {
  START: 1,
  STOP: 2,
};

/**
 * Build the `Appliance.Control.Water` payload.
 *
 * @param {object} options
 * @param {string} options.subId sub-device id of the timer
 * @param {number} [options.channel]
 * @param {number} [options.durationSeconds] required to start, omitted to stop
 * @param {boolean} options.start
 */
export function buildWaterControlPayload({ subId, channel = 0, durationSeconds, start }) {
  const entry = {
    channel,
    onoff: start ? WATER_ONOFF.START : WATER_ONOFF.STOP,
    subId,
  };

  if (start) {
    entry.dura = Math.round(durationSeconds);
  }

  // Field order mirrors the app's own request; harmless, but it keeps a capture
  // diff readable when comparing against a future firmware.
  return { control: [start ? { channel, dura: entry.dura, onoff: entry.onoff, subId } : entry] };
}

/** Prefix shared by every hub namespace. */
export const HUB_NAMESPACE_PREFIX = 'Appliance.Hub.';

/**
 * Hub payloads are `{ <key>: [ { id, ... }, ... ] }`. This maps a namespace to
 * the key its array lives under, so one merge routine handles them all.
 */
export const HUB_PAYLOAD_KEYS = {
  [NAMESPACE.HUB_ONLINE]: 'online',
  [NAMESPACE.HUB_TOGGLEX]: 'togglex',
  [NAMESPACE.HUB_BATTERY]: 'battery',
  [NAMESPACE.HUB_SENSOR_ALL]: 'all',
  [NAMESPACE.HUB_SENSOR_TEMPHUM]: 'tempHum',
  [NAMESPACE.HUB_SENSOR_ALERT]: 'alert',
  [NAMESPACE.HUB_SENSOR_WATERLEAK]: 'waterLeak',
  [NAMESPACE.HUB_MTS100_ALL]: 'all',
  [NAMESPACE.HUB_MTS100_TEMPERATURE]: 'temperature',
  [NAMESPACE.HUB_MTS100_MODE]: 'mode',
};

/**
 * Namespaces that address a hub SUB-DEVICE without living under
 * `Appliance.Hub.*`, and the payload key each one uses.
 *
 * They break both conventions at once, which is what made them unreadable by
 * guesswork: `Appliance.Control.Water` carries a `control` array — not `water`
 * after the namespace — and targets the sub-device by `subId`, not `id`.
 *
 * (Cross-checked against the meross_lan project, which drives the same
 * hardware: https://github.com/krahabb/meross_lan)
 */
export const HUB_SUBID_PAYLOAD_KEYS = {
  [NAMESPACE.CONTROL_WATER]: 'control',
  'Appliance.Control.WaterEvent': 'control',
  'Appliance.Control.WaterEvent.Skip': 'control',
  'Appliance.Control.WaterPlan.Skip': 'control',
  'Appliance.Digest.WaterPlan': 'digest',
  'Appliance.Control.Sensor.LatestX': 'latest',
};

/** The key a namespace uses to name a sub-device: `subId` for these, `id` elsewhere. */
export const SUB_DEVICE_ID_KEY = 'subId';

/** True when a namespace addresses sub-devices by `subId`. */
export function isSubIdNamespace(namespace) {
  return namespace in HUB_SUBID_PAYLOAD_KEYS;
}

/** True for any `Appliance.Hub.*` namespace. */
export function isHubNamespace(namespace) {
  return typeof namespace === 'string' && namespace.startsWith(HUB_NAMESPACE_PREFIX);
}

/**
 * Namespaces a device answers with when it REFUSES a message.
 *
 * A refusal is not an HTTP error and not a timeout: the device replies
 * promptly, with a normal envelope, carrying an error namespace. Treating that
 * as a success is the worst possible outcome — the command silently does
 * nothing while Gladys shows it as applied.
 */
export const HUB_EXCEPTION_NAMESPACE = 'Appliance.Hub.Exception';

export function isErrorNamespace(namespace) {
  if (typeof namespace !== 'string') {
    return false;
  }
  return namespace === HUB_EXCEPTION_NAMESPACE || namespace.endsWith('.Error');
}

/**
 * The OTHER way a device says no: it echoes the namespace you asked for and
 * puts the failure in the payload — `{ "error": { "code": 5000 } }`.
 *
 * This is the sneakier of the two. The reply looks entirely normal: right
 * namespace, right messageId, valid signature. Only the body says it failed, so
 * a client that trusts the envelope reports success for a command that did
 * nothing.
 *
 * @returns {{ code: number } | null} the error, or null when the payload is fine
 */
export function readPayloadError(payload) {
  const error = payload?.error;
  if (error && typeof error === 'object' && error.code !== undefined) {
    return error;
  }
  return null;
}

/**
 * Best guess at the payload key a namespace uses, derived from its last
 * segment. Meross is inconsistent — `ToggleX` carries `togglex` while
 * `Electricity` carries `electricity` — so both the camelCase and the
 * all-lowercase spellings are worth trying.
 *
 * @returns {string[]} candidate keys, most likely first
 */
export function namespacePayloadKeys(namespace) {
  // A key confirmed against real hardware beats any derivation.
  const known = HUB_SUBID_PAYLOAD_KEYS[namespace];
  if (known) {
    return [known];
  }

  const last = String(namespace).split('.').pop() ?? '';
  if (!last) {
    return [];
  }
  const camel = last.charAt(0).toLowerCase() + last.slice(1);
  const lower = last.toLowerCase();

  const keys = camel === lower ? [camel] : [camel, lower];

  // `Appliance.Control.Sensor.LatestX` is read with a `latest` key: the trailing
  // X marks the namespace revision, not always the payload key.
  if (/X$/.test(last)) {
    keys.push(last.slice(0, -1).charAt(0).toLowerCase() + last.slice(1, -1));
  }

  return keys;
}

/**
 * Hub sensors report temperatures and humidities in TENTHS of a unit
 * (231 -> 23.1 °C, 546 -> 54.6 %).
 */
export function fromDeciUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.round(number) / 10;
}

/** Inverse of `fromDeciUnit`, for the values we send back to a valve. */
export function toDeciUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.round(number * 10);
}

export const METHOD = {
  GET: 'GET',
  SET: 'SET',
  PUSH: 'PUSH',
  SETACK: 'SETACK',
  GETACK: 'GETACK',
};

/**
 * Bitmask of `light.capacity`, telling which light channels the bulb accepts.
 * A bulb reporting capacity 5 (RGB | LUMINANCE) has color + brightness but no
 * white-temperature channel.
 */
export const LIGHT_CAPACITY = {
  RGB: 1,
  TEMPERATURE: 2,
  LUMINANCE: 4,
};

/** md5 hex digest, the only hash Meross uses. */
export function md5(input) {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

/** A fresh 32-hex-char message id, used to correlate a reply with its request. */
export function generateMessageId() {
  return md5(randomUUID());
}

/**
 * Signature of one message: md5(messageId + key + timestamp).
 * @param {string} messageId
 * @param {string} key account key returned by the cloud login
 * @param {number} timestamp unix seconds
 */
export function signMessage(messageId, key, timestamp) {
  return md5(`${messageId}${key}${timestamp}`);
}

/**
 * Build a complete, signed Meross message.
 *
 * @param {object} options
 * @param {string} options.namespace one of NAMESPACE
 * @param {string} options.method one of METHOD
 * @param {object} [options.payload] namespace-specific body
 * @param {string} options.key account key
 * @param {string} [options.from] reply-to topic (MQTT); ignored over HTTP
 * @param {string} [options.messageId] forced id (tests)
 * @param {number} [options.timestamp] forced unix seconds (tests)
 */
export function buildMessage({
  namespace,
  method,
  payload = {},
  key,
  from = '',
  messageId = generateMessageId(),
  timestamp = Math.floor(Date.now() / 1000),
  uuid,
}) {
  return {
    header: {
      messageId,
      namespace,
      method,
      payloadVersion: 1,
      from,
      timestamp,
      timestampMs: 0,
      // Local requests from the app carry the target uuid; the signature does
      // not cover it, so adding it is safe and matches the captured traffic.
      ...(uuid ? { uuid } : {}),
      sign: signMessage(messageId, key, timestamp),
    },
    payload,
  };
}

/**
 * Check the signature of an INCOMING message (device -> us).
 *
 * Devices sign their pushes with the same account key, so an unsigned or
 * badly-signed message on the broker is either a foreign device or a spoof:
 * we drop it rather than publish a bogus state into Gladys.
 *
 * @param {object} message decoded message
 * @param {string} key account key
 */
export function isSignatureValid(message, key) {
  const header = message?.header;
  if (!header || typeof header.sign !== 'string') {
    return false;
  }
  return header.sign === signMessage(header.messageId, key, header.timestamp);
}

// --- Colors ------------------------------------------------------------------
// Meross encodes a color as a 24-bit integer, and so does Gladys
// (DEVICE_FEATURE_TYPES.LIGHT.COLOR): the two agree, so no conversion is
// needed. These helpers exist for the clamping/validation only.

/** Clamp an arbitrary number to a valid 24-bit RGB integer. */
export function toRgbInt(value) {
  const int = Math.round(Number(value));
  if (!Number.isFinite(int)) {
    return 0;
  }
  return Math.max(0, Math.min(0xffffff, int));
}

/** Split a 24-bit RGB integer into its components (used by the tests/logs). */
export function intToRgb(value) {
  const int = toRgbInt(value);
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

/** Build a 24-bit RGB integer from its components. */
export function rgbToInt({ r, g, b }) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
  return (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);
}

// --- Electricity -------------------------------------------------------------
// `Appliance.Control.Electricity` reports integers in sub-units: milliwatts,
// decivolts and milliamps. Converting here keeps the device layer readable and
// gives the tests one obvious place to pin the scaling down.

/**
 * Normalize an `electricity` payload into SI units.
 * @param {{ power?: number, voltage?: number, current?: number }} electricity
 * @returns {{ power: number, voltage: number, current: number }} W, V, A
 */
export function normalizeElectricity(electricity = {}) {
  return {
    power: round(Number(electricity.power ?? 0) / 1000, 2), // mW -> W
    voltage: round(Number(electricity.voltage ?? 0) / 10, 1), // dV -> V
    current: round(Number(electricity.current ?? 0) / 1000, 3), // mA -> A
  };
}

function round(value, decimals) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
