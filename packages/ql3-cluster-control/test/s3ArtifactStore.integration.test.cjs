'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const {
  S3ClusterRemoteWorkerArtifactStore,
  S3ClusterRemoteWorkerArtifactStoreError,
} = require('@qinglong/cluster-control/s3-artifact-store');

const endpoint = process.env.QL3_TEST_S3_ENDPOINT;
const accessKeyId = process.env.QL3_TEST_S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.QL3_TEST_S3_SECRET_ACCESS_KEY;

test(
  'real S3-compatible service preserves immutable Artifact evidence',
  {
    skip:
      endpoint && accessKeyId && secretAccessKey
        ? false
        : 'requires QL3_TEST_S3_ENDPOINT and credentials',
  },
  async () => {
    const client = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    const bucket = `ql3-artifact-${process.pid}-${Date.now()}`.slice(0, 63);
    const versionedBucket = `${bucket}-v`.slice(0, 63);
    const command = Object.freeze({
      projectId: 'project-s3-integration',
      runId: 'run-s3-integration',
      attemptId: 'attempt-s3-integration',
      logArtifactId: `wlog-${'c'.repeat(30)}`,
      byteLength: 17,
      truncated: true,
    });
    const content = Buffer.from('real object bytes');
    const body = (value) =>
      Object.freeze({
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
      const range = await store.readLogRange(
        {
          projectId: command.projectId,
          runId: command.runId,
          attemptId: command.attemptId,
          logArtifactId: command.logArtifactId,
        },
        {
          offset: 5,
          length: 6,
        },
      );
      assert.equal(range.status, 'available');
      assert.equal(Buffer.from(range.content).toString(), 'object');
      assert.equal(range.start, 5);
      assert.equal(range.endExclusive, 11);
      assert.equal(range.totalBytes, content.byteLength);
      assert.equal(range.nextOffset, 11);
      assert.deepEqual(range.truncation, { truncated: true });
      await assert.rejects(
        store.put(command, body(Buffer.from('REAL OBJECT BYTES'))),
        (error) =>
          error instanceof S3ClusterRemoteWorkerArtifactStoreError &&
          error.reason === 'integrity_mismatch',
      );
      const objects = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: 'qinglong/integration/',
        }),
      );
      assert.equal(objects.KeyCount, 1);
      assert.match(objects.Contents[0].Key, /\/objects\//);
      const retired = await store.retire({
        projectId: command.projectId,
        runId: command.runId,
        attemptId: command.attemptId,
        logArtifactId: command.logArtifactId,
        executorType: 'remote_worker',
        finishedAtMs: 1,
      });
      assert.deepEqual(retired, {
        disposition: 'deleted',
        byteLength: content.byteLength,
        truncation: { truncated: true },
      });
      assert.equal(
        (
          await client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: 'qinglong/integration/',
            }),
          )
        ).KeyCount,
        0,
      );
      assert.deepEqual(
        await store.retire({
          projectId: command.projectId,
          runId: command.runId,
          attemptId: command.attemptId,
          logArtifactId: command.logArtifactId,
          executorType: 'remote_worker',
          finishedAtMs: 1,
        }),
        {
          disposition: 'already_absent',
          byteLength: 0,
          truncation: { truncated: 'unknown' },
        },
      );

      await client.send(new CreateBucketCommand({ Bucket: versionedBucket }));
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: versionedBucket,
          VersioningConfiguration: { Status: 'Enabled' },
        }),
      );
      const versionedStore = new S3ClusterRemoteWorkerArtifactStore({
        client,
        bucket: versionedBucket,
        prefix: 'qinglong/integration',
        encryption: { mode: 's3' },
      });
      assert.equal(
        (await versionedStore.put(command, body(content))).status,
        'stored',
      );
      const beforeVersionedRetirement = await client.send(
        new ListObjectVersionsCommand({ Bucket: versionedBucket }),
      );
      assert.equal(beforeVersionedRetirement.Versions?.length, 1);
      assert.equal(beforeVersionedRetirement.DeleteMarkers?.length ?? 0, 0);
      assert.match(beforeVersionedRetirement.Versions[0].Key, /\/objects\//);
      assert.equal(
        (
          await versionedStore.retire({
            projectId: command.projectId,
            runId: command.runId,
            attemptId: command.attemptId,
            logArtifactId: command.logArtifactId,
            executorType: 'remote_worker',
            finishedAtMs: 1,
          })
        ).disposition,
        'deleted',
      );
      const afterVersionedRetirement = await client.send(
        new ListObjectVersionsCommand({ Bucket: versionedBucket }),
      );
      assert.equal(afterVersionedRetirement.Versions?.length ?? 0, 0);
      assert.equal(afterVersionedRetirement.DeleteMarkers?.length ?? 0, 0);
    } finally {
      for (const cleanupBucket of [versionedBucket, bucket]) {
        try {
          const versions = await client.send(
            new ListObjectVersionsCommand({ Bucket: cleanupBucket }),
          );
          const versionedObjects = [
            ...(versions.Versions ?? []),
            ...(versions.DeleteMarkers ?? []),
          ].map(({ Key, VersionId }) => ({ Key, VersionId }));
          if (versionedObjects.length) {
            await client.send(
              new DeleteObjectsCommand({
                Bucket: cleanupBucket,
                Delete: { Objects: versionedObjects, Quiet: true },
              }),
            );
          }
          const objects = await client.send(
            new ListObjectsV2Command({ Bucket: cleanupBucket }),
          );
          if (objects.Contents?.length) {
            await client.send(
              new DeleteObjectsCommand({
                Bucket: cleanupBucket,
                Delete: {
                  Objects: objects.Contents.map(({ Key }) => ({ Key })),
                  Quiet: true,
                },
              }),
            );
          }
          await client.send(new DeleteBucketCommand({ Bucket: cleanupBucket }));
        } catch {
          // Preserve the integration assertion; the ephemeral container is removed.
        }
      }
      client.destroy();
    }
  },
);
