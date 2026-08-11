const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  CLUSTER_PLUGIN_PACKAGE_PROMPT_CATALOG_RESPONSE_SCHEMA,
  createClusterControlPluginPackagePromptCatalogRoute,
} = require('@qinglong/cluster-control/prompt-routes');

function authorized(body = null) {
  return {
    request: {
      requestId: '00000000-0000-4000-8000-000000000001',
      method: 'GET',
      path: '/api/v3/projects/project-1/packages/example/prompts',
      query: {},
      headers: {},
      signal: new AbortController().signal,
      body,
    },
    principal: {
      subject: { type: 'api_app', id: 'app-1' },
      authenticationId: 'credential-1',
      authenticatedAtMs: 1,
      expiresAtMs: 10_000,
      assurance: 'service',
    },
    operationId: 'prompt.read',
    permission: 'model.invoke',
    projectId: 'project-1',
    policyFence: { projectVersion: 3, bindingVersion: 7 },
  };
}

test('returns a bounded content-free Prompt catalog', async () => {
  let target;
  const route = createClusterControlPluginPackagePromptCatalogRoute({
    async inspect(projectId, packageName) {
      target = { projectId, packageName };
      return {
        schema: CLUSTER_PLUGIN_PACKAGE_PROMPT_CATALOG_RESPONSE_SCHEMA,
        projectId,
        packageName,
        found: true,
        publicationState: 'active',
        prompts: [{
          id: 'summary',
          name: 'Summary',
          description: null,
          parameters: [{ name: 'subject', description: null, required: true }],
        }],
      };
    },
  });
  assert.equal(route.operationId, 'prompt.read');
  assert.equal(route.permission, 'model.invoke');
  const result = await route.handle(authorized(), {
    projectId: 'project-1',
    packageName: 'example',
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(target, { projectId: 'project-1', packageName: 'example' });
  assert.equal(JSON.stringify(result).includes('template'), false);
});

test('rejects bodies and masks malformed or unavailable catalog state', async () => {
  let calls = 0;
  const route = createClusterControlPluginPackagePromptCatalogRoute({
    async inspect(projectId, packageName) {
      calls += 1;
      return {
        schema: CLUSTER_PLUGIN_PACKAGE_PROMPT_CATALOG_RESPONSE_SCHEMA,
        projectId: 'another-project',
        packageName,
        found: false,
        publicationState: null,
        prompts: [],
      };
    },
  });
  assert.deepEqual(
    await route.handle(authorized({ unexpected: true }), {
      projectId: 'project-1',
      packageName: 'example',
    }),
    { statusCode: 400, body: { code: 'invalid_prompt_catalog_request' } },
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    await route.handle(authorized(), {
      projectId: 'project-1',
      packageName: 'example',
    }),
    { statusCode: 503, body: { code: 'prompt_catalog_unavailable' } },
  );
});
