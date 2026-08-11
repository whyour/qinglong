import { defineLocalSqliteMigration } from './sqlMigration';

export const local0065ToolResultKeyCatalogMigration =
  defineLocalSqliteMigration({
    id: '0065-tool-result-key-catalog',
    statements: [
      `
CREATE TABLE "ToolResultKeyCatalogGenerations" (
  authority TEXT NOT NULL,
  generation INTEGER NOT NULL,
  previous_generation INTEGER,
  previous_catalog_digest TEXT,
  active_key_id TEXT,
  mutation_kind TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  catalog_digest TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  catalog_json TEXT NOT NULL,
  PRIMARY KEY (authority, generation),
  UNIQUE (authority, generation, catalog_digest),
  UNIQUE (mutation_id),
  UNIQUE (catalog_digest),
  CONSTRAINT ql3_tool_result_key_catalog_previous_fk
    FOREIGN KEY (
      authority, previous_generation, previous_catalog_digest
    )
    REFERENCES "ToolResultKeyCatalogGenerations" (
      authority, generation, catalog_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_result_key_catalog_authority_check CHECK (
    authority = 'trusted-tool-results'
  ),
  CONSTRAINT ql3_tool_result_key_catalog_generation_check CHECK (
    generation BETWEEN 1 AND 2147483647 AND
    (
      (
        generation = 1 AND
        previous_generation IS NULL AND
        previous_catalog_digest IS NULL AND
        mutation_kind = 'bootstrap'
      ) OR (
        generation > 1 AND
        previous_generation = generation - 1 AND
        previous_catalog_digest IS NOT NULL AND
        mutation_kind IN (
          'rotate', 'retire', 'mark_lost', 'restore'
        )
      )
    )
  ),
  CONSTRAINT ql3_tool_result_key_catalog_identity_check CHECK (
    active_key_id IS NULL OR
      length(active_key_id) BETWEEN 1 AND 128 AND
      active_key_id NOT GLOB '*[^A-Za-z0-9._-]*' AND
      substr(active_key_id, 1, 1) GLOB '[A-Za-z0-9]'
  ),
  CONSTRAINT ql3_tool_result_key_catalog_digest_check CHECK (
    (
      previous_catalog_digest IS NULL OR
      length(previous_catalog_digest) = 64 AND
        previous_catalog_digest NOT GLOB '*[^0-9a-f]*'
    ) AND
    length(catalog_digest) = 64 AND
      catalog_digest NOT GLOB '*[^0-9a-f]*' AND
    length(command_digest) = 64 AND
      command_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_tool_result_key_catalog_budget_check CHECK (
    committed_at_ms >= 0 AND
    length(mutation_id) BETWEEN 1 AND 128 AND
    length(CAST(catalog_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  CONSTRAINT ql3_tool_result_key_catalog_json_check CHECK (
    json_valid(catalog_json) AND
    json_type(catalog_json) = 'object' AND
    json_extract(catalog_json, '$.schema') =
      'qinglong/tool-result-key-catalog@v1' AND
    json_extract(catalog_json, '$.generation') = generation AND
    (
      (
        previous_catalog_digest IS NULL AND
        json_type(catalog_json, '$.previousCatalogDigest') = 'null'
      ) OR
      json_extract(catalog_json, '$.previousCatalogDigest') =
        previous_catalog_digest
    ) AND
    (
      (
        active_key_id IS NULL AND
        json_type(catalog_json, '$.activeKeyId') = 'null'
      ) OR
      json_extract(catalog_json, '$.activeKeyId') = active_key_id
    ) AND
    json_extract(catalog_json, '$.mutationKind') = mutation_kind AND
    json_extract(catalog_json, '$.mutationId') = mutation_id AND
    json_extract(catalog_json, '$.catalogDigest') = catalog_digest AND
    json_extract(catalog_json, '$.committedAtMs') = committed_at_ms AND
    json_type(catalog_json, '$.keys') = 'array' AND
    json_array_length(json_extract(catalog_json, '$.keys'))
      BETWEEN 1 AND 64
  )
)
      `,
      `CREATE INDEX ql3_tool_result_key_catalog_current_idx ON "ToolResultKeyCatalogGenerations" (authority, generation DESC)`,
      `
CREATE TABLE "ToolExecutionResultKeyBindings" (
  start_id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL UNIQUE,
  artifact_digest TEXT NOT NULL,
  catalog_authority TEXT NOT NULL,
  catalog_generation INTEGER NOT NULL,
  catalog_digest TEXT NOT NULL,
  key_id TEXT NOT NULL,
  material_proof TEXT NOT NULL,
  binding_digest TEXT NOT NULL UNIQUE,
  CONSTRAINT ql3_tool_result_key_binding_completion_fk
    FOREIGN KEY (start_id)
    REFERENCES "ToolExecutionCompletions" (start_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_result_key_binding_artifact_fk
    FOREIGN KEY (artifact_id)
    REFERENCES "ToolExecutionCompletions" (artifact_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_result_key_binding_catalog_fk
    FOREIGN KEY (
      catalog_authority, catalog_generation, catalog_digest
    )
    REFERENCES "ToolResultKeyCatalogGenerations" (
      authority, generation, catalog_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_result_key_binding_authority_check CHECK (
    catalog_authority = 'trusted-tool-results'
  ),
  CONSTRAINT ql3_tool_result_key_binding_identity_check CHECK (
    length(start_id) BETWEEN 1 AND 128 AND
    length(artifact_id) BETWEEN 1 AND 128 AND
    length(key_id) BETWEEN 1 AND 128 AND
    key_id NOT GLOB '*[^A-Za-z0-9._-]*' AND
    substr(key_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    catalog_generation BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_tool_result_key_binding_digest_check CHECK (
    length(artifact_digest) = 64 AND
      artifact_digest NOT GLOB '*[^0-9a-f]*' AND
    length(catalog_digest) = 64 AND
      catalog_digest NOT GLOB '*[^0-9a-f]*' AND
    length(material_proof) = 64 AND
      material_proof NOT GLOB '*[^0-9a-f]*' AND
    length(binding_digest) = 64 AND
      binding_digest NOT GLOB '*[^0-9a-f]*'
  )
)
      `,
      `CREATE INDEX ql3_tool_result_key_binding_catalog_idx ON "ToolExecutionResultKeyBindings" (catalog_generation, key_id, start_id)`,
    ],
  });
