import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

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

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;
const AUTHORITY = 'trusted-tool-results';

function unavailable(
  cause?: unknown,
): ToolExecutionResultRekeyUnavailableError {
  return new ToolExecutionResultRekeyUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function sqliteConstraint(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const number = (error as { errcode?: unknown }).errcode;
  return (
    (typeof code === 'string' && code.startsWith('ERR_SQLITE_CONSTRAINT')) ||
    (typeof number === 'number' && (number & 0xff) === 19)
  );
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidToolExecutionResultRekeyError ||
    error instanceof ToolExecutionResultRekeyConflictError ||
    error instanceof ToolExecutionResultRekeyUnavailableError
  ) {
    return error;
  }
  return sqliteConstraint(error)
    ? new ToolExecutionResultRekeyConflictError()
    : unavailable(error);
}

function requiredText(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== 'string') throw unavailable();
  return value;
}

function requiredInteger(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw unavailable();
  }
  return value as number;
}

function parseJson(row: Row, key: string, budget: number): unknown {
  const value = requiredText(row, key);
  if (Buffer.byteLength(value, 'utf8') > budget) throw unavailable();
  try {
    return JSON.parse(value);
  } catch {
    throw unavailable();
  }
}

function overlayFromRow(row: Row): Readonly<ToolExecutionResultRekeyOverlay> {
  let overlay: Readonly<ToolExecutionResultRekeyOverlay>;
  try {
    overlay = normalizeToolExecutionResultRekeyOverlay(
      parseJson(
        row,
        'overlayJson',
        384 * 1024,
      ) as ToolExecutionResultRekeyOverlay,
    );
  } catch {
    throw unavailable();
  }
  if (
    overlay.overlayId !== requiredText(row, 'overlayId') ||
    overlay.sourceArtifact.artifactId !== requiredText(row, 'artifactId') ||
    overlay.sourceBindingDigest !== requiredText(row, 'sourceBindingDigest') ||
    overlay.revision !== requiredInteger(row, 'revision') ||
    overlay.previousOverlayDigest !==
      nullableText(row, 'previousOverlayDigest') ||
    overlay.fromKeyId !== requiredText(row, 'fromKeyId') ||
    overlay.targetCatalogFence.generation !==
      requiredInteger(row, 'targetCatalogGeneration') ||
    overlay.targetCatalogFence.catalogDigest !==
      requiredText(row, 'targetCatalogDigest') ||
    overlay.targetCatalogFence.keyId !== requiredText(row, 'targetKeyId') ||
    overlay.targetCatalogFence.materialProof !==
      requiredText(row, 'targetMaterialProof') ||
    overlay.overlayDigest !== requiredText(row, 'overlayDigest') ||
    overlay.rekeyedAtMs !== requiredInteger(row, 'rekeyedAtMs') ||
    JSON.stringify(overlay) !== requiredText(row, 'overlayJson')
  ) {
    throw unavailable();
  }
  return overlay;
}

function receiptFromRow(row: Row): Readonly<ToolResultKeyRetirementReceipt> {
  let receipt: Readonly<ToolResultKeyRetirementReceipt>;
  try {
    receipt = normalizeToolResultKeyRetirementReceipt(
      parseJson(
        row,
        'receiptJson',
        64 * 1024,
      ) as ToolResultKeyRetirementReceipt,
    );
  } catch {
    throw unavailable();
  }
  if (
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
    receipt.createdAtMs !== requiredInteger(row, 'createdAtMs') ||
    JSON.stringify(receipt) !== requiredText(row, 'receiptJson')
  ) {
    throw unavailable();
  }
  return receipt;
}

export class LocalSqliteToolResultRekeyRepository
  implements
    ToolExecutionResultRekeyRepository,
    ToolResultKeyRetirementReceiptRepository
{
  private readonly authority: LocalSqliteOperationAuthority;
  private readonly client: DatabaseSync;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
    this.client = this.authority.client;
  }

  private enqueue<T>(work: () => T): Promise<T> {
    return this.authority.enqueue(async () => {
      try {
        return work();
      } catch (error) {
        throw mapStorageError(error);
      }
    }, unavailable);
  }

  private overlayRows(
    where: string,
    values: readonly SQLInputValue[],
  ): readonly Row[] {
    return this.client
      .prepare(
        `SELECT
           overlay_id AS "overlayId",
           artifact_id AS "artifactId",
           source_binding_digest AS "sourceBindingDigest",
           revision AS "revision",
           previous_overlay_digest AS "previousOverlayDigest",
           from_key_id AS "fromKeyId",
           target_catalog_generation AS "targetCatalogGeneration",
           target_catalog_digest AS "targetCatalogDigest",
           target_key_id AS "targetKeyId",
           target_material_proof AS "targetMaterialProof",
           mutation_id AS "mutationId",
           command_digest AS "commandDigest",
           overlay_digest AS "overlayDigest",
           rekeyed_at_ms AS "rekeyedAtMs",
           overlay_json AS "overlayJson"
         FROM "ToolExecutionResultRekeyOverlays"
         WHERE ${where}
         ORDER BY revision DESC
         LIMIT 2`,
      )
      .all(...values) as Row[];
  }

  private currentCatalog(): Readonly<ToolResultKeyCatalogRecord> {
    const row = this.client
      .prepare(
        `SELECT catalog_json AS "catalogJson"
           FROM "ToolResultKeyCatalogGenerations"
          WHERE authority = ?
          ORDER BY generation DESC
          LIMIT 1`,
      )
      .get(AUTHORITY) as Row | undefined;
    if (!row) throw unavailable();
    try {
      return normalizeToolResultKeyCatalogRecord(
        parseJson(row, 'catalogJson', 64 * 1024) as ToolResultKeyCatalogRecord,
      );
    } catch {
      throw unavailable();
    }
  }

  findHeadByArtifactId(
    artifactId: string,
  ): Promise<Readonly<ToolExecutionResultRekeyOverlay> | null> {
    return this.enqueue(() => {
      const rows = this.overlayRows(
        `artifact_id = ? AND EXISTS (
           SELECT 1
             FROM "ToolExecutionResultRekeyHeads" AS head
            WHERE head.artifact_id =
                    "ToolExecutionResultRekeyOverlays".artifact_id
              AND head.revision =
                    "ToolExecutionResultRekeyOverlays".revision
              AND head.overlay_digest =
                    "ToolExecutionResultRekeyOverlays".overlay_digest
         )`,
        [artifactId],
      );
      if (rows.length > 1) throw unavailable();
      return rows[0] ? overlayFromRow(rows[0]) : null;
    });
  }

  append(
    commandValue: Readonly<ToolExecutionResultRekeyCommand>,
  ): Promise<Readonly<CommitToolExecutionResultRekeyResult>> {
    const command = normalizeToolExecutionResultRekeyCommand(commandValue);
    return this.enqueue(() => {
      let began = false;
      try {
        this.client.exec('BEGIN IMMEDIATE');
        began = true;
        const replayRows = this.overlayRows(
          'mutation_id = ? OR overlay_id = ? OR overlay_digest = ?',
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
          this.client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing' as const,
            overlay: stored,
          });
        }

        const binding = this.client
          .prepare(
            `SELECT artifact_id AS "artifactId",
                    artifact_digest AS "artifactDigest",
                    key_id AS "keyId",
                    binding_digest AS "bindingDigest"
               FROM "ToolExecutionResultKeyBindings"
              WHERE artifact_id = ?`,
          )
          .get(command.overlay.sourceArtifact.artifactId) as Row | undefined;
        if (
          !binding ||
          requiredText(binding, 'artifactDigest') !==
            command.overlay.sourceArtifact.artifactDigest ||
          requiredText(binding, 'bindingDigest') !==
            command.overlay.sourceBindingDigest
        ) {
          throw new ToolExecutionResultRekeyConflictError();
        }
        const head = this.client
          .prepare(
            `SELECT revision AS "revision",
                    overlay_digest AS "overlayDigest",
                    target_key_id AS "targetKeyId"
               FROM "ToolExecutionResultRekeyHeads"
              WHERE artifact_id = ?`,
          )
          .get(command.overlay.sourceArtifact.artifactId) as Row | undefined;
        const currentRevision = head ? requiredInteger(head, 'revision') : 0;
        const currentDigest = head ? requiredText(head, 'overlayDigest') : null;
        const fromKeyId = head
          ? requiredText(head, 'targetKeyId')
          : requiredText(binding, 'keyId');
        if (
          currentRevision !== command.expectedRevision ||
          currentDigest !== command.expectedOverlayDigest ||
          command.overlay.fromKeyId !== fromKeyId
        ) {
          throw new ToolExecutionResultRekeyConflictError();
        }

        const catalog = this.currentCatalog();
        const active = requireActiveToolResultKey(catalog);
        const fence = toolResultKeyCatalogFence(catalog, active);
        if (
          JSON.stringify(fence) !==
          JSON.stringify(command.overlay.targetCatalogFence)
        ) {
          throw new ToolExecutionResultRekeyConflictError();
        }

        this.client
          .prepare(
            `INSERT INTO "ToolExecutionResultRekeyOverlays" (
               overlay_id, artifact_id, source_binding_digest, revision,
               previous_overlay_digest, from_key_id,
               target_catalog_authority, target_catalog_generation,
               target_catalog_digest, target_key_id, target_material_proof,
               mutation_id, command_digest, overlay_digest, rekeyed_at_ms,
               overlay_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
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
          );
        if (head) {
          const update = this.client
            .prepare(
              `UPDATE "ToolExecutionResultRekeyHeads"
                  SET revision = ?, overlay_id = ?, overlay_digest = ?,
                      target_catalog_generation = ?,
                      target_catalog_digest = ?, target_key_id = ?,
                      updated_at_ms = ?
                WHERE artifact_id = ? AND revision = ?
                  AND overlay_digest = ?`,
            )
            .run(
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
            );
          if (update.changes !== 1) {
            throw new ToolExecutionResultRekeyConflictError();
          }
        } else {
          this.client
            .prepare(
              `INSERT INTO "ToolExecutionResultRekeyHeads" (
                 artifact_id, revision, overlay_id, overlay_digest,
                 target_catalog_generation, target_catalog_digest,
                 target_key_id, updated_at_ms
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              command.overlay.sourceArtifact.artifactId,
              command.overlay.revision,
              command.overlay.overlayId,
              command.overlay.overlayDigest,
              fence.generation,
              fence.catalogDigest,
              fence.keyId,
              command.overlay.rekeyedAtMs,
            );
        }
        this.client.exec('COMMIT');
        began = false;
        return Object.freeze({
          status: 'created' as const,
          overlay: command.overlay,
        });
      } catch (error) {
        if (began && this.client.isTransaction) {
          try {
            this.client.exec('ROLLBACK');
          } catch {
            // Preserve the original error.
          }
        }
        throw error;
      }
    });
  }

  private receiptRow(
    where: string,
    values: readonly SQLInputValue[],
  ): Row | undefined {
    return this.client
      .prepare(
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
         FROM "ToolResultKeyRetirementReceipts"
         WHERE ${where}
         LIMIT 1`,
      )
      .get(...values) as Row | undefined;
  }

  findByDigest(
    receiptDigest: string,
  ): Promise<Readonly<ToolResultKeyRetirementReceipt> | null> {
    return this.enqueue(() => {
      const row = this.receiptRow('receipt_digest = ?', [receiptDigest]);
      return row ? receiptFromRow(row) : null;
    });
  }

  create(
    commandValue: Readonly<ToolResultKeyRetirementReceiptCommand>,
  ): Promise<Readonly<CommitToolResultKeyRetirementReceiptResult>> {
    const command =
      normalizeToolResultKeyRetirementReceiptCommand(commandValue);
    return this.enqueue(() => {
      let began = false;
      try {
        this.client.exec('BEGIN IMMEDIATE');
        began = true;
        const replay = this.receiptRow('mutation_id = ?', [command.mutationId]);
        if (replay) {
          const stored = receiptFromRow(replay);
          if (
            requiredText(replay, 'commandDigest') !== command.commandDigest ||
            stored.catalogGeneration !== command.expectedCatalogGeneration ||
            stored.catalogDigest !== command.expectedCatalogDigest ||
            stored.keyId !== command.keyId
          ) {
            throw new ToolExecutionResultRekeyConflictError();
          }
          this.client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing' as const,
            receipt: stored,
          });
        }

        const catalog = this.currentCatalog();
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
        const rows = this.client
          .prepare(
            `SELECT
               binding.artifact_id AS "artifactId",
               binding.binding_digest AS "bindingDigest",
               binding.key_id AS "bindingKeyId",
               head.overlay_digest AS "headOverlayDigest",
               head.target_key_id AS "headTargetKeyId",
               head.target_catalog_generation AS
                 "headTargetCatalogGeneration",
               head.target_catalog_digest AS "headTargetCatalogDigest"
             FROM "ToolExecutionResultKeyBindings" AS binding
             LEFT JOIN "ToolExecutionResultRekeyHeads" AS head
               ON head.artifact_id = binding.artifact_id
            WHERE binding.key_id = ? OR head.target_key_id = ?
            ORDER BY binding.artifact_id`,
          )
          .iterate(retiring.keyId, retiring.keyId) as Iterable<Row>;
        for (const row of rows) {
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
        const result = coverage.finish();
        if (
          result.uncoveredBindingCount !== 0 ||
          result.uncoveredOverlayHeadCount !== 0
        ) {
          throw new ToolExecutionResultRekeyConflictError();
        }
        const clock = this.client
          .prepare(`SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now`)
          .get() as Row;
        const receipt = createToolResultKeyRetirementReceipt({
          catalogGeneration: catalog.generation,
          catalogDigest: catalog.catalogDigest,
          keyId: retiring.keyId,
          materialProof: retiring.materialProof,
          mutationId: command.mutationId,
          bindingCount: result.bindingCount,
          overlayHeadCount: result.overlayHeadCount,
          coverageDigest: result.coverageDigest,
          createdAtMs: requiredInteger(clock, 'now'),
        });
        this.client
          .prepare(
            `INSERT INTO "ToolResultKeyRetirementReceipts" (
               receipt_digest, catalog_authority, catalog_generation,
               catalog_digest, key_id, material_proof, mutation_id,
               command_digest, binding_count, overlay_head_count,
               uncovered_binding_count, uncovered_overlay_head_count,
               coverage_digest, created_at_ms, receipt_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
          )
          .run(
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
          );
        this.client.exec('COMMIT');
        began = false;
        return Object.freeze({
          status: 'created' as const,
          receipt,
        });
      } catch (error) {
        if (began && this.client.isTransaction) {
          try {
            this.client.exec('ROLLBACK');
          } catch {
            // Preserve the original error.
          }
        }
        throw error;
      }
    });
  }
}
