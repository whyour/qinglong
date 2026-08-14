const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  LOCAL_MCP_SERVER_CONFIG_SCHEMA,
} = require('@qinglong/local-mcp-server/config');
const {
  openProductionLocalMcpServer,
} = require('@qinglong/local-mcp-server/process');

test('opens one bounded database authority and reuses production authentication per server call', async () => {
  const config = Object.freeze({
    schema: LOCAL_MCP_SERVER_CONFIG_SCHEMA,
    profile: 'edge',
    projectId: 'default',
    deploymentRoot: '/srv/qinglong',
    databasePath: '/srv/qinglong/data/qinglong3.sqlite',
    artifactRoot: '/srv/qinglong/artifacts',
    ownerPepperKeyringDirectory: '/srv/qinglong/owner-peppers',
    credentialFilePath: '/srv/qinglong/operator/credential.json',
    busyTimeoutMs: 250,
  });
  const calls = [];
  let closes = 0;
  const database = {
    projectPolicy: {
      async resolve() {
        return null;
      },
    },
    securityAudit: { async record() {} },
    runs: {
      async listRunsByProject() {
        return [];
      },
      async findRunById() {
        return null;
      },
      async findAttemptById() {
        return null;
      },
      async listEvents() {
        return [];
      },
    },
    runAttemptLogRetention: {
      async inspect() {
        return { status: 'active' };
      },
    },
    stepRuns: {
      async listByRun() {
        return { stepRuns: [], truncated: false };
      },
    },
    taskDefinitions: {
      async findCurrentTaskDefinition() {
        return null;
      },
      async listTaskDefinitions() {
        return { definitions: [], truncated: false };
      },
    },
    triggers: {
      async listTriggers() {
        return { triggers: [], truncated: false };
      },
    },
    approvals: {
      async listApprovalRequests() {
        return { requests: [], truncated: false };
      },
      async getApprovalRequestDetail() {
        return null;
      },
    },
    apiCredentials: {
      async resolve() {
        return null;
      },
    },
    ownerPepper: {
      async resolveKey() {
        return null;
      },
    },
    async close() {
      closes += 1;
    },
  };
  const active = await openProductionLocalMcpServer(
    { configFilePath: '/srv/qinglong/mcp.json' },
    {
      readConfig(filePath) {
        calls.push(['config', filePath]);
        return config;
      },
      async openDatabase(options) {
        calls.push(['database', options]);
        return database;
      },
      async authenticate(_database, options) {
        calls.push(['authenticate', options]);
        return null;
      },
    },
  );
  assert.equal(active.createServer().constructor.name, 'McpServer');
  assert.deepEqual(calls, [
    ['config', '/srv/qinglong/mcp.json'],
    [
      'database',
      {
        databasePath: '/srv/qinglong/data/qinglong3.sqlite',
        profile: 'edge',
        busyTimeoutMs: 250,
      },
    ],
  ]);
  await active.close();
  await active.close();
  assert.equal(closes, 1);
});
