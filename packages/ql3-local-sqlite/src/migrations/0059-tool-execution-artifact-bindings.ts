import { defineLocalSqliteMigration } from './sqlMigration';

export const local0059ToolExecutionArtifactBindingsMigration =
  defineLocalSqliteMigration({
    id: '0059-tool-execution-artifact-bindings',
    statements: [
      `
CREATE UNIQUE INDEX ql3_tool_input_artifact_start_binding_uidx
ON "ToolInvocationInputArtifacts" (
  artifact_id, artifact_digest, project_id, action_ref, input_digest
)
      `,
      `
CREATE UNIQUE INDEX ql3_tool_preview_artifact_start_binding_uidx
ON "ToolInvocationPreviewArtifacts" (
  artifact_id, artifact_digest, project_id, action_ref, action_digest,
  preview_digest, redaction_contract_digest
)
      `,
      `
CREATE TABLE "ToolExecutionStartArtifactBindings" (
  start_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  action_ref TEXT NOT NULL,
  input_artifact_id TEXT NOT NULL,
  input_artifact_digest TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  preview_artifact_id TEXT NOT NULL,
  preview_artifact_digest TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  preview_digest TEXT NOT NULL,
  redaction_contract_digest TEXT NOT NULL,
  bound_at_ms INTEGER NOT NULL,
  CONSTRAINT ql3_tool_start_artifact_barrier_fk
    FOREIGN KEY (start_id)
    REFERENCES "ToolExecutionStartBarriers" (start_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_input_artifact_fk
    FOREIGN KEY (
      input_artifact_id, input_artifact_digest, project_id, action_ref,
      input_digest
    )
    REFERENCES "ToolInvocationInputArtifacts" (
      artifact_id, artifact_digest, project_id, action_ref, input_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_preview_artifact_fk
    FOREIGN KEY (
      preview_artifact_id, preview_artifact_digest, project_id, action_ref,
      action_digest, preview_digest, redaction_contract_digest
    )
    REFERENCES "ToolInvocationPreviewArtifacts" (
      artifact_id, artifact_digest, project_id, action_ref, action_digest,
      preview_digest, redaction_contract_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_start_artifact_identity_check CHECK (
    length(start_id) BETWEEN 1 AND 128 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(action_ref) BETWEEN 1 AND 255 AND
    length(input_artifact_id) BETWEEN 1 AND 128 AND
    length(preview_artifact_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_tool_start_artifact_digest_check CHECK (
    length(input_artifact_digest) = 64 AND
      input_artifact_digest NOT GLOB '*[^0-9a-f]*' AND
    length(input_digest) = 64 AND
      input_digest NOT GLOB '*[^0-9a-f]*' AND
    length(preview_artifact_digest) = 64 AND
      preview_artifact_digest NOT GLOB '*[^0-9a-f]*' AND
    length(action_digest) = 64 AND
      action_digest NOT GLOB '*[^0-9a-f]*' AND
    length(preview_digest) = 64 AND
      preview_digest NOT GLOB '*[^0-9a-f]*' AND
    length(redaction_contract_digest) = 64 AND
      redaction_contract_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_tool_start_artifact_time_check CHECK (bound_at_ms >= 0)
)
      `,
      `CREATE INDEX ql3_tool_start_artifact_input_idx ON "ToolExecutionStartArtifactBindings" (input_artifact_id, start_id)`,
      `CREATE INDEX ql3_tool_start_artifact_preview_idx ON "ToolExecutionStartArtifactBindings" (preview_artifact_id, start_id)`,
    ],
  });
