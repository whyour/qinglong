const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PluginPackageManagementLiveExerciseError,
  assertionIdentity,
  beforePhase,
  exerciseFromState,
  ingressProbes,
  overlapPhase,
  probePod,
  revokedPhase,
  stateDigest,
  validateKeyset,
  validateState,
} = require('../../scripts/ql3-plugin-package-management-live-exercise.cjs');
const {
  validateExercise,
} = require('../../scripts/ql3-plugin-package-management-live-evidence-collect.cjs');

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const ISSUER = 'https://login.example.com/';
const AUDIENCE = 'qinglong3-package-management';

function compact(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function assertion({ kid, subject, jti, assurance = 'mfa', now = NOW }) {
  const seconds = Math.floor(now / 1000);
  return `${compact({
    alg: 'EdDSA',
    kid,
    typ: 'ql3-plugin-package-management+jwt',
  })}.${compact({
    acr: assurance,
    amr: assurance === 'mfa' ? ['pwd', 'otp'] : ['hwk'],
    aud: AUDIENCE,
    auth_time: seconds - 10,
    exp: seconds + 120,
    iat: seconds - 10,
    iss: ISSUER,
    jti,
    ql3_purpose: 'plugin-package-management',
    sub: subject,
  })}.c2lnbmF0dXJl`;
}

function keyset(generation, activeKids, revokedKids = []) {
  const document = {
    schemaVersion: 1,
    generation,
    issuer: ISSUER,
    audience: AUDIENCE,
    keys: [...new Set([...activeKids, ...revokedKids])].map((kid) => ({
      alg: 'EdDSA',
      crv: 'Ed25519',
      kid,
      kty: 'OKP',
      use: 'sig',
      x: 'a'.repeat(43),
    })),
    revokedKids,
    assuranceMappings: [
      { acr: 'mfa', assurance: 'multi_factor', requiredAmr: ['pwd', 'otp'] },
      { acr: 'hardware', assurance: 'hardware', requiredAmr: ['hwk'] },
    ],
    constraints: {
      maxAssertionBytes: 8192,
      maxLifetimeMs: 300000,
      maxAuthenticationAgeMs: 300000,
      clockSkewMs: 5000,
    },
  };
  return {
    ...validateKeyset(document),
    resourceVersion: `keyset-${generation}`,
  };
}

function snapshot(generation, activeKids, revokedKids, tls) {
  return {
    clusterIdentitySha256: `sha256:${'1'.repeat(64)}`,
    replicas: 2,
    readyReplicas: 2,
    unavailableReplicas: 0,
    pods: [
      { name: 'management-a', uid: 'pod-a', ip: '10.0.0.10' },
      { name: 'management-b', uid: 'pod-b', ip: '10.0.0.11' },
    ],
    image: `registry.example/qinglong3@sha256:${'2'.repeat(64)}`,
    imagePullPolicy: 'IfNotPresent',
    imagePullSecrets: [],
    keyset: keyset(generation, activeKids, revokedKids),
    tls: {
      serial: tls.serial,
      resourceVersion: tls.resourceVersion,
    },
  };
}

function http(snapshotValue, status, payload) {
  return {
    status,
    payload,
    tlsProtocol: 'TLSv1.3',
    tlsSerial: snapshotValue.tls.serial,
  };
}

function success(snapshotValue, operation, extra = {}) {
  return http(snapshotValue, 200, {
    schemaVersion: 1,
    requestId: 'request-id',
    result: { schemaVersion: 1, operation, ...extra },
  });
}

function failure(snapshotValue, status, code) {
  return http(snapshotValue, status, {
    schemaVersion: 1,
    requestId: 'request-id',
    error: { code },
  });
}

function exactIsolation() {
  return {
    labelledClientOutcome: 'tls13_connected',
    unlabelledClientOutcome: 'timeout',
    wrongPortOutcome: 'timeout',
    kubernetesApiEgressOutcome: 'timeout',
    publicInternetEgressOutcome: 'timeout',
    postgresEgressOutcome: 'postgres_ready',
  };
}

test('derives strong identities from the active keyset assurance mapping', () => {
  const reviewed = keyset(7, ['old-key']);
  const identity = assertionIdentity(
    assertion({
      kid: 'old-key',
      subject: 'tenant/requester',
      jti: 'requester-jti',
    }),
    reviewed,
    NOW,
  );
  assert.deepEqual(identity, {
    kid: 'old-key',
    subject: 'tenant/requester',
    assurance: 'multi_factor',
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresAt: Math.floor(NOW / 1000) + 120,
  });
  assert.throws(
    () =>
      assertionIdentity(
        assertion({
          kid: 'old-key',
          subject: 'tenant/requester',
          jti: 'expired-jti',
          now: NOW - 10 * 60 * 1000,
        }),
        reviewed,
        NOW,
      ),
    PluginPackageManagementLiveExerciseError,
  );
});

test('rejects any private JWK material in the projected identity document', () => {
  const value = keyset(7, ['old-key']).document;
  const privateValue = structuredClone(value);
  privateValue.keys[0].d = 'private-component';
  assert.throws(
    () => validateKeyset(privateValue),
    PluginPackageManagementLiveExerciseError,
  );
});

test('runs before, overlap and revoked as an ordered digest-linked ceremony', async () => {
  const requester = assertion({
    kid: 'old-key',
    subject: 'tenant/requester',
    jti: 'requester-jti',
  });
  const reviewer = assertion({
    kid: 'old-key',
    subject: 'tenant/reviewer',
    jti: 'reviewer-jti',
  });
  const oldOverlap = assertion({
    kid: 'old-key',
    subject: 'tenant/requester',
    jti: 'old-overlap-jti',
    now: NOW + 60_000,
  });
  const newOverlap = assertion({
    kid: 'new-key',
    subject: 'tenant/reviewer',
    jti: 'new-overlap-jti',
    now: NOW + 60_000,
  });
  const beforeSnapshot = snapshot(7, ['old-key'], [], {
    serial: 'A1',
    resourceVersion: 'tls-1',
  });
  let beforeRequest = 0;
  const before = await beforePhase(
    {
      endpoint: `https://management.example.com${'/api/v3/plugin-packages/management'}`,
      requesterAssertion: requester,
      reviewerAssertion: reviewer,
      actionInput: { evidence: true },
      nowMs: NOW,
    },
    {
      async snapshot() {
        return beforeSnapshot;
      },
      async request(assertionValue, command) {
        beforeRequest += 1;
        if (command.operation === 'plugin-package.propose') {
          assert.equal(assertionValue, requester);
          return success(beforeSnapshot, command.operation, {
            approval: { version: 1, state: 'pending' },
          });
        }
        if (
          command.operation === 'plugin-package.decide' &&
          assertionValue === requester
        ) {
          return failure(beforeSnapshot, 403, 'forbidden');
        }
        if (command.operation === 'plugin-package.decide') {
          assert.equal(assertionValue, reviewer);
          return success(beforeSnapshot, command.operation, {
            approval: { version: 2, state: 'approved' },
          });
        }
        assert.equal(command.operation, 'plugin-package.inspect');
        return success(beforeSnapshot, command.operation, {
          approval: { version: 2, state: 'approved' },
        });
      },
      async network() {
        return exactIsolation();
      },
    },
  );
  assert.equal(beforeRequest, 4);
  assert.equal(validateState(before, 'before'), before);

  const overlapSnapshot = snapshot(8, ['old-key', 'new-key'], [], {
    serial: 'B2',
    resourceVersion: 'tls-2',
  });
  const overlap = await overlapPhase(
    {
      endpoint: before.endpoint,
      state: before,
      oldAssertion: oldOverlap,
      newAssertion: newOverlap,
      nowMs: NOW + 60_000,
    },
    {
      async snapshot() {
        return overlapSnapshot;
      },
      async request(_assertionValue, command) {
        return success(overlapSnapshot, command.operation, {
          approval: { version: 2, state: 'approved' },
        });
      },
    },
  );
  assert.equal(overlap.previousStateSha256, before.stateSha256);
  assert.equal(validateState(overlap, 'overlap'), overlap);
  await assert.rejects(
    () =>
      revokedPhase(
        {
          endpoint: overlap.endpoint,
          state: overlap,
          oldAssertion: assertion({
            kid: 'old-key',
            subject: 'tenant/requester',
            jti: 'replacement-old-jti',
            now: NOW + 60_000,
          }),
          newAssertion: newOverlap,
          nowMs: NOW + 120_000,
        },
        {
          async snapshot() {
            return snapshot(9, ['new-key'], ['old-key'], {
              serial: 'B2',
              resourceVersion: 'tls-2',
            });
          },
          async request() {
            assert.fail('a substituted assertion must fail before HTTP');
          },
        },
      ),
    /append-only old-key revocation/,
  );

  const revokedSnapshot = snapshot(9, ['new-key'], ['old-key'], {
    serial: 'B2',
    resourceVersion: 'tls-2',
  });
  const revoked = await revokedPhase(
    {
      endpoint: overlap.endpoint,
      state: overlap,
      oldAssertion: oldOverlap,
      newAssertion: newOverlap,
      nowMs: NOW + 120_000,
    },
    {
      async snapshot() {
        return revokedSnapshot;
      },
      async request(assertionValue, command) {
        return assertionValue === oldOverlap
          ? failure(revokedSnapshot, 401, 'authentication_required')
          : success(revokedSnapshot, command.operation, {
              approval: { version: 2, state: 'approved' },
            });
      },
    },
  );
  assert.equal(revoked.previousStateSha256, overlap.stateSha256);
  assert.equal(validateState(revoked, 'revoked'), revoked);
  assert.deepEqual(revoked.phaseObservedAt, [
    '2026-07-25T12:00:00.000Z',
    '2026-07-25T12:01:00.000Z',
    '2026-07-25T12:02:00.000Z',
  ]);

  const exercise = exerciseFromState(revoked, NOW + 121_000);
  assert.equal(
    validateExercise(exercise, NOW + 121_000).fixture,
    'qinglong/plugin-package-management-live-exercise@v1',
  );
  assert.deepEqual(exercise.identity.keysetGenerations, [7, 8, 9]);
  assert.equal(exercise.rotation.revokedOldStatus, 401);
  assert.equal(exercise.rotation.readinessSamples.length, 3);
  assert.throws(
    () => exerciseFromState(revoked, NOW + 25 * 60 * 60 * 1000),
    /timeline is stale/,
  );
});

test('rejects tampered state and cannot skip directly to revoked', async () => {
  const state = {
    schemaVersion: 1,
    fixture: 'qinglong/plugin-package-management-live-exercise-state@v1',
    phase: 'before',
    recordedAt: new Date(NOW).toISOString(),
    phaseObservedAt: [new Date(NOW).toISOString()],
    previousStateSha256: null,
    clusterIdentitySha256: `sha256:${'1'.repeat(64)}`,
    endpoint:
      'https://management.example.com/api/v3/plugin-packages/management',
    action: {
      actionRef: 'ql3-live-evidence:123e4567-e89b-42d3-a456-426614174000',
      approvalRequestId: '123e4567-e89b-42d3-a456-426614174001',
      proposalAuditEventId: '123e4567-e89b-42d3-a456-426614174002',
      approvalAuditEventId: '123e4567-e89b-42d3-a456-426614174003',
      decisionAuditEventId: '123e4567-e89b-42d3-a456-426614174004',
      decisionId: '123e4567-e89b-42d3-a456-426614174005',
      approvalVersion: 1,
    },
    identity: {
      issuer: ISSUER,
      audience: AUDIENCE,
      requesterSubject: 'tenant/requester',
      reviewerSubject: 'tenant/reviewer',
      requesterAssurance: 'multi_factor',
      reviewerAssurance: 'hardware',
      oldKid: 'old-key',
      newKid: null,
      overlapOldAssertionSha256: null,
      newAssertionSha256: null,
      keysetGenerations: [7],
    },
    ceremony: {
      proposalAuditEventId: '123e4567-e89b-42d3-a456-426614174002',
      approvalAuditEventId: '123e4567-e89b-42d3-a456-426614174003',
      decisionAuditEventId: '123e4567-e89b-42d3-a456-426614174004',
      proposeStatus: 200,
      proposeOperation: 'plugin-package.propose',
      selfDecisionStatus: 403,
      selfDecisionError: 'forbidden',
      reviewerDecisionStatus: 200,
      reviewerDecisionOperation: 'plugin-package.decide',
      inspectionStatus: 200,
      inspectionOperation: 'plugin-package.inspect',
    },
    isolation: exactIsolation(),
    rotation: {
      overlapOldStatus: null,
      newStatus: null,
      revokedOldStatus: null,
      revokedOldError: null,
      previousTlsSerial: 'A1',
      currentTlsSerial: null,
      previousTlsSecretResourceVersion: 'tls-1',
      currentTlsSecretResourceVersion: null,
      readinessSamples: [
        {
          phase: 'before',
          replicas: 2,
          readyReplicas: 2,
          unavailableReplicas: 0,
          tlsProtocol: 'TLSv1.3',
        },
      ],
    },
    stateSha256: '',
  };
  state.stateSha256 = stateDigest(state);
  state.identity.requesterSubject = 'tampered';
  assert.throws(
    () => validateState(state, 'before'),
    PluginPackageManagementLiveExerciseError,
  );
  await assert.rejects(
    revokedPhase(
      {
        endpoint: state.endpoint,
        state,
        oldAssertion: 'invalid',
        newAssertion: 'invalid',
        nowMs: NOW,
      },
      { async snapshot() {} },
    ),
    PluginPackageManagementLiveExerciseError,
  );
});

test('probe Pods are tokenless, non-root, bounded and carry only public probe arguments', () => {
  const pod = probePod(
    'probe-a',
    `registry.example/qinglong3@sha256:${'2'.repeat(64)}`,
    'IfNotPresent',
    [],
    { 'qinglong.io/plugin-package-management-client': 'true' },
    [
      'tls',
      'service.namespace.svc',
      '8443',
      'connected',
      'service.namespace.svc',
    ],
  );
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.securityContext.runAsNonRoot, true);
  assert.deepEqual(pod.spec.containers[0].securityContext.capabilities.drop, [
    'ALL',
  ]);
  assert.equal(
    pod.spec.containers[0].securityContext.readOnlyRootFilesystem,
    true,
  );
  assert.equal(pod.spec.containers[0].resources.limits.memory, '64Mi');
  assert.doesNotMatch(JSON.stringify(pod), /assertion|authorization|bearer/i);
});

test('cleans only probe Pods created by the current exercise', async () => {
  const deleted = [];
  let creates = 0;
  await assert.rejects(
    () =>
      ingressProbes(
        {
          run(args) {
            if (args[0] === 'create') {
              creates += 1;
              if (creates === 2) throw new Error('name already exists');
              return { status: 0, stdout: '', stderr: '' };
            }
            if (args.includes('delete')) {
              deleted.push(args[4]);
              return { status: 0, stdout: '', stderr: '' };
            }
            assert.fail(`unexpected kubectl operation: ${args.join(' ')}`);
          },
        },
        {
          pods: [{ ip: '10.0.0.10' }],
          image: `registry.example/qinglong3@sha256:${'2'.repeat(64)}`,
          imagePullPolicy: 'IfNotPresent',
          imagePullSecrets: [],
        },
        '123e4567-e89b-42d3-a456-426614174000',
      ),
    /name already exists/,
  );
  assert.deepEqual(deleted, ['ql3-management-evidence-123e4567-allowed']);
});
