import type { RunCancellationReason } from '../run/run';

export const MAX_LOCAL_EXECUTION_CONTROL_PAGE = 64;

export const LOCAL_EXECUTION_CONTROL_KINDS = [
  'cancellation',
  'deadline',
] as const;

export type LocalExecutionControlKind =
  (typeof LOCAL_EXECUTION_CONTROL_KINDS)[number];

export interface LocalExecutionControlCandidate {
  readonly kind: LocalExecutionControlKind;
  readonly runId: string;
  readonly attemptId: string;
  readonly dueAtMs: number;
  readonly cancelReason?: RunCancellationReason;
}

export interface LocalExecutionControlCursor {
  readonly dueAtMs: number;
  readonly kind: LocalExecutionControlKind;
  readonly attemptId: string;
}

export interface LocalExecutionControlPage {
  readonly candidates: readonly LocalExecutionControlCandidate[];
  readonly truncated: boolean;
  readonly nextCursor?: LocalExecutionControlCursor;
}

export interface LocalActiveExecutionCandidate {
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptCreatedAtMs: number;
}

export interface LocalActiveExecutionCursor {
  readonly attemptCreatedAtMs: number;
  readonly attemptId: string;
}

export interface LocalActiveExecutionPage {
  readonly candidates: readonly LocalActiveExecutionCandidate[];
  readonly truncated: boolean;
  readonly nextCursor?: LocalActiveExecutionCursor;
}

export interface LocalExecutionControlSource {
  listLocalExecutionControlCandidates(options: {
    readonly observedAtMs: number;
    readonly limit: number;
    readonly after?: LocalExecutionControlCursor;
  }): Promise<LocalExecutionControlPage>;

  listLocalActiveExecutions(options: {
    readonly limit: number;
    readonly after?: LocalActiveExecutionCursor;
  }): Promise<LocalActiveExecutionPage>;
}

const CONTROL_CANDIDATE_KEYS = Object.freeze([
  'attemptId',
  'cancelReason',
  'dueAtMs',
  'kind',
  'runId',
]);
const ACTIVE_CANDIDATE_KEYS = Object.freeze([
  'attemptCreatedAtMs',
  'attemptId',
  'runId',
]);
const CANCELLATION_REASONS = new Set<RunCancellationReason>([
  'user',
  'policy',
  'shutdown',
  'reconcile',
  'timeout',
]);

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function boundedIdentity(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    /[\0\r\n]/.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function safeTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function controlKind(value: unknown): LocalExecutionControlKind {
  if (value !== 'cancellation' && value !== 'deadline') {
    throw new TypeError('Local execution control kind is invalid');
  }
  return value;
}

export function assertLocalExecutionControlLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LOCAL_EXECUTION_CONTROL_PAGE
  ) {
    throw new RangeError(
      `limit must be between 1 and ${MAX_LOCAL_EXECUTION_CONTROL_PAGE}`,
    );
  }
}

export function normalizeLocalExecutionControlCandidate(
  value: LocalExecutionControlCandidate,
): Readonly<LocalExecutionControlCandidate> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Local execution control candidate is invalid');
  }
  const record = value as unknown as Record<string, unknown>;
  const kind = controlKind(record.kind);
  const expectedKeys =
    kind === 'cancellation'
      ? CONTROL_CANDIDATE_KEYS
      : CONTROL_CANDIDATE_KEYS.filter((key) => key !== 'cancelReason');
  if (!exactKeys(record, expectedKeys)) {
    throw new TypeError('Local execution control candidate shape is invalid');
  }
  const cancelReason = record.cancelReason;
  if (
    kind === 'cancellation' &&
    !CANCELLATION_REASONS.has(cancelReason as RunCancellationReason)
  ) {
    throw new TypeError('Local execution cancellation reason is invalid');
  }
  return Object.freeze({
    kind,
    runId: boundedIdentity(record.runId, 'runId'),
    attemptId: boundedIdentity(record.attemptId, 'attemptId'),
    dueAtMs: safeTimestamp(record.dueAtMs, 'dueAtMs'),
    ...(kind === 'cancellation'
      ? { cancelReason: cancelReason as RunCancellationReason }
      : {}),
  });
}

export function normalizeLocalExecutionControlCursor(
  value: LocalExecutionControlCursor,
): Readonly<LocalExecutionControlCursor> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value as unknown as Record<string, unknown>, [
      'attemptId',
      'dueAtMs',
      'kind',
    ])
  ) {
    throw new TypeError('Local execution control cursor is invalid');
  }
  return Object.freeze({
    dueAtMs: safeTimestamp(value.dueAtMs, 'dueAtMs'),
    kind: controlKind(value.kind),
    attemptId: boundedIdentity(value.attemptId, 'attemptId'),
  });
}

export function normalizeLocalActiveExecutionCandidate(
  value: LocalActiveExecutionCandidate,
): Readonly<LocalActiveExecutionCandidate> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value as unknown as Record<string, unknown>, ACTIVE_CANDIDATE_KEYS)
  ) {
    throw new TypeError('Local active execution candidate is invalid');
  }
  return Object.freeze({
    runId: boundedIdentity(value.runId, 'runId'),
    attemptId: boundedIdentity(value.attemptId, 'attemptId'),
    attemptCreatedAtMs: safeTimestamp(
      value.attemptCreatedAtMs,
      'attemptCreatedAtMs',
    ),
  });
}

export function normalizeLocalActiveExecutionCursor(
  value: LocalActiveExecutionCursor,
): Readonly<LocalActiveExecutionCursor> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value as unknown as Record<string, unknown>, [
      'attemptCreatedAtMs',
      'attemptId',
    ])
  ) {
    throw new TypeError('Local active execution cursor is invalid');
  }
  return Object.freeze({
    attemptCreatedAtMs: safeTimestamp(
      value.attemptCreatedAtMs,
      'attemptCreatedAtMs',
    ),
    attemptId: boundedIdentity(value.attemptId, 'attemptId'),
  });
}
