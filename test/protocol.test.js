// -----------------------------------------------------------------------------
// The wire protocol: signature, envelope, unit conversions.
//
// These are the tests worth having. A drifting signature does not crash: the
// devices simply stop answering, and nothing tells you why.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildMessage,
  generateMessageId,
  intToRgb,
  isErrorNamespace,
  isSignatureValid,
  LIGHT_CAPACITY,
  md5,
  METHOD,
  NAMESPACE,
  normalizeElectricity,
  rgbToInt,
  signMessage,
  toRgbInt,
} from '../src/meross/protocol.js';

test('md5 matches the reference digest', () => {
  assert.equal(md5('meross'), createHash('md5').update('meross').digest('hex'));
});

test('a message is signed with md5(messageId + key + timestamp)', () => {
  const message = buildMessage({
    namespace: NAMESPACE.CONTROL_TOGGLEX,
    method: METHOD.SET,
    payload: { togglex: { channel: 0, onoff: 1 } },
    key: 'secret-key',
    messageId: 'a'.repeat(32),
    timestamp: 1700000000,
  });

  assert.equal(message.header.sign, md5(`${'a'.repeat(32)}secret-key1700000000`));
  assert.equal(message.header.sign, signMessage('a'.repeat(32), 'secret-key', 1700000000));
});

test('a message carries the full Meross envelope', () => {
  const message = buildMessage({
    namespace: NAMESPACE.SYSTEM_ALL,
    method: METHOD.GET,
    key: 'k',
    from: '/app/42-abc/subscribe',
    messageId: 'b'.repeat(32),
    timestamp: 1700000001,
  });

  assert.deepEqual(message, {
    header: {
      messageId: 'b'.repeat(32),
      namespace: 'Appliance.System.All',
      method: 'GET',
      payloadVersion: 1,
      from: '/app/42-abc/subscribe',
      timestamp: 1700000001,
      timestampMs: 0,
      sign: md5(`${'b'.repeat(32)}k1700000001`),
    },
    payload: {},
  });
});

test('generateMessageId returns a fresh 32-hex-char id', () => {
  const first = generateMessageId();
  const second = generateMessageId();
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.notEqual(first, second);
});

test('isSignatureValid accepts a message signed with our key', () => {
  const message = buildMessage({
    namespace: NAMESPACE.CONTROL_TOGGLEX,
    method: METHOD.PUSH,
    key: 'the-key',
  });
  assert.equal(isSignatureValid(message, 'the-key'), true);
});

test('isSignatureValid rejects a foreign or unsigned message', () => {
  const message = buildMessage({
    namespace: NAMESPACE.CONTROL_TOGGLEX,
    method: METHOD.PUSH,
    key: 'the-key',
  });

  assert.equal(isSignatureValid(message, 'another-key'), false);
  assert.equal(isSignatureValid({ header: {} }, 'the-key'), false);
  assert.equal(isSignatureValid({}, 'the-key'), false);
  assert.equal(isSignatureValid(null, 'the-key'), false);
});

test('electricity is converted from Meross sub-units to SI units', () => {
  // 123456 mW, 2345 dV, 543 mA
  assert.deepEqual(normalizeElectricity({ power: 123456, voltage: 2345, current: 543 }), {
    power: 123.46,
    voltage: 234.5,
    current: 0.543,
  });
});

test('a missing electricity field reads as zero, never NaN', () => {
  assert.deepEqual(normalizeElectricity({}), { power: 0, voltage: 0, current: 0 });
  assert.deepEqual(normalizeElectricity(), { power: 0, voltage: 0, current: 0 });
});

test('rgb integers survive the round trip', () => {
  assert.deepEqual(intToRgb(0xff8800), { r: 255, g: 136, b: 0 });
  assert.equal(rgbToInt({ r: 255, g: 136, b: 0 }), 0xff8800);
  assert.equal(rgbToInt(intToRgb(0x123456)), 0x123456);
});

test('rgb values are clamped into the 24-bit range', () => {
  assert.equal(toRgbInt(-1), 0);
  assert.equal(toRgbInt(0xffffff + 100), 0xffffff);
  assert.equal(toRgbInt('not a number'), 0);
  assert.equal(rgbToInt({ r: 999, g: -5, b: 12.6 }), (255 << 16) | (0 << 8) | 13);
});

test('a refusal namespace is recognised as an error, not as a reply', () => {
  // A refused command comes back as a normal, correctly signed message: only
  // the namespace says it failed. Missing that reports success for a no-op.
  assert.equal(isErrorNamespace('Appliance.Control.Error'), true);
  assert.equal(isErrorNamespace('Appliance.Hub.Exception'), true);
  assert.equal(isErrorNamespace('Appliance.System.Error'), true);

  assert.equal(isErrorNamespace('Appliance.Hub.ToggleX'), false);
  assert.equal(isErrorNamespace('Appliance.Control.ToggleX'), false);
  assert.equal(isErrorNamespace(undefined), false);
  assert.equal(isErrorNamespace(null), false);
});

test('light capacity bits are the Meross ones', () => {
  assert.deepEqual(LIGHT_CAPACITY, { RGB: 1, TEMPERATURE: 2, LUMINANCE: 4 });
});
