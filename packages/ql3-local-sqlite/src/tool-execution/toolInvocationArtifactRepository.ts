import type { DatabaseSync } from 'node:sqlite';

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

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

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

function serialize(value: unknown, maximumBytes: number): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > maximumBytes) {
    throw new InvalidToolInvocationArtifactError(
      'durable Artifact JSON exceeds its budget',
    );
  }
  return json;
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidToolInvocationArtifactError ||
    error instanceof ToolInvocationArtifactConflictError ||
    error instanceof ToolInvocationArtifactUnavailableError
  ) {
    return error;
  }
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  ) {
    return new ToolInvocationArtifactConflictError();
  }
  return unavailable(error);
}

export class LocalSqliteToolInvocationArtifactRepository
  implements ToolInvocationArtifactRepository
{
  private readonly authority: LocalSqliteOperationAuthority;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
  }

  private enqueue<T>(work: () => T): Promise<T> {
    return this.authority.enqueue(
      async () => {
        try {
          return work();
        } catch (error) {
          throw mapStorageError(error);
        }
      },
      () => unavailable(),
    );
  }

  private parseInput(row: Row): Readonly<ToolInvocationInputArtifact> {
    try {
      const json = text(row, 'artifactJson');
      if (
        Buffer.byteLength(json, 'utf8') >
        MAX_TOOL_INVOCATION_INPUT_ARTIFACT_JSON_BYTES
      ) {
        throw unavailable();
      }
      const artifact = normalizeToolInvocationInputArtifact(
        JSON.parse(json) as ToolInvocationInputArtifact,
      );
      if (
        artifact.artifactId !== text(row, 'artifactId') ||
        artifact.projectId !== text(row, 'projectId') ||
        artifact.actionRef !== text(row, 'actionRef') ||
        artifact.inputDigest !== text(row, 'inputDigest') ||
        artifact.invocationActionDigest !==
          text(row, 'invocationActionDigest') ||
        artifact.artifactDigest !== text(row, 'artifactDigest') ||
        artifact.keyId !== text(row, 'keyId') ||
        artifact.algorithm !== text(row, 'algorithm') ||
        artifact.plaintextBytes !== integer(row, 'plaintextBytes') ||
        artifact.sealedAtMs !== integer(row, 'sealedAtMs') ||
        JSON.stringify(artifact) !== json
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
      const json = text(row, 'artifactJson');
      if (
        Buffer.byteLength(json, 'utf8') >
        MAX_TOOL_INVOCATION_PREVIEW_ARTIFACT_JSON_BYTES
      ) {
        throw unavailable();
      }
      const artifact = normalizeToolInvocationPreviewArtifact(
        JSON.parse(json) as ToolInvocationPreviewArtifact,
      );
      if (
        artifact.artifactId !== text(row, 'artifactId') ||
        artifact.projectId !== text(row, 'projectId') ||
        artifact.actionRef !== text(row, 'actionRef') ||
        artifact.actionDigest !== text(row, 'actionDigest') ||
        artifact.previewDigest !== text(row, 'previewDigest') ||
        artifact.redactionContractDigest !==
          text(row, 'redactionContractDigest') ||
        artifact.artifactDigest !== text(row, 'artifactDigest') ||
        artifact.byteLength !== integer(row, 'byteLength') ||
        artifact.sealedAtMs !== integer(row, 'sealedAtMs') ||
        JSON.stringify(artifact) !== json
      ) {
        throw unavailable();
      }
      return artifact;
    } catch (error) {
      if (error instanceof ToolInvocationArtifactUnavailableError) throw error;
      throw unavailable();
    }
  }

  private storedInput(
    id: string,
  ): Readonly<ToolInvocationInputArtifact> | null {
    const row = this.authority.client
      .prepare(
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
         FROM "ToolInvocationInputArtifacts"
         WHERE artifact_id = ?
         LIMIT 2`,
      )
      .all(id) as Row[];
    if (row.length > 1) throw unavailable();
    return row[0] ? this.parseInput(row[0]) : null;
  }

  private storedPreview(
    id: string,
  ): Readonly<ToolInvocationPreviewArtifact> | null {
    const row = this.authority.client
      .prepare(
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
         FROM "ToolInvocationPreviewArtifacts"
         WHERE artifact_id = ?
         LIMIT 2`,
      )
      .all(id) as Row[];
    if (row.length > 1) throw unavailable();
    return row[0] ? this.parsePreview(row[0]) : null;
  }

  put(
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
      return Promise.reject(new ToolInvocationArtifactConflictError());
    }
    const inputJson = serialize(
      input,
      MAX_TOOL_INVOCATION_INPUT_ARTIFACT_JSON_BYTES,
    );
    const previewJson = serialize(
      preview,
      MAX_TOOL_INVOCATION_PREVIEW_ARTIFACT_JSON_BYTES,
    );
    return this.enqueue(() => {
      const client = this.authority.client;
      client.exec('BEGIN IMMEDIATE');
      try {
        const storedInput = this.storedInput(input.artifactId);
        const storedPreview = this.storedPreview(preview.artifactId);
        if (storedInput || storedPreview) {
          if (
            !storedInput ||
            !storedPreview ||
            JSON.stringify(storedInput) !== inputJson ||
            JSON.stringify(storedPreview) !== previewJson
          ) {
            throw new ToolInvocationArtifactConflictError();
          }
          client.exec('COMMIT');
          return Object.freeze({ status: 'existing' as const });
        }
        client
          .prepare(
            `INSERT INTO "ToolInvocationInputArtifacts" (
               artifact_id, project_id, action_ref, input_digest,
               invocation_action_digest, artifact_digest, key_id, algorithm,
               plaintext_bytes, sealed_at_ms, artifact_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
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
            inputJson,
          );
        client
          .prepare(
            `INSERT INTO "ToolInvocationPreviewArtifacts" (
               artifact_id, project_id, action_ref, action_digest,
               preview_digest, redaction_contract_digest, artifact_digest,
               byte_length, sealed_at_ms, artifact_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            preview.artifactId,
            preview.projectId,
            preview.actionRef,
            preview.actionDigest,
            preview.previewDigest,
            preview.redactionContractDigest,
            preview.artifactDigest,
            preview.byteLength,
            preview.sealedAtMs,
            previewJson,
          );
        client.exec('COMMIT');
        return Object.freeze({ status: 'inserted' as const });
      } catch (error) {
        try {
          client.exec('ROLLBACK');
        } catch {
          throw unavailable();
        }
        throw error;
      }
    });
  }

  findInput(
    value: string,
  ): Promise<Readonly<ToolInvocationInputArtifact> | null> {
    const id = artifactId(value);
    return this.enqueue(() => this.storedInput(id));
  }

  findPreview(
    value: string,
  ): Promise<Readonly<ToolInvocationPreviewArtifact> | null> {
    const id = artifactId(value);
    return this.enqueue(() => this.storedPreview(id));
  }
}
