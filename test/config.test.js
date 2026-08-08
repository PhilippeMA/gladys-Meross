// -----------------------------------------------------------------------------
// Configuration normalization: the form gives us strings, the code wants types.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, isConfigured, normalizeConfig, REGIONS } from '../src/config.js';

test('an empty config falls back to the defaults', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG);
});

test('numbers arriving as strings are coerced', () => {
  const config = normalizeConfig({ poll_frequency: '120' });
  assert.equal(config.poll_frequency, 120);
});

test('the email is trimmed so a copy-paste space cannot break the login', () => {
  assert.equal(normalizeConfig({ email: '  user@example.com \n' }).email, 'user@example.com');
});

test('an unknown region falls back to the default instead of breaking the URL', () => {
  assert.equal(normalizeConfig({ region: 'mars' }).region, DEFAULT_CONFIG.region);
  assert.equal(normalizeConfig({ region: 'US' }).region, 'us');
  for (const region of REGIONS) {
    assert.equal(normalizeConfig({ region }).region, region);
  }
});

test('GLADYS_PREFER_LOCAL defaults to true and only an explicit false disables it', () => {
  assert.equal(normalizeConfig({}).GLADYS_PREFER_LOCAL, true);
  assert.equal(normalizeConfig({ GLADYS_PREFER_LOCAL: false }).GLADYS_PREFER_LOCAL, false);
  assert.equal(normalizeConfig({ GLADYS_PREFER_LOCAL: undefined }).GLADYS_PREFER_LOCAL, true);
});

test('unknown keys are preserved (this is how the cached session survives)', () => {
  const config = normalizeConfig({ meross_token: 'tok', meross_key: 'k' });
  assert.equal(config.meross_token, 'tok');
  assert.equal(config.meross_key, 'k');
});

test('isConfigured requires both an email and a password', () => {
  assert.equal(isConfigured(normalizeConfig({})), false);
  assert.equal(isConfigured(normalizeConfig({ email: 'a@b.c' })), false);
  assert.equal(isConfigured(normalizeConfig({ password: 'p' })), false);
  assert.equal(isConfigured(normalizeConfig({ email: 'a@b.c', password: 'p' })), true);
});
