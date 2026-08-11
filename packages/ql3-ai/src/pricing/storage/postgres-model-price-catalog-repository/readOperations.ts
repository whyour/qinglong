import type { PostgresPool } from '@qinglong/runtime-core';

import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../../../migration/modelInvocationMigration';
import {
  InvalidModelPriceCatalogError,
  type ModelPriceCatalogHead,
  type ModelPriceCatalogPublication,
} from '../../modelPriceCatalog';
import type { ModelPriceCatalogAuthorization } from '../../modelPriceCatalogManagement';
import type {
  ModelPriceCatalogEntry,
  ModelPriceCatalogLookup,
} from '../../pricing';

import { identifier, mapStorageError, unavailable } from './authority';
import {
  authorizationFromRow,
  authorizationRows,
  headFromRow,
  headRows,
  integer,
  publicationFromRow,
  publicationRows,
  type Row,
} from './records';

export async function findAuthorizationOperation(
  pool: PostgresPool,
  authorizationIdValue: string,
): Promise<Readonly<ModelPriceCatalogAuthorization> | null> {
  const authorizationId = identifier(
    authorizationIdValue,
    'authorization identity',
  );
  try {
    const rows = await authorizationRows(pool, 'authorization_id = $1', [
      authorizationId,
    ]);
    if (rows.length > 1) throw unavailable();
    return rows[0] ? authorizationFromRow(rows[0]) : null;
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function findPublicationOperation(
  pool: PostgresPool,
  lookupValue: Omit<ModelPriceCatalogLookup, 'signal'>,
): Promise<Readonly<ModelPriceCatalogPublication> | null> {
  const provider = identifier(lookupValue.provider, 'provider');
  const model = identifier(lookupValue.model, 'model');
  const priceRevision = identifier(lookupValue.priceRevision, 'price revision');
  try {
    const rows = await publicationRows(
      pool,
      'provider = $1 AND model = $2 AND price_revision = $3',
      [provider, model, priceRevision],
    );
    if (rows.length > 1) throw unavailable();
    return rows[0] ? publicationFromRow(rows[0]) : null;
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function findCurrentOperation(
  pool: PostgresPool,
  providerValue: string,
  modelValue: string,
): Promise<Readonly<ModelPriceCatalogHead> | null> {
  const provider = identifier(providerValue, 'provider');
  const model = identifier(modelValue, 'model');
  try {
    const rows = await headRows(pool, 'provider = $1 AND model = $2', [
      provider,
      model,
    ]);
    if (
      rows.length > 1 &&
      integer(rows[0]!, 'generation') === integer(rows[1]!, 'generation')
    )
      throw unavailable();
    return rows[0] ? headFromRow(rows[0]) : null;
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function resolveOperation(
  pool: PostgresPool,
  lookupValue: Readonly<ModelPriceCatalogLookup>,
): Promise<Readonly<ModelPriceCatalogEntry> | null> {
  if (
    lookupValue.signal !== undefined &&
    !(lookupValue.signal instanceof AbortSignal)
  )
    throw new InvalidModelPriceCatalogError('catalog signal is invalid');
  if (lookupValue.signal?.aborted) throw lookupValue.signal.reason;
  const provider = identifier(lookupValue.provider, 'provider');
  const model = identifier(lookupValue.model, 'model');
  const priceRevision = identifier(lookupValue.priceRevision, 'price revision');
  let entry: Readonly<ModelPriceCatalogEntry> | null;
  try {
    const result = await pool.query<Row>(
      `SELECT publication.provider, publication.model,
         publication.price_revision AS "priceRevision",
         publication.catalog_digest AS "catalogDigest",
         publication.mutation_id AS "mutationId",
         publication.command_digest AS "commandDigest",
         publication.publication_digest AS "publicationDigest",
         publication.published_at_ms AS "publishedAtMs",
         publication.published_by_user_id AS "publishedByUserId",
         publication.publication_json AS "publicationJson"
       FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_heads" AS head
       JOIN "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_publications" AS publication
         ON publication.provider = head.provider
        AND publication.model = head.model
        AND publication.price_revision = head.active_price_revision
        AND publication.catalog_digest = head.active_catalog_digest
       WHERE head.provider = $1 AND head.model = $2
         AND head.active_price_revision = $3
         AND head.generation = (
           SELECT max(latest.generation)
           FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_heads" AS latest
           WHERE latest.provider = $1 AND latest.model = $2
         )
       LIMIT 2`,
      [provider, model, priceRevision],
    );
    if (result.rows.length > 1) throw unavailable();
    entry = result.rows[0] ? publicationFromRow(result.rows[0]).entry : null;
  } catch (error) {
    throw mapStorageError(error);
  }
  if (lookupValue.signal?.aborted) throw lookupValue.signal.reason;
  return entry;
}
