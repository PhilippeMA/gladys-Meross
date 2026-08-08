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
};

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
