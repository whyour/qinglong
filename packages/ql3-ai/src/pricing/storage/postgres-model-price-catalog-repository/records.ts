import type { PostgresClient, PostgresQueryable } from '@qinglong/runtime-core';

import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../../../migration/modelInvocationMigration';
import {
  normalizeModelPriceCatalogHead,
  normalizeModelPriceCatalogPublication,
  type ModelPriceCatalogHead,
  type ModelPriceCatalogPublication,
} from '../../modelPriceCatalog';
import {
  normalizeModelPriceCatalogAuthorization,
  type ModelPriceCatalogAuthorization,
} from '../../modelPriceCatalogManagement';

import { unavailable } from './authority';

export type Row = Record<string, unknown>;
type Queryable = Pick<PostgresQueryable, 'query'>;

export function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

export function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw unavailable();
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== 'string') throw unavailable();
  return value;
}

function jsonObject(row: Row, key: string): Record<string, unknown> {
  const value = row[key];
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.getPrototypeOf(parsed) === Object.prototype
      )
        return parsed as Record<string, unknown>;
    } catch {
      // Mapped below.
    }
  }
  throw unavailable();
}

export function publicationFromRow(
  row: Row,
): Readonly<ModelPriceCatalogPublication> {
  let publication: Readonly<ModelPriceCatalogPublication>;
  try {
    publication = normalizeModelPriceCatalogPublication(
      jsonObject(
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
    publication.publishedByUserId !== text(row, 'publishedByUserId')
  )
    throw unavailable();
  return publication;
}

export function headFromRow(row: Row): Readonly<ModelPriceCatalogHead> {
  let head: Readonly<ModelPriceCatalogHead>;
  try {
    head = normalizeModelPriceCatalogHead(
      jsonObject(row, 'headJson') as unknown as ModelPriceCatalogHead,
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
    head.headDigest !== text(row, 'headDigest')
  )
    throw unavailable();
  return head;
}

export function authorizationFromRow(
  row: Row,
): Readonly<ModelPriceCatalogAuthorization> {
  let authorization: Readonly<ModelPriceCatalogAuthorization>;
  try {
    authorization = normalizeModelPriceCatalogAuthorization(
      jsonObject(
        row,
        'authorizationJson',
      ) as unknown as ModelPriceCatalogAuthorization,
    );
  } catch {
    throw unavailable();
  }
  let normalizedReasons: unknown;
  try {
    const reasons = row.reasonsJson;
    normalizedReasons =
      typeof reasons === 'string' ? JSON.parse(reasons) : reasons;
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
    JSON.stringify(authorization.policy.reasons) !==
      JSON.stringify(normalizedReasons)
  )
    throw unavailable();
  return authorization;
}

export async function publicationRows(
  queryable: Queryable,
  where: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT provider, model, price_revision AS "priceRevision", catalog_digest AS "catalogDigest", mutation_id AS "mutationId", command_digest AS "commandDigest", publication_digest AS "publicationDigest", published_at_ms AS "publishedAtMs", published_by_user_id AS "publishedByUserId", publication_json AS "publicationJson" FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_publications" WHERE ${where} ORDER BY provider, model, price_revision LIMIT 2`,
    values,
  );
  return result.rows;
}

export async function headRows(
  queryable: Queryable,
  where: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT provider, model, generation, previous_head_digest AS "previousHeadDigest", active_price_revision AS "activePriceRevision", active_catalog_digest AS "activeCatalogDigest", revoked_price_revision AS "revokedPriceRevision", revoked_catalog_digest AS "revokedCatalogDigest", action, mutation_id AS "mutationId", changed_by_user_id AS "changedByUserId", changed_at_ms AS "changedAtMs", command_digest AS "commandDigest", head_digest AS "headDigest", head_json AS "headJson" FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_heads" WHERE ${where} ORDER BY generation DESC LIMIT 2`,
    values,
  );
  return result.rows;
}

export async function authorizationRows(
  queryable: Queryable,
  where: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT authorization_id AS "authorizationId", request_id AS "requestId", operation, provider, model, price_revision AS "priceRevision", catalog_command_digest AS "catalogCommandDigest", result_digest AS "resultDigest", user_id AS "userId", authentication_id AS "authenticationId", assurance, authenticated_at_ms AS "authenticatedAtMs", expires_at_ms AS "expiresAtMs", policy_revision AS "policyRevision", policy_decision_digest AS "policyDecisionDigest", decision_mode AS "decisionMode", command_digest AS "commandDigest", committed_at_ms AS "committedAtMs", authorization_digest AS "authorizationDigest", reasons_json AS "reasonsJson", authorization_json AS "authorizationJson" FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_authorizations" WHERE ${where} ORDER BY committed_at_ms DESC LIMIT 2`,
    values,
  );
  return result.rows;
}

export async function insertAuthorization(
  client: PostgresClient,
  authorization: Readonly<ModelPriceCatalogAuthorization>,
): Promise<void> {
  await client.query(
    `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_authorizations" (authorization_id, request_id, operation, provider, model, price_revision, catalog_command_digest, publication_digest, head_digest, result_digest, user_id, authentication_id, assurance, authenticated_at_ms, expires_at_ms, policy_revision, policy_decision_digest, decision_mode, command_digest, committed_at_ms, authorization_digest, reasons_json, authorization_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23::jsonb)`,
    [
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
    ],
  );
}

export async function databaseClock(client: PostgresClient): Promise<number> {
  const clock = await client.query<Row>(
    `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
       AS now`,
  );
  if (clock.rows.length !== 1 || !clock.rows[0]) throw unavailable();
  return integer(clock.rows[0], 'now');
}

export async function insertPublication(
  client: PostgresClient,
  publication: Readonly<ModelPriceCatalogPublication>,
): Promise<void> {
  await client.query(
    `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_publications" (
       provider, model, price_revision, catalog_digest,
       mutation_id, command_digest, publication_digest,
       published_at_ms, published_by_user_id, publication_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
     )`,
    [
      publication.entry.provider,
      publication.entry.model,
      publication.entry.priceRevision,
      publication.entry.catalogDigest,
      publication.mutationId,
      publication.commandDigest,
      publication.publicationDigest,
      publication.entry.publishedAtMs,
      publication.publishedByUserId,
      JSON.stringify(publication),
    ],
  );
}

export async function insertHead(
  client: PostgresClient,
  head: Readonly<ModelPriceCatalogHead>,
): Promise<void> {
  await client.query(
    `INSERT INTO "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_heads" (
       provider, model, generation, previous_head_digest,
       active_price_revision, active_catalog_digest,
       revoked_price_revision, revoked_catalog_digest,
       action, mutation_id, changed_by_user_id, changed_at_ms,
       command_digest, head_digest, head_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15::jsonb
     )`,
    [
      head.provider,
      head.model,
      head.generation,
      head.previousHeadDigest,
      head.activePriceRevision,
      head.activeCatalogDigest,
      head.revokedPriceRevision,
      head.revokedCatalogDigest,
      head.action,
      head.mutationId,
      head.changedByUserId,
      head.changedAtMs,
      head.commandDigest,
      head.headDigest,
      JSON.stringify(head),
    ],
  );
}

export async function wasRevoked(
  client: PostgresClient,
  provider: string,
  model: string,
  priceRevision: string | null,
): Promise<boolean> {
  if (priceRevision === null) return false;
  const result = await client.query<Row>(
    `SELECT 1
       FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_heads"
      WHERE provider = $1 AND model = $2
        AND revoked_price_revision = $3
      LIMIT 1`,
    [provider, model, priceRevision],
  );
  return result.rows.length !== 0;
}
