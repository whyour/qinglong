import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import {
  InvalidToolResultKeyCatalogError,
  ToolResultKeyCatalogConflictError,
  ToolResultKeyCatalogUnavailableError,
  assertToolResultKeyCatalogTransition,
  normalizeToolResultKeyCatalogCommand,
  normalizeToolResultKeyCatalogRecord,
  type CommitToolResultKeyCatalogResult,
  type ToolResultKeyCatalogCommand,
  type ToolResultKeyCatalogReader,
  type ToolResultKeyCatalogRecord,
  type ToolResultKeyCatalogRepository,
} from '@qinglong/runtime-core/tool-result-key-catalog';
import {
  normalizeToolResultKeyRetirementReceipt,
  type ToolResultKeyRetirementReceipt,
} from '@qinglong/runtime-core/tool-result-rekey';

type Row = Record<string, unknown>;

const AUTHORITY = 'trusted-tool-results';
const CATALOG_TRANSACTION_LOCK = 'SELECT pg_advisory_xact_lock(190397473, 3)';

function unavailable(cause?: unknown): ToolResultKeyCatalogUnavailableError {
  return new ToolResultKeyCatalogUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function postgresConstraint(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    ['23503', '23505', '23514'].includes((error as { code: string }).code)
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
  return postgresConstraint(error)
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
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 0) throw unavailable();
  return value;
}

function recordFromRow(row: Row): Readonly<ToolResultKeyCatalogRecord> {
  const value = row.catalogJson;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw unavailable();
  }
  let catalog: Readonly<ToolResultKeyCatalogRecord>;
  try {
    catalog = normalizeToolResultKeyCatalogRecord(
      value as ToolResultKeyCatalogRecord,
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
    catalog.committedAtMs !== requiredInteger(row, 'committedAtMs')
  ) {
    throw unavailable();
  }
  return catalog;
}

async function rollback(client: PostgresClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

export class PostgresToolResultKeyCatalogReader
  implements ToolResultKeyCatalogReader
{
  constructor(protected readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError('PostgreSQL Tool result key catalog pool is invalid');
    }
  }

  protected async rows(
    client: Pick<PostgresClient, 'query'> | PostgresPool,
    suffix = '',
    values: readonly unknown[] = [],
    lock = false,
  ): Promise<readonly Row[]> {
    const result = await client.query<Row>(
      `SELECT
         generation,
         previous_catalog_digest AS "previousCatalogDigest",
         active_key_id AS "activeKeyId",
         mutation_kind AS "mutationKind",
         mutation_id AS "mutationId",
         catalog_digest AS "catalogDigest",
         command_digest AS "commandDigest",
         committed_at_ms AS "committedAtMs",
         catalog_json AS "catalogJson"
       FROM "ql3"."tool_result_key_catalog_generations"
       WHERE authority = $1 ${suffix}
       ORDER BY generation DESC
       LIMIT 2${lock ? ' FOR UPDATE' : ''}`,
      [AUTHORITY, ...values],
    );
    return result.rows;
  }

  async findCurrent(): Promise<Readonly<ToolResultKeyCatalogRecord> | null> {
    try {
      const rows = await this.rows(this.pool);
      if (
        rows.length > 1 &&
        requiredInteger(rows[0]!, 'generation') ===
          requiredInteger(rows[1]!, 'generation')
      ) {
        throw unavailable();
      }
      return rows[0] ? recordFromRow(rows[0]) : null;
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}

export class PostgresToolResultKeyCatalogRepository
  extends PostgresToolResultKeyCatalogReader
  implements ToolResultKeyCatalogRepository
{
  async append(
    commandValue: Readonly<ToolResultKeyCatalogCommand>,
  ): Promise<Readonly<CommitToolResultKeyCatalogResult>> {
    const command = normalizeToolResultKeyCatalogCommand(commandValue);
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw unavailable(error);
    }
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query(CATALOG_TRANSACTION_LOCK);
      const replayRows = await this.rows(
        client,
        'AND (mutation_id = $2 OR generation = $3 OR catalog_digest = $4)',
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
        const { committedAtMs: _storedTime, ...storedSnapshot } = stored;
        if (
          requiredText(replayRows[0], 'commandDigest') !==
            command.commandDigest ||
          JSON.stringify(storedSnapshot) !== JSON.stringify(command.next)
        ) {
          throw new ToolResultKeyCatalogConflictError();
        }
        await client.query('COMMIT');
        return Object.freeze({
          status: 'existing' as const,
          catalog: stored,
        });
      }

      const currentRows = await this.rows(client);
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
        const receiptResult = await client.query<Row>(
          `SELECT receipt_json AS "receiptJson"
             FROM "ql3"."tool_result_key_retirement_receipts"
            WHERE receipt_digest = $1`,
          [retired.retirementReceiptDigest],
        );
        let receipt: Readonly<ToolResultKeyRetirementReceipt>;
        try {
          if (receiptResult.rows.length !== 1) {
            throw new Error('retirement receipt count');
          }
          const receiptJson = receiptResult.rows[0]!.receiptJson;
          if (
            !receiptJson ||
            typeof receiptJson !== 'object' ||
            Array.isArray(receiptJson) ||
            Buffer.byteLength(JSON.stringify(receiptJson), 'utf8') >
              64 * 1024
          ) {
            throw new Error('retirement receipt budget');
          }
          receipt = normalizeToolResultKeyRetirementReceipt(
            receiptJson as ToolResultKeyRetirementReceipt,
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
      const clock = await client.query<Row>(
        `SELECT floor(
           extract(epoch FROM clock_timestamp()) * 1000
         )::bigint AS now`,
      );
      if (clock.rows.length !== 1) throw unavailable();
      const committedAtMs = requiredInteger(clock.rows[0]!, 'now');
      const catalog = normalizeToolResultKeyCatalogRecord({
        ...command.next,
        committedAtMs,
      });
      await client.query(
        `INSERT INTO "ql3"."tool_result_key_catalog_generations" (
           authority, generation, previous_generation,
           previous_catalog_digest, active_key_id, mutation_kind,
           mutation_id, catalog_digest, command_digest, committed_at_ms,
           catalog_json
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11::jsonb
         )`,
        [
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
        ],
      );
      await client.query('COMMIT');
      return Object.freeze({
        status: 'created' as const,
        catalog,
      });
    } catch (error) {
      await rollback(client);
      throw mapStorageError(error);
    } finally {
      client.release();
    }
  }
}
