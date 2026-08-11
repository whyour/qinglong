import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import {
  InvalidToolResultKeyCatalogError,
  ToolResultKeyCatalogConflictError,
  ToolResultKeyCatalogUnavailableError,
  assertToolResultKeyCatalogTransition,
  normalizeToolResultKeyCatalogCommand,
  normalizeToolResultKeyCatalogRecord,
  type CommitToolResultKeyCatalogResult,
  type ToolResultKeyCatalogCommand,
  type ToolResultKeyCatalogRecord,
  type ToolResultKeyCatalogRepository,
} from '@qinglong/runtime-core/tool-result-key-catalog';
import {
  normalizeToolResultKeyRetirementReceipt,
  type ToolResultKeyRetirementReceipt,
} from '@qinglong/runtime-core/tool-result-rekey';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

const AUTHORITY = 'trusted-tool-results';

function unavailable(cause?: unknown): ToolResultKeyCatalogUnavailableError {
  return new ToolResultKeyCatalogUnavailableError({
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
    error instanceof InvalidToolResultKeyCatalogError ||
    error instanceof ToolResultKeyCatalogConflictError ||
    error instanceof ToolResultKeyCatalogUnavailableError
  ) {
    return error;
  }
  return sqliteConstraint(error)
    ? new ToolResultKeyCatalogConflictError()
    : unavailable(error);
}

function requiredText(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function requiredNullableText(row: Row, key: string): string | null {
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

function recordFromRow(row: Row): Readonly<ToolResultKeyCatalogRecord> {
  let parsed: unknown;
  const json = requiredText(row, 'catalogJson');
  if (Buffer.byteLength(json, 'utf8') > 64 * 1024) throw unavailable();
  try {
    parsed = JSON.parse(json);
  } catch {
    throw unavailable();
  }
  let catalog: Readonly<ToolResultKeyCatalogRecord>;
  try {
    catalog = normalizeToolResultKeyCatalogRecord(
      parsed as ToolResultKeyCatalogRecord,
    );
    const { committedAtMs: _committedAtMs, ...next } = catalog;
    normalizeToolResultKeyCatalogCommand({
      schema: 'qinglong/tool-result-key-catalog-command@v1',
      expectedGeneration: catalog.generation - 1,
      expectedCatalogDigest: catalog.previousCatalogDigest,
      next,
      commandDigest: requiredText(row, 'commandDigest'),
    });
  } catch {
    throw unavailable();
  }
  if (
    catalog.generation !== requiredInteger(row, 'generation') ||
    catalog.previousCatalogDigest !==
      requiredNullableText(row, 'previousCatalogDigest') ||
    catalog.activeKeyId !== requiredNullableText(row, 'activeKeyId') ||
    catalog.mutationKind !== requiredText(row, 'mutationKind') ||
    catalog.mutationId !== requiredText(row, 'mutationId') ||
    catalog.catalogDigest !== requiredText(row, 'catalogDigest') ||
    catalog.committedAtMs !== requiredInteger(row, 'committedAtMs') ||
    JSON.stringify(catalog) !== json
  ) {
    throw unavailable();
  }
  return catalog;
}

export class LocalSqliteToolResultKeyCatalogRepository
  implements ToolResultKeyCatalogRepository
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

  private rows(
    where = '',
    values: readonly SQLInputValue[] = [],
  ): readonly Row[] {
    return this.client
      .prepare(
        `SELECT
           generation AS "generation",
           previous_catalog_digest AS "previousCatalogDigest",
           active_key_id AS "activeKeyId",
           mutation_kind AS "mutationKind",
           mutation_id AS "mutationId",
           catalog_digest AS "catalogDigest",
           command_digest AS "commandDigest",
           committed_at_ms AS "committedAtMs",
           catalog_json AS "catalogJson"
         FROM "ToolResultKeyCatalogGenerations"
         WHERE authority = ? ${where}
         ORDER BY generation DESC
         LIMIT 2`,
      )
      .all(AUTHORITY, ...values) as Row[];
  }

  findCurrent(): Promise<Readonly<ToolResultKeyCatalogRecord> | null> {
    return this.enqueue(() => {
      const rows = this.rows();
      if (
        rows.length > 1 &&
        requiredInteger(rows[0]!, 'generation') ===
          requiredInteger(rows[1]!, 'generation')
      ) {
        throw unavailable();
      }
      return rows[0] ? recordFromRow(rows[0]) : null;
    });
  }

  append(
    commandValue: Readonly<ToolResultKeyCatalogCommand>,
  ): Promise<Readonly<CommitToolResultKeyCatalogResult>> {
    const command = normalizeToolResultKeyCatalogCommand(commandValue);
    return this.enqueue(() => {
      let began = false;
      try {
        this.client.exec('BEGIN IMMEDIATE');
        began = true;
        const replayRows = this.rows(
          'AND (mutation_id = ? OR generation = ? OR catalog_digest = ?)',
          [
            command.next.mutationId,
            command.next.generation,
            command.next.catalogDigest,
          ],
        );
        if (replayRows.length > 1) {
          throw new ToolResultKeyCatalogConflictError();
        }
        if (replayRows[0]) {
          const stored = recordFromRow(replayRows[0]);
          if (
            requiredText(replayRows[0], 'commandDigest') !==
              command.commandDigest ||
            JSON.stringify({
              ...stored,
              committedAtMs: undefined,
            }) !==
              JSON.stringify({
                ...command.next,
                committedAtMs: undefined,
              })
          ) {
            throw new ToolResultKeyCatalogConflictError();
          }
          this.client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'existing' as const,
            catalog: stored,
          });
        }

        const currentRows = this.rows();
        if (
          currentRows.length > 1 &&
          requiredInteger(currentRows[0]!, 'generation') ===
            requiredInteger(currentRows[1]!, 'generation')
        ) {
          throw new ToolResultKeyCatalogConflictError();
        }
        const current = currentRows[0] ? recordFromRow(currentRows[0]) : null;
        assertToolResultKeyCatalogTransition(current, command);
        if (command.next.mutationKind === 'retire') {
          if (!current) throw new ToolResultKeyCatalogConflictError();
          const retired = command.next.keys.find(
            (entry) => entry.state === 'retired',
          );
          const previous = retired
            ? current.keys.find((entry) => entry.keyId === retired.keyId)
            : null;
          if (
            !retired ||
            !previous ||
            retired.retirementReceiptDigest === null
          ) {
            throw new ToolResultKeyCatalogConflictError();
          }
          const receiptRow = this.client
            .prepare(
              `SELECT receipt_json AS "receiptJson"
                 FROM "ToolResultKeyRetirementReceipts"
                WHERE receipt_digest = ?`,
            )
            .get(retired.retirementReceiptDigest) as Row | undefined;
          let receipt: Readonly<ToolResultKeyRetirementReceipt>;
          try {
            const receiptJson = receiptRow
              ? requiredText(receiptRow, 'receiptJson')
              : '';
            if (Buffer.byteLength(receiptJson, 'utf8') > 64 * 1024) {
              throw new Error('receipt budget');
            }
            receipt = normalizeToolResultKeyRetirementReceipt(
              JSON.parse(receiptJson) as ToolResultKeyRetirementReceipt,
            );
          } catch {
            throw new ToolResultKeyCatalogConflictError();
          }
          if (
            receipt.receiptDigest !== retired.retirementReceiptDigest ||
            receipt.catalogGeneration !== current.generation ||
            receipt.catalogDigest !== current.catalogDigest ||
            receipt.keyId !== previous.keyId ||
            receipt.materialProof !== previous.materialProof
          ) {
            throw new ToolResultKeyCatalogConflictError();
          }
        }
        const clock = this.client
          .prepare(`SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now`)
          .get() as Row;
        const committedAtMs = requiredInteger(clock, 'now');
        const catalog = normalizeToolResultKeyCatalogRecord({
          ...command.next,
          committedAtMs,
        });
        this.client
          .prepare(
            `INSERT INTO "ToolResultKeyCatalogGenerations" (
               authority, generation, previous_generation,
               previous_catalog_digest, active_key_id, mutation_kind,
               mutation_id, catalog_digest, command_digest, committed_at_ms,
               catalog_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            AUTHORITY,
            catalog.generation,
            catalog.generation === 1 ? null : catalog.generation - 1,
            catalog.previousCatalogDigest,
            catalog.activeKeyId,
            catalog.mutationKind,
            catalog.mutationId,
            catalog.catalogDigest,
            command.commandDigest,
            catalog.committedAtMs,
            JSON.stringify(catalog),
          );
        this.client.exec('COMMIT');
        began = false;
        return Object.freeze({
          status: 'created' as const,
          catalog,
        });
      } catch (error) {
        if (began && this.client.isTransaction) {
          try {
            this.client.exec('ROLLBACK');
          } catch {
            // Preserve the original failure; the shared authority owns close.
          }
        }
        throw error;
      }
    });
  }
}
