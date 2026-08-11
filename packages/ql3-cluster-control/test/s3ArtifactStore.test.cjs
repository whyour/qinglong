'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
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
      if (
        this.options.corruptFinalMetadata &&
        input.Key.includes('/objects/')
      ) {
        metadata['ql3-content-sha256'] = '0'.repeat(64);
      }
      return {
        ContentLength: object.content.byteLength,
        ContentType: object.contentType,
        ETag: `"${checksum(object.content).slice(0, 32)}"`,
        ChecksumSHA256:
          this.options.corruptFinalChecksum && input.Key.includes('/objects/')
            ? Buffer.alloc(32, 9).toString('base64')
            : checksum(object.content),
        Metadata: metadata,
        ...(input.Key.includes('/objects/') &&
        this.options.headVersionId !== undefined
          ? { VersionId: this.options.headVersionId }
          : {}),
        ...(input.Key.includes('/temporary/') &&
        this.options.temporaryHeadVersionId !== undefined
          ? { VersionId: this.options.temporaryHeadVersionId }
          : {}),
      };
    }
    if (command instanceof GetObjectCommand) {
      const object = this.objects.get(input.Key);
      if (!object || this.options.rangeNotFound) throw notFound();
      const eTag = `"${checksum(object.content).slice(0, 32)}"`;
      assert.equal(input.IfMatch, eTag);
      const match = /^bytes=(\d+)-(\d+)$/.exec(input.Range);
      assert.ok(match);
      const start = Number(match[1]);
      const end = Number(match[2]);
      let content = object.content.subarray(start, end + 1);
      if (this.options.shortRangeBody) content = content.subarray(0, -1);
      if (this.options.oversizedRangeBody) {
        content = Buffer.concat([content, Buffer.from('x')]);
      }
      const metadata = { ...object.metadata };
      if (this.options.corruptRangeMetadata) {
        metadata['ql3-run-sha256'] = '0'.repeat(64);
      }
      return {
        ContentLength: end - start + 1,
        ContentRange: this.options.corruptContentRange
          ? `bytes ${start}-${end}/${object.content.byteLength + 1}`
          : `bytes ${start}-${end}/${object.content.byteLength}`,
        ContentType: object.contentType,
        ETag: this.options.corruptRangeETag ? '"other"' : eTag,
        Metadata: metadata,
        Body: {
          async *[Symbol.asyncIterator]() {
            const split = Math.min(2, content.byteLength);
            if (split > 0) yield content.subarray(0, split);
            if (split < content.byteLength) yield content.subarray(split);
          },
        },
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
      if (input.Key.includes('/objects/')) {
        if (this.options.permanentDeletePreconditionFailure) {
          const error = new Error('precondition failed');
          error.name = 'PreconditionFailed';
          error.$metadata = { httpStatusCode: 412 };
          throw error;
        }
        const object = this.objects.get(input.Key);
        if (!object) throw notFound();
        if (this.options.headVersionId === undefined) {
          assert.equal(
            input.IfMatch,
            `"${checksum(object.content).slice(0, 32)}"`,
          );
          assert.equal(input.VersionId, undefined);
        } else {
          assert.equal(input.IfMatch, undefined);
          assert.equal(input.VersionId, this.options.headVersionId);
        }
      }
      this.objects.delete(input.Key);
      if (
        input.Key.includes('/objects/') &&
        this.options.throwAfterPermanentDelete
      ) {
        throw new Error('lost delete response');
      }
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

function retentionCandidate(overrides = {}) {
  return Object.freeze({
    ...LOOKUP,
    executorType: 'remote_worker',
    finishedAtMs: 1_000,
    ...overrides,
  });
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
  assert.match(
    key,
    /^tenant-a\/worker-artifacts\/objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/,
  );
  assert.equal(key.includes(COMMAND.runId), false);
  assert.equal(client.objects.size, 1);

  const copy = client.commands.find(
    (command) => command instanceof CopyObjectCommand,
  );
  const cleanup = client.commands.find(
    (command) =>
      command instanceof DeleteObjectCommand &&
      command.input.Key.includes('/temporary/'),
  );
  assert.match(cleanup.input.IfMatch, /^"[A-Za-z0-9+/=]+"$/);
  assert.equal(cleanup.input.VersionId, undefined);
  assert.equal(copy.input.Metadata['ql3-content-sha256'], CONTENT_SHA256);
  assert.equal(
    JSON.stringify(copy.input.Metadata).includes(COMMAND.projectId),
    false,
  );
  assert.equal(
    JSON.stringify(copy.input.Metadata).includes(COMMAND.runId),
    false,
  );

  const inspected = await adapter.inspect(LOOKUP);
  assert.deepEqual(inspected, { ...receipt, status: 'already_stored' });
});

test('cleans one exact temporary object version after validated HEAD', async () => {
  const client = new MemoryS3Client({
    temporaryHeadVersionId: 'temporary/version+1=',
  });
  await store(client).put(COMMAND, chunks());
  const cleanup = client.commands.find(
    (command) =>
      command instanceof DeleteObjectCommand &&
      command.input.Key.includes('/temporary/'),
  );
  assert.equal(cleanup.input.VersionId, 'temporary/version+1=');
  assert.equal(cleanup.input.IfMatch, undefined);
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

test('reads only one ETag-fenced immutable byte range and stable end snapshot', async () => {
  const client = new MemoryS3Client();
  const adapter = store(client);
  await adapter.put(COMMAND, chunks());
  client.commands.length = 0;

  const result = await adapter.readLogRange(LOOKUP, { offset: 2, length: 4 });
  assert.equal(result.status, 'available');
  assert.equal(Buffer.from(result.content).toString(), 'llo ');
  assert.deepEqual(
    {
      start: result.start,
      endExclusive: result.endExclusive,
      totalBytes: result.totalBytes,
      nextOffset: result.nextOffset,
      truncation: result.truncation,
    },
    {
      start: 2,
      endExclusive: 6,
      totalBytes: 11,
      nextOffset: 6,
      truncation: { truncated: false },
    },
  );
  assert.deepEqual(
    client.commands.map((command) => command.constructor.name),
    ['HeadObjectCommand', 'GetObjectCommand'],
  );
  assert.equal(client.commands[1].input.Range, 'bytes=2-5');

  client.commands.length = 0;
  const ended = await adapter.readLogRange(LOOKUP, {
    offset: 999,
    length: 4,
  });
  assert.equal(ended.status, 'available');
  assert.equal(ended.content.byteLength, 0);
  assert.equal(ended.start, 11);
  assert.equal(ended.totalBytes, 11);
  assert.deepEqual(
    client.commands.map((command) => command.constructor.name),
    ['HeadObjectCommand'],
  );
});

test('maps absent objects and fails closed on range evidence drift', async () => {
  const absent = new MemoryS3Client();
  assert.deepEqual(
    await store(absent).readLogRange(LOOKUP, { offset: 0, length: 1 }),
    { status: 'missing' },
  );
  for (const option of [
    'corruptContentRange',
    'corruptRangeETag',
    'corruptRangeMetadata',
    'shortRangeBody',
    'oversizedRangeBody',
  ]) {
    const client = new MemoryS3Client();
    const adapter = store(client);
    await adapter.put(COMMAND, chunks());
    client.options[option] = true;
    await assert.rejects(
      adapter.readLogRange(LOOKUP, { offset: 0, length: 4 }),
      (error) =>
        error instanceof S3ClusterRemoteWorkerArtifactStoreError &&
        error.reason === 'integrity_mismatch',
    );
  }
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
  assert.deepEqual(diagnostics, [
    ['delete unavailable', 'temporary_object_cleanup'],
  ]);
  assert.equal(client.objects.size, 2);
});

test('requires exact bucket, prefix, encryption and temporary ID configuration', async () => {
  const client = new MemoryS3Client();
  assert.throws(
    () =>
      new S3ClusterRemoteWorkerArtifactStore({
        client,
        bucket: 'Invalid_Bucket',
        encryption: { mode: 's3' },
      }),
    /bucket is invalid/,
  );
  assert.throws(
    () =>
      new S3ClusterRemoteWorkerArtifactStore({
        client,
        bucket: 'valid-bucket',
        prefix: '../escape',
        encryption: { mode: 's3' },
      }),
    /prefix is invalid/,
  );
  assert.throws(
    () =>
      new S3ClusterRemoteWorkerArtifactStore({
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
  const temporaryKey = `tenant-a/worker-artifacts/temporary/${TEMPORARY_ID}`;
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

test('retires an unversioned Artifact only with its validated ETag', async () => {
  const client = new MemoryS3Client();
  const adapter = store(client, { expectedBucketOwner: '123456789012' });
  await adapter.put(COMMAND, chunks());
  client.commands.length = 0;

  assert.deepEqual(await adapter.retire(retentionCandidate()), {
    disposition: 'deleted',
    byteLength: CONTENT.byteLength,
    truncation: { truncated: false },
  });
  assert.deepEqual(
    client.commands.map((command) => command.constructor.name),
    ['HeadObjectCommand', 'DeleteObjectCommand'],
  );
  assert.equal(client.commands[1].input.ExpectedBucketOwner, '123456789012');
  assert.equal(permanentKey(client), undefined);
});

test('retires one exact version when HEAD returns an opaque VersionId', async () => {
  const client = new MemoryS3Client({ headVersionId: 'version/opaque+1=' });
  const adapter = store(client);
  await adapter.put(COMMAND, chunks());
  client.commands.length = 0;

  const result = await adapter.retire(retentionCandidate());
  assert.equal(result.disposition, 'deleted');
  assert.equal(client.commands[1].input.VersionId, 'version/opaque+1=');
  assert.equal(client.commands[1].input.IfMatch, undefined);
  assert.equal(permanentKey(client), undefined);
});

test('returns durable absent evidence without issuing a delete', async () => {
  const client = new MemoryS3Client();
  const adapter = store(client);

  assert.deepEqual(await adapter.retire(retentionCandidate()), {
    disposition: 'already_absent',
    byteLength: 0,
    truncation: { truncated: 'unknown' },
  });
  assert.deepEqual(
    client.commands.map((command) => command.constructor.name),
    ['HeadObjectCommand'],
  );
});

test('fails closed on conditional-delete drift and malformed version authority', async () => {
  for (const options of [
    { permanentDeletePreconditionFailure: true },
    { headVersionId: 'invalid\nversion' },
  ]) {
    const client = new MemoryS3Client(options);
    const adapter = store(client);
    await adapter.put(COMMAND, chunks());
    client.commands.length = 0;

    await assert.rejects(
      adapter.retire(retentionCandidate()),
      (error) =>
        error instanceof S3ClusterRemoteWorkerArtifactStoreError &&
        error.reason === 'integrity_mismatch',
    );
    assert.notEqual(permanentKey(client), undefined);
  }

  const wrongExecutor = new MemoryS3Client();
  await assert.rejects(
    store(wrongExecutor).retire(
      retentionCandidate({ executorType: 'local_process' }),
    ),
    (error) =>
      error instanceof S3ClusterRemoteWorkerArtifactStoreError &&
      error.reason === 'integrity_mismatch',
  );
  assert.equal(wrongExecutor.commands.length, 0);
});

test('lost delete response converges through a later absent inspection', async () => {
  const client = new MemoryS3Client({ throwAfterPermanentDelete: true });
  const adapter = store(client);
  await adapter.put(COMMAND, chunks());
  client.commands.length = 0;

  await assert.rejects(
    adapter.retire(retentionCandidate()),
    (error) =>
      error instanceof S3ClusterRemoteWorkerArtifactStoreError &&
      error.reason === 'unavailable',
  );
  client.options.throwAfterPermanentDelete = false;
  assert.deepEqual(await adapter.retire(retentionCandidate()), {
    disposition: 'already_absent',
    byteLength: 0,
    truncation: { truncated: 'unknown' },
  });
});
