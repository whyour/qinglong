import { createHash } from 'node:crypto';

import {
  normalizeStepRunMutation,
  type StepRunMutation,
} from '@qinglong/runtime-core/step-run';

import { normalizeCopilotFailureDiagnosisExecutionPlan } from '../admission/plan';
import {
  COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_COMMAND_SCHEMA,
  COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_REASONS,
  COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_SCHEMA,
  InvalidCopilotFailureDiagnosisPreModelTerminalizationError,
  type CopilotFailureDiagnosisPreModelTerminalizationCommand,
  type CopilotFailureDiagnosisPreModelTerminalizationOutcome,
  type CopilotFailureDiagnosisPreModelTerminalizationReason,
  type CopilotFailureDiagnosisPreModelTerminalizationReceipt,
  type CopilotFailureDiagnosisPreModelTerminalizationStage,
  type CopilotFailureDiagnosisTerminalStepReference,
} from './contracts';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const RECEIPT_DOMAIN =
  'qinglong/copilot-failure-diagnosis-pre-model-terminalization-receipt@v1\0';
const COMMAND_DOMAIN =
  'qinglong/copilot-failure-diagnosis-pre-model-terminalization-command@v1\0';
const IDENTITY_DOMAIN =
  'qinglong/copilot-failure-diagnosis-pre-model-terminalization-identity@v1\0';

function invalid(message: string): never {
  throw new InvalidCopilotFailureDiagnosisPreModelTerminalizationError(message);
}

function exact(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    return invalid(`${label} shape is invalid`);
  }
}

function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
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

function hash(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

export function copilotFailureDiagnosisPreModelTerminalizationMapping(
  reason: CopilotFailureDiagnosisPreModelTerminalizationReason,
  cancellationReason?: string,
): Readonly<{
  stage: CopilotFailureDiagnosisPreModelTerminalizationStage;
  outcome: CopilotFailureDiagnosisPreModelTerminalizationOutcome;
}> {
  if (
    !COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_REASONS.includes(
      reason,
    )
  ) {
    return invalid('reason is invalid');
  }
  if (reason === 'tool_failed')
    return Object.freeze({ stage: 'tool', outcome: 'failed' });
  if (reason === 'tool_timed_out') {
    return Object.freeze({ stage: 'tool', outcome: 'timed_out' });
  }
  if (reason.startsWith('log_'))
    return Object.freeze({ stage: 'log', outcome: 'failed' });
  if (reason === 'tool_budget_exhausted' || reason === 'deadline_exceeded') {
    return Object.freeze({ stage: 'deadline', outcome: 'timed_out' });
  }
  return Object.freeze({
    stage: 'cancellation',
    outcome: cancellationReason === 'timeout' ? 'timed_out' : 'cancelled',
  });
}

export function copilotFailureDiagnosisTerminalizationIdentity(
  prefix: 'mutation' | 'step-event' | 'run-event',
  planDigest: string,
  reason: CopilotFailureDiagnosisPreModelTerminalizationReason,
  target: string,
): string {
  const digest = hash(IDENTITY_DOMAIN, { prefix, planDigest, reason, target });
  if (prefix !== 'run-event' && prefix !== 'step-event') {
    return `cdx:${digest.slice(0, 31)}`;
  }
  const hex = digest.slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '8';
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(
    12,
    16,
  )}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function terminalStep(
  value: CopilotFailureDiagnosisTerminalStepReference,
): Readonly<CopilotFailureDiagnosisTerminalStepReference> {
  exact(
    value,
    [
      'eventId',
      'mutationDigest',
      'mutationId',
      'status',
      'stepRunId',
      'version',
    ],
    'terminal Step',
  );
  if (!['failed', 'timed_out', 'cancelled'].includes(value.status)) {
    return invalid('terminal Step status is invalid');
  }
  return Object.freeze({
    stepRunId: text(value.stepRunId, ID_PATTERN, 'StepRun id'),
    status: value.status,
    version: integer(value.version, 1, 'StepRun version'),
    mutationId: text(value.mutationId, ID_PATTERN, 'mutation id'),
    mutationDigest: text(
      value.mutationDigest,
      DIGEST_PATTERN,
      'mutation digest',
    ),
    eventId: text(value.eventId, RUN_ID_PATTERN, 'event id'),
  });
}

function unsignedReceipt(
  value: Omit<
    CopilotFailureDiagnosisPreModelTerminalizationReceipt,
    'receiptDigest'
  >,
): object {
  return {
    schema: value.schema,
    requestId: value.requestId,
    planDigest: value.planDigest,
    runId: value.runId,
    stage: value.stage,
    reason: value.reason,
    outcome: value.outcome,
    evidenceDigest: value.evidenceDigest,
    toolStartId: value.toolStartId,
    toolCompletionDigest: value.toolCompletionDigest,
    terminalSteps: value.terminalSteps,
    finalRunVersion: value.finalRunVersion,
    finalRunEventSequence: value.finalRunEventSequence,
    runEventId: value.runEventId,
    finalizedAtMs: value.finalizedAtMs,
  };
}

export function copilotFailureDiagnosisPreModelTerminalizationReceiptDigest(
  value: Omit<
    CopilotFailureDiagnosisPreModelTerminalizationReceipt,
    'receiptDigest'
  >,
): string {
  return hash(RECEIPT_DOMAIN, unsignedReceipt(value));
}

export function normalizeCopilotFailureDiagnosisPreModelTerminalizationReceipt(
  value: CopilotFailureDiagnosisPreModelTerminalizationReceipt,
): Readonly<CopilotFailureDiagnosisPreModelTerminalizationReceipt> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid('receipt');
  exact(
    value,
    [
      'evidenceDigest',
      'finalRunEventSequence',
      'finalRunVersion',
      'finalizedAtMs',
      'outcome',
      'planDigest',
      'reason',
      'receiptDigest',
      'requestId',
      'runEventId',
      'runId',
      'schema',
      'stage',
      'terminalSteps',
      'toolCompletionDigest',
      'toolStartId',
    ],
    'receipt',
  );
  if (
    value.schema !== COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_SCHEMA
  ) {
    return invalid('receipt schema is invalid');
  }
  const mapping = copilotFailureDiagnosisPreModelTerminalizationMapping(
    value.reason,
  );
  if (
    value.stage !== mapping.stage ||
    (value.reason !== 'cancellation_requested' &&
      value.outcome !== mapping.outcome) ||
    (value.reason === 'cancellation_requested' &&
      !['cancelled', 'timed_out'].includes(value.outcome)) ||
    !Array.isArray(value.terminalSteps) ||
    value.terminalSteps.length < 1 ||
    value.terminalSteps.length > 2
  ) {
    return invalid('receipt state is invalid');
  }
  const terminalSteps = Object.freeze(value.terminalSteps.map(terminalStep));
  if (
    new Set(terminalSteps.map((item) => item.stepRunId)).size !==
    terminalSteps.length
  ) {
    return invalid('terminal Step identities are duplicated');
  }
  const unsigned = Object.freeze({
    schema: value.schema,
    requestId: text(value.requestId, ID_PATTERN, 'request id'),
    planDigest: text(value.planDigest, DIGEST_PATTERN, 'plan digest'),
    runId: text(value.runId, RUN_ID_PATTERN, 'Run id'),
    stage: value.stage,
    reason: value.reason,
    outcome: value.outcome,
    evidenceDigest: text(
      value.evidenceDigest,
      DIGEST_PATTERN,
      'evidence digest',
    ),
    toolStartId:
      value.toolStartId === null
        ? null
        : text(value.toolStartId, ID_PATTERN, 'Tool start id'),
    toolCompletionDigest:
      value.toolCompletionDigest === null
        ? null
        : text(
            value.toolCompletionDigest,
            DIGEST_PATTERN,
            'Tool completion digest',
          ),
    terminalSteps,
    finalRunVersion: integer(value.finalRunVersion, 1, 'final Run version'),
    finalRunEventSequence: integer(
      value.finalRunEventSequence,
      1,
      'final Run event sequence',
    ),
    runEventId: text(value.runEventId, RUN_ID_PATTERN, 'Run event id'),
    finalizedAtMs: integer(value.finalizedAtMs, 0, 'finalized time'),
  } satisfies Omit<CopilotFailureDiagnosisPreModelTerminalizationReceipt, 'receiptDigest'>);
  if (
    unsigned.finalRunVersion !== unsigned.finalRunEventSequence ||
    unsigned.runEventId !==
      copilotFailureDiagnosisTerminalizationIdentity(
        'run-event',
        unsigned.planDigest,
        unsigned.reason,
        unsigned.runId,
      ) ||
    (unsigned.stage === 'tool' || unsigned.stage === 'log') !==
      (unsigned.toolStartId !== null &&
        unsigned.toolCompletionDigest !== null) ||
    text(value.receiptDigest, DIGEST_PATTERN, 'receipt digest') !==
      copilotFailureDiagnosisPreModelTerminalizationReceiptDigest(unsigned)
  ) {
    return invalid('receipt evidence is invalid');
  }
  return Object.freeze({ ...unsigned, receiptDigest: value.receiptDigest });
}

export function createCopilotFailureDiagnosisPreModelTerminalizationReceipt(
  value: Omit<
    CopilotFailureDiagnosisPreModelTerminalizationReceipt,
    'schema' | 'runEventId' | 'receiptDigest'
  >,
): Readonly<CopilotFailureDiagnosisPreModelTerminalizationReceipt> {
  const unsigned = Object.freeze({
    schema: COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_SCHEMA,
    ...value,
    runEventId: copilotFailureDiagnosisTerminalizationIdentity(
      'run-event',
      value.planDigest,
      value.reason,
      value.runId,
    ),
  });
  return normalizeCopilotFailureDiagnosisPreModelTerminalizationReceipt({
    ...unsigned,
    receiptDigest:
      copilotFailureDiagnosisPreModelTerminalizationReceiptDigest(unsigned),
  });
}

function commandUnsigned(
  value: Omit<
    CopilotFailureDiagnosisPreModelTerminalizationCommand,
    'commandDigest'
  >,
): object {
  return {
    schema: value.schema,
    plan: value.plan,
    expectedRunVersion: value.expectedRunVersion,
    expectedRunEventSequence: value.expectedRunEventSequence,
    stepMutations: value.stepMutations,
    receipt: value.receipt,
  };
}

export function normalizeCopilotFailureDiagnosisPreModelTerminalizationCommand(
  value: CopilotFailureDiagnosisPreModelTerminalizationCommand,
): Readonly<CopilotFailureDiagnosisPreModelTerminalizationCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid('command');
  exact(
    value,
    [
      'commandDigest',
      'expectedRunEventSequence',
      'expectedRunVersion',
      'plan',
      'receipt',
      'schema',
      'stepMutations',
    ],
    'command',
  );
  if (
    value.schema !==
    COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_COMMAND_SCHEMA
  ) {
    return invalid('command schema is invalid');
  }
  const plan = normalizeCopilotFailureDiagnosisExecutionPlan(value.plan);
  const receipt =
    normalizeCopilotFailureDiagnosisPreModelTerminalizationReceipt(
      value.receipt,
    );
  if (
    !Array.isArray(value.stepMutations) ||
    value.stepMutations.length !== receipt.terminalSteps.length
  ) {
    return invalid('Step mutation count is invalid');
  }
  const stepMutations = Object.freeze(
    value.stepMutations.map(normalizeStepRunMutation),
  );
  for (let index = 0; index < stepMutations.length; index += 1) {
    const mutation = stepMutations[index]!;
    const reference = receipt.terminalSteps[index]!;
    if (
      mutation.runId !== plan.runId ||
      mutation.stepRun.id !== reference.stepRunId ||
      mutation.stepRun.status !== reference.status ||
      mutation.stepRun.version !== reference.version ||
      mutation.mutationId !== reference.mutationId ||
      mutation.mutationDigest !== reference.mutationDigest ||
      mutation.event.id !== reference.eventId
    )
      return invalid('Step mutation evidence changed');
  }
  const expectedRunVersion = integer(
    value.expectedRunVersion,
    1,
    'expected Run version',
  );
  const expectedRunEventSequence = integer(
    value.expectedRunEventSequence,
    1,
    'expected Run event sequence',
  );
  if (
    expectedRunVersion !== expectedRunEventSequence ||
    receipt.requestId !== plan.requestId ||
    receipt.planDigest !== plan.planDigest ||
    receipt.runId !== plan.runId ||
    receipt.finalRunVersion !== expectedRunVersion + stepMutations.length + 1
  )
    return invalid('command aggregate fence is invalid');
  const unsigned = Object.freeze({
    schema: value.schema,
    plan,
    expectedRunVersion,
    expectedRunEventSequence,
    stepMutations,
    receipt,
  });
  if (
    text(value.commandDigest, DIGEST_PATTERN, 'command digest') !==
    hash(COMMAND_DOMAIN, commandUnsigned(unsigned))
  ) {
    return invalid('command digest does not match');
  }
  return Object.freeze({ ...unsigned, commandDigest: value.commandDigest });
}

export function createCopilotFailureDiagnosisPreModelTerminalizationCommand(
  value: Omit<
    CopilotFailureDiagnosisPreModelTerminalizationCommand,
    'schema' | 'commandDigest'
  >,
): Readonly<CopilotFailureDiagnosisPreModelTerminalizationCommand> {
  const unsigned = Object.freeze({
    schema: COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_COMMAND_SCHEMA,
    ...value,
  });
  return normalizeCopilotFailureDiagnosisPreModelTerminalizationCommand({
    ...unsigned,
    commandDigest: hash(COMMAND_DOMAIN, commandUnsigned(unsigned)),
  });
}

export function copilotFailureDiagnosisPreModelEvidenceDigest(
  value: Readonly<{
    reason: CopilotFailureDiagnosisPreModelTerminalizationReason;
    planDigest: string;
    toolCompletionDigest?: string;
    sourceStatus?: string;
    deadlineAtMs?: number;
    observedAtMs?: number;
    requiredToolBudgetMs?: number;
    cancelRequestedAtMs?: number;
    cancelReason?: string;
  }>,
): string {
  return hash(`${IDENTITY_DOMAIN}evidence\0`, value);
}

export function terminalStepReference(
  mutation: Readonly<StepRunMutation>,
): Readonly<CopilotFailureDiagnosisTerminalStepReference> {
  const normalized = normalizeStepRunMutation(mutation);
  if (
    !['failed', 'timed_out', 'cancelled'].includes(normalized.stepRun.status)
  ) {
    return invalid('Step mutation is not terminal');
  }
  return terminalStep({
    stepRunId: normalized.stepRun.id,
    status: normalized.stepRun.status as 'failed' | 'timed_out' | 'cancelled',
    version: normalized.stepRun.version,
    mutationId: normalized.mutationId,
    mutationDigest: normalized.mutationDigest,
    eventId: normalized.event.id,
  });
}
