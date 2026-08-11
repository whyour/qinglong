import { defineLocalSqliteMigration } from './sqlMigration';

export const local0067ToolResultRekeyOverlaysMigration =
  defineLocalSqliteMigration({
    id: '0067-tool-result-rekey-overlays',
    statements: [
      `
CREATE TABLE "ToolExecutionResultRekeyOverlays" (
  overlay_id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL,
  source_binding_digest TEXT NOT NULL,
  revision INTEGER NOT NULL,
  previous_overlay_digest TEXT,
  from_key_id TEXT NOT NULL,
  target_catalog_authority TEXT NOT NULL,
  target_catalog_generation INTEGER NOT NULL,
  target_catalog_digest TEXT NOT NULL,
  target_key_id TEXT NOT NULL,
  target_material_proof TEXT NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE,
  command_digest TEXT NOT NULL,
  overlay_digest TEXT NOT NULL UNIQUE,
  rekeyed_at_ms INTEGER NOT NULL,
  overlay_json TEXT NOT NULL,
  UNIQUE (artifact_id, revision),
  UNIQUE (artifact_id, revision, overlay_digest),
  CONSTRAINT ql3_tool_result_rekey_artifact_fk
    FOREIGN KEY (artifact_id)
    REFERENCES "ToolExecutionResultKeyBindings" (artifact_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_result_rekey_binding_fk
    FOREIGN KEY (source_binding_digest)
    REFERENCES "ToolExecutionResultKeyBindings" (binding_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_result_rekey_previous_fk
    FOREIGN KEY (previous_overlay_digest)
    REFERENCES "ToolExecutionResultRekeyOverlays" (overlay_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_result_rekey_catalog_fk
    FOREIGN KEY (
      target_catalog_authority,
      target_catalog_generation,
      target_catalog_digest
    )
    REFERENCES "ToolResultKeyCatalogGenerations" (
      authority, generation, catalog_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_result_rekey_revision_check CHECK (
    revision BETWEEN 1 AND 2147483647 AND
    (
      (revision = 1 AND previous_overlay_digest IS NULL) OR
      (revision > 1 AND previous_overlay_digest IS NOT NULL)
    )
  ),
  CONSTRAINT ql3_tool_result_rekey_authority_check CHECK (
    target_catalog_authority = 'trusted-tool-results'
  ),
  CONSTRAINT ql3_tool_result_rekey_identity_check CHECK (
    length(overlay_id) BETWEEN 1 AND 128 AND
    length(artifact_id) BETWEEN 1 AND 128 AND
    length(mutation_id) BETWEEN 1 AND 128 AND
    length(from_key_id) BETWEEN 1 AND 128 AND
    from_key_id NOT GLOB '*[^A-Za-z0-9._-]*' AND
    substr(from_key_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    length(target_key_id) BETWEEN 1 AND 128 AND
    target_key_id NOT GLOB '*[^A-Za-z0-9._-]*' AND
    substr(target_key_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    from_key_id <> target_key_id AND
    target_catalog_generation BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_tool_result_rekey_digest_check CHECK (
    (
      previous_overlay_digest IS NULL OR
      length(previous_overlay_digest) = 64 AND
        previous_overlay_digest NOT GLOB '*[^0-9a-f]*'
    ) AND
    length(source_binding_digest) = 64 AND
      source_binding_digest NOT GLOB '*[^0-9a-f]*' AND
    length(target_catalog_digest) = 64 AND
      target_catalog_digest NOT GLOB '*[^0-9a-f]*' AND
    length(target_material_proof) = 64 AND
      target_material_proof NOT GLOB '*[^0-9a-f]*' AND
    length(command_digest) = 64 AND
      command_digest NOT GLOB '*[^0-9a-f]*' AND
    length(overlay_digest) = 64 AND
      overlay_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_tool_result_rekey_budget_check CHECK (
    rekeyed_at_ms >= 0 AND
    length(CAST(overlay_json AS BLOB)) BETWEEN 2 AND 393216
  ),
  CONSTRAINT ql3_tool_result_rekey_json_check CHECK (
    json_valid(overlay_json) AND
    json_type(overlay_json) = 'object' AND
    json_extract(overlay_json, '$.schema') =
      'qinglong/tool-execution-result-rekey-overlay@v1' AND
    json_extract(overlay_json, '$.overlayId') = overlay_id AND
    json_extract(overlay_json, '$.sourceArtifact.artifactId') =
      artifact_id AND
    json_extract(overlay_json, '$.sourceBindingDigest') =
      source_binding_digest AND
    json_extract(overlay_json, '$.revision') = revision AND
    (
      (
        previous_overlay_digest IS NULL AND
        json_type(overlay_json, '$.previousOverlayDigest') = 'null'
      ) OR
      json_extract(overlay_json, '$.previousOverlayDigest') =
        previous_overlay_digest
    ) AND
    json_extract(overlay_json, '$.fromKeyId') = from_key_id AND
    json_extract(overlay_json, '$.targetCatalogFence.generation') =
      target_catalog_generation AND
    json_extract(overlay_json, '$.targetCatalogFence.catalogDigest') =
      target_catalog_digest AND
    json_extract(overlay_json, '$.targetCatalogFence.keyId') =
      target_key_id AND
    json_extract(overlay_json, '$.targetCatalogFence.materialProof') =
      target_material_proof AND
    json_extract(overlay_json, '$.rekeyedAtMs') = rekeyed_at_ms AND
    json_extract(overlay_json, '$.overlayDigest') = overlay_digest
  )
)
      `,
      `CREATE INDEX ql3_tool_result_rekey_artifact_idx ON "ToolExecutionResultRekeyOverlays" (artifact_id, revision DESC)`,
      `CREATE INDEX ql3_tool_result_rekey_target_idx ON "ToolExecutionResultRekeyOverlays" (target_key_id, artifact_id, revision DESC)`,
      `
CREATE TABLE "ToolExecutionResultRekeyHeads" (
  artifact_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL,
  overlay_id TEXT NOT NULL UNIQUE,
  overlay_digest TEXT NOT NULL UNIQUE,
  target_catalog_generation INTEGER NOT NULL,
  target_catalog_digest TEXT NOT NULL,
  target_key_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CONSTRAINT ql3_tool_result_rekey_head_overlay_fk
    FOREIGN KEY (artifact_id, revision, overlay_digest)
    REFERENCES "ToolExecutionResultRekeyOverlays" (
      artifact_id, revision, overlay_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_result_rekey_head_identity_check CHECK (
    revision BETWEEN 1 AND 2147483647 AND
    length(artifact_id) BETWEEN 1 AND 128 AND
    length(overlay_id) BETWEEN 1 AND 128 AND
    length(target_key_id) BETWEEN 1 AND 128 AND
    target_key_id NOT GLOB '*[^A-Za-z0-9._-]*' AND
    substr(target_key_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    target_catalog_generation BETWEEN 1 AND 2147483647 AND
    updated_at_ms >= 0
  ),
  CONSTRAINT ql3_tool_result_rekey_head_digest_check CHECK (
    length(overlay_digest) = 64 AND
      overlay_digest NOT GLOB '*[^0-9a-f]*' AND
    length(target_catalog_digest) = 64 AND
      target_catalog_digest NOT GLOB '*[^0-9a-f]*'
  )
)
      `,
      `CREATE INDEX ql3_tool_result_rekey_head_target_idx ON "ToolExecutionResultRekeyHeads" (target_key_id, artifact_id)`,
      `
CREATE TABLE "ToolResultKeyRetirementReceipts" (
  receipt_digest TEXT PRIMARY KEY NOT NULL,
  catalog_authority TEXT NOT NULL,
  catalog_generation INTEGER NOT NULL,
  catalog_digest TEXT NOT NULL,
  key_id TEXT NOT NULL,
  material_proof TEXT NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE,
  command_digest TEXT NOT NULL,
  binding_count INTEGER NOT NULL,
  overlay_head_count INTEGER NOT NULL,
  uncovered_binding_count INTEGER NOT NULL,
  uncovered_overlay_head_count INTEGER NOT NULL,
  coverage_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  receipt_json TEXT NOT NULL,
  CONSTRAINT ql3_tool_result_key_retirement_catalog_fk
    FOREIGN KEY (
      catalog_authority, catalog_generation, catalog_digest
    )
    REFERENCES "ToolResultKeyCatalogGenerations" (
      authority, generation, catalog_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_result_key_retirement_authority_check CHECK (
    catalog_authority = 'trusted-tool-results'
  ),
  CONSTRAINT ql3_tool_result_key_retirement_identity_check CHECK (
    catalog_generation BETWEEN 1 AND 2147483647 AND
    length(key_id) BETWEEN 1 AND 128 AND
    key_id NOT GLOB '*[^A-Za-z0-9._-]*' AND
    substr(key_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    length(mutation_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_tool_result_key_retirement_count_check CHECK (
    binding_count BETWEEN 0 AND 2147483647 AND
    overlay_head_count BETWEEN 0 AND 2147483647 AND
    uncovered_binding_count = 0 AND
    uncovered_overlay_head_count = 0 AND
    created_at_ms >= 0
  ),
  CONSTRAINT ql3_tool_result_key_retirement_digest_check CHECK (
    length(receipt_digest) = 64 AND
      receipt_digest NOT GLOB '*[^0-9a-f]*' AND
    length(catalog_digest) = 64 AND
      catalog_digest NOT GLOB '*[^0-9a-f]*' AND
    length(material_proof) = 64 AND
      material_proof NOT GLOB '*[^0-9a-f]*' AND
    length(command_digest) = 64 AND
      command_digest NOT GLOB '*[^0-9a-f]*' AND
    length(coverage_digest) = 64 AND
      coverage_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_tool_result_key_retirement_json_check CHECK (
    json_valid(receipt_json) AND
    json_type(receipt_json) = 'object' AND
    json_extract(receipt_json, '$.schema') =
      'qinglong/tool-result-key-retirement-receipt@v1' AND
    json_extract(receipt_json, '$.catalogGeneration') =
      catalog_generation AND
    json_extract(receipt_json, '$.catalogDigest') = catalog_digest AND
    json_extract(receipt_json, '$.keyId') = key_id AND
    json_extract(receipt_json, '$.materialProof') = material_proof AND
    json_extract(receipt_json, '$.mutationId') = mutation_id AND
    json_extract(receipt_json, '$.bindingCount') = binding_count AND
    json_extract(receipt_json, '$.overlayHeadCount') =
      overlay_head_count AND
    json_extract(receipt_json, '$.uncoveredBindingCount') = 0 AND
    json_extract(receipt_json, '$.uncoveredOverlayHeadCount') = 0 AND
    json_extract(receipt_json, '$.coverageDigest') = coverage_digest AND
    json_extract(receipt_json, '$.createdAtMs') = created_at_ms AND
    json_extract(receipt_json, '$.receiptDigest') = receipt_digest
  )
)
      `,
      `CREATE INDEX ql3_tool_result_key_retirement_catalog_idx ON "ToolResultKeyRetirementReceipts" (catalog_generation, key_id)`,
    ],
  });
