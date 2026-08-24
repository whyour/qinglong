'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ENVIRONMENT_BUNDLE_SCHEMA,
  InvalidEnvironmentBundleError,
  parseEnvironmentBundle,
  serializeEnvironmentBundle,
} = require('../dist/secret/environmentBundle');

test('canonicalizes one opaque environment bundle without external authority', () => {
  const serialized = serializeEnvironmentBundle({
    schema: ENVIRONMENT_BUNDLE_SCHEMA,
    entries: [
      { name: 'TOKEN', value: 'secret' },
      { name: 'EMPTY', value: '' },
    ],
  });
  assert.deepEqual(parseEnvironmentBundle(serialized), {
    schema: ENVIRONMENT_BUNDLE_SCHEMA,
    entries: [
      { name: 'EMPTY', value: '' },
      { name: 'TOKEN', value: 'secret' },
    ],
  });
});

test('rejects duplicate, reserved, widened and over-budget bundle entries', () => {
  const values = [
    { schema: ENVIRONMENT_BUNDLE_SCHEMA, entries: [] },
    {
      schema: ENVIRONMENT_BUNDLE_SCHEMA,
      entries: [
        { name: 'TOKEN', value: 'a' },
        { name: 'TOKEN', value: 'b' },
      ],
    },
    {
      schema: ENVIRONMENT_BUNDLE_SCHEMA,
      entries: [{ name: 'QL3_TOKEN', value: 'a' }],
    },
    {
      schema: ENVIRONMENT_BUNDLE_SCHEMA,
      entries: [{ name: 'TOKEN', value: 'x'.repeat(16 * 1024 + 1) }],
    },
    {
      schema: ENVIRONMENT_BUNDLE_SCHEMA,
      entries: [{ name: 'TOKEN', value: 'a', secretRef: 'forbidden' }],
    },
  ];
  for (const value of values) {
    assert.throws(
      () => serializeEnvironmentBundle(value),
      InvalidEnvironmentBundleError,
    );
  }
});
