import {
  assertWorkerConcurrency,
  assertWorkerId,
  assertWorkerSessionId,
  hashWorkerCapabilities,
  serializeWorkerCapabilities,
  type WorkerRecord,
} from '../domain/worker';
import type {
  HeartbeatWorkerRequest,
  RegisterWorkerRequest,
  TransitionWorkerRequest,
  WorkerControlPlaneClient,
} from '../ports/workerControlPlaneClient';
import type { WorkerRegistryRepository } from '../ports/workerRegistryRepository';

export const MIN_WORKER_LEASE_DURATION_MS = 5_000;
export const MAX_WORKER_LEASE_DURATION_MS = 10 * 60_000;

export interface AuthenticatedWorkerPrincipal {
  workerId: string;
}

export interface WorkerControlServiceOptions {
  leaseDurationMs?: number;
  clock?: { now(): number };
}

export class WorkerPrincipalMismatchError extends Error {
  constructor() {
    super('Authenticated Worker principal does not match the requested worker');
    this.name = 'WorkerPrincipalMismatchError';
  }
}

function assertIntegerBetween(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
}

function safeExpiration(nowMs: number, durationMs: number): number {
  assertIntegerBetween('nowMs', nowMs, 0, Number.MAX_SAFE_INTEGER);
  if (nowMs > Number.MAX_SAFE_INTEGER - durationMs) {
    throw new RangeError('Worker lease expiration exceeds the safe range');
  }
  return nowMs + durationMs;
}

export class WorkerControlService {
  private readonly leaseDurationMs: number;
  private readonly clock: { now(): number };

  constructor(
    private readonly repository: WorkerRegistryRepository,
    options: WorkerControlServiceOptions = {},
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? 45_000;
    this.clock = options.clock ?? Date;
    assertIntegerBetween(
      'leaseDurationMs',
      this.leaseDurationMs,
      MIN_WORKER_LEASE_DURATION_MS,
      MAX_WORKER_LEASE_DURATION_MS,
    );
  }

  async register(
    principal: AuthenticatedWorkerPrincipal,
    request: RegisterWorkerRequest,
  ): Promise<WorkerRecord> {
    this.assertPrincipal(principal, request.workerId);
    assertWorkerSessionId(request.sessionId);
    assertWorkerConcurrency(request.maxConcurrentRuns, request.availableSlots);
    const capabilitiesJson = serializeWorkerCapabilities(request.capabilities);
    const nowMs = this.clock.now();
    const result = await this.repository.register({
      workerId: request.workerId,
      sessionId: request.sessionId,
      capabilitiesJson,
      capabilitiesHash: hashWorkerCapabilities(capabilitiesJson),
      maxConcurrentRuns: request.maxConcurrentRuns,
      availableSlots: request.availableSlots,
      registeredAtMs: nowMs,
      leaseExpiresAtMs: safeExpiration(nowMs, this.leaseDurationMs),
    });
    return result.worker;
  }

  async heartbeat(
    principal: AuthenticatedWorkerPrincipal,
    request: HeartbeatWorkerRequest,
  ): Promise<WorkerRecord> {
    this.assertPrincipal(principal, request.workerId);
    const nowMs = this.clock.now();
    return this.repository.heartbeat({
      ...request,
      heartbeatAtMs: nowMs,
      leaseExpiresAtMs: safeExpiration(nowMs, this.leaseDurationMs),
    });
  }

  async drain(
    principal: AuthenticatedWorkerPrincipal,
    request: TransitionWorkerRequest,
  ): Promise<WorkerRecord> {
    return this.transition(principal, request, 'draining');
  }

  async disconnect(
    principal: AuthenticatedWorkerPrincipal,
    request: TransitionWorkerRequest,
  ): Promise<WorkerRecord> {
    return this.transition(principal, request, 'offline');
  }

  async listAvailable(
    options: {
      afterWorkerId?: string;
      limit?: number;
    } = {},
  ) {
    return this.repository.listAvailable({
      observedAtMs: this.clock.now(),
      ...options,
    });
  }

  private async transition(
    principal: AuthenticatedWorkerPrincipal,
    request: TransitionWorkerRequest,
    status: 'draining' | 'offline',
  ): Promise<WorkerRecord> {
    this.assertPrincipal(principal, request.workerId);
    return this.repository.transition({
      ...request,
      status,
      transitionedAtMs: this.clock.now(),
    });
  }

  private assertPrincipal(
    principal: AuthenticatedWorkerPrincipal,
    workerId: string,
  ): void {
    assertWorkerId(principal.workerId);
    assertWorkerId(workerId);
    if (principal.workerId !== workerId) {
      throw new WorkerPrincipalMismatchError();
    }
  }
}

/**
 * Binds an authenticated transport principal to the application service. A
 * future HTTP/gRPC adapter must establish this principal before constructing
 * the client; request payloads never get to self-authenticate a Worker id.
 */
export class BoundWorkerControlPlaneClient implements WorkerControlPlaneClient {
  constructor(
    private readonly service: WorkerControlService,
    private readonly principal: AuthenticatedWorkerPrincipal,
  ) {}

  register(request: RegisterWorkerRequest): Promise<WorkerRecord> {
    return this.service.register(this.principal, request);
  }

  heartbeat(request: HeartbeatWorkerRequest): Promise<WorkerRecord> {
    return this.service.heartbeat(this.principal, request);
  }

  drain(request: TransitionWorkerRequest): Promise<WorkerRecord> {
    return this.service.drain(this.principal, request);
  }

  disconnect(request: TransitionWorkerRequest): Promise<WorkerRecord> {
    return this.service.disconnect(this.principal, request);
  }
}
