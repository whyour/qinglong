import { Buffer } from 'node:buffer';

import {
  MAX_MODEL_OUTPUT_BYTES,
  type GenerateRequest,
  type GenerateResult,
  type ModelChunk,
  type ModelFinishReason,
  type ModelInfo,
  type ModelInvocationContext,
  type ModelProvider,
  type ModelUsage,
} from './model';
import {
  InvalidModelValueError,
  normalizeGenerateRequest,
  normalizeModelInvocationContext,
  normalizeModelInfo,
  normalizeModelUsage,
} from './validation';
import type {
  ModelProviderAuthorizationLease,
  ModelProviderAuthorizationProvider,
  ModelProviderAuthorizationRequest,
} from '../model-provider-credential/providerCredential';

const MAX_OPENAI_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_OPENAI_MODELS = 256;
const MAX_OPENAI_AUTHORIZATION_BYTES = 4 * 1024;

export class OpenAiCompatibleConfigurationError extends TypeError {
  readonly code = 'OPENAI_COMPATIBLE_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(`OpenAI-compatible provider configuration is invalid: ${message}`);
    this.name = 'OpenAiCompatibleConfigurationError';
  }
}

export class OpenAiCompatibleHttpError extends Error {
  readonly code = 'OPENAI_COMPATIBLE_HTTP_ERROR';
  readonly status: number;

  constructor(status: number) {
    super(`OpenAI-compatible provider returned HTTP ${status}`);
    this.name = 'OpenAiCompatibleHttpError';
    this.status = status;
  }
}

export class OpenAiCompatibleProtocolError extends Error {
  readonly code = 'OPENAI_COMPATIBLE_PROTOCOL_ERROR';

  constructor(message: string, options?: ErrorOptions) {
    super(
      `OpenAI-compatible provider response is invalid: ${message}`,
      options,
    );
    this.name = 'OpenAiCompatibleProtocolError';
  }
}

export type OpenAiCompatibleCredentialProvider =
  ModelProviderAuthorizationProvider;

export interface OpenAiCompatibleListModelsContext {
  readonly projectId?: string;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

export interface OpenAiCompatibleProviderOptions {
  readonly type: string;
  readonly baseUrl: string;
  readonly credentials?: OpenAiCompatibleCredentialProvider;
  readonly fetch?: typeof globalThis.fetch;
  readonly allowPlaintextLoopback?: boolean;
  readonly maxResponseBytes?: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBaseUrl(value: string, allowPlaintextLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenAiCompatibleConfigurationError('baseUrl is not a URL');
  }
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && loopback && allowPlaintextLoopback))
  ) {
    throw new OpenAiCompatibleConfigurationError(
      'baseUrl must use HTTPS without credentials, query, or fragment',
    );
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function normalizeFinishReason(value: unknown): ModelFinishReason {
  if (value === 'stop') return 'stop';
  if (value === 'length') return 'length';
  if (value === 'content_filter') return 'content_filter';
  if (value === 'tool_calls' || value === 'function_call') return 'tool_call';
  return 'unknown';
}

function parseUsage(value: unknown): Readonly<ModelUsage> {
  if (!isRecord(value)) {
    throw new OpenAiCompatibleProtocolError('usage is missing');
  }
  const inputTokens = value.prompt_tokens;
  const outputTokens = value.completion_tokens;
  const totalTokens = value.total_tokens;
  try {
    return normalizeModelUsage({
      inputTokens: inputTokens as number,
      outputTokens: outputTokens as number,
      totalTokens: totalTokens as number,
    });
  } catch (cause) {
    throw new OpenAiCompatibleProtocolError('usage is invalid', { cause });
  }
}

async function readBoundedBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!response.body) {
    throw new OpenAiCompatibleProtocolError('response body is missing');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        throw new OpenAiCompatibleProtocolError(
          'response exceeds the byte limit',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const bytes = await readBoundedBytes(response, maximumBytes);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new OpenAiCompatibleProtocolError('response JSON is invalid', {
      cause,
    });
  }
}

function createRequestBody(
  request: Readonly<GenerateRequest>,
  stream: boolean,
): string {
  return JSON.stringify({
    model: request.model,
    messages: request.messages,
    max_tokens: request.maxOutputTokens,
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  });
}

function parseGenerateResult(
  provider: string,
  requestedModel: string,
  value: unknown,
): Readonly<GenerateResult> {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    throw new OpenAiCompatibleProtocolError('completion shape is invalid');
  }
  const choice = value.choices[0];
  if (
    !isRecord(choice) ||
    !isRecord(choice.message) ||
    typeof choice.message.content !== 'string'
  ) {
    throw new OpenAiCompatibleProtocolError('completion choice is invalid');
  }
  if (
    Buffer.byteLength(choice.message.content, 'utf8') > MAX_MODEL_OUTPUT_BYTES
  ) {
    throw new OpenAiCompatibleProtocolError(
      'completion text exceeds the hard byte limit',
    );
  }
  const model =
    typeof value.model === 'string' && value.model.length > 0
      ? value.model
      : requestedModel;
  if (model !== requestedModel) {
    throw new OpenAiCompatibleProtocolError(
      'completion model does not match the request',
    );
  }
  return Object.freeze({
    provider,
    model,
    text: choice.message.content,
    finishReason: normalizeFinishReason(choice.finish_reason),
    usage: parseUsage(value.usage),
  });
}

function parseStreamEvent(value: unknown): Readonly<ModelChunk> | null {
  if (!isRecord(value)) {
    throw new OpenAiCompatibleProtocolError('stream event is invalid');
  }
  const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
  let delta = '';
  let finishReason: ModelFinishReason | undefined;
  if (choice !== undefined) {
    if (!isRecord(choice)) {
      throw new OpenAiCompatibleProtocolError('stream choice is invalid');
    }
    if (isRecord(choice.delta) && choice.delta.content !== undefined) {
      if (typeof choice.delta.content !== 'string') {
        throw new OpenAiCompatibleProtocolError(
          'stream delta content is invalid',
        );
      }
      delta = choice.delta.content;
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      finishReason = normalizeFinishReason(choice.finish_reason);
    }
  }
  const usage =
    value.usage === undefined || value.usage === null
      ? undefined
      : parseUsage(value.usage);
  if (delta.length === 0 && finishReason === undefined && usage === undefined) {
    return null;
  }
  return Object.freeze({
    delta,
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(usage === undefined ? {} : { usage }),
  });
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly type: string;
  readonly #baseUrl: URL;
  readonly #credentials: OpenAiCompatibleCredentialProvider | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxResponseBytes: number;

  constructor(options: OpenAiCompatibleProviderOptions) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      typeof options.type !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(options.type) ||
      typeof options.baseUrl !== 'string' ||
      (options.credentials !== undefined &&
        (!options.credentials ||
          typeof options.credentials.authorizationHeader !== 'function')) ||
      (options.fetch !== undefined && typeof options.fetch !== 'function') ||
      (options.allowPlaintextLoopback !== undefined &&
        typeof options.allowPlaintextLoopback !== 'boolean')
    ) {
      throw new OpenAiCompatibleConfigurationError('options are invalid');
    }
    const maxResponseBytes =
      options.maxResponseBytes ?? MAX_OPENAI_RESPONSE_BYTES;
    if (
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > MAX_OPENAI_RESPONSE_BYTES
    ) {
      throw new OpenAiCompatibleConfigurationError(
        'maxResponseBytes is invalid',
      );
    }
    this.type = options.type;
    this.#baseUrl = normalizeBaseUrl(
      options.baseUrl,
      options.allowPlaintextLoopback ?? false,
    );
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxResponseBytes = maxResponseBytes;
  }

  async #request(
    url: URL,
    init: Omit<RequestInit, 'headers'>,
    authorizationRequest: Readonly<ModelProviderAuthorizationRequest>,
  ): Promise<Response> {
    let authorization: Readonly<ModelProviderAuthorizationLease> | null = null;
    let authorizationValue: string | null = null;
    let response: Response | undefined;
    try {
      authorization =
        (await this.#credentials?.authorizationHeader(authorizationRequest)) ??
        null;
      if (
        authorization !== null &&
        (!authorization ||
          typeof authorization !== 'object' ||
          Array.isArray(authorization) ||
          Object.keys(authorization).sort().join('\0') !==
            ['dispose', 'value'].join('\0') ||
          typeof authorization.value !== 'string' ||
          authorization.value.length < 1 ||
          Buffer.byteLength(authorization.value, 'utf8') >
            MAX_OPENAI_AUTHORIZATION_BYTES ||
          /[\r\n]/.test(authorization.value) ||
          typeof authorization.dispose !== 'function')
      ) {
        throw new OpenAiCompatibleConfigurationError(
          'authorization lease is invalid',
        );
      }
      authorizationValue = authorization === null ? null : authorization.value;
      response = await this.#fetch(url, {
        ...init,
        headers: Object.freeze({
          accept: 'application/json',
          'content-type': 'application/json',
          ...(authorizationValue === null
            ? {}
            : { authorization: authorizationValue }),
        }),
      });
      return response;
    } finally {
      if (authorization && typeof authorization.dispose === 'function') {
        try {
          await authorization.dispose();
        } catch (cause) {
          await response?.body?.cancel().catch(() => undefined);
          throw new OpenAiCompatibleConfigurationError(
            cause instanceof Error
              ? 'authorization lease disposal failed'
              : 'authorization lease disposal is invalid',
          );
        }
      }
    }
  }

  async listModels(
    context: Readonly<OpenAiCompatibleListModelsContext> = {},
  ): Promise<readonly ModelInfo[]> {
    const response = await this.#request(
      new URL('models', this.#baseUrl),
      {
        method: 'GET',
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
      Object.freeze({
        operation: 'list_models',
        provider: this.type,
        ...(context.projectId === undefined
          ? {}
          : { projectId: context.projectId }),
        ...(context.requestId === undefined
          ? {}
          : { requestId: context.requestId }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      }),
    );
    if (!response.ok) throw new OpenAiCompatibleHttpError(response.status);
    const value = await readBoundedJson(response, this.#maxResponseBytes);
    if (!isRecord(value) || !Array.isArray(value.data)) {
      throw new OpenAiCompatibleProtocolError('model list shape is invalid');
    }
    if (value.data.length > MAX_OPENAI_MODELS) {
      throw new OpenAiCompatibleProtocolError(
        'model list exceeds the item limit',
      );
    }
    return Object.freeze(
      value.data.map((entry) => {
        if (!isRecord(entry) || typeof entry.id !== 'string') {
          throw new OpenAiCompatibleProtocolError(
            'model list entry is invalid',
          );
        }
        return normalizeModelInfo({ id: entry.id });
      }),
    );
  }

  async generate(
    request: Readonly<GenerateRequest>,
    context: Readonly<ModelInvocationContext>,
  ): Promise<Readonly<GenerateResult>> {
    const normalizedRequest = normalizeGenerateRequest(request);
    const normalizedContext = normalizeModelInvocationContext(
      context,
      Date.now(),
    );
    if (normalizedRequest.provider !== this.type) {
      throw new InvalidModelValueError(
        'request provider does not match the adapter',
      );
    }
    const response = await this.#request(
      new URL('chat/completions', this.#baseUrl),
      {
        method: 'POST',
        body: createRequestBody(normalizedRequest, false),
        ...(normalizedContext.signal === undefined
          ? {}
          : { signal: normalizedContext.signal }),
      },
      Object.freeze({
        operation: 'generate',
        provider: this.type,
        projectId: normalizedContext.projectId,
        requestId: normalizedContext.requestId,
        ...(normalizedContext.signal === undefined
          ? {}
          : { signal: normalizedContext.signal }),
      }),
    );
    if (!response.ok) throw new OpenAiCompatibleHttpError(response.status);
    return parseGenerateResult(
      this.type,
      normalizedRequest.model,
      await readBoundedJson(response, this.#maxResponseBytes),
    );
  }

  async *stream(
    request: Readonly<GenerateRequest>,
    context: Readonly<ModelInvocationContext>,
  ): AsyncIterable<Readonly<ModelChunk>> {
    const normalizedRequest = normalizeGenerateRequest(request);
    const normalizedContext = normalizeModelInvocationContext(
      context,
      Date.now(),
    );
    if (normalizedRequest.provider !== this.type) {
      throw new InvalidModelValueError(
        'request provider does not match the adapter',
      );
    }
    const response = await this.#request(
      new URL('chat/completions', this.#baseUrl),
      {
        method: 'POST',
        body: createRequestBody(normalizedRequest, true),
        ...(normalizedContext.signal === undefined
          ? {}
          : { signal: normalizedContext.signal }),
      },
      Object.freeze({
        operation: 'stream',
        provider: this.type,
        projectId: normalizedContext.projectId,
        requestId: normalizedContext.requestId,
        ...(normalizedContext.signal === undefined
          ? {}
          : { signal: normalizedContext.signal }),
      }),
    );
    if (!response.ok) throw new OpenAiCompatibleHttpError(response.status);
    if (!response.body) {
      throw new OpenAiCompatibleProtocolError('stream body is missing');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffered = '';
    let receivedBytes = 0;
    let doneEvent = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > this.#maxResponseBytes) {
          throw new OpenAiCompatibleProtocolError(
            'stream exceeds the byte limit',
          );
        }
        buffered += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffered, 'utf8') > this.#maxResponseBytes) {
          throw new OpenAiCompatibleProtocolError(
            'stream event buffer exceeds the byte limit',
          );
        }
        while (true) {
          const lfBoundary = buffered.indexOf('\n\n');
          const crlfBoundary = buffered.indexOf('\r\n\r\n');
          const boundary =
            lfBoundary < 0
              ? crlfBoundary
              : crlfBoundary < 0
              ? lfBoundary
              : Math.min(lfBoundary, crlfBoundary);
          if (boundary < 0) break;
          const boundaryLength = buffered.startsWith('\r\n\r\n', boundary)
            ? 4
            : 2;
          const event = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + boundaryLength);
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data.length === 0) continue;
          if (data === '[DONE]') {
            doneEvent = true;
            break;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch (cause) {
            throw new OpenAiCompatibleProtocolError(
              'stream event JSON is invalid',
              { cause },
            );
          }
          const chunk = parseStreamEvent(parsed);
          if (chunk) yield chunk;
        }
        if (doneEvent) break;
      }
      buffered += decoder.decode();
      if (!doneEvent) {
        throw new OpenAiCompatibleProtocolError(
          'stream ended without a done event',
        );
      }
    } finally {
      if (!doneEvent) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
