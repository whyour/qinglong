import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  CompletionReceiptFileStore,
  LocalProcessController,
  type LocalProcessControllerOptions,
} from '@qinglong/local-process';
import { BoundedWorkerRemoteExecutionContextMaterializer } from '../remote-execution/executionContextMaterializer';
import {
  WorkerRemoteExecutionInboxProcessor,
  type WorkerRemoteExecutionSession,
} from '../remote-execution/executionInboxProcessor';
import {
  WorkerRemoteExecutionHeadlessLifecycle,
  type WorkerRemoteExecutionLifecycleTickResult,
} from '../remote-execution/headlessExecutionLifecycle';
import { WorkerRemoteExecutionHttpsActivationClient } from '../remote-execution/transport/remoteActivationHttpsClient';
import {
  DEFAULT_WORKER_REMOTE_OFFER_INBOX_ENTRIES,
  MAX_WORKER_REMOTE_OFFER_INBOX_ENTRIES,
  WorkerRemoteOfferPullCoordinator,
} from '../remote-execution/remoteOfferDelivery';
import { WorkerRemoteOfferFileJournal } from '../remote-execution/remoteOfferFileJournal';
import { WorkerRemoteOfferHttpsTransport } from '../remote-execution/transport/remoteOfferHttpsTransport';
import { WorkerRemoteSecretHttpsProvider } from '../remote-execution/transport/remoteSecretHttpsProvider';
import {
  WorkerFileLogArtifactAllocator,
  workerRemoteLogArtifactPolicy,
  type WorkerRemoteLogArtifactProfile,
} from '../execution/workerFileLogArtifactAllocator';
import { WorkerIngressHttpsClient } from '../remote-execution/transport/workerIngressHttpsClient';
import {
  WorkerRemoteArtifactHttpsUploader,
  WorkerRemoteExecutionHttpsCompletionClient,
} from '../remote-execution/transport/remoteWorkerCompletionHttpsClient';
import { WorkerRemoteLeaseControlHttpsClient } from '../remote-execution/transport/remoteWorkerLeaseControlHttpsClient';
import { WorkerRemoteCompletionCoordinator } from '../execution/workerCompletionCoordinator';
import { WorkerRemoteExecutionControlCoordinator } from '../execution/workerExecutionControlCoordinator';
import {
  WorkerInboxExecutionSpawnBarrier,
  WorkerPosixExecutionExecutor,
  type WorkerPosixExecutionExecutorOptions,
} from '../execution/workerPosixExecutionExecutor';
import type { WorkerIngressHttpsCredentialProvider } from '../remote-execution/transport/workerIngressHttpsClient';
import type { WorkerCertificateRenewalResult } from '../credential/workerCertificateRenewal';

const MIN_CADENCE_MS = 100;
const MAX_CADENCE_MS = 60_000;
const MIN_DRAIN_TIMEOUT_MS = 1_000;
const MAX_DRAIN_TIMEOUT_MS = 10 * 60_000;
const MIN_DRAIN_POLL_MS = 25;
const MAX_DRAIN_POLL_MS = 5_000;
const SETTLED_STATES = new Set([
  'start_failure_acknowledged',
  'completion_acknowledged',
]);

export interface ProductionWorkerSessionLifecycle {
  current(): WorkerRemoteExecutionSession | undefined;
  /** Optional product hook. Called only after bounded startup reconciliation. */
  register?(): Promise<unknown>;
  /** Optional caller-driven heartbeat step. Must not own a timer. */
  tick?(): Promise<unknown>;
  /** Immediately prevents new work when transport identity is unavailable. */
  failClosed?(): void;
  /** Resolves only after new work is durably disabled for the current Session. */
  beginDrain(): Promise<void>;
  /** Optional product hook. Called only after all execution records settle. */
  disconnect?(): Promise<void>;
}

export interface ProductionWorkerCertificateRenewalLifecycle {
  /** One bounded, caller-driven certificate maintenance step. */
  run(): Promise<WorkerCertificateRenewalResult>;
}

export interface ProductionWorkerStorageOptions {
  readonly journalRoot: string;
  readonly logRoot: string;
  readonly receiptRoot: string;
}

export interface ProductionWorkerHeadlessApplicationDisabledOptions {
  readonly enabled?: false;
}

export interface ProductionWorkerHeadlessApplicationEnabledOptions {
  readonly enabled: true;
  readonly profile: string;
  readonly capacityProfile: WorkerRemoteLogArtifactProfile;
  readonly origin: string | URL;
  readonly credentials: WorkerIngressHttpsCredentialProvider;
  /** Shared product client. When supplied, this execution stack never closes it. */
  readonly client?: WorkerIngressHttpsClient;
  readonly session: ProductionWorkerSessionLifecycle;
  /** Reuses this application's cadence; it must not own a timer or watcher. */
  readonly certificateRenewal?: ProductionWorkerCertificateRenewalLifecycle;
  readonly storage: ProductionWorkerStorageOptions;
  readonly cadenceMs?: number;
  readonly drainTimeoutMs?: number;
  readonly drainPollMs?: number;
  readonly maximumJournalEntries?: number;
  readonly maximumRecordsPerTick?: number;
  readonly maximumSupervisionRecordsPerTick?: number;
  readonly requestTimeoutMs?: number;
  readonly offerBackoffBaseMs?: number;
  readonly ownershipStaleMs?: number;
  readonly processController?: LocalProcessControllerOptions;
  readonly launcherPath?: string;
  readonly expectedLauncherSha256?: string;
  readonly now?: () => number;
  readonly diagnostic?: (
    event: Readonly<{
      code:
        | 'tick_failed'
        | 'session_tick_failed'
        | 'certificate_renewal_failed'
        | 'certificate_unavailable'
        | 'recovery_required'
        | 'drain_failed'
        | 'disconnect_failed';
      error?: unknown;
      offerId?: string;
    }>,
  ) => void | Promise<void>;
}

export type ProductionWorkerHeadlessApplicationOptions =
  | ProductionWorkerHeadlessApplicationDisabledOptions
  | ProductionWorkerHeadlessApplicationEnabledOptions;

export type ProductionWorkerHeadlessStopResult =
  | 'stopped'
  | 'drain_timed_out'
  | 'recovery_required';

export type ProductionWorkerHeadlessApplicationResult =
  | Readonly<{
      status: 'disabled';
      stop(): Promise<'stopped'>;
    }>
  | Readonly<{
      status: 'active';
      tick(): Promise<WorkerRemoteExecutionLifecycleTickResult>;
      stop(): Promise<ProductionWorkerHeadlessStopResult>;
    }>;

export interface ProductionWorkerHeadlessExecutionStack {
  readonly journal: WorkerRemoteOfferFileJournal;
  readonly lifecycle: WorkerRemoteExecutionHeadlessLifecycle;
  readonly client: WorkerIngressHttpsClient;
  readonly offerTransport: WorkerRemoteOfferHttpsTransport;
  readonly ownsClient: boolean;
}

export class ProductionWorkerHeadlessApplicationError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'startup_recovery_required'
      | 'startup_not_converged'
      | 'certificate_unavailable'
      | 'session_drain_unproven',
    options?: ErrorOptions,
  ) {
    super(`Production Worker headless application failed: ${reason}`, options);
    this.name = 'ProductionWorkerHeadlessApplicationError';
  }
}

interface NormalizedProductionWorkerOptions {
  readonly cadenceMs: number;
  readonly drainTimeoutMs: number;
  readonly drainPollMs: number;
  readonly maximumJournalEntries: number;
  readonly maximumRecordsPerTick: number;
  readonly maximumSupervisionRecordsPerTick: number;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ProductionWorkerHeadlessApplicationError('invalid_configuration');
  }
  return value;
}

function storagePath(value: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) {
    throw new ProductionWorkerHeadlessApplicationError('invalid_configuration');
  }
  return value;
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function normalizeOptions(
  options: ProductionWorkerHeadlessApplicationEnabledOptions,
): NormalizedProductionWorkerOptions {
  if (
    !options ||
    options.enabled !== true ||
    options.profile !== 'worker' ||
    (options.capacityProfile !== 'edge' &&
      options.capacityProfile !== 'node') ||
    typeof options.credentials?.load !== 'function' ||
    (options.client !== undefined &&
      !(options.client instanceof WorkerIngressHttpsClient)) ||
    typeof options.session?.current !== 'function' ||
    typeof options.session?.beginDrain !== 'function' ||
    (options.certificateRenewal !== undefined &&
      (typeof options.certificateRenewal.run !== 'function' ||
        typeof options.session.failClosed !== 'function')) ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.diagnostic !== undefined &&
      typeof options.diagnostic !== 'function')
  ) {
    throw new ProductionWorkerHeadlessApplicationError('invalid_configuration');
  }
  const roots = [
    storagePath(options.storage?.journalRoot),
    storagePath(options.storage?.logRoot),
    storagePath(options.storage?.receiptRoot),
  ];
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (
        pathsOverlap(roots[left]!, roots[right]!) ||
        pathsOverlap(roots[right]!, roots[left]!)
      ) {
        throw new ProductionWorkerHeadlessApplicationError(
          'invalid_configuration',
        );
      }
    }
  }
  const edge = options.capacityProfile === 'edge';
  return Object.freeze({
    cadenceMs: boundedInteger(
      options.cadenceMs ?? (edge ? 2_000 : 500),
      MIN_CADENCE_MS,
      MAX_CADENCE_MS,
    ),
    drainTimeoutMs: boundedInteger(
      options.drainTimeoutMs ?? (edge ? 60_000 : 5 * 60_000),
      MIN_DRAIN_TIMEOUT_MS,
      MAX_DRAIN_TIMEOUT_MS,
    ),
    drainPollMs: boundedInteger(
      options.drainPollMs ?? (edge ? 500 : 100),
      MIN_DRAIN_POLL_MS,
      MAX_DRAIN_POLL_MS,
    ),
    maximumJournalEntries: boundedInteger(
      options.maximumJournalEntries ??
        (edge ? DEFAULT_WORKER_REMOTE_OFFER_INBOX_ENTRIES : 256),
      1,
      MAX_WORKER_REMOTE_OFFER_INBOX_ENTRIES,
    ),
    maximumRecordsPerTick: boundedInteger(
      options.maximumRecordsPerTick ?? (edge ? 4 : 16),
      1,
      64,
    ),
    maximumSupervisionRecordsPerTick: boundedInteger(
      options.maximumSupervisionRecordsPerTick ?? (edge ? 4 : 32),
      1,
      64,
    ),
  });
}

export function createProductionWorkerHeadlessExecutionStack(
  options: ProductionWorkerHeadlessApplicationEnabledOptions,
): ProductionWorkerHeadlessExecutionStack {
  const normalized = normalizeOptions(options);
  const currentSession = () => options.session.current();
  const journal = new WorkerRemoteOfferFileJournal({
    rootDirectory: options.storage.journalRoot,
    maximumEntries: normalized.maximumJournalEntries,
    ...(options.ownershipStaleMs === undefined
      ? {}
      : { ownershipStaleMs: options.ownershipStaleMs }),
  });
  const ownsClient = options.client === undefined;
  const client =
    options.client ??
    new WorkerIngressHttpsClient({
      origin: options.origin,
      credentials: options.credentials,
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
    });
  try {
    const offerTransport = new WorkerRemoteOfferHttpsTransport({ client });
    const offers = new WorkerRemoteOfferPullCoordinator({
      journal,
      transport: offerTransport,
      currentSession,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.offerBackoffBaseMs === undefined
        ? {}
        : { backoffBaseMs: options.offerBackoffBaseMs }),
    });
    const activation = new WorkerRemoteExecutionHttpsActivationClient({
      client,
    });
    const secretProvider = new WorkerRemoteSecretHttpsProvider({
      client,
      inbox: journal,
    });
    const artifacts = new WorkerFileLogArtifactAllocator({
      root: options.storage.logRoot,
      policy: workerRemoteLogArtifactPolicy(options.capacityProfile),
    });
    const materializer = new BoundedWorkerRemoteExecutionContextMaterializer({
      artifacts,
      secrets: secretProvider,
    });
    const barrier = new WorkerInboxExecutionSpawnBarrier(journal);
    const executorOptions: WorkerPosixExecutionExecutorOptions = {
      barrier,
      receiptRoot: options.storage.receiptRoot,
      ...(options.launcherPath === undefined
        ? {}
        : { launcherPath: options.launcherPath }),
      ...(options.expectedLauncherSha256 === undefined
        ? {}
        : { expectedLauncherSha256: options.expectedLauncherSha256 }),
    };
    const executor = new WorkerPosixExecutionExecutor(executorOptions);
    const processor = new WorkerRemoteExecutionInboxProcessor({
      inbox: journal,
      activation,
      materializer,
      executor,
      currentSession,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const receipts = new CompletionReceiptFileStore(
      options.storage.receiptRoot,
    );
    const uploader = new WorkerRemoteArtifactHttpsUploader({ client });
    const completionClient = new WorkerRemoteExecutionHttpsCompletionClient({
      client,
    });
    const completion = new WorkerRemoteCompletionCoordinator(
      journal,
      receipts,
      artifacts,
      uploader,
      completionClient,
      {
        currentSession,
        ...(options.now === undefined ? {} : { now: options.now }),
      },
    );
    const leaseControl = new WorkerRemoteLeaseControlHttpsClient({ client });
    const processes = new LocalProcessController(
      options.processController ?? {},
    );
    const control = new WorkerRemoteExecutionControlCoordinator(
      journal,
      completion,
      leaseControl,
      processes,
      {
        currentSession,
        ...(options.now === undefined ? {} : { now: options.now }),
      },
    );
    const lifecycle = new WorkerRemoteExecutionHeadlessLifecycle({
      journal,
      offers,
      processor,
      control,
      currentSession,
      maximumRecordsPerTick: normalized.maximumRecordsPerTick,
      maximumSupervisionRecordsPerTick:
        normalized.maximumSupervisionRecordsPerTick,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return Object.freeze({
      journal,
      lifecycle,
      client,
      offerTransport,
      ownsClient,
    });
  } catch (error) {
    if (ownsClient) client.close();
    throw error;
  }
}

async function inspectUnsettled(
  journal: WorkerRemoteOfferFileJournal,
  maximumEntries: number,
): Promise<
  Readonly<{
    unsettled: number;
    recoveryOfferId?: string;
  }>
> {
  let afterOfferId: string | undefined;
  let observed = 0;
  let unsettled = 0;
  do {
    const page = await journal.listOffers({
      ...(afterOfferId === undefined ? {} : { afterOfferId }),
      limit: 64,
    });
    observed += page.records.length;
    if (observed > maximumEntries) {
      throw new ProductionWorkerHeadlessApplicationError(
        'invalid_configuration',
      );
    }
    for (const record of page.records) {
      if (record.state === 'recovery_required') {
        return Object.freeze({
          unsettled,
          recoveryOfferId: record.offer.offerId,
        });
      }
      if (!SETTLED_STATES.has(record.state)) unsettled += 1;
    }
    afterOfferId = page.nextAfterOfferId;
  } while (afterOfferId !== undefined);
  return Object.freeze({ unsettled });
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function startProductionWorkerHeadlessApplication(
  options: ProductionWorkerHeadlessApplicationOptions,
): Promise<ProductionWorkerHeadlessApplicationResult> {
  if (!options || options.enabled !== true) {
    return Object.freeze({
      status: 'disabled' as const,
      async stop() {
        return 'stopped' as const;
      },
    });
  }
  const stack = createProductionWorkerHeadlessExecutionStack(options);
  return startProductionWorkerHeadlessApplicationWithStack(options, stack);
}

/**
 * Starts one already-composed execution stack. Product composition uses this
 * seam to share the exact HTTPS client with its timer-free Session lifecycle.
 */
export async function startProductionWorkerHeadlessApplicationWithStack(
  options: ProductionWorkerHeadlessApplicationEnabledOptions,
  stack: ProductionWorkerHeadlessExecutionStack,
): Promise<
  Extract<ProductionWorkerHeadlessApplicationResult, { status: 'active' }>
> {
  const normalized = normalizeOptions(options);
  let lifecycleStarted = false;
  let certificateUnavailable = false;
  const emit = (
    event: Readonly<{
      code:
        | 'tick_failed'
        | 'session_tick_failed'
        | 'certificate_renewal_failed'
        | 'certificate_unavailable'
        | 'recovery_required'
        | 'drain_failed'
        | 'disconnect_failed';
      error?: unknown;
      offerId?: string;
    }>,
  ) => {
    void Promise.resolve()
      .then(() => options.diagnostic?.(event))
      .catch(() => undefined);
  };
  const maintainCertificate = async (): Promise<boolean> => {
    if (!options.certificateRenewal) return true;
    let result: WorkerCertificateRenewalResult;
    try {
      result = await options.certificateRenewal.run();
    } catch (error) {
      if (!certificateUnavailable) {
        certificateUnavailable = true;
        options.session.failClosed!();
        emit({ code: 'certificate_unavailable', error });
      }
      return false;
    }
    if (result.status === 'retry_scheduled') {
      emit({ code: 'certificate_renewal_failed' });
    }
    if (result.status === 'unavailable') {
      if (!certificateUnavailable) {
        certificateUnavailable = true;
        options.session.failClosed!();
        emit({ code: 'certificate_unavailable' });
      }
      return false;
    }
    certificateUnavailable = false;
    return true;
  };
  try {
    await stack.lifecycle.start();
    lifecycleStarted = true;
    if (options.session.register !== undefined) {
      const startupState = await inspectUnsettled(
        stack.journal,
        normalized.maximumJournalEntries,
      );
      if (
        startupState.recoveryOfferId !== undefined ||
        startupState.unsettled !== 0
      ) {
        throw new ProductionWorkerHeadlessApplicationError(
          'startup_recovery_required',
        );
      }
    }
    const maximumStartupTicks =
      Math.ceil(
        normalized.maximumJournalEntries / normalized.maximumRecordsPerTick,
      ) + 1;
    let converged = false;
    for (let tick = 0; tick < maximumStartupTicks; tick += 1) {
      const result = await stack.lifecycle.tick();
      if (result.status === 'recovery_required') {
        throw new ProductionWorkerHeadlessApplicationError(
          'startup_recovery_required',
        );
      }
      if (result.status === 'reconciled') {
        converged = true;
        break;
      }
      if (result.status !== 'reconciling') {
        throw new ProductionWorkerHeadlessApplicationError(
          'startup_not_converged',
        );
      }
    }
    if (!converged) {
      throw new ProductionWorkerHeadlessApplicationError(
        'startup_not_converged',
      );
    }
    if (!(await maintainCertificate())) {
      throw new ProductionWorkerHeadlessApplicationError(
        'certificate_unavailable',
      );
    }
    await options.session.register?.();

    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    let tickOperation:
      | Promise<WorkerRemoteExecutionLifecycleTickResult>
      | undefined;
    let stopOperation: Promise<ProductionWorkerHeadlessStopResult> | undefined;

    const tickOnce =
      async (): Promise<WorkerRemoteExecutionLifecycleTickResult> => {
        if (await maintainCertificate()) {
          await options.session.tick?.().catch((error) => {
            emit({ code: 'session_tick_failed', error });
          });
        }
        const result = await stack.lifecycle.tick();
        if (result.status === 'recovery_required') {
          emit({ code: 'recovery_required', offerId: result.offerId });
        }
        return result;
      };
    const tick = (): Promise<WorkerRemoteExecutionLifecycleTickResult> => {
      if (tickOperation) return tickOperation;
      const operation = tickOnce().finally(() => {
        if (tickOperation === operation) tickOperation = undefined;
      });
      tickOperation = operation;
      return operation;
    };
    const schedule = () => {
      if (timer || closed) return;
      timer = setInterval(() => {
        void tick().catch((error) => emit({ code: 'tick_failed', error }));
      }, normalized.cadenceMs);
      timer.unref();
    };
    const unschedule = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    };
    const finish = async (): Promise<'stopped'> => {
      unschedule();
      await stack.lifecycle.stop();
      stack.offerTransport.close();
      if (stack.ownsClient) stack.client.close();
      closed = true;
      return 'stopped';
    };
    const drainAndStop =
      async (): Promise<ProductionWorkerHeadlessStopResult> => {
        unschedule();
        await stack.lifecycle.beginDrain();
        try {
          await options.session.beginDrain();
        } catch (error) {
          emit({ code: 'drain_failed', error });
          schedule();
          throw error;
        }
        const session = options.session.current();
        if (session?.status === 'available') {
          schedule();
          throw new ProductionWorkerHeadlessApplicationError(
            'session_drain_unproven',
          );
        }
        const deadline = performance.now() + normalized.drainTimeoutMs;
        while (true) {
          const tickResult = await tick().catch((error) => {
            emit({ code: 'drain_failed', error });
            return undefined;
          });
          if (tickResult?.status === 'recovery_required') {
            schedule();
            return 'recovery_required';
          }
          const state = await inspectUnsettled(
            stack.journal,
            normalized.maximumJournalEntries,
          );
          if (state.recoveryOfferId !== undefined) {
            emit({
              code: 'recovery_required',
              offerId: state.recoveryOfferId,
            });
            schedule();
            return 'recovery_required';
          }
          if (state.unsettled === 0) {
            try {
              await options.session.disconnect?.();
            } catch (error) {
              emit({ code: 'disconnect_failed', error });
              schedule();
              throw error;
            }
            return finish();
          }
          if (performance.now() >= deadline) {
            schedule();
            return 'drain_timed_out';
          }
          await wait(normalized.drainPollMs);
        }
      };
    schedule();
    return Object.freeze({
      status: 'active' as const,
      tick,
      stop() {
        if (closed) return Promise.resolve('stopped' as const);
        if (stopOperation) return stopOperation;
        const operation = drainAndStop().finally(() => {
          if (stopOperation === operation && !closed) {
            stopOperation = undefined;
          }
        });
        stopOperation = operation;
        return operation;
      },
    });
  } catch (error) {
    if (lifecycleStarted) {
      await stack.lifecycle.stop().catch(() => undefined);
    }
    stack.offerTransport.close();
    if (stack.ownsClient) stack.client.close();
    throw error;
  }
}
