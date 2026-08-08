// -----------------------------------------------------------------------------
// The device layer: kind detection, discovery payloads, state reading and
// command routing — the translation between "a Meross device" and "a Gladys
// device", with no network involved.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  colorBulb,
  colorStrip,
  createFakeClient,
  garageOpener,
  legacyTogglePlug,
  powerPlug,
  powerStrip,
  simplePlug,
  unsupportedHub,
} from './helpers/merossFixtures.js';
import {
  buildDiscoveredDevices,
  findKind,
  handlePoll,
  handleSetValue,
  publishDeviceStates,
  shouldPoll,
} from '../src/devices/index.js';
import * as plug from '../src/devices/plug.js';
import * as light from '../src/devices/light.js';
import * as garageDoor from '../src/devices/garageDoor.js';
import { NAMESPACE } from '../src/meross/protocol.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const config = { ...DEFAULT_CONFIG, poll_frequency: 60 };

/** Feature helper: find one feature by the tail of its external_id. */
function feature(device, suffix) {
  const found = device.features.find((f) => f.external_id.endsWith(`:${suffix}`));
  assert.ok(found, `expected a feature ending in ${suffix}`);
  return found;
}

// --- Kind detection ----------------------------------------------------------

test('a light is detected as a light, not as a plug', () => {
  // Bulbs also advertise ToggleX, so ordering in the registry is what decides.
  assert.equal(findKind(colorBulb()), light);
  assert.equal(findKind(colorStrip()), light);
});

test('a garage opener is detected before its ToggleX ability', () => {
  assert.equal(findKind(garageOpener()), garageDoor);
});

test('relays of every generation are detected as plugs', () => {
  assert.equal(findKind(powerPlug()), plug);
  assert.equal(findKind(simplePlug()), plug);
  assert.equal(findKind(powerStrip()), plug);
  assert.equal(findKind(legacyTogglePlug()), plug);
});

test('a device whose abilities we do not model is not claimed', () => {
  assert.equal(findKind(unsupportedHub()), null);
});

// --- Discovery ---------------------------------------------------------------

test('unsupported devices are skipped instead of published empty', () => {
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, [powerPlug(), unsupportedHub()], config);

  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Office plug');
});

test('a device external_id is built from the stable Meross uuid', () => {
  const gladys = createFakeGladys();
  const device = powerPlug();
  const [discovered] = buildDiscoveredDevices(gladys, [device], config);

  assert.equal(discovered.external_id, `meross:${device.uuid}`);
  for (const f of discovered.features) {
    assert.ok(f.external_id.startsWith(`meross:${device.uuid}:`));
  }
});

test('a power-monitoring plug exposes its relay and its three measurements', () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, [powerPlug()], config);

  assert.deepEqual(
    device.features.map((f) => f.name),
    ['On/Off', 'Power', 'Voltage', 'Current', 'Energy today'],
  );

  const power = feature(device, 'power-0');
  assert.equal(power.unit, 'watt');
  assert.equal(power.read_only, true);

  const relay = feature(device, 'on-off-0');
  assert.equal(relay.read_only, false);
  assert.equal(relay.has_feedback, true);
});

test('a plain plug exposes only its relay', () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, [simplePlug()], config);

  assert.deepEqual(
    device.features.map((f) => f.name),
    ['On/Off'],
  );
});

test('a power strip becomes one device with one feature per outlet', () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, [powerStrip()], config);

  assert.deepEqual(
    device.features.map((f) => f.name),
    ['All outlets', 'Screen', 'Dock', 'Outlet 3', 'Outlet 4'],
  );
});

test('only devices with something to poll declare a poll_frequency', () => {
  const gladys = createFakeGladys();
  const [monitored] = buildDiscoveredDevices(gladys, [powerPlug()], config);
  const [plain] = buildDiscoveredDevices(gladys, [simplePlug()], config);

  assert.equal(monitored.poll_frequency, 60);
  assert.equal(plain.poll_frequency, undefined);
  assert.equal(shouldPoll(powerPlug()), true);
  assert.equal(shouldPoll(simplePlug()), false);
});

test('a colour bulb exposes brightness, colour and white temperature', () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, [colorBulb()], config);

  assert.deepEqual(
    device.features.map((f) => f.name),
    ['On/Off', 'Brightness', 'Color', 'Color temperature'],
  );
  assert.equal(feature(device, 'color-0').max, 16777215);
  assert.equal(feature(device, 'brightness-0').unit, 'percent');
});

test('an RGB strip gets no phantom white-temperature feature', () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, [colorStrip()], config);

  assert.deepEqual(
    device.features.map((f) => f.name),
    ['On/Off', 'Brightness', 'Color'],
  );
});

test('the device metadata carries the Meross identity', () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, [powerPlug()], config);
  const params = Object.fromEntries(device.params.map((p) => [p.name, p.value]));

  assert.equal(params.MEROSS_MODEL, 'mss310');
  assert.equal(params.MEROSS_LAN_IP, '192.168.1.50');
  assert.equal(params.MEROSS_UUID, powerPlug().uuid);
});

// --- Reading states ----------------------------------------------------------

test('the digest of a strip is published channel by channel', async () => {
  const gladys = createFakeGladys();
  const device = powerStrip();
  await publishDeviceStates(gladys, device);

  const states = Object.fromEntries(
    gladys.published.map((p) => [p.featureExternalId.split(':').pop(), p.state]),
  );
  assert.deepEqual(states, {
    'on-off-0': 1,
    'on-off-1': 1,
    'on-off-2': 0,
    'on-off-3': 0,
    'on-off-4': 1,
  });
});

test('a legacy single-toggle plug is still read correctly', () => {
  assert.deepEqual(plug.buildStates(legacyTogglePlug()), [{ featureKey: 'on-off-0', state: 1 }]);
});

test('a bulb in colour mode reports its colour, not a stale temperature', () => {
  // digest.light.capacity is 5 (RGB | LUMINANCE): the bulb is in colour mode.
  const states = Object.fromEntries(
    light.buildStates(colorBulb()).map((s) => [s.featureKey, s.state]),
  );

  assert.equal(states['on-off-0'], 1);
  assert.equal(states['brightness-0'], 70);
  assert.equal(states['color-0'], 0xff8800);
  assert.equal(states['color-temperature-0'], undefined);
});

test('a bulb in white mode reports its temperature, not a stale colour', () => {
  const device = colorBulb();
  device.digest.light = { channel: 0, capacity: 6, temperature: 20, luminance: 40 };

  const states = Object.fromEntries(light.buildStates(device).map((s) => [s.featureKey, s.state]));

  assert.equal(states['color-temperature-0'], 20);
  assert.equal(states['color-0'], undefined);
  assert.equal(states['brightness-0'], 40);
});

test('a closed garage door reads as 0 and an open one as 1', () => {
  assert.deepEqual(garageDoor.buildStates(garageOpener()), [{ featureKey: 'door-0', state: 0 }]);

  const open = garageOpener();
  open.digest.garageDoor = [{ channel: 0, open: 1 }];
  assert.deepEqual(garageDoor.buildStates(open), [{ featureKey: 'door-0', state: 1 }]);
});

test("today's entry is picked out of the energy history and converted to kWh", () => {
  const history = [
    { date: '2024-01-01', value: 500 },
    { date: '2024-06-15', value: 2500 },
  ];
  // 2500 Wh on the matching day -> 2.5 kWh
  assert.equal(plug.readTodayConsumption(history, new Date('2024-06-15T10:00:00')), 2.5);
  // No entry for today -> fall back to the most recent one.
  assert.equal(plug.readTodayConsumption(history, new Date('2024-06-16T10:00:00')), 2.5);
  assert.equal(plug.readTodayConsumption([]), null);
  assert.equal(plug.readTodayConsumption(undefined), null);
});

// --- Commands ----------------------------------------------------------------

test('switching an outlet sends ToggleX on the right channel', async () => {
  const gladys = createFakeGladys();
  const device = powerStrip();
  const client = createFakeClient([device]);
  const [discovered] = buildDiscoveredDevices(gladys, [device], config);

  await handleSetValue(gladys, client, {
    device: discovered,
    feature: feature(discovered, 'on-off-2'),
    value: 1,
  });

  assert.deepEqual(client.requests, [
    {
      uuid: device.uuid,
      namespace: NAMESPACE.CONTROL_TOGGLEX,
      method: 'SET',
      payload: { togglex: { channel: 2, onoff: 1 } },
    },
  ]);
  // has_feedback: the confirmed state goes straight back to Gladys.
  assert.deepEqual(gladys.published, [
    { featureExternalId: feature(discovered, 'on-off-2').external_id, state: 1 },
  ]);
});

test('a legacy plug is driven with the old Toggle namespace', async () => {
  const gladys = createFakeGladys();
  const device = legacyTogglePlug();
  const client = createFakeClient([device]);
  const [discovered] = buildDiscoveredDevices(gladys, [device], config);

  await handleSetValue(gladys, client, {
    device: discovered,
    feature: feature(discovered, 'on-off-0'),
    value: 0,
  });

  assert.equal(client.requests[0].namespace, NAMESPACE.CONTROL_TOGGLE);
  assert.deepEqual(client.requests[0].payload, { toggle: { onoff: 0 } });
});

test('setting the brightness sends the luminance capacity bit', async () => {
  const gladys = createFakeGladys();
  const device = colorBulb();
  const client = createFakeClient([device]);
  const [discovered] = buildDiscoveredDevices(gladys, [device], config);

  await handleSetValue(gladys, client, {
    device: discovered,
    feature: feature(discovered, 'brightness-0'),
    value: 42,
  });

  assert.deepEqual(client.requests[0], {
    uuid: device.uuid,
    namespace: NAMESPACE.CONTROL_LIGHT,
    method: 'SET',
    payload: { light: { channel: 0, capacity: 4, luminance: 42 } },
  });
});

test('dragging the brightness to zero turns the light off instead of failing', async () => {
  // Meross rejects luminance 0, so "0 %" has to become a power-off.
  const gladys = createFakeGladys();
  const device = colorBulb();
  const client = createFakeClient([device]);
  const [discovered] = buildDiscoveredDevices(gladys, [device], config);

  await handleSetValue(gladys, client, {
    device: discovered,
    feature: feature(discovered, 'brightness-0'),
    value: 0,
  });

  assert.deepEqual(client.requests[0], {
    uuid: device.uuid,
    namespace: NAMESPACE.CONTROL_TOGGLEX,
    method: 'SET',
    payload: { togglex: { channel: 0, onoff: 0 } },
  });
});

test('setting a colour sends the rgb capacity bit', async () => {
  const gladys = createFakeGladys();
  const device = colorBulb();
  const client = createFakeClient([device]);
  const [discovered] = buildDiscoveredDevices(gladys, [device], config);

  await handleSetValue(gladys, client, {
    device: discovered,
    feature: feature(discovered, 'color-0'),
    value: 0x00ff00,
  });

  assert.deepEqual(client.requests[0].payload, {
    light: { channel: 0, capacity: 1, rgb: 0x00ff00 },
  });
});

test('setting the white temperature sends the temperature capacity bit', async () => {
  const gladys = createFakeGladys();
  const device = colorBulb();
  const client = createFakeClient([device]);
  const [discovered] = buildDiscoveredDevices(gladys, [device], config);

  await handleSetValue(gladys, client, {
    device: discovered,
    feature: feature(discovered, 'color-temperature-0'),
    value: 80,
  });

  assert.deepEqual(client.requests[0].payload, {
    light: { channel: 0, capacity: 2, temperature: 80 },
  });
});

test('opening the garage sends the door uuid the firmware requires', async () => {
  const gladys = createFakeGladys();
  const device = garageOpener();
  const client = createFakeClient([device]);
  const [discovered] = buildDiscoveredDevices(gladys, [device], config);

  await handleSetValue(gladys, client, {
    device: discovered,
    feature: feature(discovered, 'door-0'),
    value: 1,
  });

  assert.deepEqual(client.requests[0], {
    uuid: device.uuid,
    namespace: NAMESPACE.GARAGE_DOOR_STATE,
    method: 'SET',
    payload: { state: { channel: 0, open: 1, uuid: device.uuid } },
  });
});

test('a command for an unknown device fails loudly', async () => {
  const gladys = createFakeGladys();
  const client = createFakeClient([]);

  await assert.rejects(
    () =>
      handleSetValue(gladys, client, {
        device: { external_id: 'meross:does-not-exist' },
        feature: { external_id: 'meross:does-not-exist:on-off-0' },
        value: 1,
      }),
    /Unknown Meross device/,
  );
});

// --- Polling -----------------------------------------------------------------

test('polling a power plug publishes the digest and the measurements', async () => {
  const gladys = createFakeGladys();
  const device = powerPlug();
  const client = createFakeClient([device]);
  const [discovered] = buildDiscoveredDevices(gladys, [device], config);

  await handlePoll(gladys, client, discovered);

  const states = Object.fromEntries(
    gladys.published.map((p) => [p.featureExternalId.split(':').pop(), p.state]),
  );

  assert.equal(states['on-off-0'], 1);
  assert.equal(states['power-0'], 123.46);
  assert.equal(states['voltage-0'], 234.5);
  assert.equal(states['current-0'], 0.543);
  assert.equal(states['energy-today-0'], 1.234);
});

test('polling a plug without measurements asks for none', async () => {
  const gladys = createFakeGladys();
  const device = simplePlug();
  const client = createFakeClient([device]);
  const [discovered] = buildDiscoveredDevices(gladys, [device], config);

  await handlePoll(gladys, client, discovered);

  assert.deepEqual(
    client.requests.map((r) => r.namespace),
    [NAMESPACE.SYSTEM_ALL],
  );
});
