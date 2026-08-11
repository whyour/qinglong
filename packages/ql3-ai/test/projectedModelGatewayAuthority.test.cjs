const assert = require('node:assert/strict');
const { chmod, mkdtemp, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
  PROJECTED_MODEL_GATEWAY_AUTHORITY_SCHEMA,
  ProjectedModelGatewayAuthorityUnavailableError,
  canonicalProjectedModelGatewayAuthorityManifest,
  loadProjectedModelGatewayProviderAuthority,
} = require('../dist/model-gateway/projectedModelGatewayAuthority.js');

function manifest(overrides = {}) {
  return {
    schema: PROJECTED_MODEL_GATEWAY_AUTHORITY_SCHEMA,
    providers: [
      {
        type: 'openai-compatible',
        baseUrl: 'https://models.example.test/v1/',
        allowPlaintextLoopback: false,
        maxResponseBytes: 1048576,
      },
    ],
    projects: [
      {
        projectId: 'project-a',
        policy: {
          revision: 'policy-v1',
          allowedProviders: ['openai-compatible'],
          allowedModels: ['vendor/model-a'],
          maxInputBytes: 4096,
          maxOutputBytes: 4096,
          maxOutputTokens: 256,
          maxTotalTokens: 1024,
          maxCostMicros: null,
          priceRevision: null,
        },
      },
    ],
    ...overrides,
  };
}

async function authorityFile(value, mode = 0o440) {
  const root = await mkdtemp(join(tmpdir(), 'ql3-ai-authority-'));
  const file = join(root, 'authority.json');
  await writeFile(
    file,
    canonicalProjectedModelGatewayAuthorityManifest(value),
    { mode },
  );
  await chmod(file, mode);
  return file;
}

const credentials = Object.freeze({
  async authorizationHeader() {
    throw new Error('not invoked while loading authority');
  },
});

test('projected authority loads one canonical provider and Project policy', async () => {
  const configFile = await authorityFile(manifest());
  const authority = await loadProjectedModelGatewayProviderAuthority({
    configFile,
    credentials,
  });
  assert.deepEqual(
    authority.providers.map(({ type }) => type),
    ['openai-compatible'],
  );
  assert.deepEqual(
    await authority.policies.resolve({ projectId: 'project-a' }),
    manifest().projects[0].policy,
  );
  await assert.rejects(
    authority.policies.resolve({ projectId: 'project-b' }),
    ProjectedModelGatewayAuthorityUnavailableError,
  );
});

test('projected authority rejects provider/policy drift before network access', async () => {
  assert.throws(
    () =>
      canonicalProjectedModelGatewayAuthorityManifest(
        manifest({
          projects: [
            {
              ...manifest().projects[0],
              policy: {
                ...manifest().projects[0].policy,
                allowedProviders: ['missing-provider'],
              },
            },
          ],
        }),
      ),
    ProjectedModelGatewayAuthorityUnavailableError,
  );
});

test('projected authority rejects writable or noncanonical JSON', async () => {
  const writable = await authorityFile(manifest(), 0o640);
  await assert.rejects(
    loadProjectedModelGatewayProviderAuthority({
      configFile: writable,
      credentials,
    }),
    ProjectedModelGatewayAuthorityUnavailableError,
  );
  const root = await mkdtemp(join(tmpdir(), 'ql3-ai-authority-'));
  const noncanonical = join(root, 'authority.json');
  await writeFile(noncanonical, JSON.stringify(manifest(), null, 2), {
    mode: 0o440,
  });
  await chmod(noncanonical, 0o440);
  await assert.rejects(
    loadProjectedModelGatewayProviderAuthority({
      configFile: noncanonical,
      credentials,
    }),
    ProjectedModelGatewayAuthorityUnavailableError,
  );
});
