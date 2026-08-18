import { randomUUID } from 'crypto';
import type { ExecutionOrigin } from '../domain/run';

export const LEGACY_SHADOW_CAPTURE_SNAPSHOT_SCHEMA =
  'qinglong/legacy-shadow-capture-snapshot@v1';
export const LEGACY_SHADOW_CAPTURE_REPORT_SCHEMA =
  'qinglong/legacy-shadow-capture-report@v1';

export type LegacyShadowCaptureFailureStage =
  | 'fact'
  | 'observer'
  | 'initialization'
  | 'accept';

export interface LegacyShadowCaptureCounts {
  admitted: number;
  captured: number;
  failed: number;
  pending: number;
  failures: Record<LegacyShadowCaptureFailureStage, number>;
}

export interface LegacyShadowCaptureOriginSnapshot
  extends LegacyShadowCaptureCounts {
  origin: ExecutionOrigin;
}

export interface LegacyShadowCaptureSnapshot {
  schema: typeof LEGACY_SHADOW_CAPTURE_SNAPSHOT_SCHEMA;
  epoch: string;
  observedAtMs: number;
  byOrigin: readonly LegacyShadowCaptureOriginSnapshot[];
}

export interface LegacyShadowCaptureReport {
  schema: typeof LEGACY_SHADOW_CAPTURE_REPORT_SCHEMA;
  profile: 'edge' | 'standalone';
  assessment: 'captured' | 'empty' | 'incomplete' | 'failures_observed';
  epoch: string;
  window: {
    basis: 'process_local_legacy_admission';
    startInclusiveMs: number;
    endExclusiveMs: number;
  };
  configuredOriginCount: number;
  totals: LegacyShadowCaptureCounts;
  byOrigin: readonly LegacyShadowCaptureOriginSnapshot[];
  capturePermille?: number;
}

export interface LegacyShadowCaptureAdmission {
  captured(): void;
  failed(stage: LegacyShadowCaptureFailureStage): void;
}

const FAILURE_STAGES: readonly LegacyShadowCaptureFailureStage[] = [
  'fact',
  'observer',
  'initialization',
  'accept',
];

function emptyCounts(): LegacyShadowCaptureCounts {
  return {
    admitted: 0,
    captured: 0,
    failed: 0,
    pending: 0,
    failures: { fact: 0, observer: 0, initialization: 0, accept: 0 },
  };
}

function cloneCounts(
  source: LegacyShadowCaptureCounts,
): LegacyShadowCaptureCounts {
  return {
    admitted: source.admitted,
    captured: source.captured,
    failed: source.failed,
    pending: source.pending,
    failures: { ...source.failures },
  };
}

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertConserved(
  counts: LegacyShadowCaptureCounts,
  label: string,
): void {
  for (const key of ['admitted', 'captured', 'failed', 'pending'] as const) {
    assertCount(counts[key], `${label}.${key}`);
  }
  for (const stage of FAILURE_STAGES) {
    assertCount(counts.failures[stage], `${label}.failures.${stage}`);
  }
  if (counts.captured + counts.failed + counts.pending !== counts.admitted) {
    throw new RangeError(`${label} does not conserve admitted executions`);
  }
  if (
    FAILURE_STAGES.reduce(
      (total, stage) => total + counts.failures[stage],
      0,
    ) !== counts.failed
  ) {
    throw new RangeError(`${label} failure stages do not conserve failures`);
  }
}

function originMap(
  snapshot: LegacyShadowCaptureSnapshot,
): Map<ExecutionOrigin, LegacyShadowCaptureOriginSnapshot> {
  if (snapshot.schema !== LEGACY_SHADOW_CAPTURE_SNAPSHOT_SCHEMA) {
    throw new TypeError('Legacy Shadow capture snapshot schema is unsupported');
  }
  if (!/^[0-9a-f-]{36}$/u.test(snapshot.epoch)) {
    throw new TypeError('Legacy Shadow capture epoch is invalid');
  }
  assertCount(snapshot.observedAtMs, 'snapshot.observedAtMs');
  const result = new Map<ExecutionOrigin, LegacyShadowCaptureOriginSnapshot>();
  for (const entry of snapshot.byOrigin) {
    if (result.has(entry.origin)) {
      throw new RangeError('Legacy Shadow capture snapshot repeats an origin');
    }
    assertConserved(entry, `snapshot.${entry.origin}`);
    result.set(entry.origin, entry);
  }
  return result;
}

function subtractCounts(
  before: LegacyShadowCaptureCounts,
  after: LegacyShadowCaptureCounts,
  label: string,
): LegacyShadowCaptureCounts {
  const result = emptyCounts();
  for (const key of ['admitted', 'captured', 'failed'] as const) {
    result[key] = after[key] - before[key];
    assertCount(result[key], `${label}.${key}`);
  }
  if (before.pending !== 0) {
    throw new RangeError(`${label} starts with pending capture work`);
  }
  result.pending = after.pending;
  for (const stage of FAILURE_STAGES) {
    result.failures[stage] = after.failures[stage] - before.failures[stage];
    assertCount(result.failures[stage], `${label}.failures.${stage}`);
  }
  assertConserved(result, label);
  return result;
}

export class LegacyShadowCaptureAuthority {
  private readonly epoch: string;
  private readonly counts = new Map<
    ExecutionOrigin,
    LegacyShadowCaptureCounts
  >();

  constructor(
    private readonly clock: { now(): number } = { now: Date.now },
    epoch: string = randomUUID(),
  ) {
    if (!/^[0-9a-f-]{36}$/u.test(epoch)) {
      throw new TypeError('Legacy Shadow capture epoch is invalid');
    }
    this.epoch = epoch;
  }

  admit(origin: ExecutionOrigin): LegacyShadowCaptureAdmission {
    const counts = this.counts.get(origin) ?? emptyCounts();
    if (!this.counts.has(origin)) this.counts.set(origin, counts);
    counts.admitted += 1;
    counts.pending += 1;
    let settled = false;
    return Object.freeze({
      captured: () => {
        if (settled) return;
        settled = true;
        counts.pending -= 1;
        counts.captured += 1;
      },
      failed: (stage: LegacyShadowCaptureFailureStage) => {
        if (settled) return;
        if (!FAILURE_STAGES.includes(stage)) {
          throw new TypeError('Legacy Shadow capture failure stage is invalid');
        }
        settled = true;
        counts.pending -= 1;
        counts.failed += 1;
        counts.failures[stage] += 1;
      },
    });
  }

  snapshot(origins: readonly ExecutionOrigin[]): LegacyShadowCaptureSnapshot {
    const observedAtMs = this.clock.now();
    assertCount(observedAtMs, 'snapshot.observedAtMs');
    const configured = [...new Set(origins)];
    return Object.freeze({
      schema: LEGACY_SHADOW_CAPTURE_SNAPSHOT_SCHEMA,
      epoch: this.epoch,
      observedAtMs,
      byOrigin: configured.map((origin) =>
        Object.freeze({
          origin,
          ...cloneCounts(this.counts.get(origin) ?? emptyCounts()),
        }),
      ),
    });
  }
}

export function createLegacyShadowCaptureReport(
  profile: 'edge' | 'standalone',
  origins: readonly ExecutionOrigin[],
  before: LegacyShadowCaptureSnapshot,
  after: LegacyShadowCaptureSnapshot,
): LegacyShadowCaptureReport {
  if (profile !== 'edge' && profile !== 'standalone') {
    throw new TypeError('Legacy Shadow capture profile is invalid');
  }
  const configured = [...new Set(origins)];
  if (configured.length < 1 || configured.length > 7) {
    throw new RangeError('Legacy Shadow capture origin count is invalid');
  }
  if (before.epoch !== after.epoch) {
    throw new RangeError(
      'Legacy Shadow capture snapshots cross process epochs',
    );
  }
  if (before.observedAtMs >= after.observedAtMs) {
    throw new RangeError('Legacy Shadow capture window must be non-empty');
  }
  const beforeOrigins = originMap(before);
  const afterOrigins = originMap(after);
  if (
    beforeOrigins.size !== configured.length ||
    afterOrigins.size !== configured.length ||
    configured.some(
      (origin) => !beforeOrigins.has(origin) || !afterOrigins.has(origin),
    )
  ) {
    throw new RangeError('Legacy Shadow capture origin coverage is incomplete');
  }
  const totals = emptyCounts();
  const byOrigin = configured.map((origin) => {
    const counts = subtractCounts(
      beforeOrigins.get(origin)!,
      afterOrigins.get(origin)!,
      `capture.${origin}`,
    );
    for (const key of ['admitted', 'captured', 'failed', 'pending'] as const) {
      totals[key] += counts[key];
    }
    for (const stage of FAILURE_STAGES) {
      totals.failures[stage] += counts.failures[stage];
    }
    return Object.freeze({ origin, ...counts });
  });
  assertConserved(totals, 'capture.totals');
  const assessment =
    totals.pending > 0
      ? 'incomplete'
      : totals.failed > 0
      ? 'failures_observed'
      : totals.admitted === 0
      ? 'empty'
      : 'captured';
  const report: LegacyShadowCaptureReport = {
    schema: LEGACY_SHADOW_CAPTURE_REPORT_SCHEMA,
    profile,
    assessment,
    epoch: before.epoch,
    window: {
      basis: 'process_local_legacy_admission' as const,
      startInclusiveMs: before.observedAtMs,
      endExclusiveMs: after.observedAtMs,
    },
    configuredOriginCount: configured.length,
    totals,
    byOrigin,
    ...(totals.admitted > 0
      ? {
          capturePermille: Math.floor(
            (totals.captured * 1_000) / totals.admitted,
          ),
        }
      : {}),
  };
  return Object.freeze(report);
}
