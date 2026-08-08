// -----------------------------------------------------------------------------
// Hub-specific client behaviour: merging the per-family payloads a hub returns,
// and coalescing the burst of polls its sub-devices trigger.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHub, MerossClient, mergeHubPayload } from '../src/meross/client.js';
import { HUB_PAYLOAD_KEYS, NAMESPACE } from '../src/meross/protocol.js';
import { parseDeviceExternalId, subDevicePlatformId } from '../src/devices/featureIds.js';
import * as hub from '../src/devices/hub.js';
import { powerPlug, smartHub } from './helpers/merossFixtures.js';

function emptyHub() {
  return smartHub({ subDevices: new Map() });
}

test('a device is a hub as soon as it advertises any Appliance.Hub namespace', () => {
  assert.equal(isHub(smartHub()), true);
  assert.equal(isHub(powerPlug()), false);
  assert.equal(isHub({}), false);
});

test('a Sensor.All payload is split into per-sub-device blocks', () => {
  const device = emptyHub();

  mergeHubPayload(device, NAMESPACE.HUB_SENSOR_ALL, {
    all: [
      {
        id: '0000A1B2',
        online: { status: 1 },
        tempHum: { latestTemperature: 231, latestHumidity: 546 },
      },
    ],
  });

  const sub = device.subDevices.get('0000A1B2');
  assert.deepEqual(sub.state.tempHum, { latestTemperature: 231, latestHumidity: 546 });
  assert.deepEqual(sub.state.online, { status: 1 });
});

test('a battery payload lands under its own block without erasing the rest', () => {
  const device = emptyHub();

  mergeHubPayload(device, NAMESPACE.HUB_SENSOR_ALL, {
    all: [{ id: '0000A1B2', tempHum: { latestTemperature: 231 } }],
  });
  mergeHubPayload(device, NAMESPACE.HUB_BATTERY, {
    battery: [{ id: '0000A1B2', value: 87 }],
  });

  const sub = device.subDevices.get('0000A1B2');
  assert.equal(sub.state.battery.value, 87);
  assert.equal(sub.state.tempHum.latestTemperature, 231);
});

test('a partial push updates one block and keeps its siblings', () => {
  const device = smartHub();

  mergeHubPayload(device, NAMESPACE.HUB_MTS100_TEMPERATURE, {
    temperature: [{ id: '0000C3D4', currentSet: 225 }],
  });

  const valve = device.subDevices.get('0000C3D4');
  assert.equal(valve.state.temperature.currentSet, 225);
  // The room temperature and the reported range must survive.
  assert.equal(valve.state.temperature.room, 210);
  assert.equal(valve.state.temperature.max, 350);
  assert.equal(valve.state.togglex.onoff, 1);
});

test('a push updates only the sub-device it names', () => {
  const device = smartHub();

  mergeHubPayload(device, NAMESPACE.HUB_TOGGLEX, {
    togglex: [{ id: '0000C3D4', onoff: 0 }],
  });

  assert.equal(device.subDevices.get('0000C3D4').state.togglex.onoff, 0);
  assert.equal(device.subDevices.get('0000A1B2').state.tempHum.latestTemperature, 231);
});

test('a sub-device the cloud never listed is recorded rather than dropped', () => {
  const device = emptyHub();

  mergeHubPayload(device, NAMESPACE.HUB_BATTERY, {
    battery: [{ id: 'NEWLYPAIRED', value: 50 }],
  });

  const sub = device.subDevices.get('NEWLYPAIRED');
  assert.equal(sub.name, 'NEWLYPAIRED');
  assert.equal(sub.state.battery.value, 50);
});

test('a malformed payload is ignored instead of corrupting the state', () => {
  const device = smartHub();

  mergeHubPayload(device, NAMESPACE.HUB_BATTERY, {});
  mergeHubPayload(device, NAMESPACE.HUB_BATTERY, { battery: 'nope' });
  mergeHubPayload(device, NAMESPACE.HUB_BATTERY, { battery: [{ value: 10 }] }); // no id

  assert.equal(device.subDevices.size, 3);
  assert.equal(device.subDevices.get('0000A1B2').state.battery.value, 87);
});

// --- Poll coalescing ---------------------------------------------------------

/** A client whose hub reads are counted instead of being sent anywhere. */
function createCountingClient() {
  const client = new MerossClient();
  client.session = { key: 'k', token: 't', userId: '1', mqttDomain: 'x' };
  client.reads = [];
  client.request = async (uuid, namespace) => {
    client.reads.push(namespace);
    return { [HUB_PAYLOAD_KEYS[namespace]]: [] };
  };
  return client;
}

test('simultaneous sub-device polls share a single hub read', async () => {
  // Three sub-devices poll at the same time; the hub must be read once.
  const client = createCountingClient();
  const device = smartHub();

  await Promise.all([
    client.refreshSubDeviceStates(device),
    client.refreshSubDeviceStates(device),
    client.refreshSubDeviceStates(device),
  ]);

  assert.equal(client.reads.length, 5, 'one read per declared hub namespace, not three times five');
});

test('a poll that just completed is not repeated', async () => {
  const client = createCountingClient();
  const device = smartHub();

  await client.refreshSubDeviceStates(device);
  const afterFirst = client.reads.length;
  await client.refreshSubDeviceStates(device);

  assert.equal(client.reads.length, afterFirst);
});

test('the hub is read again once the coalescing window has passed', async () => {
  const client = createCountingClient();
  const device = smartHub();

  await client.refreshSubDeviceStates(device);
  const afterFirst = client.reads.length;
  await client.refreshSubDeviceStates(device, { maxAgeMs: 0 });

  assert.equal(client.reads.length, afterFirst * 2);
});

test('a failed hub read does not wedge the coalescing guard', async () => {
  const client = createCountingClient();
  const device = smartHub();
  client.request = async () => {
    throw new Error('hub offline');
  };

  // Namespace failures are logged and swallowed, so this resolves...
  await client.refreshSubDeviceStates(device);
  // ...and the next call is free to try again rather than reusing a dead promise.
  assert.equal(device.subDeviceRefresh.promise, undefined);
});

// --- Probing unmodelled namespaces -------------------------------------------

test('probing only reads namespaces the device advertises', async () => {
  const client = createCountingClient();
  const device = smartHub();
  // A sprinkler hub: it advertises the watering family.
  device.ability['Appliance.Control.Water'] = {};
  device.ability['Appliance.Digest.WaterPlan'] = {};

  const results = await client.probeNamespaces(device);

  assert.deepEqual(results.map((r) => r.namespace).sort(), [
    'Appliance.Control.Water',
    'Appliance.Digest.WaterPlan',
  ]);
  // Nothing outside the advertised set was asked for.
  for (const namespace of client.reads) {
    assert.ok(namespace in device.ability);
  }
});

test('probing never sends anything but a GET', async () => {
  // Guessing a SET on a watering system could rewrite a schedule or open a
  // valve, so the probe must stay strictly read-only.
  const client = createCountingClient();
  const device = smartHub();
  device.ability['Appliance.Control.Water'] = {};

  const methods = [];
  client.request = async (uuid, namespace, method) => {
    methods.push(method);
    return {};
  };

  await client.probeNamespaces(device);
  assert.deepEqual(methods, ['GET']);
});

test('a namespace that refuses the probe is reported, not thrown', async () => {
  const client = createCountingClient();
  const device = smartHub();
  device.ability['Appliance.Control.Water'] = {};
  client.request = async () => {
    throw new Error('Meross refused the message (Appliance.Hub.Exception): {}');
  };

  const [result] = await client.probeNamespaces(device);

  assert.equal(result.namespace, 'Appliance.Control.Water');
  assert.match(result.error, /Appliance\.Hub\.Exception/);
});

test('a device advertising none of the probed namespaces is left alone', async () => {
  const client = createCountingClient();
  const results = await client.probeNamespaces(powerPlug());

  assert.deepEqual(results, []);
  assert.equal(client.reads.length, 0);
});

// --- Refusing to send what the hub cannot do ---------------------------------

test('a command needing a namespace the hub lacks fails with a useful message', async () => {
  // Better a visible failure naming what is missing than a message the hub
  // silently refuses while Gladys shows the switch as flipped.
  const device = smartHub();
  delete device.ability[NAMESPACE.HUB_TOGGLEX];
  const client = createCountingClient();

  await assert.rejects(
    () =>
      hub.onSetValue(client, {
        device,
        subDeviceId: '0000C3D4',
        kind: 'on-off',
        value: 1,
      }),
    (err) => {
      assert.match(err.message, /does not support Appliance\.Hub\.ToggleX/);
      // It must also say what the hub DOES offer, to guide the next step.
      assert.match(err.message, /Appliance\.Hub\./);
      return true;
    },
  );

  assert.equal(client.reads.length, 0, 'nothing should have been sent');
});

test('a command the hub supports is still sent normally', async () => {
  const device = smartHub();
  const client = createCountingClient();

  await hub.onSetValue(client, {
    device,
    subDeviceId: '0000C3D4',
    kind: 'on-off',
    value: 1,
  });

  assert.deepEqual(client.reads, [NAMESPACE.HUB_TOGGLEX]);
});

test('a sub-device platform id survives the round trip', () => {
  const hubUuid = smartHub().uuid;
  const platformId = subDevicePlatformId(hubUuid, '0000A1B2');

  assert.deepEqual(parseDeviceExternalId(`ext:sel:meross:${platformId}`), {
    uuid: hubUuid,
    subDeviceId: '0000A1B2',
  });
});

test('a plain device external_id resolves with no sub-device', () => {
  assert.deepEqual(parseDeviceExternalId('ext:sel:meross:1806239851916890865148e1e9aa11f1'), {
    uuid: '1806239851916890865148e1e9aa11f1',
    subDeviceId: null,
  });
});
