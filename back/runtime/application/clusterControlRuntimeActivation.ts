import type { DeploymentProfile } from '../domain/deploymentProfile';

export type ClusterControlActivationState =
  | 'disabled'
  | 'schema_ready'
  | 'reconciled'
  | 'active'
  | 'failed'
  | 'stopped';

export interface ClusterControlReadinessEvidence {
  readonly contractName: string;
  readonly contractVersion: number;
  readonly serverMajor: number;
  readonly migrationIds: readonly string[];
}

export interface ClusterControlReadinessProbe {
  assertReady(): Promise<ClusterControlReadinessEvidence>;
}

export interface ClusterControlStartupRecoverySummary {
  readonly safe: boolean;
  readonly remaining: number;
  readonly failed: number;
}

export type ClusterControlStopResult = 'stopped' | 'timed_out';

export interface ClusterControlActivationStack {
  reconcile(): Promise<ClusterControlStartupRecoverySummary>;
  startLifecycles(): Promise<boolean>;
  installAdmission(): () => void;
  stop(): Promise<ClusterControlStopResult>;
}

export interface ClusterControlActivationAudit {
  readonly state: ClusterControlActivationState;
  readonly contractName?: string;
  readonly contractVersion?: number;
  readonly serverMajor?: number;
  readonly migrationCount?: number;
  readonly recovery?: ClusterControlStartupRecoverySummary;
}

export interface ClusterControlRuntimeActivationOptions {
  readonly enabled?: boolean;
  readonly profile: DeploymentProfile;
  readonly readiness: ClusterControlReadinessProbe;
  readonly create: (
    evidence: ClusterControlReadinessEvidence,
  ) => ClusterControlActivationStack;
  readonly audit: (
    record: ClusterControlActivationAudit,
  ) => void | Promise<void>;
}

export type ClusterControlRuntimeActivationResult =
  | { readonly status: 'disabled'; stop(): Promise<'stopped'> }
  | {
      readonly status: 'active';
      readonly evidence: ClusterControlReadinessEvidence;
      readonly recovery: ClusterControlStartupRecoverySummary;
      stop(): Promise<ClusterControlStopResult>;
    };

const DISABLED_STOP = async (): Promise<'stopped'> => 'stopped';

function auditEvidence(
  evidence: ClusterControlReadinessEvidence,
): Pick<
  ClusterControlActivationAudit,
  'contractName' | 'contractVersion' | 'serverMajor' | 'migrationCount'
> {
  return {
    contractName: evidence.contractName,
    contractVersion: evidence.contractVersion,
    serverMajor: evidence.serverMajor,
    migrationCount: evidence.migrationIds.length,
  };
}

function assertSafeRecovery(
  recovery: ClusterControlStartupRecoverySummary,
): void {
  if (!recovery.safe || recovery.remaining !== 0 || recovery.failed !== 0) {
    throw new Error('Cluster-control startup recovery did not converge safely');
  }
}

/**
 * Enforces readiness -> assembly -> recovery -> lifecycle -> admission order.
 * The factory is deliberately called only after schema/role readiness, so an
 * invalid cluster database cannot even construct business repositories.
 */
export async function activateClusterControlRuntime(
  options: ClusterControlRuntimeActivationOptions,
): Promise<ClusterControlRuntimeActivationResult> {
  const enabled = options.enabled ?? false;
  if (!enabled) {
    await options.audit({ state: 'disabled' });
    return { status: 'disabled', stop: DISABLED_STOP };
  }
  if (options.profile !== 'cluster-control') {
    throw new TypeError(
      `Deployment profile ${options.profile} cannot activate cluster-control`,
    );
  }

  let evidence: ClusterControlReadinessEvidence | undefined;
  let stack: ClusterControlActivationStack | undefined;
  let disposeAdmission: (() => void) | undefined;
  try {
    evidence = await options.readiness.assertReady();
    await options.audit({ state: 'schema_ready', ...auditEvidence(evidence) });
    stack = options.create(evidence);
    const recovery = await stack.reconcile();
    assertSafeRecovery(recovery);
    await options.audit({
      state: 'reconciled',
      ...auditEvidence(evidence),
      recovery,
    });
    if (!(await stack.startLifecycles())) {
      throw new Error('Cluster-control lifecycles did not start');
    }
    disposeAdmission = stack.installAdmission();
    await options.audit({
      state: 'active',
      ...auditEvidence(evidence),
      recovery,
    });

    let stopPromise: Promise<ClusterControlStopResult> | undefined;
    return {
      status: 'active',
      evidence,
      recovery,
      stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          let admissionError: unknown;
          try {
            disposeAdmission?.();
          } catch (error) {
            admissionError = error;
          }
          disposeAdmission = undefined;
          const result = await stack!.stop();
          if (admissionError) {
            try {
              await options.audit({
                state: 'failed',
                ...auditEvidence(evidence!),
              });
            } catch {
              // Preserve the admission cleanup failure after stopping the stack.
            }
            throw admissionError;
          }
          try {
            await options.audit({
              state: 'stopped',
              ...auditEvidence(evidence!),
              recovery,
            });
          } catch {
            // Diagnostic failure cannot reverse stopped ownership.
          }
          return result;
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    try {
      disposeAdmission?.();
    } catch {
      // Preserve the activation failure and continue stopping the stack.
    }
    if (stack) {
      try {
        await stack.stop();
      } catch {
        // Preserve the activation failure after best-effort cleanup.
      }
    }
    try {
      await options.audit({
        state: 'failed',
        ...(evidence ? auditEvidence(evidence) : {}),
      });
    } catch {
      // Diagnostic failure cannot replace the activation failure.
    }
    throw error;
  }
}
