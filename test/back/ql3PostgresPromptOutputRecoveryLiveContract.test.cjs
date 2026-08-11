const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const SCRIPT = path.resolve(
  __dirname,
  '../../scripts/ql3-postgres-prompt-output-recovery-live-contract.cjs',
);
const { IMAGE } = require(SCRIPT);

test('pins the PostgreSQL 18 image by reviewed OCI digest', () => {
  assert.equal(
    IMAGE,
    'docker.io/library/postgres:18@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a',
  );
});

test('refuses Docker mutation unless the live gate is explicitly enabled', () => {
  const env = { ...process.env };
  delete env.QL3_RUN_POSTGRES_BACKUP_RECOVERY_LIVE;
  const result = spawnSync(process.execPath, [SCRIPT], {
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /QL3_RUN_POSTGRES_BACKUP_RECOVERY_LIVE=true is required/,
  );
  assert.doesNotMatch(result.stderr, /Docker command failed/);
});

test('keeps source and restore on loopback-only random database ports', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /'--publish',\s*'127\.0\.0\.1::5432'/);
  assert.match(source, /mapping\.match\(\/\^127\\\.0\\\.0\\\.1:/);
  assert.doesNotMatch(source, /0\.0\.0\.0::5432/);
  assert.match(source, /'--command',\s*'SELECT 1'/);
  assert.match(source, /Atomics\.wait/);
  assert.doesNotMatch(source, /'pg_isready'/);
  assert.match(source, /'pg_dump'/);
  assert.match(source, /'--format',\s*'custom'/);
  assert.match(source, /'pg_restore'/);
  assert.match(source, /'--exit-on-error'/);
  const sourceRemoval = source.indexOf(
    "docker(['rm', '--force', '--volumes', sourceContainer])",
  );
  const restoreStart = source.indexOf(
    'startPostgres(restoreContainer, password)',
  );
  assert.ok(sourceRemoval >= 0);
  assert.ok(restoreStart > sourceRemoval);
  assert.match(source, /sourceContainerRemovedBeforeRestore: true/);
  assert.match(source, /sourceAndRestoreContainerIdsDiffer:/);
});

test('exports only restored exact facts into the existing offline verifier', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(
    source,
    /const restoredEvidence = await readProductionEvidence\(/,
  );
  assert.match(source, /assert\.equal\(restoredRowDigest, sourceRowDigest\)/);
  assert.match(source, /JSON\.stringify\(restoredEvidence\.durableKeyFact\)/);
  assert.match(source, /JSON\.stringify\(restoredEvidence\.artifact\)/);
  assert.match(source, /runClusterPromptOutputExternalRecoveryVerifier/);
  assert.match(source, /disposeClusterPromptOutputExternalRecoveryInput/);
  assert.match(source, /backupContainsNoPlaintextOrRawKey: true/);
  assert.match(source, /productionMigrationHistoryRestoredExactly: true/);
  assert.match(
    source,
    /productionRotationAndArtifactRepositoriesReopened: true/,
  );
  assert.match(source, /reportIsContentFree: true/);
});

test('uses the QL3 production migration and Prompt persistence lineage', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /runPostgresMigrations/);
  assert.match(source, /migratePostgresModelInvocationFeature/);
  assert.match(source, /createPluginPackagePromptAdmissionBundle/);
  assert.match(source, /PostgresModelInvocationRepository/);
  assert.match(source, /PostgresPluginPackagePromptOutputArtifactRepository/);
  assert.match(
    source,
    /PostgresPluginPackagePromptOutputKeyRotationRepository/,
  );
  assert.match(source, /model_invocation_prompt_admissions/);
  assert.match(source, /model_invocation_prompt_output_artifacts/);
  assert.match(
    source,
    /model_invocation_prompt_output_key_rotation_completions/,
  );
  assert.doesNotMatch(source, /ql3_recovery\.prompt_output_evidence/);
});

test('always removes both disposable containers, volumes and private files', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(
    source,
    /docker\(\['rm', '--force', '--volumes', sourceContainer\]/,
  );
  assert.match(
    source,
    /docker\(\['rm', '--force', '--volumes', restoreContainer\]/,
  );
  assert.match(
    source,
    /rmSync\(directory, \{ recursive: true, force: true \}\)/,
  );
  assert.doesNotMatch(source, /ql3-cnpg-evidence-control-plane/);
});
