const assert = require('node:assert/strict');
const test = require('node:test');

const { getErrorDetails } = require('../../src/utils/httpError');

test('validation errors include the failing field names', () => {
  const details = getErrorDetails({
    message: 'Validation failed',
    validation: {
      body: {
        source: 'body',
        keys: ['labels', 'allow_multiple_instances'],
        message: 'request body contains invalid values',
      },
    },
  });

  assert.deepEqual(details, [
    'labels: request body contains invalid values',
    'allow_multiple_instances: request body contains invalid values',
  ]);
});

test('existing API error details remain visible', () => {
  assert.deepEqual(
    getErrorDetails({ errors: [{ message: 'duplicate value', value: 'foo' }] }),
    ['duplicate value (foo)'],
  );
});
