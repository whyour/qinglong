export const WORKER_EXECUTION_ATTESTATION_STATES = [
  'running',
  'stopped',
] as const;
export type WorkerExecutionAttestationState =
  (typeof WORKER_EXECUTION_ATTESTATION_STATES)[number];

export interface WorkerExecutionAttestationRecord {
  readonly attestationId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly sequence: number;
  readonly state: WorkerExecutionAttestationState;
  readonly workerId: string;
  readonly workerSessionId: string;
  readonly workerGeneration: number;
  readonly leaseTokenDigest: string;
  readonly leaseGeneration: number;
  readonly leaseVersion: number;
  readonly offerId: string;
  readonly callbackSequence: number;
  readonly executorHandle: string;
  readonly journalRevision: number;
  readonly receivedAtMs: number;
}

export interface SubmitWorkerExecutionAttestationCommand
  extends Omit<WorkerExecutionAttestationRecord, 'receivedAtMs'> {}

export interface SubmitWorkerExecutionAttestationResult {
  readonly status: 'created' | 'existing';
  readonly attestation: Readonly<WorkerExecutionAttestationRecord>;
}

export interface WorkerExecutionAttestationRepository {
  submit(
    command: SubmitWorkerExecutionAttestationCommand,
  ): Promise<SubmitWorkerExecutionAttestationResult>;
  findLatestExact(
    target: Readonly<{
      runId: string;
      attemptId: string;
      workerId: string;
      workerSessionId: string;
      workerGeneration: number;
      leaseTokenDigest: string;
      leaseGeneration: number;
      leaseVersion: number;
      offerId: string;
      callbackSequence: number;
      executorHandle: string;
    }>,
  ): Promise<Readonly<WorkerExecutionAttestationRecord> | null>;
}

export class WorkerExecutionAttestationFenceRejectedError extends Error {
  readonly code = 'WORKER_EXECUTION_ATTESTATION_FENCE_REJECTED';
  constructor(readonly reason: string) {
    super(`Worker execution attestation fence was rejected: ${reason}`);
    this.name = 'WorkerExecutionAttestationFenceRejectedError';
  }
}

export class WorkerExecutionAttestationUnavailableError extends Error {
  readonly code = 'WORKER_EXECUTION_ATTESTATION_UNAVAILABLE';
  constructor() {
    super('Worker execution attestation storage is unavailable');
    this.name = 'WorkerExecutionAttestationUnavailableError';
  }
}

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function bounded(name: string, value: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function integer(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} is invalid`);
  }
  return value;
}

export function normalizeWorkerExecutionAttestation(
  value: WorkerExecutionAttestationRecord,
): Readonly<WorkerExecutionAttestationRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Worker execution attestation is invalid');
  }
  const expected = [
    'attestationId', 'runId', 'attemptId', 'sequence', 'state', 'workerId',
    'workerSessionId', 'workerGeneration', 'leaseTokenDigest',
    'leaseGeneration', 'leaseVersion', 'offerId', 'callbackSequence',
    'executorHandle', 'journalRevision', 'receivedAtMs',
  ].sort();
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError('Worker execution attestation shape is invalid');
  }
  if (!UUID_V7.test(value.attestationId)) {
    throw new TypeError('Worker execution attestation ID is invalid');
  }
  bounded('Worker execution attestation runId', value.runId, 64);
  bounded('Worker execution attestation attemptId', value.attemptId, 64);
  integer('Worker execution attestation sequence', value.sequence, 1);
  if (!WORKER_EXECUTION_ATTESTATION_STATES.includes(value.state)) {
    throw new TypeError('Worker execution attestation state is invalid');
  }
  if (!SAFE_ID.test(value.workerId) || !UUID_V7.test(value.workerSessionId)) {
    throw new TypeError('Worker execution attestation Worker identity is invalid');
  }
  integer('Worker execution attestation Worker generation', value.workerGeneration, 1);
  if (!/^[0-9a-f]{64}$/.test(value.leaseTokenDigest)) {
    throw new TypeError('Worker execution attestation lease digest is invalid');
  }
  integer('Worker execution attestation lease generation', value.leaseGeneration, 1);
  integer('Worker execution attestation lease version', value.leaseVersion, 0);
  bounded('Worker execution attestation offerId', value.offerId, 128);
  integer('Worker execution attestation callback sequence', value.callbackSequence, 0);
  bounded('Worker execution attestation executor handle', value.executorHandle, 512);
  integer('Worker execution attestation journal revision', value.journalRevision, 1);
  integer('Worker execution attestation receivedAtMs', value.receivedAtMs, 0);
  return Object.freeze({ ...value });
}

export function normalizeSubmitWorkerExecutionAttestationCommand(
  command: SubmitWorkerExecutionAttestationCommand,
): Readonly<SubmitWorkerExecutionAttestationCommand> {
  const { receivedAtMs: _receivedAtMs, ...normalized } =
    normalizeWorkerExecutionAttestation({ ...command, receivedAtMs: 0 });
  return Object.freeze(normalized);
}
