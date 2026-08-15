import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
  normalizeStepRunMutation,
  normalizeStepRunRecord,
  transitionStepRunMutation,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';
import {
  normalizeToolExecutionCompletionRecord,
  type ToolExecutionCompletionRecord,
} from '@qinglong/runtime-core/tool-execution-completion';

import type { CopilotFailureDiagnosisExecutionPlan } from '../admission/contracts';
import { normalizeCopilotFailureDiagnosisExecutionPlan } from '../admission/plan';
import {
  COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_COMMAND_SCHEMA,
  COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_RECEIPT_SCHEMA,
  InvalidCopilotFailureDiagnosisToolExecutionError,
  MAX_COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_COMMAND_BYTES,
  MAX_COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_RECEIPT_BYTES,
  type CopilotFailureDiagnosisRunAuthority,
  type CopilotFailureDiagnosisToolUnlockCommand,
  type CopilotFailureDiagnosisToolUnlockReceipt,
} from './contracts';

const RECEIPT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/copilot-failure-diagnosis-tool-unlock-receipt-digest@v1\0',
  'utf8',
);
const COMMAND_DIGEST_DOMAIN = Buffer.from(
  'qinglong/copilot-failure-diagnosis-tool-unlock-command-digest@v1\0',
  'utf8',
);
const IDENTITY_DOMAIN = Buffer.from(
  'qinglong/copilot-failure-diagnosis-tool-unlock-identity@v1\0',
  'utf8',
);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function invalid(message: string): never {
  throw new InvalidCopilotFailureDiagnosisToolExecutionError(message);
}

function hash(domain: Uint8Array, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
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

function integer(value: unknown, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function evidenceIdentity(
  prefix: 'cdum' | 'cdue',
  planDigest: string,
  completionDigest: string,
): string {
  const maximumDigestLength = 35 - prefix.length;
  return `${prefix}:${hash(IDENTITY_DOMAIN, {
    prefix,
    planDigest,
    completionDigest,
  }).slice(0, maximumDigestLength)}`;
}

export function copilotFailureDiagnosisToolUnlockReceiptDigest(
  value: Omit<CopilotFailureDiagnosisToolUnlockReceipt, 'receiptDigest'>,
): string {
  return hash(RECEIPT_DIGEST_DOMAIN, value);
}

export function normalizeCopilotFailureDiagnosisToolUnlockReceipt(
  value: CopilotFailureDiagnosisToolUnlockReceipt,
): Readonly<CopilotFailureDiagnosisToolUnlockReceipt> {
  const candidate = dataRecord(value, 'Tool unlock receipt');
  exactKeys(
    candidate,
    [
      'barrierDigest',
      'finalRunEventSequence',
      'finalRunVersion',
      'modelEventId',
      'modelMutationDigest',
      'modelMutationId',
      'modelStepRunDigest',
      'modelStepRunId',
      'modelStepRunVersion',
      'planDigest',
      'receiptDigest',
      'requestId',
      'resultArtifact',
      'runId',
      'schema',
      'startId',
      'toolCompletionDigest',
      'toolStepRunId',
      'unlockedAtMs',
    ],
    'Tool unlock receipt',
  );
  if (value.schema !== COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_RECEIPT_SCHEMA) {
    return invalid('Tool unlock receipt schema is unsupported');
  }
  const artifact = dataRecord(value.resultArtifact, 'result Artifact');
  exactKeys(
    artifact,
    ['artifactDigest', 'artifactId', 'executionResultDigest', 'outputDigest'],
    'result Artifact',
  );
  const unsigned = Object.freeze({
    schema: COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_RECEIPT_SCHEMA,
    requestId: identity(value.requestId, 'request id'),
    planDigest: digest(value.planDigest, 'plan digest'),
    runId: identity(value.runId, 'Run id'),
    startId: identity(value.startId, 'start id'),
    barrierDigest: digest(value.barrierDigest, 'barrier digest'),
    toolStepRunId: identity(value.toolStepRunId, 'Tool StepRun id'),
    toolCompletionDigest: digest(
      value.toolCompletionDigest,
      'Tool completion digest',
    ),
    resultArtifact: Object.freeze({
      artifactId: identity(value.resultArtifact.artifactId, 'Artifact id'),
      artifactDigest: digest(
        value.resultArtifact.artifactDigest,
        'Artifact digest',
      ),
      outputDigest: digest(value.resultArtifact.outputDigest, 'output digest'),
      executionResultDigest: digest(
        value.resultArtifact.executionResultDigest,
        'execution result digest',
      ),
    }),
    modelStepRunId: identity(value.modelStepRunId, 'model StepRun id'),
    modelStepRunVersion: integer(
      value.modelStepRunVersion,
      2,
      'model StepRun version',
    ),
    modelStepRunDigest: digest(
      value.modelStepRunDigest,
      'model StepRun digest',
    ),
    modelMutationId: identity(value.modelMutationId, 'model mutation id'),
    modelMutationDigest: digest(
      value.modelMutationDigest,
      'model mutation digest',
    ),
    modelEventId: identity(value.modelEventId, 'model event id'),
    finalRunVersion: integer(value.finalRunVersion, 1, 'final Run version'),
    finalRunEventSequence: integer(
      value.finalRunEventSequence,
      1,
      'final Run event sequence',
    ),
    unlockedAtMs: integer(value.unlockedAtMs, 0, 'unlock time'),
  } satisfies Omit<CopilotFailureDiagnosisToolUnlockReceipt, 'receiptDigest'>);
  if (unsigned.finalRunVersion !== unsigned.finalRunEventSequence) {
    return invalid('Tool unlock Run fence is invalid');
  }
  const receiptDigest = digest(value.receiptDigest, 'receipt digest');
  if (
    copilotFailureDiagnosisToolUnlockReceiptDigest(unsigned) !== receiptDigest
  ) {
    return invalid('Tool unlock receipt digest does not match');
  }
  const normalized = Object.freeze({ ...unsigned, receiptDigest });
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
    MAX_COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_RECEIPT_BYTES
  ) {
    return invalid('Tool unlock receipt exceeds its byte budget');
  }
  return normalized;
}

function commandUnsigned(
  value: Readonly<CopilotFailureDiagnosisToolUnlockCommand>,
): Omit<CopilotFailureDiagnosisToolUnlockCommand, 'commandDigest'> {
  const { commandDigest: _commandDigest, ...unsigned } = value;
  return unsigned;
}

function validateCommandBindings(
  plan: Readonly<CopilotFailureDiagnosisExecutionPlan>,
  completion: Readonly<ToolExecutionCompletionRecord>,
  mutation: ReturnType<typeof normalizeStepRunMutation>,
  receipt: Readonly<CopilotFailureDiagnosisToolUnlockReceipt>,
): void {
  if (
    completion.projectId !== plan.projectId ||
    completion.runId !== plan.runId ||
    completion.stepRunId !== plan.toolStepRunId ||
    mutation.runId !== plan.runId ||
    mutation.previousStatus !== 'pending' ||
    mutation.stepRun.id !== plan.modelStepRunId ||
    mutation.stepRun.runId !== plan.runId ||
    mutation.stepRun.parentStepRunId !== plan.toolStepRunId ||
    mutation.stepRun.kind !== 'model' ||
    mutation.stepRun.status !== 'ready' ||
    mutation.stepRun.inputRef !== `tool-result-step:${plan.toolStepRunId}` ||
    mutation.stepRun.updatedAtMs !== completion.completedAtMs ||
    receipt.requestId !== plan.requestId ||
    receipt.planDigest !== plan.planDigest ||
    receipt.runId !== plan.runId ||
    receipt.startId !== completion.startId ||
    receipt.barrierDigest !== completion.barrierDigest ||
    receipt.toolStepRunId !== completion.stepRunId ||
    receipt.toolCompletionDigest !== completion.completionDigest ||
    JSON.stringify(receipt.resultArtifact) !==
      JSON.stringify(completion.resultArtifact) ||
    receipt.modelStepRunId !== mutation.stepRun.id ||
    receipt.modelStepRunVersion !== mutation.stepRun.version ||
    receipt.modelStepRunDigest !== mutation.stepRun.stepRunDigest ||
    receipt.modelMutationId !== mutation.mutationId ||
    receipt.modelMutationDigest !== mutation.mutationDigest ||
    receipt.modelEventId !== mutation.event.id ||
    receipt.finalRunVersion !== mutation.expectedRunVersion + 1 ||
    receipt.finalRunEventSequence !== mutation.expectedRunEventSequence + 1 ||
    receipt.unlockedAtMs !== mutation.stepRun.updatedAtMs
  ) {
    return invalid('Tool unlock command bindings are inconsistent');
  }
}

export function normalizeCopilotFailureDiagnosisToolUnlockCommand(
  value: CopilotFailureDiagnosisToolUnlockCommand,
): Readonly<CopilotFailureDiagnosisToolUnlockCommand> {
  const candidate = dataRecord(value, 'Tool unlock command');
  exactKeys(
    candidate,
    [
      'commandDigest',
      'completion',
      'modelStepRunMutation',
      'plan',
      'receipt',
      'schema',
    ],
    'Tool unlock command',
  );
  if (value.schema !== COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_COMMAND_SCHEMA) {
    return invalid('Tool unlock command schema is unsupported');
  }
  const plan = normalizeCopilotFailureDiagnosisExecutionPlan(value.plan);
  const completion = normalizeToolExecutionCompletionRecord(value.completion);
  const modelStepRunMutation = normalizeStepRunMutation(
    value.modelStepRunMutation,
  );
  const receipt = normalizeCopilotFailureDiagnosisToolUnlockReceipt(
    value.receipt,
  );
  validateCommandBindings(plan, completion, modelStepRunMutation, receipt);
  const unsigned = Object.freeze({
    schema: COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_COMMAND_SCHEMA,
    plan,
    completion,
    modelStepRunMutation,
    receipt,
  } satisfies Omit<CopilotFailureDiagnosisToolUnlockCommand, 'commandDigest'>);
  const commandDigest = digest(value.commandDigest, 'command digest');
  if (hash(COMMAND_DIGEST_DOMAIN, unsigned) !== commandDigest) {
    return invalid('Tool unlock command digest does not match');
  }
  const normalized = Object.freeze({ ...unsigned, commandDigest });
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
    MAX_COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_COMMAND_BYTES
  ) {
    return invalid('Tool unlock command exceeds its byte budget');
  }
  return normalized;
}

export function createCopilotFailureDiagnosisToolUnlockCommand(input: {
  readonly plan: CopilotFailureDiagnosisExecutionPlan;
  readonly completion: ToolExecutionCompletionRecord;
  readonly modelStepRun: StepRunRecord;
  readonly run: CopilotFailureDiagnosisRunAuthority;
}): Readonly<CopilotFailureDiagnosisToolUnlockCommand> {
  const plan = normalizeCopilotFailureDiagnosisExecutionPlan(input.plan);
  const completion = normalizeToolExecutionCompletionRecord(input.completion);
  const modelStepRun = normalizeStepRunRecord(input.modelStepRun);
  const run = dataRecord(input.run, 'Run authority');
  exactKeys(
    run,
    ['eventSequence', 'id', 'projectId', 'status', 'version'],
    'Run authority',
  );
  if (
    input.run.id !== plan.runId ||
    input.run.projectId !== plan.projectId ||
    input.run.status !== 'running' ||
    !Number.isSafeInteger(input.run.version) ||
    input.run.version < 1 ||
    !Number.isSafeInteger(input.run.eventSequence) ||
    input.run.eventSequence !== input.run.version ||
    completion.projectId !== plan.projectId ||
    completion.runId !== plan.runId ||
    completion.stepRunId !== plan.toolStepRunId ||
    modelStepRun.id !== plan.modelStepRunId ||
    modelStepRun.runId !== plan.runId ||
    modelStepRun.parentStepRunId !== plan.toolStepRunId ||
    modelStepRun.kind !== 'model' ||
    modelStepRun.status !== 'pending'
  ) {
    return invalid('Tool completion cannot unlock the model StepRun');
  }
  const mutationId = evidenceIdentity(
    'cdum',
    plan.planDigest,
    completion.completionDigest,
  );
  const eventId = evidenceIdentity(
    'cdue',
    plan.planDigest,
    completion.completionDigest,
  );
  const modelStepRunMutation = transitionStepRunMutation(
    modelStepRun,
    {
      expectedVersion: modelStepRun.version,
      expectedDigest: modelStepRun.stepRunDigest,
      mutationId,
      to: 'ready',
      atMs: completion.completedAtMs,
    },
    {
      expectedRunVersion: input.run.version,
      expectedRunEventSequence: input.run.eventSequence,
      eventId,
      dedupeKey: eventId,
      actor: Object.freeze({
        type: 'system' as const,
        id: 'copilot-runtime',
      }),
    },
  );
  const receiptUnsigned = Object.freeze({
    schema: COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_RECEIPT_SCHEMA,
    requestId: plan.requestId,
    planDigest: plan.planDigest,
    runId: plan.runId,
    startId: completion.startId,
    barrierDigest: completion.barrierDigest,
    toolStepRunId: completion.stepRunId,
    toolCompletionDigest: completion.completionDigest,
    resultArtifact: completion.resultArtifact,
    modelStepRunId: modelStepRunMutation.stepRun.id,
    modelStepRunVersion: modelStepRunMutation.stepRun.version,
    modelStepRunDigest: modelStepRunMutation.stepRun.stepRunDigest,
    modelMutationId: modelStepRunMutation.mutationId,
    modelMutationDigest: modelStepRunMutation.mutationDigest,
    modelEventId: modelStepRunMutation.event.id,
    finalRunVersion: modelStepRunMutation.expectedRunVersion + 1,
    finalRunEventSequence: modelStepRunMutation.expectedRunEventSequence + 1,
    unlockedAtMs: completion.completedAtMs,
  } satisfies Omit<CopilotFailureDiagnosisToolUnlockReceipt, 'receiptDigest'>);
  const receipt = normalizeCopilotFailureDiagnosisToolUnlockReceipt({
    ...receiptUnsigned,
    receiptDigest:
      copilotFailureDiagnosisToolUnlockReceiptDigest(receiptUnsigned),
  });
  const unsigned = Object.freeze({
    schema: COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_COMMAND_SCHEMA,
    plan,
    completion,
    modelStepRunMutation,
    receipt,
  } satisfies Omit<CopilotFailureDiagnosisToolUnlockCommand, 'commandDigest'>);
  return normalizeCopilotFailureDiagnosisToolUnlockCommand({
    ...unsigned,
    commandDigest: hash(COMMAND_DIGEST_DOMAIN, unsigned),
  });
}
