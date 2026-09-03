const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createPanelBootstrapRoute,
  panelCapabilities,
  panelPublicResponse,
} = require('../dist/panel-compatibility/panelBootstrapRoute.js');

const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'owner' }),
  authenticationId: 'auth:owner',
  authenticatedAtMs: 1_787_200_000_000,
  expiresAtMs: 1_787_200_060_000,
  assurance: 'local_console',
});

test('publishes an exact profile-aware capability contract', () => {
  const edge = panelCapabilities('edge');
  const standalone = panelCapabilities('standalone');
  assert.deepEqual(edge, {
    schemaVersion: 1,
    product: 'qinglong3',
    version: '3.0.0-alpha.2',
    deployment: { mode: 'local', profile: 'edge' },
    authentication: {
      kind: 'api_credential',
      transport: 'bearer',
      persistence: 'memory_only',
      loginEndpoint: null,
    },
    project: { selection: 'explicit', defaultId: 'default' },
    panel: {
      bootstrap: true,
      cronList: 'bounded_read_only',
      runControl: 'task_run_v1',
      taskRead: true,
      triggerRead: true,
      runRead: true,
      runLogRead: true,
      legacyMutations: false,
      legacyLogin: false,
      subscriptions: false,
      scripts: false,
      environmentVariables: false,
      webSocket: false,
    },
    limits: {
      cronRows: 64,
      cronPageSize: 64,
      logChunkBytes: 16 * 1_024,
    },
  });
  assert.deepEqual(standalone.limits, {
    cronRows: 256,
    cronPageSize: 64,
    logChunkBytes: 32 * 1_024,
  });
  assert.throws(() => panelCapabilities('cluster'));
});

test('serves public health, system and native capability envelopes', () => {
  assert.deepEqual(panelPublicResponse('health', 'edge'), {
    statusCode: 200,
    body: {
      code: 200,
      data: {
        status: 'ok',
        ql3: {
          schemaVersion: 1,
          apiVersion: 'v3',
          capabilitiesPath: '/api/v3/capabilities',
        },
      },
    },
  });
  const system = panelPublicResponse('system', 'standalone');
  assert.equal(system.body.code, 200);
  assert.equal(system.body.data.isInitialized, true);
  assert.equal(system.body.data.version, '3.0.0-alpha.2');
  assert.equal(system.body.data.ql3.profile, 'standalone');
  const capabilities = panelPublicResponse('capabilities', 'edge');
  assert.equal(capabilities.body.capabilities.limits.cronRows, 64);
});

test('projects the authenticated principal and bounded panel configuration', async () => {
  const route = createPanelBootstrapRoute('edge');
  const user = await route.handle({
    operationId: 'panel.user.get',
    principal: PRINCIPAL,
  });
  assert.deepEqual(user, {
    statusCode: 200,
    body: {
      code: 200,
      data: {
        username: 'owner',
        ql3: {
          schemaVersion: 1,
          subjectType: 'user',
          assurance: 'local_console',
          expiresAtMs: 1_787_200_060_000,
          credentialPersistence: 'memory_only',
          panelHome: '/crontab',
        },
      },
    },
  });
  const config = await route.handle({
    operationId: 'panel.system.config.get',
    principal: PRINCIPAL,
  });
  assert.equal(config.statusCode, 200);
  assert.deepEqual(config.body.data.info, {
    panelTitle: 'QingLong 3.0',
    lang: 'zh-cn',
  });
  assert.equal(config.body.data.ql3.limits.cronRows, 64);
});

test('fails closed for invalid profile, principal and operation', async () => {
  assert.throws(() => createPanelBootstrapRoute('cluster'));
  const route = createPanelBootstrapRoute('standalone');
  assert.equal(
    (await route.handle({ operationId: 'panel.user.get', principal: null }))
      .statusCode,
    503,
  );
  assert.equal(
    (
      await route.handle({
        operationId: 'panel.user.get',
        principal: {
          ...PRINCIPAL,
          subject: { type: 'api_app', id: 'service' },
          assurance: 'service',
        },
      })
    ).statusCode,
    503,
  );
  assert.equal(
    (
      await route.handle({
        operationId: 'panel.unknown',
        principal: PRINCIPAL,
      })
    ).statusCode,
    503,
  );
});
