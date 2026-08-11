import { normalizeStepRunMutation, type StepRunMutation } from '@qinglong/runtime-core/step-run';

import type { ModelInvocationAuditRecord } from '../../model-gateway/model';
import { normalizeModelUsage } from '../../model-gateway/validation';
import {
  MODEL_INVOCATION_COMPLETION_COMMAND_SCHEMA,
  MODEL_INVOCATION_COMPLETION_SCHEMA,
  MODEL_INVOCATION_OUTCOMES,
  type ModelInvocationCompletionCommand,
  type ModelInvocationCompletionRecord,
  type ModelInvocationStartRecord,
} from './contracts';
import {
  COMPLETION_COMMAND_DIGEST_DOMAIN,
  COMPLETION_DIGEST_DOMAIN,
  ERROR_CODE_PATTERN,
  assertJsonBudget,
  createModelInvocationMutationIdentity,
  dataRecord,
  digest,
  exactKeys,
  hash,
  identifier,
  integer,
  invalid,
} from './common';
import { normalizeAuditCommon, outcomeFor } from './audit';
import { normalizeModelInvocationStartRecord } from './startProtocol';

function completionWithoutDigest(
  value: Readonly<ModelInvocationCompletionRecord>,
): Omit<ModelInvocationCompletionRecord, 'completionDigest'> {
  const { completionDigest: _completionDigest, ...unsigned } = value;
  return unsigned;
}

export function normalizeModelInvocationCompletionRecord(
  value: ModelInvocationCompletionRecord,
): Readonly<ModelInvocationCompletionRecord> {
  const candidate = dataRecord(value, 'completion record');
  exactKeys(
    candidate,
    [
      'completedAtMs',
      'completedStepRunDigest',
      'completedStepRunVersion',
      'completionDigest',
      'errorCode',
      'invocationId',
      'outcome',
      'outputBytes',
      'projectId',
      'runEventId',
      'runId',
      'schema',
      'startDigest',
      'stepRunId',
      'stepRunMutationDigest',
      'stepRunMutationId',
      'traceId',
      'usage',
    ],
    'completion record',
  );
  if (
    value.schema !== MODEL_INVOCATION_COMPLETION_SCHEMA ||
    !MODEL_INVOCATION_OUTCOMES.includes(value.outcome)
  ) {
    invalid('completion schema or outcome is invalid');
  }
  const usage = value.usage === null ? null : normalizeModelUsage(value.usage);
  const errorCode =
    value.errorCode === null
      ? null
      : typeof value.errorCode === 'string' &&
        ERROR_CODE_PATTERN.test(value.errorCode)
      ? value.errorCode
      : invalid('completion error code is invalid');
  const normalized = Object.freeze({
    schema: MODEL_INVOCATION_COMPLETION_SCHEMA,
    invocationId: identifier(value.invocationId, 'invocation id'),
    projectId: identifier(value.projectId, 'project id'),
    runId: identifier(value.runId, 'Run id'),
    stepRunId: identifier(value.stepRunId, 'StepRun id'),
    traceId: identifier(value.traceId, 'trace id'),
    startDigest: digest(value.startDigest, 'start digest'),
    outcome: value.outcome,
    outputBytes: integer(value.outputBytes, 0, 1024 * 1024, 'output bytes'),
    usage,
    errorCode,
    completedStepRunVersion: integer(
      value.completedStepRunVersion,
      3,
      2_147_483_647,
      'completed StepRun version',
    ),
    stepRunMutationId: identifier(
      value.stepRunMutationId,
      'StepRun mutation id',
    ),
    stepRunMutationDigest: digest(
      value.stepRunMutationDigest,
      'StepRun mutation digest',
    ),
    completedStepRunDigest: digest(
      value.completedStepRunDigest,
      'completed StepRun digest',
    ),
    runEventId: identifier(value.runEventId, 'RunEvent id'),
    completedAtMs: integer(
      value.completedAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
      'completed time',
    ),
    completionDigest: digest(value.completionDigest, 'completion digest'),
  });
  const identity = createModelInvocationMutationIdentity(
    normalized.invocationId,
    'completion',
  );
  if (
    (normalized.outcome === 'succeeded') !==
      (normalized.usage !== null && normalized.errorCode === null) ||
    (normalized.outcome !== 'succeeded' && normalized.errorCode === null) ||
    normalized.stepRunMutationId !== identity.mutationId ||
    normalized.runEventId !== identity.eventId ||
    hash(COMPLETION_DIGEST_DOMAIN, completionWithoutDigest(normalized)) !==
      normalized.completionDigest
  ) {
    invalid('completion facts or digest are invalid');
  }
  assertJsonBudget(normalized, 'completion record');
  return normalized;
}

export function createModelInvocationCompletionCommand(
  startValue: ModelInvocationStartRecord,
  auditValue: ModelInvocationAuditRecord,
  mutationValue: StepRunMutation,
  successOutputRefValue?: string,
): Readonly<ModelInvocationCompletionCommand> {
  const start = normalizeModelInvocationStartRecord(startValue);
  const audit = normalizeAuditCommon(auditValue);
  const mutation = normalizeStepRunMutation(mutationValue);
  const outcome = outcomeFor(audit);
  const identity = createModelInvocationMutationIdentity(
    audit.requestId,
    'completion',
  );
  const successOutputRef =
    successOutputRefValue ?? `model-invocation:${start.invocationId}`;
  if (
    audit.requestId !== start.invocationId ||
    audit.projectId !== start.projectId ||
    audit.runId !== start.runId ||
    audit.stepRunId !== start.stepRunId ||
    audit.traceId !== start.traceId ||
    audit.provider !== start.provider ||
    audit.model !== start.model ||
    audit.policyRevision !== start.policyRevision ||
    audit.requestDigest !== start.requestDigest ||
    audit.deadlineAtMs !== start.deadlineAtMs ||
    audit.inputBytes !== start.inputBytes ||
    audit.maxOutputTokens !== start.maxOutputTokens ||
    audit.occurredAtMs < start.admittedAtMs ||
    mutation.previousStatus !== 'running' ||
    mutation.mutationId !== identity.mutationId ||
    mutation.expectedStepRunVersion !== start.startedStepRunVersion ||
    mutation.expectedStepRunDigest !== start.startedStepRunDigest ||
    mutation.stepRun.runId !== start.runId ||
    mutation.stepRun.id !== start.stepRunId ||
    mutation.stepRun.kind !== 'model' ||
    mutation.stepRun.status !== outcome.stepStatus ||
    mutation.stepRun.updatedAtMs !== audit.occurredAtMs ||
    mutation.event.id !== identity.eventId ||
    mutation.event.dedupeKey !== identity.dedupeKey ||
    mutation.event.type !== `step.${outcome.stepStatus}` ||
    (outcome.stepStatus === 'succeeded'
      ? mutation.stepRun.outputRef !== successOutputRef
      : mutation.stepRun.resultCode !== outcome.resultCode ||
        mutation.stepRun.errorSummary !== outcome.errorSummary)
  ) {
    invalid('completion identity or StepRun mutation is not exact');
  }
  const unsigned = Object.freeze({
    schema: MODEL_INVOCATION_COMPLETION_SCHEMA,
    invocationId: start.invocationId,
    projectId: start.projectId,
    runId: start.runId,
    stepRunId: start.stepRunId,
    traceId: start.traceId,
    startDigest: start.startDigest,
    outcome: outcome.outcome,
    outputBytes: audit.outputBytes,
    usage: audit.usage,
    errorCode: audit.errorCode,
    completedStepRunVersion: mutation.stepRun.version,
    stepRunMutationId: mutation.mutationId,
    stepRunMutationDigest: mutation.mutationDigest,
    completedStepRunDigest: mutation.stepRun.stepRunDigest,
    runEventId: mutation.event.id,
    completedAtMs: audit.occurredAtMs,
  });
  const completion = normalizeModelInvocationCompletionRecord({
    ...unsigned,
    completionDigest: hash(COMPLETION_DIGEST_DOMAIN, unsigned),
  });
  const commandUnsigned = Object.freeze({
    schema: MODEL_INVOCATION_COMPLETION_COMMAND_SCHEMA,
    start,
    completion,
    stepRunMutation: mutation,
  });
  return Object.freeze({
    ...commandUnsigned,
    commandDigest: hash(COMPLETION_COMMAND_DIGEST_DOMAIN, commandUnsigned),
  });
}

export function normalizeModelInvocationCompletionCommand(
  value: ModelInvocationCompletionCommand,
): Readonly<ModelInvocationCompletionCommand> {
  const candidate = dataRecord(value, 'completion command');
  exactKeys(
    candidate,
    ['commandDigest', 'completion', 'schema', 'start', 'stepRunMutation'],
    'completion command',
  );
  if (value.schema !== MODEL_INVOCATION_COMPLETION_COMMAND_SCHEMA) {
    invalid('completion command schema is invalid');
  }
  const start = normalizeModelInvocationStartRecord(value.start);
  const completion = normalizeModelInvocationCompletionRecord(value.completion);
  const mutation = normalizeStepRunMutation(value.stepRunMutation);
  const canonical = createModelInvocationCompletionCommand(
    start,
    {
      phase: completion.outcome === 'succeeded' ? 'completed' : 'failed',
      projectId: completion.projectId,
      runId: completion.runId,
      stepRunId: completion.stepRunId,
      traceId: completion.traceId,
      requestId: completion.invocationId,
      provider: start.provider,
      model: start.model,
      policyRevision: start.policyRevision,
      requestDigest: start.requestDigest,
      deadlineAtMs: start.deadlineAtMs,
      inputBytes: start.inputBytes,
      maxOutputTokens: start.maxOutputTokens,
      outputBytes: completion.outputBytes,
      usage: completion.usage,
      errorCode: completion.errorCode,
      occurredAtMs: completion.completedAtMs,
    },
    mutation,
    completion.outcome === 'succeeded'
      ? mutation.stepRun.outputRef ?? undefined
      : undefined,
  );
  if (
    canonical.completion.completionDigest !== completion.completionDigest ||
    digest(value.commandDigest, 'command digest') !== canonical.commandDigest
  ) {
    invalid('completion command is not canonical');
  }
  return canonical;
}
