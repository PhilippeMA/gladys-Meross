// -----------------------------------------------------------------------------
// Client-side state handling: reading `Appliance.System.All`, merging the
// partial pushes devices send, and the session cache.
//
// These are pure functions on purpose — the parts of the client worth testing
// without a broker.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySystemAll,
  MerossClient,
  mergeDigest,
  readCachedSession,
  SESSION_KEYS,
} from '../src/meross/client.js';
import { extractUuid } from '../src/meross/mqttClient.js';
import { buildFeatureKey, parseFeatureExternalId } from '../src/devices/featureIds.js';
import { NAMESPACE } from '../src/meross/protocol.js';

// --- Appliance.System.All ----------------------------------------------------

test('the LAN address is read out of the firmware block', () => {
  // This is the ONLY place Meross ever discloses a device's local IP.
  const device = { uuid: 'abc', digest: {} };

  applySystemAll(device, {
    all: {
      system: {
        firmware: { version: '2.1.12', innerIp: '192.168.1.50' },
        hardware: { version: '2.0.0' },
      },
      digest: { togglex: [{ channel: 0, onoff: 1 }] },
    },
  });

  assert.equal(device.ip, '192.168.1.50');
  assert.equal(device.firmwareVersion, '2.1.12');
  assert.equal(device.hardwareVersion, '2.0.0');
  assert.deepEqual(device.digest.togglex, [{ channel: 0, onoff: 1 }]);
});

test('a payload without a firmware block keeps the known IP', () => {
  const device = { uuid: 'abc', ip: '192.168.1.50', digest: {} };
  applySystemAll(device, { all: { digest: {} } });
  assert.equal(device.ip, '192.168.1.50');
});

// --- Partial pushes ----------------------------------------------------------

test('a push updates one channel and leaves the others alone', () => {
  const device = {
    digest: {
      togglex: [
        { channel: 0, onoff: 1 },
        { channel: 1, onoff: 0 },
        { channel: 2, onoff: 1 },
      ],
    },
  };

  mergeDigest(device, { togglex: [{ channel: 1, onoff: 1 }] });

  assert.deepEqual(device.digest.togglex, [
    { channel: 0, onoff: 1 },
    { channel: 1, onoff: 1 },
    { channel: 2, onoff: 1 },
  ]);
});

test('a push for an unknown channel is added rather than dropped', () => {
  const device = { digest: { togglex: [{ channel: 0, onoff: 1 }] } };
  mergeDigest(device, { togglex: [{ channel: 3, onoff: 1 }] });
  assert.equal(device.digest.togglex.length, 2);
  assert.deepEqual(device.digest.togglex[1], { channel: 3, onoff: 1 });
});

test('a push sent as a bare object (not an array) is handled', () => {
  const device = { digest: {} };
  mergeDigest(device, { togglex: { channel: 0, onoff: 1 } });
  assert.deepEqual(device.digest.togglex, [{ channel: 0, onoff: 1 }]);
});

test('a partial light push keeps the fields it does not mention', () => {
  const device = { digest: { light: { channel: 0, rgb: 0xff0000, luminance: 80, capacity: 5 } } };

  mergeDigest(device, { light: { channel: 0, luminance: 30 } });

  assert.deepEqual(device.digest.light, {
    channel: 0,
    rgb: 0xff0000,
    luminance: 30,
    capacity: 5,
  });
});

test('a garage door push updates the matching door', () => {
  const device = {
    digest: {
      garageDoor: [
        { channel: 0, open: 0 },
        { channel: 1, open: 0 },
      ],
    },
  };

  mergeDigest(device, { garageDoor: [{ channel: 1, open: 1 }] });

  assert.deepEqual(device.digest.garageDoor, [
    { channel: 0, open: 0 },
    { channel: 1, open: 1 },
  ]);
});

test('merging into a device that has no digest yet works', () => {
  const device = {};
  mergeDigest(device, { togglex: [{ channel: 0, onoff: 1 }] });
  assert.deepEqual(device.digest.togglex, [{ channel: 0, onoff: 1 }]);
});

// --- Polling a hub -----------------------------------------------------------

test('polling a hub reads the watering state alongside the Hub namespaces', async () => {
  // `Appliance.Control.Water` is readable, so the watering state must come off
  // the poll and not only from a push — otherwise a cycle started from the
  // Meross app, or by the timer's own schedule, is invisible until it ends.
  // It is not an `Appliance.Hub.*` namespace though: it is keyed `control` and
  // merges by `subId`, so it needs its own branch on the read path.
  const client = new MerossClient();
  const device = {
    uuid: 'hub-uuid',
    name: 'Smart Hub',
    ability: { [NAMESPACE.HUB_BATTERY]: {}, [NAMESPACE.CONTROL_WATER]: {} },
    subDevices: new Map([['1B0091AFC74E', { id: '1B0091AFC74E', name: 'Timer', state: {} }]]),
  };

  const sent = [];
  client.request = async (uuid, namespace, method, payload) => {
    sent.push({ namespace, payload });
    if (namespace === NAMESPACE.CONTROL_WATER) {
      return { control: [{ subId: '1B0091AFC74E', channel: 0, dura: 900, onoff: 2 }] };
    }
    return { battery: [{ id: '1B0091AFC74E', value: 98 }] };
  };

  await client.refreshSubDeviceStates(device, { maxAgeMs: 0 });

  assert.deepEqual(
    sent.find((entry) => entry.namespace === NAMESPACE.CONTROL_WATER)?.payload,
    { control: [] },
    'the read is keyed `control`, not `water`',
  );

  const sub = device.subDevices.get('1B0091AFC74E');
  assert.equal(sub.state.control.onoff, 2);
  assert.equal(sub.state.control.dura, 900);
  assert.equal(sub.state.battery.value, 98, 'the Hub namespaces still merge as before');
});

test('a hub that does not advertise watering is not asked about it', async () => {
  const client = new MerossClient();
  const device = {
    uuid: 'hub-uuid',
    name: 'Smart Hub',
    ability: { [NAMESPACE.HUB_BATTERY]: {} },
    subDevices: new Map(),
  };

  const sent = [];
  client.request = async (uuid, namespace) => {
    sent.push(namespace);
    return {};
  };

  await client.refreshSubDeviceStates(device, { maxAgeMs: 0 });

  assert.deepEqual(sent, [NAMESPACE.HUB_BATTERY]);
});

// --- Session cache -----------------------------------------------------------

test('a complete cached session is reused', () => {
  const session = readCachedSession({
    [SESSION_KEYS.TOKEN]: 'tok',
    [SESSION_KEYS.KEY]: 'key',
    [SESSION_KEYS.USER_ID]: 42,
    [SESSION_KEYS.MQTT_DOMAIN]: 'mqtt-eu.meross.com',
  });

  assert.deepEqual(session, {
    token: 'tok',
    key: 'key',
    userId: '42',
    mqttDomain: 'mqtt-eu.meross.com',
  });
});

test('an incomplete cached session is ignored so we log in cleanly', () => {
  assert.equal(readCachedSession({}), null);
  assert.equal(readCachedSession({ [SESSION_KEYS.TOKEN]: 'tok' }), null);
  assert.equal(readCachedSession({ [SESSION_KEYS.TOKEN]: 'tok', [SESSION_KEYS.KEY]: 'key' }), null);
  assert.equal(readCachedSession(), null);
});

/**
 * Stub the Meross cloud at the `fetch` level: every call answers HTTP 200, and
 * the real outcome sits in `apiStatus` — exactly like the API does.
 *
 * @param {Array<object>} bodies one response body per call, in order
 * @returns {{ paths: string[], tokens: (string|undefined)[], restore: () => void }}
 */
function stubCloud(bodies) {
  const original = globalThis.fetch;
  const paths = [];
  const tokens = [];
  let call = 0;

  globalThis.fetch = async (url, options) => {
    paths.push(new URL(url).pathname);
    tokens.push(options?.headers?.Authorization);
    const body = bodies[call];
    call += 1;
    return { ok: true, json: async () => body };
  };

  return { paths, tokens, restore: () => (globalThis.fetch = original) };
}

const CACHED_CONFIG = {
  email: 'user@example.com',
  password: 'secret',
  region: 'eu',
  [SESSION_KEYS.TOKEN]: 'stale-token',
  [SESSION_KEYS.KEY]: 'stale-key',
  [SESSION_KEYS.USER_ID]: '42',
  [SESSION_KEYS.MQTT_DOMAIN]: 'mqtt-eu-4.meross.com',
};

const LOGIN_OK = {
  apiStatus: 0,
  data: { token: 'fresh-token', key: 'fresh-key', userid: 42, mqttDomain: 'mqtt-eu-4.meross.com' },
};

test('a session Meross no longer recognises is dropped and replaced', async () => {
  // The reported failure: the cached token came back as `1022 No login`. Since
  // nothing cleared it, every later attempt reused the same dead token and the
  // integration never came back on its own.
  const cloud = stubCloud([{ apiStatus: 1022, info: 'No login' }, LOGIN_OK]);
  const saved = [];
  const client = new MerossClient({ saveSession: async (partial) => saved.push(partial) });

  try {
    const session = await client.authenticate({ ...CACHED_CONFIG });

    assert.equal(session.token, 'fresh-token');
    assert.deepEqual(cloud.paths, ['/v1/Device/devList', '/v1/Auth/signIn']);
    // The dead token must not be carried into the login request.
    assert.equal(cloud.tokens[1], undefined);
    // Erased first, so a crash between the two never leaves it cached.
    assert.equal(saved[0][SESSION_KEYS.TOKEN], '');
    assert.equal(saved[1][SESSION_KEYS.TOKEN], 'fresh-token');
  } finally {
    cloud.restore();
  }
});

test('an undocumented API status on a cached session also triggers a login', async () => {
  const cloud = stubCloud([{ apiStatus: 9999, info: 'Whatever Meross invents next' }, LOGIN_OK]);
  const client = new MerossClient({});

  try {
    const session = await client.authenticate({ ...CACHED_CONFIG });
    assert.equal(session.token, 'fresh-token');
  } finally {
    cloud.restore();
  }
});

test('the session cap is not answered with yet another login', async () => {
  // 1301 says there are too many sessions already: logging in again would add
  // to the very pile the API is complaining about.
  const cloud = stubCloud([{ apiStatus: 1301, info: 'Too many tokens' }]);
  const saved = [];
  const client = new MerossClient({ saveSession: async (partial) => saved.push(partial) });

  try {
    await assert.rejects(() => client.authenticate({ ...CACHED_CONFIG }), /1301/);
    assert.deepEqual(cloud.paths, ['/v1/Device/devList']);
    assert.deepEqual(saved, []);
  } finally {
    cloud.restore();
  }
});

test('a network failure keeps the cached session instead of burning a new one', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const saved = [];
  const client = new MerossClient({ saveSession: async (partial) => saved.push(partial) });

  try {
    await assert.rejects(() => client.authenticate({ ...CACHED_CONFIG }), /network down/);
    assert.deepEqual(saved, []);
  } finally {
    globalThis.fetch = original;
  }
});

// --- MQTT addressing ---------------------------------------------------------

test('the device uuid is extracted from the reply topic', () => {
  assert.equal(
    extractUuid('/appliance/1806239851916890865148e1e9aa11f1/publish'),
    '1806239851916890865148e1e9aa11f1',
  );
  assert.equal(extractUuid('/app/42-abc/subscribe'), null);
  assert.equal(extractUuid(undefined), null);
  assert.equal(extractUuid(''), null);
});

// --- Feature ids -------------------------------------------------------------

test('feature keys survive the round trip, multi-word kinds included', () => {
  for (const [kind, channel] of [
    ['on-off', 0],
    ['color-temperature', 0],
    ['energy-today', 0],
    ['on-off', 12],
  ]) {
    const externalId = `ext:sel:meross:uuid:${buildFeatureKey(kind, channel)}`;
    assert.deepEqual(parseFeatureExternalId(externalId), { kind, channel });
  }
});

test('an unparseable feature id is reported rather than guessed', () => {
  assert.equal(parseFeatureExternalId('ext:sel:meross:uuid:nochannel'), null);
  assert.equal(parseFeatureExternalId('ext:sel:meross:uuid:on-off-abc'), null);
  assert.equal(parseFeatureExternalId(undefined), null);
});
