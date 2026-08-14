// -----------------------------------------------------------------------------
// Cloud API: request signing and error surfacing.
//
// The Meross API answers HTTP 200 even when it refuses you, so the `apiStatus`
// handling below is the only thing standing between a wrong password and a
// silent, deviceless integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSignedBody,
  checkApiStatus,
  LOGIN_WONT_HELP_STATUSES,
  MerossApiError,
  REGION_ENDPOINTS,
} from '../src/meross/cloudApi.js';
import { md5 } from '../src/meross/protocol.js';

const SECRET = '23x17ahWarFH6w29';

test('the signed body carries base64 params and their md5 signature', () => {
  const body = buildSignedBody({ email: 'a@b.c' }, 1700000000000, 'NONCE1234567890A');

  const expectedParams = Buffer.from(JSON.stringify({ email: 'a@b.c' })).toString('base64');
  assert.equal(body.params, expectedParams);
  assert.equal(body.timestamp, 1700000000000);
  assert.equal(body.nonce, 'NONCE1234567890A');
  assert.equal(body.sign, md5(`${SECRET}1700000000000NONCE1234567890A${expectedParams}`));
});

test('params round-trip back to the original data', () => {
  const data = { email: 'user@example.com', password: 'hashed', encryption: 1 };
  const body = buildSignedBody(data);
  assert.deepEqual(JSON.parse(Buffer.from(body.params, 'base64').toString('utf8')), data);
});

test('a random nonce is generated when none is given', () => {
  const first = buildSignedBody({});
  const second = buildSignedBody({});
  assert.match(first.nonce, /^[A-Z0-9]{16}$/);
  assert.notEqual(first.nonce, second.nonce);
});

test('checkApiStatus returns the data on apiStatus 0', () => {
  assert.deepEqual(checkApiStatus({ apiStatus: 0, data: { token: 't' } }), { token: 't' });
});

test('a known apiStatus becomes a readable error', () => {
  assert.throws(
    () => checkApiStatus({ apiStatus: 1004, info: 'raw' }),
    (err) => {
      assert.ok(err instanceof MerossApiError);
      assert.equal(err.apiStatus, 1004);
      assert.match(err.message, /Wrong email or password/);
      return true;
    },
  );
});

test('an unknown apiStatus still surfaces the API message', () => {
  assert.throws(
    () => checkApiStatus({ apiStatus: 9999, info: 'Something specific happened' }),
    /Meross API error 9999: Something specific happened/,
  );
});

test('a rejected session asks for a fresh login by default', () => {
  // The one that broke a working install: 1022 was not on the old allow-list,
  // so the integration threw instead of logging in again — and never recovered.
  assert.equal(new MerossApiError(1022).needsFreshLogin, true);
  assert.equal(new MerossApiError(1019).needsFreshLogin, true);
  assert.equal(new MerossApiError(1200).needsFreshLogin, true);
  // An undocumented code must fall on the recoverable side too.
  assert.equal(new MerossApiError(9999).needsFreshLogin, true);
});

test('statuses a new login cannot fix do not trigger one', () => {
  for (const status of LOGIN_WONT_HELP_STATUSES) {
    assert.equal(new MerossApiError(status).needsFreshLogin, false, `status ${status}`);
  }
  // Credentials, and the session cap a second login would only make worse.
  assert.ok(LOGIN_WONT_HELP_STATUSES.has(1004));
  assert.ok(LOGIN_WONT_HELP_STATUSES.has(1301));
});

test('a missing apiStatus is treated as a failure, not a success', () => {
  assert.throws(() => checkApiStatus({}), MerossApiError);
  assert.throws(() => checkApiStatus(undefined), MerossApiError);
});

test('every region maps to an https Meross endpoint', () => {
  for (const url of Object.values(REGION_ENDPOINTS)) {
    assert.match(url, /^https:\/\/[a-z-]+\.meross\.com$/);
  }
});
