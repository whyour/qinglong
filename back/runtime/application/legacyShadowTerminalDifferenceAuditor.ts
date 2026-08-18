import type {
  ExecutionOrigin,
  RunAttemptStatus,
  RunStatus,
} from '../domain/run';
import { EXECUTION_ORIGINS } from '../domain/run';
import {
  MAX_LEGACY_SHADOW_TERMINAL_EVIDENCE_PER_PAGE,
  MAX_LEGACY_SHADOW_TERMINAL_PAGE_SIZE,
  type LegacyShadowTerminalAttemptEvidence,
  type LegacyShadowTerminalCandidate,
  type LegacyShadowTerminalCursor,
  type LegacyShadowTerminalDifferenceSource,
  type LegacyShadowTerminalPage,
  type LegacyTerminalEvidence,
  type LegacyTerminalOutcome,
} from '../ports/legacyShadowTerminalDifference';

export type LegacyShadowTerminalAuditProfile = 'edge' | 'standalone';

export const LEGACY_SHADOW_TERMINAL_CATEGORIES = Object.freeze([
  'matched',
  'shadow_not_terminal',
  'shadow_attempt_missing',
  'shadow_attempt_ambiguous',
  'legacy_evidence_missing',
  'legacy_evidence_ambiguous',
  'status_mismatch',
  'field_mismatch',
] as const);

export type LegacyShadowTerminalCategory =
  (typeof LEGACY_SHADOW_TERMINAL_CATEGORIES)[number];

export type LegacyShadowTerminalCategoryCounts = Record<
  LegacyShadowTerminalCategory,
  number
>;

export interface LegacyShadowTerminalDimensionCounts {
  compared: number;
  matched: number;
  mismatched: number;
  unavailable: number;
}

export interface LegacyShadowTerminalDimensions {
  status: LegacyShadowTerminalDimensionCounts;
  exitCode: LegacyShadowTerminalDimensionCounts;
  startedAt: LegacyShadowTerminalDimensionCounts;
  finishedAt: LegacyShadowTerminalDimensionCounts;
  logArtifact: LegacyShadowTerminalDimensionCounts;
}

export interface LegacyShadowTerminalOriginSummary
  extends LegacyShadowTerminalCategoryCounts {
  origin: ExecutionOrigin;
  scanned: number;
}

export type LegacyShadowTerminalAuditAssessment =
  | 'matched'
  | 'empty'
  | 'differences_found'
  | 'window_open'
  | 'incomplete';

export type LegacyShadowTerminalAuditStopReason =
  | 'complete'
  | 'page_limit'
  | 'cursor_stalled';

export interface LegacyShadowTerminalDifferenceReport {
  schema: 'qinglong/legacy-shadow-terminal-difference-report@v1';
  profile: LegacyShadowTerminalAuditProfile;
  observedAtMs: number;
  window: {
    basis: 'shadow_run_created_at';
    startInclusiveMs: number;
    endExclusiveMs: number;
    minimumSettlingAgeMs: number;
    closed: boolean;
  };
  coverage: {
    direction: 'shadow_to_legacy';
    cohort: 'legacy_owned_shadow_runs';
    legacyWithoutShadow: 'not_measured';
  };
  budget: { pageSize: number; maxPages: number; maxCandidates: number };
  pages: number;
  scanned: number;
  stopReason: LegacyShadowTerminalAuditStopReason;
  remaining: boolean;
  evidenceComplete: boolean;
  evidenceOverflowPages: number;
  assessment: LegacyShadowTerminalAuditAssessment;
  counts: LegacyShadowTerminalCategoryCounts;
  byOrigin: readonly LegacyShadowTerminalOriginSummary[];
  dimensions: LegacyShadowTerminalDimensions;
  terminalAgreementPermille?: number;
  fullyComparablePermille?: number;
}

export interface LegacyShadowTerminalAuditorOptions {
  profile: LegacyShadowTerminalAuditProfile;
  projectId?: string;
  origins: readonly ExecutionOrigin[];
  windowStartMs: number;
  windowEndMs: number;
  observedAtMs?: number;
  minimumSettlingAgeMs?: number;
  correlationToleranceMs?: number;
  clock?: { now(): number };
}

interface Selection {
  status: 'matched' | 'missing' | 'ambiguous';
  evidence?: LegacyTerminalEvidence;
}

interface Classification {
  category: LegacyShadowTerminalCategory;
  fullyComparable: boolean;
}

const BUDGETS: Readonly<
  Record<
    LegacyShadowTerminalAuditProfile,
    { pageSize: number; maxPages: number }
  >
> = {
  edge: { pageSize: 8, maxPages: 1 },
  standalone: { pageSize: 32, maxPages: 4 },
};

const MAX_CONFIGURED_ORIGINS = 7;
const MAX_CORRELATION_TOLERANCE_MS = 60_000;
const EXECUTION_ORIGIN_SET = new Set<ExecutionOrigin>(EXECUTION_ORIGINS);

function assertSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function emptyCounts(): LegacyShadowTerminalCategoryCounts {
  return Object.fromEntries(
    LEGACY_SHADOW_TERMINAL_CATEGORIES.map((category) => [category, 0]),
  ) as LegacyShadowTerminalCategoryCounts;
}

function emptyDimension(): LegacyShadowTerminalDimensionCounts {
  return { compared: 0, matched: 0, mismatched: 0, unavailable: 0 };
}

function emptyDimensions(): LegacyShadowTerminalDimensions {
  return {
    status: emptyDimension(),
    exitCode: emptyDimension(),
    startedAt: emptyDimension(),
    finishedAt: emptyDimension(),
    logArtifact: emptyDimension(),
  };
}

function originSummary(
  origin: ExecutionOrigin,
): LegacyShadowTerminalOriginSummary {
  return { origin, scanned: 0, ...emptyCounts() };
}

function compareDimension(
  target: LegacyShadowTerminalDimensionCounts,
  left: unknown,
  right: unknown,
  matches: (left: unknown, right: unknown) => boolean = (a, b) => a === b,
): boolean | undefined {
  if (left === undefined || right === undefined) {
    target.unavailable += 1;
    return undefined;
  }
  target.compared += 1;
  if (matches(left, right)) {
    target.matched += 1;
    return true;
  }
  target.mismatched += 1;
  return false;
}

function markUnavailable(dimensions: LegacyShadowTerminalDimensions): void {
  for (const dimension of Object.values(dimensions)) {
    dimension.unavailable += 1;
  }
}

function expectedOutcome(
  status: RunStatus | RunAttemptStatus,
): LegacyTerminalOutcome | undefined {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'stopped';
  return undefined;
}

function isTerminalShadowStatus(status: RunStatus | RunAttemptStatus): boolean {
  return ['succeeded', 'failed', 'cancelled', 'timed_out', 'lost'].includes(
    status,
  );
}

function selectEvidence(
  candidate: LegacyShadowTerminalCandidate,
  attempt: LegacyShadowTerminalAttemptEvidence,
  evidence: readonly LegacyTerminalEvidence[],
  toleranceMs: number,
): Selection {
  const direct = evidence.filter(
    (item) =>
      item.attemptId === attempt.attemptId || item.runId === candidate.runId,
  );
  if (
    direct.some(
      (item) =>
        (item.attemptId !== undefined &&
          item.attemptId !== attempt.attemptId) ||
        (item.runId !== undefined && item.runId !== candidate.runId),
    )
  ) {
    return { status: 'ambiguous' };
  }
  if (direct.length === 1) return { status: 'matched', evidence: direct[0] };
  if (direct.length > 1) return { status: 'ambiguous' };
  if (candidate.legacyCronId === undefined) return { status: 'missing' };

  const sameCron = evidence.filter(
    (item) => item.legacyCronId === candidate.legacyCronId,
  );
  const byLog =
    attempt.logArtifactId === undefined
      ? []
      : sameCron.filter((item) => item.logArtifactId === attempt.logArtifactId);
  const byPid =
    attempt.pid === undefined
      ? []
      : sameCron.filter((item) => item.pid === attempt.pid);

  if (attempt.logArtifactId !== undefined && attempt.pid !== undefined) {
    const byPidSet = new Set(byPid);
    const intersection = byLog.filter((item) => byPidSet.has(item));
    if (intersection.length === 1) {
      return { status: 'matched', evidence: intersection[0] };
    }
    if (intersection.length > 1 || byLog.length > 1 || byPid.length > 1) {
      return { status: 'ambiguous' };
    }
    if (byLog.length === 1 && byPid.length === 0) {
      return { status: 'matched', evidence: byLog[0] };
    }
    if (byPid.length === 1 && byLog.length === 0) {
      return { status: 'matched', evidence: byPid[0] };
    }
    if (byLog.length === 1 && byPid.length === 1) {
      return { status: 'ambiguous' };
    }
  } else if (byLog.length === 1) {
    return { status: 'matched', evidence: byLog[0] };
  } else if (byLog.length > 1) {
    return { status: 'ambiguous' };
  } else if (byPid.length === 1) {
    return { status: 'matched', evidence: byPid[0] };
  } else if (byPid.length > 1) {
    return { status: 'ambiguous' };
  }

  const shadowStartedAtMs = attempt.startedAtMs ?? candidate.startedAtMs;
  if (shadowStartedAtMs === undefined) return { status: 'missing' };
  const byStart = sameCron.filter(
    (item) => Math.abs(item.startedAtMs - shadowStartedAtMs) <= toleranceMs,
  );
  if (byStart.length === 1) {
    return { status: 'matched', evidence: byStart[0] };
  }
  return { status: byStart.length > 1 ? 'ambiguous' : 'missing' };
}

function classify(
  candidate: LegacyShadowTerminalCandidate,
  evidence: readonly LegacyTerminalEvidence[],
  evidenceTruncated: boolean,
  toleranceMs: number,
  dimensions: LegacyShadowTerminalDimensions,
): Classification {
  if (
    !isTerminalShadowStatus(candidate.runStatus) ||
    candidate.finishedAtMs === undefined
  ) {
    markUnavailable(dimensions);
    return { category: 'shadow_not_terminal', fullyComparable: false };
  }
  if (candidate.attemptCount === 0 || candidate.attempt === undefined) {
    markUnavailable(dimensions);
    return { category: 'shadow_attempt_missing', fullyComparable: false };
  }
  if (candidate.attemptCount !== 1) {
    markUnavailable(dimensions);
    return { category: 'shadow_attempt_ambiguous', fullyComparable: false };
  }
  if (
    !isTerminalShadowStatus(candidate.attempt.status) ||
    candidate.attempt.finishedAtMs === undefined
  ) {
    markUnavailable(dimensions);
    return { category: 'shadow_not_terminal', fullyComparable: false };
  }
  if (evidenceTruncated) {
    markUnavailable(dimensions);
    return { category: 'legacy_evidence_ambiguous', fullyComparable: false };
  }

  const selection = selectEvidence(
    candidate,
    candidate.attempt,
    evidence,
    toleranceMs,
  );
  if (selection.status === 'ambiguous') {
    markUnavailable(dimensions);
    return { category: 'legacy_evidence_ambiguous', fullyComparable: false };
  }
  if (selection.status === 'missing' || selection.evidence === undefined) {
    markUnavailable(dimensions);
    return { category: 'legacy_evidence_missing', fullyComparable: false };
  }

  const expectedRunOutcome = expectedOutcome(candidate.runStatus);
  const expectedAttemptOutcome = expectedOutcome(candidate.attempt.status);
  let statusMatches: boolean | undefined;
  if (
    expectedRunOutcome === undefined ||
    expectedAttemptOutcome === undefined
  ) {
    dimensions.status.unavailable += 1;
  } else if (expectedRunOutcome !== expectedAttemptOutcome) {
    dimensions.status.compared += 1;
    dimensions.status.mismatched += 1;
    statusMatches = false;
  } else {
    statusMatches = compareDimension(
      dimensions.status,
      expectedRunOutcome,
      selection.evidence.outcome,
    );
  }
  if (
    expectedRunOutcome === undefined ||
    expectedAttemptOutcome === undefined ||
    expectedRunOutcome !== expectedAttemptOutcome ||
    statusMatches !== true
  ) {
    for (const dimension of [
      dimensions.exitCode,
      dimensions.startedAt,
      dimensions.finishedAt,
      dimensions.logArtifact,
    ]) {
      dimension.unavailable += 1;
    }
    return { category: 'status_mismatch', fullyComparable: false };
  }

  const exitMatches = compareDimension(
    dimensions.exitCode,
    candidate.attempt.exitCode,
    selection.evidence.exitCode,
  );
  const startMatches = compareDimension(
    dimensions.startedAt,
    candidate.attempt.startedAtMs ?? candidate.startedAtMs,
    selection.evidence.startedAtMs,
    (left, right) => Math.abs(Number(left) - Number(right)) <= toleranceMs,
  );
  const finishMatches = compareDimension(
    dimensions.finishedAt,
    candidate.attempt.finishedAtMs ?? candidate.finishedAtMs,
    selection.evidence.finishedAtMs,
    (left, right) => Math.abs(Number(left) - Number(right)) <= toleranceMs,
  );
  const logMatches = compareDimension(
    dimensions.logArtifact,
    candidate.attempt.logArtifactId,
    selection.evidence.logArtifactId,
  );
  const compared = [true, exitMatches, startMatches, finishMatches, logMatches];
  const hasMismatch = compared.includes(false);
  return {
    category: hasMismatch ? 'field_mismatch' : 'matched',
    fullyComparable: compared.every((value) => value === true),
  };
}

function sameCursor(
  left: LegacyShadowTerminalCursor | undefined,
  right: LegacyShadowTerminalCursor,
): boolean {
  return (
    left !== undefined &&
    left.createdAtMs === right.createdAtMs &&
    left.runId === right.runId
  );
}

function validatePage(
  page: LegacyShadowTerminalPage,
  cursor: LegacyShadowTerminalCursor | undefined,
  limit: number,
  allowedOrigins: ReadonlySet<ExecutionOrigin>,
  windowStartMs: number,
  windowEndMs: number,
): void {
  if (page.candidates.length > limit) {
    throw new Error('Legacy Shadow terminal source exceeded candidate limit');
  }
  if (
    page.evidence.length >
    Math.min(
      MAX_LEGACY_SHADOW_TERMINAL_EVIDENCE_PER_PAGE,
      page.candidates.length * 8,
    )
  ) {
    throw new Error('Legacy Shadow terminal source exceeded evidence limit');
  }
  let previous = cursor;
  const runIds = new Set<string>();
  for (const candidate of page.candidates) {
    if (
      candidate.runId.length === 0 ||
      runIds.has(candidate.runId) ||
      !allowedOrigins.has(candidate.origin) ||
      !Number.isSafeInteger(candidate.createdAtMs) ||
      candidate.createdAtMs < windowStartMs ||
      candidate.createdAtMs >= windowEndMs ||
      (previous !== undefined &&
        (candidate.createdAtMs < previous.createdAtMs ||
          (candidate.createdAtMs === previous.createdAtMs &&
            candidate.runId <= previous.runId)))
    ) {
      throw new Error('Legacy Shadow terminal source returned an invalid page');
    }
    runIds.add(candidate.runId);
    previous = { createdAtMs: candidate.createdAtMs, runId: candidate.runId };
  }
  if (page.truncated) {
    if (
      page.candidates.length !== limit ||
      page.nextCursor === undefined ||
      previous === undefined ||
      page.nextCursor.createdAtMs !== previous.createdAtMs ||
      page.nextCursor.runId !== previous.runId
    ) {
      throw new Error(
        'Legacy Shadow terminal source returned an invalid cursor',
      );
    }
  } else if (page.nextCursor !== undefined) {
    throw new Error('Completed Legacy Shadow terminal page returned a cursor');
  }
}

function permille(numerator: number, denominator: number): number {
  return Math.floor((numerator * 1_000) / denominator);
}

/**
 * Explicit, timer-free audit for a closed Shadow cohort. The report deliberately
 * does not claim Legacy-to-Shadow capture coverage because RunningInstances have
 * no trustworthy execution-origin field in the 2.x schema.
 */
export class LegacyShadowTerminalDifferenceAuditor {
  constructor(private readonly source: LegacyShadowTerminalDifferenceSource) {}

  async run(
    options: LegacyShadowTerminalAuditorOptions,
  ): Promise<LegacyShadowTerminalDifferenceReport> {
    if (!['edge', 'standalone'].includes(options.profile)) {
      throw new RangeError('profile must be edge or standalone');
    }
    const projectId = options.projectId ?? 'default';
    if (projectId.length < 1 || projectId.length > 128) {
      throw new RangeError('projectId length is invalid');
    }
    const origins = [...new Set(options.origins)];
    if (origins.length < 1 || origins.length > MAX_CONFIGURED_ORIGINS) {
      throw new RangeError('origin count is outside its audit budget');
    }
    if (origins.some((origin) => !EXECUTION_ORIGIN_SET.has(origin))) {
      throw new RangeError('terminal audit origin is invalid');
    }
    assertSafeInteger('windowStartMs', options.windowStartMs);
    assertSafeInteger('windowEndMs', options.windowEndMs);
    if (options.windowStartMs >= options.windowEndMs) {
      throw new RangeError('terminal audit window must be non-empty');
    }
    const observedAtMs =
      options.observedAtMs ?? options.clock?.now() ?? Date.now();
    const minimumSettlingAgeMs = options.minimumSettlingAgeMs ?? 5 * 60_000;
    const correlationToleranceMs = options.correlationToleranceMs ?? 2_000;
    assertSafeInteger('observedAtMs', observedAtMs);
    assertSafeInteger('minimumSettlingAgeMs', minimumSettlingAgeMs);
    assertSafeInteger('correlationToleranceMs', correlationToleranceMs);
    if (correlationToleranceMs > MAX_CORRELATION_TOLERANCE_MS) {
      throw new RangeError('correlationToleranceMs exceeds its hard limit');
    }
    const budget = BUDGETS[options.profile];
    if (budget.pageSize > MAX_LEGACY_SHADOW_TERMINAL_PAGE_SIZE) {
      throw new RangeError('terminal audit Profile exceeds the source limit');
    }

    const counts = emptyCounts();
    const dimensions = emptyDimensions();
    const originSummaries = new Map(
      origins.map((origin) => [origin, originSummary(origin)]),
    );
    const allowedOrigins = new Set(origins);
    let cursor: LegacyShadowTerminalCursor | undefined;
    let pages = 0;
    let scanned = 0;
    let fullyComparable = 0;
    let evidenceOverflowPages = 0;
    let remaining = false;
    let stopReason: LegacyShadowTerminalAuditStopReason = 'complete';

    while (pages < budget.maxPages) {
      const page = await this.source.listCandidates({
        projectId,
        origins,
        windowStartMs: options.windowStartMs,
        windowEndMs: options.windowEndMs,
        observedAtMs,
        correlationToleranceMs,
        ...(cursor === undefined ? {} : { cursor }),
        limit: budget.pageSize,
      });
      pages += 1;
      validatePage(
        page,
        cursor,
        budget.pageSize,
        allowedOrigins,
        options.windowStartMs,
        options.windowEndMs,
      );
      if (page.evidenceTruncated) evidenceOverflowPages += 1;

      for (const candidate of page.candidates) {
        const result = classify(
          candidate,
          page.evidence,
          page.evidenceTruncated,
          correlationToleranceMs,
          dimensions,
        );
        counts[result.category] += 1;
        const perOrigin = originSummaries.get(candidate.origin)!;
        perOrigin.scanned += 1;
        perOrigin[result.category] += 1;
        scanned += 1;
        if (result.fullyComparable) fullyComparable += 1;
      }

      if (!page.truncated) break;
      if (
        page.nextCursor === undefined ||
        sameCursor(cursor, page.nextCursor)
      ) {
        remaining = true;
        stopReason = 'cursor_stalled';
        break;
      }
      cursor = page.nextCursor;
      if (pages === budget.maxPages) {
        remaining = true;
        stopReason = 'page_limit';
      }
    }

    const windowClosed =
      options.windowEndMs <= observedAtMs - minimumSettlingAgeMs;
    const evidenceComplete = evidenceOverflowPages === 0;
    const assessment: LegacyShadowTerminalAuditAssessment = !windowClosed
      ? 'window_open'
      : remaining || !evidenceComplete
      ? 'incomplete'
      : scanned === 0
      ? 'empty'
      : counts.matched === scanned
      ? 'matched'
      : 'differences_found';
    const ratiosAvailable =
      windowClosed && !remaining && evidenceComplete && scanned > 0;

    return {
      schema: 'qinglong/legacy-shadow-terminal-difference-report@v1',
      profile: options.profile,
      observedAtMs,
      window: {
        basis: 'shadow_run_created_at',
        startInclusiveMs: options.windowStartMs,
        endExclusiveMs: options.windowEndMs,
        minimumSettlingAgeMs,
        closed: windowClosed,
      },
      coverage: {
        direction: 'shadow_to_legacy',
        cohort: 'legacy_owned_shadow_runs',
        legacyWithoutShadow: 'not_measured',
      },
      budget: {
        pageSize: budget.pageSize,
        maxPages: budget.maxPages,
        maxCandidates: budget.pageSize * budget.maxPages,
      },
      pages,
      scanned,
      stopReason,
      remaining,
      evidenceComplete,
      evidenceOverflowPages,
      assessment,
      counts,
      byOrigin: [...originSummaries.values()],
      dimensions,
      ...(ratiosAvailable
        ? {
            terminalAgreementPermille: permille(counts.matched, scanned),
            fullyComparablePermille: permille(fullyComparable, scanned),
          }
        : {}),
    };
  }
}
