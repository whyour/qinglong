const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerCredentialDeliveryUnavailableError,
} = require('@qinglong/runtime-core/worker-credential-delivery');
const {
  WORKER_CREDENTIAL_KUBERNETES_TOKEN_REQUEST_SECONDS,
  WorkerCredentialKubernetesTokenRequestUnavailableError,
  createWorkerCredentialKubernetesTokenRequestSession,
} = require(
  '@qinglong/cluster-admin/worker-credential-kubernetes-token-request'
);

const NOW_MS = 1_800_000_000_000;
const DELIVERY = Object.freeze({
  clusterIdentity: 'cluster-production-a',
  stageNamespace: 'qinglong-worker-a-stage',
  namespace: 'qinglong-worker-a',
  targetSecretName: 'worker-a-credential',
  targetDeploymentName: 'worker-a',
  targetDataKey: 'credential-token',
});

function segment(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function jwt(overrides = {}) {
  const issuedAt = Math.floor(NOW_MS / 1_000);
  const header = { alg: 'RS256', typ: 'JWT', ...(overrides.header ?? {}) };
  const claims = {
    sub:
      'system:serviceaccount:qinglong-worker-a-stage:' +
      'ql3-worker-credential-admin',
    iat: issuedAt,
    exp: issuedAt + WORKER_CREDENTIAL_KUBERNETES_TOKEN_REQUEST_SECONDS,
    aud: ['https://kubernetes.default.svc'],
    ...(overrides.claims ?? {}),
  };
  return `${segment(header)}.${segment(claims)}.${Buffer.from('signature').toString('base64url')}`;
}

function permission(attributes) {
  if (
    attributes.namespace === DELIVERY.stageNamespace &&
    attributes.resource === 'secrets'
  ) {
    return ['get', 'list', 'create', 'delete'].includes(attributes.verb);
  }
  if (
    attributes.namespace === DELIVERY.namespace &&
    attributes.resource === 'secrets' &&
    attributes.name === DELIVERY.targetSecretName
  ) {
    return ['get', 'update'].includes(attributes.verb);
  }
  return attributes.namespace === DELIVERY.namespace &&
    attributes.group === 'apps' &&
    attributes.resource === 'deployments' &&
    attributes.name === DELIVERY.targetDeploymentName &&
    ['get', 'update'].includes(attributes.verb);
}

function issuerPermission(attributes) {
  return attributes.namespace === DELIVERY.stageNamespace &&
    attributes.verb === 'create' &&
    attributes.resource === 'serviceaccounts' &&
    attributes.subresource === 'token' &&
    attributes.name === 'ql3-worker-credential-admin';
}

function fixture(options = {}) {
  const value = options.token ?? jwt();
  const issuedAt = Math.floor(NOW_MS / 1_000);
  const response = {
    apiVersion: 'authentication.k8s.io/v1',
    kind: 'TokenRequest',
    status: {
      token: value,
      expirationTimestamp:
        options.expirationTimestamp ??
        new Date(
          (issuedAt + WORKER_CREDENTIAL_KUBERNETES_TOKEN_REQUEST_SECONDS) *
          1_000,
        ),
    },
  };
  const requests = [];
  const receivedTokens = [];
  let active = false;
  let disposals = 0;
  const tokenRequests = {
    async createNamespacedServiceAccountToken(request) {
      requests.push(structuredClone(request));
      if (options.requestError) throw new Error('sensitive upstream failure');
      return response;
    },
  };
  const issuerAuthorization = {
    async createSelfSubjectAccessReview(request) {
      return {
        status: {
          allowed: options.issuerOverbroad === true
            ? true
            : issuerPermission(request.body.spec.resourceAttributes),
        },
      };
    },
  };
  const createRestrictedClients = (token) => {
    receivedTokens.push(token);
    active = true;
    const assertActive = () => {
      if (!active) {
        throw Object.assign(new Error('disposed credential'), { code: 401 });
      }
    };
    return {
      secrets: {
        async readNamespacedSecret() { assertActive(); throw Object.assign(new Error('absent'), { code: 404 }); },
        async createNamespacedSecret() { assertActive(); throw new Error('unused'); },
        async replaceNamespacedSecret() { assertActive(); throw new Error('unused'); },
        async deleteNamespacedSecret() { assertActive(); throw new Error('unused'); },
        async listNamespacedSecret() { assertActive(); return { items: [] }; },
      },
      deployments: {
        async readNamespacedDeployment() { assertActive(); throw new Error('unused'); },
        async replaceNamespacedDeployment() { assertActive(); throw new Error('unused'); },
      },
      authorization: {
        async createSelfSubjectAccessReview(request) {
          assertActive();
          return {
            status: {
              allowed: options.overbroad === true
                ? true
                : permission(request.body.spec.resourceAttributes),
            },
          };
        },
      },
      dispose() {
        disposals += 1;
        active = false;
        if (options.disposeError) throw new Error('sensitive dispose failure');
      },
    };
  };
  const session = createWorkerCredentialKubernetesTokenRequestSession(
    tokenRequests,
    issuerAuthorization,
    createRestrictedClients,
    {
      serviceAccountName: 'ql3-worker-credential-admin',
      identitySecretName: 'worker-a-identity',
      delivery: DELIVERY,
      now: () => NOW_MS,
    },
  );
  return {
    session,
    response,
    requests,
    receivedTokens,
    get active() { return active; },
    get disposals() { return disposals; },
  };
}

test('mints one bounded token, proves exact RBAC and disposes retained clients', async () => {
  const state = fixture();
  let retained;
  const result = await state.session.withDelivery(async (context) => {
    retained = context.delivery;
    assert.deepEqual(context.evidence, {
      tokenLifetimeSeconds: 600,
      issuerAllowedChecks: 1,
      issuerDeniedChecks: 8,
      allowedChecks: 8,
      deniedChecks: 20,
    });
    assert.match(context.delivery.deploymentTargetDigest, /^[0-9a-f]{64}$/);
    return 'published';
  });
  assert.equal(result, 'published');
  assert.deepEqual(state.requests, [{
    name: 'ql3-worker-credential-admin',
    namespace: DELIVERY.stageNamespace,
    body: {
      apiVersion: 'authentication.k8s.io/v1',
      kind: 'TokenRequest',
      spec: { expirationSeconds: 600 },
    },
  }]);
  assert.equal(state.receivedTokens.length, 1);
  assert.equal(state.response.status.token, '');
  assert.equal(state.disposals, 1);
  assert.equal(state.active, false);
  await assert.rejects(
    retained.inspect('123e4567-e89b-42d3-a456-426614174901'),
    WorkerCredentialDeliveryUnavailableError,
  );
  state.receivedTokens[0] = '';
});

test('rejects an overbroad delivery token before invoking credential work', async () => {
  const state = fixture({ overbroad: true });
  let invoked = false;
  await assert.rejects(
    state.session.withDelivery(async () => {
      invoked = true;
    }),
    WorkerCredentialKubernetesTokenRequestUnavailableError,
  );
  assert.equal(invoked, false);
  assert.equal(state.response.status.token, '');
  assert.equal(state.disposals, 1);
  assert.equal(state.active, false);
  state.receivedTokens[0] = '';
});

test('rejects an overbroad token issuer before requesting a token', async () => {
  const state = fixture({ issuerOverbroad: true });
  await assert.rejects(
    state.session.withDelivery(async () => undefined),
    WorkerCredentialKubernetesTokenRequestUnavailableError,
  );
  assert.equal(state.requests.length, 0);
  assert.equal(state.receivedTokens.length, 0);
  assert.equal(state.disposals, 0);
});

test('rejects malformed, wrong-subject and overlong token responses before client creation', async () => {
  const issuedAt = Math.floor(NOW_MS / 1_000);
  const cases = [
    { token: 'not-a-jwt' },
    { token: jwt({ header: { alg: 'none' } }) },
    { token: jwt({ claims: { sub: 'system:serviceaccount:other:other' } }) },
    { token: jwt({ claims: { exp: issuedAt + 601 } }), expirationTimestamp: new Date((issuedAt + 601) * 1_000) },
    { token: jwt(), expirationTimestamp: new Date((issuedAt + 599) * 1_000) },
  ];
  for (const value of cases) {
    const state = fixture(value);
    await assert.rejects(
      state.session.withDelivery(async () => undefined),
      WorkerCredentialKubernetesTokenRequestUnavailableError,
    );
    assert.equal(state.receivedTokens.length, 0);
    assert.equal(state.response.status.token, '');
  }
});

test('maps TokenRequest failures to a stable secret-free error', async () => {
  const state = fixture({ requestError: true });
  await assert.rejects(
    state.session.withDelivery(async () => undefined),
    (error) => {
      assert.ok(
        error instanceof WorkerCredentialKubernetesTokenRequestUnavailableError,
      );
      assert.doesNotMatch(error.message, /sensitive|upstream/i);
      return true;
    },
  );
  assert.equal(state.receivedTokens.length, 0);
});

test('fails closed when restricted client disposal fails', async () => {
  const state = fixture({ disposeError: true });
  await assert.rejects(
    state.session.withDelivery(async () => 'would-have-succeeded'),
    (error) => {
      assert.ok(
        error instanceof WorkerCredentialKubernetesTokenRequestUnavailableError,
      );
      assert.doesNotMatch(error.message, /sensitive|dispose/i);
      return true;
    },
  );
  assert.equal(state.response.status.token, '');
  assert.equal(state.disposals, 1);
  assert.equal(state.active, false);
  state.receivedTokens[0] = '';
});
