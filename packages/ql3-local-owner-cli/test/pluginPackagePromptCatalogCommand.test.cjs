const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  createLocalPluginPackagePromptCommandRunner,
} = require('@qinglong/local-owner-cli/plugin-package-prompt-command');
const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');

test('Local prompt.inspect reads only the redacted catalog without activating AI', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-prompt-catalog-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = pluginPackageTaskReconciliationFixture('local-prompt-catalog', {
    prompts: [{
      schema: 'qinglong/plugin-package-prompt-resource@v1',
      id: 'summary',
      name: 'Summary',
      template: 'Private {{subject}} template.',
      parameters: [{ name: 'subject', required: true }],
    }],
  });
  const publication = createInitialPluginPackageAutomationPublication(
    source.revision,
    source.registry,
    1_000,
  );
  const child = (name) => path.join(root, name);
  const commandPath = child('command.json');
  fs.writeFileSync(commandPath, JSON.stringify({
    schemaVersion: 1,
    operation: 'prompt.inspect',
    options: {
      deploymentRoot: root,
      databasePath: child('qinglong3.sqlite'),
      profile: 'edge',
      ownerPepperKeyringDirectory: child('owner-keys'),
      credentialFilePath: child('credential.json'),
    },
    request: {
      projectId: publication.target.projectId,
      packageName: publication.target.packageName,
      requestId: 'prompt-catalog-request-1',
      auditEventId: '00000000-0000-4000-8000-000000000001',
      failureAuditEventId: '00000000-0000-4000-8000-000000000002',
    },
  }), { mode: 0o600 });

  const audits = [];
  let providerLoads = 0;
  let closes = 0;
  const principal = {
    subject: { type: 'user', id: 'owner-1' },
    authenticationId: 'credential-1',
    authenticatedAtMs: 1,
    expiresAtMs: 10_000,
    assurance: 'local_console',
  };
  const runner = createLocalPluginPackagePromptCommandRunner({
    async openDatabase() {
      return {
        projectPolicy: {
          async resolve(projectId, subject) {
            return {
              project: {
                id: projectId,
                name: projectId,
                slug: projectId,
                status: 'active',
                version: 1,
                createdAtMs: 0,
                updatedAtMs: 0,
              },
              binding: {
                projectId,
                subject,
                version: 1,
                state: 'active',
                role: 'owner',
                mutationId: 'grant-owner',
                changedBy: subject,
                createdAtMs: 0,
              },
            };
          },
          async append() { throw new Error('not used'); },
        },
        automationPublications: {
          async findCurrent() { return publication; },
        },
        securityAudit: {
          async record(audit) { audits.push(audit); },
        },
        authority: { client: {} },
        async close() { closes += 1; },
      };
    },
    async authenticate() {
      return {
        principal,
        databaseFence: {},
        async confirm() {},
      };
    },
    async loadProviders() {
      providerLoads += 1;
      throw new Error('prompt.inspect must not load providers');
    },
    now: () => 2_000,
  });

  const result = await runner.run(commandPath);
  assert.equal(result.operation, 'prompt.inspect');
  assert.equal(result.found, true);
  assert.equal(result.prompts[0].id, 'summary');
  assert.equal(JSON.stringify(result).includes('Private'), false);
  assert.equal(providerLoads, 0);
  assert.equal(closes, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].operationId, 'prompt.inspect');
});
