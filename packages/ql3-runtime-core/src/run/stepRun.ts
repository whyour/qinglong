import { createHash } from 'node:crypto';

import {
  RUN_EVENT_ACTOR_TYPES,
  type RunEventActorType,
  type RunEventRecord,
} from './run';
import { MAX_RUN_EVENT_PAYLOAD_BYTES } from './runRepository';

export const STEP_RUN_SCHEMA = 'qinglong/step-run@v1' as const;
export const STEP_RUN_MUTATION_SCHEMA =
  'qinglong/step-run-mutation@v1' as const;

export const STEP_RUN_KINDS = [
  'task',
  'tool',
  'model',
  'agent',
  'condition',
  'approval',
  'subworkflow',
] as const;
export const STEP_RUN_STATUSES = [
  'pending',
  'ready',
  'waiting_approval',
  'running',
  'lost',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
  'timed_out',
] as const;
export const STEP_RUN_TERMINAL_STATUSES = [
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
  'timed_out',
] as const;

export const MAX_STEP_RUNS_PER_RUN = 128;
export const MAX_STEP_RUN_ATTEMPTS = 64;
export const MAX_STEP_RUN_PAGE_SIZE = 128;
export const MAX_STEP_RUN_ERROR_SUMMARY_BYTES = 2 * 1024;

export type StepRunKind = (typeof STEP_RUN_KINDS)[number];
export type StepRunStatus = (typeof STEP_RUN_STATUSES)[number];
export type StepRunTerminalStatus =
  (typeof STEP_RUN_TERMINAL_STATUSES)[number];

export interface StepRunRecord {
  readonly schema: typeof STEP_RUN_SCHEMA;
  readonly id: string;
  readonly runId: string;
  readonly parentStepRunId: string | null;
  readonly stepKey: string;
  readonly kind: StepRunKind;
  readonly definitionRef: string;
  readonly definitionDigest: string;
  readonly required: boolean;
  readonly status: StepRunStatus;
  readonly version: number;
  readonly attemptCount: number;
  readonly inputRef: string | null;
  readonly outputRef: string | null;
  readonly approvalRequestId: string | null;
  readonly readyAtMs: number | null;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly resultCode: string | null;
  readonly errorSummary: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly lastMutationId: string;
  readonly stepRunDigest: string;
}

export interface CreateStepRunRecordInput {
  readonly id: string;
  readonly runId: string;
  readonly parentStepRunId?: string;
  readonly stepKey: string;
  readonly kind: StepRunKind;
  readonly definitionRef: string;
  readonly definitionDigest: string;
  readonly required: boolean;
  readonly initialStatus: 'pending' | 'ready';
  readonly inputRef?: string;
  readonly mutationId: string;
  readonly createdAtMs: number;
}

export interface TransitionStepRunRecordCommand {
  readonly expectedVersion: number;
  readonly expectedDigest: string;
  readonly mutationId: string;
  readonly to: StepRunStatus;
  readonly atMs: number;
  readonly approvalRequestId?: string;
  readonly outputRef?: string;
  readonly resultCode?: string;
  readonly errorSummary?: string;
}

export interface StepRunMutationContext {
  readonly expectedRunVersion: number;
  readonly expectedRunEventSequence: number;
  readonly eventId: string;
  readonly dedupeKey: string;
  readonly actor: Readonly<{
    type: RunEventActorType;
    id?: string;
  }>;
}

export interface StepRunMutation {
  readonly schema: typeof STEP_RUN_MUTATION_SCHEMA;
  readonly mutationId: string;
  readonly runId: string;
  readonly expectedRunVersion: number;
  readonly expectedRunEventSequence: number;
  readonly expectedStepRunVersion: number | null;
  readonly expectedStepRunDigest: string | null;
  readonly previousStatus: StepRunStatus | null;
  readonly stepRun: Readonly<StepRunRecord>;
  readonly event: Readonly<RunEventRecord>;
  readonly mutationDigest: string;
}

export interface StepRunCursor {
  readonly stepKey: string;
  readonly id: string;
}

export interface ListStepRunsQuery {
  readonly runId: string;
  readonly limit: number;
  readonly after?: StepRunCursor;
}

export interface ListStepRunsResult {
  readonly stepRuns: readonly Readonly<StepRunRecord>[];
  readonly truncated: boolean;
  readonly next?: Readonly<StepRunCursor>;
}

export interface ApplyStepRunMutationResult {
  readonly status: 'applied' | 'existing';
  readonly stepRun: Readonly<StepRunRecord>;
  readonly runVersion: number;
  readonly runEventSequence: number;
}

export interface StepRunRepository {
  findById(id: string): Promise<Readonly<StepRunRecord> | null>;
  findByRunAndStepKey(
    runId: string,
    stepKey: string,
  ): Promise<Readonly<StepRunRecord> | null>;
  listByRun(query: ListStepRunsQuery): Promise<ListStepRunsResult>;
  apply(
    mutation: StepRunMutation,
  ): Promise<Readonly<ApplyStepRunMutationResult>>;
}

export class InvalidStepRunError extends TypeError {
  readonly code = 'STEP_RUN_INVALID';

  constructor(message: string) {
    super(`StepRun is invalid: ${message}`);
    this.name = 'InvalidStepRunError';
  }
}

export class StepRunStateConflictError extends Error {
  readonly code = 'STEP_RUN_STATE_CONFLICT';

  constructor() {
    super('StepRun is not in the required state');
    this.name = 'StepRunStateConflictError';
  }
}

export class StepRunFenceConflictError extends Error {
  readonly code = 'STEP_RUN_FENCE_CONFLICT';

  constructor() {
    super('StepRun or Run aggregate fence changed');
    this.name = 'StepRunFenceConflictError';
  }
}

export class StepRunMutationConflictError extends Error {
  readonly code = 'STEP_RUN_MUTATION_CONFLICT';

  constructor() {
    super('StepRun mutation identity was reused with different content');
    this.name = 'StepRunMutationConflictError';
  }
}

export class StepRunRepositoryUnavailableError extends Error {
  readonly code = 'STEP_RUN_REPOSITORY_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('StepRun repository is unavailable', options);
    this.name = 'StepRunRepositoryUnavailableError';
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STEP_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESULT_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const STEP_RUN_DIGEST_DOMAIN = Buffer.from(
  'qinglong/step-run-digest@v1\0',
  'utf8',
);
const STEP_RUN_MUTATION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/step-run-mutation-digest@v1\0',
  'utf8',
);

const TRANSITIONS = Object.freeze<
  Readonly<Record<StepRunStatus, readonly StepRunStatus[]>>
>({
  pending: ['ready', 'skipped', 'cancelled'],
  ready: [
    'ready',
    'waiting_approval',
    'running',
    'failed',
    'skipped',
    'cancelled',
    'timed_out',
  ],
  waiting_approval: ['ready', 'running', 'cancelled', 'timed_out'],
  running: ['lost', 'succeeded', 'failed', 'cancelled', 'timed_out'],
  lost: ['ready', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  skipped: [],
  cancelled: [],
  timed_out: [],
});

function invalid(message: string): never {
  throw new InvalidStepRunError(message);
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    )
  ) {
    return invalid(`${label} must contain enumerable data properties`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function hash(domain: Buffer, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function stepKey(value: unknown): string {
  if (typeof value !== 'string' || !STEP_KEY_PATTERN.test(value)) {
    return invalid('step key is invalid');
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
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

function timestamp(value: unknown, label: string): number {
  return integer(value, 0, Number.MAX_SAFE_INTEGER, label);
}

function nullableTimestamp(value: unknown, label: string): number | null {
  return value === null ? null : timestamp(value, label);
}

function boundedText(
  value: unknown,
  maximumBytes: number,
  label: string,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    CONTROL_PATTERN.test(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function reference(value: unknown, label: string): string {
  return boundedText(value, 512, label);
}

function nullableReference(value: unknown, label: string): string | null {
  return value === null ? null : reference(value, label);
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : identifier(value, label);
}

function resultCode(value: unknown): string {
  if (typeof value !== 'string' || !RESULT_CODE_PATTERN.test(value)) {
    return invalid('result code is invalid');
  }
  return value;
}

function nullableResultCode(value: unknown): string | null {
  return value === null ? null : resultCode(value);
}

function nullableErrorSummary(value: unknown): string | null {
  return value === null
    ? null
    : boundedText(
        value,
        MAX_STEP_RUN_ERROR_SUMMARY_BYTES,
        'error summary',
      );
}

function recordWithoutDigest(
  value: Readonly<StepRunRecord>,
): Omit<StepRunRecord, 'stepRunDigest'> {
  const { stepRunDigest: _stepRunDigest, ...unsigned } = value;
  return unsigned;
}

function withRecordDigest(
  value: Omit<StepRunRecord, 'stepRunDigest'>,
): Readonly<StepRunRecord> {
  const unsigned = Object.freeze(value);
  return Object.freeze({
    ...unsigned,
    stepRunDigest: hash(STEP_RUN_DIGEST_DOMAIN, unsigned),
  });
}

function assertRecordState(
  value: Omit<StepRunRecord, 'stepRunDigest'>,
): void {
  const terminal = STEP_RUN_TERMINAL_STATUSES.includes(
    value.status as StepRunTerminalStatus,
  );
  if (
    value.updatedAtMs < value.createdAtMs ||
    (value.readyAtMs !== null &&
      (value.readyAtMs < value.createdAtMs ||
        value.readyAtMs > value.updatedAtMs)) ||
    (value.startedAtMs !== null &&
      (value.readyAtMs === null ||
        value.startedAtMs < value.readyAtMs ||
        value.startedAtMs > value.updatedAtMs)) ||
    (value.finishedAtMs !== null &&
      (value.finishedAtMs < value.createdAtMs ||
        (value.readyAtMs !== null &&
          value.finishedAtMs < value.readyAtMs) ||
        (value.startedAtMs !== null &&
          value.finishedAtMs < value.startedAtMs) ||
        value.finishedAtMs > value.updatedAtMs))
  ) {
    invalid('record time ordering is invalid');
  }
  if (
    (value.status === 'pending' &&
      (value.readyAtMs !== null ||
        value.startedAtMs !== null ||
        value.finishedAtMs !== null)) ||
    ((value.status === 'ready' || value.status === 'waiting_approval') &&
      (value.readyAtMs === null ||
        value.startedAtMs !== null ||
        value.finishedAtMs !== null)) ||
    ((value.status === 'running' || value.status === 'lost') &&
      (value.readyAtMs === null ||
        value.startedAtMs === null ||
        value.finishedAtMs !== null)) ||
    (terminal && value.finishedAtMs === null)
  ) {
    invalid('record status time shape is invalid');
  }
  if (
    (value.status === 'waiting_approval' &&
      value.approvalRequestId === null) ||
    (value.outputRef !== null && value.status !== 'succeeded') ||
    (value.status === 'succeeded' &&
      (value.resultCode !== null || value.errorSummary !== null)) ||
    ((value.status === 'failed' ||
      value.status === 'skipped' ||
      value.status === 'cancelled' ||
      value.status === 'timed_out' ||
      value.status === 'lost') &&
      value.resultCode === null) ||
    ((value.status === 'pending' ||
      value.status === 'ready' ||
      value.status === 'waiting_approval' ||
      value.status === 'running') &&
      (value.resultCode !== null || value.errorSummary !== null))
  ) {
    invalid('record result shape is invalid');
  }
  if (
    value.parentStepRunId === value.id ||
    (value.attemptCount === 0 && value.startedAtMs !== null) ||
    (value.attemptCount > 0 &&
      (value.status === 'pending' || value.status === 'ready') &&
      value.startedAtMs !== null)
  ) {
    invalid('record hierarchy or attempt shape is invalid');
  }
}

export function normalizeStepRunRecord(
  value: StepRunRecord,
): Readonly<StepRunRecord> {
  const record = dataRecord(value, 'record');
  exactKeys(
    record,
    [
      'approvalRequestId',
      'attemptCount',
      'createdAtMs',
      'definitionDigest',
      'definitionRef',
      'errorSummary',
      'finishedAtMs',
      'id',
      'inputRef',
      'kind',
      'lastMutationId',
      'outputRef',
      'parentStepRunId',
      'readyAtMs',
      'required',
      'resultCode',
      'runId',
      'schema',
      'startedAtMs',
      'status',
      'stepKey',
      'stepRunDigest',
      'updatedAtMs',
      'version',
    ],
    [],
    'record',
  );
  if (
    value.schema !== STEP_RUN_SCHEMA ||
    !STEP_RUN_KINDS.includes(value.kind) ||
    !STEP_RUN_STATUSES.includes(value.status) ||
    typeof value.required !== 'boolean'
  ) {
    invalid('record schema, kind, status or required flag is invalid');
  }
  const unsigned = Object.freeze({
    schema: STEP_RUN_SCHEMA,
    id: identifier(value.id, 'StepRun id'),
    runId: identifier(value.runId, 'Run id'),
    parentStepRunId: nullableIdentifier(
      value.parentStepRunId,
      'parent StepRun id',
    ),
    stepKey: stepKey(value.stepKey),
    kind: value.kind,
    definitionRef: reference(value.definitionRef, 'definition reference'),
    definitionDigest: digest(value.definitionDigest, 'definition digest'),
    required: value.required,
    status: value.status,
    version: integer(value.version, 1, 2_147_483_647, 'version'),
    attemptCount: integer(
      value.attemptCount,
      0,
      MAX_STEP_RUN_ATTEMPTS,
      'attempt count',
    ),
    inputRef: nullableReference(value.inputRef, 'input reference'),
    outputRef: nullableReference(value.outputRef, 'output reference'),
    approvalRequestId: nullableIdentifier(
      value.approvalRequestId,
      'approval request id',
    ),
    readyAtMs: nullableTimestamp(value.readyAtMs, 'ready time'),
    startedAtMs: nullableTimestamp(value.startedAtMs, 'started time'),
    finishedAtMs: nullableTimestamp(value.finishedAtMs, 'finished time'),
    resultCode: nullableResultCode(value.resultCode),
    errorSummary: nullableErrorSummary(value.errorSummary),
    createdAtMs: timestamp(value.createdAtMs, 'created time'),
    updatedAtMs: timestamp(value.updatedAtMs, 'updated time'),
    lastMutationId: identifier(value.lastMutationId, 'last mutation id'),
  } satisfies Omit<StepRunRecord, 'stepRunDigest'>);
  assertRecordState(unsigned);
  const stepRunDigest = digest(value.stepRunDigest, 'StepRun digest');
  if (hash(STEP_RUN_DIGEST_DOMAIN, unsigned) !== stepRunDigest) {
    invalid('record digest does not match');
  }
  return Object.freeze({ ...unsigned, stepRunDigest });
}

export function createStepRunRecord(
  value: CreateStepRunRecordInput,
): Readonly<StepRunRecord> {
  const input = dataRecord(value, 'create input');
  exactKeys(
    input,
    [
      'createdAtMs',
      'definitionDigest',
      'definitionRef',
      'id',
      'initialStatus',
      'kind',
      'mutationId',
      'required',
      'runId',
      'stepKey',
    ],
    ['inputRef', 'parentStepRunId'],
    'create input',
  );
  if (
    !STEP_RUN_KINDS.includes(value.kind) ||
    (value.initialStatus !== 'pending' && value.initialStatus !== 'ready') ||
    typeof value.required !== 'boolean'
  ) {
    invalid('create kind, status or required flag is invalid');
  }
  const createdAtMs = timestamp(value.createdAtMs, 'created time');
  return withRecordDigest({
    schema: STEP_RUN_SCHEMA,
    id: identifier(value.id, 'StepRun id'),
    runId: identifier(value.runId, 'Run id'),
    parentStepRunId:
      value.parentStepRunId === undefined
        ? null
        : identifier(value.parentStepRunId, 'parent StepRun id'),
    stepKey: stepKey(value.stepKey),
    kind: value.kind,
    definitionRef: reference(value.definitionRef, 'definition reference'),
    definitionDigest: digest(value.definitionDigest, 'definition digest'),
    required: value.required,
    status: value.initialStatus,
    version: 1,
    attemptCount: 0,
    inputRef:
      value.inputRef === undefined
        ? null
        : reference(value.inputRef, 'input reference'),
    outputRef: null,
    approvalRequestId: null,
    readyAtMs: value.initialStatus === 'ready' ? createdAtMs : null,
    startedAtMs: null,
    finishedAtMs: null,
    resultCode: null,
    errorSummary: null,
    createdAtMs,
    updatedAtMs: createdAtMs,
    lastMutationId: identifier(value.mutationId, 'mutation id'),
  });
}

export function transitionStepRunRecord(
  currentValue: StepRunRecord,
  commandValue: TransitionStepRunRecordCommand,
): Readonly<StepRunRecord> {
  const current = normalizeStepRunRecord(currentValue);
  const command = dataRecord(commandValue, 'transition command');
  exactKeys(
    command,
    [
      'atMs',
      'expectedDigest',
      'expectedVersion',
      'mutationId',
      'to',
    ],
    ['approvalRequestId', 'errorSummary', 'outputRef', 'resultCode'],
    'transition command',
  );
  if (!STEP_RUN_STATUSES.includes(commandValue.to)) {
    invalid('transition target is invalid');
  }
  const expectedVersion = integer(
    commandValue.expectedVersion,
    1,
    2_147_483_647,
    'expected version',
  );
  const expectedDigest = digest(
    commandValue.expectedDigest,
    'expected StepRun digest',
  );
  if (
    expectedVersion !== current.version ||
    expectedDigest !== current.stepRunDigest
  ) {
    throw new StepRunFenceConflictError();
  }
  if (!TRANSITIONS[current.status].includes(commandValue.to)) {
    throw new StepRunStateConflictError();
  }
  const atMs = timestamp(commandValue.atMs, 'transition time');
  if (atMs < current.updatedAtMs) {
    invalid('transition time precedes current state');
  }
  const mutationId = identifier(commandValue.mutationId, 'mutation id');
  const approvalRequestId =
    commandValue.approvalRequestId === undefined
      ? undefined
      : identifier(commandValue.approvalRequestId, 'approval request id');
  const outputRef =
    commandValue.outputRef === undefined
      ? undefined
      : reference(commandValue.outputRef, 'output reference');
  const suppliedResultCode =
    commandValue.resultCode === undefined
      ? undefined
      : resultCode(commandValue.resultCode);
  const errorSummary =
    commandValue.errorSummary === undefined
      ? undefined
      : boundedText(
          commandValue.errorSummary,
          MAX_STEP_RUN_ERROR_SUMMARY_BYTES,
          'error summary',
        );

  const requiresResult = [
    'failed',
    'skipped',
    'cancelled',
    'timed_out',
    'lost',
  ].includes(commandValue.to);
  if (
    (commandValue.to === 'waiting_approval' &&
      approvalRequestId === undefined) ||
    (commandValue.to === 'running' &&
      current.status === 'waiting_approval' &&
      (approvalRequestId === undefined ||
        approvalRequestId !== current.approvalRequestId)) ||
    (commandValue.to !== 'waiting_approval' &&
      commandValue.to !== 'running' &&
      approvalRequestId !== undefined) ||
    (commandValue.to === 'running' &&
      current.status !== 'waiting_approval' &&
      approvalRequestId !== undefined) ||
    (commandValue.to !== 'succeeded' && outputRef !== undefined) ||
    (requiresResult !== (suppliedResultCode !== undefined)) ||
    (commandValue.to !== 'failed' &&
      commandValue.to !== 'timed_out' &&
      commandValue.to !== 'lost' &&
      errorSummary !== undefined)
  ) {
    invalid('transition result or approval shape is invalid');
  }

  let readyAtMs = current.readyAtMs;
  let startedAtMs = current.startedAtMs;
  let finishedAtMs = current.finishedAtMs;
  let attemptCount = current.attemptCount;
  let nextApprovalRequestId = current.approvalRequestId;
  let nextOutputRef: string | null = null;
  let nextResultCode: string | null = null;
  let nextErrorSummary: string | null = null;

  if (commandValue.to === 'ready') {
    readyAtMs = readyAtMs ?? atMs;
    startedAtMs = null;
    finishedAtMs = null;
    nextApprovalRequestId = null;
  } else if (commandValue.to === 'waiting_approval') {
    nextApprovalRequestId = approvalRequestId!;
  } else if (commandValue.to === 'running') {
    if (attemptCount >= MAX_STEP_RUN_ATTEMPTS) {
      throw new StepRunStateConflictError();
    }
    startedAtMs = atMs;
    finishedAtMs = null;
    attemptCount += 1;
    if (approvalRequestId !== undefined) {
      nextApprovalRequestId = approvalRequestId;
    }
  } else if (
    STEP_RUN_TERMINAL_STATUSES.includes(
      commandValue.to as StepRunTerminalStatus,
    )
  ) {
    finishedAtMs = atMs;
    nextOutputRef = outputRef ?? null;
    nextResultCode = suppliedResultCode ?? null;
    nextErrorSummary = errorSummary ?? null;
  } else if (commandValue.to === 'lost') {
    nextResultCode = suppliedResultCode!;
    nextErrorSummary = errorSummary ?? null;
  }

  return withRecordDigest({
    ...recordWithoutDigest(current),
    status: commandValue.to,
    version: current.version + 1,
    attemptCount,
    outputRef: nextOutputRef,
    approvalRequestId: nextApprovalRequestId,
    readyAtMs,
    startedAtMs,
    finishedAtMs,
    resultCode: nextResultCode,
    errorSummary: nextErrorSummary,
    updatedAtMs: atMs,
    lastMutationId: mutationId,
  });
}

function normalizeActor(
  value: StepRunMutationContext['actor'],
): Readonly<{ type: RunEventActorType; id?: string }> {
  const actor = dataRecord(value, 'mutation actor');
  exactKeys(actor, ['type'], ['id'], 'mutation actor');
  if (!RUN_EVENT_ACTOR_TYPES.includes(value.type)) {
    invalid('mutation actor type is invalid');
  }
  const id =
    value.id === undefined ? undefined : identifier(value.id, 'actor id');
  return Object.freeze({
    type: value.type,
    ...(id === undefined ? {} : { id }),
  });
}

function normalizeMutationContext(
  value: StepRunMutationContext,
): Readonly<StepRunMutationContext> {
  const context = dataRecord(value, 'mutation context');
  exactKeys(
    context,
    [
      'actor',
      'dedupeKey',
      'eventId',
      'expectedRunEventSequence',
      'expectedRunVersion',
    ],
    [],
    'mutation context',
  );
  return Object.freeze({
    expectedRunVersion: integer(
      value.expectedRunVersion,
      0,
      2_147_483_647,
      'expected Run version',
    ),
    expectedRunEventSequence: integer(
      value.expectedRunEventSequence,
      0,
      2_147_483_647,
      'expected Run event sequence',
    ),
    eventId: identifier(value.eventId, 'event id'),
    dedupeKey: identifier(value.dedupeKey, 'event dedupe key'),
    actor: normalizeActor(value.actor),
  });
}

function eventFor(
  stepRun: Readonly<StepRunRecord>,
  previousStatus: StepRunStatus | null,
  context: Readonly<StepRunMutationContext>,
): Readonly<RunEventRecord> {
  const payload = Object.freeze({
    stepRunId: stepRun.id,
    stepKey: stepRun.stepKey,
    kind: stepRun.kind,
    from: previousStatus,
    to: stepRun.status,
    version: stepRun.version,
    stepRunDigest: stepRun.stepRunDigest,
  });
  if (
    Buffer.byteLength(JSON.stringify(payload), 'utf8') >
    MAX_RUN_EVENT_PAYLOAD_BYTES
  ) {
    invalid('StepRun event payload exceeds its budget');
  }
  return Object.freeze({
    id: context.eventId,
    runId: stepRun.runId,
    sequence: context.expectedRunEventSequence + 1,
    type:
      previousStatus === null
        ? 'step.created'
        : `step.${stepRun.status}`,
    dedupeKey: context.dedupeKey,
    actorType: context.actor.type,
    ...(context.actor.id === undefined
      ? {}
      : { actorId: context.actor.id }),
    stepRunId: stepRun.id,
    payload,
    createdAtMs: stepRun.updatedAtMs,
  });
}

function mutationWithoutDigest(
  value: Readonly<StepRunMutation>,
): Omit<StepRunMutation, 'mutationDigest'> {
  const { mutationDigest: _mutationDigest, ...unsigned } = value;
  return unsigned;
}

function withMutationDigest(
  value: Omit<StepRunMutation, 'mutationDigest'>,
): Readonly<StepRunMutation> {
  const unsigned = Object.freeze(value);
  return Object.freeze({
    ...unsigned,
    mutationDigest: hash(STEP_RUN_MUTATION_DIGEST_DOMAIN, unsigned),
  });
}

export function createStepRunMutation(
  createValue: CreateStepRunRecordInput,
  contextValue: StepRunMutationContext,
): Readonly<StepRunMutation> {
  const stepRun = createStepRunRecord(createValue);
  const context = normalizeMutationContext(contextValue);
  return withMutationDigest({
    schema: STEP_RUN_MUTATION_SCHEMA,
    mutationId: stepRun.lastMutationId,
    runId: stepRun.runId,
    expectedRunVersion: context.expectedRunVersion,
    expectedRunEventSequence: context.expectedRunEventSequence,
    expectedStepRunVersion: null,
    expectedStepRunDigest: null,
    previousStatus: null,
    stepRun,
    event: eventFor(stepRun, null, context),
  });
}

export function transitionStepRunMutation(
  currentValue: StepRunRecord,
  commandValue: TransitionStepRunRecordCommand,
  contextValue: StepRunMutationContext,
): Readonly<StepRunMutation> {
  const current = normalizeStepRunRecord(currentValue);
  const stepRun = transitionStepRunRecord(current, commandValue);
  const context = normalizeMutationContext(contextValue);
  return withMutationDigest({
    schema: STEP_RUN_MUTATION_SCHEMA,
    mutationId: stepRun.lastMutationId,
    runId: stepRun.runId,
    expectedRunVersion: context.expectedRunVersion,
    expectedRunEventSequence: context.expectedRunEventSequence,
    expectedStepRunVersion: current.version,
    expectedStepRunDigest: current.stepRunDigest,
    previousStatus: current.status,
    stepRun,
    event: eventFor(stepRun, current.status, context),
  });
}

function normalizeEvent(
  value: RunEventRecord,
  mutation: Omit<StepRunMutation, 'mutationDigest' | 'event'>,
): Readonly<RunEventRecord> {
  const event = dataRecord(value, 'mutation event');
  exactKeys(
    event,
    [
      'actorType',
      'createdAtMs',
      'dedupeKey',
      'id',
      'payload',
      'runId',
      'sequence',
      'stepRunId',
      'type',
    ],
    ['actorId'],
    'mutation event',
  );
  if (
    !RUN_EVENT_ACTOR_TYPES.includes(value.actorType) ||
    value.runId !== mutation.runId ||
    value.stepRunId !== mutation.stepRun.id ||
    value.sequence !== mutation.expectedRunEventSequence + 1 ||
    value.createdAtMs !== mutation.stepRun.updatedAtMs
  ) {
    invalid('mutation event binding is invalid');
  }
  const actorId =
    value.actorId === undefined
      ? undefined
      : identifier(value.actorId, 'event actor id');
  const expected = eventFor(
    mutation.stepRun,
    mutation.previousStatus,
    {
      expectedRunVersion: mutation.expectedRunVersion,
      expectedRunEventSequence: mutation.expectedRunEventSequence,
      eventId: identifier(value.id, 'event id'),
      dedupeKey: identifier(value.dedupeKey, 'event dedupe key'),
      actor: {
        type: value.actorType,
        ...(actorId === undefined ? {} : { id: actorId }),
      },
    },
  );
  const payload = dataRecord(value.payload, 'mutation event payload');
  exactKeys(
    payload,
    [
      'from',
      'kind',
      'stepKey',
      'stepRunDigest',
      'stepRunId',
      'to',
      'version',
    ],
    [],
    'mutation event payload',
  );
  const expectedPayload = expected.payload as Readonly<
    Record<string, unknown>
  >;
  if (
    value.id !== expected.id ||
    value.type !== expected.type ||
    value.dedupeKey !== expected.dedupeKey ||
    value.actorType !== expected.actorType ||
    value.actorId !== expected.actorId ||
    payload.stepRunId !== expectedPayload.stepRunId ||
    payload.stepKey !== expectedPayload.stepKey ||
    payload.kind !== expectedPayload.kind ||
    payload.from !== expectedPayload.from ||
    payload.to !== expectedPayload.to ||
    payload.version !== expectedPayload.version ||
    payload.stepRunDigest !== expectedPayload.stepRunDigest
  ) {
    invalid('mutation event does not match canonical StepRun event');
  }
  return expected;
}

export function normalizeStepRunMutation(
  value: StepRunMutation,
): Readonly<StepRunMutation> {
  const mutation = dataRecord(value, 'mutation');
  exactKeys(
    mutation,
    [
      'event',
      'expectedRunEventSequence',
      'expectedRunVersion',
      'expectedStepRunDigest',
      'expectedStepRunVersion',
      'mutationDigest',
      'mutationId',
      'previousStatus',
      'runId',
      'schema',
      'stepRun',
    ],
    [],
    'mutation',
  );
  if (
    value.schema !== STEP_RUN_MUTATION_SCHEMA ||
    (value.previousStatus !== null &&
      !STEP_RUN_STATUSES.includes(value.previousStatus))
  ) {
    invalid('mutation schema or previous status is invalid');
  }
  const stepRun = normalizeStepRunRecord(value.stepRun);
  const expectedStepRunVersion =
    value.expectedStepRunVersion === null
      ? null
      : integer(
          value.expectedStepRunVersion,
          1,
          2_147_483_647,
          'expected StepRun version',
        );
  const expectedStepRunDigest =
    value.expectedStepRunDigest === null
      ? null
      : digest(value.expectedStepRunDigest, 'expected StepRun digest');
  if (
    value.runId !== stepRun.runId ||
    value.mutationId !== stepRun.lastMutationId ||
    (expectedStepRunVersion === null) !==
      (expectedStepRunDigest === null) ||
    (value.previousStatus === null) !==
      (expectedStepRunVersion === null) ||
    stepRun.version !== (expectedStepRunVersion ?? 0) + 1
  ) {
    invalid('mutation StepRun fence is invalid');
  }
  const unsignedWithoutEvent = {
    schema: STEP_RUN_MUTATION_SCHEMA,
    mutationId: identifier(value.mutationId, 'mutation id'),
    runId: identifier(value.runId, 'Run id'),
    expectedRunVersion: integer(
      value.expectedRunVersion,
      0,
      2_147_483_647,
      'expected Run version',
    ),
    expectedRunEventSequence: integer(
      value.expectedRunEventSequence,
      0,
      2_147_483_647,
      'expected Run event sequence',
    ),
    expectedStepRunVersion,
    expectedStepRunDigest,
    previousStatus: value.previousStatus,
    stepRun,
  };
  const event = normalizeEvent(value.event, unsignedWithoutEvent);
  const unsigned = Object.freeze({ ...unsignedWithoutEvent, event });
  const mutationDigest = digest(value.mutationDigest, 'mutation digest');
  if (hash(STEP_RUN_MUTATION_DIGEST_DOMAIN, unsigned) !== mutationDigest) {
    invalid('mutation digest does not match');
  }
  return Object.freeze({ ...unsigned, mutationDigest });
}

function sameImmutableStepIdentity(
  current: Readonly<StepRunRecord>,
  next: Readonly<StepRunRecord>,
): boolean {
  return (
    current.id === next.id &&
    current.runId === next.runId &&
    current.parentStepRunId === next.parentStepRunId &&
    current.stepKey === next.stepKey &&
    current.kind === next.kind &&
    current.definitionRef === next.definitionRef &&
    current.definitionDigest === next.definitionDigest &&
    current.required === next.required &&
    current.inputRef === next.inputRef &&
    current.createdAtMs === next.createdAtMs
  );
}

function transitionCommandFromMutation(
  current: Readonly<StepRunRecord>,
  mutation: Readonly<StepRunMutation>,
): TransitionStepRunRecordCommand {
  const next = mutation.stepRun;
  const command: {
    expectedVersion: number;
    expectedDigest: string;
    mutationId: string;
    to: StepRunStatus;
    atMs: number;
    approvalRequestId?: string;
    outputRef?: string;
    resultCode?: string;
    errorSummary?: string;
  } = {
    expectedVersion: current.version,
    expectedDigest: current.stepRunDigest,
    mutationId: mutation.mutationId,
    to: next.status,
    atMs: next.updatedAtMs,
  };
  if (
    next.status === 'waiting_approval' ||
    (next.status === 'running' && current.status === 'waiting_approval')
  ) {
    if (next.approvalRequestId === null) {
      invalid('mutation approval binding is absent');
    }
    command.approvalRequestId = next.approvalRequestId;
  }
  if (next.status === 'succeeded' && next.outputRef !== null) {
    command.outputRef = next.outputRef;
  }
  if (
    next.status === 'failed' ||
    next.status === 'skipped' ||
    next.status === 'cancelled' ||
    next.status === 'timed_out' ||
    next.status === 'lost'
  ) {
    if (next.resultCode === null) {
      invalid('mutation result code is absent');
    }
    command.resultCode = next.resultCode;
    if (next.errorSummary !== null) {
      command.errorSummary = next.errorSummary;
    }
  }
  return command;
}

export function resolveStepRunMutation(
  currentValue: StepRunRecord | null,
  mutationValue: StepRunMutation,
): 'apply' | 'existing' {
  const mutation = normalizeStepRunMutation(mutationValue);
  const current =
    currentValue === null ? null : normalizeStepRunRecord(currentValue);
  if (
    current !== null &&
    current.lastMutationId === mutation.mutationId
  ) {
    if (
      current.stepRunDigest === mutation.stepRun.stepRunDigest &&
      JSON.stringify(current) === JSON.stringify(mutation.stepRun)
    ) {
      return 'existing';
    }
    throw new StepRunMutationConflictError();
  }
  if (mutation.expectedStepRunVersion === null) {
    if (current !== null) throw new StepRunFenceConflictError();
    return 'apply';
  }
  if (
    current === null ||
    current.version !== mutation.expectedStepRunVersion ||
    current.stepRunDigest !== mutation.expectedStepRunDigest ||
    current.status !== mutation.previousStatus
  ) {
    throw new StepRunFenceConflictError();
  }
  if (!sameImmutableStepIdentity(current, mutation.stepRun)) {
    invalid('mutation changes immutable StepRun identity');
  }
  const expected = transitionStepRunRecord(
    current,
    transitionCommandFromMutation(current, mutation),
  );
  if (JSON.stringify(expected) !== JSON.stringify(mutation.stepRun)) {
    invalid('mutation does not match the StepRun state machine');
  }
  return 'apply';
}

export function normalizeListStepRunsQuery(
  value: ListStepRunsQuery,
): Readonly<ListStepRunsQuery> {
  const query = dataRecord(value, 'list query');
  exactKeys(query, ['limit', 'runId'], ['after'], 'list query');
  let after: Readonly<StepRunCursor> | undefined;
  if (value.after !== undefined) {
    const cursor = dataRecord(value.after, 'list cursor');
    exactKeys(cursor, ['id', 'stepKey'], [], 'list cursor');
    after = Object.freeze({
      stepKey: stepKey(value.after.stepKey),
      id: identifier(value.after.id, 'cursor StepRun id'),
    });
  }
  return Object.freeze({
    runId: identifier(value.runId, 'Run id'),
    limit: integer(value.limit, 1, MAX_STEP_RUN_PAGE_SIZE, 'page size'),
    ...(after === undefined ? {} : { after }),
  });
}

export function normalizeListStepRunsResult(
  value: ListStepRunsResult,
  queryValue: ListStepRunsQuery,
): Readonly<ListStepRunsResult> {
  const query = normalizeListStepRunsQuery(queryValue);
  const result = dataRecord(value, 'list result');
  exactKeys(result, ['stepRuns', 'truncated'], ['next'], 'list result');
  if (
    !Array.isArray(value.stepRuns) ||
    value.stepRuns.length > query.limit ||
    typeof value.truncated !== 'boolean'
  ) {
    invalid('list result is invalid');
  }
  const stepRuns = value.stepRuns.map(normalizeStepRunRecord);
  if (
    stepRuns.some((item) => item.runId !== query.runId) ||
    stepRuns.some((item, index) => {
      const previous = stepRuns[index - 1];
      return (
        previous !== undefined &&
        (previous.stepKey > item.stepKey ||
          (previous.stepKey === item.stepKey && previous.id >= item.id))
      );
    })
  ) {
    invalid('list result ordering or Run binding is invalid');
  }
  const expectedNext =
    value.truncated && stepRuns.length > 0
      ? {
          stepKey: stepRuns.at(-1)!.stepKey,
          id: stepRuns.at(-1)!.id,
        }
      : undefined;
  if (
    (expectedNext === undefined) !== (value.next === undefined) ||
    (expectedNext !== undefined &&
      (value.next?.stepKey !== expectedNext.stepKey ||
        value.next.id !== expectedNext.id))
  ) {
    invalid('list result continuation is invalid');
  }
  return Object.freeze({
    stepRuns: Object.freeze(stepRuns),
    truncated: value.truncated,
    ...(expectedNext === undefined
      ? {}
      : { next: Object.freeze(expectedNext) }),
  });
}
