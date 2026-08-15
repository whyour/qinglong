import { Buffer } from 'node:buffer';

import type { RunEventRecord, RunRecord } from '@qinglong/runtime-core';
import {
  createStepRunMutation,
  normalizeStepRunMutation,
} from '@qinglong/runtime-core/step-run';

import {
  COPILOT_FAILURE_DIAGNOSIS_ADMISSION_RECEIPT_SCHEMA,
  MAX_COPILOT_FAILURE_DIAGNOSIS_ADMISSION_RECEIPT_BYTES,
  type CopilotFailureDiagnosisAdmissionBundle,
  type CopilotFailureDiagnosisAdmissionReceipt,
  type CopilotFailureDiagnosisExecutionPlan,
} from './contracts';
import { normalizeCopilotFailureDiagnosisExecutionPlan } from './plan';
import {
  dataRecord,
  digest,
  exactKeys,
  hash,
  identity,
  integer,
  invalid,
  runIdentity,
  timestamp,
} from './validation';

const EVIDENCE_IDENTITY_DOMAIN =
  'qinglong/copilot-failure-diagnosis-admission-evidence-identity@v1\0';
const RECEIPT_DIGEST_DOMAIN =
  'qinglong/copilot-failure-diagnosis-admission-receipt-digest@v1\0';

function evidenceIdentity(
  prefix: 'cda' | 'cdtm' | 'cdte' | 'cdmm' | 'cdme',
  planDigest: string,
): string {
  const maximumDigestLength = 35 - prefix.length;
  return `${prefix}:${hash(EVIDENCE_IDENTITY_DOMAIN, {
    prefix,
    planDigest,
  }).slice(0, maximumDigestLength)}`;
}

function receiptFields(
  value: Omit<CopilotFailureDiagnosisAdmissionReceipt, 'receiptDigest'>,
): object {
  return { ...value };
}

export function copilotFailureDiagnosisAdmissionReceiptDigest(
  value: Omit<CopilotFailureDiagnosisAdmissionReceipt, 'receiptDigest'>,
): string {
  return hash(RECEIPT_DIGEST_DOMAIN, receiptFields(value));
}

export function normalizeCopilotFailureDiagnosisAdmissionReceipt(
  value: CopilotFailureDiagnosisAdmissionReceipt,
): Readonly<CopilotFailureDiagnosisAdmissionReceipt> {
  const candidate = dataRecord(value, 'admission receipt');
  exactKeys(
    candidate,
    [
      'admittedAtMs',
      'finalRunEventSequence',
      'finalRunVersion',
      'modelEventId',
      'modelMutationId',
      'modelStepRunDigest',
      'modelStepRunId',
      'planDigest',
      'receiptDigest',
      'requestId',
      'runId',
      'schema',
      'sourceAttemptId',
      'sourceRunId',
      'sourceRunVersion',
      'toolEventId',
      'toolMutationId',
      'toolStepRunDigest',
      'toolStepRunId',
    ],
    'admission receipt',
  );
  if (candidate.schema !== COPILOT_FAILURE_DIAGNOSIS_ADMISSION_RECEIPT_SCHEMA) {
    return invalid('admission receipt schema is unsupported');
  }
  const unsigned = Object.freeze({
    schema: COPILOT_FAILURE_DIAGNOSIS_ADMISSION_RECEIPT_SCHEMA,
    requestId: identity(candidate.requestId, 'request id'),
    planDigest: digest(candidate.planDigest, 'plan digest'),
    runId: runIdentity(candidate.runId, 'diagnosis Run id'),
    sourceRunId: runIdentity(candidate.sourceRunId, 'source Run id'),
    sourceRunVersion: integer(
      candidate.sourceRunVersion,
      1,
      2_147_483_647,
      'source Run version',
    ),
    sourceAttemptId: runIdentity(
      candidate.sourceAttemptId,
      'source Attempt id',
    ),
    toolStepRunId: identity(candidate.toolStepRunId, 'Tool StepRun id'),
    toolStepRunDigest: digest(
      candidate.toolStepRunDigest,
      'Tool StepRun digest',
    ),
    toolMutationId: identity(candidate.toolMutationId, 'Tool mutation id'),
    toolEventId: identity(candidate.toolEventId, 'Tool event id'),
    modelStepRunId: identity(candidate.modelStepRunId, 'model StepRun id'),
    modelStepRunDigest: digest(
      candidate.modelStepRunDigest,
      'model StepRun digest',
    ),
    modelMutationId: identity(candidate.modelMutationId, 'model mutation id'),
    modelEventId: identity(candidate.modelEventId, 'model event id'),
    finalRunVersion: integer(
      candidate.finalRunVersion,
      3,
      3,
      'final Run version',
    ) as 3,
    finalRunEventSequence: integer(
      candidate.finalRunEventSequence,
      3,
      3,
      'final Run event sequence',
    ) as 3,
    admittedAtMs: timestamp(candidate.admittedAtMs, 'admitted time'),
  } satisfies Omit<CopilotFailureDiagnosisAdmissionReceipt, 'receiptDigest'>);
  const receiptDigest = digest(candidate.receiptDigest, 'receipt digest');
  if (
    copilotFailureDiagnosisAdmissionReceiptDigest(unsigned) !== receiptDigest
  ) {
    return invalid('admission receipt digest does not match');
  }
  const normalized = Object.freeze({ ...unsigned, receiptDigest });
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
    MAX_COPILOT_FAILURE_DIAGNOSIS_ADMISSION_RECEIPT_BYTES
  ) {
    return invalid('admission receipt exceeds its byte budget');
  }
  return normalized;
}

export function createCopilotFailureDiagnosisAdmissionBundle(
  planValue: CopilotFailureDiagnosisExecutionPlan,
): Readonly<CopilotFailureDiagnosisAdmissionBundle> {
  const plan = normalizeCopilotFailureDiagnosisExecutionPlan(planValue);
  const admissionEvent = Object.freeze({
    id: evidenceIdentity('cda', plan.planDigest),
    runId: plan.runId,
    sequence: 1,
    type: 'copilot.failure_diagnosis.admitted',
    dedupeKey: evidenceIdentity('cda', plan.planDigest),
    actorType: plan.requestedBySubject.type,
    actorId: plan.requestedBySubject.id,
    payload: Object.freeze({
      planDigest: plan.planDigest,
      sourceRunId: plan.source.runId,
      sourceRunVersion: plan.source.runVersion,
      sourceAttemptId: plan.source.attemptId,
      toolPlanDigest: plan.tool.planDigest,
      modelIntentDigest: plan.model.intentDigest,
    }),
    createdAtMs: plan.plannedAtMs,
  } satisfies RunEventRecord);
  const toolStepMutation = normalizeStepRunMutation(
    createStepRunMutation(
      {
        id: plan.toolStepRunId,
        runId: plan.runId,
        stepKey: 'collect-log',
        kind: 'tool',
        definitionRef: 'tool:qinglong.run.log.excerpt@1.0.0',
        definitionDigest: plan.tool.definitionDigest,
        required: true,
        initialStatus: 'ready',
        inputRef: `tool-invocation:${plan.tool.invocationArtifact.artifactId}`,
        mutationId: evidenceIdentity('cdtm', plan.planDigest),
        createdAtMs: plan.plannedAtMs,
      },
      {
        expectedRunVersion: 1,
        expectedRunEventSequence: 1,
        eventId: evidenceIdentity('cdte', plan.planDigest),
        dedupeKey: evidenceIdentity('cdte', plan.planDigest),
        actor: plan.requestedBySubject,
      },
    ),
  );
  const modelStepMutation = normalizeStepRunMutation(
    createStepRunMutation(
      {
        id: plan.modelStepRunId,
        runId: plan.runId,
        parentStepRunId: plan.toolStepRunId,
        stepKey: 'diagnose',
        kind: 'model',
        definitionRef: `copilot-failure-diagnosis:${plan.model.intentDigest}`,
        definitionDigest: plan.model.intentDigest,
        required: true,
        initialStatus: 'pending',
        inputRef: `tool-result-step:${plan.toolStepRunId}`,
        mutationId: evidenceIdentity('cdmm', plan.planDigest),
        createdAtMs: plan.plannedAtMs,
      },
      {
        expectedRunVersion: 2,
        expectedRunEventSequence: 2,
        eventId: evidenceIdentity('cdme', plan.planDigest),
        dedupeKey: evidenceIdentity('cdme', plan.planDigest),
        actor: plan.requestedBySubject,
      },
    ),
  );
  const run = Object.freeze({
    id: plan.runId,
    projectId: plan.projectId,
    taskId: 'copilot.failure-diagnosis',
    taskRevision: 'qinglong/copilot-failure-diagnosis@v1',
    taskName: 'Copilot failure diagnosis',
    taskSnapshotRef: `copilot-failure-diagnosis:${plan.planDigest}`,
    parentRunId: plan.source.runId,
    triggerType: 'copilot_failure_diagnosis',
    executionOrigin: 'manual' as const,
    executionOwner: 'runtime' as const,
    triggeredBy: plan.requestedBySubject.id,
    requestId: plan.requestId,
    status: 'running' as const,
    version: 3,
    eventSequence: 3,
    priority: 0,
    idempotencyKey: `copilot-diagnosis:${plan.planDigest.slice(0, 32)}`,
    createdAtMs: plan.plannedAtMs,
    startedAtMs: plan.plannedAtMs,
  } satisfies RunRecord);
  const receiptUnsigned = Object.freeze({
    schema: COPILOT_FAILURE_DIAGNOSIS_ADMISSION_RECEIPT_SCHEMA,
    requestId: plan.requestId,
    planDigest: plan.planDigest,
    runId: plan.runId,
    sourceRunId: plan.source.runId,
    sourceRunVersion: plan.source.runVersion,
    sourceAttemptId: plan.source.attemptId,
    toolStepRunId: plan.toolStepRunId,
    toolStepRunDigest: toolStepMutation.stepRun.stepRunDigest,
    toolMutationId: toolStepMutation.mutationId,
    toolEventId: toolStepMutation.event.id,
    modelStepRunId: plan.modelStepRunId,
    modelStepRunDigest: modelStepMutation.stepRun.stepRunDigest,
    modelMutationId: modelStepMutation.mutationId,
    modelEventId: modelStepMutation.event.id,
    finalRunVersion: 3 as const,
    finalRunEventSequence: 3 as const,
    admittedAtMs: plan.plannedAtMs,
  });
  const receipt = normalizeCopilotFailureDiagnosisAdmissionReceipt({
    ...receiptUnsigned,
    receiptDigest:
      copilotFailureDiagnosisAdmissionReceiptDigest(receiptUnsigned),
  });
  return Object.freeze({
    plan,
    run,
    admissionEvent,
    toolStepMutation,
    modelStepMutation,
    receipt,
  });
}
