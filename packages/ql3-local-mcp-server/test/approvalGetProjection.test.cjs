const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createToolInvocationPreviewArtifact,
} = require('@qinglong/runtime-core/tool-invocation-artifact');
const {
  BUILTIN_APPROVAL_GET_TOOL,
  BUILTIN_APPROVAL_GET_TOOL_DEFINITION,
  BuiltInApprovalGetToolUnavailableError,
  InvalidBuiltInApprovalGetToolError,
  executeBuiltInApprovalGetTool,
} = require('../dist/tool-projection/approvalGet.js');

function detail() {
  const previewArtifact = createToolInvocationPreviewArtifact({
    artifactId: 'preview-1',
    projectId: 'default',
    actionRef: 'tool:approval-1',
    actionDigest: 'a'.repeat(64),
    redactionContractDigest: 'c'.repeat(64),
    sealedAtMs: 1_000,
    preview: {
      title: 'Run task',
      summary: 'Runs the selected task once.',
      fields: [
        { kind: 'identifier', label: 'Task', value: 'task-1' },
        { kind: 'redacted', label: 'Token', value: null },
      ],
      warnings: ['external_effect'],
    },
  });
  const request = createApprovalRequest({
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
    requestedBy: { type: 'agent', id: 'private-agent' },
    requestedAtMs: 1_000,
    expiresAtMs: 61_000,
    requestFence: { projectVersion: 1, bindingVersion: 2 },
  });
  return Object.freeze({ request, preview: previewArtifact.preview });
}

test('defines an exact dual-authorized read-only Approval detail Tool', () => {
  assert.deepEqual(BUILTIN_APPROVAL_GET_TOOL, {
    name: 'qinglong.approval.get',
    version: '1.0.0',
  });
  assert.equal(BUILTIN_APPROVAL_GET_TOOL_DEFINITION.effect, 'read');
  assert.equal(BUILTIN_APPROVAL_GET_TOOL_DEFINITION.risk, 'low');
  assert.deepEqual(BUILTIN_APPROVAL_GET_TOOL_DEFINITION.requiredPermissions, [
    'approval.read',
    'artifact.read',
  ]);
});

test('projects only Approval metadata and the redacted preview document', async () => {
  let captured;
  const output = await executeBuiltInApprovalGetTool(
    {
      async getApprovalRequestDetail(query) {
        captured = query;
        return detail();
      },
    },
    'default',
    { requestId: 'approval-1' },
  );
  assert.deepEqual(captured, { projectId: 'default', requestId: 'approval-1' });
  assert.deepEqual(output, {
    found: true,
    approval: {
      requestId: 'approval-1',
      version: 1,
      state: 'pending',
      risk: 'medium',
      decisionMode: 'human_confirmation',
      permission: 'run.start',
      actionType: 'tool.invoke',
      requestedByType: 'agent',
      requestedAtMs: 1_000,
      expiresAtMs: 61_000,
      previewAvailable: true,
      preview: {
        title: 'Run task',
        summary: 'Runs the selected task once.',
        fields: [
          { kind: 'identifier', label: 'Task', value: 'task-1' },
          { kind: 'redacted', label: 'Token' },
        ],
        warnings: ['external_effect'],
      },
    },
  });
  const serialized = JSON.stringify(output);
  for (const hidden of [
    'private-agent',
    'actionRef',
    'actionDigest',
    'previewDigest',
    'artifactDigest',
    'redactionContractDigest',
    'requestFence',
  ]) {
    assert.equal(serialized.includes(hidden), false);
  }
});

test('masks an absent request and reports an unavailable preview explicitly', async () => {
  const missing = await executeBuiltInApprovalGetTool(
    { async getApprovalRequestDetail() { return null; } },
    'default',
    { requestId: 'missing' },
  );
  assert.deepEqual(missing, { found: false });
  const withoutPreview = detail();
  const output = await executeBuiltInApprovalGetTool(
    {
      async getApprovalRequestDetail() {
        return { request: withoutPreview.request, preview: null };
      },
    },
    'default',
    { requestId: 'approval-1' },
  );
  assert.equal(output.approval.previewAvailable, false);
  assert.equal(Object.hasOwn(output.approval, 'preview'), false);
});

test('rejects widened input before reading and fails closed on binding drift', async () => {
  let reads = 0;
  const source = {
    async getApprovalRequestDetail() {
      reads += 1;
      return null;
    },
  };
  for (const input of [null, {}, { requestId: '' }, { requestId: 'a', extra: true }]) {
    await assert.rejects(
      executeBuiltInApprovalGetTool(source, 'default', input),
      InvalidBuiltInApprovalGetToolError,
    );
  }
  assert.equal(reads, 0);
  const value = detail();
  await assert.rejects(
    executeBuiltInApprovalGetTool(
      { async getApprovalRequestDetail() { return value; } },
      'other',
      { requestId: 'approval-1' },
    ),
    BuiltInApprovalGetToolUnavailableError,
  );
  await assert.rejects(
    executeBuiltInApprovalGetTool(
      { async getApprovalRequestDetail() { throw new Error('private'); } },
      'default',
      { requestId: 'approval-1' },
    ),
    BuiltInApprovalGetToolUnavailableError,
  );
  await assert.rejects(
    executeBuiltInApprovalGetTool(
      {
        async getApprovalRequestDetail() {
          return { ...value, extra: true };
        },
      },
      'default',
      { requestId: 'approval-1' },
    ),
    BuiltInApprovalGetToolUnavailableError,
  );
});
