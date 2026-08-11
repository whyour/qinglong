const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  ApprovalUnavailableError,
  createApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createToolInvocationPreviewArtifact,
} = require('@qinglong/runtime-core/tool-invocation-artifact');
const {
  LocalSqliteApprovalRequestRepository,
} = require('@qinglong/local-sqlite/approved-action');
const {
  LocalSqliteApprovalRequestSource,
} = require('@qinglong/local-sqlite/approval-discovery');
const {
  LocalSqliteOperationAuthority,
} = require('@qinglong/local-sqlite/operation-authority');
const {
  migrateLocalSqliteDatabase,
} = require('@qinglong/local-sqlite/migration');

const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 1 });
const REQUESTER = Object.freeze({ type: 'user', id: 'usr_owner' });

function request(id, requestedAtMs) {
  return createApprovalRequest({
    id,
    projectId: 'default',
    action: {
      permission: 'run.start',
      actionType: 'tool.invoke',
      actionRef: `tool:${id}`,
      actionDigest: 'a'.repeat(64),
      previewDigest: 'b'.repeat(64),
    },
    risk: 'medium',
    decisionMode: 'human_confirmation',
    requestedBy: REQUESTER,
    requestedAtMs,
    expiresAtMs: requestedAtMs + 60_000,
    requestFence: FENCE,
  });
}

function audit(id, atMs) {
  return {
    eventId: id,
    requestId: `command-${id}`,
    operationId: 'approval.request',
    projectId: 'default',
    subject: REQUESTER,
    authenticationId: 'auth-owner',
    outcome: 'approval_required',
    reasons: ['agent_action_requires_approval'],
    fence: FENCE,
    occurredAtMs: atMs,
  };
}

async function fixture(t) {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  client.exec(`INSERT INTO "QingLong3ProjectRoleBindings"
    ("project_id","subject_type","subject_id","version","state","role",
     "mutation_id","changed_by_type","changed_by_id","created_at_ms")
    VALUES ('default','user','usr_owner',1,'active','owner','grant-owner',
            'user','usr_owner',0)`);
  const authority = new LocalSqliteOperationAuthority(client);
  t.after(() => authority.close());
  const writer = new LocalSqliteApprovalRequestRepository(authority);
  for (const [index, atMs] of [1_000, 2_000, 3_000].entries()) {
    const id = `approval-${index + 1}`;
    await writer.create({
      request: request(id, atMs),
      audit: audit(`10000000-0000-4000-8000-00000000000${index + 1}`, atMs),
    });
  }
  return {
    authority,
    client,
    source: new LocalSqliteApprovalRequestSource(authority),
  };
}

test('lists one Project newest-first with a stable keyset cursor', async (t) => {
  const { source } = await fixture(t);
  const first = await source.listApprovalRequests({
    projectId: 'default',
    limit: 2,
  });
  assert.deepEqual(
    first.requests.map(({ id }) => id),
    ['approval-3', 'approval-2'],
  );
  assert.equal(first.truncated, true);
  assert.deepEqual(first.next, {
    updatedAtMs: 2_000,
    requestId: 'approval-2',
  });
  const second = await source.listApprovalRequests({
    projectId: 'default',
    limit: 2,
    after: first.next,
  });
  assert.deepEqual(second.requests.map(({ id }) => id), ['approval-1']);
  assert.equal(second.truncated, false);
  assert.equal(second.next, undefined);
});

test('rejects widened input and fails closed on row mirror drift', async (t) => {
  const { client, source } = await fixture(t);
  assert.throws(
    () => source.listApprovalRequests({ projectId: 'default', limit: 65 }),
    TypeError,
  );
  client.exec(`UPDATE "QingLong3ApprovalRequests"
    SET "updated_at_ms" = "updated_at_ms" + 1
    WHERE "request_id" = 'approval-3'`);
  await assert.rejects(
    source.listApprovalRequests({ projectId: 'default', limit: 2 }),
    ApprovalUnavailableError,
  );
});

test('reads one Project-scoped Approval with an exactly bound redacted preview', async (t) => {
  const { authority, client, source } = await fixture(t);
  const previewArtifact = createToolInvocationPreviewArtifact({
    artifactId: 'preview-approval',
    projectId: 'default',
    actionRef: 'tool:approval-preview',
    actionDigest: 'c'.repeat(64),
    redactionContractDigest: 'd'.repeat(64),
    sealedAtMs: 4_000,
    preview: {
      title: 'Run task',
      summary: 'Runs one selected task.',
      fields: [{ kind: 'redacted', label: 'Token', value: null }],
      warnings: ['external_effect'],
    },
  });
  const approval = createApprovalRequest({
    id: 'approval-preview',
    projectId: 'default',
    action: {
      permission: 'run.start',
      actionType: 'tool.invoke',
      actionRef: previewArtifact.actionRef,
      actionDigest: previewArtifact.actionDigest,
      previewDigest: previewArtifact.previewDigest,
    },
    risk: 'medium',
    decisionMode: 'human_confirmation',
    requestedBy: REQUESTER,
    requestedAtMs: 4_000,
    expiresAtMs: 64_000,
    requestFence: FENCE,
  });
  await new LocalSqliteApprovalRequestRepository(authority).create({
    request: approval,
    audit: audit('10000000-0000-4000-8000-000000000009', 4_000),
  });
  client.prepare(`INSERT INTO "ToolInvocationPreviewArtifacts" (
    artifact_id, project_id, action_ref, action_digest, preview_digest,
    redaction_contract_digest, artifact_digest, byte_length, sealed_at_ms,
    artifact_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    previewArtifact.artifactId,
    previewArtifact.projectId,
    previewArtifact.actionRef,
    previewArtifact.actionDigest,
    previewArtifact.previewDigest,
    previewArtifact.redactionContractDigest,
    previewArtifact.artifactDigest,
    previewArtifact.byteLength,
    previewArtifact.sealedAtMs,
    JSON.stringify(previewArtifact),
  );
  const detail = await source.getApprovalRequestDetail({
    projectId: 'default',
    requestId: 'approval-preview',
  });
  assert.equal(detail.request.id, 'approval-preview');
  assert.equal(detail.preview.title, 'Run task');
  assert.equal(
    await source.getApprovalRequestDetail({
      projectId: 'other',
      requestId: 'approval-preview',
    }),
    null,
  );
  client.exec('PRAGMA ignore_check_constraints = ON');
  client.exec(`UPDATE "ToolInvocationPreviewArtifacts"
    SET byte_length = byte_length + 1
    WHERE artifact_id = 'preview-approval'`);
  await assert.rejects(
    source.getApprovalRequestDetail({
      projectId: 'default',
      requestId: 'approval-preview',
    }),
    ApprovalUnavailableError,
  );
});

test('exports discovery separately from Approval mutation authority', () => {
  const root = require('@qinglong/local-sqlite');
  const mutation = require('@qinglong/local-sqlite/approved-action');
  const discovery = require('@qinglong/local-sqlite/approval-discovery');
  assert.equal(root.LocalSqliteApprovalRequestSource, undefined);
  assert.equal(mutation.LocalSqliteApprovalRequestSource, undefined);
  assert.equal(
    discovery.LocalSqliteApprovalRequestSource,
    LocalSqliteApprovalRequestSource,
  );
});
