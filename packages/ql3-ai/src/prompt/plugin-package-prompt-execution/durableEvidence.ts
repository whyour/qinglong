import { Buffer } from 'node:buffer';

import type { RunEventRecord, RunRecord } from '@qinglong/runtime-core';
import {
  createStepRunMutation,
  normalizeStepRunMutation,
} from '@qinglong/runtime-core/step-run';

import {
  MAX_PLUGIN_PACKAGE_PROMPT_ADMISSION_RECEIPT_BYTES,
  MAX_PLUGIN_PACKAGE_PROMPT_FINALIZATION_RECEIPT_BYTES,
  PLUGIN_PACKAGE_PROMPT_ADMISSION_RECEIPT_SCHEMA,
  PLUGIN_PACKAGE_PROMPT_FINALIZATION_RECEIPT_SCHEMA,
  PLUGIN_PACKAGE_PROMPT_FINAL_RUN_STATUSES,
  PLUGIN_PACKAGE_PROMPT_TERMINAL_EVIDENCE_KINDS,
  type PluginPackagePromptAdmissionBundle,
  type PluginPackagePromptAdmissionReceipt,
  type PluginPackagePromptExecutionPlan,
  type PluginPackagePromptFinalizationReceipt,
} from './contracts';
import { normalizePluginPackagePromptExecutionPlan } from './plan';
import {
  dataRecord,
  digest,
  exactKeys,
  hash,
  identity,
  invalid,
  positiveInteger,
  timestamp,
} from './validation';

const IDENTITY_DOMAIN =
  'qinglong/plugin-package-prompt-execution-identity@v1\0';
const RECEIPT_DIGEST_DOMAIN =
  'qinglong/plugin-package-prompt-admission-receipt-digest@v1\0';
const FINALIZATION_RECEIPT_DIGEST_DOMAIN =
  'qinglong/plugin-package-prompt-finalization-receipt-digest@v1\0';
const FINALIZATION_IDENTITY_DOMAIN =
  'qinglong/plugin-package-prompt-finalization-identity@v1\0';

function admissionIdentity(
  prefix: 'ppa' | 'ppm' | 'ppe',
  planDigest: string,
): string {
  return `${prefix}:${hash(IDENTITY_DOMAIN, { prefix, planDigest }).slice(
    0,
    32,
  )}`;
}

function receiptFields(
  value: Omit<PluginPackagePromptAdmissionReceipt, 'receiptDigest'>,
): object {
  return {
    schema: value.schema,
    requestId: value.requestId,
    invocationId: value.invocationId,
    planDigest: value.planDigest,
    runId: value.runId,
    stepRunId: value.stepRunId,
    stepRunDigest: value.stepRunDigest,
    mutationId: value.mutationId,
    eventId: value.eventId,
    publicationDigest: value.publicationDigest,
    promptId: value.promptId,
    finalRunVersion: value.finalRunVersion,
    finalRunEventSequence: value.finalRunEventSequence,
    admittedAtMs: value.admittedAtMs,
  };
}

export function pluginPackagePromptAdmissionReceiptDigest(
  value: Omit<PluginPackagePromptAdmissionReceipt, 'receiptDigest'>,
): string {
  return hash(RECEIPT_DIGEST_DOMAIN, receiptFields(value));
}

export function normalizePluginPackagePromptAdmissionReceipt(
  value: PluginPackagePromptAdmissionReceipt,
): Readonly<PluginPackagePromptAdmissionReceipt> {
  const receipt = dataRecord(value, 'Prompt admission receipt');
  exactKeys(
    receipt,
    [
      'schema',
      'requestId',
      'invocationId',
      'planDigest',
      'runId',
      'stepRunId',
      'stepRunDigest',
      'mutationId',
      'eventId',
      'publicationDigest',
      'promptId',
      'finalRunVersion',
      'finalRunEventSequence',
      'admittedAtMs',
      'receiptDigest',
    ],
    [],
    'Prompt admission receipt',
  );
  if (value.schema !== PLUGIN_PACKAGE_PROMPT_ADMISSION_RECEIPT_SCHEMA) {
    return invalid('receipt schema is unsupported');
  }
  const normalized = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_ADMISSION_RECEIPT_SCHEMA,
    requestId: identity(value.requestId, 'requestId'),
    invocationId: identity(value.invocationId, 'invocationId'),
    planDigest: digest(value.planDigest, 'planDigest'),
    runId: identity(value.runId, 'runId'),
    stepRunId: identity(value.stepRunId, 'stepRunId'),
    stepRunDigest: digest(value.stepRunDigest, 'stepRunDigest'),
    mutationId: identity(value.mutationId, 'mutationId'),
    eventId: identity(value.eventId, 'eventId'),
    publicationDigest: digest(value.publicationDigest, 'publicationDigest'),
    promptId: identity(value.promptId, 'promptId'),
    finalRunVersion: positiveInteger(
      value.finalRunVersion,
      2,
      'finalRunVersion',
    ) as 2,
    finalRunEventSequence: positiveInteger(
      value.finalRunEventSequence,
      2,
      'finalRunEventSequence',
    ) as 2,
    admittedAtMs: timestamp(value.admittedAtMs, 'admittedAtMs'),
    receiptDigest: digest(value.receiptDigest, 'receiptDigest'),
  });
  if (
    normalized.finalRunVersion !== 2 ||
    normalized.finalRunEventSequence !== 2 ||
    pluginPackagePromptAdmissionReceiptDigest(normalized) !==
      normalized.receiptDigest ||
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
      MAX_PLUGIN_PACKAGE_PROMPT_ADMISSION_RECEIPT_BYTES
  ) {
    return invalid('receipt digest, counter, or size is invalid');
  }
  return normalized;
}

export function pluginPackagePromptFinalizationEventIdentity(
  invocationIdValue: string,
  terminalEvidenceDigestValue: string,
): string {
  const invocationId = identity(invocationIdValue, 'invocationId');
  const terminalEvidenceDigest = digest(
    terminalEvidenceDigestValue,
    'terminalEvidenceDigest',
  );
  return `ppf:${hash(FINALIZATION_IDENTITY_DOMAIN, {
    invocationId,
    terminalEvidenceDigest,
  }).slice(0, 32)}`;
}

function finalizationReceiptFields(
  value: Omit<PluginPackagePromptFinalizationReceipt, 'receiptDigest'>,
): object {
  return {
    schema: value.schema,
    requestId: value.requestId,
    invocationId: value.invocationId,
    planDigest: value.planDigest,
    runId: value.runId,
    stepRunId: value.stepRunId,
    terminalEvidenceKind: value.terminalEvidenceKind,
    terminalEvidenceDigest: value.terminalEvidenceDigest,
    finalStepRunDigest: value.finalStepRunDigest,
    runStatus: value.runStatus,
    eventId: value.eventId,
    finalRunVersion: value.finalRunVersion,
    finalRunEventSequence: value.finalRunEventSequence,
    finalizedAtMs: value.finalizedAtMs,
  };
}

export function pluginPackagePromptFinalizationReceiptDigest(
  value: Omit<PluginPackagePromptFinalizationReceipt, 'receiptDigest'>,
): string {
  return hash(
    FINALIZATION_RECEIPT_DIGEST_DOMAIN,
    finalizationReceiptFields(value),
  );
}

export function normalizePluginPackagePromptFinalizationReceipt(
  value: PluginPackagePromptFinalizationReceipt,
): Readonly<PluginPackagePromptFinalizationReceipt> {
  const receipt = dataRecord(value, 'Prompt finalization receipt');
  exactKeys(
    receipt,
    [
      'schema',
      'requestId',
      'invocationId',
      'planDigest',
      'runId',
      'stepRunId',
      'terminalEvidenceKind',
      'terminalEvidenceDigest',
      'finalStepRunDigest',
      'runStatus',
      'eventId',
      'finalRunVersion',
      'finalRunEventSequence',
      'finalizedAtMs',
      'receiptDigest',
    ],
    [],
    'Prompt finalization receipt',
  );
  if (
    value.schema !== PLUGIN_PACKAGE_PROMPT_FINALIZATION_RECEIPT_SCHEMA ||
    !PLUGIN_PACKAGE_PROMPT_TERMINAL_EVIDENCE_KINDS.includes(
      value.terminalEvidenceKind,
    ) ||
    !PLUGIN_PACKAGE_PROMPT_FINAL_RUN_STATUSES.includes(value.runStatus)
  ) {
    return invalid('finalization schema, evidence, or Run status is invalid');
  }
  const normalized = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_FINALIZATION_RECEIPT_SCHEMA,
    requestId: identity(value.requestId, 'requestId'),
    invocationId: identity(value.invocationId, 'invocationId'),
    planDigest: digest(value.planDigest, 'planDigest'),
    runId: identity(value.runId, 'runId'),
    stepRunId: identity(value.stepRunId, 'stepRunId'),
    terminalEvidenceKind: value.terminalEvidenceKind,
    terminalEvidenceDigest: digest(
      value.terminalEvidenceDigest,
      'terminalEvidenceDigest',
    ),
    finalStepRunDigest: digest(value.finalStepRunDigest, 'finalStepRunDigest'),
    runStatus: value.runStatus,
    eventId: identity(value.eventId, 'eventId'),
    finalRunVersion: positiveInteger(
      value.finalRunVersion,
      2_147_483_647,
      'finalRunVersion',
    ),
    finalRunEventSequence: positiveInteger(
      value.finalRunEventSequence,
      2_147_483_647,
      'finalRunEventSequence',
    ),
    finalizedAtMs: timestamp(value.finalizedAtMs, 'finalizedAtMs'),
    receiptDigest: digest(value.receiptDigest, 'receiptDigest'),
  });
  if (
    normalized.finalRunVersion < 3 ||
    normalized.finalRunVersion !== normalized.finalRunEventSequence ||
    normalized.eventId !==
      pluginPackagePromptFinalizationEventIdentity(
        normalized.invocationId,
        normalized.terminalEvidenceDigest,
      ) ||
    pluginPackagePromptFinalizationReceiptDigest(normalized) !==
      normalized.receiptDigest ||
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
      MAX_PLUGIN_PACKAGE_PROMPT_FINALIZATION_RECEIPT_BYTES
  ) {
    return invalid(
      'finalization identity, digest, counter, or size is invalid',
    );
  }
  return normalized;
}

export function createPluginPackagePromptAdmissionBundle(
  planValue: PluginPackagePromptExecutionPlan,
): Readonly<PluginPackagePromptAdmissionBundle> {
  const plan = normalizePluginPackagePromptExecutionPlan(planValue);
  const admissionEvent = Object.freeze({
    id: admissionIdentity('ppa', plan.planDigest),
    runId: plan.runId,
    sequence: 1,
    type: 'prompt.admitted',
    dedupeKey: admissionIdentity('ppa', plan.planDigest),
    actorType: 'user' as const,
    actorId: plan.requestedBySubject.id,
    payload: Object.freeze({
      planDigest: plan.planDigest,
      publicationDigest: plan.target.publicationDigest,
      promptId: plan.target.promptId,
      promptDefinitionDigest: plan.target.promptDefinitionDigest,
      parameterDigest: plan.parameterDigest,
      modelRequestDigest: plan.modelRequestDigest,
      provider: plan.provider,
      model: plan.model,
      inputBytes: plan.inputBytes,
      maxOutputTokens: plan.maxOutputTokens,
    }),
    createdAtMs: plan.plannedAtMs,
  } satisfies RunEventRecord);
  const stepMutation = normalizeStepRunMutation(
    createStepRunMutation(
      {
        id: plan.stepRunId,
        runId: plan.runId,
        stepKey: 'prompt',
        kind: 'model',
        definitionRef:
          `plugin-package:${plan.target.publicationDigest}:prompt:` +
          plan.target.promptId,
        definitionDigest: plan.target.promptDefinitionDigest,
        required: true,
        initialStatus: 'ready',
        inputRef: `prompt-input:${plan.parameterDigest}`,
        mutationId: admissionIdentity('ppm', plan.planDigest),
        createdAtMs: plan.plannedAtMs,
      },
      {
        expectedRunVersion: 1,
        expectedRunEventSequence: 1,
        eventId: admissionIdentity('ppe', plan.planDigest),
        dedupeKey: admissionIdentity('ppe', plan.planDigest),
        actor: plan.requestedBySubject,
      },
    ),
  );
  const run = Object.freeze({
    id: plan.runId,
    projectId: plan.target.projectId,
    taskId: plan.target.promptId,
    taskRevision: plan.target.publicationDigest,
    taskName: `Prompt ${plan.target.promptId}`,
    taskSnapshotRef:
      `plugin-package:${plan.target.publicationDigest}:prompt:` +
      plan.target.promptId,
    triggerType: 'plugin_package_prompt',
    executionOrigin: 'manual' as const,
    executionOwner: 'runtime' as const,
    triggeredBy: plan.requestedBySubject.id,
    requestId: plan.requestId,
    status: 'running' as const,
    version: 2,
    eventSequence: 2,
    priority: 0,
    idempotencyKey: `plugin-package-prompt:${plan.requestId}`,
    createdAtMs: plan.plannedAtMs,
    startedAtMs: plan.plannedAtMs,
  } satisfies RunRecord);
  const receiptUnsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_ADMISSION_RECEIPT_SCHEMA,
    requestId: plan.requestId,
    invocationId: plan.invocationId,
    planDigest: plan.planDigest,
    runId: plan.runId,
    stepRunId: plan.stepRunId,
    stepRunDigest: stepMutation.stepRun.stepRunDigest,
    mutationId: stepMutation.mutationId,
    eventId: stepMutation.event.id,
    publicationDigest: plan.target.publicationDigest,
    promptId: plan.target.promptId,
    finalRunVersion: 2 as const,
    finalRunEventSequence: 2 as const,
    admittedAtMs: plan.plannedAtMs,
  });
  const receipt = normalizePluginPackagePromptAdmissionReceipt({
    ...receiptUnsigned,
    receiptDigest: pluginPackagePromptAdmissionReceiptDigest(receiptUnsigned),
  });
  return Object.freeze({
    plan,
    run,
    admissionEvent,
    stepMutation,
    receipt,
  });
}
