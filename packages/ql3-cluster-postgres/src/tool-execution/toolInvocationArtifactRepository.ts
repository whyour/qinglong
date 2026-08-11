import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import {
  InvalidToolInvocationArtifactError,
  MAX_TOOL_INVOCATION_INPUT_ARTIFACT_JSON_BYTES,
  MAX_TOOL_INVOCATION_PREVIEW_ARTIFACT_JSON_BYTES,
  ToolInvocationArtifactConflictError,
  ToolInvocationArtifactUnavailableError,
  normalizeToolInvocationInputArtifact,
  normalizeToolInvocationPreviewArtifact,
  type ToolInvocationArtifactRepository,
  type ToolInvocationInputArtifact,
  type ToolInvocationPreviewArtifact,
} from '@qinglong/runtime-core/tool-invocation-artifact';

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;
type Queryable = Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>;

const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function unavailable(cause?: unknown): ToolInvocationArtifactUnavailableError {
  return new ToolInvocationArtifactUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function artifactId(value: unknown): string {
  if (typeof value !== 'string' || !ARTIFACT_ID_PATTERN.test(value)) {
    throw new InvalidToolInvocationArtifactError('artifact id is invalid');
  }
  return value;
}

function serialize(value: unknown, maximumBytes: number): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > maximumBytes) {
    throw new InvalidToolInvocationArtifactError(
      'durable Artifact JSON exceeds its budget',
    );
  }
  return json;
}

function mappedError(error: unknown): Error {
  if (
    error instanceof InvalidToolInvocationArtifactError ||
    error instanceof ToolInvocationArtifactConflictError ||
    error instanceof ToolInvocationArtifactUnavailableError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new ToolInvocationArtifactConflictError();
  }
  return unavailable(error);
}

function requiredString(value: unknown): string {
  return postgresRequiredString(value, unavailable);
}

function requiredInteger(value: unknown): number {
  return postgresRequiredInteger(value, unavailable);
}

export class PostgresToolInvocationArtifactRepository
  implements ToolInvocationArtifactRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL Tool invocation Artifact repository options are invalid',
      );
    }
  }

  private parseInput(row: Row): Readonly<ToolInvocationInputArtifact> {
    try {
      const artifact = normalizeToolInvocationInputArtifact(
        postgresRequiredJsonObject(
          row.artifactJson,
          unavailable,
        ) as unknown as ToolInvocationInputArtifact,
      );
      if (
        artifact.artifactId !== requiredString(row.artifactId) ||
        artifact.projectId !== requiredString(row.projectId) ||
        artifact.actionRef !== requiredString(row.actionRef) ||
        artifact.inputDigest !== requiredString(row.inputDigest) ||
        artifact.invocationActionDigest !==
          requiredString(row.invocationActionDigest) ||
        artifact.artifactDigest !== requiredString(row.artifactDigest) ||
        artifact.keyId !== requiredString(row.keyId) ||
        artifact.algorithm !== requiredString(row.algorithm) ||
        artifact.plaintextBytes !== requiredInteger(row.plaintextBytes) ||
        artifact.sealedAtMs !== requiredInteger(row.sealedAtMs) ||
        Buffer.byteLength(JSON.stringify(artifact), 'utf8') >
          MAX_TOOL_INVOCATION_INPUT_ARTIFACT_JSON_BYTES
      ) {
        throw unavailable();
      }
      return artifact;
    } catch (error) {
      if (error instanceof ToolInvocationArtifactUnavailableError) throw error;
      throw unavailable();
    }
  }

  private parsePreview(
    row: Row,
  ): Readonly<ToolInvocationPreviewArtifact> {
    try {
      const artifact = normalizeToolInvocationPreviewArtifact(
        postgresRequiredJsonObject(
          row.artifactJson,
          unavailable,
        ) as unknown as ToolInvocationPreviewArtifact,
      );
      if (
        artifact.artifactId !== requiredString(row.artifactId) ||
        artifact.projectId !== requiredString(row.projectId) ||
        artifact.actionRef !== requiredString(row.actionRef) ||
        artifact.actionDigest !== requiredString(row.actionDigest) ||
        artifact.previewDigest !== requiredString(row.previewDigest) ||
        artifact.redactionContractDigest !==
          requiredString(row.redactionContractDigest) ||
        artifact.artifactDigest !== requiredString(row.artifactDigest) ||
        artifact.byteLength !== requiredInteger(row.byteLength) ||
        artifact.sealedAtMs !== requiredInteger(row.sealedAtMs) ||
        Buffer.byteLength(JSON.stringify(artifact), 'utf8') >
          MAX_TOOL_INVOCATION_PREVIEW_ARTIFACT_JSON_BYTES
      ) {
        throw unavailable();
      }
      return artifact;
    } catch (error) {
      if (error instanceof ToolInvocationArtifactUnavailableError) throw error;
      throw unavailable();
    }
  }

  private async storedInput(
    queryable: Queryable,
    id: string,
  ): Promise<Readonly<ToolInvocationInputArtifact> | null> {
    const result = await queryable.query<Row>(
      `SELECT
         artifact_id AS "artifactId",
         project_id AS "projectId",
         action_ref AS "actionRef",
         input_digest AS "inputDigest",
         invocation_action_digest AS "invocationActionDigest",
         artifact_digest AS "artifactDigest",
         key_id AS "keyId",
         algorithm,
         plaintext_bytes AS "plaintextBytes",
         sealed_at_ms AS "sealedAtMs",
         artifact_json AS "artifactJson"
       FROM "ql3"."tool_invocation_input_artifacts"
       WHERE artifact_id = $1
       LIMIT 2`,
      [id],
    );
    if (result.rows.length > 1) throw unavailable();
    return result.rows[0] ? this.parseInput(result.rows[0]) : null;
  }

  private async storedPreview(
    queryable: Queryable,
    id: string,
  ): Promise<Readonly<ToolInvocationPreviewArtifact> | null> {
    const result = await queryable.query<Row>(
      `SELECT
         artifact_id AS "artifactId",
         project_id AS "projectId",
         action_ref AS "actionRef",
         action_digest AS "actionDigest",
         preview_digest AS "previewDigest",
         redaction_contract_digest AS "redactionContractDigest",
         artifact_digest AS "artifactDigest",
         byte_length AS "byteLength",
         sealed_at_ms AS "sealedAtMs",
         artifact_json AS "artifactJson"
       FROM "ql3"."tool_invocation_preview_artifacts"
       WHERE artifact_id = $1
       LIMIT 2`,
      [id],
    );
    if (result.rows.length > 1) throw unavailable();
    return result.rows[0] ? this.parsePreview(result.rows[0]) : null;
  }

  async put(
    inputValue: ToolInvocationInputArtifact,
    previewValue: ToolInvocationPreviewArtifact,
  ): Promise<Readonly<{ status: 'inserted' | 'existing' }>> {
    const input = normalizeToolInvocationInputArtifact(inputValue);
    const preview = normalizeToolInvocationPreviewArtifact(previewValue);
    if (
      input.projectId !== preview.projectId ||
      input.actionRef !== preview.actionRef ||
      input.sealedAtMs !== preview.sealedAtMs
    ) {
      throw new ToolInvocationArtifactConflictError();
    }
    serialize(input, MAX_TOOL_INVOCATION_INPUT_ARTIFACT_JSON_BYTES);
    serialize(preview, MAX_TOOL_INVOCATION_PREVIEW_ARTIFACT_JSON_BYTES);
    for (
      let attempt = 1;
      attempt <= POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch {
        throw unavailable();
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        const storedInput = await this.storedInput(client, input.artifactId);
        const storedPreview = await this.storedPreview(
          client,
          preview.artifactId,
        );
        if (storedInput || storedPreview) {
          if (
            !storedInput ||
            !storedPreview ||
            JSON.stringify(storedInput) !== JSON.stringify(input) ||
            JSON.stringify(storedPreview) !== JSON.stringify(preview)
          ) {
            throw new ToolInvocationArtifactConflictError();
          }
          await client.query('COMMIT');
          began = false;
          return Object.freeze({ status: 'existing' });
        }
        await client.query(
          `INSERT INTO "ql3"."tool_invocation_input_artifacts" (
             artifact_id, project_id, action_ref, input_digest,
             invocation_action_digest, artifact_digest, key_id, algorithm,
             plaintext_bytes, sealed_at_ms, artifact_json
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
           )`,
          [
            input.artifactId,
            input.projectId,
            input.actionRef,
            input.inputDigest,
            input.invocationActionDigest,
            input.artifactDigest,
            input.keyId,
            input.algorithm,
            input.plaintextBytes,
            input.sealedAtMs,
            JSON.stringify(input),
          ],
        );
        await client.query(
          `INSERT INTO "ql3"."tool_invocation_preview_artifacts" (
             artifact_id, project_id, action_ref, action_digest,
             preview_digest, redaction_contract_digest, artifact_digest,
             byte_length, sealed_at_ms, artifact_json
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
           )`,
          [
            preview.artifactId,
            preview.projectId,
            preview.actionRef,
            preview.actionDigest,
            preview.previewDigest,
            preview.redactionContractDigest,
            preview.artifactDigest,
            preview.byteLength,
            preview.sealedAtMs,
            JSON.stringify(preview),
          ],
        );
        await client.query('COMMIT');
        began = false;
        return Object.freeze({ status: 'inserted' });
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        const state = postgresSqlState(error);
        if (
          attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS &&
          state !== undefined &&
          (POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state) ||
            state === '23505')
        ) {
          continue;
        }
        throw mappedError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }

  async findInput(
    value: string,
  ): Promise<Readonly<ToolInvocationInputArtifact> | null> {
    try {
      return await this.storedInput(this.pool, artifactId(value));
    } catch (error) {
      throw mappedError(error);
    }
  }

  async findPreview(
    value: string,
  ): Promise<Readonly<ToolInvocationPreviewArtifact> | null> {
    try {
      return await this.storedPreview(this.pool, artifactId(value));
    } catch (error) {
      throw mappedError(error);
    }
  }
}
