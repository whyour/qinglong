const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  BUILTIN_APPROVAL_LIST_DEFAULT_LIMIT,
  BUILTIN_APPROVAL_LIST_MAX_LIMIT,
  BUILTIN_APPROVAL_LIST_TOOL,
  BUILTIN_APPROVAL_LIST_TOOL_DEFINITION,
  BuiltInApprovalListToolUnavailableError,
  InvalidBuiltInApprovalListToolError,
  executeBuiltInApprovalListTool,
} = require('../dist/tool-projection/approvalList.js');

function approval(id, requestedAtMs, overrides = {}) {
  return createApprovalRequest({
    id,
    projectId: 'default',
    action: {
      permission: 'run.start',
      actionType: 'tool.invoke',
      actionRef: `private:${id}`,
      actionDigest: 'a'.repeat(64),
      previewDigest: 'b'.repeat(64),
    },
    risk: 'medium',
    decisionMode: 'human_confirmation',
    requestedBy: { type: 'agent', id: 'private-agent' },
    requestedAtMs,
    expiresAtMs: requestedAtMs + 60_000,
    requestFence: { projectVersion: 1, bindingVersion: 2 },
    ...overrides,
  });
}

test('defines one bounded low-risk approval.read Tool', () => {
  assert.deepEqual(BUILTIN_APPROVAL_LIST_TOOL, {
    name: 'qinglong.approval.list',
    version: '1.0.0',
  });
  assert.equal(BUILTIN_APPROVAL_LIST_TOOL_DEFINITION.effect, 'read');
  assert.equal(BUILTIN_APPROVAL_LIST_TOOL_DEFINITION.risk, 'low');
  assert.deepEqual(BUILTIN_APPROVAL_LIST_TOOL_DEFINITION.requiredPermissions, [
    'approval.read',
  ]);
  assert.equal(BUILTIN_APPROVAL_LIST_DEFAULT_LIMIT, 32);
  assert.equal(BUILTIN_APPROVAL_LIST_MAX_LIMIT, 64);
});

test('projects bounded Approval state without authority or sensitive evidence', async () => {
  let captured;
  const output = await executeBuiltInApprovalListTool(
    {
      async listApprovalRequests(query) {
        captured = query;
        return Object.freeze({
          requests: Object.freeze([approval('approval-2', 2_000)]),
          truncated: true,
          next: Object.freeze({ updatedAtMs: 2_000, requestId: 'approval-2' }),
        });
      },
    },
    'default',
    { after: { updatedAtMs: 3_000, requestId: 'approval-3' }, limit: 1 },
  );
  assert.deepEqual(captured, {
    projectId: 'default',
    limit: 1,
    after: { updatedAtMs: 3_000, requestId: 'approval-3' },
  });
  assert.deepEqual(output, {
    approvals: [
      {
        requestId: 'approval-2',
        version: 1,
        state: 'pending',
        risk: 'medium',
        decisionMode: 'human_confirmation',
        permission: 'run.start',
        actionType: 'tool.invoke',
        requestedByType: 'agent',
        requestedAtMs: 2_000,
        expiresAtMs: 62_000,
        updatedAtMs: 2_000,
      },
    ],
    hasMore: true,
    next: { updatedAtMs: 2_000, requestId: 'approval-2' },
  });
  const serialized = JSON.stringify(output);
  for (const hidden of [
    'private',
    'actionRef',
    'actionDigest',
    'previewDigest',
    'requestFence',
    'projectId',
  ]) {
    assert.equal(serialized.includes(hidden), false);
  }
});

test('defaults to 32 and returns no cursor for a complete page', async () => {
  let captured;
  const output = await executeBuiltInApprovalListTool(
    {
      async listApprovalRequests(query) {
        captured = query;
        return { requests: [], truncated: false };
      },
    },
    'default',
    {},
  );
  assert.deepEqual(captured, { projectId: 'default', limit: 32 });
  assert.deepEqual(output, { approvals: [], hasMore: false });
});

test('rejects invalid input before reading', async () => {
  let reads = 0;
  const source = {
    async listApprovalRequests() {
      reads += 1;
      return { requests: [], truncated: false };
    },
  };
  for (const input of [
    null,
    { limit: 65 },
    { after: { updatedAtMs: -1, requestId: 'approval-1' } },
    { after: { updatedAtMs: 1, requestId: '' } },
    { after: { updatedAtMs: 1, requestId: 'approval-1', extra: true } },
    { unexpected: true },
  ]) {
    await assert.rejects(
      executeBuiltInApprovalListTool(source, 'default', input),
      InvalidBuiltInApprovalListToolError,
    );
  }
  assert.equal(reads, 0);
});

test('fails closed on cross-Project, unordered, oversized or inconsistent pages', async () => {
  for (const { page, input = {} } of [
    {
      page: {
        requests: [approval('approval-2', 2_000, { projectId: 'other' })],
        truncated: false,
      },
    },
    {
      page: {
        requests: [approval('approval-1', 1_000), approval('approval-2', 2_000)],
        truncated: false,
      },
    },
    {
      page: {
        requests: [approval('approval-2', 2_000), approval('approval-1', 1_000)],
        truncated: false,
      },
      input: { limit: 1 },
    },
    {
      page: { requests: [approval('approval-1', 1_000)], truncated: true },
    },
    {
      page: {
        requests: [approval('approval-1', 1_000)],
        truncated: true,
        next: { updatedAtMs: 1_000, requestId: 'approval-other' },
      },
    },
    {
      page: { requests: [{ projectId: 'default' }], truncated: false },
    },
  ]) {
    await assert.rejects(
      executeBuiltInApprovalListTool(
        {
          async listApprovalRequests() {
            return page;
          },
        },
        'default',
        input,
      ),
      BuiltInApprovalListToolUnavailableError,
    );
  }
});
