import Logger from '../../../loaders/logger';
import type { ExecutionOrigin } from '../../domain/run';
import {
  parseDeploymentProfile,
  type DeploymentProfile,
} from '../../domain/deploymentProfile';
import { configuredLegacyShadowOrigins } from '../../compatibility/legacyExecutionBridge';
import { createLegacyLogArtifactId } from '../../compatibility/legacyTaskRevision';
import {
  LEGACY_SHADOW_STARTUP_OUTCOMES,
  type LegacyShadowStartupOriginSummary,
  type LegacyShadowStartupOutcomeCounts,
  type LegacyShadowStartupSummary,
} from '../../application/legacyShadowStartupReconciler';

export interface LegacyShadowStartupBudget {
  pageSize: number;
  maxPages: number;
}

export interface LegacyShadowStartupRequest extends LegacyShadowStartupBudget {
  origins: readonly ExecutionOrigin[];
  profile: 'edge' | 'standalone';
}

export const LEGACY_SHADOW_STARTUP_DIFFERENCE_REPORT_SCHEMA =
  'qinglong/legacy-shadow-startup-difference-report@v1';
export const LEGACY_SHADOW_STARTUP_METRIC_BATCH_SCHEMA =
  'qinglong/legacy-shadow-startup-metric-batch@v1';

export type LegacyShadowStartupAssessment =
  | 'converged'
  | 'waiting_external_callback'
  | 'incomplete'
  | 'attention_required';

export interface LegacyShadowStartupDifferenceReport {
  schemaVersion: 1;
  schema: typeof LEGACY_SHADOW_STARTUP_DIFFERENCE_REPORT_SCHEMA;
  profile: 'edge' | 'standalone';
  assessment: LegacyShadowStartupAssessment;
  configuredOriginCount: number;
  budget: {
    pageSize: number;
    maxPages: number;
    maxCandidates: number;
  };
  coverage: {
    pages: number;
    scanned: number;
    stopReason: LegacyShadowStartupSummary['stopReason'];
    remaining: boolean;
    resumeAvailable: boolean;
  };
  outcomes: LegacyShadowStartupOutcomeCounts;
  byOrigin: readonly LegacyShadowStartupOriginSummary[];
}

export interface LegacyShadowStartupMetricBatch {
  schemaVersion: 1;
  schema: typeof LEGACY_SHADOW_STARTUP_METRIC_BATCH_SCHEMA;
  dimensions: {
    profile: 'edge' | 'standalone';
    assessment: LegacyShadowStartupAssessment;
    stopReason: LegacyShadowStartupSummary['stopReason'];
  };
  values: LegacyShadowStartupOutcomeCounts & {
    configuredOrigins: number;
    pageSize: number;
    maxPages: number;
    maxCandidates: number;
    pages: number;
    scanned: number;
    remaining: 0 | 1;
    resumeAvailable: 0 | 1;
  };
  byOrigin: readonly LegacyShadowStartupOriginSummary[];
}

export type LegacyShadowStartupAudit =
  | {
      state: 'disabled';
    }
  | {
      state: 'profile_rejected';
      profile: 'cluster-control' | 'worker';
    }
  | {
      state: 'reconciled' | 'incomplete';
      profile: 'edge' | 'standalone';
      origins: number;
      summary: Omit<LegacyShadowStartupSummary, 'nextCursor' | 'byOrigin'> & {
        resumeAvailable: boolean;
      };
      report: LegacyShadowStartupDifferenceReport;
      metrics: LegacyShadowStartupMetricBatch;
    }
  | {
      state: 'failed';
      errorType: string;
    };

export interface BootstrapLegacyShadowStartupOptions {
  origins?: readonly ExecutionOrigin[];
  profile?: DeploymentProfile;
  execute?: (
    request: LegacyShadowStartupRequest,
  ) => Promise<LegacyShadowStartupSummary>;
  audit?: (record: LegacyShadowStartupAudit) => void | Promise<void>;
  collect?: (metrics: LegacyShadowStartupMetricBatch) => void | Promise<void>;
}

const BUDGETS: Readonly<
  Record<'edge' | 'standalone', LegacyShadowStartupBudget>
> = {
  edge: { pageSize: 8, maxPages: 1 },
  standalone: { pageSize: 32, maxPages: 4 },
};
const MAX_CONFIGURED_LEGACY_SHADOW_ORIGINS = 7;

function auditSummary(summary: LegacyShadowStartupSummary): Omit<
  LegacyShadowStartupSummary,
  'nextCursor' | 'byOrigin'
> & {
  resumeAvailable: boolean;
} {
  const { nextCursor, byOrigin: _byOrigin, ...bounded } = summary;
  return { ...bounded, resumeAvailable: nextCursor !== undefined };
}

function outcomeCounts(
  source: LegacyShadowStartupOutcomeCounts,
): LegacyShadowStartupOutcomeCounts {
  return Object.fromEntries(
    LEGACY_SHADOW_STARTUP_OUTCOMES.map((outcome) => [outcome, source[outcome]]),
  ) as LegacyShadowStartupOutcomeCounts;
}

function outcomeTotal(source: LegacyShadowStartupOutcomeCounts): number {
  return LEGACY_SHADOW_STARTUP_OUTCOMES.reduce(
    (total, outcome) => total + source[outcome],
    0,
  );
}

function assertCount(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} is outside its startup budget`);
  }
}

function assessment(
  summary: LegacyShadowStartupSummary,
): LegacyShadowStartupAssessment {
  if (summary.ambiguous > 0 || summary.skipped > 0 || summary.failed > 0) {
    return 'attention_required';
  }
  if (summary.remaining) return 'incomplete';
  if (summary.pending > 0) return 'waiting_external_callback';
  return 'converged';
}

export function createLegacyShadowStartupDifferenceReport(
  request: LegacyShadowStartupRequest,
  summary: LegacyShadowStartupSummary,
): LegacyShadowStartupDifferenceReport {
  const expectedBudget = BUDGETS[request.profile];
  if (
    request.pageSize !== expectedBudget.pageSize ||
    request.maxPages !== expectedBudget.maxPages
  ) {
    throw new RangeError('startup report budget does not match its Profile');
  }
  const configuredOrigins = [...new Set(request.origins)];
  if (
    configuredOrigins.length < 1 ||
    configuredOrigins.length > MAX_CONFIGURED_LEGACY_SHADOW_ORIGINS
  ) {
    throw new RangeError(
      'configured Shadow origin count is outside its budget',
    );
  }
  const maxCandidates = request.pageSize * request.maxPages;
  assertCount(summary.pages, 'pages', request.maxPages);
  if (summary.pages < 1) {
    throw new RangeError('pages must include the executed startup page');
  }
  assertCount(summary.scanned, 'scanned', request.pageSize * summary.pages);
  for (const outcome of LEGACY_SHADOW_STARTUP_OUTCOMES) {
    assertCount(summary[outcome], outcome, summary.scanned);
  }
  if (outcomeTotal(summary) !== summary.scanned) {
    throw new RangeError('startup outcomes do not conserve scanned candidates');
  }
  if (summary.remaining !== (summary.stopReason !== 'complete')) {
    throw new RangeError('startup remaining and stop reason disagree');
  }
  if (
    !['complete', 'page_limit', 'cursor_stalled'].includes(summary.stopReason)
  ) {
    throw new RangeError('startup stop reason is invalid');
  }
  if (summary.stopReason === 'page_limit' && summary.nextCursor === undefined) {
    throw new RangeError('page-limited startup summary has no resume cursor');
  }
  if (summary.stopReason !== 'page_limit' && summary.nextCursor !== undefined) {
    throw new RangeError('resume cursor is present without a page limit');
  }

  if (summary.byOrigin.length !== configuredOrigins.length) {
    throw new RangeError('origin outcome coverage is incomplete');
  }
  const origins = new Map<ExecutionOrigin, LegacyShadowStartupOriginSummary>();
  for (const origin of summary.byOrigin) {
    if (
      origins.has(origin.origin) ||
      !configuredOrigins.includes(origin.origin)
    ) {
      throw new RangeError('origin outcome coverage is invalid');
    }
    assertCount(origin.scanned, `${origin.origin}:scanned`, summary.scanned);
    for (const outcome of LEGACY_SHADOW_STARTUP_OUTCOMES) {
      assertCount(
        origin[outcome],
        `${origin.origin}:${outcome}`,
        origin.scanned,
      );
    }
    if (outcomeTotal(origin) !== origin.scanned) {
      throw new RangeError(
        'origin outcomes do not conserve scanned candidates',
      );
    }
    origins.set(origin.origin, {
      origin: origin.origin,
      scanned: origin.scanned,
      ...outcomeCounts(origin),
    });
  }
  const orderedOrigins = configuredOrigins.map(
    (origin) => origins.get(origin)!,
  );
  if (
    orderedOrigins.reduce((total, origin) => total + origin.scanned, 0) !==
      summary.scanned ||
    LEGACY_SHADOW_STARTUP_OUTCOMES.some(
      (outcome) =>
        orderedOrigins.reduce((total, origin) => total + origin[outcome], 0) !==
        summary[outcome],
    )
  ) {
    throw new RangeError('origin outcomes do not match aggregate outcomes');
  }

  return {
    schemaVersion: 1,
    schema: LEGACY_SHADOW_STARTUP_DIFFERENCE_REPORT_SCHEMA,
    profile: request.profile,
    assessment: assessment(summary),
    configuredOriginCount: configuredOrigins.length,
    budget: {
      pageSize: request.pageSize,
      maxPages: request.maxPages,
      maxCandidates,
    },
    coverage: {
      pages: summary.pages,
      scanned: summary.scanned,
      stopReason: summary.stopReason,
      remaining: summary.remaining,
      resumeAvailable: summary.nextCursor !== undefined,
    },
    outcomes: outcomeCounts(summary),
    byOrigin: orderedOrigins,
  };
}

export function createLegacyShadowStartupMetricBatch(
  report: LegacyShadowStartupDifferenceReport,
): LegacyShadowStartupMetricBatch {
  return {
    schemaVersion: 1,
    schema: LEGACY_SHADOW_STARTUP_METRIC_BATCH_SCHEMA,
    dimensions: {
      profile: report.profile,
      assessment: report.assessment,
      stopReason: report.coverage.stopReason,
    },
    values: {
      configuredOrigins: report.configuredOriginCount,
      pageSize: report.budget.pageSize,
      maxPages: report.budget.maxPages,
      maxCandidates: report.budget.maxCandidates,
      pages: report.coverage.pages,
      scanned: report.coverage.scanned,
      remaining: report.coverage.remaining ? 1 : 0,
      resumeAvailable: report.coverage.resumeAvailable ? 1 : 0,
      ...outcomeCounts(report.outcomes),
    },
    byOrigin: report.byOrigin.map((origin) => ({
      origin: origin.origin,
      scanned: origin.scanned,
      ...outcomeCounts(origin),
    })),
  };
}

async function executeDefault(
  request: LegacyShadowStartupRequest,
): Promise<LegacyShadowStartupSummary> {
  const [data, repositoryModule, sourceModule, writerModule, reconcilerModule] =
    await Promise.all([
      import('../../../data'),
      import('../legacy-sequelize/runRepository'),
      import('../legacy-sequelize/legacyShadowStartupRecoverySource'),
      import('../../application/legacyShadowRunWriter'),
      import('../../application/legacyShadowStartupReconciler'),
    ]);
  const repository = new repositoryModule.LegacySequelizeRunRepository(
    data.sequelize,
  );
  const source = new sourceModule.LegacySequelizeShadowStartupRecoverySource(
    data.sequelize,
    createLegacyLogArtifactId,
  );
  const writer = new writerModule.LegacyShadowRunWriter(repository);
  const reconciler = new reconcilerModule.LegacyShadowStartupReconciler(
    repository,
    source,
    writer,
  );
  return new reconcilerModule.LegacyShadowStartupSupervisor(reconciler).run({
    origins: request.origins,
    pageSize: request.pageSize,
    maxPages: request.maxPages,
  });
}

/**
 * Runs once after Legacy startup normalization and before HTTP listen. Disabled
 * and non-local Profiles never import a Repository or touch the database.
 */
export async function bootstrapLegacyShadowStartupReconciliation(
  options: BootstrapLegacyShadowStartupOptions = {},
): Promise<LegacyShadowStartupAudit> {
  const origins = [
    ...new Set(options.origins ?? configuredLegacyShadowOrigins()),
  ];
  const audit =
    options.audit ??
    ((record: LegacyShadowStartupAudit) => {
      Logger.info(`[ql3-shadow-startup] ${JSON.stringify(record)}`);
    });
  if (origins.length === 0) {
    const record: LegacyShadowStartupAudit = { state: 'disabled' };
    try {
      await audit(record);
    } catch {
      // Shadow audit output must not affect Legacy startup.
    }
    return record;
  }

  try {
    const profile =
      options.profile ??
      parseDeploymentProfile(process.env.QL_DEPLOYMENT_PROFILE);
    if (profile === 'cluster-control' || profile === 'worker') {
      const record: LegacyShadowStartupAudit = {
        state: 'profile_rejected',
        profile,
      };
      try {
        await audit(record);
      } catch {
        // Shadow audit output must not affect Legacy startup.
      }
      return record;
    }
    const request: LegacyShadowStartupRequest = {
      origins,
      profile,
      ...BUDGETS[profile],
    };
    const summary = await (options.execute ?? executeDefault)(request);
    const report = createLegacyShadowStartupDifferenceReport(request, summary);
    const metrics = createLegacyShadowStartupMetricBatch(report);
    const record: LegacyShadowStartupAudit = {
      state: report.assessment === 'converged' ? 'reconciled' : 'incomplete',
      profile,
      origins: origins.length,
      summary: auditSummary(summary),
      report,
      metrics,
    };
    try {
      await audit(record);
    } catch {
      // Shadow audit output must not affect Legacy startup.
    }
    try {
      await options.collect?.(metrics);
    } catch {
      // Shadow metric collection must not affect Legacy startup.
    }
    return record;
  } catch (error) {
    const record: LegacyShadowStartupAudit = {
      state: 'failed',
      errorType: error instanceof Error ? error.name : 'unknown',
    };
    try {
      await audit(record);
    } catch {
      // Shadow audit output must not affect Legacy startup.
    }
    return record;
  }
}
