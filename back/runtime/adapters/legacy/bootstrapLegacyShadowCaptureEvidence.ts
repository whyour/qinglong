import fs from 'fs/promises';
import path from 'path';
import config from '../../../config';
import Logger from '../../../loaders/logger';
import {
  createLegacyShadowCaptureReport,
  type LegacyShadowCaptureReport,
  type LegacyShadowCaptureSnapshot,
} from '../../application/legacyShadowCaptureAuthority';
import {
  configuredLegacyShadowOrigins,
  legacyShadowCaptureSnapshot,
} from '../../compatibility/legacyExecutionBridge';
import {
  parseDeploymentProfile,
  type DeploymentProfile,
} from '../../domain/deploymentProfile';
import type { ExecutionOrigin } from '../../domain/run';
import type {
  LegacyShadowStartupAudit,
  LegacyShadowStartupDifferenceReport,
} from './bootstrapLegacyShadowStartupReconciliation';

export const LEGACY_SHADOW_CAPTURE_EVIDENCE_SCHEMA =
  'qinglong/legacy-shadow-capture-evidence@v1';
export const LEGACY_SHADOW_CAPTURE_EVIDENCE_FILE_ENV =
  'QL3_SHADOW_CAPTURE_EVIDENCE_FILE';

export interface LegacyShadowCaptureEvidence {
  schema: typeof LEGACY_SHADOW_CAPTURE_EVIDENCE_SCHEMA;
  profile: 'edge' | 'standalone';
  startup: LegacyShadowStartupDifferenceReport;
  capture: LegacyShadowCaptureReport;
  qualification: {
    passed: boolean;
    startupConverged: boolean;
    originCoverageExact: boolean;
    captureComplete: boolean;
  };
}

export type LegacyShadowCaptureEvidenceAudit =
  | { state: 'disabled' }
  | { state: 'profile_rejected'; profile: 'cluster-control' | 'worker' }
  | { state: 'armed'; profile: 'edge' | 'standalone'; origins: number }
  | {
      state: 'exported';
      profile: 'edge' | 'standalone';
      origins: number;
      qualified: boolean;
    }
  | { state: 'failed'; errorType: string };

export interface LegacyShadowCaptureEvidenceHandle {
  active: boolean;
  close(): Promise<LegacyShadowCaptureEvidenceAudit>;
}

export interface BootstrapLegacyShadowCaptureEvidenceOptions {
  startup: LegacyShadowStartupAudit;
  origins?: readonly ExecutionOrigin[];
  profile?: DeploymentProfile;
  outputPath?: string;
  snapshot?: (
    origins: readonly ExecutionOrigin[],
  ) => LegacyShadowCaptureSnapshot;
  write?: (
    outputPath: string,
    evidence: LegacyShadowCaptureEvidence,
  ) => Promise<void>;
  audit?: (record: LegacyShadowCaptureEvidenceAudit) => void | Promise<void>;
}

const FILE_NAME_PATTERN =
  /^(?=.{1,128}$)(?!\.)(?!.*\.\.)(?:[A-Za-z0-9][A-Za-z0-9._-]*)\.json$/u;

function configuredOutputPath(): string | undefined {
  const fileName = process.env[LEGACY_SHADOW_CAPTURE_EVIDENCE_FILE_ENV]?.trim();
  if (!fileName) return undefined;
  if (
    !FILE_NAME_PATTERN.test(fileName) ||
    path.basename(fileName) !== fileName
  ) {
    throw new TypeError('Legacy Shadow capture evidence filename is invalid');
  }
  return path.join(config.configPath, fileName);
}

async function writeEvidence(
  outputPath: string,
  evidence: LegacyShadowCaptureEvidence,
): Promise<void> {
  if (!path.isAbsolute(outputPath)) {
    throw new TypeError('Legacy Shadow capture evidence path must be absolute');
  }
  const handle = await fs.open(outputPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(evidence)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function exactOriginCoverage(
  origins: readonly ExecutionOrigin[],
  startup: LegacyShadowStartupDifferenceReport,
): boolean {
  return (
    startup.configuredOriginCount === origins.length &&
    startup.byOrigin.length === origins.length &&
    origins.every((origin, index) => startup.byOrigin[index]?.origin === origin)
  );
}

async function emitAudit(
  audit: (record: LegacyShadowCaptureEvidenceAudit) => void | Promise<void>,
  record: LegacyShadowCaptureEvidenceAudit,
): Promise<void> {
  try {
    await audit(record);
  } catch {
    // Evidence diagnostics must not change Legacy startup or shutdown.
  }
}

/**
 * Arms one process-lifetime capture window after startup reconciliation. It has
 * no timer or watcher and writes exactly one owner-private report on a clean
 * shutdown when an explicit filename is configured.
 */
export async function bootstrapLegacyShadowCaptureEvidence(
  options: BootstrapLegacyShadowCaptureEvidenceOptions,
): Promise<LegacyShadowCaptureEvidenceHandle> {
  const audit =
    options.audit ??
    ((record: LegacyShadowCaptureEvidenceAudit) => {
      Logger.info(`[ql3-shadow-capture] ${JSON.stringify(record)}`);
    });
  const origins = [
    ...new Set(options.origins ?? configuredLegacyShadowOrigins()),
  ];
  let outputPath: string | undefined;
  try {
    outputPath = options.outputPath ?? configuredOutputPath();
  } catch (error) {
    const record: LegacyShadowCaptureEvidenceAudit = {
      state: 'failed',
      errorType: error instanceof Error ? error.name : 'unknown',
    };
    await emitAudit(audit, record);
    return {
      active: false,
      async close() {
        return record;
      },
    };
  }
  if (origins.length === 0 || outputPath === undefined) {
    const record: LegacyShadowCaptureEvidenceAudit = { state: 'disabled' };
    await emitAudit(audit, record);
    return {
      active: false,
      async close() {
        return record;
      },
    };
  }
  const profile =
    options.profile ??
    parseDeploymentProfile(process.env.QL_DEPLOYMENT_PROFILE);
  if (profile === 'cluster-control' || profile === 'worker') {
    const record: LegacyShadowCaptureEvidenceAudit = {
      state: 'profile_rejected',
      profile,
    };
    await emitAudit(audit, record);
    return {
      active: false,
      async close() {
        return record;
      },
    };
  }
  if (
    options.startup.state !== 'reconciled' ||
    options.startup.report.profile !== profile
  ) {
    const record: LegacyShadowCaptureEvidenceAudit = {
      state: 'failed',
      errorType: 'LegacyShadowStartupEvidenceUnavailable',
    };
    await emitAudit(audit, record);
    return {
      active: false,
      async close() {
        return record;
      },
    };
  }
  const startupReport = options.startup.report;
  const snapshot = options.snapshot ?? legacyShadowCaptureSnapshot;
  const before = snapshot(origins);
  const armed: LegacyShadowCaptureEvidenceAudit = {
    state: 'armed',
    profile,
    origins: origins.length,
  };
  await emitAudit(audit, armed);
  let closed: LegacyShadowCaptureEvidenceAudit | undefined;
  return {
    active: true,
    async close() {
      if (closed) return closed;
      try {
        const capture = createLegacyShadowCaptureReport(
          profile,
          origins,
          before,
          snapshot(origins),
        );
        const startupConverged = startupReport.assessment === 'converged';
        const originCoverageExact = exactOriginCoverage(origins, startupReport);
        const captureComplete = capture.assessment === 'captured';
        const evidence: LegacyShadowCaptureEvidence = {
          schema: LEGACY_SHADOW_CAPTURE_EVIDENCE_SCHEMA,
          profile,
          startup: startupReport,
          capture,
          qualification: {
            passed: startupConverged && originCoverageExact && captureComplete,
            startupConverged,
            originCoverageExact,
            captureComplete,
          },
        };
        await (options.write ?? writeEvidence)(outputPath!, evidence);
        closed = {
          state: 'exported',
          profile,
          origins: origins.length,
          qualified: evidence.qualification.passed,
        };
      } catch (error) {
        closed = {
          state: 'failed',
          errorType: error instanceof Error ? error.name : 'unknown',
        };
      }
      await emitAudit(audit, closed);
      return closed;
    },
  };
}
