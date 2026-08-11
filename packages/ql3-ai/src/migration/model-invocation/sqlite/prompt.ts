import type { LocalMigrationContext } from './context';

import {
  LOCAL_PLUGIN_PACKAGE_PROMPT_ADMISSION_MIGRATION_ID,
  LOCAL_PLUGIN_PACKAGE_PROMPT_FINALIZATION_MIGRATION_ID,
  LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_MIGRATION_ID,
  LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_MIGRATION_ID,
  LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_MIGRATION_ID,
} from '../identities';

import { defineSqlMigration } from '../shared';

const LOCAL_PLUGIN_PACKAGE_PROMPT_ADMISSION_TABLE_SQL = `
CREATE TABLE "ModelInvocationPromptAdmissions" (
  request_id TEXT PRIMARY KEY NOT NULL,
  invocation_id TEXT NOT NULL UNIQUE,
  plan_digest TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL UNIQUE,
  step_run_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  lock_digest TEXT NOT NULL,
  generation INTEGER NOT NULL,
  generation_digest TEXT NOT NULL,
  materialized_revision_digest TEXT NOT NULL,
  publication_digest TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  prompt_definition_digest TEXT NOT NULL,
  parameter_digest TEXT NOT NULL,
  model_request_digest TEXT NOT NULL,
  admitted_at_ms INTEGER NOT NULL,
  receipt_digest TEXT NOT NULL UNIQUE,
  plan_json TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  CONSTRAINT ql3_ai_prompt_admission_run_fk
    FOREIGN KEY (run_id) REFERENCES "Runs" (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_admission_step_fk
    FOREIGN KEY (run_id, step_run_id) REFERENCES "StepRuns" (run_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_admission_publication_fk
    FOREIGN KEY (publication_digest)
    REFERENCES "QingLong3PluginPackageAutomationPublications" (
      publication_digest
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_admission_identity_check CHECK (
    length(request_id) BETWEEN 1 AND 128 AND
    length(invocation_id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    length(step_run_id) BETWEEN 1 AND 128 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(package_name) BETWEEN 1 AND 63 AND
    length(installation_id) BETWEEN 1 AND 128 AND
    length(prompt_id) BETWEEN 1 AND 128 AND
    generation BETWEEN 1 AND 2147483647 AND
    admitted_at_ms >= 0
  ),
  CONSTRAINT ql3_ai_prompt_admission_digest_check CHECK (
    length(plan_digest) = 64 AND
      plan_digest NOT GLOB '*[^0-9a-f]*' AND
    length(lock_digest) = 64 AND
      lock_digest NOT GLOB '*[^0-9a-f]*' AND
    length(generation_digest) = 64 AND
      generation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(materialized_revision_digest) = 64 AND
      materialized_revision_digest NOT GLOB '*[^0-9a-f]*' AND
    length(publication_digest) = 64 AND
      publication_digest NOT GLOB '*[^0-9a-f]*' AND
    length(prompt_definition_digest) = 64 AND
      prompt_definition_digest NOT GLOB '*[^0-9a-f]*' AND
    length(parameter_digest) = 64 AND
      parameter_digest NOT GLOB '*[^0-9a-f]*' AND
    model_request_digest GLOB 'sha256:[0-9a-f]*' AND
      length(model_request_digest) = 71 AND
      substr(model_request_digest, 8) NOT GLOB '*[^0-9a-f]*' AND
    length(receipt_digest) = 64 AND
      receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_ai_prompt_admission_plan_json_check CHECK (
    length(CAST(plan_json AS BLOB)) BETWEEN 2 AND 32768 AND
    json_valid(plan_json) AND json_type(plan_json) = 'object' AND
    json_extract(plan_json, '$.schema') =
      'qinglong/plugin-package-prompt-execution-plan@v1' AND
    json_extract(plan_json, '$.requestId') = request_id AND
    json_extract(plan_json, '$.invocationId') = invocation_id AND
    json_extract(plan_json, '$.planDigest') = plan_digest AND
    json_extract(plan_json, '$.runId') = run_id AND
    json_extract(plan_json, '$.stepRunId') = step_run_id AND
    json_extract(plan_json, '$.target.projectId') = project_id AND
    json_extract(plan_json, '$.target.packageName') = package_name AND
    json_extract(plan_json, '$.target.installationId') = installation_id AND
    json_extract(plan_json, '$.target.lockDigest') = lock_digest AND
    json_extract(plan_json, '$.target.generation') = generation AND
    json_extract(plan_json, '$.target.generationDigest') =
      generation_digest AND
    json_extract(plan_json, '$.target.materializedRevisionDigest') =
      materialized_revision_digest AND
    json_extract(plan_json, '$.target.publicationDigest') =
      publication_digest AND
    json_extract(plan_json, '$.target.promptId') = prompt_id AND
    json_extract(plan_json, '$.target.promptDefinitionDigest') =
      prompt_definition_digest AND
    json_extract(plan_json, '$.parameterDigest') = parameter_digest AND
    json_extract(plan_json, '$.modelRequestDigest') = model_request_digest AND
    json_extract(plan_json, '$.plannedAtMs') = admitted_at_ms
  ),
  CONSTRAINT ql3_ai_prompt_admission_receipt_json_check CHECK (
    length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 16384 AND
    json_valid(receipt_json) AND json_type(receipt_json) = 'object' AND
    json_extract(receipt_json, '$.schema') =
      'qinglong/plugin-package-prompt-admission-receipt@v1' AND
    json_extract(receipt_json, '$.requestId') = request_id AND
    json_extract(receipt_json, '$.invocationId') = invocation_id AND
    json_extract(receipt_json, '$.planDigest') = plan_digest AND
    json_extract(receipt_json, '$.runId') = run_id AND
    json_extract(receipt_json, '$.stepRunId') = step_run_id AND
    json_extract(receipt_json, '$.publicationDigest') =
      publication_digest AND
    json_extract(receipt_json, '$.promptId') = prompt_id AND
    json_extract(receipt_json, '$.admittedAtMs') = admitted_at_ms AND
    json_extract(receipt_json, '$.receiptDigest') = receipt_digest
  )
)`;

const localPluginPackagePromptAdmissionMigration =
  defineSqlMigration<LocalMigrationContext>(
    LOCAL_PLUGIN_PACKAGE_PROMPT_ADMISSION_MIGRATION_ID,
    [
      LOCAL_PLUGIN_PACKAGE_PROMPT_ADMISSION_TABLE_SQL,
      `CREATE UNIQUE INDEX ql3_ai_prompt_admission_run_step_uidx
         ON "ModelInvocationPromptAdmissions" (run_id, step_run_id)`,
      `CREATE INDEX ql3_ai_prompt_admission_target_idx
         ON "ModelInvocationPromptAdmissions"
         (project_id, package_name, admitted_at_ms, request_id)`,
    ],
    (context, statement) => context.client.exec(statement),
  );

const LOCAL_PLUGIN_PACKAGE_PROMPT_FINALIZATION_TABLE_SQL = `
CREATE TABLE "ModelInvocationPromptFinalizations" (
  request_id TEXT PRIMARY KEY NOT NULL,
  invocation_id TEXT NOT NULL UNIQUE,
  plan_digest TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL UNIQUE,
  step_run_id TEXT NOT NULL UNIQUE,
  terminal_evidence_kind TEXT NOT NULL,
  terminal_evidence_digest TEXT NOT NULL UNIQUE,
  final_step_run_digest TEXT NOT NULL,
  run_status TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  final_run_version INTEGER NOT NULL,
  final_run_event_sequence INTEGER NOT NULL,
  finalized_at_ms INTEGER NOT NULL,
  receipt_digest TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL,
  CONSTRAINT ql3_ai_prompt_finalization_admission_fk
    FOREIGN KEY (request_id) REFERENCES "ModelInvocationPromptAdmissions" (
      request_id
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_finalization_invocation_fk
    FOREIGN KEY (invocation_id) REFERENCES "ModelInvocationPromptAdmissions" (
      invocation_id
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_finalization_plan_fk
    FOREIGN KEY (plan_digest) REFERENCES "ModelInvocationPromptAdmissions" (
      plan_digest
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_finalization_run_fk
    FOREIGN KEY (run_id) REFERENCES "Runs" (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_finalization_step_fk
    FOREIGN KEY (run_id, step_run_id) REFERENCES "StepRuns" (run_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_finalization_event_fk
    FOREIGN KEY (event_id) REFERENCES "RunEvents" (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_finalization_identity_check CHECK (
    length(request_id) BETWEEN 1 AND 128 AND
    length(invocation_id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    length(step_run_id) BETWEEN 1 AND 128 AND
    length(event_id) BETWEEN 1 AND 128 AND
    terminal_evidence_kind IN ('completion', 'resolution') AND
    run_status IN ('succeeded', 'failed', 'cancelled', 'timed_out') AND
    final_run_version BETWEEN 3 AND 2147483647 AND
    final_run_event_sequence = final_run_version AND
    finalized_at_ms >= 0
  ),
  CONSTRAINT ql3_ai_prompt_finalization_digest_check CHECK (
    length(plan_digest) = 64 AND
      plan_digest NOT GLOB '*[^0-9a-f]*' AND
    length(terminal_evidence_digest) = 64 AND
      terminal_evidence_digest NOT GLOB '*[^0-9a-f]*' AND
    length(final_step_run_digest) = 64 AND
      final_step_run_digest NOT GLOB '*[^0-9a-f]*' AND
    length(receipt_digest) = 64 AND
      receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_ai_prompt_finalization_receipt_json_check CHECK (
    length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 16384 AND
    json_valid(receipt_json) AND json_type(receipt_json) = 'object' AND
    json_extract(receipt_json, '$.schema') =
      'qinglong/plugin-package-prompt-finalization-receipt@v1' AND
    json_extract(receipt_json, '$.requestId') = request_id AND
    json_extract(receipt_json, '$.invocationId') = invocation_id AND
    json_extract(receipt_json, '$.planDigest') = plan_digest AND
    json_extract(receipt_json, '$.runId') = run_id AND
    json_extract(receipt_json, '$.stepRunId') = step_run_id AND
    json_extract(receipt_json, '$.terminalEvidenceKind') =
      terminal_evidence_kind AND
    json_extract(receipt_json, '$.terminalEvidenceDigest') =
      terminal_evidence_digest AND
    json_extract(receipt_json, '$.finalStepRunDigest') =
      final_step_run_digest AND
    json_extract(receipt_json, '$.runStatus') = run_status AND
    json_extract(receipt_json, '$.eventId') = event_id AND
    json_extract(receipt_json, '$.finalRunVersion') = final_run_version AND
    json_extract(receipt_json, '$.finalRunEventSequence') =
      final_run_event_sequence AND
    json_extract(receipt_json, '$.finalizedAtMs') = finalized_at_ms AND
    json_extract(receipt_json, '$.receiptDigest') = receipt_digest
  )
)`;

const localPluginPackagePromptFinalizationMigration =
  defineSqlMigration<LocalMigrationContext>(
    LOCAL_PLUGIN_PACKAGE_PROMPT_FINALIZATION_MIGRATION_ID,
    [
      LOCAL_PLUGIN_PACKAGE_PROMPT_FINALIZATION_TABLE_SQL,
      `CREATE UNIQUE INDEX ql3_ai_prompt_finalization_run_step_uidx
         ON "ModelInvocationPromptFinalizations" (run_id, step_run_id)`,
      `CREATE INDEX ql3_ai_prompt_finalization_status_idx
         ON "ModelInvocationPromptFinalizations"
         (run_status, finalized_at_ms, request_id)`,
    ],
    (context, statement) => context.client.exec(statement),
  );

const LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_TABLE_SQL = `
CREATE TABLE "ModelInvocationPromptOutputArtifacts" (
  artifact_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL UNIQUE,
  requested_by_type TEXT NOT NULL,
  requested_by_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  output_bytes INTEGER NOT NULL,
  retention_policy_revision TEXT NOT NULL,
  retention_ms INTEGER NOT NULL,
  retention_policy_digest TEXT NOT NULL,
  retention_eligible_at_ms INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  plaintext_bytes INTEGER NOT NULL,
  sealed_at_ms INTEGER NOT NULL,
  artifact_digest TEXT NOT NULL UNIQUE,
  artifact_json TEXT NOT NULL,
  CONSTRAINT ql3_ai_prompt_output_artifact_admission_fk
    FOREIGN KEY (invocation_id)
    REFERENCES "ModelInvocationPromptAdmissions" (invocation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_output_artifact_start_fk
    FOREIGN KEY (invocation_id)
    REFERENCES "ModelInvocationStarts" (invocation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_output_artifact_step_fk
    FOREIGN KEY (run_id, step_run_id) REFERENCES "StepRuns" (run_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_output_artifact_identity_check CHECK (
    length(artifact_id) BETWEEN 1 AND 128 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    length(step_run_id) BETWEEN 1 AND 128 AND
    length(invocation_id) BETWEEN 1 AND 128 AND
    length(requested_by_type) BETWEEN 1 AND 32 AND
    length(requested_by_id) BETWEEN 1 AND 128 AND
    length(provider) BETWEEN 1 AND 256 AND
    length(model) BETWEEN 1 AND 256 AND
    length(retention_policy_revision) BETWEEN 1 AND 128 AND
    length(key_id) BETWEEN 1 AND 128 AND
    algorithm = 'aes-256-gcm'
  ),
  CONSTRAINT ql3_ai_prompt_output_artifact_value_check CHECK (
    output_bytes BETWEEN 0 AND 1048576 AND
    plaintext_bytes BETWEEN 1 AND 1052672 AND
    retention_ms BETWEEN 3600000 AND 31536000000 AND
    sealed_at_ms >= 0 AND
    retention_eligible_at_ms = sealed_at_ms + retention_ms AND
    length(content_digest) = 64 AND
      content_digest NOT GLOB '*[^0-9a-f]*' AND
    length(retention_policy_digest) = 64 AND
      retention_policy_digest NOT GLOB '*[^0-9a-f]*' AND
    length(artifact_digest) = 64 AND
      artifact_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_ai_prompt_output_artifact_json_check CHECK (
    length(CAST(artifact_json AS BLOB)) BETWEEN 2 AND 1572864 AND
    json_valid(artifact_json) AND json_type(artifact_json) = 'object' AND
    json_extract(artifact_json, '$.schema') =
      'qinglong/plugin-package-prompt-output-artifact@v1' AND
    json_extract(artifact_json, '$.artifactId') = artifact_id AND
    json_extract(artifact_json, '$.projectId') = project_id AND
    json_extract(artifact_json, '$.runId') = run_id AND
    json_extract(artifact_json, '$.stepRunId') = step_run_id AND
    json_extract(artifact_json, '$.invocationId') = invocation_id AND
    json_extract(artifact_json, '$.requestedBy.type') = requested_by_type AND
    json_extract(artifact_json, '$.requestedBy.id') = requested_by_id AND
    json_extract(artifact_json, '$.provider') = provider AND
    json_extract(artifact_json, '$.model') = model AND
    json_extract(artifact_json, '$.contentDigest') = content_digest AND
    json_extract(artifact_json, '$.outputBytes') = output_bytes AND
    json_extract(artifact_json, '$.retentionPolicy.revision') =
      retention_policy_revision AND
    json_extract(artifact_json, '$.retentionPolicy.retentionMs') =
      retention_ms AND
    json_extract(artifact_json, '$.retentionPolicyDigest') =
      retention_policy_digest AND
    json_extract(artifact_json, '$.retentionEligibleAtMs') =
      retention_eligible_at_ms AND
    json_extract(artifact_json, '$.keyId') = key_id AND
    json_extract(artifact_json, '$.algorithm') = algorithm AND
    json_extract(artifact_json, '$.plaintextBytes') = plaintext_bytes AND
    json_extract(artifact_json, '$.sealedAtMs') = sealed_at_ms AND
    json_extract(artifact_json, '$.artifactDigest') = artifact_digest
  )
)`;

const localPluginPackagePromptOutputArtifactMigration =
  defineSqlMigration<LocalMigrationContext>(
    LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_MIGRATION_ID,
    [
      LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_TABLE_SQL,
      `CREATE INDEX ql3_ai_prompt_output_artifact_retention_idx
         ON "ModelInvocationPromptOutputArtifacts"
         (retention_eligible_at_ms, artifact_id)`,
      `CREATE INDEX ql3_ai_prompt_output_artifact_project_run_idx
         ON "ModelInvocationPromptOutputArtifacts"
         (project_id, run_id, artifact_id)`,
    ],
    (context, statement) => context.client.exec(statement),
  );

const LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_TABLE_SQL = `
CREATE TABLE "ModelInvocationPromptOutputArtifactTombstones" (
  artifact_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_run_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL UNIQUE,
  artifact_digest TEXT NOT NULL UNIQUE,
  retention_policy_digest TEXT NOT NULL,
  retention_eligible_at_ms INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  tombstoned_at_ms INTEGER NOT NULL,
  tombstone_digest TEXT NOT NULL UNIQUE,
  tombstone_json TEXT NOT NULL,
  CONSTRAINT ql3_ai_prompt_output_tombstone_admission_fk
    FOREIGN KEY (invocation_id)
    REFERENCES "ModelInvocationPromptAdmissions" (invocation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_output_tombstone_start_fk
    FOREIGN KEY (invocation_id)
    REFERENCES "ModelInvocationStarts" (invocation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_output_tombstone_step_fk
    FOREIGN KEY (run_id, step_run_id) REFERENCES "StepRuns" (run_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_output_tombstone_identity_check CHECK (
    length(artifact_id) BETWEEN 1 AND 128 AND
    length(project_id) BETWEEN 1 AND 128 AND
    length(run_id) BETWEEN 1 AND 128 AND
    length(step_run_id) BETWEEN 1 AND 128 AND
    length(invocation_id) BETWEEN 1 AND 128 AND
    length(key_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_ai_prompt_output_tombstone_value_check CHECK (
    retention_eligible_at_ms >= 0 AND
    tombstoned_at_ms >= retention_eligible_at_ms AND
    length(artifact_digest) = 64 AND
      artifact_digest NOT GLOB '*[^0-9a-f]*' AND
    length(retention_policy_digest) = 64 AND
      retention_policy_digest NOT GLOB '*[^0-9a-f]*' AND
    length(tombstone_digest) = 64 AND
      tombstone_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_ai_prompt_output_tombstone_json_check CHECK (
    length(CAST(tombstone_json AS BLOB)) BETWEEN 2 AND 8192 AND
    json_valid(tombstone_json) AND json_type(tombstone_json) = 'object' AND
    json_extract(tombstone_json, '$.schema') =
      'qinglong/plugin-package-prompt-output-artifact-tombstone@v1' AND
    json_extract(tombstone_json, '$.reference.artifactId') = artifact_id AND
    json_extract(tombstone_json, '$.reference.projectId') = project_id AND
    json_extract(tombstone_json, '$.reference.runId') = run_id AND
    json_extract(tombstone_json, '$.reference.stepRunId') = step_run_id AND
    json_extract(tombstone_json, '$.reference.invocationId') = invocation_id AND
    json_extract(tombstone_json, '$.reference.artifactDigest') = artifact_digest AND
    json_extract(tombstone_json, '$.reference.retentionPolicyDigest') =
      retention_policy_digest AND
    json_extract(tombstone_json, '$.reference.retentionEligibleAtMs') =
      retention_eligible_at_ms AND
    json_extract(tombstone_json, '$.reference.keyId') = key_id AND
    json_extract(tombstone_json, '$.tombstonedAtMs') = tombstoned_at_ms AND
    json_extract(tombstone_json, '$.tombstoneDigest') = tombstone_digest
  )
)`;

const localPluginPackagePromptOutputTombstoneMigration =
  defineSqlMigration<LocalMigrationContext>(
    LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_MIGRATION_ID,
    [
      LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_TABLE_SQL,
      `CREATE INDEX ql3_ai_prompt_output_tombstone_time_idx
         ON "ModelInvocationPromptOutputArtifactTombstones"
         (tombstoned_at_ms, artifact_id)`,
      `CREATE INDEX ql3_ai_prompt_output_tombstone_project_run_idx
         ON "ModelInvocationPromptOutputArtifactTombstones"
         (project_id, run_id, artifact_id)`,
    ],
    (context, statement) => context.client.exec(statement),
  );

const LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_PREPARATION_TABLE_SQL = `
CREATE TABLE "ModelInvocationPromptOutputKeyRetirementPreparations" (
  key_id TEXT PRIMARY KEY NOT NULL,
  retirement_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  mutation_id TEXT NOT NULL UNIQUE,
  catalog_digest TEXT NOT NULL,
  material_proof TEXT NOT NULL,
  prepared_at_ms INTEGER NOT NULL,
  preparation_digest TEXT NOT NULL UNIQUE,
  preparation_json TEXT NOT NULL,
  CONSTRAINT ql3_ai_prompt_output_key_retirement_preparation_identity_check CHECK (
    length(key_id) BETWEEN 1 AND 128 AND
    length(retirement_id) BETWEEN 1 AND 128 AND
    length(request_id) BETWEEN 1 AND 128 AND
    length(mutation_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_ai_prompt_output_key_retirement_preparation_value_check CHECK (
    prepared_at_ms >= 0 AND
    length(catalog_digest) = 64 AND catalog_digest NOT GLOB '*[^0-9a-f]*' AND
    length(material_proof) = 64 AND material_proof NOT GLOB '*[^0-9a-f]*' AND
    length(preparation_digest) = 64 AND
      preparation_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_ai_prompt_output_key_retirement_preparation_json_check CHECK (
    length(CAST(preparation_json AS BLOB)) BETWEEN 2 AND 8192 AND
    json_valid(preparation_json) AND json_type(preparation_json) = 'object' AND
    json_extract(preparation_json, '$.schema') =
      'qinglong/plugin-package-prompt-output-key-retirement-preparation@v1' AND
    json_extract(preparation_json, '$.keyId') = key_id AND
    json_extract(preparation_json, '$.retirementId') = retirement_id AND
    json_extract(preparation_json, '$.requestId') = request_id AND
    json_extract(preparation_json, '$.mutationId') = mutation_id AND
    json_extract(preparation_json, '$.catalogDigest') = catalog_digest AND
    json_extract(preparation_json, '$.materialProof') = material_proof AND
    json_extract(preparation_json, '$.preparedAtMs') = prepared_at_ms AND
    json_extract(preparation_json, '$.preparationDigest') = preparation_digest
  )
)`;

const LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_COMPLETION_TABLE_SQL = `
CREATE TABLE "ModelInvocationPromptOutputKeyRetirementCompletions" (
  key_id TEXT PRIMARY KEY NOT NULL,
  retirement_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  mutation_id TEXT NOT NULL UNIQUE,
  preparation_digest TEXT NOT NULL UNIQUE,
  retired_catalog_digest TEXT NOT NULL,
  absence_proof TEXT NOT NULL,
  completed_at_ms INTEGER NOT NULL,
  completion_digest TEXT NOT NULL UNIQUE,
  completion_json TEXT NOT NULL,
  CONSTRAINT ql3_ai_prompt_output_key_retirement_completion_preparation_fk
    FOREIGN KEY (key_id, preparation_digest)
    REFERENCES "ModelInvocationPromptOutputKeyRetirementPreparations"
      (key_id, preparation_digest)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_ai_prompt_output_key_retirement_completion_identity_check CHECK (
    length(key_id) BETWEEN 1 AND 128 AND
    length(retirement_id) BETWEEN 1 AND 128 AND
    length(request_id) BETWEEN 1 AND 128 AND
    length(mutation_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_ai_prompt_output_key_retirement_completion_value_check CHECK (
    completed_at_ms >= 0 AND
    length(preparation_digest) = 64 AND
      preparation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(retired_catalog_digest) = 64 AND
      retired_catalog_digest NOT GLOB '*[^0-9a-f]*' AND
    length(absence_proof) = 64 AND absence_proof NOT GLOB '*[^0-9a-f]*' AND
    length(completion_digest) = 64 AND completion_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_ai_prompt_output_key_retirement_completion_json_check CHECK (
    length(CAST(completion_json AS BLOB)) BETWEEN 2 AND 8192 AND
    json_valid(completion_json) AND json_type(completion_json) = 'object' AND
    json_extract(completion_json, '$.schema') =
      'qinglong/plugin-package-prompt-output-key-retirement-completion@v1' AND
    json_extract(completion_json, '$.keyId') = key_id AND
    json_extract(completion_json, '$.retirementId') = retirement_id AND
    json_extract(completion_json, '$.requestId') = request_id AND
    json_extract(completion_json, '$.mutationId') = mutation_id AND
    json_extract(completion_json, '$.preparationDigest') = preparation_digest AND
    json_extract(completion_json, '$.retiredCatalogDigest') =
      retired_catalog_digest AND
    json_extract(completion_json, '$.absenceProof') = absence_proof AND
    json_extract(completion_json, '$.completedAtMs') = completed_at_ms AND
    json_extract(completion_json, '$.completionDigest') = completion_digest
  )
)`;

const localPluginPackagePromptOutputKeyRetirementMigration =
  defineSqlMigration<LocalMigrationContext>(
    LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_MIGRATION_ID,
    [
      LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_PREPARATION_TABLE_SQL,
      `CREATE UNIQUE INDEX ql3_ai_prompt_output_key_retirement_preparation_fk_uidx
         ON "ModelInvocationPromptOutputKeyRetirementPreparations"
         (key_id, preparation_digest)`,
      LOCAL_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_COMPLETION_TABLE_SQL,
      `CREATE INDEX ql3_ai_prompt_output_key_retirement_completion_time_idx
         ON "ModelInvocationPromptOutputKeyRetirementCompletions"
         (completed_at_ms, key_id)`,
    ],
    (context, statement) => context.client.exec(statement),
  );

export const sqlitePromptMigrations = Object.freeze([
  localPluginPackagePromptAdmissionMigration,
  localPluginPackagePromptFinalizationMigration,
  localPluginPackagePromptOutputArtifactMigration,
  localPluginPackagePromptOutputTombstoneMigration,
  localPluginPackagePromptOutputKeyRetirementMigration,
]);
