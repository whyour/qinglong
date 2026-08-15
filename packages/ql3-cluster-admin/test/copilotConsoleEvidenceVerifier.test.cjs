'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createClusterConsoleEvidenceBundle,
  serializeClusterConsoleEvidenceBundle,
} = require('../assets/copilot-console/evidence-bundle.js');
const {
  CLUSTER_CONSOLE_EVIDENCE_BUNDLE_SCHEMA,
  CLUSTER_CONSOLE_EVIDENCE_VERIFICATION_SCHEMA,
  verifyClusterConsoleEvidenceBundleFile,
} = require('../dist/copilot-console/evidenceVerifier.js');

const cliPath = path.resolve(
  __dirname,
  '../dist/copilot-console/evidenceVerifierCli.js',
);
const requestSchema = 'qinglong/cluster-copilot-console-read-request@v1';

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
}

function resign(bundle) {
  const unsigned = {};
  for (const key of Object.keys(bundle)) {
    if (key !== 'contentDigest') unsigned[key] = bundle[key];
  }
  bundle.contentDigest = createHash('sha256')
    .update(canonicalize(unsigned), 'utf8')
    .digest('hex');
  return bundle;
}

async function validBundle() {
  return createClusterConsoleEvidenceBundle(
    [
      {
        operation: 'run_read',
        observedAtMs: 1_700_000_000_000,
        request: {
          schema: requestSchema,
          operation: 'run_read',
          projectId: 'private-project',
          requestId: 'private-request',
          runId: 'private-run',
        },
        fact: {
          schema: 'qinglong/bounded-run-projection@v1',
          schemaVersion: 1,
          status: 'succeeded',
          projectId: 'private-project',
          runId: 'private-run',
          createdAtMs: 1_700_000_000_000,
          outputAvailable: true,
          message: 'must-never-survive-redaction',
        },
      },
    ],
    1_700_000_001_000,
    webcrypto,
  );
}

function fixture(t, encoded, name = 'evidence.json') {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-evidence-verifier-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, encoded, { mode: 0o644 });
  return { directory, filePath };
}

test('independently verifies the browser generator output without authority claims', async (t) => {
  const bundle = await validBundle();
  const encoded = serializeClusterConsoleEvidenceBundle(bundle);
  const { filePath } = fixture(t, encoded);

  const result = verifyClusterConsoleEvidenceBundleFile(filePath);
  assert.deepEqual(result, {
    schema: CLUSTER_CONSOLE_EVIDENCE_VERIFICATION_SCHEMA,
    status: 'verified',
    bundle: {
      schema: CLUSTER_CONSOLE_EVIDENCE_BUNDLE_SCHEMA,
      contentDigest: bundle.contentDigest,
      entryCount: 1,
      totalRawCanonicalBytes: bundle.source.totalRawCanonicalBytes,
    },
    integrity: {
      bundleDigest: 'verified',
      rawFactDigests: 'not_recomputed_without_raw_facts',
    },
    claims: {
      serverSignature: 'not_verified',
      attestation: 'not_verified',
      durableAudit: 'not_verified',
      actionAuthority: 'none',
    },
    execution: { networkAccess: false, mutation: false, fileWrites: false },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(encoded.includes('must-never-survive-redaction'), false);
});

test('cross-verifies every fixed Console read operation', async (t) => {
  const requests = {
    inspect: { projectId: 'p-1', requestId: 'q-1', sourceRunId: 'r-1' },
    output: { projectId: 'p-2', requestId: 'q-2', sourceRunId: 'r-2' },
    run_list: {
      afterCreatedAtMs: null,
      afterRunId: null,
      limit: 32,
      projectId: 'p-3',
      requestId: 'q-3',
    },
    run_read: { projectId: 'p-4', requestId: 'q-4', runId: 'r-4' },
    run_event_list: {
      afterSequence: null,
      limit: 32,
      projectId: 'p-5',
      requestId: 'q-5',
      runId: 'r-5',
    },
    run_step_list: {
      afterStepKey: null,
      afterStepRunId: null,
      limit: 32,
      projectId: 'p-6',
      requestId: 'q-6',
      runId: 'r-6',
    },
    task_list: {
      afterTaskId: null,
      limit: 32,
      projectId: 'p-7',
      requestId: 'q-7',
    },
    task_read: { projectId: 'p-8', requestId: 'q-8', taskId: 't-8' },
    workflow_list: {
      packageName: 'pkg-9',
      projectId: 'p-9',
      requestId: 'q-9',
    },
    workflow_run_list: {
      afterAdmittedAtMs: null,
      afterRunId: null,
      limit: 32,
      packageName: 'pkg-10',
      projectId: 'p-10',
      requestId: 'q-10',
      workflowId: 'w-10',
    },
    workflow_run_read: {
      packageName: 'pkg-11',
      projectId: 'p-11',
      requestId: 'q-11',
      runId: 'r-11',
      workflowId: 'w-11',
    },
    workflow_event_list: {
      afterSequence: null,
      limit: 32,
      packageName: 'pkg-12',
      projectId: 'p-12',
      requestId: 'q-12',
      runId: 'r-12',
      workflowId: 'w-12',
    },
    workflow_step_list: {
      afterStepKey: null,
      afterStepRunId: null,
      limit: 32,
      packageName: 'pkg-13',
      projectId: 'p-13',
      requestId: 'q-13',
      runId: 'r-13',
      workflowId: 'w-13',
    },
  };
  const records = Object.entries(requests).map(
    ([operation, request], index) => ({
      operation,
      observedAtMs: 1_700_000_000_000 + index,
      request: { schema: requestSchema, operation, ...request },
      fact: {
        schema: 'qinglong/test-fact@v1',
        schemaVersion: 1,
        operation,
        status: 'succeeded',
      },
    }),
  );
  const bundle = await createClusterConsoleEvidenceBundle(
    records,
    1_700_000_001_000,
    webcrypto,
  );
  const { filePath } = fixture(
    t,
    serializeClusterConsoleEvidenceBundle(bundle),
  );
  const result = verifyClusterConsoleEvidenceBundleFile(filePath);
  assert.equal(result.status, 'verified');
  assert.equal(result.bundle.entryCount, 13);
});

test('CLI is secret-free on success, invalid input and usage errors', async (t) => {
  const bundle = await validBundle();
  const { filePath } = fixture(
    t,
    serializeClusterConsoleEvidenceBundle(bundle),
    'private-customer-run.json',
  );
  const success = spawnSync(
    process.execPath,
    [cliPath, `--bundle=${filePath}`],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(success.status, 0);
  assert.equal(JSON.parse(success.stdout).status, 'verified');
  assert.equal(success.stderr, '');
  assert.equal(success.stdout.includes(filePath), false);
  assert.equal(success.stdout.includes('private-customer-run'), false);

  const tampered = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  tampered.entries[0].fact.status = 'failed';
  fs.writeFileSync(filePath, `${JSON.stringify(tampered, null, 2)}\n`);
  const invalid = spawnSync(
    process.execPath,
    [cliPath, `--bundle=${filePath}`],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(invalid.status, 65);
  assert.equal(invalid.stdout, '');
  assert.equal(
    JSON.parse(invalid.stderr).code,
    'QL3_CLUSTER_CONSOLE_EVIDENCE_VERIFICATION_INVALID',
  );
  assert.equal(invalid.stderr.includes(filePath), false);

  const usage = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' });
  assert.equal(usage.status, 64);
  assert.equal(
    JSON.parse(usage.stderr).code,
    'QL3_CLUSTER_CONSOLE_EVIDENCE_VERIFIER_USAGE_INVALID',
  );
  const help = spawnSync(process.execPath, [cliPath, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: ql3-copilot-evidence-verify/);
});

test('rejects re-signed structural widening, alias gaps and false proof claims', async (t) => {
  const baseline = JSON.parse(
    serializeClusterConsoleEvidenceBundle(await validBundle()),
  );
  const mutations = [
    (bundle) => {
      bundle.entries[0].fact.message = 'unsafe free text';
    },
    (bundle) => {
      bundle.entries[0].target.runId = 'run-002';
    },
    (bundle) => {
      bundle.integrity.serverSignature = true;
    },
    (bundle) => {
      bundle.source.totalRawCanonicalBytes += 1;
    },
    (bundle) => {
      bundle.entries[0].sequence = 2;
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const candidate = structuredClone(baseline);
    mutate(candidate);
    resign(candidate);
    const { filePath } = fixture(
      t,
      `${JSON.stringify(candidate, null, 2)}\n`,
      `invalid-${index}.json`,
    );
    assert.throws(() => verifyClusterConsoleEvidenceBundleFile(filePath), {
      code: 'QL3_CLUSTER_CONSOLE_EVIDENCE_VERIFICATION_INVALID',
    });
  }
});

test('rejects non-canonical JSON, links, relative paths and oversized files', async (t) => {
  const encoded = serializeClusterConsoleEvidenceBundle(await validBundle());
  for (const [name, contents] of [
    ['minified.json', JSON.stringify(JSON.parse(encoded))],
    ['bom.json', `\ufeff${encoded}`],
    ['crlf.json', encoded.replaceAll('\n', '\r\n')],
    [
      'duplicate.json',
      encoded.replace(
        '{\n',
        `{\n  "schema": "${CLUSTER_CONSOLE_EVIDENCE_BUNDLE_SCHEMA}",\n`,
      ),
    ],
  ]) {
    const { filePath } = fixture(t, contents, name);
    assert.throws(
      () => verifyClusterConsoleEvidenceBundleFile(filePath),
      undefined,
      name,
    );
  }

  const { directory, filePath } = fixture(t, encoded, 'source.json');
  const linkPath = path.join(directory, 'link.json');
  fs.symlinkSync(filePath, linkPath);
  assert.throws(() => verifyClusterConsoleEvidenceBundleFile(linkPath));
  assert.throws(() => verifyClusterConsoleEvidenceBundleFile('source.json'));

  const oversized = path.join(directory, 'oversized.json');
  fs.writeFileSync(oversized, 'x'.repeat(512 * 1024 + 1));
  assert.throws(() => verifyClusterConsoleEvidenceBundleFile(oversized));
});
