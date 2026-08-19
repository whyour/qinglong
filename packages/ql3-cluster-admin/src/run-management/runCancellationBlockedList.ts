import { randomUUID } from 'node:crypto';

import type { ClusterRunManagementClientResult } from './runManagementClient';
import {
  RUN_CANCELLATION_DISPATCH_BLOCKED_LIST_REQUEST_SCHEMA,
  normalizeClusterRunManagementCommand,
  type ClusterRunManagementCancellationBlockedListCommand,
  type ClusterRunManagementCancellationBlockedListTransportResult,
} from './runManagementTransport';

export const RUN_CANCELLATION_BLOCKED_LIST_SCHEMA =
  'qinglong/run-cancellation-blocked-list@v1' as const;

const CURSOR_PREFIX = 'v1.';
const CURSOR_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type BlockedCursor = NonNullable<
  ClusterRunManagementCancellationBlockedListCommand['request']['body']['after']
>;

export interface RunCancellationBlockedListObservation {
  readonly schemaVersion: 1;
  readonly schema: typeof RUN_CANCELLATION_BLOCKED_LIST_SCHEMA;
  readonly component: 'qinglong3-run-management-client';
  readonly event: 'cancellation_blocked_list_observed';
  readonly requestId: string;
  readonly projectId: string;
  readonly snapshotAtMs: number;
  readonly observedAtMs: number;
  readonly items: readonly Readonly<{
    runId: string;
    blockedAtMs: number;
  }>[];
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

function invalidCursor(): never {
  throw new TypeError('Run cancellation blocked cursor is invalid');
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalidCursor();
  }
  const actual = Object.keys(value as object).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalidCursor();
  }
  return value as Record<string, unknown>;
}

function normalizeCursor(value: unknown): Readonly<BlockedCursor> {
  const cursor = exact(value, ['snapshotAtMs', 'blockedAtMs', 'runId']);
  if (
    typeof cursor.snapshotAtMs !== 'number' ||
    !Number.isSafeInteger(cursor.snapshotAtMs) ||
    cursor.snapshotAtMs < 0 ||
    typeof cursor.blockedAtMs !== 'number' ||
    !Number.isSafeInteger(cursor.blockedAtMs) ||
    cursor.blockedAtMs < 0 ||
    cursor.blockedAtMs > cursor.snapshotAtMs ||
    typeof cursor.runId !== 'string' ||
    !IDENTIFIER_PATTERN.test(cursor.runId)
  ) {
    invalidCursor();
  }
  return Object.freeze({
    snapshotAtMs: cursor.snapshotAtMs,
    blockedAtMs: cursor.blockedAtMs,
    runId: cursor.runId,
  });
}

export function decodeRunCancellationBlockedCursor(
  token: string,
): Readonly<BlockedCursor> {
  if (typeof token !== 'string' || !token.startsWith(CURSOR_PREFIX)) {
    invalidCursor();
  }
  const encoded = token.slice(CURSOR_PREFIX.length);
  if (!CURSOR_PAYLOAD_PATTERN.test(encoded)) invalidCursor();
  let bytes: Buffer;
  let parsed: unknown;
  try {
    bytes = Buffer.from(encoded, 'base64url');
    if (
      bytes.length < 2 ||
      bytes.length > 384 ||
      bytes.toString('base64url') !== encoded
    ) {
      invalidCursor();
    }
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    invalidCursor();
  }
  return normalizeCursor(parsed);
}

export function encodeRunCancellationBlockedCursor(
  value: Readonly<BlockedCursor>,
): string {
  const cursor = normalizeCursor(value);
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor)).toString(
    'base64url',
  )}`;
}

export function createRunCancellationBlockedListCommand(
  projectId: string,
  cursorToken?: string,
  createUuid: () => string = randomUUID,
): Readonly<ClusterRunManagementCancellationBlockedListCommand> {
  const requestId = createUuid();
  const auditEventId = createUuid();
  let failureAuditEventId = createUuid();
  for (
    let attempts = 0;
    failureAuditEventId === auditEventId && attempts < 3;
    attempts += 1
  ) {
    failureAuditEventId = createUuid();
  }
  return normalizeClusterRunManagementCommand({
    schemaVersion: 1,
    operation: 'run.cancellation.blocked.list',
    request: {
      projectId,
      requestId,
      auditEventId,
      failureAuditEventId,
      body: {
        schema: RUN_CANCELLATION_DISPATCH_BLOCKED_LIST_REQUEST_SCHEMA,
        after:
          cursorToken === undefined
            ? null
            : decodeRunCancellationBlockedCursor(cursorToken),
      },
    },
  }) as Readonly<ClusterRunManagementCancellationBlockedListCommand>;
}

export function projectRunCancellationBlockedList(
  result: Readonly<ClusterRunManagementClientResult>,
): Readonly<RunCancellationBlockedListObservation> {
  if (result.result.operation !== 'run.cancellation.blocked.list') {
    throw new TypeError('Run cancellation blocked list requires a list result');
  }
  const page = (
    result.result as ClusterRunManagementCancellationBlockedListTransportResult
  ).page;
  return Object.freeze({
    schemaVersion: 1,
    schema: RUN_CANCELLATION_BLOCKED_LIST_SCHEMA,
    component: 'qinglong3-run-management-client',
    event: 'cancellation_blocked_list_observed',
    requestId: result.requestId,
    projectId: page.projectId,
    snapshotAtMs: page.snapshotAtMs,
    observedAtMs: page.observedAtMs,
    items: page.items,
    truncated: page.truncated,
    ...(page.nextCursor === undefined
      ? {}
      : { nextCursor: encodeRunCancellationBlockedCursor(page.nextCursor) }),
  });
}

export function formatRunCancellationBlockedListCard(
  observation: Readonly<RunCancellationBlockedListObservation>,
): string {
  return [
    'QingLong 3.0 / Blocked Cancellations',
    `PROJECT       ${observation.projectId}`,
    `SNAPSHOT      ${new Date(observation.snapshotAtMs).toISOString()}`,
    `OBSERVED      ${new Date(observation.observedAtMs).toISOString()}`,
    `ITEMS         ${observation.items.length}`,
    ...observation.items.map(
      (item) =>
        `BLOCKED       ${new Date(item.blockedAtMs).toISOString()} ${item.runId}`,
    ),
    `NEXT_CURSOR   ${observation.nextCursor ?? '-'}`,
    `REQUEST       ${observation.requestId}`,
  ].join('\n');
}
