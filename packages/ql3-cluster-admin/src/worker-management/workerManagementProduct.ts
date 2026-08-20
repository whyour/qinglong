/** Bounded commands and low-sensitive product projections for Worker sessions. */
import { randomUUID } from 'node:crypto';

import type {
  ClusterWorkerManagementClientResult,
  ClusterWorkerManagementCommand,
  ClusterWorkerManagementTransportResult,
} from './workerManagementClient';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type InspectCommand = Extract<
  ClusterWorkerManagementCommand,
  { readonly operation: 'worker-session.inspect' }
>;
type ListCommand = Extract<
  ClusterWorkerManagementCommand,
  { readonly operation: 'worker-session.list' }
>;
type InspectResult = Extract<
  ClusterWorkerManagementTransportResult,
  { readonly operation: 'worker-session.inspect' }
>;
type ListResult = Extract<
  ClusterWorkerManagementTransportResult,
  { readonly operation: 'worker-session.list' }
>;

export interface WorkerSessionInspection {
  readonly schema: 'qinglong/worker-session-inspection@v1';
  readonly projectId: string;
  readonly observedAtMs: number;
  readonly found: boolean;
  readonly worker: InspectResult['worker'];
}

export interface WorkerSessionList {
  readonly schema: 'qinglong/worker-session-list@v1';
  readonly projectId: string;
  readonly observedAtMs: number;
  readonly count: number;
  readonly workers: ListResult['workers'];
  readonly nextAfterWorkerId: string | null;
}

export class ClusterWorkerManagementProductError extends TypeError {
  readonly code = 'QL3_WORKER_MANAGEMENT_PRODUCT_INPUT_INVALID';

  constructor() {
    super('Worker management product input is invalid');
    this.name = 'ClusterWorkerManagementProductError';
  }
}

function identifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new ClusterWorkerManagementProductError();
  return value;
}

function inspectionId(createId: () => string): string {
  const value = createId();
  return identifier(value);
}

export function createWorkerSessionInspectionCommand(
  projectId: string,
  workerId: string,
  createId: () => string = randomUUID,
): Readonly<InspectCommand> {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'worker-session.inspect',
    request: Object.freeze({
      authorityProjectId: identifier(projectId),
      workerId: identifier(workerId),
      inspectionId: inspectionId(createId),
    }),
  });
}

export function createWorkerSessionListCommand(
  projectId: string,
  afterWorkerId?: string,
  createId: () => string = randomUUID,
): Readonly<ListCommand> {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'worker-session.list',
    request: Object.freeze({
      authorityProjectId: identifier(projectId),
      afterWorkerId:
        afterWorkerId === undefined ? null : identifier(afterWorkerId),
      inspectionId: inspectionId(createId),
    }),
  });
}

function cloneWorker<
  Worker extends
    | NonNullable<InspectResult['worker']>
    | ListResult['workers'][number],
>(worker: Worker): Worker {
  return Object.freeze({
    ...worker,
    ...('runtimes' in worker
      ? {
          runtimes: Object.freeze(
            worker.runtimes.map((runtime) => Object.freeze({ ...runtime })),
          ),
          declaredCapacity: Object.freeze({ ...worker.declaredCapacity }),
        }
      : {}),
  }) as Worker;
}

export function projectWorkerSessionInspection(
  projectId: string,
  response: Readonly<ClusterWorkerManagementClientResult>,
): Readonly<WorkerSessionInspection> {
  if (response.result.operation !== 'worker-session.inspect') {
    throw new ClusterWorkerManagementProductError();
  }
  return Object.freeze({
    schema: 'qinglong/worker-session-inspection@v1',
    projectId: identifier(projectId),
    observedAtMs: response.result.observedAtMs,
    found: response.result.worker !== null,
    worker:
      response.result.worker === null
        ? null
        : cloneWorker(response.result.worker),
  });
}

export function projectWorkerSessionList(
  projectId: string,
  response: Readonly<ClusterWorkerManagementClientResult>,
): Readonly<WorkerSessionList> {
  if (response.result.operation !== 'worker-session.list') {
    throw new ClusterWorkerManagementProductError();
  }
  const workers = Object.freeze(response.result.workers.map(cloneWorker));
  return Object.freeze({
    schema: 'qinglong/worker-session-list@v1',
    projectId: identifier(projectId),
    observedAtMs: response.result.observedAtMs,
    count: workers.length,
    workers,
    nextAfterWorkerId: response.result.nextCursor,
  });
}

export function formatWorkerSessionInspectionCard(
  inspection: Readonly<WorkerSessionInspection>,
): string {
  if (inspection.worker === null) {
    return [
      `Worker session: not found`,
      `Project: ${inspection.projectId}`,
      `Observed: ${inspection.observedAtMs}`,
    ].join('\n');
  }
  const worker = inspection.worker;
  return [
    `Worker session: ${worker.workerId}`,
    `Project: ${inspection.projectId}`,
    `State: ${worker.lifecycle} / ${worker.compatibility} / ${worker.supportTier}`,
    `Platform: ${worker.operatingSystem ?? 'unknown'} ${
      worker.architecture
    } / protocol ${worker.protocolVersion}`,
    `Capacity: ${worker.availableSlots}/${worker.maxConcurrentRuns} slots available`,
    `Heartbeat: ${worker.lastHeartbeatAtMs} / lease ${worker.leaseExpiresAtMs}`,
    `Observed: ${inspection.observedAtMs}`,
  ].join('\n');
}

export function formatWorkerSessionListCard(
  page: Readonly<WorkerSessionList>,
): string {
  const lines = [
    `Worker sessions: ${page.count}`,
    `Project: ${page.projectId}`,
    `Observed: ${page.observedAtMs}`,
  ];
  for (const worker of page.workers) {
    lines.push(
      `${worker.workerId}  ${worker.lifecycle}  ${worker.supportTier}  ${worker.architecture}  slots ${worker.availableSlots}/${worker.maxConcurrentRuns}`,
    );
  }
  lines.push(`Next after: ${page.nextAfterWorkerId ?? '-'}`);
  return lines.join('\n');
}
