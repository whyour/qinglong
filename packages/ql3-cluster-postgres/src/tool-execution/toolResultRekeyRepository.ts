import type {
  PostgresClient,
  PostgresPool,
  PostgresQueryable,
} from '@qinglong/runtime-core';
import {
  InvalidToolExecutionResultRekeyError,
  ToolExecutionResultRekeyConflictError,
  ToolExecutionResultRekeyUnavailableError,
  ToolResultKeyRetirementCoverageBuilder,
  createToolResultKeyRetirementReceipt,
  normalizeToolExecutionResultRekeyCommand,
  normalizeToolExecutionResultRekeyOverlay,
  normalizeToolResultKeyRetirementReceipt,
  normalizeToolResultKeyRetirementReceiptCommand,
  type CommitToolExecutionResultRekeyResult,
  type CommitToolResultKeyRetirementReceiptResult,
  type ToolExecutionResultRekeyCommand,
  type ToolExecutionResultRekeyOverlay,
  type ToolExecutionResultRekeyReader,
  type ToolExecutionResultRekeyRepository,
  type ToolResultKeyRetirementReceipt,
  type ToolResultKeyRetirementReceiptCommand,
  type ToolResultKeyRetirementReceiptRepository,
} from '@qinglong/runtime-core/tool-result-rekey';
import {
  normalizeToolResultKeyCatalogRecord,
  requireActiveToolResultKey,
  toolResultKeyCatalogFence,
  type ToolResultKeyCatalogRecord,
} from '@qinglong/runtime-core/tool-result-key-catalog';

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
type Queryable = Pick<PostgresQueryable, 'query'>;

const AUTHORITY = 'trusted-tool-results';
const CATALOG_TRANSACTION_LOCK = 'SELECT pg_advisory_xact_lock(190397473, 3)';
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COVERAGE_PAGE_SIZE = 64;

function unavailable(
  cause?: unknown,
): ToolExecutionResultRekeyUnavailableError {
  return new ToolExecutionResultRekeyUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function requiredText(row: Row, key: string): string {
  return postgresRequiredString(row[key], unavailable);
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== 'string') throw unavailable();
  return value;
}

function requiredInteger(row: Row, key: string): number {
  const value = postgresRequiredInteger(row[key], unavailable);
  if (value < 0) throw unavailable();
  return value;
}

function postgresConstraint(error: unknown): boolean {
  const state = postgresSqlState(error);
  return state === '23503' || state === '23505' || state === '23514';
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidToolExecutionResultRekeyError ||
    error instanceof ToolExecutionResultRekeyConflictError ||
    error instanceof ToolExecutionResultRekeyUnavailableError
  ) {
    return error;
  }
  return postgresConstraint(error)
    ? new ToolExecutionResultRekeyConflictError()
    : unavailable(error);
}

function overlayFromRow(
  row: Row,
): Readonly<ToolExecutionResultRekeyOverlay> {
  let overlay: Readonly<ToolExecutionResultRekeyOverlay>;
  try {
    overlay = normalizeToolExecutionResultRekeyOverlay(
      postgresRequiredJsonObject(
        row.overlayJson,
        unavailable,
      ) as unknown as ToolExecutionResultRekeyOverlay,
    );
  } catch {
    throw unavailable();
  }
  if (
    Buffer.byteLength(JSON.stringify(overlay), 'utf8') > 384 * 1024 ||
    overlay.overlayId !== requiredText(row, 'overlayId') ||
    overlay.sourceArtifact.artifactId !== requiredText(row, 'artifactId') ||
    overlay.sourceBindingDigest !== requiredText(row, 'sourceBindingDigest') ||
    overlay.revision !== requiredInteger(row, 'revision') ||
    overlay.previousOverlayDigest !== nullableText(row, 'previousOverlayDigest') ||
    overlay.fromKeyId !== requiredText(row, 'fromKeyId') ||
    overlay.targetCatalogFence.generation !==
      requiredInteger(row, 'targetCatalogGeneration') ||
    overlay.targetCatalogFence.catalogDigest !==
      requiredText(row, 'targetCatalogDigest') ||
    overlay.targetCatalogFence.keyId !== requiredText(row, 'targetKeyId') ||
    overlay.targetCatalogFence.materialProof !==
      requiredText(row, 'targetMaterialProof') ||
    overlay.overlayDigest !== requiredText(row, 'overlayDigest') ||
    overlay.rekeyedAtMs !== requiredInteger(row, 'rekeyedAtMs')
  ) {
    throw unavailable();
  }
  return overlay;
}

function receiptFromRow(
  row: Row,
): Readonly<ToolResultKeyRetirementReceipt> {
  let receipt: Readonly<ToolResultKeyRetirementReceipt>;
  try {
    receipt = normalizeToolResultKeyRetirementReceipt(
      postgresRequiredJsonObject(
        row.receiptJson,
        unavailable,
      ) as unknown as ToolResultKeyRetirementReceipt,
    );
  } catch {
    throw unavailable();
  }
  if (
    Buffer.byteLength(JSON.stringify(receipt), 'utf8') > 64 * 1024 ||
    receipt.receiptDigest !== requiredText(row, 'receiptDigest') ||
    receipt.catalogGeneration !== requiredInteger(row, 'catalogGeneration') ||
    receipt.catalogDigest !== requiredText(row, 'catalogDigest') ||
    receipt.keyId !== requiredText(row, 'keyId') ||
    receipt.materialProof !== requiredText(row, 'materialProof') ||
    receipt.mutationId !== requiredText(row, 'mutationId') ||
    receipt.bindingCount !== requiredInteger(row, 'bindingCount') ||
    receipt.overlayHeadCount !== requiredInteger(row, 'overlayHeadCount') ||
    receipt.uncoveredBindingCount !==
      requiredInteger(row, 'uncoveredBindingCount') ||
    receipt.uncoveredOverlayHeadCount !==
      requiredInteger(row, 'uncoveredOverlayHeadCount') ||
    receipt.coverageDigest !== requiredText(row, 'coverageDigest') ||
    receipt.createdAtMs !== requiredInteger(row, 'createdAtMs')
  ) {
    throw unavailable();
  }
  return receipt;
}

async function currentCatalog(
  queryable: Queryable,
): Promise<Readonly<ToolResultKeyCatalogRecord>> {
  const result = await queryable.query<Row>(
    `SELECT catalog_json AS "catalogJson"
       FROM "ql3"."tool_result_key_catalog_generations"
      WHERE authority = $1
      ORDER BY generation DESC
      LIMIT 1`,
    [AUTHORITY],
  );
  if (result.rows.length !== 1) throw unavailable();
  try {
    return normalizeToolResultKeyCatalogRecord(
      postgresRequiredJsonObject(
        result.rows[0]!.catalogJson,
        unavailable,
      ) as unknown as ToolResultKeyCatalogRecord,
    );
  } catch {
    throw unavailable();
  }
}

async function overlayRows(
  queryable: Queryable,
  suffix: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT
       overlay.overlay_id AS "overlayId",
       overlay.artifact_id AS "artifactId",
       overlay.source_binding_digest AS "sourceBindingDigest",
       overlay.revision AS "revision",
       overlay.previous_overlay_digest AS "previousOverlayDigest",
       overlay.from_key_id AS "fromKeyId",
       overlay.target_catalog_generation AS "targetCatalogGeneration",
       overlay.target_catalog_digest AS "targetCatalogDigest",
       overlay.target_key_id AS "targetKeyId",
       overlay.target_material_proof AS "targetMaterialProof",
       overlay.mutation_id AS "mutationId",
       overlay.command_digest AS "commandDigest",
       overlay.overlay_digest AS "overlayDigest",
       overlay.rekeyed_at_ms AS "rekeyedAtMs",
       overlay.overlay_json AS "overlayJson"
     FROM "ql3"."tool_execution_result_rekey_overlays" AS overlay
     ${suffix}
     ORDER BY overlay.revision DESC
     LIMIT 2`,
    values,
  );
  return result.rows;
}

async function receiptRows(
  queryable: Queryable,
  suffix: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT
       receipt_digest AS "receiptDigest",
       catalog_generation AS "catalogGeneration",
       catalog_digest AS "catalogDigest",
       key_id AS "keyId",
       material_proof AS "materialProof",
       mutation_id AS "mutationId",
       command_digest AS "commandDigest",
       binding_count AS "bindingCount",
       overlay_head_count AS "overlayHeadCount",
       uncovered_binding_count AS "uncoveredBindingCount",
       uncovered_overlay_head_count AS "uncoveredOverlayHeadCount",
       coverage_digest AS "coverageDigest",
       created_at_ms AS "createdAtMs",
       receipt_json AS "receiptJson"
     FROM "ql3"."tool_result_key_retirement_receipts"
     ${suffix}
     ORDER BY created_at_ms DESC
     LIMIT 2`,
    values,
  );
  return result.rows;
}

export class PostgresToolResultRekeyReader
  implements ToolExecutionResultRekeyReader
{
  constructor(protected readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError('PostgreSQL Tool result rekey pool is invalid');
    }
  }

  async findHeadByArtifactId(
    artifactId: string,
  ): Promise<Readonly<ToolExecutionResultRekeyOverlay> | null> {
    if (!IDENTITY_PATTERN.test(artifactId)) {
      throw new InvalidToolExecutionResultRekeyError(
        'source Artifact id is invalid',
      );
    }
    try {
      const rows = await overlayRows(
        this.pool,
        `JOIN "ql3"."tool_execution_result_rekey_heads" AS head
           ON head.artifact_id = overlay.artifact_id
          AND head.revision = overlay.revision
          AND head.overlay_digest = overlay.overlay_digest
         WHERE overlay.artifact_id = $1`,
        [artifactId],
      );
      if (rows.length > 1) throw unavailable();
      return rows[0] ? overlayFromRow(rows[0]) : null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}

export class PostgresToolResultRekeyRepository
  extends PostgresToolResultRekeyReader
  implements
    ToolExecutionResultRekeyRepository,
    ToolResultKeyRetirementReceiptRepository
{
  private async transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        throw mapStorageError(error);
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        await client.query(CATALOG_TRANSACTION_LOCK);
        const result = await work(client);
        await client.query('COMMIT');
        began = false;
        return result;
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        const state = postgresSqlState(error);
        if (
          state &&
          POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state) &&
          attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }
        throw mapStorageError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }

  append(
    commandValue: Readonly<ToolExecutionResultRekeyCommand>,
  ): Promise<Readonly<CommitToolExecutionResultRekeyResult>> {
    const command = normalizeToolExecutionResultRekeyCommand(commandValue);
    return this.transaction(async (client) => {
      const replayRows = await overlayRows(
        client,
        `WHERE overlay.mutation_id = $1
            OR overlay.overlay_id = $2
            OR overlay.overlay_digest = $3`,
        [
          command.mutationId,
          command.overlay.overlayId,
          command.overlay.overlayDigest,
        ],
      );
      if (replayRows.length > 1) {
        throw new ToolExecutionResultRekeyConflictError();
      }
      if (replayRows[0]) {
        const stored = overlayFromRow(replayRows[0]);
        if (
          requiredText(replayRows[0], 'commandDigest') !==
            command.commandDigest ||
          JSON.stringify(stored) !== JSON.stringify(command.overlay)
        ) {
          throw new ToolExecutionResultRekeyConflictError();
        }
        return Object.freeze({
          status: 'existing' as const,
          overlay: stored,
        });
      }

      const source = await client.query<Row>(
        `SELECT
           binding.artifact_digest AS "bindingArtifactDigest",
           binding.key_id AS "bindingKeyId",
           binding.binding_digest AS "bindingDigest",
           completion.artifact_digest AS "artifactDigest",
           completion.output_digest AS "outputDigest",
           completion.execution_result_digest AS "executionResultDigest"
         FROM "ql3"."tool_execution_result_key_bindings" AS binding
        JOIN "ql3"."tool_execution_completions" AS completion
           ON completion.artifact_id = binding.artifact_id
          AND completion.start_id = binding.start_id
        WHERE binding.artifact_id = $1`,
        [command.overlay.sourceArtifact.artifactId],
      );
      if (source.rows.length !== 1) {
        throw new ToolExecutionResultRekeyConflictError();
      }
      const binding = source.rows[0]!;
      if (
        requiredText(binding, 'bindingArtifactDigest') !==
          command.overlay.sourceArtifact.artifactDigest ||
        requiredText(binding, 'artifactDigest') !==
          command.overlay.sourceArtifact.artifactDigest ||
        requiredText(binding, 'outputDigest') !==
          command.overlay.sourceArtifact.outputDigest ||
        requiredText(binding, 'executionResultDigest') !==
          command.overlay.sourceArtifact.executionResultDigest ||
        requiredText(binding, 'bindingDigest') !==
          command.overlay.sourceBindingDigest
      ) {
        throw new ToolExecutionResultRekeyConflictError();
      }

      const headResult = await client.query<Row>(
        `SELECT revision, overlay_digest AS "overlayDigest",
                target_key_id AS "targetKeyId"
           FROM "ql3"."tool_execution_result_rekey_heads"
          WHERE artifact_id = $1
          FOR UPDATE`,
        [command.overlay.sourceArtifact.artifactId],
      );
      if (headResult.rows.length > 1) throw unavailable();
      const head = headResult.rows[0];
      const currentRevision = head ? requiredInteger(head, 'revision') : 0;
      const currentDigest = head ? requiredText(head, 'overlayDigest') : null;
      const fromKeyId = head
        ? requiredText(head, 'targetKeyId')
        : requiredText(binding, 'bindingKeyId');
      if (
        currentRevision !== command.expectedRevision ||
        currentDigest !== command.expectedOverlayDigest ||
        command.overlay.fromKeyId !== fromKeyId
      ) {
        throw new ToolExecutionResultRekeyConflictError();
      }

      const catalog = await currentCatalog(client);
      const active = requireActiveToolResultKey(catalog);
      const fence = toolResultKeyCatalogFence(catalog, active);
      if (
        JSON.stringify(fence) !==
        JSON.stringify(command.overlay.targetCatalogFence)
      ) {
        throw new ToolExecutionResultRekeyConflictError();
      }

      await client.query(
        `INSERT INTO "ql3"."tool_execution_result_rekey_overlays" (
           overlay_id, artifact_id, source_binding_digest, revision,
           previous_overlay_digest, from_key_id,
           target_catalog_authority, target_catalog_generation,
           target_catalog_digest, target_key_id, target_material_proof,
           mutation_id, command_digest, overlay_digest, rekeyed_at_ms,
           overlay_json
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16::jsonb
         )`,
        [
          command.overlay.overlayId,
          command.overlay.sourceArtifact.artifactId,
          command.overlay.sourceBindingDigest,
          command.overlay.revision,
          command.overlay.previousOverlayDigest,
          command.overlay.fromKeyId,
          AUTHORITY,
          fence.generation,
          fence.catalogDigest,
          fence.keyId,
          fence.materialProof,
          command.mutationId,
          command.commandDigest,
          command.overlay.overlayDigest,
          command.overlay.rekeyedAtMs,
          JSON.stringify(command.overlay),
        ],
      );
      if (head) {
        const updated = await client.query(
          `UPDATE "ql3"."tool_execution_result_rekey_heads"
              SET revision = $1, overlay_id = $2, overlay_digest = $3,
                  target_catalog_generation = $4,
                  target_catalog_digest = $5, target_key_id = $6,
                  updated_at_ms = $7
            WHERE artifact_id = $8 AND revision = $9
              AND overlay_digest = $10`,
          [
            command.overlay.revision,
            command.overlay.overlayId,
            command.overlay.overlayDigest,
            fence.generation,
            fence.catalogDigest,
            fence.keyId,
            command.overlay.rekeyedAtMs,
            command.overlay.sourceArtifact.artifactId,
            command.expectedRevision,
            command.expectedOverlayDigest,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new ToolExecutionResultRekeyConflictError();
        }
      } else {
        await client.query(
          `INSERT INTO "ql3"."tool_execution_result_rekey_heads" (
             artifact_id, revision, overlay_id, overlay_digest,
             target_catalog_generation, target_catalog_digest,
             target_key_id, updated_at_ms
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            command.overlay.sourceArtifact.artifactId,
            command.overlay.revision,
            command.overlay.overlayId,
            command.overlay.overlayDigest,
            fence.generation,
            fence.catalogDigest,
            fence.keyId,
            command.overlay.rekeyedAtMs,
          ],
        );
      }
      return Object.freeze({
        status: 'created' as const,
        overlay: command.overlay,
      });
    });
  }

  async findByDigest(
    receiptDigest: string,
  ): Promise<Readonly<ToolResultKeyRetirementReceipt> | null> {
    if (!/^[0-9a-f]{64}$/.test(receiptDigest)) {
      throw new InvalidToolExecutionResultRekeyError(
        'retirement receipt digest is invalid',
      );
    }
    try {
      const rows = await receiptRows(
        this.pool,
        'WHERE receipt_digest = $1',
        [receiptDigest],
      );
      if (rows.length > 1) throw unavailable();
      return rows[0] ? receiptFromRow(rows[0]) : null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  create(
    commandValue: Readonly<ToolResultKeyRetirementReceiptCommand>,
  ): Promise<Readonly<CommitToolResultKeyRetirementReceiptResult>> {
    const command =
      normalizeToolResultKeyRetirementReceiptCommand(commandValue);
    return this.transaction(async (client) => {
      const replayRows = await receiptRows(
        client,
        'WHERE mutation_id = $1',
        [command.mutationId],
      );
      if (replayRows.length > 1) {
        throw new ToolExecutionResultRekeyConflictError();
      }
      if (replayRows[0]) {
        const stored = receiptFromRow(replayRows[0]);
        if (
          requiredText(replayRows[0], 'commandDigest') !==
            command.commandDigest ||
          stored.catalogGeneration !== command.expectedCatalogGeneration ||
          stored.catalogDigest !== command.expectedCatalogDigest ||
          stored.keyId !== command.keyId
        ) {
          throw new ToolExecutionResultRekeyConflictError();
        }
        return Object.freeze({
          status: 'existing' as const,
          receipt: stored,
        });
      }

      const catalog = await currentCatalog(client);
      if (
        catalog.generation !== command.expectedCatalogGeneration ||
        catalog.catalogDigest !== command.expectedCatalogDigest
      ) {
        throw new ToolExecutionResultRekeyConflictError();
      }
      const retiring = catalog.keys.find(
        (entry) => entry.keyId === command.keyId,
      );
      if (!retiring || retiring.state !== 'decrypt_only') {
        throw new ToolExecutionResultRekeyConflictError();
      }
      const decryptableKeyIds = catalog.keys
        .filter(
          (entry) =>
            entry.keyId !== retiring.keyId &&
            (entry.state === 'active' || entry.state === 'decrypt_only'),
        )
        .map((entry) => entry.keyId)
        .sort();
      const coverage = new ToolResultKeyRetirementCoverageBuilder({
        catalogGeneration: catalog.generation,
        catalogDigest: catalog.catalogDigest,
        keyId: retiring.keyId,
        decryptableKeyIds,
      });
      let cursor = '';
      for (;;) {
        const page = await client.query<Row>(
          `SELECT
             binding.artifact_id AS "artifactId",
             binding.binding_digest AS "bindingDigest",
             binding.key_id AS "bindingKeyId",
             head.overlay_digest AS "headOverlayDigest",
             head.target_key_id AS "headTargetKeyId",
             head.target_catalog_generation AS "headTargetCatalogGeneration",
             head.target_catalog_digest AS "headTargetCatalogDigest"
           FROM "ql3"."tool_execution_result_key_bindings" AS binding
           LEFT JOIN "ql3"."tool_execution_result_rekey_heads" AS head
             ON head.artifact_id = binding.artifact_id
          WHERE (binding.key_id = $1 OR head.target_key_id = $1)
            AND binding.artifact_id > $2
          ORDER BY binding.artifact_id
          LIMIT $3`,
          [retiring.keyId, cursor, COVERAGE_PAGE_SIZE],
        );
        for (const row of page.rows) {
          coverage.add({
            artifactId: requiredText(row, 'artifactId'),
            bindingDigest: requiredText(row, 'bindingDigest'),
            bindingKeyId: requiredText(row, 'bindingKeyId'),
            headOverlayDigest: nullableText(row, 'headOverlayDigest'),
            headTargetKeyId: nullableText(row, 'headTargetKeyId'),
            headTargetCatalogGeneration:
              row.headTargetCatalogGeneration === null
                ? null
                : requiredInteger(row, 'headTargetCatalogGeneration'),
            headTargetCatalogDigest: nullableText(
              row,
              'headTargetCatalogDigest',
            ),
          });
        }
        if (page.rows.length < COVERAGE_PAGE_SIZE) break;
        cursor = requiredText(page.rows[page.rows.length - 1]!, 'artifactId');
      }
      const result = coverage.finish();
      if (
        result.uncoveredBindingCount !== 0 ||
        result.uncoveredOverlayHeadCount !== 0
      ) {
        throw new ToolExecutionResultRekeyConflictError();
      }
      const clock = await client.query<Row>(
        `SELECT floor(
           extract(epoch FROM clock_timestamp()) * 1000
         )::bigint AS now`,
      );
      if (clock.rows.length !== 1) throw unavailable();
      const receipt = createToolResultKeyRetirementReceipt({
        catalogGeneration: catalog.generation,
        catalogDigest: catalog.catalogDigest,
        keyId: retiring.keyId,
        materialProof: retiring.materialProof,
        mutationId: command.mutationId,
        bindingCount: result.bindingCount,
        overlayHeadCount: result.overlayHeadCount,
        coverageDigest: result.coverageDigest,
        createdAtMs: requiredInteger(clock.rows[0]!, 'now'),
      });
      await client.query(
        `INSERT INTO "ql3"."tool_result_key_retirement_receipts" (
           receipt_digest, catalog_authority, catalog_generation,
           catalog_digest, key_id, material_proof, mutation_id,
           command_digest, binding_count, overlay_head_count,
           uncovered_binding_count, uncovered_overlay_head_count,
           coverage_digest, created_at_ms, receipt_json
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, 0, $11, $12,
           $13::jsonb
         )`,
        [
          receipt.receiptDigest,
          AUTHORITY,
          receipt.catalogGeneration,
          receipt.catalogDigest,
          receipt.keyId,
          receipt.materialProof,
          receipt.mutationId,
          command.commandDigest,
          receipt.bindingCount,
          receipt.overlayHeadCount,
          receipt.coverageDigest,
          receipt.createdAtMs,
          JSON.stringify(receipt),
        ],
      );
      return Object.freeze({
        status: 'created' as const,
        receipt,
      });
    });
  }
}
