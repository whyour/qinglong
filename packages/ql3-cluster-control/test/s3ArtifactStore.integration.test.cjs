'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} = require('@aws-sdk/client-s3');
const {
  S3ClusterRemoteWorkerArtifactStore,
  S3ClusterRemoteWorkerArtifactStoreError,
} = require('@qinglong/cluster-control/s3-artifact-store');

const endpoint = process.env.QL3_TEST_S3_ENDPOINT;
const accessKeyId = process.env.QL3_TEST_S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.QL3_TEST_S3_SECRET_ACCESS_KEY;

test('real S3-compatible service preserves immutable Artifact evidence', {
  skip: endpoint && accessKeyId && secretAccessKey
    ? false
    : 'requires QL3_TEST_S3_ENDPOINT and credentials',
}, async () => {
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const bucket = `ql3-artifact-${process.pid}-${Date.now()}`.slice(0, 63);
  const command = Object.freeze({
    projectId: 'project-s3-integration',
    runId: 'run-s3-integration',
    attemptId: 'attempt-s3-integration',
    logArtifactId: `wlog-${'c'.repeat(30)}`,
    byteLength: 17,
    truncated: true,
  });
  const content = Buffer.from('real object bytes');
  const body = (value) => Object.freeze({
    async *[Symbol.asyncIterator]() {
      yield value.subarray(0, 4);
      yield value.subarray(4);
    },
  });

  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    const store = new S3ClusterRemoteWorkerArtifactStore({
      client,
      bucket,
      prefix: 'qinglong/integration',
      encryption: { mode: 's3' },
    });
    const stored = await store.put(command, body(content));
    assert.equal(stored.status, 'stored');
    assert.equal(
      stored.sha256,
      createHash('sha256').update(content).digest('hex'),
    );
    const replay = await store.put(command, body(content));
    assert.equal(replay.status, 'already_stored');
    await assert.rejects(
      store.put(command, body(Buffer.from('REAL OBJECT BYTES'))),
      (error) =>
        error instanceof S3ClusterRemoteWorkerArtifactStoreError &&
        error.reason === 'integrity_mismatch',
    );
    const objects = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: 'qinglong/integration/',
    }));
    assert.equal(objects.KeyCount, 1);
    assert.match(objects.Contents[0].Key, /\/objects\//);
  } finally {
    try {
      const objects = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
      }));
      if (objects.Contents?.length) {
        await client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: objects.Contents.map(({ Key }) => ({ Key })),
            Quiet: true,
          },
        }));
      }
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    } catch {
      // Preserve the integration assertion; the ephemeral container is removed.
    }
    client.destroy();
  }
});
