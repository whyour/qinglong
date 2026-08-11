import type { LocalMigrationContext } from './context';

import {
  LOCAL_MODEL_PROVIDER_CREDENTIAL_CATALOG_MIGRATION_ID,
} from '../identities';

import { defineSqlMigration } from '../shared';

const LOCAL_MODEL_PROVIDER_CREDENTIAL_BINDING_TABLE_SQL = `
CREATE TABLE "ModelInvocationProviderCredentialBindings" (
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  revision TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  PRIMARY KEY (project_id, provider, revision),
  CONSTRAINT ql3_ai_local_provider_binding_identity_check CHECK (
    length(project_id) BETWEEN 1 AND 128 AND
    length(provider) BETWEEN 1 AND 128 AND
    length(revision) BETWEEN 1 AND 128 AND
    project_id NOT GLOB '*[^A-Za-z0-9._:/-]*' AND
    provider NOT GLOB '*[^A-Za-z0-9._:/-]*' AND
    revision NOT GLOB '*[^A-Za-z0-9._:/-]*'
  ),
  CONSTRAINT ql3_ai_local_provider_binding_digest_check CHECK (
    length(binding_digest) = 64 AND
    binding_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_ai_local_provider_binding_json_check CHECK (
    length(CAST(binding_json AS BLOB)) BETWEEN 2 AND 4096 AND
    json_valid(binding_json) AND json_type(binding_json) = 'object' AND
    json_extract(binding_json, '$.schema') =
      'qinglong/model-provider-credential-binding@v1' AND
    json_extract(binding_json, '$.projectId') = project_id AND
    json_extract(binding_json, '$.provider') = provider AND
    json_extract(binding_json, '$.revision') = revision AND
    json_extract(binding_json, '$.scheme') = 'bearer'
  )
)`;

const LOCAL_MODEL_PROVIDER_CREDENTIAL_TRANSITION_TABLE_SQL = `
CREATE TABLE "ModelInvocationProviderCredentialTransitions" (
  mutation_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  generation INTEGER NOT NULL,
  action TEXT NOT NULL,
  active_binding_revision TEXT,
  active_binding_digest TEXT,
  previous_transition_digest TEXT,
  changed_by_type TEXT NOT NULL,
  changed_by_id TEXT NOT NULL,
  changed_at_ms INTEGER NOT NULL,
  command_digest TEXT NOT NULL,
  transition_digest TEXT NOT NULL,
  command_json TEXT NOT NULL,
  transition_json TEXT NOT NULL,
  UNIQUE (project_id, provider, generation),
  UNIQUE (transition_digest),
  FOREIGN KEY (project_id, provider, active_binding_revision)
    REFERENCES "ModelInvocationProviderCredentialBindings"
      (project_id, provider, revision) ON DELETE RESTRICT,
  CONSTRAINT ql3_ai_local_provider_transition_identity_check CHECK (
    length(mutation_id) BETWEEN 1 AND 128 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(provider) BETWEEN 1 AND 128 AND
    length(changed_by_id) BETWEEN 1 AND 128 AND
    project_id NOT GLOB '*[^A-Za-z0-9._:/-]*' AND
    provider NOT GLOB '*[^A-Za-z0-9._:/-]*'
  ),
  CONSTRAINT ql3_ai_local_provider_transition_value_check CHECK (
    generation BETWEEN 1 AND 2147483647 AND
    action IN ('bind', 'revoke') AND
    changed_by_type = 'user' AND
    changed_at_ms >= 0 AND
    ((action = 'bind' AND active_binding_revision IS NOT NULL AND
       active_binding_digest IS NOT NULL) OR
     (action = 'revoke' AND active_binding_revision IS NULL AND
       active_binding_digest IS NULL))
  ),
  CONSTRAINT ql3_ai_local_provider_transition_digest_check CHECK (
    length(command_digest) = 64 AND command_digest NOT GLOB '*[^0-9a-f]*' AND
    length(transition_digest) = 64 AND
      transition_digest NOT GLOB '*[^0-9a-f]*' AND
    (previous_transition_digest IS NULL OR
      (length(previous_transition_digest) = 64 AND
       previous_transition_digest NOT GLOB '*[^0-9a-f]*')) AND
    (active_binding_digest IS NULL OR
      (length(active_binding_digest) = 64 AND
       active_binding_digest NOT GLOB '*[^0-9a-f]*'))
  ),
  CONSTRAINT ql3_ai_local_provider_transition_json_check CHECK (
    length(CAST(command_json AS BLOB)) BETWEEN 2 AND 8192 AND
    json_valid(command_json) AND json_type(command_json) = 'object' AND
    json_extract(command_json, '$.mutationId') = mutation_id AND
    json_extract(command_json, '$.projectId') = project_id AND
    json_extract(command_json, '$.provider') = provider AND
    json_extract(command_json, '$.action') = action AND
    length(CAST(transition_json AS BLOB)) BETWEEN 2 AND 8192 AND
    json_valid(transition_json) AND json_type(transition_json) = 'object' AND
    json_extract(transition_json, '$.schema') =
      'qinglong/model-provider-credential-transition@v1' AND
    json_extract(transition_json, '$.mutationId') = mutation_id AND
    json_extract(transition_json, '$.projectId') = project_id AND
    json_extract(transition_json, '$.provider') = provider AND
    json_extract(transition_json, '$.generation') = generation AND
    json_extract(transition_json, '$.action') = action AND
    json_extract(transition_json, '$.transitionDigest') = transition_digest
  )
)`;

const LOCAL_MODEL_PROVIDER_CREDENTIAL_AUDIT_TABLE_SQL = `
CREATE TABLE "ModelInvocationProviderCredentialAudits" (
  operation TEXT NOT NULL,
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  request_id TEXT NOT NULL,
  binding_revision TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  audit_json TEXT NOT NULL,
  PRIMARY KEY (operation, project_id, provider, request_id),
  CONSTRAINT ql3_ai_local_provider_audit_identity_check CHECK (
    operation IN ('list_models', 'generate', 'stream') AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(provider) BETWEEN 1 AND 128 AND
    length(request_id) BETWEEN 1 AND 128 AND
    length(binding_revision) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_ai_local_provider_audit_digest_check CHECK (
    length(binding_digest) = 71 AND
    binding_digest GLOB 'sha256:[0-9a-f]*' AND
    occurred_at_ms >= 0
  ),
  CONSTRAINT ql3_ai_local_provider_audit_json_check CHECK (
    length(CAST(audit_json AS BLOB)) BETWEEN 2 AND 4096 AND
    json_valid(audit_json) AND json_type(audit_json) = 'object' AND
    json_extract(audit_json, '$.schema') =
      'qinglong/model-provider-credential-audit@v1' AND
    json_extract(audit_json, '$.operation') = operation AND
    json_extract(audit_json, '$.projectId') = project_id AND
    json_extract(audit_json, '$.provider') = provider AND
    json_extract(audit_json, '$.requestId') = request_id AND
    json_extract(audit_json, '$.bindingRevision') = binding_revision AND
    json_extract(audit_json, '$.bindingDigest') = binding_digest AND
    json_extract(audit_json, '$.occurredAtMs') = occurred_at_ms
  )
)`;

const localModelProviderCredentialCatalogMigration =
  defineSqlMigration<LocalMigrationContext>(
    LOCAL_MODEL_PROVIDER_CREDENTIAL_CATALOG_MIGRATION_ID,
    [
      LOCAL_MODEL_PROVIDER_CREDENTIAL_BINDING_TABLE_SQL,
      `CREATE UNIQUE INDEX ql3_ai_local_provider_binding_digest_uidx
         ON "ModelInvocationProviderCredentialBindings" (binding_digest)`,
      LOCAL_MODEL_PROVIDER_CREDENTIAL_TRANSITION_TABLE_SQL,
      `CREATE INDEX ql3_ai_local_provider_transition_current_idx
         ON "ModelInvocationProviderCredentialTransitions"
         (project_id, provider, generation DESC)`,
      LOCAL_MODEL_PROVIDER_CREDENTIAL_AUDIT_TABLE_SQL,
      `CREATE INDEX ql3_ai_local_provider_audit_time_idx
         ON "ModelInvocationProviderCredentialAudits"
         (project_id, occurred_at_ms DESC, provider, request_id)`,
    ],
    (context, statement) => context.client.exec(statement),
  );

export const sqliteCredentialMigrations = Object.freeze([
  localModelProviderCredentialCatalogMigration,
]);
