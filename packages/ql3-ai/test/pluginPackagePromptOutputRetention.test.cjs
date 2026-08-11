const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  InvalidPluginPackagePromptOutputRetentionPolicyCatalogError,
  createPluginPackagePromptOutputRetentionPolicyCatalogResolver,
} = require('../dist/prompt-output/pluginPackagePromptOutputRetention');
const {
  pluginPackagePromptOutputArtifactRetentionPolicyDigest,
} = require('../dist/prompt-output/pluginPackagePromptOutputArtifact');

function entry(projectId, revision, retentionMs) {
  const policy = { revision, retentionMs };
  return {
    projectId,
    policy,
    policyDigest:
      pluginPackagePromptOutputArtifactRetentionPolicyDigest(policy),
  };
}

test('resolves one exact digest-bound Project retention policy', async () => {
  const expected = entry('project-a', 'retention-v1', 3_600_000);
  const resolver =
    createPluginPackagePromptOutputRetentionPolicyCatalogResolver({
      schemaVersion: 1,
      policies: [expected, entry('project-b', 'retention-v2', 7_200_000)],
    });
  assert.deepEqual(
    await resolver.resolve({
      projectId: expected.projectId,
      revision: expected.policy.revision,
    }),
    expected.policy,
  );
  assert.equal(
    await resolver.resolve({
      projectId: expected.projectId,
      revision: 'retention-v2',
    }),
    null,
  );
});

test('rejects rewritten, duplicate, widened and unbounded policy catalogs', () => {
  const expected = entry('project-a', 'retention-v1', 3_600_000);
  assert.throws(
    () =>
      createPluginPackagePromptOutputRetentionPolicyCatalogResolver({
        schemaVersion: 1,
        policies: [{ ...expected, policyDigest: '0'.repeat(64) }],
      }),
    InvalidPluginPackagePromptOutputRetentionPolicyCatalogError,
  );
  assert.throws(
    () =>
      createPluginPackagePromptOutputRetentionPolicyCatalogResolver({
        schemaVersion: 1,
        policies: [expected, expected],
      }),
    InvalidPluginPackagePromptOutputRetentionPolicyCatalogError,
  );
  assert.throws(
    () =>
      createPluginPackagePromptOutputRetentionPolicyCatalogResolver({
        schemaVersion: 1,
        policies: [{ ...expected, enabled: true }],
      }),
    InvalidPluginPackagePromptOutputRetentionPolicyCatalogError,
  );
  assert.throws(
    () =>
      createPluginPackagePromptOutputRetentionPolicyCatalogResolver({
        schemaVersion: 1,
        policies: Array.from({ length: 129 }, (_, index) =>
          entry(`project-${index}`, 'retention-v1', 3_600_000),
        ),
      }),
    InvalidPluginPackagePromptOutputRetentionPolicyCatalogError,
  );
});
