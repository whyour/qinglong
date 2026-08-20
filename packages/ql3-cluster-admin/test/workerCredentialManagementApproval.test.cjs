const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createClusterWorkerCredentialManagementService,
} = require('@qinglong/cluster-admin/worker-credential-management');
const {
  canonicalRemoteWorkerCapabilities,
} = require('@qinglong/runtime-core/remote-dispatch');

const REQUESTER = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'operator-a' }),
  authenticationId: 'session-operator-a',
  authenticatedAtMs: 900,
  expiresAtMs: 20_000,
  assurance: 'multi_factor',
});
const REVIEWER = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'reviewer-b' }),
  authenticationId: 'session-reviewer-b',
  authenticatedAtMs: 900,
  expiresAtMs: 20_000,
  assurance: 'hardware',
});

function sessionRow() {
  const capabilities = canonicalRemoteWorkerCapabilities({
    architecture: 'arm64',
    executors: ['remote-worker'],
    protocolVersion: '1.0.0',
    supportTier: 'tier1',
    runtimes: [{ name: 'node', version: '24.18.0' }],
  });
  return {
    observedAtMs: 2_000,
    workerId: 'worker-a',
    sessionId: '018f0f5d-7b6a-7a11-8f4d-2f7b4f477001',
    generation: 2,
    status: 'online',
    version: 5,
    capabilitiesJson: capabilities.json,
    capabilitiesHash: capabilities.hash,
    maxConcurrentRuns: 2,
    availableSlots: 1,
    registeredAtMs: 1_000,
    lastHeartbeatAtMs: 1_900,
    leaseExpiresAtMs: 3_000,
    updatedAtMs: 1_900,
  };
}

function approvalFixture() {
  const plans = new Map();
  const approvals = new Map();
  const audits = new Map();
  const queries = [];
  let releases = 0;

  const query = async (text, values = []) => {
    queries.push({ text, values });
    if (text.includes('FROM "ql3"."projects" AS project')) {
      const subjectId = values[2];
      return {
        rows: [{
          projectId: 'cluster-authority',
          projectName: 'Cluster Authority',
          projectSlug: 'cluster-authority',
          projectStatus: 'active',
          projectVersion: 3,
          projectCreatedAtMs: 1,
          projectUpdatedAtMs: 2,
          bindingProjectId: 'cluster-authority',
          bindingSubjectType: 'user',
          bindingSubjectId: subjectId,
          bindingVersion: 2,
          bindingState: 'active',
          bindingRole: 'admin',
          bindingMutationId: `binding-${subjectId}-v2`,
          bindingChangedByType: 'user',
          bindingChangedById: 'owner-a',
          bindingCreatedAtMs: 2,
        }],
        rowCount: 1,
      };
    }
    if (text.includes('SELECT plan_json')) {
      const plan = plans.get(values[0]);
      return { rows: plan ? [{ planJson: plan }] : [], rowCount: plan ? 1 : 0 };
    }
    if (text.includes('INSERT INTO "ql3"."worker_credential_management_plans"')) {
      if (plans.has(values[0])) return { rows: [], rowCount: 0 };
      plans.set(values[0], JSON.parse(values[17]));
      return { rows: [{ actionRef: values[0] }], rowCount: 1 };
    }
    if (text.includes('FROM "ql3"."approval_requests"')) {
      const stored = approvals.get(values[0]);
      return {
        rows: stored
          ? [{ requestJson: stored.request, requestDigest: stored.digest }]
          : [],
        rowCount: stored ? 1 : 0,
      };
    }
    if (text.includes('FROM "ql3"."security_audit_events"')) {
      const stored = audits.get(values[0]);
      return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 };
    }
    if (text.includes('FROM "ql3"."worker_sessions"')) {
      return { rows: [sessionRow()], rowCount: 1 };
    }
    if (text.includes('"ql3"."lock_approval_policy_fence"')) {
      return { rows: [{ matches: true }], rowCount: 1 };
    }
    if (text.includes('INSERT INTO "ql3"."approval_requests"')) {
      approvals.set(values[0], {
        request: JSON.parse(values[14]),
        digest: values[15],
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('UPDATE "ql3"."approval_requests"')) {
      const current = approvals.get(values[8]);
      if (!current || current.request.version !== values[9]) {
        return { rows: [], rowCount: 0 };
      }
      approvals.set(values[8], {
        request: JSON.parse(values[5]),
        digest: values[6],
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO "ql3"."security_audit_events"')) {
      audits.set(values[0], {
        eventId: values[0],
        requestId: values[1],
        operationId: values[2],
        projectId: values[3],
        subjectType: values[4],
        subjectId: values[5],
        authenticationId: values[6],
        outcome: values[7],
        reasonsJson: JSON.parse(values[8]),
        fenceProjectVersion: values[9],
        fenceBindingVersion: values[10],
        occurredAtMs: values[11],
      });
      return { rows: [], rowCount: 1 };
    }
    if (
      text === 'BEGIN ISOLATION LEVEL SERIALIZABLE' ||
      text === 'COMMIT' ||
      text === 'ROLLBACK' ||
      text.includes("SELECT set_config(")
    ) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected query: ${text}`);
  };

  const pool = {
    query,
    async connect() {
      return {
        query,
        release() {
          releases += 1;
        },
      };
    },
  };
  return { pool, plans, approvals, audits, queries, releases: () => releases };
}

function planRequest() {
  return {
    actionRef: 'worker-credential:worker-a:generation-2',
    authorityProjectId: 'cluster-authority',
    action: 'rotate',
    deliveryId: '123e4567-e89b-42d3-a456-426614174702',
    workerId: 'worker-a',
    credentialId: 'credential-b',
    previousCredentialId: 'credential-a',
    credentialNotBeforeAtMs: 1_000,
    credentialExpiresAtMs: 100_000,
    deploymentTargetDigest: '1'.repeat(64),
    deploymentGeneration: 'generation-2',
    principal: REQUESTER,
  };
}

test('binds proposal, separate approval and inspection to one immutable plan', async () => {
  const state = approvalFixture();
  let now = 1_000;
  const service = createClusterWorkerCredentialManagementService({
    pool: state.pool,
    now: () => now,
    planLifetimeMs: 10_000,
    approvalLifetimeMs: 5_000,
  });
  const planned = await service.plan(planRequest());
  const proposed = await service.propose({
    actionRef: planned.plan.actionRef,
    authorityProjectId: planned.plan.authorityProjectId,
    approvalRequestId: 'approval-worker-a-generation-2',
    approvalAuditEventId: '123e4567-e89b-42d3-a456-426614174703',
    principal: REQUESTER,
  });

  assert.equal(proposed.approvalStatus, 'created');
  assert.equal(proposed.approvalRequest.state, 'pending');
  assert.equal(proposed.approvalRequest.version, 1);
  assert.equal(proposed.approvalRequest.decisionMode, 'separation_of_duty');
  assert.equal(proposed.approvalRequest.risk, 'high');
  assert.deepEqual(proposed.approvalRequest.action, {
    permission: 'worker.manage',
    actionType: 'worker_credential.delivery.rotate',
    actionRef: planned.plan.actionRef,
    actionDigest: planned.plan.planDigest,
    previewDigest: planned.plan.previewDigest,
  });

  now = 1_100;
  const decided = await service.decide({
    actionRef: planned.plan.actionRef,
    authorityProjectId: planned.plan.authorityProjectId,
    approvalRequestId: proposed.approvalRequest.id,
    expectedVersion: 1,
    decisionId: 'decision-worker-a-generation-2',
    auditEventId: '123e4567-e89b-42d3-a456-426614174704',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: REVIEWER,
  });
  const replay = await service.decide({
    actionRef: planned.plan.actionRef,
    authorityProjectId: planned.plan.authorityProjectId,
    approvalRequestId: proposed.approvalRequest.id,
    expectedVersion: 1,
    decisionId: 'decision-worker-a-generation-2',
    auditEventId: '123e4567-e89b-42d3-a456-426614174704',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: REVIEWER,
  });
  const inspection = await service.inspectAuthorized({
    actionRef: planned.plan.actionRef,
    authorityProjectId: planned.plan.authorityProjectId,
    approvalRequestId: proposed.approvalRequest.id,
    inspectionId: 'inspection-worker-a-generation-2',
    principal: REVIEWER,
  });

  assert.equal(decided.status, 'decided');
  assert.equal(decided.request.state, 'approved');
  assert.equal(decided.request.version, 2);
  assert.equal(decided.request.decidedBy.id, 'reviewer-b');
  assert.equal(replay.status, 'existing');
  assert.equal(inspection.stale, false);
  assert.equal(inspection.plan.planDigest, planned.plan.planDigest);
  assert.equal(inspection.approvalRequest.state, 'approved');
  assert.equal(state.approvals.size, 1);
  assert.equal(state.audits.size, 2);
  assert.equal(state.releases(), 2);
});

test('authorizes and consumes durable quota before reading management state', async () => {
  const state = approvalFixture();
  const quotaCalls = [];
  const service = createClusterWorkerCredentialManagementService({
    pool: state.pool,
    now: () => 1_000,
    quota: {
      async consume(command) {
        assert.equal(
          state.queries.some(({ text }) =>
            text.includes('FROM "ql3"."projects" AS project'),
          ),
          true,
        );
        quotaCalls.push({
          ...command,
          planReads: state.queries.filter(({ text }) =>
            text.includes('SELECT plan_json'),
          ).length,
        });
        return { admitted: true, retryAfterMs: null };
      },
    },
  });
  const planned = await service.plan(planRequest());
  assert.equal(quotaCalls[0].operation, 'worker-credential.plan');
  const readsBefore = state.queries.filter(({ text }) =>
    text.includes('SELECT plan_json'),
  ).length;
  await assert.rejects(
    service.propose({
      actionRef: planned.plan.actionRef,
      authorityProjectId: 'other-project',
      approvalRequestId: 'approval-other-project',
      approvalAuditEventId: '123e4567-e89b-42d3-a456-426614174799',
      principal: REQUESTER,
    }),
  );
  assert.equal(
    state.queries.filter(({ text }) => text.includes('SELECT plan_json')).length,
    readsBefore + 1,
  );
  assert.equal(quotaCalls.length, 2);
  assert.equal(quotaCalls[1].operation, 'worker-credential.propose');
  assert.equal(quotaCalls[1].planReads, readsBefore);
});

test('observes one Session and one bounded page only after worker.manage quota', async () => {
  const state = approvalFixture();
  const quotaCalls = [];
  const service = createClusterWorkerCredentialManagementService({
    pool: state.pool,
    now: () => 2_000,
    quota: {
      async consume(command) {
        quotaCalls.push(command);
        return { admitted: true, retryAfterMs: null };
      },
    },
  });
  const inspection = await service.inspectSession({
    authorityProjectId: 'cluster-authority',
    workerId: 'worker-a',
    inspectionId: 'worker-session-inspection-a',
    principal: REQUESTER,
  });
  const page = await service.listSessions({
    authorityProjectId: 'cluster-authority',
    afterWorkerId: null,
    inspectionId: 'worker-session-list-a',
    principal: REQUESTER,
  });
  assert.equal(inspection.worker.workerId, 'worker-a');
  assert.equal(inspection.worker.compatibility, 'default_placement');
  assert.equal(page.workers.length, 1);
  assert.equal(page.workers[0].workerId, 'worker-a');
  assert.deepEqual(
    quotaCalls.map(({ operation, idempotencyKey }) => ({
      operation,
      idempotencyKey,
    })),
    [
      {
        operation: 'worker-session.observe',
        idempotencyKey: 'session-inspect:worker-session-inspection-a',
      },
      {
        operation: 'worker-session.observe',
        idempotencyKey: 'session-list:worker-session-list-a',
      },
    ],
  );
});
