import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import {
  ModelPriceCatalogUnavailableError,
  normalizeModelPriceCatalogHead,
  normalizeModelPriceCatalogPublication,
  type ModelPriceCatalogHead,
  type ModelPriceCatalogPublication,
} from '../../modelPriceCatalog';
import {
  normalizeModelPriceCatalogAuthorization,
  type ModelPriceCatalogAuthorization,
  type ModelPriceCatalogAuthorizationCommand,
} from '../../modelPriceCatalogManagement';

import { unavailable } from './authority';

export type Row = Record<string, unknown>;

export function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

export function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw unavailable();
  }
  return value as number;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== 'string') throw unavailable();
  return value;
}

function parsedJson(row: Row, key: string): Record<string, unknown> {
  const value = text(row, key);
  if (Buffer.byteLength(value, 'utf8') > 24 * 1024) throw unavailable();
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype
    ) {
      throw unavailable();
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ModelPriceCatalogUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

export function publicationFromRow(
  row: Row,
): Readonly<ModelPriceCatalogPublication> {
  let publication: Readonly<ModelPriceCatalogPublication>;
  try {
    publication = normalizeModelPriceCatalogPublication(
      parsedJson(
        row,
        'publicationJson',
      ) as unknown as ModelPriceCatalogPublication,
    );
  } catch {
    throw unavailable();
  }
  if (
    publication.entry.provider !== text(row, 'provider') ||
    publication.entry.model !== text(row, 'model') ||
    publication.entry.priceRevision !== text(row, 'priceRevision') ||
    publication.entry.catalogDigest !== text(row, 'catalogDigest') ||
    publication.mutationId !== text(row, 'mutationId') ||
    publication.commandDigest !== text(row, 'commandDigest') ||
    publication.publicationDigest !== text(row, 'publicationDigest') ||
    publication.entry.publishedAtMs !== integer(row, 'publishedAtMs') ||
    publication.publishedByUserId !== text(row, 'publishedByUserId') ||
    JSON.stringify(publication) !== text(row, 'publicationJson')
  ) {
    throw unavailable();
  }
  return publication;
}

export function headFromRow(row: Row): Readonly<ModelPriceCatalogHead> {
  let head: Readonly<ModelPriceCatalogHead>;
  try {
    head = normalizeModelPriceCatalogHead(
      parsedJson(row, 'headJson') as unknown as ModelPriceCatalogHead,
    );
  } catch {
    throw unavailable();
  }
  if (
    head.provider !== text(row, 'provider') ||
    head.model !== text(row, 'model') ||
    head.generation !== integer(row, 'generation') ||
    head.previousHeadDigest !== nullableText(row, 'previousHeadDigest') ||
    head.activePriceRevision !== nullableText(row, 'activePriceRevision') ||
    head.activeCatalogDigest !== nullableText(row, 'activeCatalogDigest') ||
    head.revokedPriceRevision !== nullableText(row, 'revokedPriceRevision') ||
    head.revokedCatalogDigest !== nullableText(row, 'revokedCatalogDigest') ||
    head.action !== text(row, 'action') ||
    head.mutationId !== text(row, 'mutationId') ||
    head.changedByUserId !== text(row, 'changedByUserId') ||
    head.changedAtMs !== integer(row, 'changedAtMs') ||
    head.commandDigest !== text(row, 'commandDigest') ||
    head.headDigest !== text(row, 'headDigest') ||
    JSON.stringify(head) !== text(row, 'headJson')
  ) {
    throw unavailable();
  }
  return head;
}

export function authorizationFromRow(
  row: Row,
): Readonly<ModelPriceCatalogAuthorization> {
  const value = text(row, 'authorizationJson');
  if (Buffer.byteLength(value, 'utf8') > 32 * 1024) throw unavailable();
  let authorization: Readonly<ModelPriceCatalogAuthorization>;
  try {
    authorization = normalizeModelPriceCatalogAuthorization(
      JSON.parse(value) as ModelPriceCatalogAuthorization,
    );
  } catch {
    throw unavailable();
  }
  if (
    authorization.authorizationId !== text(row, 'authorizationId') ||
    authorization.requestId !== text(row, 'requestId') ||
    authorization.operation !== text(row, 'operation') ||
    authorization.provider !== text(row, 'provider') ||
    authorization.model !== text(row, 'model') ||
    authorization.priceRevision !== nullableText(row, 'priceRevision') ||
    authorization.catalogCommandDigest !== text(row, 'catalogCommandDigest') ||
    authorization.resultDigest !== text(row, 'resultDigest') ||
    authorization.principal.subject.id !== text(row, 'userId') ||
    authorization.principal.authenticationId !==
      text(row, 'authenticationId') ||
    authorization.principal.assurance !== text(row, 'assurance') ||
    authorization.principal.authenticatedAtMs !==
      integer(row, 'authenticatedAtMs') ||
    authorization.principal.expiresAtMs !== integer(row, 'expiresAtMs') ||
    authorization.policy.revision !== text(row, 'policyRevision') ||
    authorization.policy.decisionDigest !== text(row, 'policyDecisionDigest') ||
    authorization.decisionMode !== text(row, 'decisionMode') ||
    authorization.commandDigest !== text(row, 'commandDigest') ||
    authorization.committedAtMs !== integer(row, 'committedAtMs') ||
    authorization.authorizationDigest !== text(row, 'authorizationDigest') ||
    JSON.stringify(authorization.policy.reasons) !== text(row, 'reasonsJson') ||
    JSON.stringify(authorization) !== value
  ) {
    throw unavailable();
  }
  return authorization;
}

export function isFreshReauthorizationReplay(
  stored: Readonly<ModelPriceCatalogAuthorization>,
  incoming: Readonly<ModelPriceCatalogAuthorizationCommand>,
): boolean {
  return (
    stored.authorizationId === incoming.authorizationId &&
    stored.requestId === incoming.requestId &&
    stored.operation === incoming.operation &&
    stored.provider === incoming.provider &&
    stored.model === incoming.model &&
    stored.priceRevision === incoming.priceRevision &&
    stored.catalogCommandDigest === incoming.catalogCommandDigest &&
    stored.principal.subject.type === incoming.principal.subject.type &&
    stored.principal.subject.id === incoming.principal.subject.id &&
    stored.principal.authenticationId === incoming.principal.authenticationId &&
    stored.principal.assurance === incoming.principal.assurance &&
    stored.policy.decisionDigest === incoming.policy.decisionDigest &&
    stored.decisionMode === incoming.decisionMode
  );
}

export function publicationRows(
  client: DatabaseSync,
  where: string,
  values: readonly SQLInputValue[],
): readonly Row[] {
  return client
    .prepare(
      `SELECT provider, model, price_revision AS "priceRevision", catalog_digest AS "catalogDigest", mutation_id AS "mutationId", command_digest AS "commandDigest", publication_digest AS "publicationDigest", published_at_ms AS "publishedAtMs", published_by_user_id AS "publishedByUserId", publication_json AS "publicationJson" FROM "ModelPriceCatalogPublications" WHERE ${where} ORDER BY provider, model, price_revision LIMIT 2`,
    )
    .all(...values) as Row[];
}

export function headRows(
  client: DatabaseSync,
  where: string,
  values: readonly SQLInputValue[],
): readonly Row[] {
  return client
    .prepare(
      `SELECT provider, model, generation, previous_head_digest AS "previousHeadDigest", active_price_revision AS "activePriceRevision", active_catalog_digest AS "activeCatalogDigest", revoked_price_revision AS "revokedPriceRevision", revoked_catalog_digest AS "revokedCatalogDigest", action, mutation_id AS "mutationId", changed_by_user_id AS "changedByUserId", changed_at_ms AS "changedAtMs", command_digest AS "commandDigest", head_digest AS "headDigest", head_json AS "headJson" FROM "ModelPriceCatalogHeads" WHERE ${where} ORDER BY generation DESC LIMIT 2`,
    )
    .all(...values) as Row[];
}

export function authorizationRows(
  client: DatabaseSync,
  where: string,
  values: readonly SQLInputValue[],
): readonly Row[] {
  return client
    .prepare(
      `SELECT authorization_id AS "authorizationId", request_id AS "requestId", operation, provider, model, price_revision AS "priceRevision", catalog_command_digest AS "catalogCommandDigest", result_digest AS "resultDigest", user_id AS "userId", authentication_id AS "authenticationId", assurance, authenticated_at_ms AS "authenticatedAtMs", expires_at_ms AS "expiresAtMs", policy_revision AS "policyRevision", policy_decision_digest AS "policyDecisionDigest", decision_mode AS "decisionMode", command_digest AS "commandDigest", committed_at_ms AS "committedAtMs", authorization_digest AS "authorizationDigest", reasons_json AS "reasonsJson", authorization_json AS "authorizationJson" FROM "ModelPriceCatalogAuthorizations" WHERE ${where} ORDER BY committed_at_ms DESC LIMIT 2`,
    )
    .all(...values) as Row[];
}

export function insertAuthorization(
  client: DatabaseSync,
  authorization: Readonly<ModelPriceCatalogAuthorization>,
): void {
  client
    .prepare(
      `INSERT INTO "ModelPriceCatalogAuthorizations" (authorization_id, request_id, operation, provider, model, price_revision, catalog_command_digest, publication_digest, head_digest, result_digest, user_id, authentication_id, assurance, authenticated_at_ms, expires_at_ms, policy_revision, policy_decision_digest, decision_mode, command_digest, committed_at_ms, authorization_digest, reasons_json, authorization_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      authorization.authorizationId,
      authorization.requestId,
      authorization.operation,
      authorization.provider,
      authorization.model,
      authorization.priceRevision,
      authorization.catalogCommandDigest,
      authorization.operation === 'publish' ? authorization.resultDigest : null,
      authorization.operation === 'publish' ? null : authorization.resultDigest,
      authorization.resultDigest,
      authorization.principal.subject.id,
      authorization.principal.authenticationId,
      authorization.principal.assurance,
      authorization.principal.authenticatedAtMs,
      authorization.principal.expiresAtMs,
      authorization.policy.revision,
      authorization.policy.decisionDigest,
      authorization.decisionMode,
      authorization.commandDigest,
      authorization.committedAtMs,
      authorization.authorizationDigest,
      JSON.stringify(authorization.policy.reasons),
      JSON.stringify(authorization),
    );
}
