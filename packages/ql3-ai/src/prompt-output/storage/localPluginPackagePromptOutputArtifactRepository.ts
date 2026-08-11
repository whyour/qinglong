import type { DatabaseSync } from 'node:sqlite';

import { assertLocalModelInvocationFeatureActive } from '../../feature-activation/localModelInvocationFeatureActivation';
import type { LocalModelInvocationOperationAuthority } from '../../model-invocation/localModelInvocationRepository';
import {
  normalizePluginPackagePromptExecutionPlan,
  type PluginPackagePromptExecutionPlan,
} from '../../prompt/pluginPackagePromptExecution';
import {
  InvalidPluginPackagePromptOutputArtifactError,
  MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_JSON_BYTES,
  PluginPackagePromptOutputArtifactConflictError,
  PluginPackagePromptOutputArtifactUnavailableError,
  normalizePluginPackagePromptOutputArtifact,
  type PluginPackagePromptOutputArtifact,
  type PluginPackagePromptOutputArtifactRepository,
} from '../pluginPackagePromptOutputArtifact';
import { assertLocalPluginPackagePromptOutputKeyNotRetiring } from './localPluginPackagePromptOutputKeyRetirementRepository';

type Row = Record<string, unknown>;

function unavailable(
  cause?: unknown,
): PluginPackagePromptOutputArtifactUnavailableError {
  return new PluginPackagePromptOutputArtifactUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw unavailable();
  }
  return value as number;
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackagePromptOutputArtifactError ||
    error instanceof PluginPackagePromptOutputArtifactConflictError ||
    error instanceof PluginPackagePromptOutputArtifactUnavailableError
  ) {
    return error;
  }
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    (error.code.includes('CONSTRAINT') || error.code.includes('SQLITE_BUSY'))
  ) {
    return error.code.includes('CONSTRAINT')
      ? new PluginPackagePromptOutputArtifactConflictError()
      : unavailable(error);
  }
  return unavailable(error);
}

function serialize(value: PluginPackagePromptOutputArtifact): string {
  const json = JSON.stringify(value);
  if (
    Buffer.byteLength(json, 'utf8') >
    MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_JSON_BYTES
  ) {
    throw new InvalidPluginPackagePromptOutputArtifactError(
      'durable Artifact JSON exceeds its budget',
    );
  }
  return json;
}

function parseArtifactRow(
  row: Row,
): Readonly<PluginPackagePromptOutputArtifact> {
  try {
    const json = text(row, 'artifactJson');
    if (
      Buffer.byteLength(json, 'utf8') >
      MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_JSON_BYTES
    ) {
      throw unavailable();
    }
    const artifact = normalizePluginPackagePromptOutputArtifact(
      JSON.parse(json) as PluginPackagePromptOutputArtifact,
    );
    if (
      artifact.artifactId !== text(row, 'artifactId') ||
      artifact.projectId !== text(row, 'projectId') ||
      artifact.runId !== text(row, 'runId') ||
      artifact.stepRunId !== text(row, 'stepRunId') ||
      artifact.invocationId !== text(row, 'invocationId') ||
      artifact.requestedBy.type !== text(row, 'requestedByType') ||
      artifact.requestedBy.id !== text(row, 'requestedById') ||
      artifact.provider !== text(row, 'provider') ||
      artifact.model !== text(row, 'model') ||
      artifact.contentDigest !== text(row, 'contentDigest') ||
      artifact.outputBytes !== integer(row, 'outputBytes') ||
      artifact.retentionPolicy.revision !==
        text(row, 'retentionPolicyRevision') ||
      artifact.retentionPolicy.retentionMs !== integer(row, 'retentionMs') ||
      artifact.retentionPolicyDigest !== text(row, 'retentionPolicyDigest') ||
      artifact.retentionEligibleAtMs !==
        integer(row, 'retentionEligibleAtMs') ||
      artifact.keyId !== text(row, 'keyId') ||
      artifact.algorithm !== text(row, 'algorithm') ||
      artifact.plaintextBytes !== integer(row, 'plaintextBytes') ||
      artifact.sealedAtMs !== integer(row, 'sealedAtMs') ||
      artifact.artifactDigest !== text(row, 'artifactDigest') ||
      JSON.stringify(artifact) !== json
    ) {
      throw unavailable();
    }
    return artifact;
  } catch (error) {
    if (error instanceof PluginPackagePromptOutputArtifactUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
}

export function readLocalPluginPackagePromptOutputArtifactInTransaction(
  client: DatabaseSync,
  artifactId: string,
): Readonly<PluginPackagePromptOutputArtifact> | null {
  const rows = client
    .prepare(
      `SELECT artifact_id AS "artifactId", project_id AS "projectId",
              run_id AS "runId", step_run_id AS "stepRunId",
              invocation_id AS "invocationId",
              requested_by_type AS "requestedByType",
              requested_by_id AS "requestedById", provider, model,
              content_digest AS "contentDigest",
              output_bytes AS "outputBytes",
              retention_policy_revision AS "retentionPolicyRevision",
              retention_ms AS "retentionMs",
              retention_policy_digest AS "retentionPolicyDigest",
              retention_eligible_at_ms AS "retentionEligibleAtMs",
              key_id AS "keyId", algorithm,
              plaintext_bytes AS "plaintextBytes",
              sealed_at_ms AS "sealedAtMs",
              artifact_digest AS "artifactDigest",
              artifact_json AS "artifactJson"
         FROM "ModelInvocationPromptOutputArtifacts"
        WHERE artifact_id = ?
        LIMIT 2`,
    )
    .all(artifactId) as Row[];
  if (rows.length > 1) throw unavailable();
  return rows[0] ? parseArtifactRow(rows[0]) : null;
}

function assertDurablePlan(
  client: DatabaseSync,
  artifact: Readonly<PluginPackagePromptOutputArtifact>,
): void {
  const rows = client
    .prepare(
      `SELECT plan_json AS "planJson"
         FROM "ModelInvocationPromptAdmissions"
        WHERE invocation_id = ?
        LIMIT 2`,
    )
    .all(artifact.invocationId) as Row[];
  if (rows.length !== 1) {
    throw new PluginPackagePromptOutputArtifactConflictError();
  }
  let plan: Readonly<PluginPackagePromptExecutionPlan>;
  try {
    plan = normalizePluginPackagePromptExecutionPlan(
      JSON.parse(
        text(rows[0]!, 'planJson'),
      ) as PluginPackagePromptExecutionPlan,
    );
  } catch (error) {
    throw unavailable(error);
  }
  if (
    plan.output?.mode !== 'durable_artifact' ||
    plan.output.retentionPolicyDigest !== artifact.retentionPolicyDigest ||
    JSON.stringify(plan.output.retentionPolicy) !==
      JSON.stringify(artifact.retentionPolicy) ||
    plan.target.projectId !== artifact.projectId ||
    plan.runId !== artifact.runId ||
    plan.stepRunId !== artifact.stepRunId ||
    plan.invocationId !== artifact.invocationId ||
    plan.requestedBySubject.type !== artifact.requestedBy.type ||
    plan.requestedBySubject.id !== artifact.requestedBy.id ||
    plan.provider !== artifact.provider ||
    plan.model !== artifact.model
  ) {
    throw new PluginPackagePromptOutputArtifactConflictError();
  }
}

export function putLocalPluginPackagePromptOutputArtifactInTransaction(
  client: DatabaseSync,
  value: PluginPackagePromptOutputArtifact,
): Readonly<{
  status: 'inserted' | 'existing';
  artifact: Readonly<PluginPackagePromptOutputArtifact>;
}> {
  const artifact = normalizePluginPackagePromptOutputArtifact(value);
  const json = serialize(artifact);
  assertLocalModelInvocationFeatureActive(client);
  assertDurablePlan(client, artifact);
  assertLocalPluginPackagePromptOutputKeyNotRetiring(client, artifact.keyId);
  const existing = readLocalPluginPackagePromptOutputArtifactInTransaction(
    client,
    artifact.artifactId,
  );
  if (existing) {
    if (JSON.stringify(existing) !== json) {
      throw new PluginPackagePromptOutputArtifactConflictError();
    }
    return Object.freeze({ status: 'existing' as const, artifact: existing });
  }
  client
    .prepare(
      `INSERT INTO "ModelInvocationPromptOutputArtifacts" (
         artifact_id, project_id, run_id, step_run_id, invocation_id,
         requested_by_type, requested_by_id, provider, model,
         content_digest, output_bytes, retention_policy_revision,
         retention_ms, retention_policy_digest,
         retention_eligible_at_ms, key_id, algorithm, plaintext_bytes,
         sealed_at_ms, artifact_digest, artifact_json
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`,
    )
    .run(
      artifact.artifactId,
      artifact.projectId,
      artifact.runId,
      artifact.stepRunId,
      artifact.invocationId,
      artifact.requestedBy.type,
      artifact.requestedBy.id,
      artifact.provider,
      artifact.model,
      artifact.contentDigest,
      artifact.outputBytes,
      artifact.retentionPolicy.revision,
      artifact.retentionPolicy.retentionMs,
      artifact.retentionPolicyDigest,
      artifact.retentionEligibleAtMs,
      artifact.keyId,
      artifact.algorithm,
      artifact.plaintextBytes,
      artifact.sealedAtMs,
      artifact.artifactDigest,
      json,
    );
  return Object.freeze({ status: 'inserted' as const, artifact });
}

export class LocalPluginPackagePromptOutputArtifactRepository
  implements PluginPackagePromptOutputArtifactRepository
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

  private enqueue<T>(work: (client: DatabaseSync) => T): Promise<T> {
    return this.authority.enqueue(
      async () => {
        try {
          return work(this.authority.client);
        } catch (error) {
          throw mapStorageError(error);
        }
      },
      () => unavailable(),
    );
  }

  find(
    artifactId: string,
  ): Promise<Readonly<PluginPackagePromptOutputArtifact> | null> {
    if (
      typeof artifactId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(artifactId)
    ) {
      return Promise.reject(
        new InvalidPluginPackagePromptOutputArtifactError(
          'Artifact id is invalid',
        ),
      );
    }
    return this.enqueue((client) =>
      readLocalPluginPackagePromptOutputArtifactInTransaction(
        client,
        artifactId,
      ),
    );
  }

  put(
    value: PluginPackagePromptOutputArtifact,
  ): Promise<Readonly<{ status: 'inserted' | 'existing' }>> {
    return this.enqueue((client) => {
      client.exec('BEGIN IMMEDIATE');
      try {
        const result = putLocalPluginPackagePromptOutputArtifactInTransaction(
          client,
          value,
        );
        client.exec('COMMIT');
        return Object.freeze({ status: result.status });
      } catch (error) {
        try {
          client.exec('ROLLBACK');
        } catch {
          throw unavailable(error);
        }
        throw error;
      }
    });
  }
}
