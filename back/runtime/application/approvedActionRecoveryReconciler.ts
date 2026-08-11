import { v7 as uuidV7 } from 'uuid';
import {
  assertApprovedActionLeaseIdentity,
  assertApprovedActionResultCode,
} from '../domain/approvedActionDispatchExecution';
import {
  assertApprovedActionEvidenceDigest,
  assertApprovedActionRecoveryLeaseDuration,
  assertApprovedActionRecoveryPageSize,
  type ApprovedActionRecoveryCursor,
} from '../domain/approvedActionRecovery';
import type {
  ApprovedActionRecoveryEvidence,
  ApprovedActionRecoveryEvidenceProvider,
} from '../ports/approvedActionRecoveryEvidenceProvider';
import type { ApprovedActionRecoveryRepository } from '../ports/approvedActionRecoveryRepository';

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60_000;

export interface ApprovedActionRecoveryReconcilerOptions {
  owner: string;
  leaseDurationMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  clock?: () => number;
  createId?: () => string;
}

export interface ApprovedActionRecoveryBatchSummary {
  scanned: number;
  claimed: number;
  verifiedSucceeded: number;
  verifiedFailed: number;
  deferred: number;
  manualRequired: number;
  executionActive: number;
  alreadyResolved: number;
  unavailable: number;
  truncated: boolean;
  nextCursor?: Readonly<ApprovedActionRecoveryCursor>;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    keys.length === canonical.length &&
    keys.every((key, index) => key === canonical[index])
  );
}

export class ApprovedActionRecoveryReconciler {
  private readonly providers = new Map<
    string,
    ApprovedActionRecoveryEvidenceProvider
  >();
  private readonly owner: string;
  private readonly leaseDurationMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly clock: () => number;
  private readonly createId: () => string;

  constructor(
    private readonly repository: ApprovedActionRecoveryRepository,
    providers: readonly ApprovedActionRecoveryEvidenceProvider[],
    options: ApprovedActionRecoveryReconcilerOptions,
  ) {
    assertApprovedActionLeaseIdentity(options.owner);
    this.owner = options.owner;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.clock = options.clock ?? Date.now;
    this.createId = options.createId ?? uuidV7;
    assertApprovedActionRecoveryLeaseDuration(this.leaseDurationMs);
    assertPositiveInteger('retryBaseMs', this.retryBaseMs);
    assertPositiveInteger('retryMaxMs', this.retryMaxMs);
    if (this.retryMaxMs < this.retryBaseMs) {
      throw new RangeError(
        'retryMaxMs must be greater than or equal to retryBaseMs',
      );
    }
    for (const provider of providers) {
      if (
        !provider ||
        typeof provider !== 'object' ||
        typeof provider.actionType !== 'string' ||
        provider.actionType.length < 1 ||
        provider.actionType.length > 64 ||
        !['automatic', 'manual_only'].includes(provider.capability) ||
        typeof provider.inspect !== 'function'
      ) {
        throw new TypeError('Approved action recovery provider is invalid');
      }
      if (this.providers.has(provider.actionType)) {
        throw new TypeError(
          `Duplicate approved action recovery provider: ${provider.actionType}`,
        );
      }
      this.providers.set(provider.actionType, provider);
    }
  }

  async reconcileBatch(
    options: { cursor?: ApprovedActionRecoveryCursor; limit?: number } = {},
  ): Promise<Readonly<ApprovedActionRecoveryBatchSummary>> {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Approved action recovery options must be an object');
    }
    const expectedKeys = [
      ...(options.cursor === undefined ? [] : ['cursor']),
      ...(options.limit === undefined ? [] : ['limit']),
    ];
    if (!exactKeys(options, expectedKeys)) {
      throw new TypeError('Approved action recovery options shape is invalid');
    }
    const limit = options.limit ?? 16;
    assertApprovedActionRecoveryPageSize(limit);
    const observedAtMs = this.now();
    const page = await this.repository.listDue({
      nowMs: observedAtMs,
      limit,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
    const summary: ApprovedActionRecoveryBatchSummary = {
      scanned: page.recoveries.length,
      claimed: 0,
      verifiedSucceeded: 0,
      verifiedFailed: 0,
      deferred: 0,
      manualRequired: 0,
      executionActive: 0,
      alreadyResolved: 0,
      unavailable: 0,
      truncated: page.truncated,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
    for (const candidate of page.recoveries) {
      await this.reconcileOne(candidate.action.dispatch.id, summary);
    }
    return Object.freeze(summary);
  }

  private async reconcileOne(
    dispatchId: string,
    summary: ApprovedActionRecoveryBatchSummary,
  ): Promise<void> {
    let claim;
    try {
      claim = await this.repository.claim({
        dispatchId,
        owner: this.owner,
        leaseToken: this.createId(),
        nowMs: this.now(),
        leaseDurationMs: this.leaseDurationMs,
      });
    } catch {
      summary.unavailable += 1;
      return;
    }
    if (claim.status === 'not_found') {
      summary.unavailable += 1;
      return;
    }
    if (claim.status !== 'claimed') {
      if (claim.status === 'manual_required') summary.manualRequired += 1;
      else if (claim.status === 'resolved') summary.alreadyResolved += 1;
      else if (claim.status === 'execution_active')
        summary.executionActive += 1;
      else summary.deferred += 1;
      return;
    }
    summary.claimed += 1;
    const snapshot = claim.snapshot;
    const provider = this.providers.get(
      snapshot.action.dispatch.action.actionType,
    );
    let evidence: ApprovedActionRecoveryEvidence;
    if (!provider || provider.capability === 'manual_only') {
      evidence = {
        finding: 'unsupported',
        resultCode: 'automatic_recovery_unsupported',
      };
    } else {
      try {
        evidence = await provider.inspect(
          Object.freeze({
            snapshot,
            idempotencyKey: snapshot.action.dispatch.id,
            observedAtMs: this.now(),
          }),
        );
      } catch {
        evidence = {
          finding: 'unavailable',
          resultCode: 'recovery_evidence_unavailable',
        };
      }
      try {
        this.assertEvidence(evidence);
      } catch {
        evidence = {
          finding: 'conflict',
          resultCode: 'recovery_evidence_invalid',
        };
      }
    }

    if (
      evidence.finding === 'verified_succeeded' ||
      evidence.finding === 'verified_failed'
    ) {
      try {
        const resolved = await this.repository.resolve({
          dispatchId,
          expectedExecutionVersion: snapshot.action.execution.version,
          expectedRecoveryVersion: snapshot.recovery.version,
          owner: this.owner,
          leaseToken: snapshot.recovery.leaseToken!,
          mutationId: this.createId(),
          source: 'automatic_evidence',
          decision:
            evidence.finding === 'verified_succeeded'
              ? 'confirm_succeeded'
              : 'confirm_failed',
          evidenceDigest: evidence.evidenceDigest,
          reasonCode: evidence.resultCode,
          resolvedAtMs: this.now(),
        });
        if (resolved.status === 'not_found') {
          summary.unavailable += 1;
        } else if (resolved.status === 'already_terminal') {
          summary.alreadyResolved += 1;
        } else if (resolved.snapshot.action.execution.status === 'succeeded') {
          summary.verifiedSucceeded += 1;
        } else {
          summary.verifiedFailed += 1;
        }
      } catch {
        summary.unavailable += 1;
      }
      return;
    }

    const retry = ['still_running', 'missing', 'unavailable'].includes(
      evidence.finding,
    );
    try {
      const observedAtMs = this.now();
      const recorded = await this.repository.recordFinding({
        dispatchId,
        expectedExecutionVersion: snapshot.action.execution.version,
        expectedRecoveryVersion: snapshot.recovery.version,
        owner: this.owner,
        leaseToken: snapshot.recovery.leaseToken!,
        findingMutationId: this.createId(),
        finding: evidence.finding,
        resultCode: evidence.resultCode,
        ...(evidence.evidenceDigest
          ? { evidenceDigest: evidence.evidenceDigest }
          : {}),
        observedAtMs,
        ...(retry
          ? {
              retryAtMs: this.nextRetryAt(
                observedAtMs,
                snapshot.recovery.findingCount + 1,
              ),
            }
          : {}),
      });
      if (recorded.recovery.status === 'manual_required') {
        summary.manualRequired += 1;
      } else {
        summary.deferred += 1;
      }
    } catch {
      summary.unavailable += 1;
    }
  }

  private assertEvidence(
    value: unknown,
  ): asserts value is ApprovedActionRecoveryEvidence {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Approved action recovery evidence is invalid');
    }
    if (
      !('finding' in value) ||
      ![
        'verified_succeeded',
        'verified_failed',
        'still_running',
        'missing',
        'conflict',
        'unsupported',
        'unavailable',
      ].includes(value.finding as string) ||
      !('resultCode' in value) ||
      typeof value.resultCode !== 'string'
    ) {
      throw new TypeError('Approved action recovery evidence is invalid');
    }
    assertApprovedActionResultCode(value.resultCode);
    const verified =
      value.finding === 'verified_succeeded' ||
      value.finding === 'verified_failed';
    if (
      !exactKeys(
        value,
        verified || 'evidenceDigest' in value
          ? ['finding', 'resultCode', 'evidenceDigest']
          : ['finding', 'resultCode'],
      )
    ) {
      throw new TypeError('Approved action recovery evidence is invalid');
    }
    if (verified && !('evidenceDigest' in value)) {
      throw new TypeError('Verified recovery evidence has no digest');
    }
    if ('evidenceDigest' in value) {
      if (typeof value.evidenceDigest !== 'string') {
        throw new TypeError('Approved action recovery evidence is invalid');
      }
      assertApprovedActionEvidenceDigest(value.evidenceDigest);
    }
  }

  private nextRetryAt(atMs: number, findingCount: number): number {
    const exponent = Math.max(0, Math.min(findingCount - 1, 30));
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent);
    return Math.min(Number.MAX_SAFE_INTEGER, atMs + delay);
  }

  private now(): number {
    const nowMs = this.clock();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new RangeError('clock must return a non-negative safe integer');
    }
    return nowMs;
  }
}
