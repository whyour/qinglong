import type { StepRunStatus } from '@qinglong/runtime-core/step-run';

import type { ModelInvocationAuditRecord } from '../../model-gateway/model';
import { normalizeModelUsage } from '../../model-gateway/validation';
import type { ModelInvocationOutcome } from './contracts';
import {
  ERROR_CODE_PATTERN,
  dataRecord,
  exactKeys,
  identifier,
  integer,
  invalid,
  requestDigest,
} from './common';

export function normalizeAdmissionAudit(
  value: ModelInvocationAuditRecord,
): Readonly<ModelInvocationAuditRecord> {
  const candidate = normalizeAuditCommon(value);
  if (
    candidate.phase !== 'admitted' ||
    candidate.outputBytes !== 0 ||
    candidate.usage !== null ||
    candidate.errorCode !== null
  ) {
    invalid('admission audit facts are invalid');
  }
  return candidate;
}

export function normalizeAuditCommon(
  value: ModelInvocationAuditRecord,
): Readonly<ModelInvocationAuditRecord> {
  const candidate = dataRecord(value, 'audit record');
  exactKeys(
    candidate,
    [
      'deadlineAtMs',
      'errorCode',
      'inputBytes',
      'maxOutputTokens',
      'model',
      'occurredAtMs',
      'outputBytes',
      'phase',
      'policyRevision',
      'projectId',
      'provider',
      'requestDigest',
      'requestId',
      'runId',
      'stepRunId',
      'traceId',
      'usage',
    ],
    'audit record',
  );
  if (!['admitted', 'completed', 'failed'].includes(value.phase)) {
    invalid('audit phase is invalid');
  }
  const usage = value.usage === null ? null : normalizeModelUsage(value.usage);
  const errorCode =
    value.errorCode === null
      ? null
      : typeof value.errorCode === 'string' &&
        ERROR_CODE_PATTERN.test(value.errorCode)
      ? value.errorCode
      : invalid('audit error code is invalid');
  return Object.freeze({
    phase: value.phase,
    projectId: identifier(value.projectId, 'audit project id'),
    runId: identifier(value.runId, 'audit Run id'),
    stepRunId: identifier(value.stepRunId, 'audit StepRun id'),
    traceId: identifier(value.traceId, 'audit trace id'),
    requestId: identifier(value.requestId, 'audit request id'),
    provider: identifier(value.provider, 'audit provider'),
    model: identifier(value.model, 'audit model'),
    policyRevision: identifier(value.policyRevision, 'audit policy revision'),
    requestDigest: requestDigest(value.requestDigest),
    deadlineAtMs: integer(
      value.deadlineAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
      'audit deadline',
    ),
    inputBytes: integer(value.inputBytes, 1, 256 * 1024, 'audit input bytes'),
    maxOutputTokens: integer(
      value.maxOutputTokens,
      1,
      32_768,
      'audit max output tokens',
    ),
    outputBytes: integer(
      value.outputBytes,
      0,
      1024 * 1024,
      'audit output bytes',
    ),
    usage,
    errorCode,
    occurredAtMs: integer(
      value.occurredAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
      'audit time',
    ),
  });
}

export function outcomeFor(audit: Readonly<ModelInvocationAuditRecord>): Readonly<{
  outcome: ModelInvocationOutcome;
  stepStatus: StepRunStatus;
  resultCode?: string;
  errorSummary?: string;
}> {
  if (audit.phase === 'completed') {
    if (!audit.usage || audit.errorCode !== null) {
      invalid('successful completion facts are invalid');
    }
    return Object.freeze({ outcome: 'succeeded', stepStatus: 'succeeded' });
  }
  if (audit.phase !== 'failed' || audit.errorCode === null) {
    invalid('failed completion facts are invalid');
  }
  if (audit.errorCode === 'MODEL_INVOCATION_DEADLINE_EXCEEDED') {
    return Object.freeze({
      outcome: 'timed_out',
      stepStatus: 'timed_out',
      resultCode: 'model_deadline_exceeded',
      errorSummary: 'Model invocation deadline exceeded',
    });
  }
  if (
    audit.errorCode === 'MODEL_INVOCATION_ABORTED' ||
    audit.errorCode === 'MODEL_STREAM_CANCELLED' ||
    audit.errorCode === 'MODEL_INVOCATION_OUTCOME_UNKNOWN'
  ) {
    return Object.freeze({
      outcome: 'outcome_unknown',
      stepStatus: 'lost',
      resultCode: 'model_outcome_unknown',
      errorSummary: 'Model invocation outcome is unknown',
    });
  }
  return Object.freeze({
    outcome: 'failed',
    stepStatus: 'failed',
    resultCode: 'model_provider_failed',
    errorSummary: 'Model invocation failed',
  });
}
