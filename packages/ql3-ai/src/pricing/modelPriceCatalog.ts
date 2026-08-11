import { Buffer } from 'node:buffer';
// Catalog facts are immutable pricing-domain contracts shared by both storage dialects.
import { createHash } from 'node:crypto';

import {
  MODEL_PRICE_CURRENCY,
  createModelPriceCatalogEntry,
  normalizeModelPriceCatalogEntry,
  type ModelPriceCatalogEntry,
  type ModelPriceCatalogLookup,
  type ModelPriceCatalogResolver,
} from './pricing';

export const MODEL_PRICE_CATALOG_PUBLISH_COMMAND_SCHEMA =
  'qinglong/model-price-catalog-publish-command@v1' as const;
export const MODEL_PRICE_CATALOG_PUBLICATION_SCHEMA =
  'qinglong/model-price-catalog-publication@v1' as const;
export const MODEL_PRICE_CATALOG_TRANSITION_COMMAND_SCHEMA =
  'qinglong/model-price-catalog-transition-command@v1' as const;
export const MODEL_PRICE_CATALOG_HEAD_SCHEMA =
  'qinglong/model-price-catalog-head@v1' as const;
export const MODEL_PRICE_CATALOG_ACTIONS = [
  'activate',
  'deactivate',
  'revoke',
] as const;
export const MAX_MODEL_PRICE_CATALOG_GENERATION = 2_147_483_647;

export type ModelPriceCatalogAction =
  (typeof MODEL_PRICE_CATALOG_ACTIONS)[number];

export interface ModelPriceCatalogPublishCommand {
  readonly schema: typeof MODEL_PRICE_CATALOG_PUBLISH_COMMAND_SCHEMA;
  readonly provider: string;
  readonly model: string;
  readonly priceRevision: string;
  readonly currency: typeof MODEL_PRICE_CURRENCY;
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
  readonly mutationId: string;
  readonly publishedByUserId: string;
  readonly commandDigest: string;
}

export interface ModelPriceCatalogPublication {
  readonly schema: typeof MODEL_PRICE_CATALOG_PUBLICATION_SCHEMA;
  readonly entry: Readonly<ModelPriceCatalogEntry>;
  readonly mutationId: string;
  readonly publishedByUserId: string;
  readonly commandDigest: string;
  readonly publicationDigest: string;
}

export interface ModelPriceCatalogTransitionCommand {
  readonly schema: typeof MODEL_PRICE_CATALOG_TRANSITION_COMMAND_SCHEMA;
  readonly provider: string;
  readonly model: string;
  readonly expectedGeneration: number;
  readonly expectedHeadDigest: string | null;
  readonly action: ModelPriceCatalogAction;
  readonly priceRevision: string | null;
  readonly mutationId: string;
  readonly changedByUserId: string;
  readonly commandDigest: string;
}

export interface ModelPriceCatalogHead {
  readonly schema: typeof MODEL_PRICE_CATALOG_HEAD_SCHEMA;
  readonly provider: string;
  readonly model: string;
  readonly generation: number;
  readonly previousHeadDigest: string | null;
  readonly activePriceRevision: string | null;
  readonly activeCatalogDigest: string | null;
  readonly revokedPriceRevision: string | null;
  readonly revokedCatalogDigest: string | null;
  readonly action: ModelPriceCatalogAction;
  readonly mutationId: string;
  readonly changedByUserId: string;
  readonly changedAtMs: number;
  readonly commandDigest: string;
  readonly headDigest: string;
}

export interface CommitModelPriceCatalogPublicationResult {
  readonly status: 'created' | 'existing';
  readonly publication: Readonly<ModelPriceCatalogPublication>;
}

export interface CommitModelPriceCatalogHeadResult {
  readonly status: 'created' | 'existing';
  readonly head: Readonly<ModelPriceCatalogHead>;
}

export interface ModelPriceCatalogReader extends ModelPriceCatalogResolver {
  findPublication(
    lookup: Omit<ModelPriceCatalogLookup, 'signal'>,
  ): Promise<Readonly<ModelPriceCatalogPublication> | null>;
  findCurrent(
    provider: string,
    model: string,
  ): Promise<Readonly<ModelPriceCatalogHead> | null>;
}

export interface ModelPriceCatalogAdministrationRepository
  extends ModelPriceCatalogReader {
  publish(
    command: Readonly<ModelPriceCatalogPublishCommand>,
  ): Promise<Readonly<CommitModelPriceCatalogPublicationResult>>;
  transition(
    command: Readonly<ModelPriceCatalogTransitionCommand>,
  ): Promise<Readonly<CommitModelPriceCatalogHeadResult>>;
}

export class InvalidModelPriceCatalogError extends TypeError {
  readonly code = 'MODEL_PRICE_CATALOG_INVALID';

  constructor(message: string) {
    super(`Model price catalog is invalid: ${message}`);
    this.name = 'InvalidModelPriceCatalogError';
  }
}

export class ModelPriceCatalogConflictError extends Error {
  readonly code = 'MODEL_PRICE_CATALOG_CONFLICT';

  constructor() {
    super('Model price catalog conflicts with durable state');
    this.name = 'ModelPriceCatalogConflictError';
  }
}

export class ModelPriceCatalogUnavailableError extends Error {
  readonly code = 'MODEL_PRICE_CATALOG_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Model price catalog is unavailable', options);
    this.name = 'ModelPriceCatalogUnavailableError';
  }
}

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PUBLISH_COMMAND_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-price-catalog-publish-command-digest@v1\0',
  'utf8',
);
const PUBLICATION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-price-catalog-publication-digest@v1\0',
  'utf8',
);
const TRANSITION_COMMAND_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-price-catalog-transition-command-digest@v1\0',
  'utf8',
);
const HEAD_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-price-catalog-head-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidModelPriceCatalogError(message);
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

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function nullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : digest(value, label);
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

function action(value: unknown): ModelPriceCatalogAction {
  if (value !== 'activate' && value !== 'deactivate' && value !== 'revoke') {
    return invalid('action is invalid');
  }
  return value;
}

function hash(domain: Buffer, value: object): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

export function createModelPriceCatalogPublishCommand(
  value: Omit<ModelPriceCatalogPublishCommand, 'schema' | 'commandDigest'>,
): Readonly<ModelPriceCatalogPublishCommand> {
  const candidate = record(value, 'publish command');
  exactKeys(
    candidate,
    [
      'currency',
      'inputMicrosPerMillionTokens',
      'model',
      'mutationId',
      'outputMicrosPerMillionTokens',
      'priceRevision',
      'provider',
      'publishedByUserId',
    ],
    'publish command',
  );
  const semanticEntry = createModelPriceCatalogEntry({
    provider: value.provider,
    model: value.model,
    priceRevision: value.priceRevision,
    currency: value.currency,
    inputMicrosPerMillionTokens: value.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens: value.outputMicrosPerMillionTokens,
    publishedAtMs: 0,
  });
  const unsigned = Object.freeze({
    schema: MODEL_PRICE_CATALOG_PUBLISH_COMMAND_SCHEMA,
    provider: semanticEntry.provider,
    model: semanticEntry.model,
    priceRevision: semanticEntry.priceRevision,
    currency: semanticEntry.currency,
    inputMicrosPerMillionTokens: semanticEntry.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens: semanticEntry.outputMicrosPerMillionTokens,
    mutationId: identity(value.mutationId, 'mutation id'),
    publishedByUserId: identity(value.publishedByUserId, 'publisher user id'),
  });
  return Object.freeze({
    ...unsigned,
    commandDigest: hash(PUBLISH_COMMAND_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeModelPriceCatalogPublishCommand(
  value: ModelPriceCatalogPublishCommand,
): Readonly<ModelPriceCatalogPublishCommand> {
  const candidate = record(value, 'publish command');
  exactKeys(
    candidate,
    [
      'commandDigest',
      'currency',
      'inputMicrosPerMillionTokens',
      'model',
      'mutationId',
      'outputMicrosPerMillionTokens',
      'priceRevision',
      'provider',
      'publishedByUserId',
      'schema',
    ],
    'publish command',
  );
  if (value.schema !== MODEL_PRICE_CATALOG_PUBLISH_COMMAND_SCHEMA) {
    invalid('publish command schema is invalid');
  }
  const normalized = createModelPriceCatalogPublishCommand({
    provider: value.provider,
    model: value.model,
    priceRevision: value.priceRevision,
    currency: value.currency,
    inputMicrosPerMillionTokens: value.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens: value.outputMicrosPerMillionTokens,
    mutationId: value.mutationId,
    publishedByUserId: value.publishedByUserId,
  });
  if (
    digest(value.commandDigest, 'publish command digest') !==
    normalized.commandDigest
  ) {
    invalid('publish command digest is inconsistent');
  }
  return normalized;
}

export function createModelPriceCatalogPublication(
  commandValue: ModelPriceCatalogPublishCommand,
  publishedAtMsValue: number,
): Readonly<ModelPriceCatalogPublication> {
  const command = normalizeModelPriceCatalogPublishCommand(commandValue);
  const entry = createModelPriceCatalogEntry({
    provider: command.provider,
    model: command.model,
    priceRevision: command.priceRevision,
    currency: command.currency,
    inputMicrosPerMillionTokens: command.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens: command.outputMicrosPerMillionTokens,
    publishedAtMs: integer(publishedAtMsValue, 'publish time', 0),
  });
  const unsigned = Object.freeze({
    schema: MODEL_PRICE_CATALOG_PUBLICATION_SCHEMA,
    entry,
    mutationId: command.mutationId,
    publishedByUserId: command.publishedByUserId,
    commandDigest: command.commandDigest,
  });
  return Object.freeze({
    ...unsigned,
    publicationDigest: hash(PUBLICATION_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeModelPriceCatalogPublication(
  value: ModelPriceCatalogPublication,
): Readonly<ModelPriceCatalogPublication> {
  const candidate = record(value, 'publication');
  exactKeys(
    candidate,
    [
      'commandDigest',
      'entry',
      'mutationId',
      'publicationDigest',
      'publishedByUserId',
      'schema',
    ],
    'publication',
  );
  if (value.schema !== MODEL_PRICE_CATALOG_PUBLICATION_SCHEMA) {
    invalid('publication schema is invalid');
  }
  const entry = normalizeModelPriceCatalogEntry(value.entry);
  const command = createModelPriceCatalogPublishCommand({
    provider: entry.provider,
    model: entry.model,
    priceRevision: entry.priceRevision,
    currency: entry.currency,
    inputMicrosPerMillionTokens: entry.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens: entry.outputMicrosPerMillionTokens,
    mutationId: value.mutationId,
    publishedByUserId: value.publishedByUserId,
  });
  if (
    digest(value.commandDigest, 'publish command digest') !==
    command.commandDigest
  ) {
    invalid('publication command is inconsistent');
  }
  const normalized = createModelPriceCatalogPublication(
    command,
    entry.publishedAtMs,
  );
  if (
    digest(value.publicationDigest, 'publication digest') !==
    normalized.publicationDigest
  ) {
    invalid('publication digest is inconsistent');
  }
  return normalized;
}

export function createModelPriceCatalogTransitionCommand(
  value: Omit<ModelPriceCatalogTransitionCommand, 'schema' | 'commandDigest'>,
): Readonly<ModelPriceCatalogTransitionCommand> {
  const candidate = record(value, 'transition command');
  exactKeys(
    candidate,
    [
      'action',
      'changedByUserId',
      'expectedGeneration',
      'expectedHeadDigest',
      'model',
      'mutationId',
      'priceRevision',
      'provider',
    ],
    'transition command',
  );
  const normalizedAction = action(value.action);
  const expectedGeneration = integer(
    value.expectedGeneration,
    'expected generation',
    0,
    MAX_MODEL_PRICE_CATALOG_GENERATION - 1,
  );
  const expectedHeadDigest = nullableDigest(
    value.expectedHeadDigest,
    'expected head digest',
  );
  if ((expectedGeneration === 0) !== (expectedHeadDigest === null)) {
    invalid('expected head fence is invalid');
  }
  const priceRevision =
    value.priceRevision === null
      ? null
      : identity(value.priceRevision, 'price revision');
  if ((normalizedAction === 'deactivate') !== (priceRevision === null)) {
    invalid('transition price revision is invalid');
  }
  const unsigned = Object.freeze({
    schema: MODEL_PRICE_CATALOG_TRANSITION_COMMAND_SCHEMA,
    provider: identity(value.provider, 'provider'),
    model: identity(value.model, 'model'),
    expectedGeneration,
    expectedHeadDigest,
    action: normalizedAction,
    priceRevision,
    mutationId: identity(value.mutationId, 'mutation id'),
    changedByUserId: identity(value.changedByUserId, 'actor user id'),
  });
  return Object.freeze({
    ...unsigned,
    commandDigest: hash(TRANSITION_COMMAND_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeModelPriceCatalogTransitionCommand(
  value: ModelPriceCatalogTransitionCommand,
): Readonly<ModelPriceCatalogTransitionCommand> {
  const candidate = record(value, 'transition command');
  exactKeys(
    candidate,
    [
      'action',
      'changedByUserId',
      'commandDigest',
      'expectedGeneration',
      'expectedHeadDigest',
      'model',
      'mutationId',
      'priceRevision',
      'provider',
      'schema',
    ],
    'transition command',
  );
  if (value.schema !== MODEL_PRICE_CATALOG_TRANSITION_COMMAND_SCHEMA) {
    invalid('transition command schema is invalid');
  }
  const normalized = createModelPriceCatalogTransitionCommand({
    provider: value.provider,
    model: value.model,
    expectedGeneration: value.expectedGeneration,
    expectedHeadDigest: value.expectedHeadDigest,
    action: value.action,
    priceRevision: value.priceRevision,
    mutationId: value.mutationId,
    changedByUserId: value.changedByUserId,
  });
  if (
    digest(value.commandDigest, 'transition command digest') !==
    normalized.commandDigest
  ) {
    invalid('transition command digest is inconsistent');
  }
  return normalized;
}

export function createModelPriceCatalogHead(
  previousValue: ModelPriceCatalogHead | null,
  commandValue: ModelPriceCatalogTransitionCommand,
  targetValue: ModelPriceCatalogPublication | null,
  targetRevoked: boolean,
  changedAtMsValue: number,
): Readonly<ModelPriceCatalogHead> {
  const previous =
    previousValue === null
      ? null
      : normalizeModelPriceCatalogHead(previousValue);
  const command = normalizeModelPriceCatalogTransitionCommand(commandValue);
  const target =
    targetValue === null
      ? null
      : normalizeModelPriceCatalogPublication(targetValue);
  if (
    (previous?.generation ?? 0) !== command.expectedGeneration ||
    (previous?.headDigest ?? null) !== command.expectedHeadDigest ||
    (previous !== null &&
      (previous.provider !== command.provider ||
        previous.model !== command.model))
  ) {
    invalid('transition fence is inconsistent');
  }
  if (
    command.action === 'deactivate'
      ? target !== null
      : !target ||
        target.entry.provider !== command.provider ||
        target.entry.model !== command.model ||
        target.entry.priceRevision !== command.priceRevision
  ) {
    invalid('transition target is inconsistent');
  }
  if (targetRevoked) invalid('transition target is revoked');

  let activePriceRevision = previous?.activePriceRevision ?? null;
  let activeCatalogDigest = previous?.activeCatalogDigest ?? null;
  let revokedPriceRevision: string | null = null;
  let revokedCatalogDigest: string | null = null;
  if (command.action === 'activate') {
    if (
      activePriceRevision === target!.entry.priceRevision &&
      activeCatalogDigest === target!.entry.catalogDigest
    ) {
      invalid('transition does not change catalog state');
    }
    activePriceRevision = target!.entry.priceRevision;
    activeCatalogDigest = target!.entry.catalogDigest;
  } else if (command.action === 'deactivate') {
    if (activePriceRevision === null) {
      invalid('transition does not change catalog state');
    }
    activePriceRevision = null;
    activeCatalogDigest = null;
  } else {
    revokedPriceRevision = target!.entry.priceRevision;
    revokedCatalogDigest = target!.entry.catalogDigest;
    if (activePriceRevision === revokedPriceRevision) {
      activePriceRevision = null;
      activeCatalogDigest = null;
    }
  }
  const unsigned = Object.freeze({
    schema: MODEL_PRICE_CATALOG_HEAD_SCHEMA,
    provider: command.provider,
    model: command.model,
    generation: command.expectedGeneration + 1,
    previousHeadDigest: command.expectedHeadDigest,
    activePriceRevision,
    activeCatalogDigest,
    revokedPriceRevision,
    revokedCatalogDigest,
    action: command.action,
    mutationId: command.mutationId,
    changedByUserId: command.changedByUserId,
    changedAtMs: integer(changedAtMsValue, 'change time', 0),
    commandDigest: command.commandDigest,
  });
  return Object.freeze({
    ...unsigned,
    headDigest: hash(HEAD_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeModelPriceCatalogHead(
  value: ModelPriceCatalogHead,
): Readonly<ModelPriceCatalogHead> {
  const candidate = record(value, 'catalog head');
  exactKeys(
    candidate,
    [
      'action',
      'activeCatalogDigest',
      'activePriceRevision',
      'changedAtMs',
      'changedByUserId',
      'commandDigest',
      'generation',
      'headDigest',
      'model',
      'mutationId',
      'previousHeadDigest',
      'provider',
      'revokedCatalogDigest',
      'revokedPriceRevision',
      'schema',
    ],
    'catalog head',
  );
  if (value.schema !== MODEL_PRICE_CATALOG_HEAD_SCHEMA) {
    invalid('catalog head schema is invalid');
  }
  const generation = integer(
    value.generation,
    'generation',
    1,
    MAX_MODEL_PRICE_CATALOG_GENERATION,
  );
  const previousHeadDigest = nullableDigest(
    value.previousHeadDigest,
    'previous head digest',
  );
  if ((generation === 1) !== (previousHeadDigest === null)) {
    invalid('catalog head generation fence is invalid');
  }
  const activePriceRevision =
    value.activePriceRevision === null
      ? null
      : identity(value.activePriceRevision, 'active price revision');
  const activeCatalogDigest = nullableDigest(
    value.activeCatalogDigest,
    'active catalog digest',
  );
  const revokedPriceRevision =
    value.revokedPriceRevision === null
      ? null
      : identity(value.revokedPriceRevision, 'revoked price revision');
  const revokedCatalogDigest = nullableDigest(
    value.revokedCatalogDigest,
    'revoked catalog digest',
  );
  if (
    (activePriceRevision === null) !== (activeCatalogDigest === null) ||
    (revokedPriceRevision === null) !== (revokedCatalogDigest === null) ||
    (revokedPriceRevision !== null &&
      revokedPriceRevision === activePriceRevision)
  ) {
    invalid('catalog head projection is invalid');
  }
  const normalizedAction = action(value.action);
  if ((normalizedAction === 'revoke') !== (revokedPriceRevision !== null)) {
    invalid('catalog head revocation projection is invalid');
  }
  if (
    (normalizedAction === 'activate' && activePriceRevision === null) ||
    (normalizedAction === 'deactivate' && activePriceRevision !== null)
  ) {
    invalid('catalog head action projection is invalid');
  }
  const unsigned = Object.freeze({
    schema: MODEL_PRICE_CATALOG_HEAD_SCHEMA,
    provider: identity(value.provider, 'provider'),
    model: identity(value.model, 'model'),
    generation,
    previousHeadDigest,
    activePriceRevision,
    activeCatalogDigest,
    revokedPriceRevision,
    revokedCatalogDigest,
    action: normalizedAction,
    mutationId: identity(value.mutationId, 'mutation id'),
    changedByUserId: identity(value.changedByUserId, 'actor user id'),
    changedAtMs: integer(value.changedAtMs, 'change time', 0),
    commandDigest: digest(value.commandDigest, 'transition command digest'),
  });
  const headDigest = digest(value.headDigest, 'head digest');
  if (headDigest !== hash(HEAD_DIGEST_DOMAIN, unsigned)) {
    invalid('catalog head digest is inconsistent');
  }
  return Object.freeze({ ...unsigned, headDigest });
}
