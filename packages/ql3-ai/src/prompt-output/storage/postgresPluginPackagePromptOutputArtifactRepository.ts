import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';

import {
  normalizePluginPackagePromptExecutionPlan,
  type PluginPackagePromptExecutionPlan,
} from '../../prompt/pluginPackagePromptExecution';
import { PluginPackagePromptOutputKeyRetirementConflictError } from '../key-management/pluginPackagePromptOutputKeyRetirement';
import {
  InvalidPluginPackagePromptOutputArtifactError,
  MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_JSON_BYTES,
  PluginPackagePromptOutputArtifactConflictError,
  PluginPackagePromptOutputArtifactUnavailableError,
  normalizePluginPackagePromptOutputArtifact,
  type PluginPackagePromptOutputArtifact,
  type PluginPackagePromptOutputArtifactRepository,
} from '../pluginPackagePromptOutputArtifact';
import { assertPostgresPluginPackagePromptOutputKeyNotRetiring } from './postgresPluginPackagePromptOutputKeyRetirementRepository';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

const MAX_ATTEMPTS = 3;

function unavailable(
  cause?: unknown,
): PluginPackagePromptOutputArtifactUnavailableError {
  return new PluginPackagePromptOutputArtifactUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function sqlState(error: unknown): string | null {
  return error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : null;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function requiredInteger(value: unknown): number {
  const normalized =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || (normalized as number) < 0) {
    throw unavailable();
  }
  return normalized as number;
}

function requiredJson(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw unavailable();
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PluginPackagePromptOutputArtifactUnavailableError) {
      throw error;
    }
    throw unavailable(error);
  }
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
    const artifact = normalizePluginPackagePromptOutputArtifact(
      requiredJson(
        row.artifactJson,
      ) as unknown as PluginPackagePromptOutputArtifact,
    );
    if (
      artifact.artifactId !== requiredString(row.artifactId) ||
      artifact.projectId !== requiredString(row.projectId) ||
      artifact.runId !== requiredString(row.runId) ||
      artifact.stepRunId !== requiredString(row.stepRunId) ||
      artifact.invocationId !== requiredString(row.invocationId) ||
      artifact.requestedBy.type !== requiredString(row.requestedByType) ||
      artifact.requestedBy.id !== requiredString(row.requestedById) ||
      artifact.provider !== requiredString(row.provider) ||
      artifact.model !== requiredString(row.model) ||
      artifact.contentDigest !== requiredString(row.contentDigest) ||
      artifact.outputBytes !== requiredInteger(row.outputBytes) ||
      artifact.retentionPolicy.revision !==
        requiredString(row.retentionPolicyRevision) ||
      artifact.retentionPolicy.retentionMs !==
        requiredInteger(row.retentionMs) ||
      artifact.retentionPolicyDigest !==
        requiredString(row.retentionPolicyDigest) ||
      artifact.retentionEligibleAtMs !==
        requiredInteger(row.retentionEligibleAtMs) ||
      artifact.keyId !== requiredString(row.keyId) ||
      artifact.algorithm !== requiredString(row.algorithm) ||
      artifact.plaintextBytes !== requiredInteger(row.plaintextBytes) ||
      artifact.sealedAtMs !== requiredInteger(row.sealedAtMs) ||
      artifact.artifactDigest !== requiredString(row.artifactDigest)
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

export async function readPostgresPluginPackagePromptOutputArtifactInTransaction(
  queryable: Queryable,
  artifactId: string,
): Promise<Readonly<PluginPackagePromptOutputArtifact> | null> {
  const result = await queryable.query<Row>(
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
       FROM "ql3_ai"."model_invocation_prompt_output_artifacts"
      WHERE artifact_id = $1
      LIMIT 2`,
    [artifactId],
  );
  if (result.rows.length > 1) throw unavailable();
  return result.rows[0] ? parseArtifactRow(result.rows[0]) : null;
}

async function assertDurablePlan(
  client: PostgresClient,
  artifact: Readonly<PluginPackagePromptOutputArtifact>,
): Promise<void> {
  const result = await client.query<Row>(
    `SELECT plan_json AS "planJson"
       FROM "ql3_ai"."model_invocation_prompt_admissions"
      WHERE invocation_id = $1
      LIMIT 2`,
    [artifact.invocationId],
  );
  if (result.rows.length !== 1) {
    throw new PluginPackagePromptOutputArtifactConflictError();
  }
  let plan: Readonly<PluginPackagePromptExecutionPlan>;
  try {
    plan = normalizePluginPackagePromptExecutionPlan(
      requiredJson(
        result.rows[0]!.planJson,
      ) as unknown as PluginPackagePromptExecutionPlan,
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

export async function putPostgresPluginPackagePromptOutputArtifactInTransaction(
  client: PostgresClient,
  value: PluginPackagePromptOutputArtifact,
): Promise<
  Readonly<{
    status: 'inserted' | 'existing';
    artifact: Readonly<PluginPackagePromptOutputArtifact>;
  }>
> {
  const artifact = normalizePluginPackagePromptOutputArtifact(value);
  const json = serialize(artifact);
  await assertDurablePlan(client, artifact);
  await assertPostgresPluginPackagePromptOutputKeyNotRetiring(
    client,
    artifact.keyId,
  );
  const existing =
    await readPostgresPluginPackagePromptOutputArtifactInTransaction(
      client,
      artifact.artifactId,
    );
  if (existing) {
    if (JSON.stringify(existing) !== json) {
      throw new PluginPackagePromptOutputArtifactConflictError();
    }
    return Object.freeze({ status: 'existing' as const, artifact: existing });
  }
  await client.query(
    `INSERT INTO "ql3_ai"."model_invocation_prompt_output_artifacts" (
       artifact_id, project_id, run_id, step_run_id, invocation_id,
       requested_by_type, requested_by_id, provider, model,
       content_digest, output_bytes, retention_policy_revision,
       retention_ms, retention_policy_digest,
       retention_eligible_at_ms, key_id, algorithm, plaintext_bytes,
       sealed_at_ms, artifact_digest, artifact_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18, $19, $20, $21::jsonb
     )`,
    [
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
    ],
  );
  return Object.freeze({ status: 'inserted' as const, artifact });
}

export class PostgresPluginPackagePromptOutputArtifactRepository
  implements PluginPackagePromptOutputArtifactRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool !== 'object' ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw unavailable();
    }
  }

  async find(
    artifactId: string,
  ): Promise<Readonly<PluginPackagePromptOutputArtifact> | null> {
    if (
      typeof artifactId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(artifactId)
    ) {
      throw new InvalidPluginPackagePromptOutputArtifactError(
        'Artifact id is invalid',
      );
    }
    try {
      return await readPostgresPluginPackagePromptOutputArtifactInTransaction(
        this.pool,
        artifactId,
      );
    } catch (error) {
      if (
        error instanceof InvalidPluginPackagePromptOutputArtifactError ||
        error instanceof PluginPackagePromptOutputArtifactUnavailableError
      ) {
        throw error;
      }
      throw unavailable(error);
    }
  }

  async put(
    value: PluginPackagePromptOutputArtifact,
  ): Promise<Readonly<{ status: 'inserted' | 'existing' }>> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        const result =
          await putPostgresPluginPackagePromptOutputArtifactInTransaction(
            client,
            value,
          );
        await client.query('COMMIT');
        return Object.freeze({ status: result.status });
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          throw unavailable(error);
        }
        const state = sqlState(error);
        if (
          (state === '40001' || state === '40P01') &&
          attempt < MAX_ATTEMPTS
        ) {
          continue;
        }
        if (state === '23503' || state === '23505' || state === '23514') {
          const artifact = normalizePluginPackagePromptOutputArtifact(value);
          const winner =
            await readPostgresPluginPackagePromptOutputArtifactInTransaction(
              client,
              artifact.artifactId,
            );
          if (winner && JSON.stringify(winner) === JSON.stringify(artifact)) {
            return Object.freeze({ status: 'existing' as const });
          }
          throw new PluginPackagePromptOutputArtifactConflictError();
        }
        if (
          error instanceof PluginPackagePromptOutputKeyRetirementConflictError
        ) {
          throw new PluginPackagePromptOutputArtifactConflictError();
        }
        if (
          error instanceof InvalidPluginPackagePromptOutputArtifactError ||
          error instanceof PluginPackagePromptOutputArtifactConflictError ||
          error instanceof PluginPackagePromptOutputArtifactUnavailableError
        ) {
          throw error;
        }
        throw unavailable(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }
}
