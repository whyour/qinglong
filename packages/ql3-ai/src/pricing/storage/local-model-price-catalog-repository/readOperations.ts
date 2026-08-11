import type { DatabaseSync } from 'node:sqlite';

import type { LocalModelInvocationOperationAuthority } from '../../../model-invocation/localModelInvocationRepository';
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

import { enqueueOperation, identifier, unavailable } from './authority';
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

export function findAuthorizationOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  authorizationIdValue: string,
): Promise<Readonly<ModelPriceCatalogAuthorization> | null> {
  const authorizationId = identifier(
    authorizationIdValue,
    'authorization identity',
  );
  return enqueueOperation(authority, () => {
    const rows = authorizationRows(client, 'authorization_id = ?', [
      authorizationId,
    ]);
    if (rows.length > 1) throw unavailable();
    return rows[0] ? authorizationFromRow(rows[0]) : null;
  });
}

export function findPublicationOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  lookupValue: Omit<ModelPriceCatalogLookup, 'signal'>,
): Promise<Readonly<ModelPriceCatalogPublication> | null> {
  const provider = identifier(lookupValue.provider, 'provider');
  const model = identifier(lookupValue.model, 'model');
  const priceRevision = identifier(lookupValue.priceRevision, 'price revision');
  return enqueueOperation(authority, () => {
    const rows = publicationRows(
      client,
      'provider = ? AND model = ? AND price_revision = ?',
      [provider, model, priceRevision],
    );
    if (rows.length > 1) throw unavailable();
    return rows[0] ? publicationFromRow(rows[0]) : null;
  });
}

export function findCurrentOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  providerValue: string,
  modelValue: string,
): Promise<Readonly<ModelPriceCatalogHead> | null> {
  const provider = identifier(providerValue, 'provider');
  const model = identifier(modelValue, 'model');
  return enqueueOperation(authority, () => {
    const rows = headRows(client, 'provider = ? AND model = ?', [
      provider,
      model,
    ]);
    if (
      rows.length > 1 &&
      integer(rows[0]!, 'generation') === integer(rows[1]!, 'generation')
    )
      throw unavailable();
    return rows[0] ? headFromRow(rows[0]) : null;
  });
}

export async function resolveOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  lookupValue: Readonly<ModelPriceCatalogLookup>,
): Promise<Readonly<ModelPriceCatalogEntry> | null> {
  if (
    lookupValue.signal !== undefined &&
    !(lookupValue.signal instanceof AbortSignal)
  ) {
    throw new InvalidModelPriceCatalogError('catalog signal is invalid');
  }
  if (lookupValue.signal?.aborted) throw lookupValue.signal.reason;
  const provider = identifier(lookupValue.provider, 'provider');
  const model = identifier(lookupValue.model, 'model');
  const priceRevision = identifier(lookupValue.priceRevision, 'price revision');
  const entry = await enqueueOperation(authority, () => {
    const rows = client
      .prepare(
        `SELECT publication.provider, publication.model, publication.price_revision AS "priceRevision", publication.catalog_digest AS "catalogDigest", publication.mutation_id AS "mutationId", publication.command_digest AS "commandDigest", publication.publication_digest AS "publicationDigest", publication.published_at_ms AS "publishedAtMs", publication.published_by_user_id AS "publishedByUserId", publication.publication_json AS "publicationJson" FROM "ModelPriceCatalogHeads" AS head JOIN "ModelPriceCatalogPublications" AS publication ON publication.provider = head.provider AND publication.model = head.model AND publication.price_revision = head.active_price_revision AND publication.catalog_digest = head.active_catalog_digest WHERE head.provider = ? AND head.model = ? AND head.active_price_revision = ? AND head.generation = (SELECT max(latest.generation) FROM "ModelPriceCatalogHeads" AS latest WHERE latest.provider = ? AND latest.model = ?) LIMIT 2`,
      )
      .all(provider, model, priceRevision, provider, model) as Row[];
    if (rows.length > 1) throw unavailable();
    return rows[0] ? publicationFromRow(rows[0]).entry : null;
  });
  if (lookupValue.signal?.aborted) throw lookupValue.signal.reason;
  return entry;
}
