import { normalizeStepRunMutation, type StepRunMutation } from '@qinglong/runtime-core/step-run';

import type { ModelInvocationAuditRecord } from '../../model-gateway/model';
import {
  MODEL_INVOCATION_START_COMMAND_SCHEMA,
  MODEL_INVOCATION_START_SCHEMA,
  type ModelInvocationStartCommand,
  type ModelInvocationStartRecord,
} from './contracts';
import {
  START_COMMAND_DIGEST_DOMAIN,
  START_DIGEST_DOMAIN,
  assertJsonBudget,
  createModelInvocationMutationIdentity,
  dataRecord,
  digest,
  exactKeys,
  hash,
  identifier,
  integer,
  invalid,
  requestDigest,
} from './common';
import { normalizeAdmissionAudit } from './audit';

function startWithoutDigest(
  value: Readonly<ModelInvocationStartRecord>,
): Omit<ModelInvocationStartRecord, 'startDigest'> {
  const { startDigest: _startDigest, ...unsigned } = value;
  return unsigned;
}

export function normalizeModelInvocationStartRecord(
  value: ModelInvocationStartRecord,
): Readonly<ModelInvocationStartRecord> {
  const candidate = dataRecord(value, 'start record');
  exactKeys(
    candidate,
    [
      'admittedAtMs',
      'deadlineAtMs',
      'inputBytes',
      'invocationId',
      'maxOutputTokens',
      'model',
      'policyRevision',
      'projectId',
      'provider',
      'requestDigest',
      'runEventId',
      'runId',
      'schema',
      'startDigest',
      'startedStepRunDigest',
      'startedStepRunVersion',
      'stepRunId',
      'stepRunMutationDigest',
      'stepRunMutationId',
      'traceId',
    ],
    'start record',
  );
  if (value.schema !== MODEL_INVOCATION_START_SCHEMA) {
    invalid('start schema is invalid');
  }
  const normalized = Object.freeze({
    schema: MODEL_INVOCATION_START_SCHEMA,
    invocationId: identifier(value.invocationId, 'invocation id'),
    projectId: identifier(value.projectId, 'project id'),
    runId: identifier(value.runId, 'Run id'),
    stepRunId: identifier(value.stepRunId, 'StepRun id'),
    traceId: identifier(value.traceId, 'trace id'),
    provider: identifier(value.provider, 'provider'),
    model: identifier(value.model, 'model'),
    policyRevision: identifier(value.policyRevision, 'policy revision'),
    requestDigest: requestDigest(value.requestDigest),
    inputBytes: integer(value.inputBytes, 1, 256 * 1024, 'input bytes'),
    maxOutputTokens: integer(
      value.maxOutputTokens,
      1,
      32_768,
      'max output tokens',
    ),
    deadlineAtMs: integer(
      value.deadlineAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
      'deadline',
    ),
    startedStepRunVersion: integer(
      value.startedStepRunVersion,
      2,
      2_147_483_647,
      'started StepRun version',
    ),
    stepRunMutationId: identifier(
      value.stepRunMutationId,
      'StepRun mutation id',
    ),
    stepRunMutationDigest: digest(
      value.stepRunMutationDigest,
      'StepRun mutation digest',
    ),
    startedStepRunDigest: digest(
      value.startedStepRunDigest,
      'started StepRun digest',
    ),
    runEventId: identifier(value.runEventId, 'RunEvent id'),
    admittedAtMs: integer(
      value.admittedAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
      'admitted time',
    ),
    startDigest: digest(value.startDigest, 'start digest'),
  });
  const identity = createModelInvocationMutationIdentity(
    normalized.invocationId,
    'start',
  );
  if (
    normalized.deadlineAtMs <= normalized.admittedAtMs ||
    normalized.stepRunMutationId !== identity.mutationId ||
    normalized.runEventId !== identity.eventId ||
    hash(START_DIGEST_DOMAIN, startWithoutDigest(normalized)) !==
      normalized.startDigest
  ) {
    invalid('start time or digest is invalid');
  }
  assertJsonBudget(normalized, 'start record');
  return normalized;
}

function assertStartMutation(
  mutation: Readonly<StepRunMutation>,
  audit: Readonly<ModelInvocationAuditRecord>,
): void {
  const identity = createModelInvocationMutationIdentity(
    audit.requestId,
    'start',
  );
  if (
    mutation.previousStatus !== 'ready' ||
    mutation.mutationId !== identity.mutationId ||
    mutation.stepRun.kind !== 'model' ||
    mutation.stepRun.status !== 'running' ||
    mutation.stepRun.runId !== audit.runId ||
    mutation.stepRun.id !== audit.stepRunId ||
    mutation.stepRun.updatedAtMs !== audit.occurredAtMs ||
    mutation.event.id !== identity.eventId ||
    mutation.event.dedupeKey !== identity.dedupeKey ||
    mutation.event.type !== 'step.running'
  ) {
    invalid('start StepRun mutation is not exact');
  }
}

export function createModelInvocationStartCommand(
  auditValue: ModelInvocationAuditRecord,
  mutationValue: StepRunMutation,
): Readonly<ModelInvocationStartCommand> {
  const audit = normalizeAdmissionAudit(auditValue);
  const mutation = normalizeStepRunMutation(mutationValue);
  assertStartMutation(mutation, audit);
  const unsigned = Object.freeze({
    schema: MODEL_INVOCATION_START_SCHEMA,
    invocationId: audit.requestId,
    projectId: audit.projectId,
    runId: audit.runId,
    stepRunId: audit.stepRunId,
    traceId: audit.traceId,
    provider: audit.provider,
    model: audit.model,
    policyRevision: audit.policyRevision,
    requestDigest: audit.requestDigest,
    inputBytes: audit.inputBytes,
    maxOutputTokens: audit.maxOutputTokens,
    deadlineAtMs: audit.deadlineAtMs,
    startedStepRunVersion: mutation.stepRun.version,
    stepRunMutationId: mutation.mutationId,
    stepRunMutationDigest: mutation.mutationDigest,
    startedStepRunDigest: mutation.stepRun.stepRunDigest,
    runEventId: mutation.event.id,
    admittedAtMs: audit.occurredAtMs,
  });
  const start = normalizeModelInvocationStartRecord({
    ...unsigned,
    startDigest: hash(START_DIGEST_DOMAIN, unsigned),
  });
  const commandUnsigned = Object.freeze({
    schema: MODEL_INVOCATION_START_COMMAND_SCHEMA,
    start,
    stepRunMutation: mutation,
  });
  return Object.freeze({
    ...commandUnsigned,
    commandDigest: hash(START_COMMAND_DIGEST_DOMAIN, commandUnsigned),
  });
}

export function normalizeModelInvocationStartCommand(
  value: ModelInvocationStartCommand,
): Readonly<ModelInvocationStartCommand> {
  const candidate = dataRecord(value, 'start command');
  exactKeys(
    candidate,
    ['commandDigest', 'schema', 'start', 'stepRunMutation'],
    'start command',
  );
  if (value.schema !== MODEL_INVOCATION_START_COMMAND_SCHEMA) {
    invalid('start command schema is invalid');
  }
  const start = normalizeModelInvocationStartRecord(value.start);
  const mutation = normalizeStepRunMutation(value.stepRunMutation);
  const canonical = createModelInvocationStartCommand(
    {
      phase: 'admitted',
      projectId: start.projectId,
      runId: start.runId,
      stepRunId: start.stepRunId,
      traceId: start.traceId,
      requestId: start.invocationId,
      provider: start.provider,
      model: start.model,
      policyRevision: start.policyRevision,
      requestDigest: start.requestDigest,
      deadlineAtMs: start.deadlineAtMs,
      inputBytes: start.inputBytes,
      maxOutputTokens: start.maxOutputTokens,
      outputBytes: 0,
      usage: null,
      errorCode: null,
      occurredAtMs: start.admittedAtMs,
    },
    mutation,
  );
  if (
    canonical.start.startDigest !== start.startDigest ||
    digest(value.commandDigest, 'command digest') !== canonical.commandDigest
  ) {
    invalid('start command is not canonical');
  }
  return canonical;
}
