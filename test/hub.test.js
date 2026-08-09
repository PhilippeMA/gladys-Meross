// -----------------------------------------------------------------------------
// Hub-specific client behaviour: merging the per-family payloads a hub returns,
// and coalescing the burst of polls its sub-devices trigger.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHub, MerossClient, mergeHubPayload, mergeSubIdPayload } from '../src/meross/client.js';
import { buildMessage, HUB_PAYLOAD_KEYS, NAMESPACE } from '../src/meross/protocol.js';
import { TIMEOUT_ERROR_CODE } from '../src/meross/mqttClient.js';
import { parseDeviceExternalId, subDevicePlatformId } from '../src/devices/featureIds.js';
import * as hub from '../src/devices/hub.js';
import { publishDeviceStates } from '../src/devices/index.js';
import { powerPlug, smartHub, wateringTimer } from './helpers/merossFixtures.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

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
  assert.ok(methods.length > 0);
  assert.deepEqual([...new Set(methods)], ['GET']);
});

test('a namespace that refuses every shape reports what was tried', async () => {
  const client = createCountingClient();
  const device = smartHub();
  device.ability['Appliance.Control.Water'] = {};
  client.request = async () => {
    throw new Error('Meross returned error 5000 for Appliance.Control.Water');
  };

  const [result] = await client.probeNamespaces(device);

  assert.equal(result.namespace, 'Appliance.Control.Water');
  assert.equal(result.payload, undefined);
  // The confirmed key is `control`, and the sub-device is named `subId` —
  // neither is derivable from the namespace, which is why probing had failed.
  assert.deepEqual(
    result.attempts.map((a) => a.request),
    [
      {},
      { control: [] },
      { control: [{ subId: '0000A1B2' }] },
      { control: [{ subId: '0000C3D4' }] },
      { control: [{ subId: '0000E5F6' }] },
      { control: {} },
    ],
  );
  assert.match(result.attempts[0].error, /error 5000/);
});

test('probing keeps going past an accepted but empty read', async () => {
  // `{"latest":[]}` is accepted and comes back EMPTY: the key is right but the
  // data is not there. Stopping at that first success would hide the shape that
  // targets the sub-device by id — which is the informative one.
  const client = createCountingClient();
  const device = smartHub();
  device.ability['Appliance.Control.Water'] = {};

  client.request = async (uuid, namespace, method, payload) => {
    if (Object.keys(payload).length === 0) {
      throw new Error('Meross returned error 5000 for Appliance.Control.Water');
    }
    if (Array.isArray(payload.control) && payload.control.length === 0) {
      return { control: [] };
    }
    return { control: [{ subId: '0000C3D4', onoff: 1 }] };
  };

  const [result] = await client.probeNamespaces(device);

  const requests = result.successes.map((s) => JSON.stringify(s.request));
  assert.ok(requests.includes('{"control":[]}'), 'the empty read is reported');
  assert.ok(
    requests.includes('{"control":[{"subId":"0000C3D4"}]}'),
    'the targeted read must still be attempted',
  );
  const targeted = result.successes.find((s) => s.request.control?.[0]?.subId === '0000C3D4');
  assert.deepEqual(targeted.payload, { control: [{ subId: '0000C3D4', onoff: 1 }] });
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

  // The command itself, then the read-back that verifies it.
  assert.equal(client.reads[0], NAMESPACE.HUB_TOGGLEX);
});

// --- Watering (MST100) -------------------------------------------------------
// These payloads are copied from a real capture of the Meross Android app
// starting and stopping a watering. Every field matters and none is guessable,
// so they are pinned exactly.

function wateringHub() {
  const device = smartHub({ subDevices: new Map([['1B0091AFC74E', wateringTimer()]]) });
  device.ability[NAMESPACE.CONTROL_WATER] = {};
  return device;
}

test('a watering goes through the normal channel, cloud included', async () => {
  // This namespace looked LAN-only while the payload was wrong: keyed anything
  // but `control`, the hub answers with silence, which reads exactly like a
  // transport that does not carry it. With the right shape the cloud answers,
  // so pinning the command to the LAN would only break hubs Gladys cannot
  // reach directly.
  const device = wateringHub();
  const client = createCountingClient();
  const sent = [];
  client.request = async (uuid, namespace) => {
    sent.push(namespace);
    return {};
  };

  await hub.onSetValue(client, {
    gladys: createFakeGladys(),
    device,
    subDeviceId: '1B0091AFC74E',
    kind: 'watering',
    value: 1,
  });

  assert.deepEqual(sent, ['Appliance.Control.Water']);
});

test('starting a watering carries no duration of its own', async () => {
  // The app's captured request has a `dura`, and reproducing it OVERRIDES the
  // duration configured on the timer for that cycle. That is how this
  // integration came to overwrite its owner's setting with an invented default.
  // Left out, the timer waters for as long as it is configured to.
  const device = wateringHub();
  const client = createCountingClient();
  const sent = [];
  client.request = async (uuid, namespace, method, payload) => {
    sent.push({ uuid, namespace, method, payload });
    return {};
  };

  const applied = await hub.onSetValue(client, {
    gladys: createFakeGladys(),
    device,
    subDeviceId: '1B0091AFC74E',
    kind: 'watering',
    value: 1,
  });

  assert.deepEqual(sent[0], {
    uuid: device.uuid,
    namespace: 'Appliance.Control.Water',
    method: 'SET',
    // The sub-device is addressed by subId, and the key is `control`, not
    // `water`. No `dura`.
    payload: { control: [{ channel: 0, onoff: 1, subId: '1B0091AFC74E' }] },
  });
  assert.equal(applied, 1);
});

test('stopping a watering uses onoff 2 and omits the duration', async () => {
  // Sending 0 is NOT "stop" on this namespace.
  const device = wateringHub();
  const client = createCountingClient();
  const sent = [];
  client.request = async (uuid, namespace, method, payload) => {
    sent.push(payload);
    return {};
  };

  const applied = await hub.onSetValue(client, {
    gladys: createFakeGladys(),
    device,
    subDeviceId: '1B0091AFC74E',
    kind: 'watering',
    value: 0,
  });

  assert.deepEqual(sent[0], {
    control: [{ channel: 0, onoff: 2, subId: '1B0091AFC74E' }],
  });
  assert.ok(!('dura' in sent[0].control[0]), 'no duration when stopping');
  assert.equal(applied, 0);
});

test('setting the duration writes it to the timer, not to a local variable', async () => {
  // The whole point of the change: one duration, held by the device, edited by
  // the Meross app and by Gladys through the same field. A private copy here is
  // what made the two disagree.
  const device = wateringHub();
  device.ability['Appliance.Config.DeviceCfg'] = {};
  const client = createCountingClient();
  const sent = [];
  client.request = async (uuid, namespace, method, payload) => {
    sent.push({ namespace, method, payload });
    return {};
  };

  const applied = await hub.onSetValue(client, {
    gladys: createFakeGladys(),
    device,
    subDeviceId: '1B0091AFC74E',
    kind: 'watering-duration',
    value: 5,
  });

  assert.equal(applied, 5);
  assert.deepEqual(sent, [
    {
      namespace: 'Appliance.Config.DeviceCfg',
      method: 'SET',
      // Seconds, under the model's own config group.
      payload: { config: [{ channel: 0, subId: '1B0091AFC74E', mstCfg: { dura: 300 } }] },
    },
  ]);
  // And reflected locally so the feature does not snap back before the next poll.
  assert.equal(hub.wateringDuration(device.subDevices.get('1B0091AFC74E')), 5);
});

test('a hub that cannot configure the timer says so rather than pretending', async () => {
  const device = wateringHub();
  delete device.ability['Appliance.Config.DeviceCfg'];
  const client = createCountingClient();

  await assert.rejects(
    () =>
      hub.onSetValue(client, {
        gladys: createFakeGladys(),
        device,
        subDeviceId: '1B0091AFC74E',
        kind: 'watering-duration',
        value: 5,
      }),
    /does not support Appliance\.Config\.DeviceCfg/,
  );
});

test('an out-of-range duration is clamped rather than sent as-is', async () => {
  const device = wateringHub();
  device.ability['Appliance.Config.DeviceCfg'] = {};
  const client = createCountingClient();
  const sent = [];
  client.request = async (uuid, namespace, method, payload) => {
    sent.push(payload);
    return {};
  };

  assert.equal(
    await hub.onSetValue(client, {
      gladys: createFakeGladys(),
      device,
      subDeviceId: '1B0091AFC74E',
      kind: 'watering-duration',
      value: 0,
    }),
    1,
    'a zero-minute watering is not a watering',
  );
  assert.equal(sent[0].config[0].mstCfg.dura, 60);
});

test('a hub that cannot water refuses the command instead of sending it', async () => {
  const device = smartHub({ subDevices: new Map([['1B0091AFC74E', wateringTimer()]]) });
  // No Appliance.Control.Water on this hub.
  const client = createCountingClient();

  await assert.rejects(
    () =>
      hub.onSetValue(client, {
        gladys: createFakeGladys(),
        config: {},
        device,
        subDeviceId: '1B0091AFC74E',
        kind: 'watering',
        value: 1,
      }),
    /does not support Appliance\.Control\.Water/,
  );
});

test('a watering push is recorded against the sub-device it names', async () => {
  // `Appliance.Control.Water` targets `subId`, not the `id` every
  // Appliance.Hub.* namespace uses. Routing it like a hub payload would drop
  // it, and merging it into the digest would corrupt that.
  const device = wateringHub();

  mergeSubIdPayload(device, NAMESPACE.CONTROL_WATER, {
    control: [{ subId: '1B0091AFC74E', onoff: 1, dura: 900 }],
  });

  const sub = device.subDevices.get('1B0091AFC74E');
  assert.equal(sub.state.control.onoff, 1);
  assert.equal(sub.state.control.dura, 900);
  // The blocks it already had must survive.
  assert.equal(sub.state.battery.value, 98);
});

test('the watering switch reflects the pushed state, not what we asked for', async () => {
  const gladys = createFakeGladys();
  const device = wateringHub();

  // The timer reports a cycle in progress...
  mergeSubIdPayload(device, NAMESPACE.CONTROL_WATER, {
    control: [{ subId: '1B0091AFC74E', onoff: 1 }],
  });
  await publishDeviceStates(gladys, device);
  let states = Object.fromEntries(gladys.published.map((p) => [p.featureExternalId, p.state]));
  assert.equal(states[`meross:${device.uuid}-1B0091AFC74E:watering-0`], 1);

  // ...then that it stopped. onoff 2 is "off", not a second "on".
  gladys.published.length = 0;
  mergeSubIdPayload(device, NAMESPACE.CONTROL_WATER, {
    control: [{ subId: '1B0091AFC74E', onoff: 2 }],
  });
  await publishDeviceStates(gladys, device);
  states = Object.fromEntries(gladys.published.map((p) => [p.featureExternalId, p.state]));
  assert.equal(states[`meross:${device.uuid}-1B0091AFC74E:watering-0`], 0);
});

// --- Watering: which channel the hub will actually act on --------------------

function timeoutError() {
  const err = new Error('did not answer Appliance.Control.Water in time');
  err.code = TIMEOUT_ERROR_CODE;
  return err;
}

test('a watering the cloud swallows is retried on the LAN', async () => {
  // Confirmed against an MSH400: the hub answers a GET over the cloud, answers
  // a malformed SET with `error 5000` — so the namespace is dispatched — and
  // swallows a well-formed SET without a word. The same message over the LAN
  // is acted on. Giving up at the timeout would strand every hub like it.
  const device = wateringHub();
  const client = createCountingClient();
  const lan = [];
  client.request = async () => {
    throw timeoutError();
  };
  client.requestLocal = async (uuid, namespace, method, payload) => {
    lan.push({ namespace, method, payload });
    return {};
  };

  const applied = await hub.onSetValue(client, {
    gladys: createFakeGladys(),
    device,
    subDeviceId: '1B0091AFC74E',
    kind: 'watering',
    value: 1,
  });

  assert.equal(applied, 1);
  assert.equal(lan.length, 1);
  assert.deepEqual(lan[0].payload, {
    control: [{ channel: 0, onoff: 1, subId: '1B0091AFC74E' }],
  });
});

test('a refusal is reported, not retried on the LAN', async () => {
  // Only silence justifies the second attempt. A hub that answered `error 5000`
  // has understood the message and rejected it, and sending it again over
  // another pipe is noise.
  const device = wateringHub();
  const client = createCountingClient();
  let lanCalls = 0;
  client.request = async () => {
    throw new Error('Meross returned error 5000 for Appliance.Control.Water');
  };
  client.requestLocal = async () => {
    lanCalls += 1;
    return {};
  };

  await assert.rejects(
    () =>
      hub.onSetValue(client, {
        gladys: createFakeGladys(),
        config: {},
        device,
        subDeviceId: '1B0091AFC74E',
        kind: 'watering',
        value: 1,
      }),
    /error 5000/,
  );
  assert.equal(lanCalls, 0);
});

test('when neither channel works the error names both failures', async () => {
  // "Watering does not work" is not actionable. "No route to 192.168.50.24" is.
  const device = wateringHub();
  const client = createCountingClient();
  client.request = async () => {
    throw timeoutError();
  };
  client.requestLocal = async () => {
    throw new Error('192.168.50.24 did not answer (no route to the device (EHOSTUNREACH))');
  };

  await assert.rejects(
    () =>
      hub.onSetValue(client, {
        gladys: createFakeGladys(),
        config: {},
        device,
        subDeviceId: '1B0091AFC74E',
        kind: 'watering',
        value: 1,
      }),
    (err) => {
      assert.match(err.message, /stayed silent/, 'the cloud failure is named');
      assert.match(err.message, /192\.168\.50\.24/, 'and so is the address that failed');
      assert.match(err.message, /EHOSTUNREACH/, 'with the reason it failed');
      return true;
    },
  );
});

test('the duration is read from the device, never invented', async () => {
  // Two different `dura` fields exist, and only one is the setting:
  // Config.DeviceCfg holds what the Meross app edits, Control.Water holds the
  // length of the last cycle. Reading the second as the first made Gladys
  // report back whatever it had last sent.
  const device = wateringHub();
  const sub = device.subDevices.get('1B0091AFC74E');

  assert.equal(hub.wateringDuration(sub), null, 'nothing read yet, so nothing claimed');

  // Only a past cycle known: better than nothing, and honest about its origin.
  mergeSubIdPayload(device, NAMESPACE.CONTROL_WATER, {
    control: [{ subId: '1B0091AFC74E', onoff: 2, dura: 900 }],
  });
  assert.equal(hub.wateringDuration(sub), 15);

  // The configured value wins as soon as the device reports it.
  mergeSubIdPayload(device, NAMESPACE.CONFIG_DEVICECFG, {
    config: [{ subId: '1B0091AFC74E', channel: 0, mstCfg: { dura: 1200 } }],
  });
  assert.equal(hub.wateringDuration(sub), 20);
});

test('an unknown duration is left unpublished rather than filled in', async () => {
  // A device that has told us nothing gets no duration state at all. Publishing
  // a default here is what let Gladys present its own number as the timer's.
  const gladys = createFakeGladys();
  const device = wateringHub();

  await publishDeviceStates(gladys, device);
  const keys = gladys.published.map((p) => p.featureExternalId);

  assert.equal(
    keys.some((key) => key.endsWith(':watering-duration-0')),
    false,
  );
  assert.ok(keys.some((key) => key.endsWith(':battery-0')));
});

test('a command the sub-device ignores reports the state it really holds', async () => {
  // The hub accepts the message, the sub-device does nothing: a watering timer
  // cannot be started by a plain on/off. Publishing the REQUESTED value would
  // make the switch flip on and fall back on the next poll, unexplained.
  const device = smartHub();
  const client = createCountingClient();
  // The valve stays off no matter what is asked.
  device.subDevices.get('0000C3D4').state.togglex = { onoff: 0 };
  client.refreshSubDeviceStates = async () => device.subDevices;

  const applied = await hub.onSetValue(client, {
    device,
    subDeviceId: '0000C3D4',
    kind: 'on-off',
    value: 1,
  });

  assert.equal(applied, 0, 'the real state must win over the requested one');
});

test('a command the sub-device adopts reports the new state', async () => {
  const device = smartHub();
  const client = createCountingClient();
  client.refreshSubDeviceStates = async () => {
    device.subDevices.get('0000C3D4').state.togglex = { onoff: 1 };
    return device.subDevices;
  };

  const applied = await hub.onSetValue(client, {
    device,
    subDeviceId: '0000C3D4',
    kind: 'on-off',
    value: 1,
  });

  assert.equal(applied, 1);
});

test('a failed read-back falls back to the requested value', async () => {
  // The command WAS accepted; only the verification failed. Inventing a state
  // would be worse than reporting what was asked for.
  const device = smartHub();
  const client = createCountingClient();
  client.refreshSubDeviceStates = async () => {
    throw new Error('hub unreachable');
  };

  const applied = await hub.onSetValue(client, {
    device,
    subDeviceId: '0000C3D4',
    kind: 'on-off',
    value: 1,
  });

  assert.equal(applied, 1);
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

test('the watering command logs the exact message and the exact answer', async () => {
  // A command that is accepted and does nothing can only be argued about
  // against the bytes that went out and the answer that came back. Summarising
  // either one is how "it does not work" stays unfalsifiable.
  const device = wateringHub();
  device.localOk = true;
  device.ip = '192.168.50.24';
  const client = createCountingClient();
  client.request = async () => ({ control: [{ subId: '1B0091AFC74E', onoff: 1, dura: 900 }] });

  mergeSubIdPayload(device, NAMESPACE.CONFIG_DEVICECFG, {
    config: [{ subId: '1B0091AFC74E', channel: 0, mstCfg: { dura: 1200 } }],
  });

  const lines = [];
  const originalInfo = console.info;
  const originalLog = console.log;
  const capture = (...args) => lines.push(args.join(' '));
  console.info = capture;
  console.log = capture;

  try {
    await hub.onSetValue(client, {
      gladys: createFakeGladys(),
      device,
      subDeviceId: '1B0091AFC74E',
      kind: 'watering',
      value: 1,
    });
  } finally {
    console.info = originalInfo;
    console.log = originalLog;
  }

  const all = lines.join('\n');
  const request = lines.find((line) => line.includes('Watering command over'));

  assert.match(request, /LAN 192\.168\.50\.24/, 'the channel actually used');
  assert.match(request, /"onoff":1/, 'the payload verbatim');
  assert.equal(/"dura"/.test(request), false, 'and no duration of our own in it');
  assert.match(request, /configured duration: 1200 s/, 'what the timer is set to');
  assert.match(all, /hub answered/, 'and what came back');
});

test('the watering command goes out with triggerSrc in its header', async () => {
  // End to end, from the Gladys feature down to the bytes on the wire. The
  // transport-level guard covers `localRequest`; this one covers the path that
  // actually carries a watering, so a future refactor cannot route around it
  // and quietly start rebooting people's hubs again.
  const device = wateringHub();
  const client = createCountingClient();

  const sent = [];
  client.request = async (uuid, namespace, method, payload) => {
    sent.push(
      buildMessage({ namespace, method, payload, key: 'k', from: 'http://x/config', uuid }),
    );
    return {};
  };

  await hub.onSetValue(client, {
    gladys: createFakeGladys(),
    device,
    subDeviceId: '1B0091AFC74E',
    kind: 'watering',
    value: 1,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].header.triggerSrc, 'MerossClient');
  assert.equal(sent[0].header.namespace, 'Appliance.Control.Water');
});
