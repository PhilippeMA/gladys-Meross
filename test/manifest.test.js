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
import { DEFAULT_CONFIG, REGIONS } from '../src/config.js';

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
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
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
