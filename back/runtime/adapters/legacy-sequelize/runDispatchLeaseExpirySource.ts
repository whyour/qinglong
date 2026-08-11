import { QueryTypes, Sequelize } from 'sequelize';
import {
  RUN_ATTEMPT_TABLE,
  RUN_TABLE,
} from '../../../migrations/0002-run-schema';
import {
  RUN_DISPATCH_LEASE_EXPIRY_INDEX,
  RUN_DISPATCH_LEASE_TABLE,
} from '../../../migrations/0009-run-dispatch-lease';
import {
  assertRunDispatchId,
  assertRunDispatchLeaseVersion,
} from '../../domain/runDispatchLease';
import {
  MAX_RUN_DISPATCH_LEASE_EXPIRY_PAGE_SIZE,
  type ExpiredRunDispatchLeaseCandidate,
  type ListExpiredRunDispatchLeasesOptions,
  type RunDispatchLeaseExpirySource,
} from '../../ports/runDispatchLeaseExpirySource';

interface ExpiredLeaseRow {
  runId: string;
  attemptId: string;
  expiresAtMs: number | string;
}

function assertLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_RUN_DISPATCH_LEASE_EXPIRY_PAGE_SIZE
  ) {
    throw new RangeError(
      `limit must be between 1 and ${MAX_RUN_DISPATCH_LEASE_EXPIRY_PAGE_SIZE}`,
    );
  }
}

export class LegacySequelizeRunDispatchLeaseExpirySource
  implements RunDispatchLeaseExpirySource
{
  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Legacy Run dispatch lease expiry source is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
  }

  async listExpired({
    observedAtMs,
    after,
    limit = 16,
  }: ListExpiredRunDispatchLeasesOptions): Promise<
    readonly ExpiredRunDispatchLeaseCandidate[]
  > {
    assertRunDispatchLeaseVersion('observedAtMs', observedAtMs);
    assertLimit(limit);
    if (after) {
      assertRunDispatchLeaseVersion('after.expiresAtMs', after.expiresAtMs);
      assertRunDispatchId('after.attemptId', after.attemptId);
    }
    const cursorPredicate = after
      ? `AND (
          l.expires_at_ms > :afterExpiresAtMs
          OR (
            l.expires_at_ms = :afterExpiresAtMs
            AND l.attempt_id > :afterAttemptId
          )
        )`
      : '';
    const rows = await this.database.query<ExpiredLeaseRow>(
      `SELECT
         l.run_id AS runId,
         l.attempt_id AS attemptId,
         l.expires_at_ms AS expiresAtMs
       FROM ${RUN_DISPATCH_LEASE_TABLE} l INDEXED BY ${RUN_DISPATCH_LEASE_EXPIRY_INDEX}
       INNER JOIN ${RUN_TABLE} r ON r.id = l.run_id
       INNER JOIN ${RUN_ATTEMPT_TABLE} a ON a.id = l.attempt_id
       WHERE l.status = 'leased'
         AND l.expires_at_ms <= :observedAtMs
         AND r.execution_owner = 'runtime'
         AND r.status IN ('dispatching', 'running')
         AND a.run_id = r.id
         AND a.status IN ('claimed', 'starting', 'running')
         ${cursorPredicate}
       ORDER BY l.expires_at_ms ASC, l.attempt_id ASC
       LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          observedAtMs,
          limit,
          ...(after
            ? {
                afterExpiresAtMs: after.expiresAtMs,
                afterAttemptId: after.attemptId,
              }
            : {}),
        },
      },
    );
    return rows.map((row) => {
      const candidate = {
        runId: row.runId,
        attemptId: row.attemptId,
        expiresAtMs: Number(row.expiresAtMs),
      };
      assertRunDispatchId('runId', candidate.runId);
      assertRunDispatchId('attemptId', candidate.attemptId);
      assertRunDispatchLeaseVersion('expiresAtMs', candidate.expiresAtMs);
      if (candidate.expiresAtMs > observedAtMs) {
        throw new TypeError('Expiry source returned a live Run lease');
      }
      return candidate;
    });
  }
}
