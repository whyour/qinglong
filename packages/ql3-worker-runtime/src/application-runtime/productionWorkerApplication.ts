import type { RemoteWorkerCapabilities } from '@qinglong/runtime-core/remote-dispatch';
import {
  createProductionWorkerHeadlessExecutionStack,
  startProductionWorkerHeadlessApplicationWithStack,
  type ProductionWorkerHeadlessApplicationDisabledOptions,
  type ProductionWorkerHeadlessApplicationEnabledOptions,
  type ProductionWorkerHeadlessApplicationResult,
  type ProductionWorkerSessionLifecycle,
} from './productionHeadlessApplication';
import { WorkerExecutionCapacityOracle } from '../session/workerExecutionCapacityOracle';
import { WorkerIngressHttpsClient } from '../remote-execution/transport/workerIngressHttpsClient';
import {
  WorkerSessionCoordinator,
  type WorkerSessionCoordinatorTickResult,
} from '../session/workerSessionCoordinator';
import { WorkerSessionHttpsClient } from '../session/workerSessionHttpsClient';

export type ProductionWorkerApplicationEnabledOptions = Omit<
  ProductionWorkerHeadlessApplicationEnabledOptions,
  'client' | 'session'
> &
  Readonly<{
    workerId: string;
    capabilities: RemoteWorkerCapabilities;
    maxConcurrentRuns: number;
    leaseDurationMs?: number;
    heartbeatIntervalMs?: number;
  }>;

export type ProductionWorkerApplicationOptions =
  | ProductionWorkerHeadlessApplicationDisabledOptions
  | ProductionWorkerApplicationEnabledOptions;

class ManagedWorkerSessionLifecycle
  implements ProductionWorkerSessionLifecycle
{
  private oracle?: WorkerExecutionCapacityOracle;

  constructor(private readonly coordinator: WorkerSessionCoordinator) {}

  bind(oracle: WorkerExecutionCapacityOracle): void {
    if (this.oracle !== undefined)
      throw new TypeError('capacity already bound');
    this.oracle = oracle;
  }

  current() {
    return this.coordinator.current();
  }

  async register() {
    const oracle = this.requiredOracle();
    oracle.prepareRegistration();
    try {
      const registered = await this.coordinator.register();
      oracle.activate();
      return registered;
    } catch (error) {
      oracle.failClosed();
      throw error;
    }
  }

  async tick(): Promise<WorkerSessionCoordinatorTickResult> {
    const result = await this.coordinator.tick();
    if (result.status === 'heartbeat') this.requiredOracle().activate();
    if (result.status === 'lease_expired') this.requiredOracle().failClosed();
    return result;
  }

  failClosed(): void {
    this.coordinator.failClosed();
    this.requiredOracle().failClosed();
  }

  async beginDrain(): Promise<void> {
    this.requiredOracle().beginDrain();
    await this.coordinator.beginDrain();
  }

  async disconnect(): Promise<void> {
    await this.coordinator.disconnect();
    this.requiredOracle().offline();
  }

  private requiredOracle(): WorkerExecutionCapacityOracle {
    if (!this.oracle) throw new TypeError('capacity is not bound');
    return this.oracle;
  }
}

/**
 * Production composition root for one Remote Worker process. It owns exactly
 * one HTTPS client/Agent and delegates all periodic work to the headless
 * application's single cadence.
 */
export async function startProductionWorkerApplication(
  options: ProductionWorkerApplicationOptions,
): Promise<ProductionWorkerHeadlessApplicationResult> {
  if (!options || options.enabled !== true) {
    return Object.freeze({
      status: 'disabled' as const,
      async stop() {
        return 'stopped' as const;
      },
    });
  }
  const client = new WorkerIngressHttpsClient({
    origin: options.origin,
    credentials: options.credentials,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  let oracle: WorkerExecutionCapacityOracle | undefined;
  try {
    const coordinator = new WorkerSessionCoordinator({
      client: new WorkerSessionHttpsClient({ client }),
      workerId: options.workerId,
      capabilities: options.capabilities,
      maxConcurrentRuns: options.maxConcurrentRuns,
      availableSlots: () => oracle?.availableSlots() ?? 0,
      ...(options.leaseDurationMs === undefined
        ? {}
        : { leaseDurationMs: options.leaseDurationMs }),
      ...(options.heartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const session = new ManagedWorkerSessionLifecycle(coordinator);
    const executionOptions: ProductionWorkerHeadlessApplicationEnabledOptions =
      {
        ...options,
        client,
        session,
      };
    const stack =
      createProductionWorkerHeadlessExecutionStack(executionOptions);
    oracle = new WorkerExecutionCapacityOracle({
      journal: stack.journal,
      maxConcurrentRuns: options.maxConcurrentRuns,
    });
    session.bind(oracle);
    const application = await startProductionWorkerHeadlessApplicationWithStack(
      executionOptions,
      stack,
    );
    let closed = false;
    return Object.freeze({
      status: 'active' as const,
      tick: application.tick,
      async stop() {
        const result = await application.stop();
        if (result === 'stopped' && !closed) {
          closed = true;
          client.close();
        }
        return result;
      },
    });
  } catch (error) {
    client.close();
    throw error;
  }
}
