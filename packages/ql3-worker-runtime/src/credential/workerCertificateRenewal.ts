// Credential ownership: coordinate Worker certificate renewal lifecycle state.
import type {
  GenerateWorkerCertificateEnrollmentOptions,
  WorkerCertificateEnrollmentMaterial,
} from './workerCertificateEnrollment';
import {
  type ActiveWorkerCertificateIdentity,
  type WorkerCertificateRenewalState,
  type WorkerCertificateStore,
} from './workerCertificateStore';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_CERTIFICATE_MATERIAL_BYTES = 1024 * 1024;
const MAX_ENROLLMENT_MATERIAL_BYTES = 16 * 1024;
const MAX_CONSECUTIVE_FAILURES = 16;

export interface WorkerCertificateIssuer {
  issue(input: {
    readonly workerId: string;
    readonly certificateSigningRequestPem: string;
    readonly currentCertificateSha256?: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly certificateChainPem: string | Buffer }>;
}

export interface WorkerCertificateTrustAnchorProvider {
  load(signal: AbortSignal): Promise<readonly (string | Buffer)[]>;
}

export interface WorkerCertificateRenewalPolicy {
  readonly renewBeforeMs?: number;
  readonly minimumIssuedValidityMs?: number;
  readonly operationTimeoutMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaximumMs?: number;
}

export interface WorkerCertificateRenewalCoordinatorOptions {
  readonly workerId: string;
  readonly store: WorkerCertificateStore;
  readonly issuer: WorkerCertificateIssuer;
  readonly trustAnchors: WorkerCertificateTrustAnchorProvider;
  readonly policy?: WorkerCertificateRenewalPolicy;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly prepareEnrollment?: (
    options: GenerateWorkerCertificateEnrollmentOptions,
  ) => Promise<WorkerCertificateEnrollmentMaterial>;
}

export type WorkerCertificateRenewalResult =
  | {
      readonly status: 'not_due';
      readonly identity: ActiveWorkerCertificateIdentity;
      readonly renewAtMs: number;
    }
  | {
      readonly status: 'renewed';
      readonly identity: ActiveWorkerCertificateIdentity;
      readonly cleanupPending: boolean;
    }
  | {
      readonly status: 'backing_off';
      readonly identity: ActiveWorkerCertificateIdentity;
      readonly nextAttemptAtMs: number;
    }
  | {
      readonly status: 'retry_scheduled';
      readonly identity?: ActiveWorkerCertificateIdentity;
      readonly reason: WorkerCertificateRenewalFailureReason;
      readonly nextAttemptAtMs: number;
    }
  | {
      readonly status: 'unavailable';
      readonly nextAttemptAtMs: number;
    };

export type WorkerCertificateRenewalFailureReason =
  | 'trust_unavailable'
  | 'enrollment_failed'
  | 'issuance_failed'
  | 'installation_failed'
  | 'timed_out';

export class WorkerCertificateRenewalConfigurationError extends TypeError {
  constructor(message: string) {
    super(`Worker certificate renewal is invalid: ${message}`);
    this.name = 'WorkerCertificateRenewalConfigurationError';
  }
}

interface NormalizedPolicy {
  readonly renewBeforeMs: number;
  readonly minimumIssuedValidityMs: number;
  readonly operationTimeoutMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaximumMs: number;
}

type EnrollmentFactory = NonNullable<
  WorkerCertificateRenewalCoordinatorOptions['prepareEnrollment']
>;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new WorkerCertificateRenewalConfigurationError(`${name} is invalid`);
  }
  return candidate;
}

function normalizePolicy(
  policy: WorkerCertificateRenewalPolicy | undefined,
): NormalizedPolicy {
  if (
    policy !== undefined &&
    (!policy || typeof policy !== 'object' || Array.isArray(policy))
  ) {
    throw new WorkerCertificateRenewalConfigurationError(
      'policy must be an object',
    );
  }
  const renewBeforeMs = boundedInteger(
    policy?.renewBeforeMs,
    7 * DAY_MS,
    HOUR_MS,
    30 * DAY_MS,
    'renewBeforeMs',
  );
  const minimumIssuedValidityMs = boundedInteger(
    policy?.minimumIssuedValidityMs,
    8 * DAY_MS,
    HOUR_MS,
    365 * DAY_MS,
    'minimumIssuedValidityMs',
  );
  if (minimumIssuedValidityMs <= renewBeforeMs) {
    throw new WorkerCertificateRenewalConfigurationError(
      'minimumIssuedValidityMs must exceed renewBeforeMs',
    );
  }
  const backoffBaseMs = boundedInteger(
    policy?.backoffBaseMs,
    30_000,
    1_000,
    HOUR_MS,
    'backoffBaseMs',
  );
  const backoffMaximumMs = boundedInteger(
    policy?.backoffMaximumMs,
    6 * HOUR_MS,
    backoffBaseMs,
    6 * HOUR_MS,
    'backoffMaximumMs',
  );
  return Object.freeze({
    renewBeforeMs,
    minimumIssuedValidityMs,
    operationTimeoutMs: boundedInteger(
      policy?.operationTimeoutMs,
      30_000,
      1_000,
      120_000,
      'operationTimeoutMs',
    ),
    backoffBaseMs,
    backoffMaximumMs,
  });
}

function safeClock(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkerCertificateRenewalConfigurationError(
      'clock returned an invalid value',
    );
  }
  return value;
}

function certificateMaterial(
  value: string | Buffer,
): string | Buffer | undefined {
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) return undefined;
  const size = Buffer.byteLength(value);
  if (size < 1 || size > MAX_CERTIFICATE_MATERIAL_BYTES) return undefined;
  return value;
}

function enrollmentMaterial(
  value: WorkerCertificateEnrollmentMaterial,
  workerId: string,
): WorkerCertificateEnrollmentMaterial {
  if (
    !value ||
    typeof value !== 'object' ||
    value.algorithm !== 'ECDSA_P256_SHA256' ||
    value.workerId !== workerId ||
    !Buffer.isBuffer(value.privateKeyPem) ||
    value.privateKeyPem.byteLength < 1 ||
    value.privateKeyPem.byteLength > MAX_ENROLLMENT_MATERIAL_BYTES ||
    typeof value.certificateSigningRequestPem !== 'string' ||
    Buffer.byteLength(value.certificateSigningRequestPem) < 1 ||
    Buffer.byteLength(value.certificateSigningRequestPem) >
      MAX_ENROLLMENT_MATERIAL_BYTES ||
    typeof value.publicKeySpkiSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.publicKeySpkiSha256) ||
    typeof value.dispose !== 'function'
  ) {
    if (Buffer.isBuffer(value?.privateKeyPem)) value.privateKeyPem.fill(0);
    throw new Error('enrollment material is invalid');
  }
  return value;
}

async function defaultEnrollmentFactory(
  options: GenerateWorkerCertificateEnrollmentOptions,
): Promise<WorkerCertificateEnrollmentMaterial> {
  const enrollment = await import('./workerCertificateEnrollment');
  return enrollment.generateWorkerCertificateEnrollment(options);
}

function timeoutSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { readonly operation: AbortSignal; readonly timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    timeout,
    operation: external ? AbortSignal.any([external, timeout]) : timeout,
  };
}

/**
 * Performs one explicitly triggered renewal check. It owns no timer, watcher or
 * signal handler; edge and cluster profiles decide when to call it.
 */
export class WorkerCertificateRenewalCoordinator {
  private readonly workerId: string;
  private readonly store: WorkerCertificateStore;
  private readonly issuer: WorkerCertificateIssuer;
  private readonly trustAnchors: WorkerCertificateTrustAnchorProvider;
  private readonly policy: NormalizedPolicy;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly prepareEnrollment: EnrollmentFactory;
  private inFlight?: Promise<WorkerCertificateRenewalResult>;

  constructor(options: WorkerCertificateRenewalCoordinatorOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new WorkerCertificateRenewalConfigurationError(
        'options must be an object',
      );
    }
    if (
      typeof options.workerId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.workerId)
    ) {
      throw new WorkerCertificateRenewalConfigurationError(
        'workerId is invalid',
      );
    }
    if (
      !options.store ||
      typeof options.store.readActive !== 'function' ||
      typeof options.store.install !== 'function' ||
      typeof options.store.readRenewalState !== 'function' ||
      typeof options.store.writeRenewalState !== 'function'
    ) {
      throw new WorkerCertificateRenewalConfigurationError('store is invalid');
    }
    if (!options.issuer || typeof options.issuer.issue !== 'function') {
      throw new WorkerCertificateRenewalConfigurationError('issuer is invalid');
    }
    if (
      !options.trustAnchors ||
      typeof options.trustAnchors.load !== 'function'
    ) {
      throw new WorkerCertificateRenewalConfigurationError(
        'trustAnchors is invalid',
      );
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new WorkerCertificateRenewalConfigurationError('now is invalid');
    }
    if (options.random !== undefined && typeof options.random !== 'function') {
      throw new WorkerCertificateRenewalConfigurationError('random is invalid');
    }
    if (
      options.prepareEnrollment !== undefined &&
      typeof options.prepareEnrollment !== 'function'
    ) {
      throw new WorkerCertificateRenewalConfigurationError(
        'prepareEnrollment is invalid',
      );
    }
    this.workerId = options.workerId;
    this.store = options.store;
    this.issuer = options.issuer;
    this.trustAnchors = options.trustAnchors;
    this.policy = normalizePolicy(options.policy);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.prepareEnrollment =
      options.prepareEnrollment ?? defaultEnrollmentFactory;
  }

  run(signal?: AbortSignal): Promise<WorkerCertificateRenewalResult> {
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      return Promise.reject(
        new WorkerCertificateRenewalConfigurationError('signal is invalid'),
      );
    }
    if (this.inFlight) return this.inFlight;
    const operation = this.performRun(signal).finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined;
    });
    this.inFlight = operation;
    return operation;
  }

  private async performRun(
    externalSignal: AbortSignal | undefined,
  ): Promise<WorkerCertificateRenewalResult> {
    externalSignal?.throwIfAborted();
    const observedAtMs = safeClock(this.now);
    const renewalState = await this.store.readRenewalState();
    const signals = timeoutSignal(
      externalSignal,
      this.policy.operationTimeoutMs,
    );
    let failureReason: WorkerCertificateRenewalFailureReason =
      'trust_unavailable';
    let current: ActiveWorkerCertificateIdentity | undefined;
    let trustAnchors: readonly (string | Buffer)[] | undefined;

    try {
      trustAnchors = await this.trustAnchors.load(signals.operation);
      signals.operation.throwIfAborted();
      current = await this.store.readActive(trustAnchors, observedAtMs);
    } catch (error) {
      if (externalSignal?.aborted) throw externalSignal.reason ?? error;
      if (signals.timeout.aborted) failureReason = 'timed_out';
    }

    if (
      current &&
      current.notAfterMs - observedAtMs > this.policy.renewBeforeMs
    ) {
      return Object.freeze({
        status: 'not_due',
        identity: current,
        renewAtMs: current.notAfterMs - this.policy.renewBeforeMs,
      });
    }

    if (
      renewalState.nextAttemptAtMs !== null &&
      renewalState.nextAttemptAtMs > observedAtMs
    ) {
      if (current) {
        return Object.freeze({
          status: 'backing_off',
          identity: current,
          nextAttemptAtMs: renewalState.nextAttemptAtMs,
        });
      }
      return Object.freeze({
        status: 'unavailable',
        nextAttemptAtMs: renewalState.nextAttemptAtMs,
      });
    }

    const attemptedAtMs = safeClock(this.now);
    let enrollment: WorkerCertificateEnrollmentMaterial | undefined;
    try {
      if (!trustAnchors || signals.operation.aborted) {
        if (signals.timeout.aborted) failureReason = 'timed_out';
        throw new Error('trust is unavailable');
      }
      failureReason = 'enrollment_failed';
      enrollment = enrollmentMaterial(
        await this.prepareEnrollment({ workerId: this.workerId }),
        this.workerId,
      );
      signals.operation.throwIfAborted();
      failureReason = 'issuance_failed';
      const issued = await this.issuer.issue({
        workerId: this.workerId,
        certificateSigningRequestPem: enrollment.certificateSigningRequestPem,
        ...(current
          ? { currentCertificateSha256: current.certificateSha256 }
          : {}),
        signal: signals.operation,
      });
      signals.operation.throwIfAborted();
      const issuedMaterial = certificateMaterial(issued?.certificateChainPem);
      if (!issuedMaterial) throw new Error('issued material is invalid');
      failureReason = 'installation_failed';
      const installedAtMs = safeClock(this.now);
      const installed = await this.store.install({
        privateKeyPem: enrollment.privateKeyPem,
        certificateChainPem: issuedMaterial,
        trustAnchors,
        now: installedAtMs,
        minimumRemainingValidityMs: this.policy.minimumIssuedValidityMs,
      });
      await this.store.writeRenewalState({
        consecutiveFailures: 0,
        nextAttemptAtMs: null,
        lastAttemptAtMs: attemptedAtMs,
        lastSuccessAtMs: installedAtMs,
      });
      return Object.freeze({
        status: 'renewed',
        identity: installed,
        cleanupPending: installed.cleanupPending,
      });
    } catch (error) {
      if (externalSignal?.aborted) throw externalSignal.reason ?? error;
      if (signals.timeout.aborted) failureReason = 'timed_out';
      const failedAtMs = safeClock(this.now);
      const nextState = this.failedState(
        renewalState,
        attemptedAtMs,
        failedAtMs,
      );
      await this.store.writeRenewalState(nextState);
      if (!current || current.notAfterMs <= failedAtMs) {
        return Object.freeze({
          status: 'unavailable',
          nextAttemptAtMs: nextState.nextAttemptAtMs!,
        });
      }
      return Object.freeze({
        status: 'retry_scheduled',
        identity: current,
        reason: failureReason,
        nextAttemptAtMs: nextState.nextAttemptAtMs!,
      });
    } finally {
      try {
        enrollment?.dispose();
      } finally {
        enrollment?.privateKeyPem.fill(0);
      }
    }
  }

  private failedState(
    previous: WorkerCertificateRenewalState,
    attemptedAtMs: number,
    failedAtMs: number,
  ): WorkerCertificateRenewalState {
    const random = this.random();
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      throw new WorkerCertificateRenewalConfigurationError(
        'random returned an invalid value',
      );
    }
    const consecutiveFailures = Math.min(
      MAX_CONSECUTIVE_FAILURES,
      previous.consecutiveFailures + 1,
    );
    const exponential = Math.min(
      this.policy.backoffMaximumMs,
      this.policy.backoffBaseMs * 2 ** (consecutiveFailures - 1),
    );
    const delayMs = Math.max(1, Math.floor(exponential * (0.5 + random / 2)));
    return Object.freeze({
      consecutiveFailures,
      nextAttemptAtMs: failedAtMs + delayMs,
      lastAttemptAtMs: attemptedAtMs,
      lastSuccessAtMs: previous.lastSuccessAtMs,
    });
  }
}
