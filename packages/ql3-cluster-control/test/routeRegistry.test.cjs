const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  CLUSTER_CONTROL_ROUTE_REGISTRY_LIMITS,
  ClusterControlRouteRegistryConfigurationError,
  ClusterControlRouteResolutionError,
  createClusterControlRouteRegistry,
  isClusterControlRouteRegistry,
} = require('@qinglong/cluster-control/routes');

function metadata(overrides = {}) {
  return Object.freeze({
    requestId: 'request-1',
    method: 'POST',
    path: '/api/v3/projects/prj_default/runs',
    query: Object.freeze({}),
    headers: Object.freeze({}),
    signal: new AbortController().signal,
    ...overrides,
  });
}

function definition(overrides = {}) {
  return {
    method: 'POST',
    path: '/api/v3/projects/{projectId}/runs',
    operationId: 'run.create',
    permission: 'run.start',
    projectParameter: 'projectId',
    handle(request, parameters) {
      return {
        statusCode: 202,
        body: {
          projectId: request.projectId,
          parameter: parameters.projectId,
        },
      };
    },
    ...overrides,
  };
}

test('compiles one immutable reviewed route and owns its Project scope', async () => {
  const source = definition({ allowedQuery: ['dry_run'] });
  const registry = createClusterControlRouteRegistry([source]);
  source.operationId = 'forged.operation';

  assert.equal(isClusterControlRouteRegistry(registry), true);
  assert.equal(isClusterControlRouteRegistry({ ...registry }), false);
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(registry.contractVersion, 1);
  assert.equal(registry.size, 1);

  const route = registry.resolve(
    metadata({ query: Object.freeze({ dry_run: Object.freeze(['true']) }) }),
  );
  assert.equal(route.operationId, 'run.create');
  assert.equal(route.permission, 'run.start');
  assert.equal(route.projectId, 'prj_default');
  assert.equal(Object.isFrozen(route), true);
  assert.deepEqual(
    await route.handle({
      request: { ...metadata(), body: { taskId: 'task-1' } },
      principal: {
        subject: { type: 'user', id: 'usr_primary' },
        authenticationId: 'session:1',
        authenticatedAtMs: 1,
        expiresAtMs: 2,
        assurance: 'multi_factor',
      },
      operationId: route.operationId,
      permission: route.permission,
      projectId: route.projectId,
      policyFence: { projectVersion: 1, bindingVersion: 1 },
    }),
    {
      statusCode: 202,
      body: { projectId: 'prj_default', parameter: 'prj_default' },
    },
  );
});

test('rejects widened, ambiguous and unbounded route definitions at startup', () => {
  const invalidSets = [
    [definition({ extra: true })],
    [definition({ path: '/api/v3/projects/{projectId}/' })],
    [definition({ path: '/api/v3/projects/%7BprojectId%7D/runs' })],
    [definition({ projectParameter: 'missing' })],
    [definition(), definition({ operationId: 'run.create' })],
    [
      definition(),
      definition({
        path: '/api/v3/projects/fixed/runs',
        operationId: 'run.create.fixed',
      }),
    ],
  ];
  for (const definitions of invalidSets) {
    assert.throws(
      () => createClusterControlRouteRegistry(definitions),
      ClusterControlRouteRegistryConfigurationError,
    );
  }

  const tooMany = Array.from(
    { length: CLUSTER_CONTROL_ROUTE_REGISTRY_LIMITS.maxRoutes + 1 },
    (_, index) =>
      definition({
        path: `/api/v3/routes/route-${index}`,
        operationId: `route.operation:${index}`,
        projectParameter: null,
      }),
  );
  assert.throws(
    () => createClusterControlRouteRegistry(tooMany),
    ClusterControlRouteRegistryConfigurationError,
  );
});

test('rejects non-canonical paths and unknown query before returning a route', () => {
  const registry = createClusterControlRouteRegistry([
    definition({ allowedQuery: ['dry_run'] }),
  ]);
  for (const path of [
    '/api/v3/projects/prj_default/runs/',
    '/api/v3/projects//runs',
    '/api/v3/projects/%2e%2e/runs',
    '/api/v3/projects/prj_default\\runs',
  ]) {
    assert.throws(
      () => registry.resolve(metadata({ path })),
      (error) =>
        error instanceof ClusterControlRouteResolutionError &&
        error.statusCode === 400 &&
        error.code === 'invalid_route_path',
    );
  }
  assert.throws(
    () =>
      registry.resolve(
        metadata({ query: Object.freeze({ debug: Object.freeze(['1']) }) }),
      ),
    (error) =>
      error instanceof ClusterControlRouteResolutionError &&
      error.code === 'invalid_route_query',
  );
  assert.equal(
    registry.resolve(metadata({ method: 'GET' })),
    null,
    'method is part of the reviewed route identity',
  );
  assert.equal(
    registry.resolve(metadata({ path: '/api/v3/projects/prj_default/tasks' })),
    null,
  );
});

test('bounds repeated query values and rejects control characters', () => {
  const registry = createClusterControlRouteRegistry([
    definition({ allowedQuery: ['cursor'] }),
  ]);
  for (const values of [
    [],
    Array.from(
      {
        length:
          CLUSTER_CONTROL_ROUTE_REGISTRY_LIMITS.maxQueryValuesPerParameter + 1,
      },
      () => 'value',
    ),
    ['unsafe\u0000value'],
    ['x'.repeat(CLUSTER_CONTROL_ROUTE_REGISTRY_LIMITS.maxQueryValueBytes + 1)],
  ]) {
    assert.throws(
      () =>
        registry.resolve(
          metadata({ query: Object.freeze({ cursor: Object.freeze(values) }) }),
        ),
      (error) =>
        error instanceof ClusterControlRouteResolutionError &&
        error.code === 'invalid_route_query',
    );
  }
});
