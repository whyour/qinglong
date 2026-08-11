import type { LocalMigrationContext } from './context';

import {
  LOCAL_MODEL_PRICE_CATALOG_MIGRATION_ID,
  LOCAL_MODEL_PRICE_CATALOG_AUTHORIZATION_MIGRATION_ID,
  LOCAL_MODEL_INVOCATION_FEATURE_ACTIVATION_MIGRATION_ID,
} from '../identities';

import { defineSqlMigration } from '../shared';

const LOCAL_MODEL_PRICE_CATALOG_PUBLICATION_TABLE_SQL = `
CREATE TABLE "ModelPriceCatalogPublications" (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  price_revision TEXT NOT NULL,
  catalog_digest TEXT NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE,
  command_digest TEXT NOT NULL,
  publication_digest TEXT NOT NULL,
  published_at_ms INTEGER NOT NULL,
  published_by_user_id TEXT NOT NULL,
  publication_json TEXT NOT NULL,
  PRIMARY KEY (provider, model, price_revision),
  CONSTRAINT ql3_model_price_catalog_publication_identity_check CHECK (
    length(provider) BETWEEN 1 AND 128 AND
    length(model) BETWEEN 1 AND 128 AND
    length(price_revision) BETWEEN 1 AND 128 AND
    length(mutation_id) BETWEEN 1 AND 128 AND
    length(published_by_user_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_model_price_catalog_publication_value_check CHECK (
    published_at_ms >= 0 AND
    length(catalog_digest) = 64 AND
      catalog_digest NOT GLOB '*[^0-9a-f]*' AND
    length(command_digest) = 64 AND
      command_digest NOT GLOB '*[^0-9a-f]*' AND
    length(publication_digest) = 64 AND
      publication_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_model_price_catalog_publication_json_check CHECK (
    length(CAST(publication_json AS BLOB)) BETWEEN 2 AND 24576 AND
    json_valid(publication_json) AND
    json_type(publication_json) = 'object' AND
    json_extract(publication_json, '$.schema') =
      'qinglong/model-price-catalog-publication@v1' AND
    json_extract(publication_json, '$.entry.schema') =
      'qinglong/model-price-catalog-entry@v1' AND
    json_extract(publication_json, '$.entry.provider') = provider AND
    json_extract(publication_json, '$.entry.model') = model AND
    json_extract(publication_json, '$.entry.priceRevision') =
      price_revision AND
    json_extract(publication_json, '$.entry.catalogDigest') =
      catalog_digest AND
    json_extract(publication_json, '$.entry.publishedAtMs') =
      published_at_ms AND
    json_extract(publication_json, '$.mutationId') = mutation_id AND
    json_extract(publication_json, '$.publishedByUserId') =
      published_by_user_id AND
    json_extract(publication_json, '$.commandDigest') = command_digest AND
    json_extract(publication_json, '$.publicationDigest') =
      publication_digest
  )
)`;

const LOCAL_MODEL_PRICE_CATALOG_HEAD_TABLE_SQL = `
CREATE TABLE "ModelPriceCatalogHeads" (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  generation INTEGER NOT NULL,
  previous_head_digest TEXT,
  active_price_revision TEXT,
  active_catalog_digest TEXT,
  revoked_price_revision TEXT,
  revoked_catalog_digest TEXT,
  action TEXT NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE,
  changed_by_user_id TEXT NOT NULL,
  changed_at_ms INTEGER NOT NULL,
  command_digest TEXT NOT NULL,
  head_digest TEXT NOT NULL UNIQUE,
  head_json TEXT NOT NULL,
  PRIMARY KEY (provider, model, generation),
  FOREIGN KEY (previous_head_digest)
    REFERENCES "ModelPriceCatalogHeads" (head_digest) ON DELETE RESTRICT,
  FOREIGN KEY (
    provider, model, active_price_revision, active_catalog_digest
  ) REFERENCES "ModelPriceCatalogPublications" (
    provider, model, price_revision, catalog_digest
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    provider, model, revoked_price_revision, revoked_catalog_digest
  ) REFERENCES "ModelPriceCatalogPublications" (
    provider, model, price_revision, catalog_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT ql3_model_price_catalog_head_identity_check CHECK (
    length(provider) BETWEEN 1 AND 128 AND
    length(model) BETWEEN 1 AND 128 AND
    length(mutation_id) BETWEEN 1 AND 128 AND
    length(changed_by_user_id) BETWEEN 1 AND 128
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
    (previous_head_digest IS NULL OR (
      length(previous_head_digest) = 64 AND
      previous_head_digest NOT GLOB '*[^0-9a-f]*'
    )) AND
    (active_catalog_digest IS NULL OR (
      length(active_catalog_digest) = 64 AND
      active_catalog_digest NOT GLOB '*[^0-9a-f]*'
    )) AND
    (revoked_catalog_digest IS NULL OR (
      length(revoked_catalog_digest) = 64 AND
      revoked_catalog_digest NOT GLOB '*[^0-9a-f]*'
    )) AND
    length(command_digest) = 64 AND
      command_digest NOT GLOB '*[^0-9a-f]*' AND
    length(head_digest) = 64 AND head_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_model_price_catalog_head_json_check CHECK (
    length(CAST(head_json AS BLOB)) BETWEEN 2 AND 24576 AND
    json_valid(head_json) AND json_type(head_json) = 'object' AND
    json_extract(head_json, '$.schema') =
      'qinglong/model-price-catalog-head@v1' AND
    json_extract(head_json, '$.provider') = provider AND
    json_extract(head_json, '$.model') = model AND
    json_extract(head_json, '$.generation') = generation AND
    ((previous_head_digest IS NULL AND
      json_type(head_json, '$.previousHeadDigest') = 'null') OR
      json_extract(head_json, '$.previousHeadDigest') =
        previous_head_digest) AND
    ((active_price_revision IS NULL AND
      json_type(head_json, '$.activePriceRevision') = 'null') OR
      json_extract(head_json, '$.activePriceRevision') =
        active_price_revision) AND
    ((active_catalog_digest IS NULL AND
      json_type(head_json, '$.activeCatalogDigest') = 'null') OR
      json_extract(head_json, '$.activeCatalogDigest') =
        active_catalog_digest) AND
    ((revoked_price_revision IS NULL AND
      json_type(head_json, '$.revokedPriceRevision') = 'null') OR
      json_extract(head_json, '$.revokedPriceRevision') =
        revoked_price_revision) AND
    ((revoked_catalog_digest IS NULL AND
      json_type(head_json, '$.revokedCatalogDigest') = 'null') OR
      json_extract(head_json, '$.revokedCatalogDigest') =
        revoked_catalog_digest) AND
    json_extract(head_json, '$.action') = action AND
    json_extract(head_json, '$.mutationId') = mutation_id AND
    json_extract(head_json, '$.changedByUserId') =
      changed_by_user_id AND
    json_extract(head_json, '$.changedAtMs') = changed_at_ms AND
    json_extract(head_json, '$.commandDigest') = command_digest AND
    json_extract(head_json, '$.headDigest') = head_digest
  )
)`;

const localModelPriceCatalogMigration =
  defineSqlMigration<LocalMigrationContext>(
    LOCAL_MODEL_PRICE_CATALOG_MIGRATION_ID,
    [
      LOCAL_MODEL_PRICE_CATALOG_PUBLICATION_TABLE_SQL,
      `CREATE UNIQUE INDEX ql3_model_price_catalog_publication_identity_digest_uidx
         ON "ModelPriceCatalogPublications"
         (provider, model, price_revision, catalog_digest)`,
      `CREATE UNIQUE INDEX ql3_model_price_catalog_publication_digest_uidx
         ON "ModelPriceCatalogPublications" (publication_digest)`,
      LOCAL_MODEL_PRICE_CATALOG_HEAD_TABLE_SQL,
      `CREATE INDEX ql3_model_price_catalog_head_current_idx
         ON "ModelPriceCatalogHeads" (provider, model, generation DESC)`,
      `CREATE UNIQUE INDEX ql3_model_price_catalog_revoked_revision_uidx
         ON "ModelPriceCatalogHeads"
         (provider, model, revoked_price_revision)
         WHERE revoked_price_revision IS NOT NULL`,
    ],
    (context, statement) => context.client.exec(statement),
  );

const LOCAL_MODEL_PRICE_CATALOG_AUTHORIZATION_TABLE_SQL = `
CREATE TABLE "ModelPriceCatalogAuthorizations" (
  authorization_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  price_revision TEXT,
  catalog_command_digest TEXT NOT NULL UNIQUE,
  publication_digest TEXT UNIQUE,
  head_digest TEXT UNIQUE,
  result_digest TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  authentication_id TEXT NOT NULL,
  assurance TEXT NOT NULL,
  authenticated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  policy_revision TEXT NOT NULL,
  policy_decision_digest TEXT NOT NULL,
  decision_mode TEXT NOT NULL,
  command_digest TEXT NOT NULL UNIQUE,
  committed_at_ms INTEGER NOT NULL,
  authorization_digest TEXT NOT NULL UNIQUE,
  reasons_json TEXT NOT NULL,
  authorization_json TEXT NOT NULL,
  FOREIGN KEY (publication_digest)
    REFERENCES "ModelPriceCatalogPublications" (publication_digest)
    ON DELETE RESTRICT,
  FOREIGN KEY (head_digest)
    REFERENCES "ModelPriceCatalogHeads" (head_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_model_price_catalog_authorization_identity_check CHECK (
    length(authorization_id) BETWEEN 1 AND 128 AND
    length(request_id) BETWEEN 1 AND 128 AND
    length(provider) BETWEEN 1 AND 128 AND
    length(model) BETWEEN 1 AND 128 AND
    (price_revision IS NULL OR length(price_revision) BETWEEN 1 AND 128) AND
    length(user_id) BETWEEN 1 AND 128 AND
    length(authentication_id) BETWEEN 1 AND 128 AND
    length(policy_revision) BETWEEN 1 AND 128
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
    length(catalog_command_digest) = 64 AND
      catalog_command_digest NOT GLOB '*[^0-9a-f]*' AND
    length(result_digest) = 64 AND
      result_digest NOT GLOB '*[^0-9a-f]*' AND
    length(policy_decision_digest) = 64 AND
      policy_decision_digest NOT GLOB '*[^0-9a-f]*' AND
    length(command_digest) = 64 AND
      command_digest NOT GLOB '*[^0-9a-f]*' AND
    length(authorization_digest) = 64 AND
      authorization_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_model_price_catalog_authorization_reasons_check CHECK (
    length(CAST(reasons_json AS BLOB)) BETWEEN 5 AND 2048 AND
    json_valid(reasons_json) AND json_type(reasons_json) = 'array' AND
    json_array_length(reasons_json) BETWEEN 1 AND 8
  ),
  CONSTRAINT ql3_model_price_catalog_authorization_json_check CHECK (
    length(CAST(authorization_json AS BLOB)) BETWEEN 2 AND 32768 AND
    json_valid(authorization_json) AND
    json_type(authorization_json) = 'object' AND
    json_extract(authorization_json, '$.schema') =
      'qinglong/model-price-catalog-authorization@v1' AND
    json_extract(authorization_json, '$.authorizationId') =
      authorization_id AND
    json_extract(authorization_json, '$.requestId') = request_id AND
    json_extract(authorization_json, '$.operation') = operation AND
    json_extract(authorization_json, '$.provider') = provider AND
    json_extract(authorization_json, '$.model') = model AND
    ((price_revision IS NULL AND
      json_type(authorization_json, '$.priceRevision') = 'null') OR
      json_extract(authorization_json, '$.priceRevision') =
        price_revision) AND
    json_extract(authorization_json, '$.catalogCommandDigest') =
      catalog_command_digest AND
    json_extract(authorization_json, '$.resultDigest') = result_digest AND
    json_extract(authorization_json, '$.principal.subject.type') = 'user' AND
    json_extract(authorization_json, '$.principal.subject.id') = user_id AND
    json_extract(authorization_json, '$.principal.authenticationId') =
      authentication_id AND
    json_extract(authorization_json, '$.principal.assurance') = assurance AND
    json_extract(authorization_json, '$.principal.authenticatedAtMs') =
      authenticated_at_ms AND
    json_extract(authorization_json, '$.principal.expiresAtMs') =
      expires_at_ms AND
    json_extract(authorization_json, '$.policy.revision') =
      policy_revision AND
    json_extract(authorization_json, '$.policy.decisionDigest') =
      policy_decision_digest AND
    json_extract(authorization_json, '$.decisionMode') = decision_mode AND
    json_extract(authorization_json, '$.commandDigest') = command_digest AND
    json_extract(authorization_json, '$.committedAtMs') = committed_at_ms AND
    json_extract(authorization_json, '$.authorizationDigest') =
      authorization_digest AND
    json_extract(authorization_json, '$.policy.reasons') =
      json(reasons_json)
  )
)`;

const localModelPriceCatalogAuthorizationMigration =
  defineSqlMigration<LocalMigrationContext>(
    LOCAL_MODEL_PRICE_CATALOG_AUTHORIZATION_MIGRATION_ID,
    [
      LOCAL_MODEL_PRICE_CATALOG_AUTHORIZATION_TABLE_SQL,
      `CREATE INDEX ql3_model_price_catalog_authorization_target_idx
         ON "ModelPriceCatalogAuthorizations"
         (provider, model, operation, committed_at_ms DESC)`,
    ],
    (context, statement) => context.client.exec(statement),
  );

const LOCAL_MODEL_INVOCATION_FEATURE_TRANSITION_TABLE_SQL = `
CREATE TABLE "ModelInvocationFeatureTransitions" (
  feature_id TEXT NOT NULL
    CONSTRAINT ql3_ai_feature_transition_feature_check
    CHECK (feature_id = 'model-invocation'),
  generation INTEGER NOT NULL
    CONSTRAINT ql3_ai_feature_transition_generation_check
    CHECK (generation BETWEEN 1 AND 2147483647),
  previous_generation INTEGER,
  state TEXT NOT NULL
    CONSTRAINT ql3_ai_feature_transition_state_check
    CHECK (state IN ('active', 'inactive')),
  mutation_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  expected_migration_digest TEXT NOT NULL,
  safety_mode TEXT NOT NULL
    CONSTRAINT ql3_ai_feature_transition_safety_check
    CHECK (safety_mode IN (
      'fresh_database',
      'backup_verified',
      'preserve_existing'
    )),
  backup_evidence_digest TEXT,
  changed_by_user_id TEXT NOT NULL,
  authentication_id TEXT NOT NULL,
  assurance TEXT NOT NULL
    CONSTRAINT ql3_ai_feature_transition_assurance_check
    CHECK (assurance = 'local_console'),
  command_digest TEXT NOT NULL,
  transition_digest TEXT NOT NULL UNIQUE,
  committed_at_ms INTEGER NOT NULL
    CONSTRAINT ql3_ai_feature_transition_time_check
    CHECK (committed_at_ms >= 0),
  transition_json TEXT NOT NULL,
  PRIMARY KEY (feature_id, generation),
  UNIQUE (feature_id, generation, transition_digest),
  CONSTRAINT ql3_ai_feature_transition_previous_fk
    FOREIGN KEY (feature_id, previous_generation)
    REFERENCES "ModelInvocationFeatureTransitions" (feature_id, generation)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_feature_transition_previous_check CHECK (
    (
      generation = 1 AND
      previous_generation IS NULL AND
      state = 'active'
    ) OR (
      generation > 1 AND
      previous_generation = generation - 1
    )
  ),
  CONSTRAINT ql3_ai_feature_transition_identity_check CHECK (
    length(mutation_id) BETWEEN 1 AND 128 AND
    length(request_id) BETWEEN 1 AND 128 AND
    length(changed_by_user_id) BETWEEN 1 AND 255 AND
    length(authentication_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_ai_feature_transition_digest_check CHECK (
    length(expected_migration_digest) = 64 AND
      expected_migration_digest NOT GLOB '*[^0-9a-f]*' AND
    (
      backup_evidence_digest IS NULL OR
      length(backup_evidence_digest) = 64 AND
        backup_evidence_digest NOT GLOB '*[^0-9a-f]*'
    ) AND
    length(command_digest) = 64 AND
      command_digest NOT GLOB '*[^0-9a-f]*' AND
    length(transition_digest) = 64 AND
      transition_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_ai_feature_transition_safety_shape_check CHECK (
    (
      state = 'active' AND
      (
        (
          safety_mode = 'fresh_database' AND
          backup_evidence_digest IS NULL
        ) OR (
          safety_mode = 'backup_verified' AND
          backup_evidence_digest IS NOT NULL
        )
      )
    ) OR (
      state = 'inactive' AND
      safety_mode = 'preserve_existing' AND
      backup_evidence_digest IS NULL
    )
  ),
  CONSTRAINT ql3_ai_feature_transition_json_check CHECK (
    json_valid(transition_json) AND
    json_type(transition_json) = 'object' AND
    json_extract(transition_json, '$.schema') =
      'qinglong/model-invocation-feature-transition@v1' AND
    json_extract(transition_json, '$.featureId') = feature_id AND
    json_extract(transition_json, '$.generation') = generation AND
    (
      (
        previous_generation IS NULL AND
        json_type(transition_json, '$.previousGeneration') = 'null'
      ) OR
      json_extract(transition_json, '$.previousGeneration') =
        previous_generation
    ) AND
    json_extract(transition_json, '$.state') = state AND
    json_extract(transition_json, '$.mutationId') = mutation_id AND
    json_extract(transition_json, '$.requestId') = request_id AND
    json_extract(transition_json, '$.expectedMigrationDigest') =
      expected_migration_digest AND
    json_extract(transition_json, '$.safety.mode') = safety_mode AND
    (
      (
        backup_evidence_digest IS NULL AND
        json_type(transition_json, '$.safety.backupEvidenceDigest') = 'null'
      ) OR
      json_extract(transition_json, '$.safety.backupEvidenceDigest') =
        backup_evidence_digest
    ) AND
    json_extract(transition_json, '$.changedByUserId') =
      changed_by_user_id AND
    json_extract(transition_json, '$.authenticationId') =
      authentication_id AND
    json_extract(transition_json, '$.assurance') = assurance AND
    json_extract(transition_json, '$.commandDigest') = command_digest AND
    json_extract(transition_json, '$.committedAtMs') = committed_at_ms AND
    json_extract(transition_json, '$.transitionDigest') =
      transition_digest
  )
)`;

const LOCAL_MODEL_INVOCATION_FEATURE_HEAD_TABLE_SQL = `
CREATE TABLE "ModelInvocationFeatureHead" (
  feature_id TEXT PRIMARY KEY NOT NULL
    CONSTRAINT ql3_ai_feature_head_feature_check
    CHECK (feature_id = 'model-invocation'),
  generation INTEGER NOT NULL
    CONSTRAINT ql3_ai_feature_head_generation_check
    CHECK (generation BETWEEN 1 AND 2147483647),
  state TEXT NOT NULL
    CONSTRAINT ql3_ai_feature_head_state_check
    CHECK (state IN ('active', 'inactive')),
  transition_digest TEXT NOT NULL UNIQUE,
  updated_at_ms INTEGER NOT NULL
    CONSTRAINT ql3_ai_feature_head_time_check
    CHECK (updated_at_ms >= 0),
  CONSTRAINT ql3_ai_feature_head_transition_fk
    FOREIGN KEY (feature_id, generation, transition_digest)
    REFERENCES "ModelInvocationFeatureTransitions" (
      feature_id,
      generation,
      transition_digest
    ) ON DELETE RESTRICT
)`;

const localModelInvocationFeatureActivationMigration =
  defineSqlMigration<LocalMigrationContext>(
    LOCAL_MODEL_INVOCATION_FEATURE_ACTIVATION_MIGRATION_ID,
    [
      LOCAL_MODEL_INVOCATION_FEATURE_TRANSITION_TABLE_SQL,
      `CREATE INDEX ql3_ai_feature_transition_state_idx
         ON "ModelInvocationFeatureTransitions"
         (feature_id, state, generation DESC)`,
      LOCAL_MODEL_INVOCATION_FEATURE_HEAD_TABLE_SQL,
    ],
    (context, statement) => context.client.exec(statement),
  );

export const sqliteCatalogMigrations = Object.freeze([
  localModelPriceCatalogMigration,
  localModelPriceCatalogAuthorizationMigration,
  localModelInvocationFeatureActivationMigration,
]);
