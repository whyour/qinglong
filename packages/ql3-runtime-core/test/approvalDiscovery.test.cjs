const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  MAX_APPROVAL_REQUEST_PAGE_SIZE,
  MAX_APPROVAL_DETAIL_PREVIEW_BYTES,
  InvalidApprovalDiscoveryValueError,
  approvalRequestUpdatedAtMs,
  assertApprovalDiscoveryProjectId,
  assertApprovalDiscoveryRequestId,
  assertApprovalRequestPageSize,
  normalizeApprovalRequestCursor,
  normalizeApprovalDetailPreview,
} = require('@qinglong/runtime-core/approval-discovery');

function pending() {
  return createApprovalRequest({
    id: 'approval-1',
    projectId: 'default',
    action: {
      permission: 'run.start',
      actionType: 'tool.invoke',
      actionRef: 'tool:run.start',
      actionDigest: 'a'.repeat(64),
      previewDigest: 'b'.repeat(64),
    },
    risk: 'medium',
    decisionMode: 'human_confirmation',
    requestedBy: { type: 'agent', id: 'agent-1' },
    requestedAtMs: 10,
    expiresAtMs: 1_000,
    requestFence: { projectVersion: 1, bindingVersion: 1 },
  });
}

test('bounds Approval discovery pages and exact keyset cursors', () => {
  assert.equal(MAX_APPROVAL_REQUEST_PAGE_SIZE, 64);
  assert.doesNotThrow(() => assertApprovalRequestPageSize(1));
  assert.doesNotThrow(() => assertApprovalRequestPageSize(64));
  for (const value of [0, 65, 1.5, Number.NaN]) {
    assert.throws(
      () => assertApprovalRequestPageSize(value),
      InvalidApprovalDiscoveryValueError,
    );
  }
  assert.deepEqual(
    normalizeApprovalRequestCursor({ updatedAtMs: 20, requestId: 'approval-2' }),
    { updatedAtMs: 20, requestId: 'approval-2' },
  );
  for (const value of [
    null,
    { updatedAtMs: -1, requestId: 'approval-2' },
    { updatedAtMs: 20, requestId: '' },
    { updatedAtMs: 20, requestId: 'approval-2', extra: true },
  ]) {
    assert.throws(
      () => normalizeApprovalRequestCursor(value),
      InvalidApprovalDiscoveryValueError,
    );
  }
});

test('accepts bounded Project identifiers and rejects control data', () => {
  assert.doesNotThrow(() => assertApprovalDiscoveryProjectId('default'));
  assert.doesNotThrow(() => assertApprovalDiscoveryRequestId('approval-1'));
  for (const value of ['', 'x'.repeat(129), 'project\nother']) {
    assert.throws(
      () => assertApprovalDiscoveryProjectId(value),
      InvalidApprovalDiscoveryValueError,
    );
  }
  for (const value of ['', 'x'.repeat(129), 'approval/other']) {
    assert.throws(
      () => assertApprovalDiscoveryRequestId(value),
      InvalidApprovalDiscoveryValueError,
    );
  }
});

test('derives the sortable timestamp from the latest durable transition', () => {
  const request = pending();
  assert.equal(approvalRequestUpdatedAtMs(request), 10);
  const approved = decideApprovalRequest(request, {
    expectedVersion: 1,
    decisionId: 'decision-1',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: { type: 'user', id: 'owner-1' },
      authenticationId: 'auth-owner-1',
      authenticatedAtMs: 15,
      expiresAtMs: 100,
      assurance: 'local_console',
    },
    decidedAtMs: 20,
    authorizationFence: { projectVersion: 1, bindingVersion: 1 },
  });
  assert.equal(approvalRequestUpdatedAtMs(approved), 20);
});

test('normalizes only a bounded document-only Approval preview', () => {
  assert.equal(MAX_APPROVAL_DETAIL_PREVIEW_BYTES, 8 * 1024);
  assert.deepEqual(
    normalizeApprovalDetailPreview({
      title: 'Run task',
      summary: 'Runs one task.',
      fields: [{ kind: 'redacted', label: 'Token', value: null }],
      warnings: ['external_effect'],
    }),
    {
      title: 'Run task',
      summary: 'Runs one task.',
      fields: [{ kind: 'redacted', label: 'Token', value: null }],
      warnings: ['external_effect'],
    },
  );
  assert.throws(
    () =>
      normalizeApprovalDetailPreview({
        title: 'x'.repeat(256),
        summary: 'x'.repeat(2_048),
        fields: Array.from({ length: 16 }, (_, index) => ({
          kind: 'text',
          label: `field-${index}-${'x'.repeat(110)}`,
          value: 'x'.repeat(512),
        })),
        warnings: [],
      }),
    InvalidApprovalDiscoveryValueError,
  );
});
