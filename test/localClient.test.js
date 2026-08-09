// -----------------------------------------------------------------------------
// The LAN transport, against real sockets.
//
// The one bug that mattered here could not be caught by a mocked HTTP client:
// Meross firmware ends its status line with a bare LF, and only a real parser
// on a real socket reproduces what that does. So these tests speak raw TCP.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { localRequest } from '../src/meross/localClient.js';

const KEY = 'the-account-key';

/**
 * A server that writes bytes verbatim — no HTTP library between the test and
 * the wire, because the bytes are the subject.
 */
async function rawServer(respond) {
  const server = net.createServer((socket) => {
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      const headerEnd = received.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }
      const length = Number(/content-length: (\d+)/i.exec(received)?.[1] ?? 0);
      if (received.length < headerEnd + 4 + length) {
        return;
      }
      socket.end(respond(received.slice(headerEnd + 4)));
    });
    socket.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

function merossReply(payload) {
  return JSON.stringify({ header: { namespace: 'Appliance.System.All' }, payload });
}

test('a reply whose status line ends in a bare LF is accepted', async () => {
  // THE bug. Meross firmware writes "HTTP/1.1 200 OK\n" instead of "...\r\n".
  // A strict parser throws the whole response away over that one byte and
  // reports a failure indistinguishable from an unreachable device.
  const body = merossReply({ all: { system: { firmware: { innerIp: '192.168.50.24' } } } });
  const { server, port } = await rawServer(
    () =>
      `HTTP/1.1 200 OK\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );

  try {
    const payload = await localRequest({
      ip: '127.0.0.1',
      port,
      key: KEY,
      namespace: 'Appliance.System.All',
      method: 'GET',
    });
    assert.equal(payload.all.system.firmware.innerIp, '192.168.50.24');
  } finally {
    server.close();
  }
});

test('a well-formed reply still works', async () => {
  const body = merossReply({ all: { digest: {} } });
  const { server, port } = await rawServer(
    () => `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );

  try {
    const payload = await localRequest({
      ip: '127.0.0.1',
      port,
      key: KEY,
      namespace: 'Appliance.System.All',
      method: 'GET',
    });
    assert.deepEqual(payload, { all: { digest: {} } });
  } finally {
    server.close();
  }
});

test('the request carries the signed envelope the firmware expects', async () => {
  let sent = null;
  const body = merossReply({});
  const { server, port } = await rawServer((requestBody) => {
    sent = JSON.parse(requestBody);
    return `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  });

  try {
    await localRequest({
      ip: '127.0.0.1',
      port,
      key: KEY,
      uuid: 'the-uuid',
      namespace: 'Appliance.Control.Water',
      method: 'SET',
      payload: { control: [{ subId: 'X', channel: 0, onoff: 2 }] },
    });

    assert.match(sent.header.sign, /^[0-9a-f]{32}$/);
    assert.equal(sent.header.namespace, 'Appliance.Control.Water');
    assert.equal(sent.header.method, 'SET');
    assert.equal(sent.header.uuid, 'the-uuid');
    assert.match(sent.header.from, /^http:\/\/127\.0\.0\.1:\d+\/config$/);
    assert.deepEqual(sent.payload.control, [{ subId: 'X', channel: 0, onoff: 2 }]);
  } finally {
    server.close();
  }
});

test('a non-2xx reply is reported with its status, body and headers', async () => {
  // An MSH400 answers 470 with an empty body on port 5010. 470 means nothing on
  // its own, so everything the response carries has to be reported.
  const { server, port } = await rawServer(
    () => `HTTP/1.1 470 \r\nContent-Length: 0\r\nServer: nginx\r\n\r\n`,
  );

  try {
    await assert.rejects(
      () =>
        localRequest({
          ip: '127.0.0.1',
          port,
          key: KEY,
          namespace: 'Appliance.System.All',
          method: 'GET',
        }),
      (err) => {
        assert.match(err.message, /HTTP 470/);
        assert.match(err.message, /empty body/);
        assert.match(err.message, /server: nginx/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test('a 200 that is not JSON says so instead of throwing a parser error', async () => {
  const { server, port } = await rawServer(
    () => `HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nhello there`,
  );

  try {
    await assert.rejects(
      () =>
        localRequest({
          ip: '127.0.0.1',
          port,
          key: KEY,
          namespace: 'Appliance.System.All',
          method: 'GET',
        }),
      /not JSON: hello there/,
    );
  } finally {
    server.close();
  }
});

test('a device that accepts the connection and says nothing times out', async () => {
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    await assert.rejects(
      () =>
        localRequest({
          ip: '127.0.0.1',
          port,
          key: KEY,
          namespace: 'Appliance.System.All',
          method: 'GET',
          timeoutMs: 150,
        }),
      /packets are being dropped|timed out/,
    );
  } finally {
    server.close();
  }
});

test('a closed port is named as such, not as a generic failure', async () => {
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  await assert.rejects(
    () =>
      localRequest({
        ip: '127.0.0.1',
        port,
        key: KEY,
        namespace: 'Appliance.System.All',
        method: 'GET',
      }),
    /nothing is listening/,
  );
});

// --- One request at a time ---------------------------------------------------

test('LAN requests to one device never overlap', async () => {
  // Meross firmware serves a single local request at a time. A command, its
  // read-back and a poll all fire at once, and overlapping them earns
  // ECONNRESET and ETIMEDOUT — which read as an unreachable device and demote
  // the transport to the cloud, for what was only ever a queueing problem.
  const { MerossClient } = await import('../src/meross/client.js');

  let inFlight = 0;
  let peak = 0;
  const server = net.createServer((socket) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    socket.on('data', () => {
      setTimeout(() => {
        const body = merossReply({ all: {} });
        socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        inFlight -= 1;
      }, 25);
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const client = new MerossClient();
  client.session = { key: KEY };
  client.preferLocal = true;
  client.devices.set('hub', {
    uuid: 'hub',
    name: 'Smart Hub',
    ip: '127.0.0.1',
    localPort: server.address().port,
    localOk: true,
    ability: {},
  });

  try {
    await Promise.all(
      Array.from({ length: 6 }, () => client.request('hub', 'Appliance.System.All', 'GET')),
    );
    assert.equal(peak, 1, 'no two LAN calls to the same device were open together');
  } finally {
    server.close();
  }
});

test('one device queueing does not hold up another', async () => {
  // The chain is per device: a slow hub must not stall a plug on the same LAN.
  const { MerossClient } = await import('../src/meross/client.js');

  const body = merossReply({ all: {} });
  const { server, port } = await rawServer(
    () => `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );

  const client = new MerossClient();
  client.session = { key: KEY };
  client.preferLocal = true;
  for (const uuid of ['hub', 'plug']) {
    client.devices.set(uuid, {
      uuid,
      name: uuid,
      ip: '127.0.0.1',
      localPort: port,
      localOk: true,
      ability: {},
    });
  }

  try {
    await Promise.all([
      client.request('hub', 'Appliance.System.All', 'GET'),
      client.request('plug', 'Appliance.System.All', 'GET'),
    ]);
    assert.equal(client.localChains.size, 2, 'each device has its own chain');
  } finally {
    server.close();
  }
});

test('a failed LAN call does not wedge the queue behind it', async () => {
  // The chain must advance on rejection too, or one bad command silences the
  // device for good.
  const { MerossClient } = await import('../src/meross/client.js');

  let first = true;
  const body = merossReply({ all: {} });
  const { server, port } = await rawServer(() => {
    if (first) {
      first = false;
      return 'not http at all';
    }
    return `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  });

  const client = new MerossClient();
  client.session = { key: KEY };
  client.preferLocal = true;
  const device = {
    uuid: 'hub',
    name: 'Smart Hub',
    ip: '127.0.0.1',
    localPort: port,
    localOk: true,
    ability: {},
  };
  client.devices.set('hub', device);

  try {
    await client.requestLocal('hub', 'Appliance.System.All', 'GET').catch(() => {});
    const payload = await client.requestLocal('hub', 'Appliance.System.All', 'GET');
    assert.deepEqual(payload, { all: {} });
  } finally {
    server.close();
  }
});

test('the header is probeable without breaking the signature', async () => {
  // The signature covers messageId, key and timestamp only, so the rest of the
  // header can be varied freely — which is what makes it possible to ask a
  // firmware which header it will accept.
  let sent = null;
  const body = merossReply({});
  const { server, port } = await rawServer((requestBody) => {
    sent = JSON.parse(requestBody);
    return `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  });

  try {
    await localRequest({
      ip: '127.0.0.1',
      port,
      key: KEY,
      uuid: 'the-uuid',
      namespace: 'Appliance.Control.Water',
      method: 'SET',
      from: 'MerossClient',
      triggerSrc: 'Device',
      includeUuid: false,
    });

    assert.equal(sent.header.from, 'MerossClient', 'a name, not the URL');
    assert.equal(sent.header.triggerSrc, 'Device');
    assert.equal('uuid' in sent.header, false);
    assert.match(sent.header.sign, /^[0-9a-f]{32}$/);
  } finally {
    server.close();
  }
});

test('by default a local request carries triggerSrc and the uuid', async () => {
  let sent = null;
  const body = merossReply({});
  const { server, port } = await rawServer((requestBody) => {
    sent = JSON.parse(requestBody);
    return `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  });

  try {
    await localRequest({
      ip: '127.0.0.1',
      port,
      key: KEY,
      uuid: 'the-uuid',
      namespace: 'Appliance.System.All',
      method: 'GET',
    });

    assert.equal(sent.header.triggerSrc, 'MerossClient');
    assert.equal(sent.header.uuid, 'the-uuid');
    assert.match(sent.header.from, /^http:\/\/127\.0\.0\.1:\d+\/config$/);
  } finally {
    server.close();
  }
});

test('the watering header probe can only ever stop, never start', async () => {
  // This is the one diagnostic that writes, and what makes it acceptable is
  // that a stop does nothing when nothing is running. It matters more here than
  // usual: a watering SET this firmware refuses restarts the hub, so a shape
  // able to open a valve would water someone's garden AND reboot their hub,
  // unattended.
  const { MerossClient } = await import('../src/meross/client.js');

  const sent = [];
  const { server, port } = await rawServer((requestBody) => {
    sent.push(JSON.parse(requestBody));
    // Refuse every one, so the sweep runs to the end and every variant is seen.
    return `HTTP/1.1 470 \r\nContent-Length: 0\r\n\r\n`;
  });

  const client = new MerossClient();
  client.session = { key: KEY };
  const device = {
    uuid: 'hub',
    name: 'Smart Hub',
    ip: '127.0.0.1',
    localPort: port,
    ability: {},
  };

  try {
    const results = await client.probeWateringLocalHeaders(device, '1B0091AFC74E', {
      settleMs: 0,
    });

    assert.ok(results.length > 1, 'every variant was tried');
    assert.equal(sent.length, results.length);

    for (const message of sent) {
      assert.equal(message.header.namespace, 'Appliance.Control.Water');
      for (const entry of message.payload.control) {
        assert.equal(entry.onoff, 2, `${JSON.stringify(entry)} must be a stop`);
        assert.equal('dura' in entry, false, 'and carry no duration');
        assert.equal(entry.subId, '1B0091AFC74E');
      }
    }

    // The variants really do differ, or the sweep measures nothing.
    const headers = sent.map((m) =>
      JSON.stringify([m.header.from, m.header.triggerSrc, m.header.uuid]),
    );
    assert.equal(new Set(headers).size, headers.length, 'each variant sends a different header');
  } finally {
    server.close();
  }
});

test('the header sweep stops at the first header the hub accepts', async () => {
  // Each refused attempt costs the hub a restart, so there is no reason to keep
  // going once one is answered.
  const { MerossClient } = await import('../src/meross/client.js');

  let calls = 0;
  const body = merossReply({ control: [] });
  const { server, port } = await rawServer(() => {
    calls += 1;
    return `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  });

  const client = new MerossClient();
  client.session = { key: KEY };

  try {
    const results = await client.probeWateringLocalHeaders(
      { uuid: 'hub', name: 'Smart Hub', ip: '127.0.0.1', localPort: port, ability: {} },
      '1B0091AFC74E',
      { settleMs: 0 },
    );

    assert.equal(calls, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].label, 'meross_lan header', 'the likeliest header goes first');
  } finally {
    server.close();
  }
});
