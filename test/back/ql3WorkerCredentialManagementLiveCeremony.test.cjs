const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
  WorkerCredentialManagementLiveCeremonyError,
  assertionIdentity,
  parseArguments,
  runWorkerCredentialManagementLiveCeremony,
  validateWorkerCredentialManagementLiveCeremony,
} = require('../../scripts/ql3-worker-credential-management-live-ceremony.cjs');

const NOW_MS = 1_700_000_000_000;
const temporaryDirectories = [];

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function assertion(subject, overrides = {}, headerOverrides = {}) {
  const now = Math.floor(NOW_MS / 1000);
  return `${encode({
    alg: 'EdDSA',
    kid: `key-${subject}`,
    typ: 'ql3-worker-credential-management+jwt',
    ...headerOverrides,
  })}.${encode({
    acr: 'urn:production:mfa',
    amr: ['pwd', 'otp'],
    aud: 'qinglong3-worker-credential-management',
    auth_time: now - 20,
    exp: now + 120,
    iat: now - 10,
    iss: 'https://identity.production.example.org/',
    jti: `session-${subject}`,
    ql3_purpose: 'worker-credential-management',
    sub: subject,
    ...overrides,
  })}.${Buffer.alloc(64, 7).toString('base64url')}`;
}

function ceremony() {
  return {
    schemaVersion: 1,
    planRequest: {
      actionRef: 'worker-credential:worker-a:generation-2',
      authorityProjectId: 'cluster-authority',
      action: 'rotate',
      deliveryId: '123e4567-e89b-42d3-a456-426614174901',
      workerId: 'worker-a',
      credentialId: 'credential-generation-2',
      previousCredentialId: 'credential-generation-1',
      credentialNotBeforeAtMs: NOW_MS + 1_000,
      credentialExpiresAtMs: NOW_MS + 10 * 60_000,
      deploymentTargetDigest: 'd'.repeat(64),
      deploymentGeneration: 'generation-2',
    },
    approvalRequestId: 'approval-worker-a-generation-2',
    approvalAuditEventId: '123e4567-e89b-42d3-a456-426614174902',
    requesterDecisionId: 'requester-self-decision',
    requesterDecisionAuditEventId: '123e4567-e89b-42d3-a456-426614174903',
    reviewerDecisionId: 'reviewer-decision',
    reviewerDecisionAuditEventId: '123e4567-e89b-42d3-a456-426614174904',
    decisionReasonCode: 'reviewed',
    inspectionId: 'inspection-worker-a-generation-2',
  };
}

function writePrivate(directory, name, value) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(
    filePath,
    typeof value === 'string' ? value : `${JSON.stringify(value)}\n`,
    { mode: 0o600 },
  );
  return filePath;
}

function fixture() {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-worker-ceremony-test-')),
  );
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return {
    configFile: writePrivate(directory, 'client.json', {}),
    requesterAssertionFile: writePrivate(
      directory,
      'requester.jwt',
      assertion('operator-a'),
    ),
    reviewerAssertionFile: writePrivate(
      directory,
      'reviewer.jwt',
      assertion('reviewer-b'),
    ),
    ceremonyFile: writePrivate(directory, 'ceremony.json', ceremony()),
    outputFile: path.join(directory, 'evidence.json'),
  };
}

function approval(state, decidedBy = null) {
  return {
    id: 'approval-worker-a-generation-2',
    version: state === 'pending' ? 1 : 2,
    state,
    requestedBy: { type: 'user', id: 'operator-a' },
    decidedBy,
    dispatchId: null,
    consumedAtMs: null,
    actionDigest: 'a'.repeat(64),
    previewDigest: 'b'.repeat(64),
  };
}

function liveDependencies(options = {}) {
  const calls = [];
  let sequence = 0;
  const plan = {
    actionRef: ceremony().planRequest.actionRef,
    authorityProjectId: ceremony().planRequest.authorityProjectId,
    requestedBy: { type: 'user', id: 'operator-a' },
    planDigest: 'a'.repeat(64),
    previewDigest: 'b'.repeat(64),
  };
  return {
    calls,
    dependencies: {
      now: () => NOW_MS,
      normalize(command) {
        assert.equal(command.schemaVersion, 1);
        assert.match(command.operation, /^worker-credential\./);
        assert.notEqual(command.operation, 'worker-credential.execute');
        return command;
      },
      async collectOidc(identity) {
        assert.equal(
          identity.issuer,
          'https://identity.production.example.org/',
        );
        return {
          discoveryDocumentSha256: `sha256:${'c'.repeat(64)}`,
          jwksSha256: `sha256:${'d'.repeat(64)}`,
        };
      },
      async execute(paths) {
        const command = JSON.parse(fs.readFileSync(paths.commandFile, 'utf8'));
        calls.push({
          operation: command.operation,
          actor: path.basename(paths.assertionFile),
        });
        sequence += 1;
        if (command.operation === 'worker-credential.plan') {
          return {
            requestId: 'request-plan',
            result: { status: 'created', plan },
          };
        }
        if (command.operation === 'worker-credential.propose') {
          return {
            requestId: 'request-propose',
            result: {
              approvalStatus: 'created',
              plan,
              approval: approval('pending'),
            },
          };
        }
        if (
          command.operation === 'worker-credential.decide' &&
          path.basename(paths.assertionFile) === 'requester.jwt'
        ) {
          if (options.acceptSelfDecision) {
            return {
              requestId: 'request-self',
              result: {
                status: 'decided',
                approval: approval('approved', {
                  type: 'user',
                  id: 'operator-a',
                }),
              },
            };
          }
          throw {
            statusCode: 403,
            responseCode: 'forbidden',
            requestId: 'request-self',
          };
        }
        if (command.operation === 'worker-credential.decide') {
          return {
            requestId: 'request-reviewer',
            result: {
              status: 'decided',
              approval: approval('approved', {
                type: 'user',
                id: 'reviewer-b',
              }),
            },
          };
        }
        assert.equal(command.operation, 'worker-credential.inspect');
        return {
          requestId: 'request-inspect',
          result: {
            stale: false,
            approval: approval('approved', { type: 'user', id: 'reviewer-b' }),
          },
        };
      },
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('runs one external two-User ceremony without execution or sensitive evidence', async () => {
  const paths = fixture();
  const live = liveDependencies();
  const report = await runWorkerCredentialManagementLiveCeremony(
    paths,
    live.dependencies,
  );

  assert.deepEqual(live.calls, [
    { operation: 'worker-credential.plan', actor: 'requester.jwt' },
    { operation: 'worker-credential.propose', actor: 'requester.jwt' },
    { operation: 'worker-credential.decide', actor: 'requester.jwt' },
    { operation: 'worker-credential.decide', actor: 'reviewer.jwt' },
    { operation: 'worker-credential.inspect', actor: 'reviewer.jwt' },
  ]);
  assert.equal(report.gates.passed, true);
  assert.equal(report.ceremony.dispatchCreated, false);
  assert.equal(report.ceremony.approvalConsumed, false);
  assert.equal(
    validateWorkerCredentialManagementLiveCeremony(report).compatible,
    true,
  );
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /operator-a|reviewer-b|session-|eyJ/);
  assert.equal(fs.statSync(paths.outputFile).mode & 0o777, 0o600);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(paths.outputFile, 'utf8')),
    report,
  );
  const audit = spawnSync(
    process.execPath,
    [
      path.resolve(
        __dirname,
        '../../scripts/ql3-worker-credential-management-live-ceremony-audit.cjs',
      ),
      `--report=${paths.outputFile}`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).compatible, true);
});

test('rejects same-User, wrong-purpose and non-external identities before requests', async () => {
  for (const [requester, reviewer] of [
    [assertion('same-user'), assertion('same-user')],
    [
      assertion('operator-a', { ql3_purpose: 'plugin-package-management' }),
      assertion('reviewer-b'),
    ],
    [
      assertion('operator-a', { iss: 'https://identity.example.test/' }),
      assertion('reviewer-b', { iss: 'https://identity.example.test/' }),
    ],
  ]) {
    const paths = fixture();
    fs.writeFileSync(paths.requesterAssertionFile, requester, { mode: 0o600 });
    fs.writeFileSync(paths.reviewerAssertionFile, reviewer, { mode: 0o600 });
    const live = liveDependencies();
    await assert.rejects(
      runWorkerCredentialManagementLiveCeremony(paths, live.dependencies),
      WorkerCredentialManagementLiveCeremonyError,
    );
    assert.deepEqual(live.calls, []);
    assert.equal(fs.existsSync(paths.outputFile), false);
  }
});

test('fails closed when requester self-approval is accepted', async () => {
  const paths = fixture();
  const live = liveDependencies({ acceptSelfDecision: true });
  await assert.rejects(
    runWorkerCredentialManagementLiveCeremony(paths, live.dependencies),
    /self-decision was accepted/,
  );
  assert.equal(fs.existsSync(paths.outputFile), false);
  assert.equal(
    live.calls.some(
      ({ operation }) => operation === 'worker-credential.inspect',
    ),
    false,
  );
});

test('rejects broad, symlinked and replaceable private evidence files', async () => {
  {
    const paths = fixture();
    fs.chmodSync(paths.requesterAssertionFile, 0o640);
    const live = liveDependencies();
    await assert.rejects(
      runWorkerCredentialManagementLiveCeremony(paths, live.dependencies),
      WorkerCredentialManagementLiveCeremonyError,
    );
    assert.deepEqual(live.calls, []);
  }
  {
    const paths = fixture();
    const target = writePrivate(
      path.dirname(paths.ceremonyFile),
      'ceremony-target.json',
      ceremony(),
    );
    fs.rmSync(paths.ceremonyFile);
    fs.symlinkSync(target, paths.ceremonyFile);
    const live = liveDependencies();
    await assert.rejects(
      runWorkerCredentialManagementLiveCeremony(paths, live.dependencies),
      WorkerCredentialManagementLiveCeremonyError,
    );
    assert.deepEqual(live.calls, []);
  }
  {
    const paths = fixture();
    fs.writeFileSync(paths.outputFile, '{}\n', { mode: 0o600 });
    const live = liveDependencies();
    await assert.rejects(
      runWorkerCredentialManagementLiveCeremony(paths, live.dependencies),
      WorkerCredentialManagementLiveCeremonyError,
    );
    assert.deepEqual(live.calls, []);
  }
});

test('offline audit rejects widened, false-gate and sensitive reports', async () => {
  const paths = fixture();
  const live = liveDependencies();
  const report = await runWorkerCredentialManagementLiveCeremony(
    paths,
    live.dependencies,
  );
  for (const candidate of [
    { ...report, debug: true },
    { ...report, gates: { ...report.gates, passed: false } },
    { ...report, identity: { ...report.identity, secret: 'must-not-exist' } },
  ]) {
    assert.equal(
      validateWorkerCredentialManagementLiveCeremony(candidate).compatible,
      false,
    );
  }
});

test('parses only the five path-based CLI arguments', () => {
  assert.deepEqual(
    parseArguments([
      '--config=/private/client.json',
      '--requester-assertion=/private/requester.jwt',
      '--reviewer-assertion=/private/reviewer.jwt',
      '--ceremony=/private/ceremony.json',
      '--output=/private/evidence.json',
    ]),
    {
      configFile: '/private/client.json',
      requesterAssertionFile: '/private/requester.jwt',
      reviewerAssertionFile: '/private/reviewer.jwt',
      ceremonyFile: '/private/ceremony.json',
      outputFile: '/private/evidence.json',
    },
  );
  assert.throws(
    () => parseArguments(['--requester-assertion=raw-jwt']),
    WorkerCredentialManagementLiveCeremonyError,
  );
});

test('validates the Worker-specific assertion envelope and lifetime', () => {
  assert.deepEqual(
    assertionIdentity(assertion('operator-a'), NOW_MS).subject,
    'operator-a',
  );
  assert.throws(
    () =>
      assertionIdentity(
        assertion('operator-a', { exp: NOW_MS / 1000 - 1 }),
        NOW_MS,
      ),
    WorkerCredentialManagementLiveCeremonyError,
  );
  assert.throws(
    () =>
      assertionIdentity(
        assertion(
          'operator-a',
          {},
          { typ: 'ql3-plugin-package-management+jwt' },
        ),
        NOW_MS,
      ),
    WorkerCredentialManagementLiveCeremonyError,
  );
});
