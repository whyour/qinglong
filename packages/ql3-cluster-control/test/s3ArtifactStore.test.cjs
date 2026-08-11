'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const {
  S3ClusterRemoteWorkerArtifactStore,
  S3ClusterRemoteWorkerArtifactStoreError,
} = require('@qinglong/cluster-control/s3-artifact-store');

const TEMPORARY_ID = '018f62f6-7b41-4e4f-8cf8-6f38888629a2';
const COMMAND = Object.freeze({
  projectId: 'project-1',
  runId: 'run-1',
  attemptId: 'attempt-1',
  logArtifactId: `wlog-${'a'.repeat(30)}`,
  byteLength: 11,
  truncated: false,
});
const CONTENT = Buffer.from('hello world');
const CONTENT_SHA256 = createHash('sha256').update(CONTENT).digest('hex');
const LOOKUP = Object.freeze({
  projectId: COMMAND.projectId,
  runId: COMMAND.runId,
  attemptId: COMMAND.attemptId,
  logArtifactId: COMMAND.logArtifactId,
});

function checksum(content) {
  return createHash('sha256').update(content).digest('base64');
}

function notFound() {
  const error = new Error('not found');
  error.name = 'NotFound';
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

class MemoryS3Client {
  constructor(options = {}) {
    this.options = options;
    this.objects = new Map();
    this.commands = [];
  }

  async send(command) {
    this.commands.push(command);
    const input = command.input;
    if (command instanceof HeadObjectCommand) {
      const object = this.objects.get(input.Key);
      if (!object) throw notFound();
      const metadata = { ...object.metadata };
      if (this.options.corruptFinalMetadata && input.Key.includes('/objects/')) {
        metadata['ql3-content-sha256'] = '0'.repeat(64);
      }
      return {
        ContentLength: object.content.byteLength,
        ContentType: object.contentType,
        ChecksumSHA256: this.options.corruptFinalChecksum &&
          input.Key.includes('/objects/')
          ? Buffer.alloc(32, 9).toString('base64')
          : checksum(object.content),
        Metadata: metadata,
      };
    }
    if (command instanceof PutObjectCommand) {
      assert.equal(input.IfNoneMatch, '*');
      assert.equal(input.ChecksumAlgorithm, 'SHA256');
      assert.equal(
        input.ServerSideEncryption,
        this.options.expectedEncryption ?? 'AES256',
      );
      if (this.options.expectedKmsKeyId) {
        assert.equal(input.SSEKMSKeyId, this.options.expectedKmsKeyId);
      }
      if (this.objects.has(input.Key)) {
        const error = new Error('precondition failed');
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      const chunks = [];
      for await (const chunk of input.Body) chunks.push(Buffer.from(chunk));
      const content = Buffer.concat(chunks);
      this.objects.set(input.Key, {
        content,
        contentType: input.ContentType,
        metadata: { ...input.Metadata },
      });
      if (this.options.throwAfterPut) throw new Error('lost put response');
      return { ChecksumSHA256: checksum(content) };
    }
    if (command instanceof CopyObjectCommand) {
      assert.equal(input.IfNoneMatch, '*');
      assert.equal(input.MetadataDirective, 'REPLACE');
      assert.equal(input.ChecksumAlgorithm, 'SHA256');
      const sourceKey = decodeURIComponent(input.CopySource)
        .split('/')
        .slice(1)
        .join('/');
      const source = this.objects.get(sourceKey);
      if (!source) throw notFound();
      const final = {
        content: Buffer.from(source.content),
        contentType: input.ContentType,
        metadata: { ...input.Metadata },
      };
      if (this.options.raceOnCopy && !this.objects.has(input.Key)) {
        this.objects.set(input.Key, final);
        const error = new Error('conditional request conflict');
        error.$metadata = { httpStatusCode: 409 };
        throw error;
      }
      if (this.objects.has(input.Key)) {
        const error = new Error('precondition failed');
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      this.objects.set(input.Key, final);
      if (this.options.throwAfterCopy) throw new Error('lost copy response');
      return { CopyObjectResult: { ChecksumSHA256: checksum(final.content) } };
    }
    if (command instanceof DeleteObjectCommand) {
      if (this.options.failDelete) throw new Error('delete unavailable');
      this.objects.delete(input.Key);
      return {};
    }
    throw new Error(`unexpected command: ${command.constructor.name}`);
  }
}

function store(client, overrides = {}) {
  return new S3ClusterRemoteWorkerArtifactStore({
    client,
    bucket: 'ql3-artifacts-test',
    prefix: 'tenant-a/worker-artifacts',
    encryption: { mode: 's3' },
    createTemporaryId: () => TEMPORARY_ID,
    ...overrides,
  });
}

function chunks(content = CONTENT, observed) {
  return Object.freeze({
    async *[Symbol.asyncIterator]() {
      yield content.subarray(0, 3);
      yield content.subarray(3, 7);
      yield content.subarray(7);
      if (observed) observed.complete = true;
    },
  });
}

function permanentKey(client) {
  return [...client.objects.keys()].find((key) => key.includes('/objects/'));
}

test('streams to a checksummed temporary object then conditionally promotes it', async () => {
  const client = new MemoryS3Client();
  const adapter = store(client);
  const receipt = await adapter.put(COMMAND, chunks());

  assert.deepEqual(receipt, {
    status: 'stored',
    ...COMMAND,
    sha256: CONTENT_SHA256,
  });
  assert.deepEqual(
    client.commands.map((command) => command.constructor.name),
    [
      'HeadObjectCommand',
      'PutObjectCommand',
      'HeadObjectCommand',
      'CopyObjectCommand',
      'HeadObjectCommand',
      'DeleteObjectCommand',
    ],
  );
  const key = permanentKey(client);
  assert.match(key, /^tenant-a\/worker-artifacts\/objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/);
  assert.equal(key.includes(COMMAND.runId), false);
  assert.equal(client.objects.size, 1);

  const copy = client.commands.find((command) => command instanceof CopyObjectCommand);
  assert.equal(copy.input.Metadata['ql3-content-sha256'], CONTENT_SHA256);
  assert.equal(JSON.stringify(copy.input.Metadata).includes(COMMAND.projectId), false);
  assert.equal(JSON.stringify(copy.input.Metadata).includes(COMMAND.runId), false);

  const inspected = await adapter.inspect(LOOKUP);
  assert.deepEqual(inspected, { ...receipt, status: 'already_stored' });
});

test('exact replay consumes and hashes the whole body without another write', async () => {
  const client = new MemoryS3Client();
  const adapter = store(client);
  await adapter.put(COMMAND, chunks());
  client.commands.length = 0;
  const observed = { complete: false };

  const replay = await adapter.put(COMMAND, chunks(CONTENT, observed));
  assert.equal(replay.status, 'already_stored');
  assert.equal(observed.complete, true);
  assert.deepEqual(
    client.commands.map((command) => command.constructor.name),
    ['HeadObjectCommand'],
  );

  await assert.rejects(
    adapter.put(COMMAND, chunks(Buffer.from('HELLO WORLD'))),
    (error) =>
      error instanceof S3ClusterRemoteWorkerArtifactStoreError &&
      error.reason === 'integrity_mismatch',
  );
});

test('resolves a concurrent conditional-copy winner by immutable inspect', async () => {
  const client = new MemoryS3Client({ raceOnCopy: true });
  const receipt = await store(client).put(COMMAND, chunks());
  assert.equal(receipt.status, 'already_stored');
  assert.equal(receipt.sha256, CONTENT_SHA256);
  assert.equal(client.objects.size, 1);
});

test('recovers lost put and copy responses only from checksum evidence', async () => {
  for (const [option, expectedStatus] of [
    ['throwAfterPut', 'stored'],
    ['throwAfterCopy', 'already_stored'],
  ]) {
    const client = new MemoryS3Client({ [option]: true });
    const receipt = await store(client).put(COMMAND, chunks());
    assert.equal(receipt.status, expectedStatus);
    assert.equal(receipt.sha256, CONTENT_SHA256);
    assert.equal(client.objects.size, 1);
  }
});

test('rejects corrupt metadata, checksum, short and oversized content', async () => {
  for (const option of ['corruptFinalMetadata', 'corruptFinalChecksum']) {
    const client = new MemoryS3Client({ [option]: true });
    await assert.rejects(
      store(client).put(COMMAND, chunks()),
      (error) =>
        error instanceof S3ClusterRemoteWorkerArtifactStoreError &&
        error.reason === 'integrity_mismatch',
    );
  }

  for (const content of [Buffer.from('short'), Buffer.from('hello world!')]) {
    const client = new MemoryS3Client();
    await assert.rejects(
      store(client).put(COMMAND, chunks(content)),
      (error) => error instanceof S3ClusterRemoteWorkerArtifactStoreError,
    );
    assert.equal(permanentKey(client), undefined);
  }
});

test('temporary cleanup failure is diagnostic and never reverses promotion', async () => {
  const diagnostics = [];
  const client = new MemoryS3Client({ failDelete: true });
  const receipt = await store(client, {
    onDiagnostic(error, context) {
      diagnostics.push([error.message, context.operation]);
    },
  }).put(COMMAND, chunks());
  assert.equal(receipt.status, 'stored');
  assert.deepEqual(diagnostics, [[
    'delete unavailable',
    'temporary_object_cleanup',
  ]]);
  assert.equal(client.objects.size, 2);
});

test('requires exact bucket, prefix, encryption and temporary ID configuration', async () => {
  const client = new MemoryS3Client();
  assert.throws(
    () => new S3ClusterRemoteWorkerArtifactStore({
      client,
      bucket: 'Invalid_Bucket',
      encryption: { mode: 's3' },
    }),
    /bucket is invalid/,
  );
  assert.throws(
    () => new S3ClusterRemoteWorkerArtifactStore({
      client,
      bucket: 'valid-bucket',
      prefix: '../escape',
      encryption: { mode: 's3' },
    }),
    /prefix is invalid/,
  );
  assert.throws(
    () => new S3ClusterRemoteWorkerArtifactStore({
      client,
      bucket: 'valid-bucket',
      encryption: { mode: 'kms' },
    }),
    /encryption is invalid/,
  );
  await assert.rejects(
    store(client, { createTemporaryId: () => '../invalid' }).put(
      COMMAND,
      chunks(),
    ),
    (error) =>
      error instanceof S3ClusterRemoteWorkerArtifactStoreError &&
      error.reason === 'unavailable',
  );
});

test('supports an empty immutable Artifact without synthesizing a chunk', async () => {
  const client = new MemoryS3Client();
  const command = {
    ...COMMAND,
    logArtifactId: `wlog-${'b'.repeat(30)}`,
    byteLength: 0,
    truncated: undefined,
  };
  delete command.truncated;
  const receipt = await store(client).put(command, {
    async *[Symbol.asyncIterator]() {},
  });
  assert.equal(receipt.byteLength, 0);
  assert.equal(receipt.sha256, createHash('sha256').digest('hex'));
  assert.equal(Object.hasOwn(receipt, 'truncated'), false);
});

test('propagates KMS and expected-owner fences to both sides of promotion', async () => {
  const keyId = 'arn:aws:kms:us-east-1:123456789012:key/test';
  const client = new MemoryS3Client({
    expectedEncryption: 'aws:kms',
    expectedKmsKeyId: keyId,
  });
  await store(client, {
    expectedBucketOwner: '123456789012',
    encryption: { mode: 'kms', keyId },
  }).put(COMMAND, chunks());
  for (const command of client.commands) {
    assert.equal(command.input.ExpectedBucketOwner, '123456789012');
  }
  const copy = client.commands.find(
    (command) => command instanceof CopyObjectCommand,
  );
  assert.equal(copy.input.CopySourceExpectedBucketOwner, '123456789012');
  assert.equal(copy.input.ServerSideEncryption, 'aws:kms');
  assert.equal(copy.input.SSEKMSKeyId, keyId);
});

test('never deletes a colliding temporary object it cannot prove it owns', async () => {
  const client = new MemoryS3Client();
  const temporaryKey =
    `tenant-a/worker-artifacts/temporary/${TEMPORARY_ID}`;
  client.objects.set(temporaryKey, {
    content: Buffer.from('other operation'),
    contentType: 'application/octet-stream',
    metadata: { 'ql3-schema': 'other' },
  });
  await assert.rejects(
    store(client).put(COMMAND, chunks()),
    (error) =>
      error instanceof S3ClusterRemoteWorkerArtifactStoreError &&
      error.reason === 'unavailable',
  );
  assert.equal(client.objects.has(temporaryKey), true);
  assert.equal(
    client.commands.some((command) => command instanceof DeleteObjectCommand),
    false,
  );
});

test('a pre-aborted request performs no object-store operation', async () => {
  const client = new MemoryS3Client();
  const controller = new AbortController();
  const reason = new Error('stopping');
  controller.abort(reason);
  await assert.rejects(
    store(client).put(COMMAND, chunks(), controller.signal),
    (error) => error === reason,
  );
  assert.equal(client.commands.length, 0);
});
