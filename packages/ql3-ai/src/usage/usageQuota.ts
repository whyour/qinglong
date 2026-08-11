import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type {
  CommitModelInvocationResult,
  ModelInvocationCompletionCommand,
  ModelInvocationCompletionRecord,
  ModelInvocationRepository,
  ModelInvocationStartCommand,
  ModelInvocationStartRecord,
} from '../model-invocation/modelInvocation';

// Usage owns bounded quota reservation and settlement contracts.

export const MODEL_INVOCATION_QUOTA_ADMISSION_SCHEMA =
  'qinglong/model-invocation-quota-admission@v1' as const;
export const MODEL_INVOCATION_QUOTA_RESERVATION_SCHEMA =
  'qinglong/model-invocation-quota-reservation@v1' as const;
export const MODEL_INVOCATION_QUOTA_SETTLEMENT_SCHEMA =
  'qinglong/model-invocation-quota-settlement@v1' as const;

export const MODEL_INVOCATION_QUOTA_WINDOWS_MS = [
  60_000, 3_600_000, 86_400_000,
] as const;
export const MAX_MODEL_INVOCATIONS_PER_QUOTA_WINDOW = 100_000;
export const MAX_MODEL_TOKENS_PER_QUOTA_WINDOW = 1_000_000_000_000;
export const MAX_MODEL_COST_MICROS_PER_QUOTA_WINDOW = 1_000_000_000_000_000;

export interface ModelInvocationProjectQuotaPolicy {
  readonly revision: string;
  readonly windowMs: (typeof MODEL_INVOCATION_QUOTA_WINDOWS_MS)[number];
  readonly maxInvocations: number;
  readonly maxTokens: number;
  readonly maxCostMicros: number | null;
}

export interface ModelInvocationQuotaAdmission {
  readonly schema: typeof MODEL_INVOCATION_QUOTA_ADMISSION_SCHEMA;
  readonly invocationId: string;
  readonly projectId: string;
  readonly modelPolicyRevision: string;
  readonly quotaPolicyRevision: string;
  readonly windowMs: number;
  readonly maxInvocations: number;
  readonly maxTokens: number;
  readonly maxCostMicros: number | null;
  readonly reservedTokens: number;
  readonly reservedCostMicros: number | null;
  readonly admissionDigest: string;
}

export interface ModelInvocationQuotaReservation {
  readonly schema: typeof MODEL_INVOCATION_QUOTA_RESERVATION_SCHEMA;
  readonly invocationId: string;
  readonly projectId: string;
  readonly modelPolicyRevision: string;
  readonly quotaPolicyRevision: string;
  readonly windowMs: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly maxInvocations: number;
  readonly maxTokens: number;
  readonly maxCostMicros: number | null;
  readonly reservedTokens: number;
  readonly reservedCostMicros: number | null;
  readonly reservedAtMs: number;
  readonly admissionDigest: string;
  readonly reservationDigest: string;
}

export interface ModelInvocationQuotaSettlement {
  readonly schema: typeof MODEL_INVOCATION_QUOTA_SETTLEMENT_SCHEMA;
  readonly invocationId: string;
  readonly projectId: string;
  readonly reservationDigest: string;
  readonly completionDigest: string;
  readonly effectiveTokens: number;
  readonly effectiveCostMicros: number | null;
  readonly retainedTokenReservation: boolean;
  readonly retainedCostReservation: boolean;
  readonly settledAtMs: number;
  readonly settlementDigest: string;
}

export interface ModelInvocationQuotaWindowUsage {
  readonly projectId: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly invocationCount: number;
  readonly effectiveTokens: number;
  readonly effectiveCostMicros: number;
  readonly unknownCostInvocations: number;
}

export interface ModelInvocationQuotaRepository {
  findQuotaReservation(
    invocationId: string,
  ): Promise<Readonly<ModelInvocationQuotaReservation> | null>;
  findQuotaSettlement(
    invocationId: string,
  ): Promise<Readonly<ModelInvocationQuotaSettlement> | null>;
  readQuotaWindowUsage(
    projectId: string,
    atMs?: number,
  ): Promise<Readonly<ModelInvocationQuotaWindowUsage> | null>;
}

export interface QuotaAwareModelInvocationRepository
  extends ModelInvocationRepository,
    ModelInvocationQuotaRepository {
  admitWithQuota(
    command: ModelInvocationStartCommand,
    admission: ModelInvocationQuotaAdmission,
  ): Promise<Readonly<CommitModelInvocationResult<ModelInvocationStartRecord>>>;
  completeWithQuota(
    command: ModelInvocationCompletionCommand,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationCompletionRecord>>
  >;
}

export function isQuotaAwareModelInvocationRepository(
  value: ModelInvocationRepository,
): value is QuotaAwareModelInvocationRepository {
  const candidate = value as Partial<QuotaAwareModelInvocationRepository>;
  return (
    typeof candidate.findQuotaReservation === 'function' &&
    typeof candidate.findQuotaSettlement === 'function' &&
    typeof candidate.readQuotaWindowUsage === 'function' &&
    typeof candidate.admitWithQuota === 'function' &&
    typeof candidate.completeWithQuota === 'function'
  );
}

export class InvalidModelInvocationQuotaError extends TypeError {
  readonly code = 'MODEL_INVOCATION_QUOTA_INVALID';

  constructor(message: string) {
    super(`Model invocation quota is invalid: ${message}`);
    this.name = 'InvalidModelInvocationQuotaError';
  }
}

export class ModelInvocationProjectQuotaExceededError extends Error {
  readonly code = 'MODEL_PROJECT_QUOTA_EXCEEDED';

  constructor() {
    super('The Project model invocation quota is exhausted');
    this.name = 'ModelInvocationProjectQuotaExceededError';
  }
}

export class ModelInvocationQuotaConfigurationError extends Error {
  readonly code = 'MODEL_PROJECT_QUOTA_CONFIGURATION_INVALID';

  constructor() {
    super('The Project model invocation quota cannot safely reserve this call');
    this.name = 'ModelInvocationQuotaConfigurationError';
  }
}

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ADMISSION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-invocation-quota-admission-digest@v1\0',
  'utf8',
);
const RESERVATION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-invocation-quota-reservation-digest@v1\0',
  'utf8',
);
const SETTLEMENT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-invocation-quota-settlement-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidModelInvocationQuotaError(message);
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
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
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
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

function nullableInteger(
  value: unknown,
  label: string,
  maximum: number,
): number | null {
  return value === null ? null : integer(value, label, 0, maximum);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function digestRecord(domain: Buffer, value: object): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

export function normalizeModelInvocationProjectQuotaPolicy(
  value: ModelInvocationProjectQuotaPolicy,
): Readonly<ModelInvocationProjectQuotaPolicy> {
  const record = plainObject(value, 'policy');
  exactKeys(
    record,
    ['revision', 'windowMs', 'maxInvocations', 'maxTokens', 'maxCostMicros'],
    'policy',
  );
  const revision = identifier(record.revision, 'policy revision');
  const windowMs = integer(record.windowMs, 'windowMs', 1);
  if (
    !MODEL_INVOCATION_QUOTA_WINDOWS_MS.includes(
      windowMs as (typeof MODEL_INVOCATION_QUOTA_WINDOWS_MS)[number],
    )
  ) {
    invalid('windowMs is unsupported');
  }
  return Object.freeze({
    revision,
    windowMs: windowMs as (typeof MODEL_INVOCATION_QUOTA_WINDOWS_MS)[number],
    maxInvocations: integer(
      record.maxInvocations,
      'maxInvocations',
      1,
      MAX_MODEL_INVOCATIONS_PER_QUOTA_WINDOW,
    ),
    maxTokens: integer(
      record.maxTokens,
      'maxTokens',
      1,
      MAX_MODEL_TOKENS_PER_QUOTA_WINDOW,
    ),
    maxCostMicros: nullableInteger(
      record.maxCostMicros,
      'maxCostMicros',
      MAX_MODEL_COST_MICROS_PER_QUOTA_WINDOW,
    ),
  });
}

export function createModelInvocationQuotaAdmission(options: {
  readonly invocationId: string;
  readonly projectId: string;
  readonly modelPolicyRevision: string;
  readonly reservedTokens: number;
  readonly reservedCostMicros: number | null;
  readonly quota: ModelInvocationProjectQuotaPolicy;
}): Readonly<ModelInvocationQuotaAdmission> {
  const quota = normalizeModelInvocationProjectQuotaPolicy(options.quota);
  const reservedTokens = integer(
    options.reservedTokens,
    'reservedTokens',
    1,
    MAX_MODEL_TOKENS_PER_QUOTA_WINDOW,
  );
  const reservedCostMicros = nullableInteger(
    options.reservedCostMicros,
    'reservedCostMicros',
    MAX_MODEL_COST_MICROS_PER_QUOTA_WINDOW,
  );
  if (quota.maxCostMicros !== null && reservedCostMicros === null) {
    throw new ModelInvocationQuotaConfigurationError();
  }
  const unsigned = Object.freeze({
    schema: MODEL_INVOCATION_QUOTA_ADMISSION_SCHEMA,
    invocationId: identifier(options.invocationId, 'invocationId'),
    projectId: identifier(options.projectId, 'projectId'),
    modelPolicyRevision: identifier(
      options.modelPolicyRevision,
      'modelPolicyRevision',
    ),
    quotaPolicyRevision: quota.revision,
    windowMs: quota.windowMs,
    maxInvocations: quota.maxInvocations,
    maxTokens: quota.maxTokens,
    maxCostMicros: quota.maxCostMicros,
    reservedTokens,
    reservedCostMicros,
  });
  return Object.freeze({
    ...unsigned,
    admissionDigest: digestRecord(ADMISSION_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeModelInvocationQuotaAdmission(
  value: ModelInvocationQuotaAdmission,
): Readonly<ModelInvocationQuotaAdmission> {
  const record = plainObject(value, 'admission');
  exactKeys(
    record,
    [
      'schema',
      'invocationId',
      'projectId',
      'modelPolicyRevision',
      'quotaPolicyRevision',
      'windowMs',
      'maxInvocations',
      'maxTokens',
      'maxCostMicros',
      'reservedTokens',
      'reservedCostMicros',
      'admissionDigest',
    ],
    'admission',
  );
  if (record.schema !== MODEL_INVOCATION_QUOTA_ADMISSION_SCHEMA) {
    invalid('admission schema is invalid');
  }
  const normalized = createModelInvocationQuotaAdmission({
    invocationId: identifier(record.invocationId, 'invocationId'),
    projectId: identifier(record.projectId, 'projectId'),
    modelPolicyRevision: identifier(
      record.modelPolicyRevision,
      'modelPolicyRevision',
    ),
    reservedTokens: integer(
      record.reservedTokens,
      'reservedTokens',
      1,
      MAX_MODEL_TOKENS_PER_QUOTA_WINDOW,
    ),
    reservedCostMicros: nullableInteger(
      record.reservedCostMicros,
      'reservedCostMicros',
      MAX_MODEL_COST_MICROS_PER_QUOTA_WINDOW,
    ),
    quota: {
      revision: identifier(record.quotaPolicyRevision, 'quotaPolicyRevision'),
      windowMs: integer(
        record.windowMs,
        'windowMs',
        1,
      ) as ModelInvocationProjectQuotaPolicy['windowMs'],
      maxInvocations: integer(
        record.maxInvocations,
        'maxInvocations',
        1,
        MAX_MODEL_INVOCATIONS_PER_QUOTA_WINDOW,
      ),
      maxTokens: integer(
        record.maxTokens,
        'maxTokens',
        1,
        MAX_MODEL_TOKENS_PER_QUOTA_WINDOW,
      ),
      maxCostMicros: nullableInteger(
        record.maxCostMicros,
        'maxCostMicros',
        MAX_MODEL_COST_MICROS_PER_QUOTA_WINDOW,
      ),
    },
  });
  if (
    digest(record.admissionDigest, 'admissionDigest') !==
    normalized.admissionDigest
  ) {
    invalid('admissionDigest is inconsistent');
  }
  return normalized;
}

export function createModelInvocationQuotaReservation(
  admissionValue: ModelInvocationQuotaAdmission,
  reservedAtMsValue: number,
): Readonly<ModelInvocationQuotaReservation> {
  const admission = normalizeModelInvocationQuotaAdmission(admissionValue);
  const reservedAtMs = integer(reservedAtMsValue, 'reservedAtMs', 0);
  const windowStartMs =
    Math.floor(reservedAtMs / admission.windowMs) * admission.windowMs;
  const unsigned = Object.freeze({
    schema: MODEL_INVOCATION_QUOTA_RESERVATION_SCHEMA,
    invocationId: admission.invocationId,
    projectId: admission.projectId,
    modelPolicyRevision: admission.modelPolicyRevision,
    quotaPolicyRevision: admission.quotaPolicyRevision,
    windowMs: admission.windowMs,
    windowStartMs,
    windowEndMs: windowStartMs + admission.windowMs,
    maxInvocations: admission.maxInvocations,
    maxTokens: admission.maxTokens,
    maxCostMicros: admission.maxCostMicros,
    reservedTokens: admission.reservedTokens,
    reservedCostMicros: admission.reservedCostMicros,
    reservedAtMs,
    admissionDigest: admission.admissionDigest,
  });
  return Object.freeze({
    ...unsigned,
    reservationDigest: digestRecord(RESERVATION_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeModelInvocationQuotaReservation(
  value: ModelInvocationQuotaReservation,
): Readonly<ModelInvocationQuotaReservation> {
  const record = plainObject(value, 'reservation');
  exactKeys(
    record,
    [
      'schema',
      'invocationId',
      'projectId',
      'modelPolicyRevision',
      'quotaPolicyRevision',
      'windowMs',
      'windowStartMs',
      'windowEndMs',
      'maxInvocations',
      'maxTokens',
      'maxCostMicros',
      'reservedTokens',
      'reservedCostMicros',
      'reservedAtMs',
      'admissionDigest',
      'reservationDigest',
    ],
    'reservation',
  );
  if (record.schema !== MODEL_INVOCATION_QUOTA_RESERVATION_SCHEMA) {
    invalid('reservation schema is invalid');
  }
  const admission = normalizeModelInvocationQuotaAdmission({
    schema: MODEL_INVOCATION_QUOTA_ADMISSION_SCHEMA,
    invocationId: identifier(record.invocationId, 'invocationId'),
    projectId: identifier(record.projectId, 'projectId'),
    modelPolicyRevision: identifier(
      record.modelPolicyRevision,
      'modelPolicyRevision',
    ),
    quotaPolicyRevision: identifier(
      record.quotaPolicyRevision,
      'quotaPolicyRevision',
    ),
    windowMs: integer(record.windowMs, 'windowMs', 1),
    maxInvocations: integer(
      record.maxInvocations,
      'maxInvocations',
      1,
      MAX_MODEL_INVOCATIONS_PER_QUOTA_WINDOW,
    ),
    maxTokens: integer(
      record.maxTokens,
      'maxTokens',
      1,
      MAX_MODEL_TOKENS_PER_QUOTA_WINDOW,
    ),
    maxCostMicros: nullableInteger(
      record.maxCostMicros,
      'maxCostMicros',
      MAX_MODEL_COST_MICROS_PER_QUOTA_WINDOW,
    ),
    reservedTokens: integer(
      record.reservedTokens,
      'reservedTokens',
      1,
      MAX_MODEL_TOKENS_PER_QUOTA_WINDOW,
    ),
    reservedCostMicros: nullableInteger(
      record.reservedCostMicros,
      'reservedCostMicros',
      MAX_MODEL_COST_MICROS_PER_QUOTA_WINDOW,
    ),
    admissionDigest: digest(record.admissionDigest, 'admissionDigest'),
  });
  const normalized = createModelInvocationQuotaReservation(
    admission,
    integer(record.reservedAtMs, 'reservedAtMs', 0),
  );
  if (
    integer(record.windowStartMs, 'windowStartMs', 0) !==
      normalized.windowStartMs ||
    integer(record.windowEndMs, 'windowEndMs', 1) !== normalized.windowEndMs ||
    digest(record.reservationDigest, 'reservationDigest') !==
      normalized.reservationDigest
  ) {
    invalid('reservation is inconsistent');
  }
  return normalized;
}

export function createModelInvocationQuotaSettlement(
  reservationValue: ModelInvocationQuotaReservation,
  completion: Readonly<ModelInvocationCompletionRecord>,
): Readonly<ModelInvocationQuotaSettlement> {
  const reservation =
    normalizeModelInvocationQuotaReservation(reservationValue);
  if (
    completion.invocationId !== reservation.invocationId ||
    completion.projectId !== reservation.projectId
  ) {
    invalid('completion identity does not match reservation');
  }
  const usage = completion.usage;
  const retainedTokenReservation = usage === null;
  const retainedCostReservation =
    reservation.reservedCostMicros !== null &&
    (usage === null || usage.costMicros === undefined);
  const effectiveTokens = retainedTokenReservation
    ? reservation.reservedTokens
    : usage.totalTokens;
  const effectiveCostMicros =
    reservation.reservedCostMicros === null
      ? null
      : retainedCostReservation
      ? reservation.reservedCostMicros
      : usage!.costMicros!;
  if (
    effectiveTokens > reservation.reservedTokens ||
    (reservation.reservedCostMicros !== null &&
      effectiveCostMicros !== null &&
      effectiveCostMicros > reservation.reservedCostMicros)
  ) {
    invalid('completion usage exceeds reservation');
  }
  const unsigned = Object.freeze({
    schema: MODEL_INVOCATION_QUOTA_SETTLEMENT_SCHEMA,
    invocationId: reservation.invocationId,
    projectId: reservation.projectId,
    reservationDigest: reservation.reservationDigest,
    completionDigest: completion.completionDigest,
    effectiveTokens,
    effectiveCostMicros,
    retainedTokenReservation,
    retainedCostReservation,
    settledAtMs: completion.completedAtMs,
  });
  return Object.freeze({
    ...unsigned,
    settlementDigest: digestRecord(SETTLEMENT_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeModelInvocationQuotaSettlement(
  value: ModelInvocationQuotaSettlement,
  reservation: ModelInvocationQuotaReservation,
  completion: Readonly<ModelInvocationCompletionRecord>,
): Readonly<ModelInvocationQuotaSettlement> {
  const record = plainObject(value, 'settlement');
  exactKeys(
    record,
    [
      'schema',
      'invocationId',
      'projectId',
      'reservationDigest',
      'completionDigest',
      'effectiveTokens',
      'effectiveCostMicros',
      'retainedTokenReservation',
      'retainedCostReservation',
      'settledAtMs',
      'settlementDigest',
    ],
    'settlement',
  );
  if (record.schema !== MODEL_INVOCATION_QUOTA_SETTLEMENT_SCHEMA) {
    invalid('settlement schema is invalid');
  }
  const expected = createModelInvocationQuotaSettlement(
    reservation,
    completion,
  );
  if (
    Object.keys(expected).some(
      (key) =>
        record[key] !== expected[key as keyof ModelInvocationQuotaSettlement],
    )
  ) {
    invalid('settlement is inconsistent');
  }
  return expected;
}
