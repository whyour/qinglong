const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  createLocalApprovalCommandRunner,
} = require('@qinglong/local-owner-cli/approval-command');
const {
  createApprovalDecisionService,
} = require('@qinglong/runtime-core/approval-decision');
const {
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');

const ACTION = Object.freeze({
  permission: 'run.start',
  actionType: 'tool.invoke',
  actionRef: 'tool:run-task-1',
  actionDigest: 'a'.repeat(64),
  previewDigest: 'b'.repeat(64),
});
const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'owner-1' }),
  authenticationId: 'local_approval:auth-1',
  authenticatedAtMs: 1_500,
  expiresAtMs: 20_000,
  assurance: 'local_console',
});
const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 1 });

function pending() {
  return createApprovalRequest({
    id: 'approval-1',
    projectId: 'default',
    action: ACTION,
    risk: 'high',
    decisionMode: 'separation_of_duty',
    requestedBy: { type: 'agent', id: 'agent-1' },
    requestedAtMs: 1_000,
    expiresAtMs: 10_000,
    requestFence: FENCE,
  });
}

function options(root) {
  return {
    deploymentRoot: root,
    databasePath: path.join(root, 'qinglong3.sqlite'),
    profile: 'edge',
    ownerPepperKeyringDirectory: path.join(root, 'owner-keys'),
    credentialFilePath: path.join(root, 'credential.json'),
  };
}

function writeCommand(root, name, operation, request) {
  const filePath = path.join(root, name);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ schemaVersion: 1, operation, options: options(root), request }),
    { mode: 0o600 },
  );
  return filePath;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-approval-command-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let current = pending();
  const audits = [];
  let closes = 0;
  let confirms = 0;
  let activations = 0;
  const database = {
    profile: 'edge',
    readiness: {},
    apiCredentials: {},
    ownerPepper: {},
    projectPolicy: {
      async resolve(projectId, subject) {
        return {
          project: {
            id: projectId,
            name: 'Default',
            slug: 'default',
            status: 'active',
            version: 1,
            createdAtMs: 0,
            updatedAtMs: 1,
          },
          binding: {
            projectId,
            subject,
            version: 1,
            state: 'active',
            role: 'owner',
            mutationId: 'grant-owner-1',
            changedBy: { type: 'user', id: 'owner-1' },
            createdAtMs: 1,
          },
        };
      },
      async append() {
        throw new Error('not used');
      },
    },
    approvals: {
      async findById(id) {
        return id === current.id ? current : null;
      },
      async decide(command) {
        const { requestId: _requestId, audit: _audit, ...decision } = command;
        current = decideApprovalRequest(current, decision);
        return { status: 'decided', request: current };
      },
    },
    approvalDetails: {
      async getApprovalRequestDetail({ projectId, requestId }) {
        if (projectId !== current.projectId || requestId !== current.id) return null;
        return {
          request: current,
          preview: {
            title: 'Run task',
            summary: 'Runs one reviewed task.',
            fields: [{ kind: 'identifier', label: 'Task', value: 'task-1' }],
            warnings: ['external_effect'],
          },
        };
      },
    },
    securityAudit: {
      async record(record) {
        audits.push(record);
      },
    },
    activateUserCredentialFence() {
      activations += 1;
    },
    confirmUserCredentialFence() {
      confirms += 1;
    },
    async close() {
      closes += 1;
    },
  };
  const authenticated = {
    principal: PRINCIPAL,
    databaseFence: {
      credentialId: 'owner-credential',
      credentialVersion: 1,
      pepperKeyId: 'owner-pepper',
      materialDigest: 'c'.repeat(64),
      subjectType: 'user',
      subjectId: 'owner-1',
      secretDigest: 'd'.repeat(64),
      notBeforeAtMs: 1_000,
      expiresAtMs: 20_000,
    },
    async confirm() {
      confirms += 1;
    },
  };
  const runner = createLocalApprovalCommandRunner({
    async openDatabase() {
      return database;
    },
    async authenticate() {
      return authenticated;
    },
    createDecisionService: createApprovalDecisionService,
    now: () => 2_000,
  });
  return {
    root,
    runner,
    state: () => ({ current, audits, closes, confirms, activations }),
  };
}

function baseRequest() {
  return {
    projectId: 'default',
    approvalRequestId: 'approval-1',
    requestId: 'owner-command-1',
    auditEventId: '20000000-0000-4000-8000-000000000001',
    failureAuditEventId: '20000000-0000-4000-8000-000000000002',
  };
}

test('inspects the exact action binding and bounded preview before decision', async (t) => {
  const value = fixture(t);
  const result = await value.runner.run(
    writeCommand(value.root, 'inspect.json', 'approval.inspect', baseRequest()),
  );
  assert.equal(result.found, true);
  assert.deepEqual(result.expectedAction, ACTION);
  assert.equal(result.preview.title, 'Run task');
  assert.equal(value.state().audits[0].operationId, 'approval.inspect');
  assert.equal(value.state().audits[0].outcome, 'allowed');
  assert.equal(value.state().closes, 1);
});

test('decides only the inspected action and returns a durable receipt', async (t) => {
  const value = fixture(t);
  const result = await value.runner.run(
    writeCommand(value.root, 'decide.json', 'approval.decide', {
      ...baseRequest(),
      expectedVersion: 1,
      expectedAction: ACTION,
      decisionId: 'decision-1',
      decision: 'approved',
      reasonCode: 'reviewed',
    }),
  );
  assert.equal(result.status, 'decided');
  assert.equal(result.state, 'approved');
  assert.deepEqual(result.action, ACTION);
  assert.equal(value.state().current.decidedBy.id, 'owner-1');
  assert.equal(value.state().audits.length, 0);
  assert.equal(value.state().activations, 1);
  assert.ok(value.state().confirms >= 3);
  assert.equal(value.state().closes, 1);
});

test('records a denied failure audit when the reviewed binding drifts', async (t) => {
  const value = fixture(t);
  await assert.rejects(
    value.runner.run(
      writeCommand(value.root, 'drift.json', 'approval.decide', {
        ...baseRequest(),
        expectedVersion: 1,
        expectedAction: { ...ACTION, previewDigest: 'e'.repeat(64) },
        decisionId: 'decision-1',
        decision: 'approved',
        reasonCode: 'reviewed',
      }),
    ),
  );
  assert.equal(value.state().current.state, 'pending');
  assert.equal(value.state().audits.length, 1);
  assert.equal(value.state().audits[0].outcome, 'denied');
  assert.deepEqual(value.state().audits[0].reasons, ['approval_binding_conflict']);
  assert.equal(value.state().closes, 1);
});
