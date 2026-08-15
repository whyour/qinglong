import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { normalizeProjectPolicySubject } from '@qinglong/runtime-core/project-policy';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';
import {
  normalizeToolInvocationInputArtifactReference,
  normalizeToolInvocationPreviewArtifactReference,
} from '@qinglong/runtime-core/tool-invocation-artifact';

import { MAX_MODEL_INVOCATION_MS } from '../../../model-gateway/model';
import {
  FAILURE_DIAGNOSIS_PROMPT_PROTOCOL,
  type FailureDiagnosisModelEgressPolicy,
} from '../contracts';
import {
  normalizeFailureDiagnosisModelBoundary,
  normalizeFailureDiagnosisModelEgressPolicy,
  normalizeFailureDiagnosisResponseLanguage,
} from '../validation';
import {
  COPILOT_FAILURE_DIAGNOSIS_SOURCE_ATTEMPT_STATUSES,
  COPILOT_FAILURE_DIAGNOSIS_SOURCE_RUN_STATUSES,
  InvalidCopilotFailureDiagnosisExecutionPlanError,
  type CopilotFailureDiagnosisModelIntent,
  type CopilotFailureDiagnosisSourceFence,
  type CopilotFailureDiagnosisToolIntent,
  type PrepareCopilotFailureDiagnosisModelIntent,
} from './contracts';

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MODEL_EGRESS_POLICY_DIGEST_DOMAIN =
  'qinglong/copilot-failure-diagnosis-egress-policy-digest@v1\0';
const MODEL_INTENT_DIGEST_DOMAIN =
  'qinglong/copilot-failure-diagnosis-model-intent-digest@v1\0';

export function invalid(message: string): never {
  throw new InvalidCopilotFailureDiagnosisExecutionPlanError(message);
}

export function dataRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
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

export function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(value);
  const allowed = new Set(expected);
  if (
    actual.length !== expected.length ||
    actual.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    expected.some((key) => !actual.includes(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

export function hash(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update(JSON.stringify(value))
    .digest('hex');
}

export function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function runIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

export function integer(
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

export function timestamp(value: unknown, label: string): number {
  return integer(value, 0, Number.MAX_SAFE_INTEGER, label);
}

export function normalizeFence(value: unknown): Readonly<SecurityPolicyFence> {
  const fence = dataRecord(value, 'policy fence');
  exactKeys(fence, ['bindingVersion', 'projectVersion'], 'policy fence');
  return Object.freeze({
    projectVersion: integer(
      fence.projectVersion,
      1,
      2_147_483_647,
      'project version',
    ),
    bindingVersion: integer(
      fence.bindingVersion,
      1,
      2_147_483_647,
      'binding version',
    ),
  });
}

export function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

export function sameFence(
  left: Readonly<SecurityPolicyFence>,
  right: Readonly<SecurityPolicyFence>,
): boolean {
  return (
    left.projectVersion === right.projectVersion &&
    left.bindingVersion === right.bindingVersion
  );
}

export function normalizeSourceFence(
  value: unknown,
): Readonly<CopilotFailureDiagnosisSourceFence> {
  const source = dataRecord(value, 'source fence');
  exactKeys(
    source,
    [
      'attemptFinishedAtMs',
      'attemptId',
      'attemptStatus',
      'logArtifactId',
      'runId',
      'runStatus',
      'runVersion',
    ],
    'source fence',
  );
  if (
    !COPILOT_FAILURE_DIAGNOSIS_SOURCE_RUN_STATUSES.includes(
      source.runStatus as never,
    ) ||
    !COPILOT_FAILURE_DIAGNOSIS_SOURCE_ATTEMPT_STATUSES.includes(
      source.attemptStatus as never,
    ) ||
    (source.runStatus === 'failed' &&
      source.attemptStatus !== 'failed' &&
      source.attemptStatus !== 'lost') ||
    (source.runStatus === 'timed_out' && source.attemptStatus !== 'timed_out')
  ) {
    return invalid('source terminal status binding is invalid');
  }
  return Object.freeze({
    runId: runIdentity(source.runId, 'source Run id'),
    runVersion: integer(
      source.runVersion,
      1,
      2_147_483_647,
      'source Run version',
    ),
    runStatus: source.runStatus,
    attemptId: runIdentity(source.attemptId, 'source Attempt id'),
    attemptStatus: source.attemptStatus,
    attemptFinishedAtMs: timestamp(
      source.attemptFinishedAtMs,
      'source Attempt finish time',
    ),
    logArtifactId: runIdentity(source.logArtifactId, 'source log Artifact id'),
  } as CopilotFailureDiagnosisSourceFence);
}

export function failureDiagnosisToolInputDigest(
  source: Readonly<CopilotFailureDiagnosisSourceFence>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ attemptId: source.attemptId, runId: source.runId }),
    )
    .digest('hex');
}

export function failureDiagnosisEgressPolicyDigest(
  value: FailureDiagnosisModelEgressPolicy,
): string {
  return hash(
    MODEL_EGRESS_POLICY_DIGEST_DOMAIN,
    normalizeFailureDiagnosisModelEgressPolicy(value),
  );
}

function modelIntentFields(
  value: Omit<CopilotFailureDiagnosisModelIntent, 'intentDigest'>,
): object {
  return {
    promptProtocol: FAILURE_DIAGNOSIS_PROMPT_PROTOCOL,
    provider: value.provider,
    model: value.model,
    modelBoundary: value.modelBoundary,
    responseLanguage: value.responseLanguage,
    maxOutputTokens: value.maxOutputTokens,
    egressPolicy: value.egressPolicy,
    egressPolicyDigest: value.egressPolicyDigest,
    completion: {
      residualSensitivity: 'potentially_sensitive',
      persistence: 'encrypted_only',
      plaintextAudit: 'forbidden',
      actionAuthority: 'none',
    },
  };
}

export function failureDiagnosisModelIntentDigest(
  value: Omit<CopilotFailureDiagnosisModelIntent, 'intentDigest'>,
): string {
  return hash(MODEL_INTENT_DIGEST_DOMAIN, modelIntentFields(value));
}

export function prepareModelIntent(
  value: PrepareCopilotFailureDiagnosisModelIntent,
): Readonly<CopilotFailureDiagnosisModelIntent> {
  const candidate = dataRecord(value, 'model intent');
  exactKeys(
    candidate,
    [
      'egressPolicy',
      'maxOutputTokens',
      'model',
      'modelBoundary',
      'provider',
      'responseLanguage',
    ],
    'model intent',
  );
  const egressPolicy = normalizeFailureDiagnosisModelEgressPolicy(
    candidate.egressPolicy,
  );
  const modelBoundary = normalizeFailureDiagnosisModelBoundary(
    candidate.modelBoundary,
  );
  const maxOutputTokens = integer(
    candidate.maxOutputTokens,
    1,
    egressPolicy.maxOutputTokens,
    'model max output tokens',
  );
  if (
    !egressPolicy.potentiallySensitiveDataBoundaries.includes(modelBoundary)
  ) {
    return invalid('model boundary is not allowed by egress policy');
  }
  const unsigned = Object.freeze({
    provider: identity(candidate.provider, 'model provider'),
    model: identity(candidate.model, 'model'),
    modelBoundary,
    responseLanguage: normalizeFailureDiagnosisResponseLanguage(
      candidate.responseLanguage,
    ),
    maxOutputTokens,
    egressPolicy,
    egressPolicyDigest: failureDiagnosisEgressPolicyDigest(egressPolicy),
  });
  return Object.freeze({
    ...unsigned,
    intentDigest: failureDiagnosisModelIntentDigest(unsigned),
  });
}

export function normalizeModelIntent(
  value: unknown,
): Readonly<CopilotFailureDiagnosisModelIntent> {
  const candidate = dataRecord(value, 'model intent');
  exactKeys(
    candidate,
    [
      'egressPolicy',
      'egressPolicyDigest',
      'intentDigest',
      'maxOutputTokens',
      'model',
      'modelBoundary',
      'provider',
      'responseLanguage',
    ],
    'model intent',
  );
  const normalized = prepareModelIntent({
    provider: candidate.provider as never,
    model: candidate.model as never,
    modelBoundary: candidate.modelBoundary as never,
    responseLanguage: candidate.responseLanguage as never,
    maxOutputTokens: candidate.maxOutputTokens as never,
    egressPolicy: candidate.egressPolicy as never,
  });
  if (
    digest(candidate.egressPolicyDigest, 'egress policy digest') !==
      normalized.egressPolicyDigest ||
    digest(candidate.intentDigest, 'model intent digest') !==
      normalized.intentDigest
  ) {
    return invalid('model intent digest is invalid');
  }
  return normalized;
}

export function normalizeToolIntent(
  value: unknown,
): Readonly<CopilotFailureDiagnosisToolIntent> {
  const candidate = dataRecord(value, 'Tool intent');
  exactKeys(
    candidate,
    [
      'actionDigest',
      'actionRef',
      'bindingDigest',
      'definitionDigest',
      'invocationActionDigest',
      'invocationArtifact',
      'planDigest',
      'previewArtifact',
      'sealedAtMs',
      'snapshotDigest',
    ],
    'Tool intent',
  );
  const invocationArtifact = normalizeToolInvocationInputArtifactReference(
    candidate.invocationArtifact as never,
  );
  const previewArtifact = normalizeToolInvocationPreviewArtifactReference(
    candidate.previewArtifact as never,
  );
  const actionDigest = digest(candidate.actionDigest, 'Tool action digest');
  if (previewArtifact.actionDigest !== actionDigest) {
    return invalid('Tool preview action binding is invalid');
  }
  return Object.freeze({
    actionRef: identity(candidate.actionRef, 'Tool action reference'),
    planDigest: digest(candidate.planDigest, 'Tool plan digest'),
    actionDigest,
    invocationActionDigest: digest(
      candidate.invocationActionDigest,
      'Tool invocation action digest',
    ),
    snapshotDigest: digest(candidate.snapshotDigest, 'Tool snapshot digest'),
    definitionDigest: digest(
      candidate.definitionDigest,
      'Tool definition digest',
    ),
    bindingDigest: digest(candidate.bindingDigest, 'Tool binding digest'),
    invocationArtifact,
    previewArtifact,
    sealedAtMs: timestamp(candidate.sealedAtMs, 'Tool plan seal time'),
  });
}

export function assertDeadline(
  plannedAtMs: number,
  deadlineAtMs: number,
): void {
  if (
    deadlineAtMs <= plannedAtMs ||
    deadlineAtMs - plannedAtMs > MAX_MODEL_INVOCATION_MS
  ) {
    invalid('diagnosis deadline is invalid');
  }
}

export function assertJsonBudget(
  value: unknown,
  maximumBytes: number,
  label: string,
): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximumBytes) {
    invalid(`${label} exceeds its byte budget`);
  }
}

export { normalizeProjectPolicySubject };
