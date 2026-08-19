'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createRunCancellationBlockedListCommand,
  decodeRunCancellationBlockedCursor,
  encodeRunCancellationBlockedCursor,
  formatRunCancellationBlockedListCard,
  projectRunCancellationBlockedList,
} = require('../dist/run-management/runCancellationBlockedList.js');

const UUIDS = [
  '019fa000-0000-4000-8000-000000000001',
  '019fa000-0000-4000-8000-000000000002',
  '019fa000-0000-4000-8000-000000000003',
];

test('round-trips one bounded opaque blocked cursor', () => {
  const cursor = {
    snapshotAtMs: 1_700_000_000_000,
    blockedAtMs: 1_699_999_999_000,
    runId: 'run-16',
  };
  const token = encodeRunCancellationBlockedCursor(cursor);
  assert.match(token, /^v1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeRunCancellationBlockedCursor(token), cursor);
  for (const invalid of [
    'v2.abc',
    'v1.***',
    `${token}=`,
    'v1.e30',
  ]) {
    assert.throws(() => decodeRunCancellationBlockedCursor(invalid));
  }
});

test('builds one fixed blocked list command with no caller limit', () => {
  let index = 0;
  const cursor = encodeRunCancellationBlockedCursor({
    snapshotAtMs: 1_700_000_000_000,
    blockedAtMs: 1_699_999_999_000,
    runId: 'run-16',
  });
  const command = createRunCancellationBlockedListCommand(
    'project-1',
    cursor,
    () => UUIDS[index++],
  );
  assert.equal(command.operation, 'run.cancellation.blocked.list');
  assert.equal(command.request.projectId, 'project-1');
  assert.equal(Object.hasOwn(command.request, 'runId'), false);
  assert.equal(Object.hasOwn(command.request.body, 'limit'), false);
  assert.deepEqual(command.request.body.after, {
    snapshotAtMs: 1_700_000_000_000,
    blockedAtMs: 1_699_999_999_000,
    runId: 'run-16',
  });
});

test('projects a low-sensitive page and renders a deterministic card', () => {
  const result = {
    schemaVersion: 1,
    requestId: 'request-blocked-1',
    result: {
      schemaVersion: 1,
      operation: 'run.cancellation.blocked.list',
      page: {
        schema: 'qinglong/run-cancellation-dispatch-blocked-page@v1',
        projectId: 'project-1',
        snapshotAtMs: 1_700_000_000_000,
        observedAtMs: 1_700_000_000_100,
        items: Array.from({ length: 16 }, (_, index) => ({
          runId: `run-${index + 1}`,
          blockedAtMs: 1_699_999_999_000 + index,
        })),
        truncated: true,
        nextCursor: {
          snapshotAtMs: 1_700_000_000_000,
          blockedAtMs: 1_699_999_999_015,
          runId: 'run-16',
        },
      },
    },
  };
  const observation = projectRunCancellationBlockedList(result);
  assert.equal(observation.schema, 'qinglong/run-cancellation-blocked-list@v1');
  assert.equal(observation.items.length, 16);
  assert.match(observation.nextCursor, /^v1\./);
  const card = formatRunCancellationBlockedListCard(observation);
  assert.match(card, /Blocked Cancellations/);
  assert.match(card, /run-1/);
  assert.match(card, /NEXT_CURSOR\s+v1\./);
  for (const forbidden of [
    'attemptId',
    'lastResult',
    'leaseOwner',
    'leaseToken',
    '\u001b',
  ]) {
    assert.equal(card.includes(forbidden), false);
  }
});
