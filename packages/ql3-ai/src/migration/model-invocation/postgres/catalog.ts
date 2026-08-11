import type { PostgresQueryable } from '@qinglong/runtime-core';

import {
  POSTGRES_MODEL_PRICE_CATALOG_MIGRATION_ID,
  POSTGRES_MODEL_PRICE_CATALOG_AUTHORIZATION_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_SCHEMA,
} from '../identities';

import { defineSqlMigration } from '../shared';

const POSTGRES_MODEL_PRICE_CATALOG_PUBLICATION_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_publications" (
  provider varchar(128) NOT NULL,
  model varchar(128) NOT NULL,
  price_revision varchar(128) NOT NULL,
  catalog_digest char(64) NOT NULL,
  mutation_id varchar(128) NOT NULL UNIQUE,
  command_digest char(64) NOT NULL,
  publication_digest char(64) NOT NULL,
  published_at_ms bigint NOT NULL,
  published_by_user_id varchar(128) NOT NULL,
  publication_json jsonb NOT NULL,
  PRIMARY KEY (provider, model, price_revision),
  CONSTRAINT ql3_model_price_catalog_publication_identity_check CHECK (
    provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    price_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    published_by_user_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  ),
  CONSTRAINT ql3_model_price_catalog_publication_value_check CHECK (
    published_at_ms >= 0 AND
    catalog_digest ~ '^[0-9a-f]{64}$' AND
    command_digest ~ '^[0-9a-f]{64}$' AND
    publication_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_model_price_catalog_publication_json_check CHECK (
    jsonb_typeof(publication_json) = 'object' AND
    octet_length(publication_json::text) BETWEEN 2 AND 24576 AND
    publication_json @> jsonb_build_object(
      'schema', 'qinglong/model-price-catalog-publication@v1',
      'mutationId', mutation_id,
      'publishedByUserId', published_by_user_id,
      'commandDigest', command_digest,
      'publicationDigest', publication_digest
    ) AND
    publication_json->'entry' @> jsonb_build_object(
      'schema', 'qinglong/model-price-catalog-entry@v1',
      'provider', provider,
      'model', model,
      'priceRevision', price_revision,
      'catalogDigest', catalog_digest,
      'publishedAtMs', published_at_ms
    )
  )
)`;

const POSTGRES_MODEL_PRICE_CATALOG_HEAD_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_heads" (
  provider varchar(128) NOT NULL,
  model varchar(128) NOT NULL,
  generation integer NOT NULL,
  previous_head_digest char(64),
  active_price_revision varchar(128),
  active_catalog_digest char(64),
  revoked_price_revision varchar(128),
  revoked_catalog_digest char(64),
  action varchar(16) NOT NULL,
  mutation_id varchar(128) NOT NULL UNIQUE,
  changed_by_user_id varchar(128) NOT NULL,
  changed_at_ms bigint NOT NULL,
  command_digest char(64) NOT NULL,
  head_digest char(64) NOT NULL UNIQUE,
  head_json jsonb NOT NULL,
  PRIMARY KEY (provider, model, generation),
  FOREIGN KEY (previous_head_digest)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_heads"
      (head_digest) ON DELETE RESTRICT,
  FOREIGN KEY (
    provider, model, active_price_revision, active_catalog_digest
  ) REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_publications" (
    provider, model, price_revision, catalog_digest
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    provider, model, revoked_price_revision, revoked_catalog_digest
  ) REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_publications" (
    provider, model, price_revision, catalog_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_price_catalog_head_identity_check CHECK (
    provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    changed_by_user_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  ),
  CONSTRAINT ql3_model_price_catalog_head_value_check CHECK (
    generation BETWEEN 1 AND 2147483647 AND
    ((generation = 1 AND previous_head_digest IS NULL) OR
      (generation > 1 AND previous_head_digest IS NOT NULL)) AND
    ((active_price_revision IS NULL AND active_catalog_digest IS NULL) OR
      (active_price_revision IS NOT NULL AND
       active_catalog_digest IS NOT NULL)) AND
    ((revoked_price_revision IS NULL AND revoked_catalog_digest IS NULL) OR
      (revoked_price_revision IS NOT NULL AND
       revoked_catalog_digest IS NOT NULL)) AND
    (revoked_price_revision IS NULL OR
      revoked_price_revision <> active_price_revision) AND
    action IN ('activate', 'deactivate', 'revoke') AND
    ((action = 'revoke') = (revoked_price_revision IS NOT NULL)) AND
    changed_at_ms >= 0 AND
    (previous_head_digest IS NULL OR
      previous_head_digest ~ '^[0-9a-f]{64}$') AND
    (active_catalog_digest IS NULL OR
      active_catalog_digest ~ '^[0-9a-f]{64}$') AND
    (revoked_catalog_digest IS NULL OR
      revoked_catalog_digest ~ '^[0-9a-f]{64}$') AND
    command_digest ~ '^[0-9a-f]{64}$' AND
    head_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_model_price_catalog_head_json_check CHECK (
    jsonb_typeof(head_json) = 'object' AND
    octet_length(head_json::text) BETWEEN 2 AND 24576 AND
    head_json @> jsonb_build_object(
      'schema', 'qinglong/model-price-catalog-head@v1',
      'provider', provider,
      'model', model,
      'generation', generation,
      'previousHeadDigest', previous_head_digest,
      'activePriceRevision', active_price_revision,
      'activeCatalogDigest', active_catalog_digest,
      'revokedPriceRevision', revoked_price_revision,
      'revokedCatalogDigest', revoked_catalog_digest,
      'action', action,
      'mutationId', mutation_id,
      'changedByUserId', changed_by_user_id,
      'changedAtMs', changed_at_ms,
      'commandDigest', command_digest,
      'headDigest', head_digest
    )
  )
)`;

const postgresModelPriceCatalogMigration =
  defineSqlMigration<PostgresQueryable>(
    POSTGRES_MODEL_PRICE_CATALOG_MIGRATION_ID,
    [
      POSTGRES_MODEL_PRICE_CATALOG_PUBLICATION_TABLE_SQL,
      `CREATE UNIQUE INDEX ql3_model_price_catalog_publication_identity_digest_uidx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_publications"
         (provider, model, price_revision, catalog_digest)`,
      `CREATE UNIQUE INDEX ql3_model_price_catalog_publication_digest_uidx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_publications"
         (publication_digest)`,
      POSTGRES_MODEL_PRICE_CATALOG_HEAD_TABLE_SQL,
      `CREATE INDEX ql3_model_price_catalog_head_current_idx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_heads"
         (provider, model, generation DESC)`,
      `CREATE UNIQUE INDEX ql3_model_price_catalog_revoked_revision_uidx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_heads"
         (provider, model, revoked_price_revision)
         WHERE revoked_price_revision IS NOT NULL`,
      `GRANT USAGE ON SCHEMA "${POSTGRES_MODEL_INVOCATION_SCHEMA}"
       TO ql3_admin`,
      `REVOKE ALL ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_publications",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_heads"
       FROM PUBLIC`,
      `GRANT SELECT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_publications",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_heads"
       TO ql3_runtime`,
      `GRANT SELECT, INSERT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_publications",
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_heads"
       TO ql3_admin`,
    ],
    (context, statement) => context.query(statement).then(() => undefined),
  );

const POSTGRES_MODEL_PRICE_CATALOG_AUTHORIZATION_TABLE_SQL = `
CREATE TABLE "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_authorizations" (
  authorization_id varchar(128) PRIMARY KEY,
  request_id varchar(128) NOT NULL,
  operation varchar(16) NOT NULL,
  provider varchar(128) NOT NULL,
  model varchar(128) NOT NULL,
  price_revision varchar(128),
  catalog_command_digest char(64) NOT NULL UNIQUE,
  publication_digest char(64) UNIQUE,
  head_digest char(64) UNIQUE,
  result_digest char(64) NOT NULL UNIQUE,
  user_id varchar(128) NOT NULL,
  authentication_id varchar(128) NOT NULL,
  assurance varchar(32) NOT NULL,
  authenticated_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL,
  policy_revision varchar(128) NOT NULL,
  policy_decision_digest char(64) NOT NULL,
  decision_mode varchar(32) NOT NULL,
  command_digest char(64) NOT NULL UNIQUE,
  committed_at_ms bigint NOT NULL,
  authorization_digest char(64) NOT NULL UNIQUE,
  reasons_json jsonb NOT NULL,
  authorization_json jsonb NOT NULL,
  FOREIGN KEY (publication_digest)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_publications"
      (publication_digest) ON DELETE RESTRICT,
  FOREIGN KEY (head_digest)
    REFERENCES "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_heads"
      (head_digest) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_price_catalog_authorization_identity_check CHECK (
    authorization_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    provider ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    (price_revision IS NULL OR
      price_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$') AND
    user_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$' AND
    authentication_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  ),
  CONSTRAINT ql3_model_price_catalog_authorization_value_check CHECK (
    operation IN ('publish', 'activate', 'deactivate', 'revoke') AND
    ((operation = 'deactivate' AND price_revision IS NULL) OR
      (operation <> 'deactivate' AND price_revision IS NOT NULL)) AND
    ((operation = 'publish' AND publication_digest IS NOT NULL AND
        head_digest IS NULL AND result_digest = publication_digest) OR
      (operation <> 'publish' AND publication_digest IS NULL AND
        head_digest IS NOT NULL AND result_digest = head_digest)) AND
    assurance IN ('multi_factor', 'hardware', 'local_console') AND
    decision_mode IN ('human_confirmation', 'separation_of_duty') AND
    authenticated_at_ms >= 0 AND
    expires_at_ms > authenticated_at_ms AND
    committed_at_ms >= authenticated_at_ms AND
    committed_at_ms < expires_at_ms AND
    committed_at_ms - authenticated_at_ms <= 300000 AND
    catalog_command_digest ~ '^[0-9a-f]{64}$' AND
    result_digest ~ '^[0-9a-f]{64}$' AND
    policy_decision_digest ~ '^[0-9a-f]{64}$' AND
    command_digest ~ '^[0-9a-f]{64}$' AND
    authorization_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_model_price_catalog_authorization_reasons_check CHECK (
    jsonb_typeof(reasons_json) = 'array' AND
    jsonb_array_length(reasons_json) BETWEEN 1 AND 8 AND
    octet_length(reasons_json::text) BETWEEN 5 AND 2048
  ),
  CONSTRAINT ql3_model_price_catalog_authorization_json_check CHECK (
    jsonb_typeof(authorization_json) = 'object' AND
    octet_length(authorization_json::text) BETWEEN 2 AND 32768 AND
    authorization_json @> jsonb_build_object(
      'schema', 'qinglong/model-price-catalog-authorization@v1',
      'authorizationId', authorization_id,
      'requestId', request_id,
      'operation', operation,
      'provider', provider,
      'model', model,
      'priceRevision', price_revision,
      'catalogCommandDigest', catalog_command_digest,
      'resultDigest', result_digest,
      'decisionMode', decision_mode,
      'commandDigest', command_digest,
      'committedAtMs', committed_at_ms,
      'authorizationDigest', authorization_digest
    ) AND
    authorization_json->'principal' @> jsonb_build_object(
      'subject', jsonb_build_object('type', 'user', 'id', user_id),
      'authenticationId', authentication_id,
      'assurance', assurance,
      'authenticatedAtMs', authenticated_at_ms,
      'expiresAtMs', expires_at_ms
    ) AND
    authorization_json->'policy' @> jsonb_build_object(
      'revision', policy_revision,
      'decisionDigest', policy_decision_digest,
      'reasons', reasons_json
    )
  )
)`;

const postgresModelPriceCatalogAuthorizationMigration =
  defineSqlMigration<PostgresQueryable>(
    POSTGRES_MODEL_PRICE_CATALOG_AUTHORIZATION_MIGRATION_ID,
    [
      POSTGRES_MODEL_PRICE_CATALOG_AUTHORIZATION_TABLE_SQL,
      `CREATE INDEX ql3_model_price_catalog_authorization_target_idx
         ON "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_authorizations"
         (provider, model, operation, committed_at_ms DESC)`,
      `REVOKE ALL ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_authorizations"
       FROM PUBLIC`,
      `GRANT SELECT, INSERT ON TABLE
         "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_price_catalog_authorizations"
       TO ql3_admin`,
    ],
    (context, statement) => context.query(statement).then(() => undefined),
  );

export const postgresCatalogMigrations = Object.freeze([
  postgresModelPriceCatalogMigration,
  postgresModelPriceCatalogAuthorizationMigration,
]);
