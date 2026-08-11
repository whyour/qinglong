import { Buffer } from 'node:buffer';

import {
  MAX_MODEL_INPUT_BYTES,
  MAX_MODEL_INVOCATION_MS,
  MAX_MODEL_MESSAGE_BYTES,
  MAX_MODEL_MESSAGES,
  MAX_MODEL_OUTPUT_BYTES,
  MAX_MODEL_OUTPUT_TOKENS,
  MODEL_FINISH_REASONS,
  MODEL_MESSAGE_ROLES,
  type GenerateRequest,
  type GenerateResult,
  type ModelChunk,
  type ModelInfo,
  type ModelInvocationContext,
  type ModelInvocationPolicy,
  type ModelMessage,
  type ModelUsage,
} from './model';
import { normalizeModelInvocationProjectQuotaPolicy } from '../usage/usageQuota';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class InvalidModelValueError extends TypeError {
  readonly code = 'MODEL_VALUE_INVALID';

  constructor(message: string) {
    super(`Model value is invalid: ${message}`);
    this.name = 'InvalidModelValueError';
  }
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  name: string,
): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidModelValueError(`${name} shape is invalid`);
  }
}

function normalizeIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new InvalidModelValueError(`${name} is invalid`);
  }
  return value;
}

function normalizeNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidModelValueError(`${name} is invalid`);
  }
  return value as number;
}

function normalizePositiveInteger(
  value: unknown,
  name: string,
  maximum: number,
): number {
  const normalized = normalizeNonNegativeInteger(value, name);
  if (normalized < 1 || normalized > maximum) {
    throw new InvalidModelValueError(`${name} is out of range`);
  }
  return normalized;
}

function normalizeMessage(value: ModelMessage): Readonly<ModelMessage> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidModelValueError('message must be an object');
  }
  assertExactKeys(value, ['role', 'content'], 'message');
  if (!MODEL_MESSAGE_ROLES.includes(value.role)) {
    throw new InvalidModelValueError('message role is invalid');
  }
  if (
    typeof value.content !== 'string' ||
    Buffer.byteLength(value.content, 'utf8') > MAX_MODEL_MESSAGE_BYTES
  ) {
    throw new InvalidModelValueError('message content is invalid');
  }
  return Object.freeze({ role: value.role, content: value.content });
}

export function normalizeGenerateRequest(
  value: GenerateRequest,
): Readonly<GenerateRequest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidModelValueError('request must be an object');
  }
  const expected = ['provider', 'model', 'messages', 'maxOutputTokens'];
  if (Object.hasOwn(value, 'temperature')) expected.push('temperature');
  assertExactKeys(value, expected, 'request');
  const provider = normalizeIdentifier(value.provider, 'provider');
  const model = normalizeIdentifier(value.model, 'model');
  if (
    !Array.isArray(value.messages) ||
    value.messages.length < 1 ||
    value.messages.length > MAX_MODEL_MESSAGES
  ) {
    throw new InvalidModelValueError('messages are invalid');
  }
  const messages = Object.freeze(value.messages.map(normalizeMessage));
  if (measureModelInputBytes(messages) > MAX_MODEL_INPUT_BYTES) {
    throw new InvalidModelValueError('input exceeds the hard byte limit');
  }
  const maxOutputTokens = normalizePositiveInteger(
    value.maxOutputTokens,
    'maxOutputTokens',
    MAX_MODEL_OUTPUT_TOKENS,
  );
  if (
    value.temperature !== undefined &&
    (typeof value.temperature !== 'number' ||
      !Number.isFinite(value.temperature) ||
      value.temperature < 0 ||
      value.temperature > 2)
  ) {
    throw new InvalidModelValueError('temperature is invalid');
  }
  return Object.freeze({
    provider,
    model,
    messages,
    maxOutputTokens,
    ...(value.temperature === undefined
      ? {}
      : { temperature: value.temperature }),
  });
}

export function normalizeModelInvocationContext(
  value: ModelInvocationContext,
  nowMs: number,
): Readonly<ModelInvocationContext> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidModelValueError('context must be an object');
  }
  const expected = [
    'projectId',
    'runId',
    'stepRunId',
    'traceId',
    'requestId',
    'deadlineAtMs',
  ];
  if (Object.hasOwn(value, 'signal')) expected.push('signal');
  assertExactKeys(value, expected, 'context');
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(value.deadlineAtMs) ||
    value.deadlineAtMs <= nowMs ||
    value.deadlineAtMs - nowMs > MAX_MODEL_INVOCATION_MS
  ) {
    throw new InvalidModelValueError('deadlineAtMs is invalid');
  }
  if (
    value.signal !== undefined &&
    (!(value.signal instanceof AbortSignal) || value.signal.aborted)
  ) {
    throw new InvalidModelValueError('signal is invalid');
  }
  return Object.freeze({
    projectId: normalizeIdentifier(value.projectId, 'projectId'),
    runId: normalizeIdentifier(value.runId, 'runId'),
    stepRunId: normalizeIdentifier(value.stepRunId, 'stepRunId'),
    traceId: normalizeIdentifier(value.traceId, 'traceId'),
    requestId: normalizeIdentifier(value.requestId, 'requestId'),
    deadlineAtMs: value.deadlineAtMs,
    ...(value.signal === undefined ? {} : { signal: value.signal }),
  });
}

export function normalizeModelInvocationPolicy(
  value: ModelInvocationPolicy,
): Readonly<ModelInvocationPolicy> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidModelValueError('policy must be an object');
  }
  const expected = [
    'revision',
    'allowedProviders',
    'allowedModels',
    'maxInputBytes',
    'maxOutputBytes',
    'maxOutputTokens',
    'maxTotalTokens',
    'maxCostMicros',
    'priceRevision',
  ];
  if (Object.hasOwn(value, 'projectQuota')) expected.push('projectQuota');
  assertExactKeys(value, expected, 'policy');
  if (
    typeof value.revision !== 'string' ||
    !REVISION_PATTERN.test(value.revision)
  ) {
    throw new InvalidModelValueError('policy revision is invalid');
  }
  const normalizeAllowlist = (
    entries: readonly string[],
    name: string,
  ): readonly string[] => {
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 128) {
      throw new InvalidModelValueError(`${name} is invalid`);
    }
    const normalized = entries.map((entry) => normalizeIdentifier(entry, name));
    if (new Set(normalized).size !== normalized.length) {
      throw new InvalidModelValueError(`${name} contains duplicates`);
    }
    return Object.freeze(normalized);
  };
  const maxInputBytes = normalizePositiveInteger(
    value.maxInputBytes,
    'maxInputBytes',
    MAX_MODEL_INPUT_BYTES,
  );
  const maxOutputBytes = normalizePositiveInteger(
    value.maxOutputBytes,
    'maxOutputBytes',
    MAX_MODEL_OUTPUT_BYTES,
  );
  const maxOutputTokens = normalizePositiveInteger(
    value.maxOutputTokens,
    'maxOutputTokens',
    MAX_MODEL_OUTPUT_TOKENS,
  );
  const maxTotalTokens = normalizePositiveInteger(
    value.maxTotalTokens,
    'maxTotalTokens',
    MAX_MODEL_OUTPUT_TOKENS * 16,
  );
  if (maxOutputTokens > maxTotalTokens) {
    throw new InvalidModelValueError('maxOutputTokens exceeds maxTotalTokens');
  }
  if (
    value.maxCostMicros !== null &&
    (!Number.isSafeInteger(value.maxCostMicros) || value.maxCostMicros < 0)
  ) {
    throw new InvalidModelValueError('maxCostMicros is invalid');
  }
  if (
    value.priceRevision !== null &&
    (typeof value.priceRevision !== 'string' ||
      !REVISION_PATTERN.test(value.priceRevision))
  ) {
    throw new InvalidModelValueError('priceRevision is invalid');
  }
  return Object.freeze({
    revision: value.revision,
    allowedProviders: normalizeAllowlist(
      value.allowedProviders,
      'allowedProviders',
    ),
    allowedModels: normalizeAllowlist(value.allowedModels, 'allowedModels'),
    maxInputBytes,
    maxOutputBytes,
    maxOutputTokens,
    maxTotalTokens,
    maxCostMicros: value.maxCostMicros,
    priceRevision: value.priceRevision,
    ...(value.projectQuota === undefined
      ? {}
      : {
          projectQuota: normalizeModelInvocationProjectQuotaPolicy(
            value.projectQuota,
          ),
        }),
  });
}

export function normalizeModelUsage(value: ModelUsage): Readonly<ModelUsage> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidModelValueError('usage must be an object');
  }
  const expected = ['inputTokens', 'outputTokens', 'totalTokens'];
  if (Object.hasOwn(value, 'costMicros')) expected.push('costMicros');
  assertExactKeys(value, expected, 'usage');
  const inputTokens = normalizeNonNegativeInteger(
    value.inputTokens,
    'inputTokens',
  );
  const outputTokens = normalizeNonNegativeInteger(
    value.outputTokens,
    'outputTokens',
  );
  const totalTokens = normalizeNonNegativeInteger(
    value.totalTokens,
    'totalTokens',
  );
  if (totalTokens !== inputTokens + outputTokens) {
    throw new InvalidModelValueError('totalTokens is inconsistent');
  }
  if (
    value.costMicros !== undefined &&
    (!Number.isSafeInteger(value.costMicros) || value.costMicros < 0)
  ) {
    throw new InvalidModelValueError('costMicros is invalid');
  }
  return Object.freeze({
    inputTokens,
    outputTokens,
    totalTokens,
    ...(value.costMicros === undefined ? {} : { costMicros: value.costMicros }),
  });
}

export function normalizeGenerateResult(
  value: GenerateResult,
): Readonly<GenerateResult> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidModelValueError('result must be an object');
  }
  assertExactKeys(
    value,
    ['provider', 'model', 'text', 'finishReason', 'usage'],
    'result',
  );
  if (
    typeof value.text !== 'string' ||
    Buffer.byteLength(value.text, 'utf8') > MAX_MODEL_OUTPUT_BYTES
  ) {
    throw new InvalidModelValueError('result text is invalid');
  }
  if (!MODEL_FINISH_REASONS.includes(value.finishReason)) {
    throw new InvalidModelValueError('finishReason is invalid');
  }
  return Object.freeze({
    provider: normalizeIdentifier(value.provider, 'result provider'),
    model: normalizeIdentifier(value.model, 'result model'),
    text: value.text,
    finishReason: value.finishReason,
    usage: normalizeModelUsage(value.usage),
  });
}

export function normalizeModelChunk(value: ModelChunk): Readonly<ModelChunk> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidModelValueError('chunk must be an object');
  }
  const expected = ['delta'];
  if (Object.hasOwn(value, 'finishReason')) expected.push('finishReason');
  if (Object.hasOwn(value, 'usage')) expected.push('usage');
  assertExactKeys(value, expected, 'chunk');
  if (
    typeof value.delta !== 'string' ||
    Buffer.byteLength(value.delta, 'utf8') > MAX_MODEL_OUTPUT_BYTES
  ) {
    throw new InvalidModelValueError('chunk delta is invalid');
  }
  if (
    value.finishReason !== undefined &&
    !MODEL_FINISH_REASONS.includes(value.finishReason)
  ) {
    throw new InvalidModelValueError('chunk finishReason is invalid');
  }
  return Object.freeze({
    delta: value.delta,
    ...(value.finishReason === undefined
      ? {}
      : { finishReason: value.finishReason }),
    ...(value.usage === undefined
      ? {}
      : { usage: normalizeModelUsage(value.usage) }),
  });
}

export function normalizeModelInfo(value: ModelInfo): Readonly<ModelInfo> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidModelValueError('model info must be an object');
  }
  const expected = ['id'];
  if (Object.hasOwn(value, 'displayName')) expected.push('displayName');
  if (Object.hasOwn(value, 'contextWindowTokens')) {
    expected.push('contextWindowTokens');
  }
  assertExactKeys(value, expected, 'model info');
  const id = normalizeIdentifier(value.id, 'model id');
  if (
    value.displayName !== undefined &&
    (typeof value.displayName !== 'string' ||
      value.displayName.length < 1 ||
      Buffer.byteLength(value.displayName, 'utf8') > 256)
  ) {
    throw new InvalidModelValueError('model displayName is invalid');
  }
  if (
    value.contextWindowTokens !== undefined &&
    (!Number.isSafeInteger(value.contextWindowTokens) ||
      value.contextWindowTokens < 1)
  ) {
    throw new InvalidModelValueError('contextWindowTokens is invalid');
  }
  return Object.freeze({
    id,
    ...(value.displayName === undefined
      ? {}
      : { displayName: value.displayName }),
    ...(value.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: value.contextWindowTokens }),
  });
}

export function measureModelInputBytes(
  messages: readonly ModelMessage[],
): number {
  return messages.reduce(
    (total, message) =>
      total +
      Buffer.byteLength(message.role, 'utf8') +
      Buffer.byteLength(message.content, 'utf8'),
    0,
  );
}
