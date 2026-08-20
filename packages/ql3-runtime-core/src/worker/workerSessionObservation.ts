import {
  REMOTE_WORKER_PROTOCOL_RANGE,
  parseRemoteWorkerCapabilities,
  remoteWorkerProtocolIsCompatible,
  type RemoteWorkerArchitecture,
  type RemoteWorkerRuntimeCapability,
  type RemoteWorkerSupportTier,
} from '../remote-execution/remoteWorkerPlacement';
import {
  assertWorkerSessionRecord,
  type WorkerSessionRecord,
} from './workerSession';

export const MAX_WORKER_SESSION_OBSERVATION_PAGE_SIZE = 16;

export type WorkerSessionObservedLifecycle =
  | 'online'
  | 'draining'
  | 'offline'
  | 'lease_expired';

export type WorkerSessionObservedCompatibility =
  | 'default_placement'
  | 'explicit_placement_required'
  | 'protocol_incompatible';

export interface WorkerSessionObservationSummary {
  readonly workerId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly sessionVersion: number;
  readonly lifecycle: WorkerSessionObservedLifecycle;
  readonly compatibility: WorkerSessionObservedCompatibility;
  readonly architecture: RemoteWorkerArchitecture;
  readonly supportTier: RemoteWorkerSupportTier;
  readonly protocolVersion: string;
  readonly operatingSystem: string | null;
  readonly maxConcurrentRuns: number;
  readonly availableSlots: number;
  readonly registeredAtMs: number;
  readonly lastHeartbeatAtMs: number;
  readonly leaseExpiresAtMs: number;
  readonly updatedAtMs: number;
  readonly observedAtMs: number;
}

export interface WorkerSessionObservation
  extends WorkerSessionObservationSummary {
  readonly runtimes: readonly Readonly<RemoteWorkerRuntimeCapability>[];
  readonly declaredCapacity: Readonly<{
    readonly cpuCores: number | null;
    readonly memoryBytes: number | null;
    readonly diskBytes: number | null;
    readonly gpuCount: number;
  }>;
}

export interface WorkerSessionObservationPage {
  readonly observedAtMs: number;
  readonly workers: readonly Readonly<WorkerSessionObservationSummary>[];
  readonly nextCursor: string | null;
}

export interface WorkerSessionInspection {
  readonly observedAtMs: number;
  readonly worker: Readonly<WorkerSessionObservation> | null;
}

function invalid(message: string): never {
  throw new TypeError(`Worker Session observation is invalid: ${message}`);
}

function observedLifecycle(
  worker: Readonly<WorkerSessionRecord>,
  observedAtMs: number,
): WorkerSessionObservedLifecycle {
  if (worker.status === 'offline') return 'offline';
  if (worker.leaseExpiresAtMs <= observedAtMs) return 'lease_expired';
  return worker.status;
}

export function projectWorkerSessionObservation(
  worker: Readonly<WorkerSessionRecord>,
  observedAtMs: number,
): Readonly<WorkerSessionObservation> {
  assertWorkerSessionRecord(worker);
  if (
    !Number.isSafeInteger(observedAtMs) ||
    observedAtMs < worker.updatedAtMs
  ) {
    return invalid('observedAtMs is invalid');
  }
  const capabilities = parseRemoteWorkerCapabilities(worker);
  const protocolCompatible = remoteWorkerProtocolIsCompatible(
    capabilities.protocolVersion,
    REMOTE_WORKER_PROTOCOL_RANGE,
  );
  const compatibility: WorkerSessionObservedCompatibility = protocolCompatible
    ? capabilities.supportTier === 'tier1'
      ? 'default_placement'
      : 'explicit_placement_required'
    : 'protocol_incompatible';
  return Object.freeze({
    workerId: worker.workerId,
    sessionId: worker.sessionId,
    generation: worker.generation,
    sessionVersion: worker.version,
    lifecycle: observedLifecycle(worker, observedAtMs),
    compatibility,
    architecture: capabilities.architecture,
    supportTier: capabilities.supportTier,
    protocolVersion: capabilities.protocolVersion,
    operatingSystem: capabilities.operatingSystem ?? null,
    maxConcurrentRuns: worker.maxConcurrentRuns,
    availableSlots: worker.availableSlots,
    registeredAtMs: worker.registeredAtMs,
    lastHeartbeatAtMs: worker.lastHeartbeatAtMs,
    leaseExpiresAtMs: worker.leaseExpiresAtMs,
    updatedAtMs: worker.updatedAtMs,
    observedAtMs,
    runtimes: Object.freeze(
      (capabilities.runtimes ?? []).map((runtime) =>
        Object.freeze({ ...runtime }),
      ),
    ),
    declaredCapacity: Object.freeze({
      cpuCores: capabilities.capacity?.cpuCores ?? null,
      memoryBytes: capabilities.capacity?.memoryBytes ?? null,
      diskBytes: capabilities.capacity?.diskBytes ?? null,
      gpuCount: capabilities.capacity?.gpu?.length ?? 0,
    }),
  });
}

export function summarizeWorkerSessionObservation(
  observation: Readonly<WorkerSessionObservation>,
): Readonly<WorkerSessionObservationSummary> {
  const {
    runtimes: _runtimes,
    declaredCapacity: _declaredCapacity,
    ...summary
  } = observation;
  return Object.freeze(summary);
}
