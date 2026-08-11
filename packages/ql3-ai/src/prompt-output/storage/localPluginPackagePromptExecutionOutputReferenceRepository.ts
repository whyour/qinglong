import type { LocalModelInvocationOperationAuthority } from '../../model-invocation/localModelInvocationRepository';
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

/** Exact-key SQLite locator; it never loads Artifact ciphertext or key material. */
export class LocalPluginPackagePromptExecutionOutputReferenceRepository
  implements PluginPackagePromptExecutionOutputReferenceRepository
{
  constructor(
    private readonly authority: LocalModelInvocationOperationAuthority,
  ) {
    if (
      !authority ||
      typeof authority !== 'object' ||
      !authority.client ||
      typeof authority.enqueue !== 'function'
    ) {
      throw unavailable();
    }
  }

  find(
    value: PluginPackagePromptExecutionOutputTarget,
  ): Promise<Readonly<PluginPackagePromptExecutionOutputReference> | null> {
    const target = normalizePluginPackagePromptExecutionOutputTarget(value);
    return this.authority.enqueue(
      async () => {
        try {
          const rows = this.authority.client
            .prepare(
              `SELECT admission.run_id AS "runId",
                      artifact.artifact_id AS "artifactId",
                      artifact.artifact_digest AS "artifactDigest"
                 FROM "ModelInvocationPromptAdmissions" AS admission
                 JOIN "ModelInvocationPromptFinalizations" AS finalization
                   ON finalization.request_id = admission.request_id
                  AND finalization.run_status = 'succeeded'
                 JOIN "ModelInvocationCompletions" AS completion
                   ON completion.invocation_id = admission.invocation_id
                  AND completion.outcome = 'succeeded'
                 JOIN "Runs" AS run
                   ON run.id = admission.run_id
                  AND run.project_id = admission.project_id
                  AND run.status = 'succeeded'
                 JOIN "StepRuns" AS step
                   ON step.run_id = admission.run_id
                  AND step.id = admission.step_run_id
                  AND step.status = 'succeeded'
                 JOIN "ModelInvocationPromptOutputArtifacts" AS artifact
                   ON artifact.invocation_id = admission.invocation_id
                  AND artifact.project_id = admission.project_id
                  AND artifact.run_id = admission.run_id
                  AND artifact.step_run_id = admission.step_run_id
                  AND step.output_ref = artifact.artifact_id
                WHERE admission.request_id = ?
                  AND admission.project_id = ?
                  AND admission.package_name = ?
                  AND admission.prompt_id = ?
                LIMIT 2`,
            )
            .all(
              target.executionRequestId,
              target.projectId,
              target.packageName,
              target.promptId,
            ) as Row[];
          if (rows.length > 1) throw unavailable();
          return rows[0]
            ? normalizePluginPackagePromptExecutionOutputReference({
                runId: text(rows[0], 'runId'),
                artifactId: text(rows[0], 'artifactId'),
                artifactDigest: text(rows[0], 'artifactDigest'),
              })
            : null;
        } catch (cause) {
          if (
            cause instanceof
              InvalidPluginPackagePromptExecutionOutputReadError ||
            cause instanceof
              PluginPackagePromptExecutionOutputReadUnavailableError
          ) {
            throw cause;
          }
          throw unavailable(cause);
        }
      },
      () => unavailable(),
    );
  }
}
