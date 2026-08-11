export const MODEL_MESSAGE_ROLES = ['system', 'user', 'assistant'] as const;
export const MODEL_FINISH_REASONS = [
  'stop',
  'length',
  'content_filter',
  'tool_call',
  'unknown',
] as const;

export const MAX_MODEL_PROVIDERS = 8;
export const MAX_MODEL_MESSAGES = 64;
export const MAX_MODEL_MESSAGE_BYTES = 64 * 1024;
export const MAX_MODEL_INPUT_BYTES = 256 * 1024;
export const MAX_MODEL_OUTPUT_BYTES = 1024 * 1024;
export const MAX_MODEL_OUTPUT_TOKENS = 32_768;
export const MAX_MODEL_INVOCATION_MS = 5 * 60_000;

export type ModelMessageRole = (typeof MODEL_MESSAGE_ROLES)[number];
export type ModelFinishReason = (typeof MODEL_FINISH_REASONS)[number];

export interface ModelMessage {
  readonly role: ModelMessageRole;
  readonly content: string;
}

export interface GenerateRequest {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens: number;
  readonly temperature?: number;
}

export interface ModelInvocationContext {
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly traceId: string;
  readonly requestId: string;
  readonly deadlineAtMs: number;
  readonly signal?: AbortSignal;
}

export interface ModelInfo {
  readonly id: string;
  readonly displayName?: string;
  readonly contextWindowTokens?: number;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costMicros?: number;
}

export interface GenerateResult {
  readonly provider: string;
  readonly model: string;
  readonly text: string;
  readonly finishReason: ModelFinishReason;
  readonly usage: ModelUsage;
}

export interface ModelChunk {
  readonly delta: string;
  readonly finishReason?: ModelFinishReason;
  readonly usage?: ModelUsage;
}

export interface ModelProvider {
  readonly type: string;
  listModels(
    context?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<readonly ModelInfo[]>;
  generate(
    request: Readonly<GenerateRequest>,
    context: Readonly<ModelInvocationContext>,
  ): Promise<Readonly<GenerateResult>>;
  stream(
    request: Readonly<GenerateRequest>,
    context: Readonly<ModelInvocationContext>,
  ): AsyncIterable<Readonly<ModelChunk>>;
}

export interface ModelInvocationPolicy {
  readonly revision: string;
  readonly allowedProviders: readonly string[];
  readonly allowedModels: readonly string[];
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxOutputTokens: number;
  readonly maxTotalTokens: number;
  readonly maxCostMicros: number | null;
  readonly priceRevision: string | null;
  readonly projectQuota?: import('../usage/usageQuota').ModelInvocationProjectQuotaPolicy;
}

export interface ModelInvocationPolicyProvider {
  resolve(
    context: Readonly<ModelInvocationContext>,
  ): Promise<Readonly<ModelInvocationPolicy>>;
}

export const MODEL_INVOCATION_AUDIT_PHASES = [
  'admitted',
  'completed',
  'failed',
] as const;

export type ModelInvocationAuditPhase =
  (typeof MODEL_INVOCATION_AUDIT_PHASES)[number];

export interface ModelInvocationAuditRecord {
  readonly phase: ModelInvocationAuditPhase;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly traceId: string;
  readonly requestId: string;
  readonly provider: string;
  readonly model: string;
  readonly policyRevision: string;
  readonly requestDigest: string;
  readonly deadlineAtMs: number;
  readonly inputBytes: number;
  readonly maxOutputTokens: number;
  readonly outputBytes: number;
  readonly usage: Readonly<ModelUsage> | null;
  readonly errorCode: string | null;
  readonly occurredAtMs: number;
}

export interface ModelInvocationAuditDisposition {
  readonly status: 'created' | 'existing';
}

export type ModelInvocationAuditResult =
  void | Readonly<ModelInvocationAuditDisposition>;

export interface ModelInvocationAuditSink {
  record(
    record: Readonly<ModelInvocationAuditRecord>,
  ): Promise<ModelInvocationAuditResult>;
  recordWithQuota?(
    record: Readonly<ModelInvocationAuditRecord>,
    admission: Readonly<
      import('../usage/usageQuota').ModelInvocationQuotaAdmission
    >,
  ): Promise<ModelInvocationAuditResult>;
  recordWithPricing?(
    record: Readonly<ModelInvocationAuditRecord>,
    quote: Readonly<import('../pricing/pricing').ModelInvocationPriceQuote>,
    quotaAdmission?: Readonly<
      import('../usage/usageQuota').ModelInvocationQuotaAdmission
    >,
  ): Promise<ModelInvocationAuditResult>;
}
