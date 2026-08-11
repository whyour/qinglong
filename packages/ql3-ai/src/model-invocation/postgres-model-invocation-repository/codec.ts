import {
  normalizeStepRunRecord,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';

import {
  normalizeModelInvocationPriceQuote,
  normalizeModelInvocationPriceSettlement,
  type ModelInvocationPriceQuote,
  type ModelInvocationPriceSettlement,
} from '../../pricing/pricing';
import {
  normalizeModelInvocationUsageLedgerRecord,
  type ModelInvocationUsageLedgerRecord,
} from '../../usage/usageLedger';
import {
  normalizeModelInvocationQuotaReservation,
  normalizeModelInvocationQuotaSettlement,
  type ModelInvocationQuotaReservation,
  type ModelInvocationQuotaSettlement,
} from '../../usage/usageQuota';
import {
  normalizeModelInvocationCompletionRecord,
  normalizeModelInvocationStartRecord,
  type ModelInvocationAuthoritySnapshot,
  type ModelInvocationCompletionRecord,
  type ModelInvocationStartRecord,
} from '../modelInvocation';
import {
  normalizeModelInvocationResolutionRecord,
  type ModelInvocationResolutionRecord,
} from '../modelInvocationResolution';

import type { Row } from './authority';
import {
  integer,
  jsonObject,
  nullableInteger,
  text,
  unavailable,
} from './authority';

export function parseStart(row: Row): Readonly<ModelInvocationStartRecord> {
  let start: Readonly<ModelInvocationStartRecord>;
  try {
    start = normalizeModelInvocationStartRecord(
      jsonObject(row, 'recordJson') as unknown as ModelInvocationStartRecord,
    );
  } catch (error) {
    throw unavailable(error);
  }
  if (
    start.invocationId !== text(row, 'invocationId') ||
    start.projectId !== text(row, 'projectId') ||
    start.runId !== text(row, 'runId') ||
    start.stepRunId !== text(row, 'stepRunId') ||
    start.traceId !== text(row, 'traceId') ||
    start.provider !== text(row, 'provider') ||
    start.model !== text(row, 'model') ||
    start.policyRevision !== text(row, 'policyRevision') ||
    start.requestDigest !== text(row, 'requestDigest') ||
    start.inputBytes !== integer(row, 'inputBytes') ||
    start.maxOutputTokens !== integer(row, 'maxOutputTokens') ||
    start.deadlineAtMs !== integer(row, 'deadlineAtMs') ||
    start.admittedAtMs !== integer(row, 'admittedAtMs') ||
    start.stepRunMutationId !== text(row, 'mutationId') ||
    start.stepRunMutationDigest !== text(row, 'mutationDigest') ||
    start.startedStepRunDigest !== text(row, 'stepRunDigest') ||
    start.startedStepRunVersion !== integer(row, 'stepRunVersion') ||
    start.runEventId !== text(row, 'runEventId') ||
    start.startDigest !== text(row, 'startDigest')
  ) {
    throw unavailable();
  }
  return start;
}

export function parseCompletion(
  row: Row,
): Readonly<ModelInvocationCompletionRecord> {
  let completion: Readonly<ModelInvocationCompletionRecord>;
  try {
    completion = normalizeModelInvocationCompletionRecord(
      jsonObject(
        row,
        'recordJson',
      ) as unknown as ModelInvocationCompletionRecord,
    );
  } catch (error) {
    throw unavailable(error);
  }
  if (
    completion.invocationId !== text(row, 'invocationId') ||
    completion.projectId !== text(row, 'projectId') ||
    completion.runId !== text(row, 'runId') ||
    completion.stepRunId !== text(row, 'stepRunId') ||
    completion.traceId !== text(row, 'traceId') ||
    completion.startDigest !== text(row, 'startDigest') ||
    completion.outcome !== text(row, 'outcome') ||
    completion.outputBytes !== integer(row, 'outputBytes') ||
    completion.errorCode !== row.errorCode ||
    completion.completedAtMs !== integer(row, 'completedAtMs') ||
    completion.stepRunMutationId !== text(row, 'mutationId') ||
    completion.stepRunMutationDigest !== text(row, 'mutationDigest') ||
    completion.completedStepRunDigest !== text(row, 'stepRunDigest') ||
    completion.completedStepRunVersion !== integer(row, 'stepRunVersion') ||
    completion.runEventId !== text(row, 'runEventId') ||
    completion.completionDigest !== text(row, 'completionDigest')
  ) {
    throw unavailable();
  }
  return completion;
}

export function parseUsage(
  row: Row,
): Readonly<ModelInvocationUsageLedgerRecord> {
  let usage: Readonly<ModelInvocationUsageLedgerRecord>;
  try {
    usage = normalizeModelInvocationUsageLedgerRecord(
      jsonObject(
        row,
        'recordJson',
      ) as unknown as ModelInvocationUsageLedgerRecord,
    );
  } catch (error) {
    throw unavailable(error);
  }
  if (
    usage.invocationId !== text(row, 'invocationId') ||
    usage.projectId !== text(row, 'projectId') ||
    usage.runId !== text(row, 'runId') ||
    usage.stepRunId !== text(row, 'stepRunId') ||
    usage.traceId !== text(row, 'traceId') ||
    usage.provider !== text(row, 'provider') ||
    usage.model !== text(row, 'model') ||
    usage.policyRevision !== text(row, 'policyRevision') ||
    usage.completionDigest !== text(row, 'completionDigest') ||
    usage.outcome !== text(row, 'outcome') ||
    usage.settledAtMs !== integer(row, 'settledAtMs') ||
    usage.inputBytes !== integer(row, 'inputBytes') ||
    usage.outputBytes !== integer(row, 'outputBytes') ||
    usage.inputTokens !== integer(row, 'inputTokens') ||
    usage.outputTokens !== integer(row, 'outputTokens') ||
    usage.totalTokens !== integer(row, 'totalTokens') ||
    usage.costMicros !== nullableInteger(row, 'costMicros') ||
    usage.ledgerDigest !== text(row, 'ledgerDigest')
  ) {
    throw unavailable();
  }
  return usage;
}

export function parseQuotaReservation(
  row: Row,
): Readonly<ModelInvocationQuotaReservation> {
  try {
    return normalizeModelInvocationQuotaReservation(
      jsonObject(
        row,
        'recordJson',
      ) as unknown as ModelInvocationQuotaReservation,
    );
  } catch (error) {
    throw unavailable(error);
  }
}

export function parseQuotaSettlement(
  row: Row,
  reservation: Readonly<ModelInvocationQuotaReservation>,
  completion: Readonly<ModelInvocationCompletionRecord>,
): Readonly<ModelInvocationQuotaSettlement> {
  try {
    return normalizeModelInvocationQuotaSettlement(
      jsonObject(
        row,
        'recordJson',
      ) as unknown as ModelInvocationQuotaSettlement,
      reservation,
      completion,
    );
  } catch (error) {
    throw unavailable(error);
  }
}

export function parsePriceQuote(row: Row): Readonly<ModelInvocationPriceQuote> {
  try {
    return normalizeModelInvocationPriceQuote(
      jsonObject(row, 'recordJson') as unknown as ModelInvocationPriceQuote,
    );
  } catch (error) {
    throw unavailable(error);
  }
}

export function parsePriceSettlement(
  row: Row,
  quote: Readonly<ModelInvocationPriceQuote>,
  completion: Readonly<ModelInvocationCompletionRecord>,
): Readonly<ModelInvocationPriceSettlement> {
  try {
    return normalizeModelInvocationPriceSettlement(
      jsonObject(
        row,
        'recordJson',
      ) as unknown as ModelInvocationPriceSettlement,
      quote,
      completion,
    );
  } catch (error) {
    throw unavailable(error);
  }
}

export function parseResolution(
  row: Row,
): Readonly<ModelInvocationResolutionRecord> {
  let resolution: Readonly<ModelInvocationResolutionRecord>;
  try {
    resolution = normalizeModelInvocationResolutionRecord(
      jsonObject(
        row,
        'recordJson',
      ) as unknown as ModelInvocationResolutionRecord,
    );
  } catch (error) {
    throw unavailable(error);
  }
  if (
    resolution.resolutionId !== text(row, 'resolutionId') ||
    resolution.invocationId !== text(row, 'invocationId') ||
    resolution.projectId !== text(row, 'projectId') ||
    resolution.runId !== text(row, 'runId') ||
    resolution.stepRunId !== text(row, 'stepRunId') ||
    resolution.traceId !== text(row, 'traceId') ||
    resolution.completionDigest !== text(row, 'completionDigest') ||
    resolution.decision !== text(row, 'decision') ||
    resolution.resolvedByUserId !== text(row, 'resolvedByUserId') ||
    resolution.resolvedAtMs !== integer(row, 'resolvedAtMs') ||
    resolution.stepRunMutationId !== text(row, 'mutationId') ||
    resolution.stepRunMutationDigest !== text(row, 'mutationDigest') ||
    resolution.resolvedStepRunDigest !== text(row, 'stepRunDigest') ||
    resolution.resolvedStepRunVersion !== integer(row, 'stepRunVersion') ||
    resolution.runEventId !== text(row, 'runEventId') ||
    resolution.resolutionDigest !== text(row, 'resolutionDigest')
  ) {
    throw unavailable();
  }
  return resolution;
}

export function parseAuthority(
  row: Row,
): Readonly<ModelInvocationAuthoritySnapshot> {
  let stepRun: Readonly<StepRunRecord>;
  try {
    stepRun = normalizeStepRunRecord(
      jsonObject(row, 'stepRunJson') as unknown as StepRunRecord,
    );
  } catch (error) {
    throw unavailable(error);
  }
  if (
    stepRun.id !== text(row, 'stepRunId') ||
    stepRun.runId !== text(row, 'runId') ||
    stepRun.kind !== 'model' ||
    stepRun.status !== text(row, 'stepStatus') ||
    stepRun.version !== integer(row, 'stepVersion') ||
    stepRun.stepRunDigest !== text(row, 'stepDigest')
  ) {
    throw unavailable();
  }
  return Object.freeze({
    projectId: text(row, 'projectId'),
    runId: text(row, 'runId'),
    runVersion: integer(row, 'runVersion'),
    runEventSequence: integer(row, 'runEventSequence'),
    stepRun,
  });
}

export const START_SELECT = `
  start.invocation_id AS "invocationId",
  start.project_id AS "projectId",
  start.run_id AS "runId",
  start.step_run_id AS "stepRunId",
  start.trace_id AS "traceId",
  start.provider,
  start.model,
  start.policy_revision AS "policyRevision",
  start.request_digest AS "requestDigest",
  start.input_bytes AS "inputBytes",
  start.max_output_tokens AS "maxOutputTokens",
  start.deadline_at_ms AS "deadlineAtMs",
  start.admitted_at_ms AS "admittedAtMs",
  start.mutation_id AS "mutationId",
  start.mutation_digest AS "mutationDigest",
  start.run_event_id AS "runEventId",
  start.start_digest AS "startDigest",
  start.record_json AS "recordJson",
  mutation.step_run_digest AS "stepRunDigest",
  mutation.step_run_json->>'version' AS "stepRunVersion"
`;

export const COMPLETION_SELECT = `
  completion.invocation_id AS "invocationId",
  completion.project_id AS "projectId",
  completion.run_id AS "runId",
  completion.step_run_id AS "stepRunId",
  completion.trace_id AS "traceId",
  completion.start_digest AS "startDigest",
  completion.outcome,
  completion.output_bytes AS "outputBytes",
  completion.error_code AS "errorCode",
  completion.completed_at_ms AS "completedAtMs",
  completion.mutation_id AS "mutationId",
  completion.mutation_digest AS "mutationDigest",
  completion.run_event_id AS "runEventId",
  completion.completion_digest AS "completionDigest",
  completion.record_json AS "recordJson",
  mutation.step_run_digest AS "stepRunDigest",
  mutation.step_run_json->>'version' AS "stepRunVersion"
`;

export const USAGE_SELECT = `
  usage.invocation_id AS "invocationId",
  usage.project_id AS "projectId",
  usage.run_id AS "runId",
  usage.step_run_id AS "stepRunId",
  usage.trace_id AS "traceId",
  usage.provider,
  usage.model,
  usage.policy_revision AS "policyRevision",
  usage.completion_digest AS "completionDigest",
  usage.outcome,
  usage.settled_at_ms AS "settledAtMs",
  usage.input_bytes AS "inputBytes",
  usage.output_bytes AS "outputBytes",
  usage.input_tokens AS "inputTokens",
  usage.output_tokens AS "outputTokens",
  usage.total_tokens AS "totalTokens",
  usage.cost_micros AS "costMicros",
  usage.ledger_digest AS "ledgerDigest",
  usage.record_json AS "recordJson"
`;

export const RESOLUTION_SELECT = `
  resolution.resolution_id AS "resolutionId",
  resolution.invocation_id AS "invocationId",
  resolution.project_id AS "projectId",
  resolution.run_id AS "runId",
  resolution.step_run_id AS "stepRunId",
  resolution.trace_id AS "traceId",
  resolution.completion_digest AS "completionDigest",
  resolution.decision,
  resolution.resolved_by_user_id AS "resolvedByUserId",
  resolution.resolved_at_ms AS "resolvedAtMs",
  resolution.mutation_id AS "mutationId",
  resolution.mutation_digest AS "mutationDigest",
  resolution.run_event_id AS "runEventId",
  resolution.resolution_digest AS "resolutionDigest",
  resolution.record_json AS "recordJson",
  mutation.step_run_digest AS "stepRunDigest",
  mutation.step_run_json->>'version' AS "stepRunVersion"
`;
