import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
  MAX_MODEL_PROVIDERS,
  type GenerateRequest,
  type GenerateResult,
  type ModelChunk,
  type ModelInvocationAuditRecord,
  type ModelInvocationAuditResult,
  type ModelInvocationAuditSink,
  type ModelInvocationContext,
  type ModelInvocationPolicy,
  type ModelInvocationPolicyProvider,
  type ModelProvider,
  type ModelUsage,
} from './model';
import {
  InvalidModelValueError,
  measureModelInputBytes,
  normalizeGenerateRequest,
  normalizeGenerateResult,
  normalizeModelChunk,
  normalizeModelInvocationContext,
  normalizeModelInvocationPolicy,
} from './validation';
import {
  ModelInvocationProjectQuotaExceededError,
  ModelInvocationQuotaConfigurationError,
  createModelInvocationQuotaAdmission,
} from '../usage/usageQuota';
import {
  ModelPriceUnavailableError,
  ModelPricingConfigurationError,
  createModelInvocationPriceQuote,
  normalizeModelPriceCatalogEntry,
  priceModelUsage,
  type ModelInvocationPriceQuote,
  type ModelPriceCatalogResolver,
} from '../pricing/pricing';

export const MAX_MODEL_GATEWAY_CONCURRENCY = 64;

export class ModelProviderUnavailableError extends Error {
  readonly code = 'MODEL_PROVIDER_UNAVAILABLE';

  constructor() {
    super('The requested model provider is unavailable');
    this.name = 'ModelProviderUnavailableError';
  }
}

export class ModelPolicyDeniedError extends Error {
  readonly code = 'MODEL_POLICY_DENIED';

  constructor() {
    super('The model invocation is denied by policy');
    this.name = 'ModelPolicyDeniedError';
  }
}

export class ModelBudgetExceededError extends Error {
  readonly code = 'MODEL_BUDGET_EXCEEDED';

  constructor() {
    super('The model invocation exceeded its bounded budget');
    this.name = 'ModelBudgetExceededError';
  }
}

export class ModelGatewayBusyError extends Error {
  readonly code = 'MODEL_GATEWAY_BUSY';

  constructor() {
    super('The model gateway concurrency budget is exhausted');
    this.name = 'ModelGatewayBusyError';
  }
}

export class ModelInvocationAbortedError extends Error {
  readonly code = 'MODEL_INVOCATION_ABORTED';

  constructor() {
    super('The model invocation was aborted');
    this.name = 'ModelInvocationAbortedError';
  }
}

export class ModelInvocationDeadlineExceededError extends Error {
  readonly code = 'MODEL_INVOCATION_DEADLINE_EXCEEDED';

  constructor() {
    super('The model invocation deadline was exceeded');
    this.name = 'ModelInvocationDeadlineExceededError';
  }
}

export class ModelInvocationReplayBlockedError extends Error {
  readonly code = 'MODEL_INVOCATION_REPLAY_BLOCKED';

  constructor() {
    super(
      'An existing model invocation cannot be executed again automatically',
    );
    this.name = 'ModelInvocationReplayBlockedError';
  }
}

export class ModelAuditUnavailableError extends Error {
  readonly code = 'MODEL_AUDIT_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('The model invocation audit sink is unavailable', options);
    this.name = 'ModelAuditUnavailableError';
  }
}

export interface BoundedModelGatewayOptions {
  readonly providers: readonly ModelProvider[];
  readonly policies: ModelInvocationPolicyProvider;
  readonly pricing: ModelPriceCatalogResolver;
  readonly audit: ModelInvocationAuditSink;
  readonly successfulCompletion?: ModelInvocationSuccessfulCompletionSink;
  readonly maxConcurrent: number;
  readonly now?: () => number;
}

export interface ModelInvocationSuccessfulCompletionSink {
  record(
    audit: Readonly<ModelInvocationAuditRecord>,
    result: Readonly<GenerateResult>,
  ): Promise<
    Readonly<
      | { handled: false }
      | {
          handled: true;
          disposition: ModelInvocationAuditResult;
        }
    >
  >;
}

interface PreparedInvocation {
  readonly request: Readonly<GenerateRequest>;
  readonly context: Readonly<ModelInvocationContext>;
  readonly policy: Readonly<ModelInvocationPolicy>;
  readonly provider: ModelProvider;
  readonly requestDigest: string;
  readonly inputBytes: number;
  readonly priceQuote: Readonly<ModelInvocationPriceQuote> | null;
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
  ) {
    return error.code;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'MODEL_INVOCATION_ABORTED';
  }
  return 'MODEL_PROVIDER_FAILED';
}

function createRequestDigest(request: Readonly<GenerateRequest>): string {
  const hash = createHash('sha256');
  hash.update('qinglong/model-invocation-request@v1\0', 'utf8');
  hash.update(request.provider, 'utf8');
  hash.update('\0', 'utf8');
  hash.update(request.model, 'utf8');
  hash.update('\0', 'utf8');
  hash.update(String(request.maxOutputTokens), 'utf8');
  hash.update('\0', 'utf8');
  hash.update(
    request.temperature === undefined ? '' : String(request.temperature),
  );
  for (const message of request.messages) {
    hash.update('\0', 'utf8');
    hash.update(message.role, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(message.content, 'utf8');
  }
  return `sha256:${hash.digest('hex')}`;
}

function assertWithinPolicy(
  request: Readonly<GenerateRequest>,
  inputBytes: number,
  policy: Readonly<ModelInvocationPolicy>,
): void {
  if (
    !policy.allowedProviders.includes(request.provider) ||
    !policy.allowedModels.includes(request.model)
  ) {
    throw new ModelPolicyDeniedError();
  }
  if (
    inputBytes > policy.maxInputBytes ||
    request.maxOutputTokens > policy.maxOutputTokens
  ) {
    throw new ModelBudgetExceededError();
  }
}

function assertUsageWithinPolicy(
  usage: Readonly<ModelUsage>,
  policy: Readonly<ModelInvocationPolicy>,
): void {
  if (
    usage.outputTokens > policy.maxOutputTokens ||
    usage.totalTokens > policy.maxTotalTokens ||
    (policy.maxCostMicros !== null &&
      (usage.costMicros === undefined ||
        usage.costMicros > policy.maxCostMicros))
  ) {
    throw new ModelBudgetExceededError();
  }
}

function createInvocationAbort(
  context: Readonly<ModelInvocationContext>,
  nowMs: number,
): Readonly<{
  signal: AbortSignal;
  error(): ModelInvocationAbortedError | ModelInvocationDeadlineExceededError;
  cancel(): void;
  dispose(): void;
}> {
  const controller = new AbortController();
  let cause: 'caller' | 'deadline' | null = null;
  const abortFromCaller = (): void => {
    if (cause === null) cause = 'caller';
    controller.abort();
  };
  const abortFromDeadline = (): void => {
    if (cause === null) cause = 'deadline';
    controller.abort();
  };
  context.signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (context.signal?.aborted) abortFromCaller();
  const timer = setTimeout(
    abortFromDeadline,
    Math.max(1, context.deadlineAtMs - nowMs),
  );
  timer.unref();
  return Object.freeze({
    signal: controller.signal,
    error():
      | ModelInvocationAbortedError
      | ModelInvocationDeadlineExceededError {
      return cause === 'deadline'
        ? new ModelInvocationDeadlineExceededError()
        : new ModelInvocationAbortedError();
    },
    cancel(): void {
      abortFromCaller();
    },
    dispose(): void {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', abortFromCaller);
    },
  });
}

function withSignal(
  context: Readonly<ModelInvocationContext>,
  signal: AbortSignal,
): Readonly<ModelInvocationContext> {
  return Object.freeze({
    projectId: context.projectId,
    runId: context.runId,
    stepRunId: context.stepRunId,
    traceId: context.traceId,
    requestId: context.requestId,
    deadlineAtMs: context.deadlineAtMs,
    signal,
  });
}

function awaitAbortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  abortError: () => Error = () => new ModelInvocationAbortedError(),
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export class BoundedModelGateway {
  readonly #providers: ReadonlyMap<string, ModelProvider>;
  readonly #policies: ModelInvocationPolicyProvider;
  readonly #pricing: ModelPriceCatalogResolver;
  readonly #audit: ModelInvocationAuditSink;
  readonly #successfulCompletion:
    | ModelInvocationSuccessfulCompletionSink
    | undefined;
  readonly #maxConcurrent: number;
  readonly #now: () => number;
  #active = 0;

  constructor(options: BoundedModelGatewayOptions) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      !Array.isArray(options.providers) ||
      options.providers.length < 1 ||
      options.providers.length > MAX_MODEL_PROVIDERS ||
      !options.policies ||
      typeof options.policies.resolve !== 'function' ||
      !options.pricing ||
      typeof options.pricing.resolve !== 'function' ||
      !options.audit ||
      typeof options.audit.record !== 'function' ||
      (options.successfulCompletion !== undefined &&
        (!options.successfulCompletion ||
          typeof options.successfulCompletion.record !== 'function')) ||
      !Number.isSafeInteger(options.maxConcurrent) ||
      options.maxConcurrent < 1 ||
      options.maxConcurrent > MAX_MODEL_GATEWAY_CONCURRENCY ||
      (options.now !== undefined && typeof options.now !== 'function')
    ) {
      throw new InvalidModelValueError('gateway options are invalid');
    }
    const providers = new Map<string, ModelProvider>();
    for (const provider of options.providers) {
      if (
        !provider ||
        typeof provider.type !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(provider.type) ||
        typeof provider.generate !== 'function' ||
        typeof provider.stream !== 'function' ||
        typeof provider.listModels !== 'function' ||
        providers.has(provider.type)
      ) {
        throw new InvalidModelValueError('provider registry is invalid');
      }
      providers.set(provider.type, provider);
    }
    this.#providers = providers;
    this.#policies = options.policies;
    this.#pricing = options.pricing;
    this.#audit = options.audit;
    this.#successfulCompletion = options.successfulCompletion;
    this.#maxConcurrent = options.maxConcurrent;
    this.#now = options.now ?? Date.now;
  }

  get activeInvocations(): number {
    return this.#active;
  }

  supportsSuccessfulCompletionSink(
    sink: ModelInvocationSuccessfulCompletionSink,
  ): boolean {
    return this.#successfulCompletion === sink;
  }

  async #prepare(
    request: Readonly<GenerateRequest>,
    context: Readonly<ModelInvocationContext>,
    signal: AbortSignal,
    abortError: () => Error,
  ): Promise<PreparedInvocation> {
    const invocationContext = withSignal(context, signal);
    const inputBytes = measureModelInputBytes(request.messages);
    const policy = normalizeModelInvocationPolicy(
      await awaitAbortable(
        this.#policies.resolve(invocationContext),
        signal,
        abortError,
      ),
    );
    assertWithinPolicy(request, inputBytes, policy);
    const provider = this.#providers.get(request.provider);
    if (!provider) throw new ModelProviderUnavailableError();
    const priceRevision = policy.priceRevision;
    const priceQuote =
      priceRevision === null
        ? null
        : await (async () => {
            const entryValue = await awaitAbortable(
              this.#pricing.resolve({
                provider: request.provider,
                model: request.model,
                priceRevision,
                signal,
              }),
              signal,
              abortError,
            );
            if (!entryValue) throw new ModelPriceUnavailableError();
            const entry = normalizeModelPriceCatalogEntry(entryValue);
            if (
              entry.provider !== request.provider ||
              entry.model !== request.model ||
              entry.priceRevision !== priceRevision
            ) {
              throw new ModelPriceUnavailableError();
            }
            const quote = createModelInvocationPriceQuote(entry, {
              invocationId: context.requestId,
              projectId: context.projectId,
              modelPolicyRevision: policy.revision,
              maxTotalTokens: policy.maxTotalTokens,
              maxOutputTokens: request.maxOutputTokens,
            });
            if (
              policy.maxCostMicros !== null &&
              quote.reservedCostMicros > policy.maxCostMicros
            ) {
              throw new ModelBudgetExceededError();
            }
            return quote;
          })();
    if (
      priceQuote === null &&
      (policy.maxCostMicros !== null ||
        (policy.projectQuota !== undefined &&
          policy.projectQuota.maxCostMicros !== null))
    ) {
      throw new ModelPriceUnavailableError();
    }
    return Object.freeze({
      request,
      context: invocationContext,
      policy,
      provider,
      requestDigest: createRequestDigest(request),
      inputBytes,
      priceQuote,
    });
  }

  async #record(
    prepared: PreparedInvocation,
    phase: ModelInvocationAuditRecord['phase'],
    outputBytes: number,
    usage: Readonly<ModelUsage> | null,
    invocationErrorCode: string | null,
    result?: Readonly<GenerateResult>,
  ): Promise<ModelInvocationAuditResult> {
    try {
      const auditRecord = Object.freeze({
        phase,
        projectId: prepared.context.projectId,
        runId: prepared.context.runId,
        stepRunId: prepared.context.stepRunId,
        traceId: prepared.context.traceId,
        requestId: prepared.context.requestId,
        provider: prepared.request.provider,
        model: prepared.request.model,
        policyRevision: prepared.policy.revision,
        requestDigest: prepared.requestDigest,
        deadlineAtMs: prepared.context.deadlineAtMs,
        inputBytes: prepared.inputBytes,
        maxOutputTokens: prepared.request.maxOutputTokens,
        outputBytes,
        usage,
        errorCode: invocationErrorCode,
        occurredAtMs: this.#now(),
      });
      const quotaAdmission =
        phase === 'admitted' && prepared.policy.projectQuota
          ? createModelInvocationQuotaAdmission({
              invocationId: prepared.context.requestId,
              projectId: prepared.context.projectId,
              modelPolicyRevision: prepared.policy.revision,
              reservedTokens: prepared.policy.maxTotalTokens,
              reservedCostMicros:
                prepared.policy.projectQuota.maxCostMicros === null
                  ? null
                  : prepared.priceQuote?.reservedCostMicros ?? null,
              quota: prepared.policy.projectQuota,
            })
          : undefined;
      const successfulCompletion =
        phase === 'completed' && result && this.#successfulCompletion
          ? await this.#successfulCompletion.record(auditRecord, result)
          : undefined;
      if (
        successfulCompletion !== undefined &&
        (!successfulCompletion ||
          typeof successfulCompletion !== 'object' ||
          Array.isArray(successfulCompletion) ||
          (successfulCompletion.handled !== true &&
            successfulCompletion.handled !== false) ||
          (successfulCompletion.handled === false &&
            Object.keys(successfulCompletion).length !== 1) ||
          (successfulCompletion.handled === true &&
            Object.keys(successfulCompletion).sort().join('\0') !==
              ['disposition', 'handled'].join('\0')))
      ) {
        throw new TypeError('Successful completion disposition is invalid');
      }
      const disposition =
        successfulCompletion?.handled === true
          ? successfulCompletion.disposition
          : phase === 'admitted' && prepared.priceQuote
          ? await (() => {
              if (typeof this.#audit.recordWithPricing !== 'function') {
                throw new ModelPricingConfigurationError();
              }
              return this.#audit.recordWithPricing(
                auditRecord,
                prepared.priceQuote,
                quotaAdmission,
              );
            })()
          : quotaAdmission
          ? await (() => {
              if (typeof this.#audit.recordWithQuota !== 'function') {
                throw new ModelInvocationQuotaConfigurationError();
              }
              return this.#audit.recordWithQuota(auditRecord, quotaAdmission);
            })()
          : await this.#audit.record(auditRecord);
      if (disposition === undefined) return undefined;
      if (
        disposition &&
        typeof disposition === 'object' &&
        !Array.isArray(disposition) &&
        (disposition.status === 'created' ||
          disposition.status === 'existing') &&
        Object.keys(disposition).length === 1
      ) {
        return Object.freeze({ status: disposition.status });
      }
      throw new TypeError('Model audit disposition is invalid');
    } catch (cause) {
      if (
        cause instanceof ModelInvocationProjectQuotaExceededError ||
        cause instanceof ModelInvocationQuotaConfigurationError ||
        cause instanceof ModelPricingConfigurationError
      ) {
        throw cause;
      }
      throw new ModelAuditUnavailableError({ cause });
    }
  }

  async generate(
    request: GenerateRequest,
    context: ModelInvocationContext,
  ): Promise<Readonly<GenerateResult>> {
    const nowMs = this.#now();
    const normalizedRequest = normalizeGenerateRequest(request);
    const normalizedContext = normalizeModelInvocationContext(context, nowMs);
    if (this.#active >= this.#maxConcurrent) {
      throw new ModelGatewayBusyError();
    }
    this.#active += 1;
    const abort = createInvocationAbort(normalizedContext, nowMs);
    let prepared: PreparedInvocation | undefined;
    let admitted = false;
    let outputBytes = 0;
    let usage: Readonly<ModelUsage> | null = null;
    try {
      prepared = await this.#prepare(
        normalizedRequest,
        normalizedContext,
        abort.signal,
        () => abort.error(),
      );
      const admission = await this.#record(prepared, 'admitted', 0, null, null);
      if (admission?.status === 'existing') {
        throw new ModelInvocationReplayBlockedError();
      }
      admitted = true;
      if (abort.signal.aborted) throw abort.error();
      const providerResult = normalizeGenerateResult(
        await awaitAbortable(
          prepared.provider.generate(prepared.request, prepared.context),
          abort.signal,
          () => abort.error(),
        ),
      );
      const result = prepared.priceQuote
        ? Object.freeze({
            ...providerResult,
            usage: priceModelUsage(prepared.priceQuote, providerResult.usage),
          })
        : providerResult;
      if (
        result.provider !== prepared.request.provider ||
        result.model !== prepared.request.model
      ) {
        throw new InvalidModelValueError(
          'provider result identity does not match the request',
        );
      }
      outputBytes = Buffer.byteLength(result.text, 'utf8');
      usage = result.usage;
      if (outputBytes > prepared.policy.maxOutputBytes) {
        throw new ModelBudgetExceededError();
      }
      assertUsageWithinPolicy(usage, prepared.policy);
      await this.#record(
        prepared,
        'completed',
        outputBytes,
        usage,
        null,
        result,
      );
      return result;
    } catch (error) {
      const normalizedError =
        abort.signal.aborted &&
        !(error instanceof ModelAuditUnavailableError) &&
        !(error instanceof ModelBudgetExceededError)
          ? abort.error()
          : error;
      if (
        prepared &&
        admitted &&
        !(normalizedError instanceof ModelAuditUnavailableError)
      ) {
        await this.#record(
          prepared,
          'failed',
          outputBytes,
          usage,
          errorCode(normalizedError),
        );
      }
      throw normalizedError;
    } finally {
      abort.dispose();
      this.#active -= 1;
    }
  }

  async *stream(
    request: GenerateRequest,
    context: ModelInvocationContext,
  ): AsyncIterable<Readonly<ModelChunk>> {
    const nowMs = this.#now();
    const normalizedRequest = normalizeGenerateRequest(request);
    const normalizedContext = normalizeModelInvocationContext(context, nowMs);
    if (this.#active >= this.#maxConcurrent) {
      throw new ModelGatewayBusyError();
    }
    this.#active += 1;
    const abort = createInvocationAbort(normalizedContext, nowMs);
    let prepared: PreparedInvocation | undefined;
    let iterator: AsyncIterator<Readonly<ModelChunk>> | undefined;
    let admitted = false;
    let outputBytes = 0;
    let usage: Readonly<ModelUsage> | null = null;
    let completed = false;
    let failureRecorded = false;
    try {
      prepared = await this.#prepare(
        normalizedRequest,
        normalizedContext,
        abort.signal,
        () => abort.error(),
      );
      const admission = await this.#record(prepared, 'admitted', 0, null, null);
      if (admission?.status === 'existing') {
        throw new ModelInvocationReplayBlockedError();
      }
      admitted = true;
      if (abort.signal.aborted) throw abort.error();
      iterator = prepared.provider
        .stream(prepared.request, prepared.context)
        [Symbol.asyncIterator]();
      while (true) {
        const next = await awaitAbortable(iterator.next(), abort.signal, () =>
          abort.error(),
        );
        if (next.done) break;
        const rawChunk = next.value;
        const normalizedChunk = normalizeModelChunk(rawChunk);
        const chunk =
          normalizedChunk.usage && prepared.priceQuote
            ? Object.freeze({
                ...normalizedChunk,
                usage: priceModelUsage(
                  prepared.priceQuote,
                  normalizedChunk.usage,
                ),
              })
            : normalizedChunk;
        outputBytes += Buffer.byteLength(chunk.delta, 'utf8');
        if (outputBytes > prepared.policy.maxOutputBytes) {
          throw new ModelBudgetExceededError();
        }
        if (chunk.usage) {
          usage = chunk.usage;
          assertUsageWithinPolicy(usage, prepared.policy);
        }
        yield chunk;
      }
      if (!usage) {
        throw new InvalidModelValueError(
          'stream completed without final usage',
        );
      }
      completed = true;
      await this.#record(prepared, 'completed', outputBytes, usage, null);
    } catch (error) {
      failureRecorded = true;
      const normalizedError =
        abort.signal.aborted &&
        !(error instanceof ModelAuditUnavailableError) &&
        !(error instanceof ModelBudgetExceededError)
          ? abort.error()
          : error;
      if (
        prepared &&
        admitted &&
        !(normalizedError instanceof ModelAuditUnavailableError)
      ) {
        await this.#record(
          prepared,
          'failed',
          outputBytes,
          usage,
          errorCode(normalizedError),
        );
      }
      throw normalizedError;
    } finally {
      try {
        if (!completed && !failureRecorded && prepared && admitted) {
          await this.#record(
            prepared,
            'failed',
            outputBytes,
            usage,
            'MODEL_STREAM_CANCELLED',
          );
        }
      } finally {
        if (!completed) abort.cancel();
        if (!completed && iterator?.return) {
          try {
            void Promise.resolve(iterator.return()).catch(() => undefined);
          } catch {
            // Cleanup cannot regain invocation authority or retain the slot.
          }
        }
        abort.dispose();
        this.#active -= 1;
      }
    }
  }
}
