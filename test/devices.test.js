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
  smartHub,
  unsupportedDevice,
  wateringTimer,
} from './helpers/merossFixtures.js';
import {
  buildDiscoveredDevices,
  findKind,
  handlePoll,
  handleSetValue,
  publishDeviceStates,
  shouldPoll,
  withRequiredBounds,
} from '../src/devices/index.js';
import * as plug from '../src/devices/plug.js';
import * as light from '../src/devices/light.js';
import * as garageDoor from '../src/devices/garageDoor.js';
import * as hub from '../src/devices/hub.js';
import { NAMESPACE } from '../src/meross/protocol.js';
import { DEFAULT_CONFIG, POLL_FREQUENCIES } from '../src/config.js';

const config = { ...DEFAULT_CONFIG };

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
  assert.equal(findKind(unsupportedDevice()), null);
});

// --- Discovery ---------------------------------------------------------------

test('unsupported devices are skipped instead of published empty', () => {
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, [powerPlug(), unsupportedDevice()], config);

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

  assert.equal(monitored.poll_frequency, 60000);
  assert.equal(plain.poll_frequency, undefined);
  assert.equal(shouldPoll(powerPlug()), true);
  assert.equal(shouldPoll(simplePlug()), false);
});

test('no published device can carry a poll frequency Gladys would reject', () => {
  // Gladys rejects the WHOLE publish batch on a single bad frequency
  // ("devices[0].poll_frequency: invalid poll frequency"), so a stale or
  // hand-edited config must never reach the payload unnormalized.
  const gladys = createFakeGladys();

  for (const raw of [60, 300, 3600, '45000', undefined, 'nonsense']) {
    const devices = buildDiscoveredDevices(
      gladys,
      [powerPlug(), simplePlug(), colorBulb(), smartHub()],
      { ...config, poll_frequency: raw },
    );

    assert.ok(devices.length > 0);
    for (const device of devices) {
      if (device.poll_frequency !== undefined) {
        assert.ok(
          POLL_FREQUENCIES.includes(device.poll_frequency),
          `"${device.name}" published poll_frequency ${device.poll_frequency} for config ${JSON.stringify(raw)}`,
        );
      }
    }
  }
});

test('every published feature declares min and max', () => {
  // Gladys stores min/max as NOT NULL: a feature missing either is discovered
  // fine and then refused at ADD time with
  // "422 t_device_feature.min cannot be null". Binary features are the trap.
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(
    gladys,
    [
      powerPlug(),
      simplePlug(),
      powerStrip(),
      legacyTogglePlug(),
      colorBulb(),
      colorStrip(),
      garageOpener(),
      smartHub(),
    ],
    config,
  );

  assert.ok(devices.length > 0);
  for (const device of devices) {
    for (const f of device.features) {
      assert.ok(
        Number.isFinite(f.min),
        `"${device.name}" / "${f.name}" has no numeric min (${f.category}/${f.type})`,
      );
      assert.ok(
        Number.isFinite(f.max),
        `"${device.name}" / "${f.name}" has no numeric max (${f.category}/${f.type})`,
      );
      assert.ok(f.min < f.max, `"${device.name}" / "${f.name}" has min >= max`);
    }
  }
});

test('binary features are bounded to 0..1', () => {
  const gladys = createFakeGladys();
  const [plugDevice] = buildDiscoveredDevices(gladys, [simplePlug()], config);
  const onOff = feature(plugDevice, 'on-off-0');

  assert.equal(onOff.min, 0);
  assert.equal(onOff.max, 1);
});

test('a feature that forgot its bounds is repaired rather than published broken', () => {
  const repaired = withRequiredBounds({
    name: 'On/Off',
    category: 'switch',
    type: 'binary',
    external_id: 'x',
  });
  assert.equal(repaired.min, 0);
  assert.equal(repaired.max, 1);
});

test('a feature that declares its bounds is left untouched', () => {
  const original = { name: 'Power', category: 'energy-sensor', type: 'power', min: 0, max: 3680 };
  assert.equal(withRequiredBounds(original), original);
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

// --- Hubs and their sub-devices ----------------------------------------------

test('a hub is detected as a hub, not as a plug through its Hub.ToggleX', () => {
  assert.equal(findKind(smartHub()), hub);
});

test('a hub publishes one Gladys device per sub-device, and none for itself', () => {
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, [smartHub()], config);

  assert.deepEqual(
    devices.map((d) => d.name),
    ['Living room thermometer', 'Bedroom valve', 'Cellar leak sensor'],
  );
  // The hub itself has nothing to read or act on: it must not appear.
  assert.ok(!devices.some((d) => d.name === 'Smart Hub'));
});

test('a sub-device external_id addresses both the hub and the sub-device', () => {
  const gladys = createFakeGladys();
  const [thermometer] = buildDiscoveredDevices(gladys, [smartHub()], config);

  assert.equal(thermometer.external_id, `meross:${smartHub().uuid}-0000A1B2`);
});

test('a thermometer exposes temperature, humidity and battery', () => {
  const gladys = createFakeGladys();
  const [thermometer] = buildDiscoveredDevices(gladys, [smartHub()], config);

  assert.deepEqual(
    thermometer.features.map((f) => f.name),
    ['Temperature', 'Humidity', 'Battery'],
  );
  assert.equal(feature(thermometer, 'temperature-0').unit, 'celsius');
  assert.equal(feature(thermometer, 'battery-0').unit, 'percent');
});

test('a valve exposes a target temperature bounded by the range it reports', () => {
  const gladys = createFakeGladys();
  const [, valve] = buildDiscoveredDevices(gladys, [smartHub()], config);

  assert.deepEqual(
    valve.features.map((f) => f.name),
    ['Target temperature', 'Room temperature', 'On/Off', 'Battery'],
  );

  const target = feature(valve, 'target-temperature-0');
  // min 50 / max 350 in tenths -> 5 °C / 35 °C
  assert.equal(target.min, 5);
  assert.equal(target.max, 35);
  assert.equal(target.read_only, false);
});

test('a watering timer names its switch for what it actually does', () => {
  // The device accepts and adopts this switch but waters nothing: calling it
  // "On/Off" invites the user to expect a watering it cannot trigger.
  const gladys = createFakeGladys();
  const device = smartHub({ subDevices: new Map([['1B0091AFC74E', wateringTimer()]]) });

  const [timer] = buildDiscoveredDevices(gladys, [device], config);

  assert.deepEqual(
    timer.features.map((f) => f.name),
    ['Timer enabled', 'Battery'],
  );
  // Still controllable: it is a real state the device honours.
  assert.equal(feature(timer, 'on-off-0').read_only, false);
  assert.equal(feature(timer, 'battery-0').read_only, true);
});

test('a thermostatic valve keeps its plain On/Off name', () => {
  const gladys = createFakeGladys();
  const [, valve] = buildDiscoveredDevices(gladys, [smartHub()], config);

  assert.ok(valve.features.some((f) => f.name === 'On/Off'));
  assert.ok(!valve.features.some((f) => f.name === 'Timer enabled'));
});

test('a leak sensor exposes its leak state and battery', () => {
  const gladys = createFakeGladys();
  const [, , leak] = buildDiscoveredDevices(gladys, [smartHub()], config);

  assert.deepEqual(
    leak.features.map((f) => f.name),
    ['Water leak', 'Battery'],
  );
  assert.equal(feature(leak, 'leak-0').category, 'leak-sensor');
});

test('sub-device values are converted out of tenths', async () => {
  const gladys = createFakeGladys();
  const device = smartHub();
  await publishDeviceStates(gladys, device);

  const states = Object.fromEntries(gladys.published.map((p) => [p.featureExternalId, p.state]));
  const uuid = device.uuid;

  // 231 -> 23.1 °C, 546 -> 54.6 %
  assert.equal(states[`meross:${uuid}-0000A1B2:temperature-0`], 23.1);
  assert.equal(states[`meross:${uuid}-0000A1B2:humidity-0`], 54.6);
  assert.equal(states[`meross:${uuid}-0000A1B2:battery-0`], 87);
  // The valve: room 210 -> 21 °C, target 200 -> 20 °C
  assert.equal(states[`meross:${uuid}-0000C3D4:temperature-0`], 21);
  assert.equal(states[`meross:${uuid}-0000C3D4:target-temperature-0`], 20);
  assert.equal(states[`meross:${uuid}-0000C3D4:on-off-0`], 1);
  assert.equal(states[`meross:${uuid}-0000E5F6:leak-0`], 0);
});

test('setting a valve target sends tenths of a degree to the right sub-device', async () => {
  const gladys = createFakeGladys();
  const device = smartHub();
  const client = createFakeClient([device]);
  const [, valve] = buildDiscoveredDevices(gladys, [device], config);

  await handleSetValue(gladys, client, {
    device: valve,
    feature: feature(valve, 'target-temperature-0'),
    value: 19.5,
  });

  assert.deepEqual(client.requests[0], {
    uuid: device.uuid,
    namespace: NAMESPACE.HUB_MTS100_TEMPERATURE,
    method: 'SET',
    payload: { temperature: [{ id: '0000C3D4', custom: 195 }] },
  });
});

test('switching a valve addresses it by sub-device id, not by channel', async () => {
  const gladys = createFakeGladys();
  const device = smartHub();
  const client = createFakeClient([device]);
  const [, valve] = buildDiscoveredDevices(gladys, [device], config);

  await handleSetValue(gladys, client, {
    device: valve,
    feature: feature(valve, 'on-off-0'),
    value: 0,
  });

  assert.deepEqual(client.requests[0], {
    uuid: device.uuid,
    namespace: NAMESPACE.HUB_TOGGLEX,
    method: 'SET',
    payload: { togglex: [{ id: '0000C3D4', onoff: 0, channel: 0 }] },
  });
});

test('a read-only sub-device feature refuses a command', async () => {
  const gladys = createFakeGladys();
  const device = smartHub();
  const client = createFakeClient([device]);
  const [thermometer] = buildDiscoveredDevices(gladys, [device], config);

  await assert.rejects(
    () =>
      handleSetValue(gladys, client, {
        device: thermometer,
        feature: feature(thermometer, 'temperature-0'),
        value: 20,
      }),
    /read-only/,
  );
});

test('a sub-device with no usable data is skipped, not published empty', () => {
  const gladys = createFakeGladys();
  const device = smartHub({ subDevices: new Map() });
  device.subDevices.set('0000FFFF', {
    id: '0000FFFF',
    name: 'Mystery sensor',
    type: 'unknown999',
    state: {},
  });

  assert.deepEqual(buildDiscoveredDevices(gladys, [device], config), []);
});

test('a hub sub-device is recognised from its data even with an unknown type', () => {
  // Hub generations name their types inconsistently, so the data is the
  // authority: a `tempHum` block means a thermometer, whatever the type says.
  const gladys = createFakeGladys();
  const device = smartHub({ subDevices: new Map() });
  device.subDevices.set('0000ABCD', {
    id: '0000ABCD',
    name: 'New thermometer',
    type: 'ms9999',
    state: { tempHum: { latestTemperature: 195, latestHumidity: 480 } },
  });

  const [built] = buildDiscoveredDevices(gladys, [device], config);
  assert.deepEqual(
    built.features.map((f) => f.name),
    ['Temperature', 'Humidity'],
  );
});

test('polling a hub does not re-read its unused digest', async () => {
  // Every sub-device polls independently; reading Appliance.System.All on the
  // hub each time would be a pure waste, its digest holds no sub-device state.
  const gladys = createFakeGladys();
  const device = smartHub();
  const client = createFakeClient([device]);
  const [thermometer] = buildDiscoveredDevices(gladys, [device], config);

  await handlePoll(gladys, client, thermometer);

  assert.ok(!client.requests.some((r) => r.namespace === NAMESPACE.SYSTEM_ALL));
});

test('polling a hub refreshes its sub-devices and republishes them', async () => {
  const gladys = createFakeGladys();
  const device = smartHub();
  const client = createFakeClient([device]);
  const [thermometer] = buildDiscoveredDevices(gladys, [device], config);

  await handlePoll(gladys, client, thermometer);

  assert.ok(client.requests.some((r) => r.namespace === 'refreshSubDeviceStates'));
  const states = Object.fromEntries(gladys.published.map((p) => [p.featureExternalId, p.state]));
  assert.equal(states[`meross:${device.uuid}-0000A1B2:temperature-0`], 23.1);
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
