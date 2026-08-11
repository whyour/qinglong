const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  approvalRequestDigest,
  createApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createToolInvocationPreviewArtifact,
} = require('@qinglong/runtime-core/tool-invocation-artifact');
const {
  PostgresApprovalRequestSource,
} = require('@qinglong/cluster-postgres/approval-discovery');

function request(id, atMs) {
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
    decisionMode: 'separation_of_duty',
    requestedBy: { type: 'agent', id: 'agent-planner' },
    requestedAtMs: atMs,
    expiresAtMs: atMs + 60_000,
    requestFence: { projectVersion: 1, bindingVersion: 1 },
  });
}

function row(value) {
  return {
    requestJson: value,
    requestDigest: approvalRequestDigest(value),
    updatedAtMs: value.requestedAtMs,
  };
}

test('uses the Project descending keyset and returns limit plus one', async () => {
  const calls = [];
  const values = [request('approval-3', 3_000), request('approval-2', 2_000)];
  const source = new PostgresApprovalRequestSource({
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: values.map(row) };
    },
  });
  const page = await source.listApprovalRequests({
    projectId: 'default',
    limit: 1,
    after: { updatedAtMs: 4_000, requestId: 'approval-4' },
  });
  assert.deepEqual(calls[0].parameters, [
    'default',
    4_000,
    'approval-4',
    2,
  ]);
  assert.match(calls[0].sql, /ORDER BY updated_at_ms DESC, request_id DESC/);
  assert.deepEqual(page.requests.map(({ id }) => id), ['approval-3']);
  assert.equal(page.truncated, true);
  assert.deepEqual(page.next, {
    updatedAtMs: 3_000,
    requestId: 'approval-3',
  });
});

test('fails closed on malformed rows and database errors', async () => {
  const value = request('approval-1', 1_000);
  for (const pool of [
    { async query() { return { rows: [{ ...row(value), updatedAtMs: 2_000 }] }; } },
    { async query() { throw new Error('private database detail'); } },
  ]) {
    await assert.rejects(
      new PostgresApprovalRequestSource(pool).listApprovalRequests({
        projectId: 'default',
        limit: 1,
      }),
      { code: 'APPROVAL_UNAVAILABLE' },
    );
  }
});

test('reads one Approval detail through the exact Project and Artifact binding', async () => {
  const previewArtifact = createToolInvocationPreviewArtifact({
    artifactId: 'preview-1',
    projectId: 'default',
    actionRef: 'tool:approval-1',
    actionDigest: 'c'.repeat(64),
    redactionContractDigest: 'd'.repeat(64),
    sealedAtMs: 1_000,
    preview: {
      title: 'Run task',
      summary: 'Runs one selected task.',
      fields: [{ kind: 'redacted', label: 'Token', value: null }],
      warnings: ['external_effect'],
    },
  });
  const approval = createApprovalRequest({
    id: 'approval-1',
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
    requestedBy: { type: 'agent', id: 'agent-planner' },
    requestedAtMs: 1_000,
    expiresAtMs: 61_000,
    requestFence: { projectVersion: 1, bindingVersion: 1 },
  });
  const detailRow = {
    ...row(approval),
    previewArtifactId: previewArtifact.artifactId,
    previewProjectId: previewArtifact.projectId,
    previewActionRef: previewArtifact.actionRef,
    previewActionDigest: previewArtifact.actionDigest,
    storedPreviewDigest: previewArtifact.previewDigest,
    redactionContractDigest: previewArtifact.redactionContractDigest,
    previewArtifactDigest: previewArtifact.artifactDigest,
    previewByteLength: previewArtifact.byteLength,
    previewSealedAtMs: previewArtifact.sealedAtMs,
    previewArtifactJson: previewArtifact,
  };
  const calls = [];
  const source = new PostgresApprovalRequestSource({
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [detailRow] };
    },
  });
  const detail = await source.getApprovalRequestDetail({
    projectId: 'default',
    requestId: 'approval-1',
  });
  assert.deepEqual(calls[0].parameters, ['default', 'approval-1']);
  assert.match(calls[0].sql, /LEFT JOIN "ql3"\."tool_invocation_preview_artifacts"/);
  assert.equal(detail.request.id, 'approval-1');
  assert.equal(detail.preview.title, 'Run task');
  await assert.rejects(
    new PostgresApprovalRequestSource({
      async query() {
        return { rows: [{ ...detailRow, previewByteLength: 1 }] };
      },
    }).getApprovalRequestDetail({ projectId: 'default', requestId: 'approval-1' }),
    { code: 'APPROVAL_UNAVAILABLE' },
  );
});

test('exports only through the read authority subpath', () => {
  const root = require('@qinglong/cluster-postgres');
  const mutation = require('@qinglong/cluster-postgres/approved-action');
  const discovery = require('@qinglong/cluster-postgres/approval-discovery');
  assert.equal(root.PostgresApprovalRequestSource, undefined);
  assert.equal(mutation.PostgresApprovalRequestSource, undefined);
  assert.equal(
    discovery.PostgresApprovalRequestSource,
    PostgresApprovalRequestSource,
  );
});
