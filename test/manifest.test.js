// -----------------------------------------------------------------------------
// Consistency between `gladys-assistant-integration.json` and the code.
//
// The store indexer validates the manifest's shape, but nothing there can know
// which handlers the code actually registers, or that a default declared in the
// form matches the default the code assumes. These tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_CONFIG,
  normalizePollFrequency,
  POLL_FREQUENCIES,
  REGIONS,
} from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('every manifest action is registered in index.js', () => {
  for (const action of manifest.actions ?? []) {
    assert.match(
      indexSource,
      new RegExp(`gladys\\.onAction\\(\\s*'${action.key}'`),
      `manifest action "${action.key}" has no handler`,
    );
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default === undefined) {
      continue;
    }
    // A select stores its value as a string; the code keeps poll_frequency as
    // the number Gladys expects in the device payload, so compare through the
    // same normalization the runtime applies.
    const expected =
      field.key === 'poll_frequency' ? normalizePollFrequency(field.default) : field.default;

    assert.equal(
      DEFAULT_CONFIG[field.key],
      expected,
      `DEFAULT_CONFIG.${field.key} must match the manifest default`,
    );
  }
});

test('the refresh interval offers exactly the frequencies Gladys accepts', () => {
  // Anything else is refused at publish time with "invalid poll frequency",
  // which takes the whole device batch down with it.
  const field = manifest.config_schema.find((f) => f.key === 'poll_frequency');
  assert.equal(field.type, 'select', 'a free number would let the user pick a rejected value');

  const offered = field.options.map((option) => Number(option.value)).sort((a, b) => a - b);
  assert.deepEqual(
    offered,
    [...POLL_FREQUENCIES].sort((a, b) => a - b),
  );

  // The manifest default must itself be one of the offered options.
  assert.ok(field.options.some((option) => option.value === field.default));
});

test('every stored config field is known to the code', () => {
  for (const field of manifest.config_schema) {
    if (field.type === 'section') {
      continue;
    }
    assert.ok(
      field.key in DEFAULT_CONFIG,
      `config_schema field "${field.key}" has no entry in DEFAULT_CONFIG`,
    );
  }
});

test('the region options are exactly the regions the code accepts', () => {
  const field = manifest.config_schema.find((f) => f.key === 'region');
  assert.deepEqual(
    field.options.map((option) => option.value),
    REGIONS,
  );
});

test('the password is a secret field, and secrets declare no default', () => {
  const password = manifest.config_schema.find((f) => f.key === 'password');
  assert.equal(password.type, 'secret', 'the password must never be a plain string field');
  // The indexer rejects a `default` on a secret field.
  assert.equal(password.default, undefined);
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0);

  for (const section of sections) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(section.placeholder, undefined, `section "${section.key}" needs no placeholder`);
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the manifest respects the store validation rules', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');

  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.match(manifest.docker_image, /^[a-z0-9./-]+:[\w.-]+$/, 'image needs an explicit tag');

  // `en` is mandatory and every language stays within 10-100 characters.
  assert.ok(manifest.description.en);
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(text.length >= 10 && text.length <= 100, `description.${lang} must be 10-100 chars`);
  }

  for (const field of manifest.config_schema) {
    assert.match(field.key, /^[a-z0-9_]+$/);
    assert.ok(
      [
        'string',
        'number',
        'boolean',
        'select',
        'multi_select',
        'secret',
        'oauth2',
        'section',
      ].includes(field.type),
      `unknown field type "${field.type}"`,
    );
    assert.ok(field.label?.en, `field "${field.key}" needs an English label`);
  }

  for (const action of manifest.actions ?? []) {
    assert.match(action.key, /^[a-z0-9_]+$/);
    assert.ok(action.label?.en);
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120);
  }
});

test('declaring both transports is what enables the prefer-local toggle', () => {
  // The reserved GLADYS_PREFER_LOCAL key only arrives when both are declared,
  // and the whole local/cloud routing depends on receiving it.
  assert.deepEqual([...manifest.transports].sort(), ['cloud', 'local']);
  assert.equal(DEFAULT_CONFIG.GLADYS_PREFER_LOCAL, true);
});

test('the declared categories are valid, and force the Gladys version that added them', () => {
  // `categories` is what puts the integration in the right shelves of the store
  // catalogue. Gladys 4.86 introduced the field, so declaring it without
  // raising `gladys_version` would offer the integration to versions that
  // cannot read it.
  const ALLOWED = [
    'climate',
    'lighting',
    'energy',
    'security',
    'multimedia',
    'appliances',
    'environment',
    'protocols',
    'network',
    'notifications',
    'assistants',
    'services',
  ];

  assert.ok(Array.isArray(manifest.categories), 'categories is a list');
  assert.ok(
    manifest.categories.length >= 1 && manifest.categories.length <= 3,
    `expected 1 to 3 categories, got ${manifest.categories.length}`,
  );
  assert.equal(new Set(manifest.categories).size, manifest.categories.length, 'no duplicates');

  for (const category of manifest.categories) {
    assert.ok(ALLOWED.includes(category), `"${category}" is not a store category`);
  }

  assert.equal(manifest.gladys_version, '>=4.86.0');
});
