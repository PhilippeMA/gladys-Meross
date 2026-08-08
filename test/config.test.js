// -----------------------------------------------------------------------------
// Configuration normalization: the form gives us strings, the code wants types.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  DEFAULT_POLL_FREQUENCY,
  isConfigured,
  normalizeConfig,
  normalizePollFrequency,
  POLL_FREQUENCIES,
  REGIONS,
} from '../src/config.js';

test('an empty config falls back to the defaults', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG);
});

// --- Poll frequency ----------------------------------------------------------
// Gladys accepts only DEVICE_POLL_FREQUENCIES (milliseconds, 1 minute at the
// slowest) and rejects the WHOLE publish batch otherwise, so these are the
// tests that keep devices publishable at all.

test('the allowed frequencies are exactly the ones Gladys defines', () => {
  assert.deepEqual(
    [...POLL_FREQUENCIES].sort((a, b) => a - b),
    [1000, 2000, 10000, 15000, 30000, 60000],
  );
});

test('a select value arriving as a string becomes a number', () => {
  assert.equal(normalizeConfig({ poll_frequency: '30000' }).poll_frequency, 30000);
});

test('every allowed frequency passes through untouched', () => {
  for (const frequency of POLL_FREQUENCIES) {
    assert.equal(normalizePollFrequency(frequency), frequency);
  }
});

test('a frequency Gladys would reject snaps to the closest allowed one', () => {
  // A config written before this field became a select: 60 seconds, in seconds.
  assert.equal(normalizePollFrequency(60), 1000);
  // The old default of 300 s: honour "slowly" with the slowest Gladys offers.
  assert.equal(normalizePollFrequency(300000), 60000);
  assert.equal(normalizePollFrequency(45000), 30000);
  assert.equal(normalizePollFrequency(12000), 10000);
});

test('a missing or nonsensical frequency falls back to the default', () => {
  assert.equal(normalizePollFrequency(undefined), DEFAULT_POLL_FREQUENCY);
  assert.equal(normalizePollFrequency('not a number'), DEFAULT_POLL_FREQUENCY);
  assert.equal(normalizePollFrequency(0), DEFAULT_POLL_FREQUENCY);
  assert.equal(normalizePollFrequency(-5), DEFAULT_POLL_FREQUENCY);
});

test('normalizeConfig never yields a frequency Gladys would refuse', () => {
  for (const raw of [undefined, '', '60', 300, 3600, 'abc', 60000, '1000']) {
    assert.ok(
      POLL_FREQUENCIES.includes(normalizeConfig({ poll_frequency: raw }).poll_frequency),
      `poll_frequency ${JSON.stringify(raw)} normalized outside the allowed list`,
    );
  }
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
