import { createHash } from 'node:crypto';

export const COPILOT_FAILURE_DIAGNOSIS_FINALIZATION_RECEIPT_SCHEMA =
  'qinglong/copilot-failure-diagnosis-finalization-receipt@v1' as const;
export const COPILOT_FAILURE_DIAGNOSIS_FINAL_OUTCOMES = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
] as const;

export type CopilotFailureDiagnosisFinalOutcome =
  (typeof COPILOT_FAILURE_DIAGNOSIS_FINAL_OUTCOMES)[number];

export interface CopilotFailureDiagnosisFinalizationReceipt {
  readonly schema: typeof COPILOT_FAILURE_DIAGNOSIS_FINALIZATION_RECEIPT_SCHEMA;
  readonly requestId: string;
  readonly planDigest: string;
  readonly runId: string;
  readonly modelStepRunId: string;
  readonly invocationId: string;
  readonly completionDigest: string;
  readonly outcome: CopilotFailureDiagnosisFinalOutcome;
  readonly outputArtifactId: string | null;
  readonly finalRunVersion: number;
  readonly finalRunEventSequence: number;
  readonly runEventId: string;
  readonly finalizedAtMs: number;
  readonly receiptDigest: string;
}

export interface CopilotFailureDiagnosisFinalizationRepository {
  findFinalization(
    requestId: string,
  ): Promise<Readonly<CopilotFailureDiagnosisFinalizationReceipt> | null>;
  finalize(requestId: string): Promise<Readonly<{
    status: 'created' | 'existing';
    receipt: Readonly<CopilotFailureDiagnosisFinalizationReceipt>;
  }>>;
}

export class CopilotFailureDiagnosisModelExecutionInProgressError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_MODEL_EXECUTION_IN_PROGRESS';
  constructor() {
    super('Copilot failure diagnosis Model execution is in progress');
    this.name = 'CopilotFailureDiagnosisModelExecutionInProgressError';
  }
}

export class CopilotFailureDiagnosisModelResolutionRequiredError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_MODEL_RESOLUTION_REQUIRED';
  constructor() {
    super('Copilot failure diagnosis Model execution requires resolution');
    this.name = 'CopilotFailureDiagnosisModelResolutionRequiredError';
  }
}

export class CopilotFailureDiagnosisFinalizationConflictError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_FINALIZATION_CONFLICT';
  constructor() {
    super('Copilot failure diagnosis finalization conflicts');
    this.name = 'CopilotFailureDiagnosisFinalizationConflictError';
  }
}

export class CopilotFailureDiagnosisFinalizationUnavailableError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_FINALIZATION_UNAVAILABLE';
  constructor(options?: ErrorOptions) {
    super('Copilot failure diagnosis finalization is unavailable', options);
    this.name = 'CopilotFailureDiagnosisFinalizationUnavailableError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_DOMAIN =
  'qinglong/copilot-failure-diagnosis-finalization-receipt-digest@v1\0';
const EVENT_DOMAIN =
  'qinglong/copilot-failure-diagnosis-finalization-event-id@v1\0';

function invalid(): never {
  throw new CopilotFailureDiagnosisFinalizationConflictError();
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) return invalid();
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}

function unsigned(
  value: Omit<CopilotFailureDiagnosisFinalizationReceipt, 'receiptDigest'>,
): object {
  return {
    schema: value.schema,
    requestId: value.requestId,
    planDigest: value.planDigest,
    runId: value.runId,
    modelStepRunId: value.modelStepRunId,
    invocationId: value.invocationId,
    completionDigest: value.completionDigest,
    outcome: value.outcome,
    outputArtifactId: value.outputArtifactId,
    finalRunVersion: value.finalRunVersion,
    finalRunEventSequence: value.finalRunEventSequence,
    runEventId: value.runEventId,
    finalizedAtMs: value.finalizedAtMs,
  };
}

export function copilotFailureDiagnosisFinalizationReceiptDigest(
  value: Omit<CopilotFailureDiagnosisFinalizationReceipt, 'receiptDigest'>,
): string {
  return createHash('sha256')
    .update(DIGEST_DOMAIN)
    .update(JSON.stringify(unsigned(value)))
    .digest('hex');
}

export function copilotFailureDiagnosisFinalizationEventIdentity(
  invocationId: string,
  completionDigest: string,
): string {
  const hex = createHash('sha256')
    .update(EVENT_DOMAIN)
    .update(text(invocationId, ID_PATTERN))
    .update(text(completionDigest, DIGEST_PATTERN))
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '4';
  hex[16] = '8';
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(
    12,
    16,
  )}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function normalizeCopilotFailureDiagnosisFinalizationReceipt(
  value: CopilotFailureDiagnosisFinalizationReceipt,
): Readonly<CopilotFailureDiagnosisFinalizationReceipt> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid();
  }
  const expected = [
    'completionDigest', 'finalRunEventSequence', 'finalRunVersion',
    'finalizedAtMs', 'invocationId', 'outcome', 'outputArtifactId',
    'modelStepRunId', 'planDigest', 'receiptDigest', 'requestId', 'runEventId',
    'runId', 'schema',
  ];
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((item) => typeof item !== 'string' || !expected.includes(item)) ||
    value.schema !== COPILOT_FAILURE_DIAGNOSIS_FINALIZATION_RECEIPT_SCHEMA ||
    !COPILOT_FAILURE_DIAGNOSIS_FINAL_OUTCOMES.includes(value.outcome)
  ) {
    return invalid();
  }
  const outputArtifactId =
    value.outputArtifactId === null
      ? null
      : text(value.outputArtifactId, ID_PATTERN);
  if ((value.outcome === 'succeeded') !== (outputArtifactId !== null)) {
    return invalid();
  }
  const normalized = Object.freeze({
    schema: value.schema,
    requestId: text(value.requestId, ID_PATTERN),
    planDigest: text(value.planDigest, DIGEST_PATTERN),
    runId: text(value.runId, RUN_ID_PATTERN),
    modelStepRunId: text(value.modelStepRunId, ID_PATTERN),
    invocationId: text(value.invocationId, ID_PATTERN),
    completionDigest: text(value.completionDigest, DIGEST_PATTERN),
    outcome: value.outcome,
    outputArtifactId,
    finalRunVersion: integer(value.finalRunVersion),
    finalRunEventSequence: integer(value.finalRunEventSequence),
    runEventId: text(value.runEventId, RUN_ID_PATTERN),
    finalizedAtMs: integer(value.finalizedAtMs),
  } satisfies Omit<
    CopilotFailureDiagnosisFinalizationReceipt,
    'receiptDigest'
  >);
  if (
    normalized.finalRunVersion < 1 ||
    normalized.finalRunEventSequence !== normalized.finalRunVersion ||
    normalized.runEventId !==
      copilotFailureDiagnosisFinalizationEventIdentity(
        normalized.invocationId,
        normalized.completionDigest,
      ) ||
    text(value.receiptDigest, DIGEST_PATTERN) !==
      copilotFailureDiagnosisFinalizationReceiptDigest(normalized)
  ) {
    return invalid();
  }
  return Object.freeze({ ...normalized, receiptDigest: value.receiptDigest });
}

export function createCopilotFailureDiagnosisFinalizationReceipt(
  value: Omit<
    CopilotFailureDiagnosisFinalizationReceipt,
    'schema' | 'runEventId' | 'receiptDigest'
  >,
): Readonly<CopilotFailureDiagnosisFinalizationReceipt> {
  const unsignedReceipt = Object.freeze({
    schema: COPILOT_FAILURE_DIAGNOSIS_FINALIZATION_RECEIPT_SCHEMA,
    ...value,
    runEventId: copilotFailureDiagnosisFinalizationEventIdentity(
      value.invocationId,
      value.completionDigest,
    ),
  });
  return normalizeCopilotFailureDiagnosisFinalizationReceipt({
    ...unsignedReceipt,
    receiptDigest:
      copilotFailureDiagnosisFinalizationReceiptDigest(unsignedReceipt),
  });
}
