const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { test } = require('node:test');

const {
  ClusterPluginPackageIdentityAssertionAuthenticationError,
  ClusterPluginPackageIdentityAssertionConfigurationError,
  createClusterPluginPackageIdentityAssertionVerifier,
} = require('@qinglong/cluster-admin/plugin-package-identity-assertion');
const {
  createClusterPluginPackageManagementTransport,
} = require('@qinglong/cluster-admin/plugin-package-management-transport');

const NOW = 1_700_000_000_000;
const ISSUER = 'https://identity.example.test/ql3';
const AUDIENCE = 'qinglong3-plugin-package-management';
const PURPOSE = 'plugin-package-management';
const TYPE = 'ql3-plugin-package-management+jwt';

function reviewedKey(algorithm = 'EdDSA', kid = 'identity-key-1') {
  const pair =
    algorithm === 'RS256'
      ? generateKeyPairSync('rsa', {
          modulusLength: 2048,
          publicExponent: 0x10001,
        })
      : algorithm === 'ES256'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : generateKeyPairSync('ed25519');
  return {
    algorithm,
    kid,
    privateKey: pair.privateKey,
    publicJwk: {
      ...pair.publicKey.export({ format: 'jwk' }),
      kid,
      use: 'sig',
      alg: algorithm,
    },
  };
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function assertion(key, claimOverrides = {}, headerOverrides = {}) {
  const header = {
    typ: TYPE,
    alg: key.algorithm,
    kid: key.kid,
    ...headerOverrides,
  };
  const claims = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'cluster-reviewer',
    jti: 'assertion-session-1',
    iat: NOW / 1_000 - 10,
    auth_time: NOW / 1_000 - 20,
    exp: NOW / 1_000 + 120,
    acr: 'urn:example:assurance:mfa',
    amr: ['pwd', 'otp'],
    ql3_purpose: PURPOSE,
    ...claimOverrides,
  };
  const protectedSegment = encode(header);
  const payloadSegment = encode(claims);
  const signed = Buffer.from(`${protectedSegment}.${payloadSegment}`, 'ascii');
  const signature =
    key.algorithm === 'EdDSA'
      ? sign(null, signed, key.privateKey)
      : key.algorithm === 'ES256'
      ? sign('sha256', signed, {
          key: key.privateKey,
          dsaEncoding: 'ieee-p1363',
        })
      : sign('RSA-SHA256', signed, key.privateKey);
  return `${protectedSegment}.${payloadSegment}.${signature.toString(
    'base64url',
  )}`;
}

function verifier(key, overrides = {}) {
  return createClusterPluginPackageIdentityAssertionVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    keys: [key.publicJwk],
    assuranceMappings: [
      {
        acr: 'urn:example:assurance:mfa',
        assurance: 'multi_factor',
        requiredAmr: ['pwd', 'otp'],
      },
      {
        acr: 'urn:example:assurance:hardware',
        assurance: 'hardware',
        requiredAmr: ['fido', 'hwk'],
      },
    ],
    now: () => NOW,
    ...overrides,
  });
}

function fakeManagementService() {
  const calls = [];
  return {
    calls,
    service: {
      async propose(request) {
        calls.push(request);
        return {
          proposalStatus: 'created',
          approvalStatus: 'created',
          proposal: {
            actionRef: request.actionRef,
            projectId: 'default',
            actionInput: request.actionInput,
            actionDigest: 'a'.repeat(64),
            previewDigest: 'b'.repeat(64),
            proposalDigest: 'c'.repeat(64),
            createdAtMs: request.requestedAtMs,
          },
          approvalRequest: {
            id: request.approvalRequestId,
            projectId: 'default',
            version: 1,
            state: 'pending',
            action: {
              actionDigest: 'a'.repeat(64),
              previewDigest: 'b'.repeat(64),
            },
            risk: 'high',
            decisionMode: 'separation_of_duty',
            requestedAtMs: request.requestedAtMs,
            expiresAtMs: request.requestedAtMs + 60_000,
            decision: null,
            decisionReasonCode: null,
            decidedAtMs: null,
            dispatchId: null,
            consumedAtMs: null,
          },
        };
      },
      async decide() {
        throw new Error('not used');
      },
      async inspect() {
        return { proposal: null, approvalRequest: null };
      },
      async inspectAuthorized() {
        return { proposal: null, approvalRequest: null };
      },
      async inspectInstallationAuthorized() {
        return null;
      },
      async listInstallationsAuthorized() {
        return { items: [], truncated: false };
      },
    },
  };
}

function proposeCommand() {
  return {
    schemaVersion: 1,
    operation: 'plugin-package.propose',
    request: {
      actionRef: 'package:cluster-monitor:1',
      approvalRequestId: 'approval-cluster-monitor-1',
      proposalAuditEventId: 'proposal-audit-1',
      approvalAuditEventId: 'approval-audit-1',
      actionInput: {
        manifest: {
          metadata: { name: 'cluster-monitor', version: '1.0.0' },
        },
        plan: { operation: 'install' },
        source: { kind: 'registry' },
        architecture: 'arm64',
        deploymentProfile: 'cluster',
        targetGeneration: 1,
      },
    },
  };
}

test('verifies a dedicated assertion and injects no raw token identity into management', async () => {
  const key = reviewedKey();
  const token = assertion(key);
  const identity = verifier(key);
  const principal = identity.verify(token);
  const expectedAuthenticationId = `ql3oidc.${createHash('sha256')
    .update(ISSUER)
    .update('\0')
    .update('assertion-session-1')
    .digest('base64url')}`;
  assert.deepEqual(principal, {
    subject: { type: 'user', id: 'cluster-reviewer' },
    authenticationId: expectedAuthenticationId,
    authenticatedAtMs: NOW - 20_000,
    expiresAtMs: NOW + 120_000,
    assurance: 'multi_factor',
  });

  const fixture = fakeManagementService();
  const transport = createClusterPluginPackageManagementTransport({
    service: fixture.service,
    now: () => NOW,
  });
  const result = await transport.execute(
    proposeCommand(),
    identity.bind(token),
  );
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls[0].principal, principal);
  const serialized = JSON.stringify({ result, request: fixture.calls[0] });
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes('assertion-session-1'), false);
});

test('keeps Plugin Package and Worker credential assertion purposes disjoint', () => {
  const key = reviewedKey();
  const workerAudience = 'qinglong3-worker-credential-management';
  const workerProfile = {
    type: 'ql3-worker-credential-management+jwt',
    purpose: 'worker-credential-management',
  };
  const workerToken = assertion(
    key,
    {
      aud: workerAudience,
      ql3_purpose: workerProfile.purpose,
    },
    { typ: workerProfile.type },
  );
  const workerVerifier = verifier(key, {
    audience: workerAudience,
    assertionProfile: workerProfile,
  });

  assert.equal(
    workerVerifier.verify(workerToken).subject.id,
    'cluster-reviewer',
  );
  assert.throws(
    () => verifier(key).verify(workerToken),
    ClusterPluginPackageIdentityAssertionAuthenticationError,
  );
  assert.throws(
    () => workerVerifier.verify(assertion(key)),
    ClusterPluginPackageIdentityAssertionAuthenticationError,
  );
});

test('accepts reviewed EdDSA, ES256 and RS256 key algorithms', () => {
  for (const algorithm of ['EdDSA', 'ES256', 'RS256']) {
    const key = reviewedKey(algorithm, `key-${algorithm}`);
    assert.equal(
      verifier(key).verify(assertion(key)).subject.id,
      'cluster-reviewer',
    );
  }
});

test('maps hardware only through an exact ACR and complete AMR rule', () => {
  const key = reviewedKey();
  const identity = verifier(key);
  const hardware = identity.verify(
    assertion(key, {
      acr: 'urn:example:assurance:hardware',
      amr: ['fido', 'hwk'],
    }),
  );
  assert.equal(hardware.assurance, 'hardware');
  assert.throws(
    () =>
      identity.verify(
        assertion(key, {
          acr: 'urn:example:assurance:hardware',
          amr: ['fido'],
        }),
      ),
    ClusterPluginPackageIdentityAssertionAuthenticationError,
  );
});

test('rejects signature, algorithm, key and dedicated-token confusion', () => {
  const key = reviewedKey();
  const other = reviewedKey('EdDSA', 'identity-key-2');
  const identity = verifier(key);
  const valid = assertion(key);
  const tampered = `${valid.slice(0, -1)}${valid.endsWith('A') ? 'B' : 'A'}`;
  for (const candidate of [
    tampered,
    assertion(other),
    assertion(key, {}, { typ: 'JWT' }),
    assertion(key, {}, { alg: 'RS256' }),
    assertion(key, { unexpected_claim: 'must-fail-closed' }),
    `${valid}.extra`,
    'a'.repeat(9 * 1_024),
  ]) {
    assert.throws(
      () => identity.verify(candidate),
      ClusterPluginPackageIdentityAssertionAuthenticationError,
    );
  }
});

test('rejects wrong trust domain, inactive lifetime and weak assurance facts', () => {
  const key = reviewedKey();
  const identity = verifier(key);
  for (const overrides of [
    { iss: 'https://other.example.test/ql3' },
    { aud: 'another-service' },
    { ql3_purpose: 'cluster-control' },
    { exp: NOW / 1_000 },
    { iat: NOW / 1_000 + 10 },
    { auth_time: NOW / 1_000 - 301 },
    { exp: NOW / 1_000 + 301 },
    { acr: 'urn:example:assurance:single-factor', amr: ['pwd'] },
    { acr: 'urn:example:assurance:mfa', amr: ['pwd'] },
  ]) {
    assert.throws(
      () => identity.verify(assertion(key, overrides)),
      ClusterPluginPackageIdentityAssertionAuthenticationError,
    );
  }
});

test('rejects unreviewed configuration before accepting any assertion', () => {
  const key = reviewedKey();
  const weakRsa = reviewedKey('RS256', 'weak-rsa');
  const weakRsaPair = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicExponent: 0x10001,
  });
  weakRsa.publicJwk = {
    ...weakRsaPair.publicKey.export({ format: 'jwk' }),
    kid: weakRsa.kid,
    use: 'sig',
    alg: weakRsa.algorithm,
  };
  const privateJwk = {
    ...key.privateKey.export({ format: 'jwk' }),
    kid: key.kid,
    use: 'sig',
    alg: key.algorithm,
  };
  for (const overrides of [
    { issuer: 'http://identity.example.test/ql3' },
    { keys: [] },
    { keys: [key.publicJwk, key.publicJwk] },
    { keys: [privateJwk] },
    { keys: [weakRsa.publicJwk] },
    {
      assuranceMappings: [
        {
          acr: 'urn:example:assurance:mfa',
          assurance: 'single_factor',
          requiredAmr: ['pwd'],
        },
      ],
    },
    { maxAssertionBytes: 32 * 1024 },
    { maxLifetimeMs: 60 * 60_000 },
    { clockSkewMs: 120_000 },
    {
      assertionProfile: {
        type: 'JWT',
        purpose: 'worker-credential-management',
      },
    },
    {
      assertionProfile: {
        type: 'ql3-worker-credential-management+jwt',
        purpose: 'Worker Credential Management',
      },
    },
  ]) {
    assert.throws(
      () => verifier(key, overrides),
      ClusterPluginPackageIdentityAssertionConfigurationError,
    );
  }
});
