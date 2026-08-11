import { Buffer } from 'node:buffer';

import {
  createModelPriceCatalogPublishCommand,
  createModelPriceCatalogTransitionCommand,
  type ModelPriceCatalogPublishCommand,
  type ModelPriceCatalogTransitionCommand,
} from '../modelPriceCatalog';
import {
  MAX_MODEL_PRICE_CATALOG_PRINCIPAL_AGE_MS,
  MODEL_PRICE_CATALOG_AUTHORIZATION_COMMAND_SCHEMA,
  MODEL_PRICE_CATALOG_AUTHORIZATION_SCHEMA,
  MODEL_PRICE_CATALOG_POLICY_DECISION_SCHEMA,
  type ModelPriceCatalogAuthorization,
  type ModelPriceCatalogAuthorizationCommand,
  type ModelPriceCatalogPolicyDecision,
} from './contracts';
import {
  decisionMode,
  digest,
  exactKeys,
  hash,
  identity,
  integer,
  invalid,
  normalizeReasons,
  normalizeStoredPrincipal,
  nullableIdentity,
  operation,
  record,
  requestId,
  validateOperationRevision,
} from './validation';

const POLICY_DECISION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-price-catalog-policy-decision-digest@v1\0',
  'utf8',
);
const AUTHORIZATION_COMMAND_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-price-catalog-authorization-command-digest@v1\0',
  'utf8',
);
const AUTHORIZATION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/model-price-catalog-authorization-digest@v1\0',
  'utf8',
);

export function createModelPriceCatalogPolicyDecision(
  value: Omit<ModelPriceCatalogPolicyDecision, 'schema' | 'decisionDigest'>,
): Readonly<ModelPriceCatalogPolicyDecision> {
  const candidate = record(value, 'policy decision');
  exactKeys(candidate, ['effect', 'revision', 'reasons'], 'policy decision');
  if (value.effect !== 'allow' && value.effect !== 'deny') {
    return invalid('policy effect is invalid');
  }
  const semantic = Object.freeze({
    schema: MODEL_PRICE_CATALOG_POLICY_DECISION_SCHEMA,
    effect: value.effect,
    revision: identity(value.revision, 'policy revision'),
    reasons: normalizeReasons(value.reasons),
  });
  return Object.freeze({
    ...semantic,
    decisionDigest: hash(POLICY_DECISION_DIGEST_DOMAIN, semantic),
  });
}

export function normalizeModelPriceCatalogPolicyDecision(
  value: ModelPriceCatalogPolicyDecision,
): Readonly<ModelPriceCatalogPolicyDecision> {
  const candidate = record(value, 'policy decision');
  exactKeys(
    candidate,
    ['schema', 'effect', 'revision', 'reasons', 'decisionDigest'],
    'policy decision',
  );
  if (value.schema !== MODEL_PRICE_CATALOG_POLICY_DECISION_SCHEMA) {
    return invalid('policy decision schema is invalid');
  }
  const normalized = createModelPriceCatalogPolicyDecision({
    effect: value.effect,
    revision: value.revision,
    reasons: value.reasons,
  });
  if (normalized.decisionDigest !== value.decisionDigest) {
    return invalid('policy decision digest is invalid');
  }
  return normalized;
}

export function createModelPriceCatalogAuthorizationCommand(
  value: Omit<
    ModelPriceCatalogAuthorizationCommand,
    'schema' | 'commandDigest'
  >,
): Readonly<ModelPriceCatalogAuthorizationCommand> {
  const candidate = record(value, 'authorization command');
  exactKeys(
    candidate,
    [
      'authorizationId',
      'requestId',
      'operation',
      'provider',
      'model',
      'priceRevision',
      'catalogCommandDigest',
      'principal',
      'policy',
      'decisionMode',
    ],
    'authorization command',
  );
  const normalizedOperation = operation(value.operation);
  const priceRevision = nullableIdentity(
    value.priceRevision,
    'authorization price revision',
  );
  validateOperationRevision(normalizedOperation, priceRevision);
  const principal = normalizeStoredPrincipal(value.principal);
  const policy = normalizeModelPriceCatalogPolicyDecision(value.policy);
  if (policy.effect !== 'allow') {
    return invalid('authorization policy must allow');
  }
  const semantic = Object.freeze({
    schema: MODEL_PRICE_CATALOG_AUTHORIZATION_COMMAND_SCHEMA,
    authorizationId: identity(value.authorizationId, 'authorization identity'),
    requestId: requestId(value.requestId),
    operation: normalizedOperation,
    provider: identity(value.provider, 'authorization provider'),
    model: identity(value.model, 'authorization model'),
    priceRevision,
    catalogCommandDigest: digest(
      value.catalogCommandDigest,
      'catalog command digest',
    ),
    principal,
    policy,
    decisionMode: decisionMode(value.decisionMode),
  });
  return Object.freeze({
    ...semantic,
    commandDigest: hash(AUTHORIZATION_COMMAND_DIGEST_DOMAIN, semantic),
  });
}

export function normalizeModelPriceCatalogAuthorizationCommand(
  value: ModelPriceCatalogAuthorizationCommand,
): Readonly<ModelPriceCatalogAuthorizationCommand> {
  const candidate = record(value, 'authorization command');
  exactKeys(
    candidate,
    [
      'schema',
      'authorizationId',
      'requestId',
      'operation',
      'provider',
      'model',
      'priceRevision',
      'catalogCommandDigest',
      'principal',
      'policy',
      'decisionMode',
      'commandDigest',
    ],
    'authorization command',
  );
  if (value.schema !== MODEL_PRICE_CATALOG_AUTHORIZATION_COMMAND_SCHEMA) {
    return invalid('authorization command schema is invalid');
  }
  const normalized = createModelPriceCatalogAuthorizationCommand({
    authorizationId: value.authorizationId,
    requestId: value.requestId,
    operation: value.operation,
    provider: value.provider,
    model: value.model,
    priceRevision: value.priceRevision,
    catalogCommandDigest: value.catalogCommandDigest,
    principal: value.principal,
    policy: value.policy,
    decisionMode: value.decisionMode,
  });
  if (normalized.commandDigest !== value.commandDigest) {
    return invalid('authorization command digest is invalid');
  }
  return normalized;
}

export function normalizeModelPriceCatalogPublishAuthorization(
  catalogCommandValue: Readonly<ModelPriceCatalogPublishCommand>,
  authorizationValue: Readonly<ModelPriceCatalogAuthorizationCommand>,
): Readonly<ModelPriceCatalogAuthorizationCommand> {
  const catalogCommand = createModelPriceCatalogPublishCommand({
    provider: catalogCommandValue.provider,
    model: catalogCommandValue.model,
    priceRevision: catalogCommandValue.priceRevision,
    currency: catalogCommandValue.currency,
    inputMicrosPerMillionTokens:
      catalogCommandValue.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens:
      catalogCommandValue.outputMicrosPerMillionTokens,
    mutationId: catalogCommandValue.mutationId,
    publishedByUserId: catalogCommandValue.publishedByUserId,
  });
  if (catalogCommand.commandDigest !== catalogCommandValue.commandDigest) {
    return invalid('publish command digest is invalid');
  }
  const authorization =
    normalizeModelPriceCatalogAuthorizationCommand(authorizationValue);
  if (
    authorization.operation !== 'publish' ||
    authorization.provider !== catalogCommand.provider ||
    authorization.model !== catalogCommand.model ||
    authorization.priceRevision !== catalogCommand.priceRevision ||
    authorization.catalogCommandDigest !== catalogCommand.commandDigest ||
    authorization.principal.subject.id !== catalogCommand.publishedByUserId
  ) {
    return invalid('publish authorization binding is invalid');
  }
  return authorization;
}

export function normalizeModelPriceCatalogTransitionAuthorization(
  catalogCommandValue: Readonly<ModelPriceCatalogTransitionCommand>,
  authorizationValue: Readonly<ModelPriceCatalogAuthorizationCommand>,
): Readonly<ModelPriceCatalogAuthorizationCommand> {
  const catalogCommand = createModelPriceCatalogTransitionCommand({
    provider: catalogCommandValue.provider,
    model: catalogCommandValue.model,
    expectedGeneration: catalogCommandValue.expectedGeneration,
    expectedHeadDigest: catalogCommandValue.expectedHeadDigest,
    action: catalogCommandValue.action,
    priceRevision: catalogCommandValue.priceRevision,
    mutationId: catalogCommandValue.mutationId,
    changedByUserId: catalogCommandValue.changedByUserId,
  });
  if (catalogCommand.commandDigest !== catalogCommandValue.commandDigest) {
    return invalid('transition command digest is invalid');
  }
  const authorization =
    normalizeModelPriceCatalogAuthorizationCommand(authorizationValue);
  if (
    authorization.operation !== catalogCommand.action ||
    authorization.provider !== catalogCommand.provider ||
    authorization.model !== catalogCommand.model ||
    authorization.priceRevision !== catalogCommand.priceRevision ||
    authorization.catalogCommandDigest !== catalogCommand.commandDigest ||
    authorization.principal.subject.id !== catalogCommand.changedByUserId
  ) {
    return invalid('transition authorization binding is invalid');
  }
  return authorization;
}

export function createModelPriceCatalogAuthorization(
  commandValue: Readonly<ModelPriceCatalogAuthorizationCommand>,
  resultDigestValue: string,
  committedAtMsValue: number,
): Readonly<ModelPriceCatalogAuthorization> {
  const command = normalizeModelPriceCatalogAuthorizationCommand(commandValue);
  const resultDigest = digest(resultDigestValue, 'authorization result digest');
  const committedAtMs = integer(
    committedAtMsValue,
    'authorization commit time',
  );
  if (
    committedAtMs < command.principal.authenticatedAtMs ||
    committedAtMs >= command.principal.expiresAtMs ||
    committedAtMs - command.principal.authenticatedAtMs >
      MAX_MODEL_PRICE_CATALOG_PRINCIPAL_AGE_MS
  ) {
    return invalid('authorization principal is not active at commit');
  }
  const semantic = Object.freeze({
    schema: MODEL_PRICE_CATALOG_AUTHORIZATION_SCHEMA,
    authorizationId: command.authorizationId,
    requestId: command.requestId,
    operation: command.operation,
    provider: command.provider,
    model: command.model,
    priceRevision: command.priceRevision,
    catalogCommandDigest: command.catalogCommandDigest,
    resultDigest,
    principal: command.principal,
    policy: command.policy,
    decisionMode: command.decisionMode,
    commandDigest: command.commandDigest,
    committedAtMs,
  });
  return Object.freeze({
    ...semantic,
    authorizationDigest: hash(AUTHORIZATION_DIGEST_DOMAIN, semantic),
  });
}

export function normalizeModelPriceCatalogAuthorization(
  value: ModelPriceCatalogAuthorization,
): Readonly<ModelPriceCatalogAuthorization> {
  const candidate = record(value, 'authorization');
  exactKeys(
    candidate,
    [
      'schema',
      'authorizationId',
      'requestId',
      'operation',
      'provider',
      'model',
      'priceRevision',
      'catalogCommandDigest',
      'resultDigest',
      'principal',
      'policy',
      'decisionMode',
      'commandDigest',
      'committedAtMs',
      'authorizationDigest',
    ],
    'authorization',
  );
  if (value.schema !== MODEL_PRICE_CATALOG_AUTHORIZATION_SCHEMA) {
    return invalid('authorization schema is invalid');
  }
  const command = createModelPriceCatalogAuthorizationCommand({
    authorizationId: value.authorizationId,
    requestId: value.requestId,
    operation: value.operation,
    provider: value.provider,
    model: value.model,
    priceRevision: value.priceRevision,
    catalogCommandDigest: value.catalogCommandDigest,
    principal: value.principal,
    policy: value.policy,
    decisionMode: value.decisionMode,
  });
  if (command.commandDigest !== value.commandDigest) {
    return invalid('authorization command digest is invalid');
  }
  const normalized = createModelPriceCatalogAuthorization(
    command,
    value.resultDigest,
    value.committedAtMs,
  );
  if (normalized.authorizationDigest !== value.authorizationDigest) {
    return invalid('authorization digest is invalid');
  }
  return normalized;
}
