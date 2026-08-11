const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  actorSource,
  projectionResources,
} = require('../../scripts/ql3-prompt-output-projection-kubernetes-live-contract.cjs');

test('keeps the live projection probe tokenless, read-only and exact', () => {
  const resources = projectionResources('ql3-ai:test');
  const account = resources.find(
    (resource) => resource.kind === 'ServiceAccount',
  );
  const pod = resources.find((resource) => resource.kind === 'Pod');
  const container = pod.spec.containers[0];
  const volume = pod.spec.volumes.find(
    (entry) => entry.name === 'prompt-output-keyring',
  );
  const mount = container.volumeMounts.find(
    (entry) => entry.name === 'prompt-output-keyring',
  );
  assert.equal(account.automountServiceAccountToken, false);
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(mount.readOnly, true);
  assert.equal(volume.secret.defaultMode, 288);
  assert.deepEqual(volume.secret.items, [
    { key: 'keyring.json', path: 'keyring.json' },
  ]);
  assert.equal(container.imagePullPolicy, 'Never');
  assert.match(actorSource(), /requestedBy: \{ type: 'system'/);
  assert.match(actorSource(), /historical key is unavailable/);
  assert.match(
    actorSource(),
    /PLUGIN_PACKAGE_PROMPT_OUTPUT_PROJECTED_KEYRING_UNAVAILABLE/,
  );
  assert.match(actorSource(), /isSymbolicLink\(\), true/);
});
