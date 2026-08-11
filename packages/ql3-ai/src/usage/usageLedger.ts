import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type {
  ModelInvocationCompletionRecord,
  ModelInvocationStartRecord,
} from '../model-invocation/modelInvocation';
import {
  normalizeModelInvocationCompletionRecord,
  normalizeModelInvocationStartRecord,
} from '../model-invocation/modelInvocation';

// Usage owns immutable metering facts derived from completed model invocations.

export const MODEL_INVOCATION_USAGE_LEDGER_SCHEMA =
  'qinglong/model-invocation-usage-ledger@v1';
export const MAX_MODEL_INVOCATION_USAGE_LEDGER_PAGE_SIZE = 128;
export const MAX_MODEL_INVOCATION_USAGE_SUMMARY_ROWS = 100_000;
export const MAX_MODEL_INVOCATION_USAGE_QUERY_WINDOW_MS =
  366 * 24 * 60 * 60_000;

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const LEDGER_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-invocation-usage-ledger-digest@v1\0',
  'utf8',
);

export interface ModelInvocationUsageLedgerRecord {
  readonly schema: typeof MODEL_INVOCATION_USAGE_LEDGER_SCHEMA;
  readonly invocationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly traceId: string;
  readonly provider: string;
  readonly model: string;
  readonly policyRevision: string;
  readonly completionDigest: string;
  readonly outcome: ModelInvocationCompletionRecord['outcome'];
  readonly settledAtMs: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costMicros: number | null;
  readonly ledgerDigest: string;
}

export interface ModelInvocationUsageLedgerCursor {
  readonly settledAtMs: number;
  readonly invocationId: string;
}

export interface ModelInvocationUsageLedgerQuery {
  readonly projectId: string;
  readonly fromMsInclusive: number;
  readonly toMsExclusive: number;
  readonly limit: number;
  readonly after?: Readonly<ModelInvocationUsageLedgerCursor>;
}

export interface ModelInvocationUsageLedgerSummaryQuery {
  readonly projectId: string;
  readonly fromMsInclusive: number;
  readonly toMsExclusive: number;
}

export interface ModelInvocationUsageLedgerPage {
  readonly records: readonly Readonly<ModelInvocationUsageLedgerRecord>[];
  readonly hasMore: boolean;
}

export interface ModelInvocationUsageLedgerSummary {
  readonly invocationCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly knownCostMicros: number;
  readonly unknownCostInvocations: number;
}

export interface ModelInvocationUsageLedgerRepository {
  findUsage(
    invocationId: string,
  ): Promise<Readonly<ModelInvocationUsageLedgerRecord> | null>;
  listProjectUsage(
    query: ModelInvocationUsageLedgerQuery,
  ): Promise<Readonly<ModelInvocationUsageLedgerPage>>;
  summarizeProjectUsage(
    query: ModelInvocationUsageLedgerSummaryQuery,
  ): Promise<Readonly<ModelInvocationUsageLedgerSummary>>;
}

export class InvalidModelInvocationUsageLedgerError extends TypeError {
  readonly code = 'MODEL_INVOCATION_USAGE_LEDGER_INVALID';

  constructor(message: string) {
    super(`Model invocation usage ledger is invalid: ${message}`);
    this.name = 'InvalidModelInvocationUsageLedgerError';
  }
}

export class ModelInvocationUsageSummaryLimitExceededError extends Error {
  readonly code = 'MODEL_INVOCATION_USAGE_SUMMARY_LIMIT_EXCEEDED';

  constructor() {
    super('Model invocation usage summary exceeds its reviewed row limit');
    this.name = 'ModelInvocationUsageSummaryLimitExceededError';
  }
}

function invalid(message: string): never {
  throw new InvalidModelInvocationUsageLedgerError(message);
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalid(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function hash(value: object): string {
  return createHash('sha256')
    .update(LEDGER_DIGEST_DOMAIN)
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function withoutDigest(
  value: Readonly<ModelInvocationUsageLedgerRecord>,
): Omit<ModelInvocationUsageLedgerRecord, 'ledgerDigest'> {
  const { ledgerDigest: _ledgerDigest, ...unsigned } = value;
  return unsigned;
}

export function normalizeModelInvocationUsageLedgerRecord(
  value: ModelInvocationUsageLedgerRecord,
): Readonly<ModelInvocationUsageLedgerRecord> {
  const candidate = dataRecord(value, 'ledger record');
  exactKeys(
    candidate,
    [
      'completionDigest',
      'costMicros',
      'inputBytes',
      'inputTokens',
      'invocationId',
      'ledgerDigest',
      'model',
      'outcome',
      'outputBytes',
      'outputTokens',
      'policyRevision',
      'projectId',
      'provider',
      'runId',
      'schema',
      'settledAtMs',
      'stepRunId',
      'totalTokens',
      'traceId',
    ],
    'ledger record',
  );
  if (
    value.schema !== MODEL_INVOCATION_USAGE_LEDGER_SCHEMA ||
    !['succeeded', 'failed', 'timed_out', 'outcome_unknown'].includes(
      value.outcome,
    )
  ) {
    invalid('schema or outcome is invalid');
  }
  const inputTokens = integer(
    value.inputTokens,
    0,
    Number.MAX_SAFE_INTEGER,
    'input token count',
  );
  const outputTokens = integer(
    value.outputTokens,
    0,
    Number.MAX_SAFE_INTEGER,
    'output token count',
  );
  const totalTokens = integer(
    value.totalTokens,
    0,
    Number.MAX_SAFE_INTEGER,
    'total token count',
  );
  if (totalTokens !== inputTokens + outputTokens) {
    invalid('total token count is inconsistent');
  }
  const normalized = Object.freeze({
    schema: MODEL_INVOCATION_USAGE_LEDGER_SCHEMA,
    invocationId: identifier(value.invocationId, 'invocation id'),
    projectId: identifier(value.projectId, 'Project id'),
    runId: identifier(value.runId, 'Run id'),
    stepRunId: identifier(value.stepRunId, 'StepRun id'),
    traceId: identifier(value.traceId, 'trace id'),
    provider: identifier(value.provider, 'provider'),
    model: identifier(value.model, 'model'),
    policyRevision: identifier(value.policyRevision, 'policy revision'),
    completionDigest: digest(value.completionDigest, 'completion digest'),
    outcome: value.outcome,
    settledAtMs: integer(
      value.settledAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
      'settlement time',
    ),
    inputBytes: integer(value.inputBytes, 1, 256 * 1024, 'input bytes'),
    outputBytes: integer(value.outputBytes, 0, 1024 * 1024, 'output bytes'),
    inputTokens,
    outputTokens,
    totalTokens,
    costMicros:
      value.costMicros === null
        ? null
        : integer(value.costMicros, 0, Number.MAX_SAFE_INTEGER, 'cost'),
    ledgerDigest: digest(value.ledgerDigest, 'ledger digest'),
  });
  if (hash(withoutDigest(normalized)) !== normalized.ledgerDigest) {
    invalid('ledger digest is invalid');
  }
  return normalized;
}

export function createModelInvocationUsageLedgerRecord(
  startValue: ModelInvocationStartRecord,
  completionValue: ModelInvocationCompletionRecord,
): Readonly<ModelInvocationUsageLedgerRecord> | null {
  const start = normalizeModelInvocationStartRecord(startValue);
  const completion = normalizeModelInvocationCompletionRecord(completionValue);
  if (
    completion.invocationId !== start.invocationId ||
    completion.projectId !== start.projectId ||
    completion.runId !== start.runId ||
    completion.stepRunId !== start.stepRunId ||
    completion.traceId !== start.traceId ||
    completion.startDigest !== start.startDigest ||
    completion.completedAtMs < start.admittedAtMs
  ) {
    invalid('completion is detached from its start');
  }
  if (!completion.usage) return null;
  const unsigned = Object.freeze({
    schema: MODEL_INVOCATION_USAGE_LEDGER_SCHEMA,
    invocationId: completion.invocationId,
    projectId: completion.projectId,
    runId: completion.runId,
    stepRunId: completion.stepRunId,
    traceId: completion.traceId,
    provider: start.provider,
    model: start.model,
    policyRevision: start.policyRevision,
    completionDigest: completion.completionDigest,
    outcome: completion.outcome,
    settledAtMs: completion.completedAtMs,
    inputBytes: start.inputBytes,
    outputBytes: completion.outputBytes,
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    totalTokens: completion.usage.totalTokens,
    costMicros: completion.usage.costMicros ?? null,
  });
  return normalizeModelInvocationUsageLedgerRecord({
    ...unsigned,
    ledgerDigest: hash(unsigned),
  });
}

function normalizeWindow(value: Record<string, unknown>): Readonly<{
  projectId: string;
  fromMsInclusive: number;
  toMsExclusive: number;
}> {
  const projectId = identifier(value.projectId, 'Project id');
  const fromMsInclusive = integer(
    value.fromMsInclusive,
    0,
    Number.MAX_SAFE_INTEGER,
    'window start',
  );
  const toMsExclusive = integer(
    value.toMsExclusive,
    1,
    Number.MAX_SAFE_INTEGER,
    'window end',
  );
  if (
    toMsExclusive <= fromMsInclusive ||
    toMsExclusive - fromMsInclusive > MAX_MODEL_INVOCATION_USAGE_QUERY_WINDOW_MS
  ) {
    invalid('query window is invalid');
  }
  return Object.freeze({ projectId, fromMsInclusive, toMsExclusive });
}

function normalizeCursor(
  value: Readonly<ModelInvocationUsageLedgerCursor>,
): Readonly<ModelInvocationUsageLedgerCursor> {
  const cursor = dataRecord(value, 'ledger cursor');
  exactKeys(cursor, ['invocationId', 'settledAtMs'], 'ledger cursor');
  return Object.freeze({
    settledAtMs: integer(
      value.settledAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
      'cursor settlement time',
    ),
    invocationId: identifier(value.invocationId, 'cursor invocation id'),
  });
}

export function normalizeModelInvocationUsageLedgerQuery(
  value: ModelInvocationUsageLedgerQuery,
): Readonly<ModelInvocationUsageLedgerQuery> {
  const query = dataRecord(value, 'ledger query');
  exactKeys(
    query,
    value.after === undefined
      ? ['fromMsInclusive', 'limit', 'projectId', 'toMsExclusive']
      : ['after', 'fromMsInclusive', 'limit', 'projectId', 'toMsExclusive'],
    'ledger query',
  );
  const window = normalizeWindow(query);
  const after =
    value.after === undefined ? undefined : normalizeCursor(value.after);
  if (
    after &&
    (after.settledAtMs < window.fromMsInclusive ||
      after.settledAtMs >= window.toMsExclusive)
  ) {
    invalid('cursor is outside the query window');
  }
  return Object.freeze({
    ...window,
    limit: integer(
      value.limit,
      1,
      MAX_MODEL_INVOCATION_USAGE_LEDGER_PAGE_SIZE,
      'query limit',
    ),
    ...(after === undefined ? {} : { after }),
  });
}

export function normalizeModelInvocationUsageLedgerSummaryQuery(
  value: ModelInvocationUsageLedgerSummaryQuery,
): Readonly<ModelInvocationUsageLedgerSummaryQuery> {
  const query = dataRecord(value, 'ledger summary query');
  exactKeys(
    query,
    ['fromMsInclusive', 'projectId', 'toMsExclusive'],
    'ledger summary query',
  );
  return normalizeWindow(query);
}
