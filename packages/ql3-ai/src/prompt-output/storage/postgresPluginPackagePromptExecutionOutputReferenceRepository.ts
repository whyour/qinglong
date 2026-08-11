import type { PostgresPool } from '@qinglong/runtime-core';

import {
  InvalidPluginPackagePromptExecutionOutputReadError,
  PluginPackagePromptExecutionOutputReadUnavailableError,
  normalizePluginPackagePromptExecutionOutputReference,
  normalizePluginPackagePromptExecutionOutputTarget,
  type PluginPackagePromptExecutionOutputReference,
  type PluginPackagePromptExecutionOutputReferenceRepository,
  type PluginPackagePromptExecutionOutputTarget,
} from '../pluginPackagePromptExecutionOutputRead';

type Row = Record<string, unknown>;

function unavailable(
  cause?: unknown,
): PluginPackagePromptExecutionOutputReadUnavailableError {
  return new PluginPackagePromptExecutionOutputReadUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

/** Exact-key PostgreSQL locator; it never loads Artifact ciphertext or keys. */
export class PostgresPluginPackagePromptExecutionOutputReferenceRepository
  implements PluginPackagePromptExecutionOutputReferenceRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.query !== 'function') throw unavailable();
  }

  async find(
    value: PluginPackagePromptExecutionOutputTarget,
  ): Promise<Readonly<PluginPackagePromptExecutionOutputReference> | null> {
    const target = normalizePluginPackagePromptExecutionOutputTarget(value);
    try {
      const page = await this.pool.query<Row>(
        `SELECT admission.run_id AS "runId",
                artifact.artifact_id AS "artifactId",
                artifact.artifact_digest AS "artifactDigest"
           FROM "ql3_ai"."model_invocation_prompt_admissions" AS admission
           JOIN "ql3_ai"."model_invocation_prompt_finalizations" AS finalization
             ON finalization.request_id = admission.request_id
            AND finalization.run_status = 'succeeded'
           JOIN "ql3_ai"."model_invocation_completions" AS completion
             ON completion.invocation_id = admission.invocation_id
            AND completion.outcome = 'succeeded'
           JOIN "ql3"."runs" AS run
             ON run.id = admission.run_id
            AND run.project_id = admission.project_id
            AND run.status = 'succeeded'
           JOIN "ql3"."step_runs" AS step
             ON step.run_id = admission.run_id
            AND step.id = admission.step_run_id
            AND step.status = 'succeeded'
           JOIN "ql3_ai"."model_invocation_prompt_output_artifacts" AS artifact
             ON artifact.invocation_id = admission.invocation_id
            AND artifact.project_id = admission.project_id
            AND artifact.run_id = admission.run_id
            AND artifact.step_run_id = admission.step_run_id
            AND step.output_ref = artifact.artifact_id
          WHERE admission.request_id = $1
            AND admission.project_id = $2
            AND admission.package_name = $3
            AND admission.prompt_id = $4
          LIMIT 2`,
        [
          target.executionRequestId,
          target.projectId,
          target.packageName,
          target.promptId,
        ],
      );
      if (page.rows.length > 1) throw unavailable();
      return page.rows[0]
        ? normalizePluginPackagePromptExecutionOutputReference({
            runId: text(page.rows[0], 'runId'),
            artifactId: text(page.rows[0], 'artifactId'),
            artifactDigest: text(page.rows[0], 'artifactDigest'),
          })
        : null;
    } catch (cause) {
      if (
        cause instanceof InvalidPluginPackagePromptExecutionOutputReadError ||
        cause instanceof PluginPackagePromptExecutionOutputReadUnavailableError
      ) {
        throw cause;
      }
      throw unavailable(cause);
    }
  }
}
