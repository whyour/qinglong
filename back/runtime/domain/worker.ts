import { createHash } from 'crypto';

export const WORKER_STATUSES = ['online', 'draining', 'offline'] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const MAX_WORKER_ID_LENGTH = 128;
export const MAX_WORKER_CAPABILITIES_BYTES = 16 * 1024;
export const MAX_WORKER_EXECUTORS = 16;
export const MAX_WORKER_RUNTIMES = 32;
export const MAX_WORKER_LABELS = 32;
export const MAX_WORKER_FEATURES = 32;
export const MAX_WORKER_GPUS = 8;
export const MAX_WORKER_CONCURRENT_RUNS = 1024;

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CAPABILITY_NAME_PATTERN = /^[a-z0-9][a-z0-9._+-]*$/;
const LABEL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface WorkerRuntimeCapability {
  name: string;
  version: string;
}

export interface WorkerGpuCapability {
  vendor: string;
  model?: string;
  memoryBytes?: number;
}

export interface WorkerCapacity {
  cpuCores?: number;
  memoryBytes?: number;
  diskBytes?: number;
  gpu?: readonly WorkerGpuCapability[];
}

export interface WorkerCapabilities {
  architecture: string;
  operatingSystem: string;
  executors: readonly string[];
  runtimes: readonly WorkerRuntimeCapability[];
  labels: Readonly<Record<string, string>>;
  capacity: WorkerCapacity;
  features: readonly string[];
}

export interface WorkerRecord {
  id: string;
  sessionId: string;
  generation: number;
  status: WorkerStatus;
  version: number;
  capabilities: WorkerCapabilities;
  capabilitiesHash: string;
  maxConcurrentRuns: number;
  availableSlots: number;
  registeredAtMs: number;
  lastHeartbeatAtMs: number;
  leaseExpiresAtMs: number;
  updatedAtMs: number;
}

export class InvalidWorkerValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkerValueError';
  }
}

export class WorkerFenceRejectedError extends Error {
  constructor(
    readonly workerId: string,
    readonly reason:
      | 'missing'
      | 'session_mismatch'
      | 'generation_mismatch'
      | 'version_mismatch'
      | 'lease_expired'
      | 'offline',
  ) {
    super(`Worker ${workerId} fence rejected: ${reason}`);
    this.name = 'WorkerFenceRejectedError';
  }
}

export class WorkerSessionConflictError extends Error {
  constructor(readonly workerId: string) {
    super(`Worker ${workerId} session replay conflicts with persisted data`);
    this.name = 'WorkerSessionConflictError';
  }
}

function invalid(message: string): never {
  throw new InvalidWorkerValueError(message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  name: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    invalid(`${name} fields do not match the supported schema`);
  }
}

function boundedString(
  value: unknown,
  name: string,
  maximum: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes('\0') ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (pattern && !pattern.test(value))
  ) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    invalid(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function optionalPositiveInteger(
  value: unknown,
  name: string,
): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, name);
}

function uniqueSortedStrings(
  value: unknown,
  name: string,
  maximumItems: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    invalid(`${name} must be an array with at most ${maximumItems} items`);
  }
  const normalized = value.map((item, index) =>
    boundedString(item, `${name}[${index}]`, 64, CAPABILITY_NAME_PATTERN),
  );
  if (new Set(normalized).size !== normalized.length) {
    invalid(`${name} must not contain duplicates`);
  }
  return normalized.sort();
}

function normalizeRuntimes(value: unknown): WorkerRuntimeCapability[] {
  if (!Array.isArray(value) || value.length > MAX_WORKER_RUNTIMES) {
    invalid(`runtimes must contain at most ${MAX_WORKER_RUNTIMES} items`);
  }
  const runtimes = value.map((candidate, index) => {
    const item = record(candidate, `runtimes[${index}]`);
    assertKeys(item, `runtimes[${index}]`, ['name', 'version']);
    return {
      name: boundedString(
        item.name,
        `runtimes[${index}].name`,
        64,
        CAPABILITY_NAME_PATTERN,
      ),
      version: boundedString(item.version, `runtimes[${index}].version`, 64),
    };
  });
  const keys = runtimes.map((item) => `${item.name}\0${item.version}`);
  if (new Set(keys).size !== keys.length) {
    invalid('runtimes must not contain duplicates');
  }
  return runtimes.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version),
  );
}

function normalizeLabels(value: unknown): Record<string, string> {
  const labels = record(value, 'labels');
  const entries = Object.entries(labels);
  if (entries.length > MAX_WORKER_LABELS) {
    invalid(`labels must contain at most ${MAX_WORKER_LABELS} entries`);
  }
  return Object.fromEntries(
    entries
      .map(([key, candidate]) => [
        boundedString(key, 'label key', 128, LABEL_KEY_PATTERN),
        boundedString(candidate, `labels.${key}`, 256),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeGpu(value: unknown): WorkerGpuCapability[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_WORKER_GPUS) {
    invalid(`capacity.gpu must contain at most ${MAX_WORKER_GPUS} items`);
  }
  return value.map((candidate, index) => {
    const item = record(candidate, `capacity.gpu[${index}]`);
    assertKeys(
      item,
      `capacity.gpu[${index}]`,
      ['vendor'],
      ['model', 'memoryBytes'],
    );
    return {
      vendor: boundedString(
        item.vendor,
        `capacity.gpu[${index}].vendor`,
        64,
        CAPABILITY_NAME_PATTERN,
      ),
      ...(item.model === undefined
        ? {}
        : {
            model: boundedString(
              item.model,
              `capacity.gpu[${index}].model`,
              128,
            ),
          }),
      ...(item.memoryBytes === undefined
        ? {}
        : {
            memoryBytes: positiveInteger(
              item.memoryBytes,
              `capacity.gpu[${index}].memoryBytes`,
            ),
          }),
    };
  });
}

function normalizeCapacity(value: unknown): WorkerCapacity {
  const capacity = record(value, 'capacity');
  assertKeys(
    capacity,
    'capacity',
    [],
    ['cpuCores', 'memoryBytes', 'diskBytes', 'gpu'],
  );
  const cpuCores =
    capacity.cpuCores === undefined
      ? undefined
      : positiveInteger(capacity.cpuCores, 'capacity.cpuCores', 4096);
  const memoryBytes = optionalPositiveInteger(
    capacity.memoryBytes,
    'capacity.memoryBytes',
  );
  const diskBytes = optionalPositiveInteger(
    capacity.diskBytes,
    'capacity.diskBytes',
  );
  const gpu = normalizeGpu(capacity.gpu);
  return {
    ...(cpuCores === undefined ? {} : { cpuCores }),
    ...(memoryBytes === undefined ? {} : { memoryBytes }),
    ...(diskBytes === undefined ? {} : { diskBytes }),
    ...(gpu === undefined ? {} : { gpu }),
  };
}

export function assertWorkerId(value: string): void {
  boundedString(value, 'workerId', MAX_WORKER_ID_LENGTH, WORKER_ID_PATTERN);
}

export function assertWorkerSessionId(value: string): void {
  if (!UUID_V7_PATTERN.test(value))
    invalid('sessionId must be a lowercase UUIDv7');
}

export function normalizeWorkerCapabilities(
  value: unknown,
): WorkerCapabilities {
  const capabilities = record(value, 'capabilities');
  assertKeys(capabilities, 'capabilities', [
    'architecture',
    'operatingSystem',
    'executors',
    'runtimes',
    'labels',
    'capacity',
    'features',
  ]);
  const normalized: WorkerCapabilities = {
    architecture: boundedString(
      capabilities.architecture,
      'architecture',
      32,
      CAPABILITY_NAME_PATTERN,
    ),
    operatingSystem: boundedString(
      capabilities.operatingSystem,
      'operatingSystem',
      32,
      CAPABILITY_NAME_PATTERN,
    ),
    executors: uniqueSortedStrings(
      capabilities.executors,
      'executors',
      MAX_WORKER_EXECUTORS,
    ),
    runtimes: normalizeRuntimes(capabilities.runtimes),
    labels: normalizeLabels(capabilities.labels),
    capacity: normalizeCapacity(capabilities.capacity),
    features: uniqueSortedStrings(
      capabilities.features,
      'features',
      MAX_WORKER_FEATURES,
    ),
  };
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_WORKER_CAPABILITIES_BYTES) {
    invalid('capabilities exceed the byte limit');
  }
  return normalized;
}

export function serializeWorkerCapabilities(value: unknown): string {
  return JSON.stringify(normalizeWorkerCapabilities(value));
}

export function parseWorkerCapabilities(value: string): WorkerCapabilities {
  if (
    Buffer.byteLength(value, 'utf8') < 2 ||
    Buffer.byteLength(value, 'utf8') > MAX_WORKER_CAPABILITIES_BYTES
  ) {
    invalid('capabilities size is outside the allowed range');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid('capabilities are not valid JSON');
  }
  return normalizeWorkerCapabilities(parsed);
}

export function hashWorkerCapabilities(serialized: string): string {
  const canonical = serializeWorkerCapabilities(
    parseWorkerCapabilities(serialized),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

export function assertWorkerConcurrency(
  maxConcurrentRuns: number,
  availableSlots: number,
): void {
  positiveInteger(
    maxConcurrentRuns,
    'maxConcurrentRuns',
    MAX_WORKER_CONCURRENT_RUNS,
  );
  if (
    !Number.isSafeInteger(availableSlots) ||
    availableSlots < 0 ||
    availableSlots > maxConcurrentRuns
  ) {
    invalid('availableSlots must be between 0 and maxConcurrentRuns');
  }
}

export function isWorkerLeaseActive(
  worker: WorkerRecord,
  observedAtMs: number,
): boolean {
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    invalid('observedAtMs must be a non-negative safe integer');
  }
  return worker.status !== 'offline' && worker.leaseExpiresAtMs > observedAtMs;
}
