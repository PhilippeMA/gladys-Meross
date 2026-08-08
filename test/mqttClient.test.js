// -----------------------------------------------------------------------------
// Correlating a cloud reply with the command that asked for it.
//
// This is where a working integration and a silent one differ. A command that
// reaches the device but whose answer we fail to recognise is indistinguishable,
// from the outside, from a command that never arrived — and the two have
// opposite fixes.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MerossMqttClient } from '../src/meross/mqttClient.js';
import { buildMessage, METHOD, NAMESPACE } from '../src/meross/protocol.js';

const KEY = 'the-account-key';
const UUID = '25111744516971620801c4e7ae24d682';

/** A client wired to a fake broker: no socket, but `request()` works. */
function createClient({ onPush } = {}) {
  const client = new MerossMqttClient({ domain: 'broker', userId: '42', key: KEY, onPush });
  const published = [];
  client.client = {
    connected: true,
    publishAsync: async (topic, payload) => {
      published.push({ topic, payload: JSON.parse(payload) });
    },
  };
  client.published = published;
  return client;
}

/** Feed the client a correctly signed message, as the broker would. */
function deliver(client, { namespace, method, payload, messageId }) {
  const message = buildMessage({
    namespace,
    method,
    payload,
    key: KEY,
    from: `/appliance/${UUID}/publish`,
    messageId,
  });
  client.handleInbound(client.replyTopic, Buffer.from(JSON.stringify(message)));
}

/**
 * Hold the event loop open past a request timeout. The pending timer is
 * `unref`'d — so it never delays a shutdown — which also means it would never
 * fire in a test process that has nothing else to do.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The messageId the client generated for its one in-flight request. */
function pendingId(client) {
  return [...client.pending.keys()][0];
}

test('a PUSH carrying our messageId is the reply, not an unrelated event', async () => {
  // A hub acknowledges some commands by PUSHing the state that resulted from
  // them rather than by sending a SETACK. Requiring a SETACK means waiting ten
  // seconds for an answer already in hand, then reporting a failure for a
  // command that worked. This is exactly how watering failed.
  const client = createClient();

  const reply = client.request(UUID, NAMESPACE.CONTROL_WATER, METHOD.SET, {
    control: [{ channel: 0, dura: 900, onoff: 1, subId: '1B0091AFC74E' }],
  });
  await Promise.resolve();

  deliver(client, {
    namespace: NAMESPACE.CONTROL_WATER,
    method: METHOD.PUSH,
    payload: { control: [{ subId: '1B0091AFC74E', channel: 0, dura: 900, onoff: 1 }] },
    messageId: pendingId(client),
  });

  assert.deepEqual(await reply, {
    control: [{ subId: '1B0091AFC74E', channel: 0, dura: 900, onoff: 1 }],
  });
});

test('a PUSH that answers a command is still handled as a push', async () => {
  // It resolves the command AND announces the new state. Consuming it as a
  // reply only would leave Gladys showing the old state until the next poll.
  const pushes = [];
  const client = createClient({ onPush: (uuid, message) => pushes.push({ uuid, message }) });

  const reply = client.request(UUID, NAMESPACE.CONTROL_WATER, METHOD.SET, {});
  await Promise.resolve();
  deliver(client, {
    namespace: NAMESPACE.CONTROL_WATER,
    method: METHOD.PUSH,
    payload: { control: [{ subId: '1B0091AFC74E', onoff: 1 }] },
    messageId: pendingId(client),
  });

  await reply;
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].uuid, UUID);
  assert.equal(pushes[0].message.header.namespace, NAMESPACE.CONTROL_WATER);
});

test('a SETACK is consumed by the command and not replayed as a push', async () => {
  // The other half of the rule: an ack carries no news, and feeding it to the
  // push path would merge a reply payload into the device digest.
  const pushes = [];
  const client = createClient({ onPush: (uuid, message) => pushes.push({ uuid, message }) });

  const reply = client.request(UUID, NAMESPACE.HUB_TOGGLEX, METHOD.SET, {});
  await Promise.resolve();
  deliver(client, {
    namespace: NAMESPACE.HUB_TOGGLEX,
    method: 'SETACK',
    payload: { togglex: [{ id: '1B0091AFC74E', onoff: 1 }] },
    messageId: pendingId(client),
  });

  await reply;
  assert.deepEqual(pushes, []);
});

test('a reply about another namespace does not resolve the request', async () => {
  // The messageId alone is not enough: matching on it only would let an
  // unrelated message satisfy a command and report success for nothing.
  const client = createClient();

  const reply = client.request(UUID, NAMESPACE.CONTROL_WATER, METHOD.SET, {}, 60);
  await Promise.resolve();
  const messageId = pendingId(client);

  deliver(client, {
    namespace: NAMESPACE.HUB_BATTERY,
    method: METHOD.PUSH,
    payload: { battery: [] },
    messageId,
  });

  const settled = assert.rejects(() => reply, /did not answer Appliance\.Control\.Water/);
  await sleep(120);
  await settled;
});

test('a refusal namespace still rejects the command', async () => {
  // A refusal comes back under a DIFFERENT namespace, so it cannot be matched
  // by namespace equality — it has its own branch, and it must keep working.
  const client = createClient();

  const reply = client.request(UUID, NAMESPACE.CONTROL_WATER, METHOD.SET, {}, 60);
  await Promise.resolve();

  deliver(client, {
    namespace: 'Appliance.Control.Error',
    method: METHOD.PUSH,
    payload: { error: { code: 5000 } },
    messageId: pendingId(client),
  });

  await assert.rejects(() => reply, /Meross refused the message/);
});

test('a timeout reports what arrived instead of the answer', async () => {
  // "No answer" and "an answer we did not recognise" look identical from the
  // outside. Naming what did arrive is what separates them.
  const client = createClient();

  const reply = client.request(UUID, NAMESPACE.CONTROL_WATER, METHOD.SET, {}, 60);
  await Promise.resolve();

  deliver(client, {
    namespace: 'Appliance.Control.WaterEvent',
    method: METHOD.PUSH,
    payload: {},
    messageId: 'f'.repeat(32),
  });

  const settled = assert.rejects(() => reply, /PUSH Appliance\.Control\.WaterEvent/);
  await sleep(120);
  await settled;
});

test('a timeout with nothing at all received says so', async () => {
  const client = createClient();
  const settled = assert.rejects(
    () => client.request(UUID, NAMESPACE.CONTROL_WATER, METHOD.SET, {}, 60),
    /Nothing at all arrived on the reply topic/,
  );
  await sleep(120);
  await settled;
});

test('a message signed with another key is dropped', async () => {
  // Unchanged, but worth pinning next to the loosened matching: the signature
  // is what stops a foreign message from resolving one of our commands.
  const client = createClient();

  const reply = client.request(UUID, NAMESPACE.CONTROL_WATER, METHOD.SET, {}, 60);
  await Promise.resolve();

  const forged = buildMessage({
    namespace: NAMESPACE.CONTROL_WATER,
    method: METHOD.PUSH,
    payload: { control: [] },
    key: 'someone-elses-key',
    messageId: pendingId(client),
  });
  client.handleInbound(client.replyTopic, Buffer.from(JSON.stringify(forged)));

  const settled = assert.rejects(() => reply, /did not answer/);
  await sleep(120);
  await settled;
});
