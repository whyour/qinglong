import { Buffer } from 'node:buffer';
// Pricing owns immutable quotes and settlements; metering and quota remain sibling domains.
import { createHash } from 'node:crypto';

import type {
  CommitModelInvocationResult,
  ModelInvocationCompletionCommand,
  ModelInvocationCompletionRecord,
  ModelInvocationRepository,
  ModelInvocationStartCommand,
  ModelInvocationStartRecord,
} from '../model-invocation/modelInvocation';
import { normalizeModelInvocationCompletionRecord } from '../model-invocation/modelInvocation';
import type { ModelUsage } from '../model-gateway/model';
import { normalizeModelUsage } from '../model-gateway/validation';
import type { ModelInvocationQuotaAdmission } from '../usage/usageQuota';

export const MODEL_PRICE_CATALOG_ENTRY_SCHEMA =
  'qinglong/model-price-catalog-entry@v1' as const;
export const MODEL_INVOCATION_PRICE_QUOTE_SCHEMA =
  'qinglong/model-invocation-price-quote@v1' as const;
export const MODEL_INVOCATION_PRICE_SETTLEMENT_SCHEMA =
  'qinglong/model-invocation-price-settlement@v1' as const;
export const MODEL_PRICE_CURRENCY = 'USD' as const;
export const MODEL_PRICE_RATE_UNIT_TOKENS = 1_000_000;
export const MAX_MODEL_PRICE_CATALOG_ENTRIES = 256;
export const MAX_MODEL_PRICE_RATE_MICROS = 1_000_000_000_000;
export const MAX_MODEL_PRICE_COST_MICROS = 1_000_000_000_000_000;

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CATALOG_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-price-catalog-entry-digest@v1\0',
  'utf8',
);
const QUOTE_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-invocation-price-quote-digest@v1\0',
  'utf8',
);
const SETTLEMENT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-invocation-price-settlement-digest@v1\0',
  'utf8',
);

export interface ModelPriceCatalogEntry {
  readonly schema: typeof MODEL_PRICE_CATALOG_ENTRY_SCHEMA;
  readonly provider: string;
  readonly model: string;
  readonly priceRevision: string;
  readonly currency: typeof MODEL_PRICE_CURRENCY;
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
  readonly publishedAtMs: number;
  readonly catalogDigest: string;
}

export interface ModelPriceCatalogLookup {
  readonly provider: string;
  readonly model: string;
  readonly priceRevision: string;
  readonly signal?: AbortSignal;
}

export interface ModelPriceCatalogResolver {
  resolve(
    lookup: Readonly<ModelPriceCatalogLookup>,
  ): Promise<Readonly<ModelPriceCatalogEntry> | null>;
}

export interface ModelInvocationPriceQuote {
  readonly schema: typeof MODEL_INVOCATION_PRICE_QUOTE_SCHEMA;
  readonly invocationId: string;
  readonly projectId: string;
  readonly modelPolicyRevision: string;
  readonly provider: string;
  readonly model: string;
  readonly priceRevision: string;
  readonly currency: typeof MODEL_PRICE_CURRENCY;
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
  readonly maxTotalTokens: number;
  readonly maxOutputTokens: number;
  readonly reservedCostMicros: number;
  readonly catalogDigest: string;
  readonly quoteDigest: string;
}

export interface ModelInvocationPriceSettlement {
  readonly schema: typeof MODEL_INVOCATION_PRICE_SETTLEMENT_SCHEMA;
  readonly invocationId: string;
  readonly projectId: string;
  readonly quoteDigest: string;
  readonly completionDigest: string;
  readonly currency: typeof MODEL_PRICE_CURRENCY;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly settledAtMs: number;
  readonly settlementDigest: string;
}

export interface ModelInvocationPricingRepository {
  findPriceQuote(
    invocationId: string,
  ): Promise<Readonly<ModelInvocationPriceQuote> | null>;
  findPriceSettlement(
    invocationId: string,
  ): Promise<Readonly<ModelInvocationPriceSettlement> | null>;
}

export interface PricingAwareModelInvocationRepository
  extends ModelInvocationRepository,
    ModelInvocationPricingRepository {
  admitWithPricing(
    command: ModelInvocationStartCommand,
    quote: ModelInvocationPriceQuote,
    quotaAdmission?: ModelInvocationQuotaAdmission,
  ): Promise<Readonly<CommitModelInvocationResult<ModelInvocationStartRecord>>>;
  completeWithPricing(
    command: ModelInvocationCompletionCommand,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationCompletionRecord>>
  >;
}

export class InvalidModelPricingError extends TypeError {
  readonly code = 'MODEL_PRICING_INVALID';

  constructor(message: string) {
    super(`Model pricing is invalid: ${message}`);
    this.name = 'InvalidModelPricingError';
  }
}

export class ModelPriceUnavailableError extends Error {
  readonly code = 'MODEL_PRICE_UNAVAILABLE';

  constructor() {
    super('The exact model price revision is unavailable');
    this.name = 'ModelPriceUnavailableError';
  }
}

export class ModelPricingConfigurationError extends Error {
  readonly code = 'MODEL_PRICING_CONFIGURATION_INVALID';

  constructor() {
    super('The model pricing authority is not durably configured');
    this.name = 'ModelPricingConfigurationError';
  }
}

function invalid(message: string): never {
  throw new InvalidModelPricingError(message);
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

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function hash(domain: Buffer, value: object): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function rateCost(tokens: number, rateMicros: number): number {
  const numerator = BigInt(tokens) * BigInt(rateMicros);
  const unit = BigInt(MODEL_PRICE_RATE_UNIT_TOKENS);
  const rounded = (numerator + unit - 1n) / unit;
  if (rounded > BigInt(MAX_MODEL_PRICE_COST_MICROS)) {
    return invalid('calculated cost exceeds its reviewed limit');
  }
  return Number(rounded);
}

function totalCost(
  inputTokens: number,
  outputTokens: number,
  inputRate: number,
  outputRate: number,
): number {
  const cost =
    rateCost(inputTokens, inputRate) + rateCost(outputTokens, outputRate);
  return integer(cost, 'calculated cost', 0, MAX_MODEL_PRICE_COST_MICROS);
}

function catalogKey(
  value: Pick<ModelPriceCatalogEntry, 'provider' | 'model' | 'priceRevision'>,
): string {
  return JSON.stringify([value.provider, value.model, value.priceRevision]);
}

export function createModelPriceCatalogEntry(
  value: Omit<ModelPriceCatalogEntry, 'schema' | 'catalogDigest'>,
): Readonly<ModelPriceCatalogEntry> {
  const candidate = plainObject(value, 'catalog entry');
  exactKeys(
    candidate,
    [
      'currency',
      'inputMicrosPerMillionTokens',
      'model',
      'outputMicrosPerMillionTokens',
      'priceRevision',
      'provider',
      'publishedAtMs',
    ],
    'catalog entry',
  );
  if (value.currency !== MODEL_PRICE_CURRENCY) {
    invalid('catalog currency is unsupported');
  }
  const unsigned = Object.freeze({
    schema: MODEL_PRICE_CATALOG_ENTRY_SCHEMA,
    provider: identifier(value.provider, 'provider'),
    model: identifier(value.model, 'model'),
    priceRevision: identifier(value.priceRevision, 'price revision'),
    currency: MODEL_PRICE_CURRENCY,
    inputMicrosPerMillionTokens: integer(
      value.inputMicrosPerMillionTokens,
      'input price',
      0,
      MAX_MODEL_PRICE_RATE_MICROS,
    ),
    outputMicrosPerMillionTokens: integer(
      value.outputMicrosPerMillionTokens,
      'output price',
      0,
      MAX_MODEL_PRICE_RATE_MICROS,
    ),
    publishedAtMs: integer(value.publishedAtMs, 'publish time', 0),
  });
  return Object.freeze({
    ...unsigned,
    catalogDigest: hash(CATALOG_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeModelPriceCatalogEntry(
  value: ModelPriceCatalogEntry,
): Readonly<ModelPriceCatalogEntry> {
  const candidate = plainObject(value, 'catalog entry');
  exactKeys(
    candidate,
    [
      'catalogDigest',
      'currency',
      'inputMicrosPerMillionTokens',
      'model',
      'outputMicrosPerMillionTokens',
      'priceRevision',
      'provider',
      'publishedAtMs',
      'schema',
    ],
    'catalog entry',
  );
  if (value.schema !== MODEL_PRICE_CATALOG_ENTRY_SCHEMA) {
    invalid('catalog schema is invalid');
  }
  const normalized = createModelPriceCatalogEntry({
    provider: value.provider,
    model: value.model,
    priceRevision: value.priceRevision,
    currency: value.currency,
    inputMicrosPerMillionTokens: value.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens: value.outputMicrosPerMillionTokens,
    publishedAtMs: value.publishedAtMs,
  });
  if (
    digest(value.catalogDigest, 'catalog digest') !== normalized.catalogDigest
  ) {
    invalid('catalog digest is inconsistent');
  }
  return normalized;
}

export class StaticModelPriceCatalog implements ModelPriceCatalogResolver {
  readonly #entries: ReadonlyMap<string, Readonly<ModelPriceCatalogEntry>>;

  constructor(entries: readonly ModelPriceCatalogEntry[]) {
    if (
      !Array.isArray(entries) ||
      entries.length < 1 ||
      entries.length > MAX_MODEL_PRICE_CATALOG_ENTRIES
    ) {
      invalid('catalog size is invalid');
    }
    const indexed = new Map<string, Readonly<ModelPriceCatalogEntry>>();
    for (const value of entries) {
      const entry = normalizeModelPriceCatalogEntry(value);
      const key = catalogKey(entry);
      if (indexed.has(key)) invalid('catalog identity is duplicated');
      indexed.set(key, entry);
    }
    this.#entries = indexed;
  }

  async resolve(
    lookupValue: Readonly<ModelPriceCatalogLookup>,
  ): Promise<Readonly<ModelPriceCatalogEntry> | null> {
    const lookup = plainObject(lookupValue, 'catalog lookup');
    exactKeys(
      lookup,
      lookupValue.signal === undefined
        ? ['model', 'priceRevision', 'provider']
        : ['model', 'priceRevision', 'provider', 'signal'],
      'catalog lookup',
    );
    if (
      lookupValue.signal !== undefined &&
      !(lookupValue.signal instanceof AbortSignal)
    ) {
      invalid('catalog signal is invalid');
    }
    if (lookupValue.signal?.aborted) {
      throw lookupValue.signal.reason;
    }
    return (
      this.#entries.get(
        catalogKey({
          provider: identifier(lookupValue.provider, 'provider'),
          model: identifier(lookupValue.model, 'model'),
          priceRevision: identifier(
            lookupValue.priceRevision,
            'price revision',
          ),
        }),
      ) ?? null
    );
  }
}

export function createModelInvocationPriceQuote(
  entryValue: ModelPriceCatalogEntry,
  options: Readonly<{
    invocationId: string;
    projectId: string;
    modelPolicyRevision: string;
    maxTotalTokens: number;
    maxOutputTokens: number;
  }>,
): Readonly<ModelInvocationPriceQuote> {
  const entry = normalizeModelPriceCatalogEntry(entryValue);
  const maxTotalTokens = integer(
    options.maxTotalTokens,
    'maximum total tokens',
    1,
    1_000_000_000_000,
  );
  const maxOutputTokens = integer(
    options.maxOutputTokens,
    'maximum output tokens',
    1,
    maxTotalTokens,
  );
  const expensiveOutput =
    entry.outputMicrosPerMillionTokens > entry.inputMicrosPerMillionTokens;
  const reservedOutputTokens = expensiveOutput ? maxOutputTokens : 0;
  const reservedInputTokens = maxTotalTokens - reservedOutputTokens;
  const unsigned = Object.freeze({
    schema: MODEL_INVOCATION_PRICE_QUOTE_SCHEMA,
    invocationId: identifier(options.invocationId, 'invocation id'),
    projectId: identifier(options.projectId, 'Project id'),
    modelPolicyRevision: identifier(
      options.modelPolicyRevision,
      'model policy revision',
    ),
    provider: entry.provider,
    model: entry.model,
    priceRevision: entry.priceRevision,
    currency: entry.currency,
    inputMicrosPerMillionTokens: entry.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens: entry.outputMicrosPerMillionTokens,
    maxTotalTokens,
    maxOutputTokens,
    reservedCostMicros: totalCost(
      reservedInputTokens,
      reservedOutputTokens,
      entry.inputMicrosPerMillionTokens,
      entry.outputMicrosPerMillionTokens,
    ),
    catalogDigest: entry.catalogDigest,
  });
  return Object.freeze({
    ...unsigned,
    quoteDigest: hash(QUOTE_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeModelInvocationPriceQuote(
  value: ModelInvocationPriceQuote,
): Readonly<ModelInvocationPriceQuote> {
  const candidate = plainObject(value, 'price quote');
  exactKeys(
    candidate,
    [
      'catalogDigest',
      'currency',
      'inputMicrosPerMillionTokens',
      'invocationId',
      'maxOutputTokens',
      'maxTotalTokens',
      'model',
      'modelPolicyRevision',
      'outputMicrosPerMillionTokens',
      'priceRevision',
      'projectId',
      'provider',
      'quoteDigest',
      'reservedCostMicros',
      'schema',
    ],
    'price quote',
  );
  if (
    value.schema !== MODEL_INVOCATION_PRICE_QUOTE_SCHEMA ||
    value.currency !== MODEL_PRICE_CURRENCY
  ) {
    invalid('price quote schema or currency is invalid');
  }
  const maxTotalTokens = integer(
    value.maxTotalTokens,
    'maximum total tokens',
    1,
    1_000_000_000_000,
  );
  const maxOutputTokens = integer(
    value.maxOutputTokens,
    'maximum output tokens',
    1,
    maxTotalTokens,
  );
  const unsigned = Object.freeze({
    schema: MODEL_INVOCATION_PRICE_QUOTE_SCHEMA,
    invocationId: identifier(value.invocationId, 'invocation id'),
    projectId: identifier(value.projectId, 'Project id'),
    modelPolicyRevision: identifier(
      value.modelPolicyRevision,
      'model policy revision',
    ),
    provider: identifier(value.provider, 'provider'),
    model: identifier(value.model, 'model'),
    priceRevision: identifier(value.priceRevision, 'price revision'),
    currency: MODEL_PRICE_CURRENCY,
    inputMicrosPerMillionTokens: integer(
      value.inputMicrosPerMillionTokens,
      'input price',
      0,
      MAX_MODEL_PRICE_RATE_MICROS,
    ),
    outputMicrosPerMillionTokens: integer(
      value.outputMicrosPerMillionTokens,
      'output price',
      0,
      MAX_MODEL_PRICE_RATE_MICROS,
    ),
    maxTotalTokens,
    maxOutputTokens,
    reservedCostMicros: integer(
      value.reservedCostMicros,
      'reserved cost',
      0,
      MAX_MODEL_PRICE_COST_MICROS,
    ),
    catalogDigest: digest(value.catalogDigest, 'catalog digest'),
  });
  const expensiveOutput =
    unsigned.outputMicrosPerMillionTokens >
    unsigned.inputMicrosPerMillionTokens;
  const expectedCost = totalCost(
    unsigned.maxTotalTokens - (expensiveOutput ? unsigned.maxOutputTokens : 0),
    expensiveOutput ? unsigned.maxOutputTokens : 0,
    unsigned.inputMicrosPerMillionTokens,
    unsigned.outputMicrosPerMillionTokens,
  );
  if (
    unsigned.reservedCostMicros !== expectedCost ||
    digest(value.quoteDigest, 'quote digest') !==
      hash(QUOTE_DIGEST_DOMAIN, unsigned)
  ) {
    invalid('price quote cost or digest is inconsistent');
  }
  return Object.freeze({
    ...unsigned,
    quoteDigest: value.quoteDigest,
  });
}

export function createModelInvocationPriceSettlement(
  quoteValue: ModelInvocationPriceQuote,
  completionValue: ModelInvocationCompletionRecord,
): Readonly<ModelInvocationPriceSettlement> | null {
  const quote = normalizeModelInvocationPriceQuote(quoteValue);
  const completion = normalizeModelInvocationCompletionRecord(completionValue);
  if (
    completion.invocationId !== quote.invocationId ||
    completion.projectId !== quote.projectId
  ) {
    invalid('completion is detached from its price quote');
  }
  if (!completion.usage) return null;
  if (
    completion.usage.totalTokens > quote.maxTotalTokens ||
    completion.usage.outputTokens > quote.maxOutputTokens
  ) {
    invalid('completion usage exceeds its price quote');
  }
  const costMicros = calculateModelInvocationPriceCost(quote, completion.usage);
  if (completion.usage.costMicros !== costMicros) {
    invalid('completion cost does not match its price quote');
  }
  const unsigned = Object.freeze({
    schema: MODEL_INVOCATION_PRICE_SETTLEMENT_SCHEMA,
    invocationId: quote.invocationId,
    projectId: quote.projectId,
    quoteDigest: quote.quoteDigest,
    completionDigest: completion.completionDigest,
    currency: quote.currency,
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    costMicros,
    settledAtMs: completion.completedAtMs,
  });
  return Object.freeze({
    ...unsigned,
    settlementDigest: hash(SETTLEMENT_DIGEST_DOMAIN, unsigned),
  });
}

export function calculateModelInvocationPriceCost(
  quoteValue: ModelInvocationPriceQuote,
  usageValue: ModelUsage,
): number {
  const quote = normalizeModelInvocationPriceQuote(quoteValue);
  const usage = normalizeModelUsage(usageValue);
  if (
    usage.totalTokens > quote.maxTotalTokens ||
    usage.outputTokens > quote.maxOutputTokens
  ) {
    invalid('usage exceeds its price quote');
  }
  return totalCost(
    usage.inputTokens,
    usage.outputTokens,
    quote.inputMicrosPerMillionTokens,
    quote.outputMicrosPerMillionTokens,
  );
}

export function priceModelUsage(
  quoteValue: ModelInvocationPriceQuote,
  usageValue: ModelUsage,
): Readonly<ModelUsage> {
  const usage = normalizeModelUsage(usageValue);
  return Object.freeze({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    costMicros: calculateModelInvocationPriceCost(quoteValue, usage),
  });
}

export function normalizeModelInvocationPriceSettlement(
  value: ModelInvocationPriceSettlement,
  quoteValue: ModelInvocationPriceQuote,
  completionValue: ModelInvocationCompletionRecord,
): Readonly<ModelInvocationPriceSettlement> {
  const record = plainObject(value, 'price settlement');
  exactKeys(
    record,
    [
      'completionDigest',
      'costMicros',
      'currency',
      'inputTokens',
      'invocationId',
      'outputTokens',
      'projectId',
      'quoteDigest',
      'schema',
      'settledAtMs',
      'settlementDigest',
    ],
    'price settlement',
  );
  if (value.schema !== MODEL_INVOCATION_PRICE_SETTLEMENT_SCHEMA) {
    invalid('price settlement schema is invalid');
  }
  const expected = createModelInvocationPriceSettlement(
    quoteValue,
    completionValue,
  );
  if (
    !expected ||
    Object.keys(expected).some(
      (key) =>
        record[key] !== expected[key as keyof ModelInvocationPriceSettlement],
    )
  ) {
    invalid('price settlement is inconsistent');
  }
  return expected;
}

export function isPricingAwareModelInvocationRepository(
  value: ModelInvocationRepository,
): value is PricingAwareModelInvocationRepository {
  const candidate = value as Partial<PricingAwareModelInvocationRepository>;
  return (
    typeof candidate.findPriceQuote === 'function' &&
    typeof candidate.findPriceSettlement === 'function' &&
    typeof candidate.admitWithPricing === 'function' &&
    typeof candidate.completeWithPricing === 'function'
  );
}
