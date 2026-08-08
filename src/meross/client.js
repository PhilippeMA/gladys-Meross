// -----------------------------------------------------------------------------
// The Meross client: one object the device layer can talk to without ever
// caring HOW a message reaches a plug.
//
// What it owns:
//   1. the session      — cloud login, token cached in the Gladys config so a
//                         restart does not burn a new one (Meross caps them);
//   2. the inventory    — the account devices, enriched with their abilities,
//                         their current state and their LAN address;
//   3. the routing      — local HTTP when the user prefers it AND the device
//                         actually answers on the LAN, cloud MQTT otherwise;
//   4. the truth about  — the effective transport per device, including the
//      the transport      "you asked for local, you got cloud, here is why"
//                         degraded state.
//
// Everything above the device layer therefore reduces to:
//   await client.request(uuid, NAMESPACE.CONTROL_TOGGLEX, METHOD.SET, payload)
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import * as cloudApi from './cloudApi.js';
import { MerossMqttClient, TIMEOUT_ERROR_CODE } from './mqttClient.js';
import { isReachable, localRequest } from './localClient.js';
import {
  HUB_PAYLOAD_KEYS,
  isHubNamespace,
  METHOD,
  NAMESPACE,
  namespacePayloadKeys,
} from './protocol.js';

const logger = createLogger({ name: 'meross-client' });

/** `onlineStatus` values of the cloud device list. */
export const ONLINE_STATUS = { ONLINE: 1, OFFLINE: 2 };

/**
 * Config keys used to cache the session. They live OUTSIDE `config_schema` on
 * purpose: the user never sees or edits them, they are written with
 * `gladys.setConfig()` and survive a container restart.
 */
export const SESSION_KEYS = {
  TOKEN: 'meross_token',
  KEY: 'meross_key',
  USER_ID: 'meross_user_id',
  MQTT_DOMAIN: 'meross_mqtt_domain',
};

/**
 * Namespaces worth reading when a device is not fully supported yet.
 *
 * The watering family belongs to the sprinkler hubs (MSH400/MSH450 driving
 * MST100 timers): a watering timer is not a plain relay, so its `togglex` alone
 * does not start a watering. These namespaces are where its real model lives,
 * and none of them is publicly documented — reading them is how support gets
 * written.
 */
export const PROBE_NAMESPACES = [
  'Appliance.Control.Water',
  'Appliance.Control.WaterEvent',
  'Appliance.Digest.WaterPlan',
  'Appliance.Config.WaterPlan',
  'Appliance.Control.Sensor.LatestX',
];

/**
 * Probes must not stall the diagnostic: a namespace that ignores us costs one
 * timeout per shape tried, and there are several shapes.
 */
const PROBE_TIMEOUT_MS = 6000;

/**
 * Request shapes to try when reading an undocumented namespace, most likely
 * first: a bare read, then the namespace's own key as an object, then as an
 * array (hub-style namespaces answer lists).
 */
export function probePayloads(namespace, subDeviceIds = []) {
  const payloads = [{}];

  for (const key of namespacePayloadKeys(namespace)) {
    // Hub namespaces all take an ARRAY of per-sub-device objects keyed by `id`.
    // A watering timer is a sub-device, so its namespaces most likely follow the
    // same convention — that is the shape worth trying before anything else.
    payloads.push({ [key]: [] });
    for (const id of subDeviceIds) {
      payloads.push({ [key]: [{ id }] });
    }
    payloads.push({ [key]: {} });
  }

  return payloads;
}

export class MerossClient {
  /**
   * @param {object} options
   * @param {(uuid: string, message: object) => void} [options.onPush] called on
   *   every real-time device message
   * @param {(partialConfig: object) => Promise<unknown>} [options.saveSession]
   *   persists the session (normally `gladys.setConfig`)
   */
  constructor({ onPush, saveSession } = {}) {
    this.onPush = onPush;
    this.saveSession = saveSession;

    /** @type {{ userId: string, key: string, token: string, mqttDomain: string } | null} */
    this.session = null;
    /** @type {MerossMqttClient | null} */
    this.mqtt = null;
    /** uuid -> device descriptor */
    this.devices = new Map();
    /** uuid -> { transport, degraded?, message? } */
    this.transports = new Map();

    this.baseUrl = cloudApi.REGION_ENDPOINTS.eu;
    this.preferLocal = true;

    // False until `start()` has completed. Caching the session calls
    // `setConfig`, which makes Gladys fire `onConfigUpdated` while we are still
    // starting up: this flag keeps that callback from acting on a client that
    // has no devices yet.
    this.ready = false;
  }

  // --- Session ---------------------------------------------------------------

  /**
   * Open a session: reuse the cached token when there is one, otherwise log in.
   * A cached token that the API rejects triggers exactly one fresh login.
   */
  async authenticate(config) {
    this.baseUrl = cloudApi.REGION_ENDPOINTS[config.region] ?? cloudApi.REGION_ENDPOINTS.eu;

    const cached = readCachedSession(config);
    if (cached) {
      logger.info('Reusing the cached Meross session');
      this.session = cached;
      try {
        // Cheapest call that proves the token is still valid.
        await cloudApi.listDevices({ baseUrl: this.baseUrl, token: cached.token });
        return this.session;
      } catch (err) {
        if (!(err instanceof cloudApi.MerossApiError) || !err.isTokenExpired) {
          throw err;
        }
        logger.info('Cached Meross session expired, logging in again');
      }
    }

    if (!config.email || !config.password) {
      throw new Error('Meross email and password are required');
    }

    this.session = await cloudApi.login({
      baseUrl: this.baseUrl,
      email: config.email,
      password: config.password,
    });

    await this.#persistSession();
    return this.session;
  }

  async #persistSession() {
    if (typeof this.saveSession !== 'function' || !this.session) {
      return;
    }
    try {
      await this.saveSession({
        [SESSION_KEYS.TOKEN]: this.session.token,
        [SESSION_KEYS.KEY]: this.session.key,
        [SESSION_KEYS.USER_ID]: this.session.userId,
        [SESSION_KEYS.MQTT_DOMAIN]: this.session.mqttDomain,
      });
    } catch (err) {
      // Not fatal: we simply log in again next start.
      logger.warn('Could not cache the Meross session', err);
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * Full start-up: authenticate, connect the broker, then enumerate and
   * describe every device of the account.
   *
   * @param {object} config normalized integration config
   */
  async start(config) {
    this.preferLocal = config.GLADYS_PREFER_LOCAL !== false;

    await this.authenticate(config);
    await this.connectMqtt();
    await this.refreshDevices();
    this.ready = true;
  }

  async connectMqtt() {
    if (!this.session) {
      throw new Error('Cannot connect to the broker before authenticating');
    }
    await this.disconnectMqtt();

    this.mqtt = new MerossMqttClient({
      domain: this.session.mqttDomain,
      userId: this.session.userId,
      key: this.session.key,
      onPush: (uuid, message) => this.#handlePush(uuid, message),
    });
    await this.mqtt.connect();
  }

  async disconnectMqtt() {
    this.ready = false;
    if (this.mqtt) {
      await this.mqtt.disconnect();
      this.mqtt = null;
    }
  }

  async stop() {
    await this.disconnectMqtt();
    // Release the token so the account does not accumulate dead sessions.
    if (this.session?.token) {
      try {
        await cloudApi.logout({ baseUrl: this.baseUrl, token: this.session.token });
        await this.saveSession?.({
          [SESSION_KEYS.TOKEN]: '',
          [SESSION_KEYS.KEY]: '',
          [SESSION_KEYS.USER_ID]: '',
          [SESSION_KEYS.MQTT_DOMAIN]: '',
        });
      } catch (err) {
        logger.warn('Could not close the Meross session cleanly', err);
      }
    }
    this.session = null;
  }

  // --- Inventory -------------------------------------------------------------

  /**
   * Enumerate the account devices and describe each one: what it can do
   * (abilities), where it is on the LAN, and its current state.
   */
  async refreshDevices() {
    const rawDevices = await cloudApi.listDevices({
      baseUrl: this.baseUrl,
      token: this.session.token,
    });

    this.devices.clear();

    for (const raw of rawDevices) {
      const device = {
        uuid: raw.uuid,
        name: raw.devName || raw.uuid,
        type: raw.deviceType,
        subType: raw.subType,
        // A single-channel plug reports one channel; a power strip reports its
        // master at index 0 followed by one entry per outlet.
        channelCount: Array.isArray(raw.channels) ? Math.max(1, raw.channels.length) : 1,
        channelNames: (raw.channels ?? []).map((channel) => channel?.devName || ''),
        online: Number(raw.onlineStatus) === ONLINE_STATUS.ONLINE,
        firmwareVersion: raw.fmwareVersion,
        hardwareVersion: raw.hdwareVersion,
        domain: raw.domain,
        ability: {},
        digest: {},
        ip: null,
        // Populated for hubs only: sub-device id -> { id, name, type, state }.
        subDevices: new Map(),
      };
      this.devices.set(device.uuid, device);
    }

    // Describing a device needs the broker. Without it — the "Test the
    // connection" button builds a client that never connects one — the
    // inventory alone is the answer, so skip straight to returning it.
    if (this.mqtt?.connected) {
      // Describe the online devices in parallel: an offline one would just time
      // out and slow the whole start-up down.
      await Promise.all(
        [...this.devices.values()]
          .filter((device) => device.online)
          .map((device) => this.#describeDevice(device)),
      );
    }

    return [...this.devices.values()];
  }

  /**
   * Ask ONE device what it can do and what it is doing, and decide which
   * transport we will use to reach it from now on.
   */
  async #describeDevice(device) {
    try {
      // `Appliance.System.Ability` lists the namespaces the firmware accepts.
      // Building features from it — rather than from a hard-coded model table —
      // means a new Meross reference works the day it ships.
      const abilityPayload = await this.cloudRequest(
        device.uuid,
        NAMESPACE.SYSTEM_ABILITY,
        METHOD.GET,
      );
      device.ability = abilityPayload?.ability ?? {};

      const allPayload = await this.cloudRequest(device.uuid, NAMESPACE.SYSTEM_ALL, METHOD.GET);
      applySystemAll(device, allPayload);

      if (isHub(device)) {
        await this.refreshSubDevices(device);
      }

      await this.#resolveTransport(device);
    } catch (err) {
      logger.warn(`Could not describe Meross device ${device.name} (${device.uuid})`, err);
      this.transports.set(device.uuid, { transport: DEVICE_TRANSPORTS.UNREACHABLE });
    }
  }

  /**
   * Decide — and record — the channel actually used for a device.
   *
   * The user's "prefer local" choice is a wish, not an order: we report what we
   * really use. When local is preferred but the device does not answer on the
   * LAN, we fall back to the cloud AND flag the device degraded, so the badge
   * carries the reason instead of silently looking normal.
   */
  async #resolveTransport(device) {
    if (!device.online) {
      this.transports.set(device.uuid, { transport: DEVICE_TRANSPORTS.UNREACHABLE });
      return;
    }

    if (!this.preferLocal) {
      device.localOk = false;
      this.transports.set(device.uuid, { transport: DEVICE_TRANSPORTS.CLOUD });
      return;
    }

    if (device.ip) {
      device.localOk = await isReachable({ ip: device.ip, key: this.session.key });
      if (device.localOk) {
        this.transports.set(device.uuid, { transport: DEVICE_TRANSPORTS.LOCAL });
        return;
      }
    }

    device.localOk = false;
    this.transports.set(device.uuid, {
      transport: DEVICE_TRANSPORTS.CLOUD,
      degraded: true,
      message: device.ip
        ? {
            en: `Local control preferred but ${device.ip} does not answer, using the cloud.`,
            fr: `Contrôle local préféré mais ${device.ip} ne répond pas, passage par le cloud.`,
          }
        : {
            en: 'Local control preferred but no LAN address is known, using the cloud.',
            fr: 'Contrôle local préféré mais aucune adresse LAN connue, passage par le cloud.',
          },
    });
  }

  /** Re-evaluate every device transport, e.g. after the user flips the toggle. */
  async refreshTransports(config) {
    this.preferLocal = config.GLADYS_PREFER_LOCAL !== false;
    await Promise.all([...this.devices.values()].map((device) => this.#resolveTransport(device)));
    return this.getTransportEntries();
  }

  getDevice(uuid) {
    return this.devices.get(uuid);
  }

  getDevices() {
    return [...this.devices.values()];
  }

  /**
   * Per-device transport, keyed by PLATFORM id (not uuid): a hub publishes no
   * Gladys device of its own, so its transport belongs to each of its
   * sub-devices — they are reached through it, so they share its channel.
   */
  getTransportEntries() {
    const entries = [];

    for (const [uuid, entry] of this.transports) {
      const device = this.devices.get(uuid);

      if (device && isHub(device)) {
        for (const sub of device.subDevices?.values() ?? []) {
          entries.push({ platformId: `${uuid}-${sub.id}`, ...entry });
        }
        continue;
      }

      entries.push({ platformId: uuid, ...entry });
    }

    return entries;
  }

  // --- Messaging -------------------------------------------------------------

  /**
   * Send a message to a device over the best available channel.
   *
   * Local first when it is the resolved transport; if the LAN call fails at
   * that very moment (device rebooted, DHCP moved it), we do NOT fail the
   * user's command: we retry over the cloud and downgrade the badge.
   */
  async request(uuid, namespace, method, payload = {}, { timeoutMs } = {}) {
    const device = this.devices.get(uuid);
    if (!device) {
      throw new Error(`Unknown Meross device ${uuid}`);
    }

    if (this.preferLocal && device.localOk && device.ip) {
      try {
        return await localRequest({
          ip: device.ip,
          key: this.session.key,
          namespace,
          method,
          payload,
          timeoutMs,
        });
      } catch (err) {
        logger.warn(`LAN call to ${device.name} failed, falling back to the cloud`, err);
        device.localOk = false;
        this.transports.set(uuid, {
          transport: DEVICE_TRANSPORTS.CLOUD,
          degraded: true,
          message: {
            en: 'Local control failed, falling back to the cloud.',
            fr: 'Le contrôle local a échoué, bascule sur le cloud.',
          },
        });
      }
    }

    return this.cloudRequest(uuid, namespace, method, payload, { timeoutMs });
  }

  /** Force a message through the cloud broker. */
  async cloudRequest(uuid, namespace, method, payload = {}, { timeoutMs } = {}) {
    if (!this.mqtt?.connected) {
      throw new Error('Not connected to the Meross broker');
    }
    return this.mqtt.request(uuid, namespace, method, payload, timeoutMs);
  }

  /** Read the full state of a device and cache it. */
  async fetchState(uuid) {
    const device = this.devices.get(uuid);
    if (!device) {
      throw new Error(`Unknown Meross device ${uuid}`);
    }
    const payload = await this.request(uuid, NAMESPACE.SYSTEM_ALL, METHOD.GET);
    applySystemAll(device, payload);
    return device.digest;
  }

  /**
   * Enumerate the sub-devices of a hub and read their state.
   *
   * Two sources, and both are needed:
   *   - the cloud endpoint gives the ids, the TYPES and the names the user
   *     chose in the Meross app;
   *   - the hub itself gives the live values, spread over one namespace per
   *     family (sensors, valves, batteries).
   */
  async refreshSubDevices(device) {
    const listed = await cloudApi
      .listSubDevices({ baseUrl: this.baseUrl, token: this.session.token, hubUuid: device.uuid })
      .catch((err) => {
        logger.warn(`Could not list the sub-devices of hub ${device.name}`, err);
        return [];
      });

    for (const raw of listed) {
      const id = String(raw.subDeviceId ?? raw.id ?? '');
      if (!id) {
        continue;
      }
      const existing = device.subDevices.get(id);
      device.subDevices.set(id, {
        id,
        name: raw.subDeviceName || existing?.name || id,
        type: String(raw.subDeviceType ?? existing?.type ?? '').toLowerCase(),
        state: existing?.state ?? {},
      });
    }

    await this.refreshSubDeviceStates(device);

    logger.info(
      `Hub ${device.name}: ${device.subDevices.size} sub-device(s) — ` +
        [...device.subDevices.values()].map((sub) => `${sub.name} (${sub.type})`).join(', '),
    );

    return device.subDevices;
  }

  /**
   * Read the live values of a hub's sub-devices, without re-reading the cloud
   * list. This is the polling path.
   *
   * A hub only answers the namespaces it declares, so each read is optional and
   * a failure is not fatal: a hub with no valve paired simply has no Mts100
   * data to give.
   */
  async refreshSubDeviceStates(device, { maxAgeMs = 5000 } = {}) {
    // Every sub-device is its own Gladys device with its own poll_frequency, so
    // a hub with five sensors gets polled five times in a burst — while ONE
    // read already refreshes all of them. Coalesce: share the in-flight read,
    // and skip one that just completed.
    const pending = device.subDeviceRefresh;
    if (pending?.promise) {
      return pending.promise;
    }
    if (pending?.at && Date.now() - pending.at < maxAgeMs) {
      return device.subDevices;
    }

    const promise = this.#readHubNamespaces(device);
    device.subDeviceRefresh = { promise };

    try {
      return await promise;
    } finally {
      device.subDeviceRefresh = { at: Date.now() };
    }
  }

  async #readHubNamespaces(device) {
    for (const namespace of [
      NAMESPACE.HUB_SENSOR_ALL,
      NAMESPACE.HUB_MTS100_ALL,
      NAMESPACE.HUB_BATTERY,
      NAMESPACE.HUB_TOGGLEX,
      NAMESPACE.HUB_ONLINE,
    ]) {
      if (!(namespace in device.ability)) {
        continue;
      }
      try {
        const payload = await this.request(device.uuid, namespace, METHOD.GET, {
          [HUB_PAYLOAD_KEYS[namespace]]: [],
        });
        mergeHubPayload(device, namespace, payload);
      } catch (err) {
        logger.warn(`Hub ${device.name} did not answer ${namespace}`, err);
      }
    }

    return device.subDevices;
  }

  /**
   * READ namespaces this integration does not model yet, to find out what they
   * contain. Diagnostic only, and deliberately GET-only: a GET has no side
   * effect, where guessing a SET payload on someone's watering system could
   * rewrite their schedule or open a valve.
   *
   * Only namespaces the device actually advertises are probed; a refusal is
   * captured as text rather than thrown, since "this namespace rejects an
   * empty GET" is itself a useful finding.
   */
  async probeNamespaces(device, namespaces = PROBE_NAMESPACES) {
    const advertised = namespaces.filter((namespace) => namespace in (device.ability ?? {}));

    return Promise.all(
      advertised.map(async (namespace) => {
        const attempts = [];
        const subDeviceIds = [...(device.subDevices?.keys() ?? [])];

        // A bare `{}` is rarely enough: most namespaces want their own key in
        // the request too, and answer `error 5000` without it. Try the
        // conventional shapes and report the first one that works.
        for (const payload of probePayloads(namespace, subDeviceIds)) {
          try {
            const reply = await this.request(device.uuid, namespace, METHOD.GET, payload, {
              timeoutMs: PROBE_TIMEOUT_MS,
            });
            return { namespace, request: payload, payload: reply, attempts };
          } catch (err) {
            attempts.push({ request: payload, error: err.message });

            // Silence is different from a refusal: a namespace that does not
            // answer at all will not answer a different payload either, so stop
            // rather than burn one timeout per remaining shape.
            if (err.code === TIMEOUT_ERROR_CODE) {
              return { namespace, attempts, silent: true };
            }
          }
        }

        return { namespace, attempts };
      }),
    );
  }

  /** Read the instantaneous electricity measurement of a channel. */
  async fetchElectricity(uuid, channel = 0) {
    const payload = await this.request(uuid, NAMESPACE.CONTROL_ELECTRICITY, METHOD.GET, {
      electricity: { channel },
    });
    return payload?.electricity ?? null;
  }

  /** Read the per-day energy history (most recent day last). */
  async fetchConsumption(uuid) {
    const payload = await this.request(uuid, NAMESPACE.CONTROL_CONSUMPTIONX, METHOD.GET, {});
    return payload?.consumptionx ?? [];
  }

  // --- Real-time -------------------------------------------------------------

  /**
   * A device pushed something. Keep our cached state in sync, then hand the
   * message to the device layer so it can publish the new value to Gladys.
   */
  #handlePush(uuid, message) {
    const device = this.devices.get(uuid);
    if (!device) {
      return;
    }

    const { namespace } = message.header ?? {};
    const payload = message.payload ?? {};

    if (namespace === NAMESPACE.SYSTEM_ONLINE) {
      const status = Number(payload?.online?.status);
      device.online = status === ONLINE_STATUS.ONLINE;
      if (!device.online) {
        this.transports.set(uuid, { transport: DEVICE_TRANSPORTS.UNREACHABLE });
      }
    }

    if (namespace === NAMESPACE.SYSTEM_ALL) {
      applySystemAll(device, payload);
    } else if (isHubNamespace(namespace)) {
      // Hub payloads are per SUB-DEVICE (keyed by `id`), not per channel:
      // merging them into the digest would corrupt it.
      mergeHubPayload(device, namespace, payload);
    } else {
      mergeDigest(device, payload);
    }

    if (typeof this.onPush === 'function') {
      this.onPush(uuid, message);
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** Read a cached session from the config, if it is complete. */
export function readCachedSession(config = {}) {
  const token = config[SESSION_KEYS.TOKEN];
  const key = config[SESSION_KEYS.KEY];
  const userId = config[SESSION_KEYS.USER_ID];
  const mqttDomain = config[SESSION_KEYS.MQTT_DOMAIN];
  if (!token || !key || !userId) {
    return null;
  }
  return { token, key, userId: String(userId), mqttDomain: mqttDomain || 'mqtt.meross.com' };
}

/**
 * Apply an `Appliance.System.All` payload to a device: its digest (the state of
 * every sub-system) and its LAN address, which is the only place Meross ever
 * discloses it.
 */
export function applySystemAll(device, payload = {}) {
  const all = payload?.all ?? {};
  device.digest = all.digest ?? device.digest ?? {};

  const firmware = all.system?.firmware ?? {};
  if (firmware.innerIp) {
    device.ip = firmware.innerIp;
  }

  const hardware = all.system?.hardware ?? {};
  if (hardware.version) {
    device.hardwareVersion = hardware.version;
  }
  if (firmware.version) {
    device.firmwareVersion = firmware.version;
  }

  return device;
}

/** True when a device is a hub, i.e. it advertises any `Appliance.Hub.*`. */
export function isHub(device) {
  return Object.keys(device?.ability ?? {}).some(isHubNamespace);
}

/**
 * Merge a hub payload into the sub-devices it describes.
 *
 * Every hub namespace has the same shape — `{ <key>: [ { id, ... } ] }` — so
 * one routine covers sensors, valves, batteries and online status. The state
 * of a sub-device is the accumulation of all of them, because each namespace
 * only carries its own slice.
 *
 * A sub-device the cloud never listed is still recorded: better an
 * unnamed device the user can see than a silently dropped sensor.
 */
export function mergeHubPayload(device, namespace, payload = {}) {
  const key = HUB_PAYLOAD_KEYS[namespace];
  const entries = payload?.[key];
  if (!Array.isArray(entries)) {
    return device.subDevices;
  }

  device.subDevices = device.subDevices ?? new Map();

  for (const entry of entries) {
    const id = String(entry?.id ?? '');
    if (!id) {
      continue;
    }

    const sub = device.subDevices.get(id) ?? { id, name: id, type: '', state: {} };

    if (namespace === NAMESPACE.HUB_SENSOR_ALL || namespace === NAMESPACE.HUB_MTS100_ALL) {
      // An `All` payload is already a bag of per-family blocks: merge block by
      // block so a later partial push cannot wipe a sibling block.
      for (const [block, value] of Object.entries(entry)) {
        if (block === 'id') {
          continue;
        }
        sub.state[block] = mergeBlock(sub.state[block], value);
      }
    } else {
      const { id: _ignored, ...rest } = entry;
      sub.state[key] = mergeBlock(sub.state[key], rest);
    }

    device.subDevices.set(id, sub);
  }

  return device.subDevices;
}

/** Shallow-merge two state blocks, tolerating scalars and arrays. */
function mergeBlock(existing, incoming) {
  if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return incoming;
  }
  if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
    return { ...incoming };
  }
  return { ...existing, ...incoming };
}

/**
 * Merge a partial push (`{ togglex: [...] }`, `{ light: {...} }`) into the
 * cached digest, so a later poll or read never regresses to a stale value.
 */
export function mergeDigest(device, payload = {}) {
  device.digest = device.digest ?? {};

  for (const [section, value] of Object.entries(payload)) {
    if (section === 'togglex') {
      device.digest.togglex = mergeChannelArray(device.digest.togglex, value);
    } else if (section === 'toggle') {
      device.digest.toggle = { ...(device.digest.toggle ?? {}), ...value };
    } else if (section === 'light') {
      device.digest.light = { ...(device.digest.light ?? {}), ...value };
    } else if (section === 'garageDoor') {
      device.digest.garageDoor = mergeChannelArray(device.digest.garageDoor, value);
    } else {
      device.digest[section] = value;
    }
  }

  return device.digest;
}

/**
 * Merge per-channel entries. Meross pushes either one object or an array of
 * them, each identified by its `channel`.
 */
function mergeChannelArray(existing, incoming) {
  const list = Array.isArray(existing) ? [...existing] : [];
  const updates = Array.isArray(incoming) ? incoming : [incoming];

  for (const update of updates) {
    if (!update || typeof update !== 'object') {
      continue;
    }
    const channel = Number(update.channel ?? 0);
    const index = list.findIndex((entry) => Number(entry?.channel ?? 0) === channel);
    if (index >= 0) {
      list[index] = { ...list[index], ...update };
    } else {
      list.push({ ...update });
    }
  }

  return list;
}
