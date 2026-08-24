#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');

const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  ClusterMountedSecretProviderError,
  createClusterMountedSecretProvider,
} = require('@qinglong/cluster-control/mounted-secret-provider');

const ROOT = '/var/run/secrets/qinglong3/worker-values';
const FIRST_OBSERVATION = '/tmp/ql3-mounted-secret-first-observed';
const SECRET_REF = createSecretRef({
  projectId: 'secret-binding-kubernetes-live',
  name: 'runtime-token',
  version: 1,
});

function authority() {
  return Object.freeze({
    workerId: 'worker-secret-provider-live',
    workerSessionId: '018f0000-0000-7000-8000-000000000001',
    workerGeneration: 1,
    runId: 'run-secret-provider-live',
    attemptId: 'attempt-secret-provider-live',
    projectId: 'secret-binding-kubernetes-live',
    taskId: 'task-secret-provider-live',
    taskRevision: 'revision-1',
    executionDigest: 'a'.repeat(64),
    offerId: 'offer-secret-provider-live',
    leaseGeneration: 1,
    leaseVersion: 1,
    secretRefs: Object.freeze([SECRET_REF]),
    environmentBundleRefs: Object.freeze([]),
  });
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function resolveDigest(provider) {
  const resolution = await provider.resolve(authority());
  try {
    assert.equal(resolution.values.length, 1);
    assert.equal(resolution.values[0].secretRef, SECRET_REF);
    assert.equal(typeof resolution.values[0].value, 'string');
    return digest(resolution.values[0].value);
  } finally {
    await resolution.dispose?.();
  }
}

async function observeMissing(provider) {
  try {
    await provider.resolve(authority());
  } catch (error) {
    assert.ok(error instanceof ClusterMountedSecretProviderError);
    assert.equal(error.reason, 'material_unavailable');
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        event: 'mounted_secret_missing_rejected',
        errorCode: error.code,
      })}\n`,
    );
    return;
  }
  throw new Error('missing mounted Secret projection was accepted');
}

async function observeRotation(provider) {
  const deadline = Date.now() + 180_000;
  let firstDigest;
  let observations = 0;
  let unavailable = 0;
  while (Date.now() < deadline) {
    try {
      const currentDigest = await resolveDigest(provider);
      observations += 1;
      if (!firstDigest) {
        firstDigest = currentDigest;
        fs.writeFileSync(FIRST_OBSERVATION, '', { flag: 'wx', mode: 0o600 });
      } else if (currentDigest !== firstDigest) {
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            event: 'mounted_secret_rotation_observed',
            generations: 2,
            observations,
            unavailable,
          })}\n`,
        );
        return;
      }
    } catch (error) {
      if (!(error instanceof ClusterMountedSecretProviderError)) throw error;
      unavailable += 1;
    }
    await delay(250);
  }
  throw new Error('mounted Secret rotation was not observed before timeout');
}

async function main() {
  const provider = await createClusterMountedSecretProvider({
    rootDirectory: ROOT,
  });
  if (process.env.QL3_LIVE_EXPECT_MISSING === 'true') {
    await observeMissing(provider);
    return;
  }
  await observeRotation(provider);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `QL3 mounted Secret live actor failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  FIRST_OBSERVATION,
  SECRET_REF,
  authority,
  digest,
};
