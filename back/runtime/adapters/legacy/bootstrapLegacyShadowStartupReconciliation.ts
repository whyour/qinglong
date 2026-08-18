import Logger from '../../../loaders/logger';
import type { ExecutionOrigin } from '../../domain/run';
import {
  parseDeploymentProfile,
  type DeploymentProfile,
} from '../../domain/deploymentProfile';
import { configuredLegacyShadowOrigins } from '../../compatibility/legacyExecutionBridge';
import { createLegacyLogArtifactId } from '../../compatibility/legacyTaskRevision';
import type { LegacyShadowStartupSummary } from '../../application/legacyShadowStartupReconciler';

export interface LegacyShadowStartupBudget {
  pageSize: number;
  maxPages: number;
}

export interface LegacyShadowStartupRequest extends LegacyShadowStartupBudget {
  origins: readonly ExecutionOrigin[];
  profile: 'edge' | 'standalone';
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
      summary: Omit<LegacyShadowStartupSummary, 'nextCursor'> & {
        resumeAvailable: boolean;
      };
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
}

const BUDGETS: Readonly<
  Record<'edge' | 'standalone', LegacyShadowStartupBudget>
> = {
  edge: { pageSize: 8, maxPages: 1 },
  standalone: { pageSize: 32, maxPages: 4 },
};

function auditSummary(summary: LegacyShadowStartupSummary): Omit<
  LegacyShadowStartupSummary,
  'nextCursor'
> & {
  resumeAvailable: boolean;
} {
  const { nextCursor, ...bounded } = summary;
  return { ...bounded, resumeAvailable: nextCursor !== undefined };
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
    const summary = await (options.execute ?? executeDefault)({
      origins,
      profile,
      ...BUDGETS[profile],
    });
    const record: LegacyShadowStartupAudit = {
      state: summary.remaining ? 'incomplete' : 'reconciled',
      profile,
      origins: origins.length,
      summary: auditSummary(summary),
    };
    try {
      await audit(record);
    } catch {
      // Shadow audit output must not affect Legacy startup.
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
