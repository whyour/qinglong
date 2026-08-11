// PostgreSQL Remote Worker recovery evidence is owned by this domain.
import type {
  ClusterControlRecoveryEvidence,
  ClusterControlRecoveryEvidenceInspectionContext,
  ClusterControlRecoveryExecutorEvidenceProvider,
  ClusterControlRecoveryProbeTarget,
} from '@qinglong/runtime-core';
import type { PostgresPool } from '@qinglong/runtime-core';
import type { WorkerExecutionAttestationRepository } from '@qinglong/runtime-core/worker-attestation';

export const REMOTE_WORKER_ATTESTATION_LIMITS = Object.freeze({
  defaultRunningFreshnessMs: 30_000,
  maxRunningFreshnessMs: 300_000,
});

type Row = Record<string, unknown>;

export class PostgresRemoteWorkerAttestationEvidenceProvider
  implements ClusterControlRecoveryExecutorEvidenceProvider
{
  readonly executorType = 'remote-worker';
  readonly requiredIdentity = Object.freeze([
    'workerId',
    'workerSessionId',
    'workerGeneration',
    'leaseTokenDigest',
    'leaseGeneration',
    'leaseVersion',
    'offerId',
    'executorHandle',
  ] as const);

  private readonly runningFreshnessMs: number;

  constructor(
    private readonly pool: PostgresPool,
    private readonly attestations: WorkerExecutionAttestationRepository,
    options: Readonly<{ runningFreshnessMs?: number }> = {},
  ) {
    const freshness =
      options.runningFreshnessMs ??
      REMOTE_WORKER_ATTESTATION_LIMITS.defaultRunningFreshnessMs;
    if (
      !Number.isSafeInteger(freshness) ||
      freshness < 1_000 ||
      freshness > REMOTE_WORKER_ATTESTATION_LIMITS.maxRunningFreshnessMs
    ) {
      throw new RangeError('Remote Worker attestation freshness is invalid');
    }
    this.runningFreshnessMs = freshness;
  }

  async inspect(
    target: ClusterControlRecoveryProbeTarget,
    context: ClusterControlRecoveryEvidenceInspectionContext,
  ): Promise<ClusterControlRecoveryEvidence> {
    if (context.signal.aborted) {
      return Object.freeze({ status: 'unknown', reason: 'provider_unavailable' });
    }
    const attestation = await this.attestations.findLatestExact({
      runId: target.runId,
      attemptId: target.attemptId,
      workerId: target.workerId!,
      workerSessionId: target.workerSessionId!,
      workerGeneration: target.workerGeneration!,
      leaseTokenDigest: target.leaseTokenDigest!,
      leaseGeneration: target.leaseGeneration!,
      leaseVersion: target.leaseVersion!,
      offerId: target.offerId!,
      callbackSequence: target.callbackSequence,
      executorHandle: target.executorHandle!,
    });
    if (!attestation) {
      return Object.freeze({ status: 'unknown', reason: 'provider_unavailable' });
    }
    if (attestation.state === 'stopped') {
      return Object.freeze({ status: 'not_running' });
    }
    const observed = await this.pool.query<Row>(
      `SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS "observedAtMs"`,
    );
    const raw = observed.rows[0]?.observedAtMs;
    const observedAtMs =
      typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (
      observed.rows.length !== 1 ||
      typeof observedAtMs !== 'number' ||
      !Number.isSafeInteger(observedAtMs) ||
      observedAtMs < attestation.receivedAtMs ||
      observedAtMs - attestation.receivedAtMs > this.runningFreshnessMs
    ) {
      return Object.freeze({ status: 'unknown', reason: 'provider_unavailable' });
    }
    return Object.freeze({ status: 'running' });
  }
}
