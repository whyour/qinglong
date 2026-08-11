import { defineLocalSqliteMigration } from './sqlMigration';

export const local0057ToolInvocationArtifactsMigration =
  defineLocalSqliteMigration({
    id: '0057-tool-invocation-artifacts',
    statements: [
      `
CREATE TABLE "ToolInvocationInputArtifacts" (
  artifact_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  action_ref TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  invocation_action_digest TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  key_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  plaintext_bytes INTEGER NOT NULL,
  sealed_at_ms INTEGER NOT NULL,
  artifact_json TEXT NOT NULL,
  CONSTRAINT ql3_tool_input_artifact_project_fk
    FOREIGN KEY (project_id)
    REFERENCES "QingLong3Projects" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_input_artifact_identity_check CHECK (
    length(artifact_id) BETWEEN 1 AND 128 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(action_ref) BETWEEN 1 AND 255 AND
    length(key_id) BETWEEN 1 AND 128 AND
    algorithm = 'aes-256-gcm'
  ),
  CONSTRAINT ql3_tool_input_artifact_digest_check CHECK (
    length(input_digest) = 64 AND
      input_digest NOT GLOB '*[^0-9a-f]*' AND
    length(invocation_action_digest) = 64 AND
      invocation_action_digest NOT GLOB '*[^0-9a-f]*' AND
    length(artifact_digest) = 64 AND
      artifact_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_tool_input_artifact_budget_check CHECK (
    plaintext_bytes BETWEEN 0 AND 65536 AND sealed_at_ms >= 0
  ),
  CONSTRAINT ql3_tool_input_artifact_json_check CHECK (
    length(CAST(artifact_json AS BLOB)) BETWEEN 2 AND 98304 AND
    json_valid(artifact_json) AND json_type(artifact_json) = 'object' AND
    json_extract(artifact_json, '$.schema') =
      'qinglong/tool-invocation-input-artifact@v1' AND
    json_extract(artifact_json, '$.artifactId') = artifact_id AND
    json_extract(artifact_json, '$.projectId') = project_id AND
    json_extract(artifact_json, '$.actionRef') = action_ref AND
    json_extract(artifact_json, '$.inputDigest') = input_digest AND
    json_extract(artifact_json, '$.invocationActionDigest') =
      invocation_action_digest AND
    json_extract(artifact_json, '$.artifactDigest') = artifact_digest AND
    json_extract(artifact_json, '$.keyId') = key_id AND
    json_extract(artifact_json, '$.algorithm') = algorithm AND
    json_extract(artifact_json, '$.plaintextBytes') IS plaintext_bytes AND
    json_extract(artifact_json, '$.sealedAtMs') IS sealed_at_ms
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_tool_input_artifact_action_uidx ON "ToolInvocationInputArtifacts" (project_id, action_ref)`,
      `CREATE INDEX ql3_tool_input_artifact_project_time_idx ON "ToolInvocationInputArtifacts" (project_id, sealed_at_ms, artifact_id)`,
      `
CREATE TABLE "ToolInvocationPreviewArtifacts" (
  artifact_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  action_ref TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  preview_digest TEXT NOT NULL,
  redaction_contract_digest TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  sealed_at_ms INTEGER NOT NULL,
  artifact_json TEXT NOT NULL,
  CONSTRAINT ql3_tool_preview_artifact_project_fk
    FOREIGN KEY (project_id)
    REFERENCES "QingLong3Projects" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_preview_artifact_identity_check CHECK (
    length(artifact_id) BETWEEN 1 AND 128 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(action_ref) BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_tool_preview_artifact_digest_check CHECK (
    length(action_digest) = 64 AND
      action_digest NOT GLOB '*[^0-9a-f]*' AND
    length(preview_digest) = 64 AND
      preview_digest NOT GLOB '*[^0-9a-f]*' AND
    length(redaction_contract_digest) = 64 AND
      redaction_contract_digest NOT GLOB '*[^0-9a-f]*' AND
    length(artifact_digest) = 64 AND
      artifact_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_tool_preview_artifact_budget_check CHECK (
    byte_length BETWEEN 2 AND 8192 AND sealed_at_ms >= 0
  ),
  CONSTRAINT ql3_tool_preview_artifact_json_check CHECK (
    length(CAST(artifact_json AS BLOB)) BETWEEN 2 AND 16384 AND
    json_valid(artifact_json) AND json_type(artifact_json) = 'object' AND
    json_extract(artifact_json, '$.schema') =
      'qinglong/tool-invocation-preview-artifact@v1' AND
    json_extract(artifact_json, '$.artifactId') = artifact_id AND
    json_extract(artifact_json, '$.projectId') = project_id AND
    json_extract(artifact_json, '$.actionRef') = action_ref AND
    json_extract(artifact_json, '$.actionDigest') = action_digest AND
    json_extract(artifact_json, '$.previewDigest') = preview_digest AND
    json_extract(artifact_json, '$.redactionContractDigest') =
      redaction_contract_digest AND
    json_extract(artifact_json, '$.artifactDigest') = artifact_digest AND
    json_extract(artifact_json, '$.byteLength') IS byte_length AND
    json_extract(artifact_json, '$.sealedAtMs') IS sealed_at_ms
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_tool_preview_artifact_action_uidx ON "ToolInvocationPreviewArtifacts" (project_id, action_ref)`,
      `CREATE UNIQUE INDEX ql3_tool_preview_artifact_action_digest_uidx ON "ToolInvocationPreviewArtifacts" (action_digest)`,
      `CREATE INDEX ql3_tool_preview_artifact_project_time_idx ON "ToolInvocationPreviewArtifacts" (project_id, sealed_at_ms, artifact_id)`,
    ],
  });
