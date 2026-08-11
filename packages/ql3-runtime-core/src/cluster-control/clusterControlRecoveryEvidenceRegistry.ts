import type {
  ClusterControlRecoveryEvidence,
  ClusterControlRecoveryEvidenceProvider,
  ClusterControlRecoveryProbeTarget,
} from './clusterControlRecoveryProcessor';

export const MAX_CLUSTER_CONTROL_RECOVERY_EVIDENCE_PROVIDERS = 32;
export const MAX_CLUSTER_CONTROL_RECOVERY_EVIDENCE_TIMEOUT_MS = 30_000;

export const CLUSTER_CONTROL_RECOVERY_IDENTITY_FIELDS = [
  'workerId',
  'workerSessionId',
  'workerGeneration',
  'executorHandle',
  'pid',
  'leaseToken',
  'leaseTokenDigest',
  'leaseGeneration',
  'leaseVersion',
  'offerId',
] as const;

export type ClusterControlRecoveryIdentityField =
  (typeof CLUSTER_CONTROL_RECOVERY_IDENTITY_FIELDS)[number];

export interface ClusterControlRecoveryEvidenceInspectionContext {
  /** Resource bound only; PostgreSQL time remains the claim-fence authority. */
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/**
 * Executor-specific, evidence-only capability. It deliberately receives no
 * recovery owner/token and exposes no start, stop, retry or completion port.
 */
export interface ClusterControlRecoveryExecutorEvidenceProvider {
  readonly executorType: string;
  readonly requiredIdentity: readonly ClusterControlRecoveryIdentityField[];
  inspect(
    target: ClusterControlRecoveryProbeTarget,
    context: ClusterControlRecoveryEvidenceInspectionContext,
  ): Promise<ClusterControlRecoveryEvidence>;
}

export interface ClusterControlRecoveryEvidenceRegistryOptions {
  readonly timeoutMs?: number;
}

interface RegisteredProvider {
  readonly inspect: ClusterControlRecoveryExecutorEvidenceProvider['inspect'];
  readonly requiredIdentity: ReadonlySet<ClusterControlRecoveryIdentityField>;
}

interface ActiveInspection {
  readonly controller: AbortController;
  readonly resolve: (evidence: ClusterControlRecoveryEvidence) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  responded: boolean;
}

const PROVIDER_UNAVAILABLE = Object.freeze({
  status: 'unknown',
  reason: 'provider_unavailable',
} as const);

const IDENTITY_UNVERIFIABLE = Object.freeze({
  status: 'unknown',
  reason: 'identity_unverifiable',
} as const);

const CONFLICTING_EVIDENCE = Object.freeze({
  status: 'unknown',
  reason: 'conflicting_evidence',
} as const);

function integerInRange(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function executorType(value: string): string {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(value)) {
    throw new TypeError(
      'Cluster-control recovery evidence executorType is invalid',
    );
  }
  return value;
}

function requiredIdentity(
  fields: readonly ClusterControlRecoveryIdentityField[],
): ReadonlySet<ClusterControlRecoveryIdentityField> {
  if (!Array.isArray(fields) || fields.length < 1) {
    throw new TypeError(
      'Cluster-control recovery evidence provider requires an execution identity',
    );
  }
  const normalized = new Set<ClusterControlRecoveryIdentityField>();
  for (const field of fields) {
    if (!CLUSTER_CONTROL_RECOVERY_IDENTITY_FIELDS.includes(field)) {
      throw new TypeError(
        'Cluster-control recovery evidence identity field is invalid',
      );
    }
    if (normalized.has(field)) {
      throw new TypeError(
        'Cluster-control recovery evidence identity field is duplicated',
      );
    }
    normalized.add(field);
  }
  return normalized;
}

function optionalString(value: string | undefined, maximum: number): boolean {
  return (
    value === undefined ||
    (value.length > 0 && value.length <= maximum && !value.includes('\0'))
  );
}

function optionalSafeInteger(
  value: number | undefined,
  minimum: number,
): boolean {
  return (
    value === undefined || (Number.isSafeInteger(value) && value >= minimum)
  );
}

function validTarget(target: ClusterControlRecoveryProbeTarget): boolean {
  return (
    !!target &&
    typeof target === 'object' &&
    typeof target.runId === 'string' &&
    target.runId.length > 0 &&
    target.runId.length <= 64 &&
    typeof target.attemptId === 'string' &&
    target.attemptId.length > 0 &&
    target.attemptId.length <= 64 &&
    ['starting', 'running'].includes(target.attemptStatus) &&
    /^[a-z][a-z0-9_.-]{0,63}$/.test(target.executorType) &&
    Number.isSafeInteger(target.callbackSequence) &&
    target.callbackSequence >= 0 &&
    optionalString(target.workerId, 128) &&
    (target.workerSessionId === undefined ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        target.workerSessionId,
      )) &&
    optionalSafeInteger(target.workerGeneration, 1) &&
    optionalString(target.executorHandle, 512) &&
    optionalSafeInteger(target.pid, 1) &&
    optionalString(target.leaseToken, 128) &&
    (target.leaseTokenDigest === undefined ||
      /^[0-9a-f]{64}$/.test(target.leaseTokenDigest)) &&
    optionalSafeInteger(target.leaseGeneration, 1) &&
    optionalSafeInteger(target.leaseVersion, 0) &&
    optionalSafeInteger(target.leaseExpiresAtMs, 0) &&
    optionalString(target.offerId, 128) &&
    optionalSafeInteger(target.startedAtMs, 0)
  );
}

function hasRequiredIdentity(
  target: ClusterControlRecoveryProbeTarget,
  fields: ReadonlySet<ClusterControlRecoveryIdentityField>,
): boolean {
  for (const field of fields) {
    const value = target[field];
    if (
      field === 'pid' ||
      field === 'workerGeneration' ||
      field === 'leaseGeneration' ||
      field === 'leaseVersion'
    ) {
      if (typeof value !== 'number') return false;
    } else if (typeof value !== 'string' || value.length === 0) {
      return false;
    }
  }
  return true;
}

function frozenTarget(
  target: ClusterControlRecoveryProbeTarget,
): ClusterControlRecoveryProbeTarget {
  return Object.freeze({ ...target });
}

function normalizeEvidence(value: unknown): ClusterControlRecoveryEvidence {
  if (
    value &&
    typeof value === 'object' &&
    'status' in value &&
    value.status === 'running'
  ) {
    return Object.freeze({ status: 'running' });
  }
  if (
    value &&
    typeof value === 'object' &&
    'status' in value &&
    value.status === 'not_running'
  ) {
    return Object.freeze({ status: 'not_running' });
  }
  if (
    value &&
    typeof value === 'object' &&
    'status' in value &&
    value.status === 'unknown' &&
    'reason' in value
  ) {
    if (value.reason === 'provider_unavailable') return PROVIDER_UNAVAILABLE;
    if (value.reason === 'identity_unverifiable') {
      return IDENTITY_UNVERIFIABLE;
    }
    if (value.reason === 'conflicting_evidence') {
      return CONFLICTING_EVIDENCE;
    }
  }
  return CONFLICTING_EVIDENCE;
}

/**
 * Exact executor-type router with one in-flight inspection per provider.
 * Timeout releases the startup path but keeps the provider busy until its
 * abandoned operation settles, preventing unbounded probe accumulation.
 */
export class ClusterControlRecoveryEvidenceRegistry
  implements ClusterControlRecoveryEvidenceProvider
{
  private readonly providers = new Map<string, RegisteredProvider>();
  private readonly active = new Map<string, ActiveInspection>();
  private readonly timeoutMs: number;
  private disposed = false;

  constructor(
    providers: readonly ClusterControlRecoveryExecutorEvidenceProvider[],
    options: ClusterControlRecoveryEvidenceRegistryOptions = {},
  ) {
    if (
      !Array.isArray(providers) ||
      providers.length > MAX_CLUSTER_CONTROL_RECOVERY_EVIDENCE_PROVIDERS
    ) {
      throw new RangeError(
        `Cluster-control recovery evidence providers cannot exceed ${MAX_CLUSTER_CONTROL_RECOVERY_EVIDENCE_PROVIDERS}`,
      );
    }
    this.timeoutMs = integerInRange(
      'Cluster-control recovery evidence timeout',
      options.timeoutMs ?? 5_000,
      1,
      MAX_CLUSTER_CONTROL_RECOVERY_EVIDENCE_TIMEOUT_MS,
    );
    for (const provider of providers) {
      if (!provider || typeof provider.inspect !== 'function') {
        throw new TypeError(
          'Cluster-control recovery evidence provider is invalid',
        );
      }
      const type = executorType(provider.executorType);
      if (this.providers.has(type)) {
        throw new TypeError(
          `Duplicate cluster-control recovery evidence provider: ${type}`,
        );
      }
      this.providers.set(type, {
        inspect: provider.inspect.bind(provider),
        requiredIdentity: requiredIdentity(provider.requiredIdentity),
      });
    }
  }

  async inspect(
    _claim: Parameters<ClusterControlRecoveryEvidenceProvider['inspect']>[0],
    target: ClusterControlRecoveryProbeTarget,
  ): Promise<ClusterControlRecoveryEvidence> {
    if (this.disposed) return PROVIDER_UNAVAILABLE;
    if (!validTarget(target)) return IDENTITY_UNVERIFIABLE;
    const registration = this.providers.get(target.executorType);
    if (!registration) return IDENTITY_UNVERIFIABLE;
    if (!hasRequiredIdentity(target, registration.requiredIdentity)) {
      return IDENTITY_UNVERIFIABLE;
    }
    if (this.active.has(target.executorType)) return PROVIDER_UNAVAILABLE;

    return new Promise<ClusterControlRecoveryEvidence>((resolve) => {
      const controller = new AbortController();
      const inspection: ActiveInspection = {
        controller,
        resolve,
        timer: undefined,
        responded: false,
      };
      this.active.set(target.executorType, inspection);

      const respond = (
        evidence: ClusterControlRecoveryEvidence,
        release: boolean,
      ): void => {
        if (release && this.active.get(target.executorType) === inspection) {
          this.active.delete(target.executorType);
        }
        if (inspection.timer !== undefined) {
          clearTimeout(inspection.timer);
          inspection.timer = undefined;
        }
        if (inspection.responded) return;
        inspection.responded = true;
        inspection.resolve(evidence);
      };

      inspection.timer = setTimeout(() => {
        inspection.timer = undefined;
        controller.abort();
        // Keep the slot occupied until the provider promise actually settles.
        respond(PROVIDER_UNAVAILABLE, false);
      }, this.timeoutMs);
      inspection.timer.unref?.();

      const context = Object.freeze({
        timeoutMs: this.timeoutMs,
        signal: controller.signal,
      });
      Promise.resolve()
        .then(() => registration.inspect(frozenTarget(target), context))
        .then(
          (evidence) => respond(normalizeEvidence(evidence), true),
          () => respond(PROVIDER_UNAVAILABLE, true),
        );
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const inspection of this.active.values()) {
      if (inspection.timer !== undefined) clearTimeout(inspection.timer);
      inspection.timer = undefined;
      inspection.controller.abort();
      if (!inspection.responded) {
        inspection.responded = true;
        inspection.resolve(PROVIDER_UNAVAILABLE);
      }
    }
    this.active.clear();
  }
}
