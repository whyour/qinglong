import { Buffer } from 'node:buffer';

import {
  RUN_LOG_MODEL_CONTEXT_PROFILES,
  RUN_LOG_PROMPT_INJECTION_SIGNALS,
  RUN_LOG_REDACTION_CATEGORIES,
  runLogModelContextBudget,
  type RunLogModelContextProfile,
  type RunLogModelContextProjection,
  type RunLogPromptInjectionSignal,
  type RunLogRedactionCategory,
} from '@qinglong/runtime-core/run-log-model-context-projection';

import {
  FAILURE_DIAGNOSIS_EGRESS_POLICY_SCHEMA,
  FAILURE_DIAGNOSIS_MODEL_BOUNDARIES,
  FAILURE_DIAGNOSIS_RESPONSE_LANGUAGES,
  MAX_FAILURE_DIAGNOSIS_INPUT_BYTES,
  MAX_FAILURE_DIAGNOSIS_OUTPUT_TOKENS,
  InvalidFailureDiagnosisPromptValueError,
  type FailureDiagnosisModelBoundary,
  type FailureDiagnosisModelEgressPolicy,
  type FailureDiagnosisResponseLanguage,
} from './contracts';

const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function invalid(message: string): never {
  throw new InvalidFailureDiagnosisPromptValueError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
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
  value: Readonly<Record<string, unknown>>,
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

function boundedInteger(
  value: unknown,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function positiveInteger(
  value: unknown,
  maximum: number,
  label: string,
): number {
  const normalized = boundedInteger(value, maximum, label);
  if (normalized < 1) return invalid(`${label} is invalid`);
  return normalized;
}

function canonicalSubset<T extends string>(
  value: unknown,
  canonical: readonly T[],
  label: string,
): readonly T[] {
  if (!Array.isArray(value)) return invalid(`${label} is invalid`);
  const selected = new Set<T>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !canonical.includes(entry as T)) {
      return invalid(`${label} is invalid`);
    }
    if (selected.has(entry as T)) return invalid(`${label} has duplicates`);
    selected.add(entry as T);
  }
  const normalized = canonical.filter((entry) => selected.has(entry));
  if (normalized.some((entry, index) => entry !== value[index])) {
    return invalid(`${label} order is invalid`);
  }
  return Object.freeze(normalized);
}

export function normalizeFailureDiagnosisModelBoundary(
  value: unknown,
): FailureDiagnosisModelBoundary {
  if (
    typeof value !== 'string' ||
    !FAILURE_DIAGNOSIS_MODEL_BOUNDARIES.includes(
      value as FailureDiagnosisModelBoundary,
    )
  ) {
    return invalid('model boundary is invalid');
  }
  return value as FailureDiagnosisModelBoundary;
}

export function normalizeFailureDiagnosisResponseLanguage(
  value: unknown,
): FailureDiagnosisResponseLanguage {
  if (
    typeof value !== 'string' ||
    !FAILURE_DIAGNOSIS_RESPONSE_LANGUAGES.includes(
      value as FailureDiagnosisResponseLanguage,
    )
  ) {
    return invalid('response language is invalid');
  }
  return value as FailureDiagnosisResponseLanguage;
}

export function normalizeFailureDiagnosisModelEgressPolicy(
  value: unknown,
): Readonly<FailureDiagnosisModelEgressPolicy> {
  const candidate = record(value, 'egress policy');
  exactKeys(
    candidate,
    [
      'schema',
      'revision',
      'potentiallySensitiveDataBoundaries',
      'maxInputBytes',
      'maxOutputTokens',
    ],
    'egress policy',
  );
  if (candidate.schema !== FAILURE_DIAGNOSIS_EGRESS_POLICY_SCHEMA) {
    return invalid('egress policy schema is invalid');
  }
  if (
    typeof candidate.revision !== 'string' ||
    !REVISION_PATTERN.test(candidate.revision)
  ) {
    return invalid('egress policy revision is invalid');
  }
  return Object.freeze({
    schema: FAILURE_DIAGNOSIS_EGRESS_POLICY_SCHEMA,
    revision: candidate.revision,
    potentiallySensitiveDataBoundaries: canonicalSubset(
      candidate.potentiallySensitiveDataBoundaries,
      FAILURE_DIAGNOSIS_MODEL_BOUNDARIES,
      'potentially sensitive data boundaries',
    ),
    maxInputBytes: positiveInteger(
      candidate.maxInputBytes,
      MAX_FAILURE_DIAGNOSIS_INPUT_BYTES,
      'egress maxInputBytes',
    ),
    maxOutputTokens: positiveInteger(
      candidate.maxOutputTokens,
      MAX_FAILURE_DIAGNOSIS_OUTPUT_TOKENS,
      'egress maxOutputTokens',
    ),
  });
}

export function normalizeFailureDiagnosisProfile(
  value: unknown,
): RunLogModelContextProfile {
  if (
    typeof value !== 'string' ||
    !RUN_LOG_MODEL_CONTEXT_PROFILES.includes(value as RunLogModelContextProfile)
  ) {
    return invalid('profile is invalid');
  }
  return value as RunLogModelContextProfile;
}

export function normalizeFailureDiagnosisProjection(
  value: unknown,
  profile: RunLogModelContextProfile,
): Readonly<RunLogModelContextProjection> {
  const candidate = record(value, 'run log projection');
  exactKeys(
    candidate,
    [
      'content',
      'sourceBytes',
      'modelTextBytes',
      'redaction',
      'normalization',
      'trust',
    ],
    'run log projection',
  );
  const budget = runLogModelContextBudget(profile);
  if (typeof candidate.content !== 'string') {
    return invalid('run log content is invalid');
  }
  const modelTextBytes = boundedInteger(
    candidate.modelTextBytes,
    budget.maximumTextBytes,
    'run log modelTextBytes',
  );
  if (Buffer.byteLength(candidate.content, 'utf8') !== modelTextBytes) {
    return invalid('run log modelTextBytes does not match content');
  }
  const sourceBytes = boundedInteger(
    candidate.sourceBytes,
    budget.sourceBytes,
    'run log sourceBytes',
  );

  const redaction = record(candidate.redaction, 'run log redaction');
  exactKeys(
    redaction,
    ['contract', 'residualSensitivity', 'replacements', 'categories'],
    'run log redaction',
  );
  if (
    redaction.contract !== 'recognized_credentials_v1' ||
    redaction.residualSensitivity !== 'potentially_sensitive'
  ) {
    return invalid('run log redaction contract is invalid');
  }
  const replacements = boundedInteger(
    redaction.replacements,
    budget.sourceBytes,
    'run log redaction replacements',
  );
  const categories = canonicalSubset<RunLogRedactionCategory>(
    redaction.categories,
    RUN_LOG_REDACTION_CATEGORIES,
    'run log redaction categories',
  );

  const normalization = record(
    candidate.normalization,
    'run log normalization',
  );
  exactKeys(
    normalization,
    ['invalidUtf8', 'unsafeCodePointsReplaced'],
    'run log normalization',
  );
  if (typeof normalization.invalidUtf8 !== 'boolean') {
    return invalid('run log invalidUtf8 is invalid');
  }
  const unsafeCodePointsReplaced = boundedInteger(
    normalization.unsafeCodePointsReplaced,
    budget.sourceBytes,
    'run log unsafeCodePointsReplaced',
  );

  const trust = record(candidate.trust, 'run log trust');
  exactKeys(
    trust,
    [
      'classification',
      'instructionPolicy',
      'actionAuthority',
      'suspectedPromptInjection',
      'signals',
    ],
    'run log trust',
  );
  if (
    trust.classification !== 'untrusted_execution_output' ||
    trust.instructionPolicy !== 'data_only_never_execute' ||
    trust.actionAuthority !== 'none' ||
    typeof trust.suspectedPromptInjection !== 'boolean'
  ) {
    return invalid('run log trust contract is invalid');
  }
  const signals = canonicalSubset<RunLogPromptInjectionSignal>(
    trust.signals,
    RUN_LOG_PROMPT_INJECTION_SIGNALS,
    'run log prompt injection signals',
  );
  if (trust.suspectedPromptInjection !== signals.length > 0) {
    return invalid('run log prompt injection flag is inconsistent');
  }

  return Object.freeze({
    content: candidate.content,
    sourceBytes,
    modelTextBytes,
    redaction: Object.freeze({
      contract: 'recognized_credentials_v1' as const,
      residualSensitivity: 'potentially_sensitive' as const,
      replacements,
      categories,
    }),
    normalization: Object.freeze({
      invalidUtf8: normalization.invalidUtf8,
      unsafeCodePointsReplaced,
    }),
    trust: Object.freeze({
      classification: 'untrusted_execution_output' as const,
      instructionPolicy: 'data_only_never_execute' as const,
      actionAuthority: 'none' as const,
      suspectedPromptInjection: trust.suspectedPromptInjection,
      signals,
    }),
  });
}
