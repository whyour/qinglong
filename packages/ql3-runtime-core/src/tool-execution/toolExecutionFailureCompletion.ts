import { createHash } from 'node:crypto';

import { normalizeStepRunMutation, type StepRunMutation } from '../run/stepRun';
import {
  normalizeToolExecutionStartBarrierRecord,
  type ToolExecutionStartBarrierRecord,
} from './toolExecutionStartBarrier';

export const TOOL_EXECUTION_FAILURE_RESULT_SCHEMA =
  'qinglong/tool-execution-failure-result@v1' as const;
export const TOOL_EXECUTION_FAILURE_COMPLETION_SCHEMA =
  'qinglong/tool-execution-failure-completion@v1' as const;
export const TOOL_EXECUTION_FAILURE_COMPLETION_COMMAND_SCHEMA =
  'qinglong/tool-execution-failure-completion-command@v1' as const;
export const MAX_TOOL_EXECUTION_FAILURE_COMPLETION_JSON_BYTES = 24 * 1024;

export const TOOL_EXECUTION_FAILURE_OUTCOMES = ['failed', 'timed_out'] as const;

export type ToolExecutionFailureOutcome =
  (typeof TOOL_EXECUTION_FAILURE_OUTCOMES)[number];

export const TOOL_EXECUTION_FAILURE_FACTS = Object.freeze({
  failed: Object.freeze({
    resultCode: 'tool_adapter_failed',
    errorSummary: 'Trusted Tool execution failed',
  }),
  timed_out: Object.freeze({
    resultCode: 'tool_deadline_exceeded',
    errorSummary: 'Trusted Tool execution deadline exceeded',
  }),
} satisfies Record<ToolExecutionFailureOutcome, Readonly<{ resultCode: string; errorSummary: string }>>);

export interface ToolExecutionFailureResult {
  readonly schema: typeof TOOL_EXECUTION_FAILURE_RESULT_SCHEMA;
  readonly startId: string;
  readonly barrierDigest: string;
  readonly adapterDigest: string;
  readonly outcome: ToolExecutionFailureOutcome;
  readonly resultCode: string;
  readonly errorSummary: string;
  readonly completedAtMs: number;
  readonly failureDigest: string;
}

export interface ToolExecutionFailureCompletionRecord {
  readonly schema: typeof TOOL_EXECUTION_FAILURE_COMPLETION_SCHEMA;
  readonly startId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly startedStepRunVersion: number;
  readonly completedStepRunVersion: number;
  readonly barrierDigest: string;
  readonly adapterDigest: string;
  readonly outcome: ToolExecutionFailureOutcome;
  readonly resultCode: string;
  readonly errorSummary: string;
  readonly stepRunMutationId: string;
  readonly stepRunMutationDigest: string;
  readonly completedStepRunDigest: string;
  readonly runEventId: string;
  readonly completedAtMs: number;
  readonly completionDigest: string;
}

export interface ToolExecutionFailureCompletionCommand {
  readonly schema: typeof TOOL_EXECUTION_FAILURE_COMPLETION_COMMAND_SCHEMA;
  readonly barrier: Readonly<ToolExecutionStartBarrierRecord>;
  readonly failure: Readonly<ToolExecutionFailureResult>;
  readonly stepRunMutation: Readonly<StepRunMutation>;
  readonly commandDigest: string;
}

export interface CommitToolExecutionFailureCompletionResult {
  readonly status: 'created' | 'existing';
  readonly completion: Readonly<ToolExecutionFailureCompletionRecord>;
}

export interface ToolExecutionFailureCompletionRepository {
  findByStartId(
    startId: string,
  ): Promise<Readonly<ToolExecutionFailureCompletionRecord> | null>;
  commit(
    command: ToolExecutionFailureCompletionCommand,
  ): Promise<Readonly<CommitToolExecutionFailureCompletionResult>>;
}

export class InvalidToolExecutionFailureCompletionError extends TypeError {
  readonly code = 'TOOL_EXECUTION_FAILURE_COMPLETION_INVALID';

  constructor(message: string) {
    super(`Tool execution failure completion is invalid: ${message}`);
    this.name = 'InvalidToolExecutionFailureCompletionError';
  }
}

export class ToolExecutionFailureCompletionConflictError extends Error {
  readonly code = 'TOOL_EXECUTION_FAILURE_COMPLETION_CONFLICT';

  constructor() {
    super('Tool execution failure completion conflicts with durable state');
    this.name = 'ToolExecutionFailureCompletionConflictError';
  }
}

export class ToolExecutionFailureCompletionUnavailableError extends Error {
  readonly code = 'TOOL_EXECUTION_FAILURE_COMPLETION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super(
      'Tool execution failure completion authority is unavailable',
      options,
    );
    this.name = 'ToolExecutionFailureCompletionUnavailableError';
  }
}

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const FAILURE_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-failure-result-digest@v1\0',
  'utf8',
);
const COMPLETION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-failure-completion-digest@v1\0',
  'utf8',
);
const COMMAND_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-failure-completion-command-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidToolExecutionFailureCompletionError(message);
}

function hash(domain: Uint8Array, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalid(`${label} is not a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function version(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 2 ||
    (value as number) > 2_147_483_647
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function outcome(value: unknown): ToolExecutionFailureOutcome {
  if (
    typeof value !== 'string' ||
    !TOOL_EXECUTION_FAILURE_OUTCOMES.includes(
      value as ToolExecutionFailureOutcome,
    )
  ) {
    return invalid('failure outcome is invalid');
  }
  return value as ToolExecutionFailureOutcome;
}

function exactFailureFacts(
  value: Readonly<{
    outcome: ToolExecutionFailureOutcome;
    resultCode: unknown;
    errorSummary: unknown;
  }>,
): Readonly<{ resultCode: string; errorSummary: string }> {
  const expected = TOOL_EXECUTION_FAILURE_FACTS[value.outcome];
  if (
    value.resultCode !== expected.resultCode ||
    value.errorSummary !== expected.errorSummary
  ) {
    return invalid('failure facts are invalid');
  }
  return expected;
}

export function normalizeToolExecutionFailureResult(
  value: ToolExecutionFailureResult,
): Readonly<ToolExecutionFailureResult> {
  const candidate = record(value, 'failure result');
  exactKeys(
    candidate,
    [
      'adapterDigest',
      'barrierDigest',
      'completedAtMs',
      'errorSummary',
      'failureDigest',
      'outcome',
      'resultCode',
      'schema',
      'startId',
    ],
    'failure result',
  );
  if (value.schema !== TOOL_EXECUTION_FAILURE_RESULT_SCHEMA) {
    return invalid('failure result schema is invalid');
  }
  const normalizedOutcome = outcome(value.outcome);
  const facts = exactFailureFacts({
    outcome: normalizedOutcome,
    resultCode: value.resultCode,
    errorSummary: value.errorSummary,
  });
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_FAILURE_RESULT_SCHEMA,
    startId: identity(value.startId, 'failure start id'),
    barrierDigest: digest(value.barrierDigest, 'failure barrier digest'),
    adapterDigest: digest(value.adapterDigest, 'failure adapter digest'),
    outcome: normalizedOutcome,
    resultCode: facts.resultCode,
    errorSummary: facts.errorSummary,
    completedAtMs: timestamp(value.completedAtMs, 'failure completion time'),
  });
  const failureDigest = digest(value.failureDigest, 'failure digest');
  if (hash(FAILURE_DIGEST_DOMAIN, unsigned) !== failureDigest) {
    return invalid('failure digest does not match');
  }
  return Object.freeze({ ...unsigned, failureDigest });
}

export function createToolExecutionFailureResult(
  barrierValue: ToolExecutionStartBarrierRecord,
  failureOutcome: ToolExecutionFailureOutcome,
  completedAtMs: number,
): Readonly<ToolExecutionFailureResult> {
  const barrier = normalizeToolExecutionStartBarrierRecord(barrierValue);
  const normalizedOutcome = outcome(failureOutcome);
  const facts = TOOL_EXECUTION_FAILURE_FACTS[normalizedOutcome];
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_FAILURE_RESULT_SCHEMA,
    startId: barrier.startId,
    barrierDigest: barrier.barrierDigest,
    adapterDigest: barrier.adapterDigest,
    outcome: normalizedOutcome,
    resultCode: facts.resultCode,
    errorSummary: facts.errorSummary,
    completedAtMs: timestamp(completedAtMs, 'failure completion time'),
  });
  if (unsigned.completedAtMs < barrier.startedAtMs) {
    return invalid('failure completion precedes durable start');
  }
  return normalizeToolExecutionFailureResult({
    ...unsigned,
    failureDigest: hash(FAILURE_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeToolExecutionFailureCompletionRecord(
  value: ToolExecutionFailureCompletionRecord,
): Readonly<ToolExecutionFailureCompletionRecord> {
  const candidate = record(value, 'failure completion');
  exactKeys(
    candidate,
    [
      'adapterDigest',
      'barrierDigest',
      'completedAtMs',
      'completedStepRunDigest',
      'completedStepRunVersion',
      'completionDigest',
      'errorSummary',
      'outcome',
      'projectId',
      'resultCode',
      'runEventId',
      'runId',
      'schema',
      'startId',
      'startedStepRunVersion',
      'stepRunId',
      'stepRunMutationDigest',
      'stepRunMutationId',
    ],
    'failure completion',
  );
  if (value.schema !== TOOL_EXECUTION_FAILURE_COMPLETION_SCHEMA) {
    return invalid('failure completion schema is invalid');
  }
  const normalizedOutcome = outcome(value.outcome);
  const facts = exactFailureFacts({
    outcome: normalizedOutcome,
    resultCode: value.resultCode,
    errorSummary: value.errorSummary,
  });
  const startedStepRunVersion = version(
    value.startedStepRunVersion,
    'started StepRun version',
  );
  const completedStepRunVersion = version(
    value.completedStepRunVersion,
    'completed StepRun version',
  );
  if (completedStepRunVersion !== startedStepRunVersion + 1) {
    return invalid('failure completion StepRun version fence is invalid');
  }
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_FAILURE_COMPLETION_SCHEMA,
    startId: identity(value.startId, 'failure completion start id'),
    projectId: identity(value.projectId, 'failure completion project id'),
    runId: identity(value.runId, 'failure completion Run id'),
    stepRunId: identity(value.stepRunId, 'failure completion StepRun id'),
    startedStepRunVersion,
    completedStepRunVersion,
    barrierDigest: digest(
      value.barrierDigest,
      'failure completion barrier digest',
    ),
    adapterDigest: digest(
      value.adapterDigest,
      'failure completion adapter digest',
    ),
    outcome: normalizedOutcome,
    resultCode: facts.resultCode,
    errorSummary: facts.errorSummary,
    stepRunMutationId: identity(
      value.stepRunMutationId,
      'failure completion mutation id',
    ),
    stepRunMutationDigest: digest(
      value.stepRunMutationDigest,
      'failure completion mutation digest',
    ),
    completedStepRunDigest: digest(
      value.completedStepRunDigest,
      'failed StepRun digest',
    ),
    runEventId: identity(value.runEventId, 'failure completion Run event id'),
    completedAtMs: timestamp(value.completedAtMs, 'failure completion time'),
  });
  if (
    Buffer.byteLength(JSON.stringify(unsigned), 'utf8') >
    MAX_TOOL_EXECUTION_FAILURE_COMPLETION_JSON_BYTES
  ) {
    return invalid('failure completion exceeds its budget');
  }
  const completionDigest = digest(
    value.completionDigest,
    'failure completion digest',
  );
  if (hash(COMPLETION_DIGEST_DOMAIN, unsigned) !== completionDigest) {
    return invalid('failure completion digest does not match');
  }
  return Object.freeze({ ...unsigned, completionDigest });
}

function completionFromParts(
  barrier: Readonly<ToolExecutionStartBarrierRecord>,
  failure: Readonly<ToolExecutionFailureResult>,
  mutation: Readonly<StepRunMutation>,
): Readonly<ToolExecutionFailureCompletionRecord> {
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_FAILURE_COMPLETION_SCHEMA,
    startId: barrier.startId,
    projectId: barrier.projectId,
    runId: barrier.runId,
    stepRunId: barrier.stepRunId,
    startedStepRunVersion: barrier.startedStepRunVersion,
    completedStepRunVersion: mutation.stepRun.version,
    barrierDigest: barrier.barrierDigest,
    adapterDigest: barrier.adapterDigest,
    outcome: failure.outcome,
    resultCode: failure.resultCode,
    errorSummary: failure.errorSummary,
    stepRunMutationId: mutation.mutationId,
    stepRunMutationDigest: mutation.mutationDigest,
    completedStepRunDigest: mutation.stepRun.stepRunDigest,
    runEventId: mutation.event.id,
    completedAtMs: failure.completedAtMs,
  });
  return normalizeToolExecutionFailureCompletionRecord({
    ...unsigned,
    completionDigest: hash(COMPLETION_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeToolExecutionFailureCompletionCommand(
  value: ToolExecutionFailureCompletionCommand,
): Readonly<ToolExecutionFailureCompletionCommand> {
  const candidate = record(value, 'failure completion command');
  exactKeys(
    candidate,
    ['barrier', 'commandDigest', 'failure', 'schema', 'stepRunMutation'],
    'failure completion command',
  );
  if (value.schema !== TOOL_EXECUTION_FAILURE_COMPLETION_COMMAND_SCHEMA) {
    return invalid('failure completion command schema is invalid');
  }
  const barrier = normalizeToolExecutionStartBarrierRecord(value.barrier);
  const failure = normalizeToolExecutionFailureResult(value.failure);
  const stepRunMutation = normalizeStepRunMutation(value.stepRunMutation);
  if (
    failure.startId !== barrier.startId ||
    failure.barrierDigest !== barrier.barrierDigest ||
    failure.adapterDigest !== barrier.adapterDigest ||
    failure.completedAtMs < barrier.startedAtMs ||
    stepRunMutation.runId !== barrier.runId ||
    stepRunMutation.stepRun.id !== barrier.stepRunId ||
    stepRunMutation.stepRun.kind !== 'tool' ||
    stepRunMutation.previousStatus !== 'running' ||
    stepRunMutation.expectedStepRunVersion !== barrier.startedStepRunVersion ||
    stepRunMutation.expectedStepRunDigest !== barrier.startedStepRunDigest ||
    stepRunMutation.stepRun.status !== failure.outcome ||
    stepRunMutation.stepRun.outputRef !== null ||
    stepRunMutation.stepRun.resultCode !== failure.resultCode ||
    stepRunMutation.stepRun.errorSummary !== failure.errorSummary ||
    stepRunMutation.stepRun.finishedAtMs !== failure.completedAtMs ||
    stepRunMutation.stepRun.updatedAtMs !== failure.completedAtMs
  ) {
    throw new ToolExecutionFailureCompletionConflictError();
  }
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_FAILURE_COMPLETION_COMMAND_SCHEMA,
    barrier,
    failure,
    stepRunMutation,
  });
  const commandDigest = digest(
    value.commandDigest,
    'failure completion command digest',
  );
  if (hash(COMMAND_DIGEST_DOMAIN, unsigned) !== commandDigest) {
    return invalid('failure completion command digest does not match');
  }
  return Object.freeze({ ...unsigned, commandDigest });
}

export function createToolExecutionFailureCompletionCommand(
  value: Omit<
    ToolExecutionFailureCompletionCommand,
    'commandDigest' | 'schema'
  >,
): Readonly<ToolExecutionFailureCompletionCommand> {
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_FAILURE_COMPLETION_COMMAND_SCHEMA,
    barrier: normalizeToolExecutionStartBarrierRecord(value.barrier),
    failure: normalizeToolExecutionFailureResult(value.failure),
    stepRunMutation: normalizeStepRunMutation(value.stepRunMutation),
  });
  return normalizeToolExecutionFailureCompletionCommand({
    ...unsigned,
    commandDigest: hash(COMMAND_DIGEST_DOMAIN, unsigned),
  });
}

export function toolExecutionFailureCompletionRecord(
  commandValue: ToolExecutionFailureCompletionCommand,
): Readonly<ToolExecutionFailureCompletionRecord> {
  const command = normalizeToolExecutionFailureCompletionCommand(commandValue);
  return completionFromParts(
    command.barrier,
    command.failure,
    command.stepRunMutation,
  );
}
