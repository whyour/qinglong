import { createHash } from 'node:crypto';
import type { WorkerSessionRecord } from '../worker/workerSession';
import { assertWorkerSessionRecord } from '../worker/workerSession';
import { semver } from '../versioning/pinnedSemver';

export const REMOTE_WORKER_EXECUTOR_CAPABILITY = 'remote-worker';
export const MAX_REMOTE_PLACEMENT_VALUES = 16;
export const MAX_REMOTE_PLACEMENT_PREFERENCES = 16;
export const MAX_REMOTE_WORKER_RUNTIMES = 32;
export const MAX_REMOTE_WORKER_LABELS = 32;
export const MAX_REMOTE_WORKER_FEATURES = 32;
export const MAX_REMOTE_WORKER_GPUS = 8;

const CAPABILITY_NAME = /^[a-z0-9][a-z0-9._+-]*$/;
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface RemoteWorkerRuntimeCapability {
  readonly name: string;
  readonly version: string;
}

export interface RemoteWorkerCapabilities {
  readonly architecture: string;
  readonly executors: readonly string[];
  readonly operatingSystem?: string;
  readonly runtimes?: readonly RemoteWorkerRuntimeCapability[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly capacity?: Readonly<{
    readonly cpuCores?: number;
    readonly memoryBytes?: number;
    readonly diskBytes?: number;
    readonly gpu?: readonly Readonly<{
      readonly vendor: string;
      readonly model?: string;
      readonly memoryBytes?: number;
    }>[];
  }>;
  readonly features?: readonly string[];
}

export interface RemoteWorkerRuntimeRequirement {
  readonly name: string;
  readonly versionRange?: string;
}

export interface RemoteWorkerPlacementSpec {
  readonly required?: Readonly<{
    readonly architectures?: readonly string[];
    readonly operatingSystems?: readonly string[];
    readonly executors?: readonly string[];
    readonly runtimes?: readonly RemoteWorkerRuntimeRequirement[];
    readonly labels?: Readonly<Record<string, string>>;
    readonly minMemoryBytes?: number;
    readonly minDiskBytes?: number;
    readonly gpuVendor?: string;
    readonly features?: readonly string[];
  }>;
  readonly preferred?: readonly Readonly<{
    readonly labels: Readonly<Record<string, string>>;
    readonly weight: number;
  }>[];
}

export type RemoteWorkerPlacementMismatch =
  | 'worker_unavailable'
  | 'architecture'
  | 'operating_system'
  | 'executor'
  | 'runtime'
  | 'label'
  | 'memory'
  | 'disk'
  | 'gpu'
  | 'feature';

export interface RemoteWorkerPlacementDecision {
  readonly matches: boolean;
  readonly score: number;
  readonly mismatches: readonly RemoteWorkerPlacementMismatch[];
}

function invalid(message: string): never {
  throw new TypeError(`Remote Worker placement value is invalid: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    invalid(`${label} shape is invalid`);
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (pattern !== undefined && !pattern.test(value))
  )
    invalid(`${label} is invalid`);
  return value;
}

function positiveInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    invalid(`${label} is invalid`);
  }
  return value as number;
}

function sortedStrings(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = true,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    (!allowEmpty && value.length === 0)
  ) {
    invalid(`${label} is invalid`);
  }
  const result = value.map((item, index) =>
    boundedString(item, `${label}[${index}]`, 64, CAPABILITY_NAME),
  );
  if (new Set(result).size !== result.length)
    invalid(`${label} contains duplicates`);
  return Object.freeze(result.sort());
}

function normalizedLabels(
  value: unknown,
  label: string,
  maximum: number,
): Readonly<Record<string, string>> {
  const source = object(value, label);
  const entries = Object.entries(source);
  if (entries.length > maximum) invalid(`${label} exceeds its item budget`);
  return Object.freeze(
    Object.fromEntries(
      entries
        .map(
          ([key, item]) =>
            [
              boundedString(key, `${label} key`, 128, LABEL_KEY),
              boundedString(item, `${label}.${key}`, 256),
            ] as const,
        )
        .sort((left, right) => left[0].localeCompare(right[0])),
    ),
  );
}

export function normalizeRemoteWorkerCapabilities(
  value: unknown,
): RemoteWorkerCapabilities {
  const source = object(value, 'capabilities');
  exactKeys(
    source,
    ['architecture', 'executors'],
    ['capacity', 'features', 'labels', 'operatingSystem', 'runtimes'],
    'capabilities',
  );
  const architecture = boundedString(
    source.architecture,
    'architecture',
    32,
    CAPABILITY_NAME,
  );
  const executors = sortedStrings(source.executors, 'executors', 16, false);
  const operatingSystem =
    source.operatingSystem === undefined
      ? undefined
      : boundedString(
          source.operatingSystem,
          'operatingSystem',
          32,
          CAPABILITY_NAME,
        );
  let runtimes: readonly RemoteWorkerRuntimeCapability[] | undefined;
  if (source.runtimes !== undefined) {
    if (
      !Array.isArray(source.runtimes) ||
      source.runtimes.length > MAX_REMOTE_WORKER_RUNTIMES
    )
      invalid('runtimes is invalid');
    const mapped = source.runtimes.map((item, index) => {
      const runtime = object(item, `runtimes[${index}]`);
      exactKeys(runtime, ['name', 'version'], [], `runtimes[${index}]`);
      const name = boundedString(
        runtime.name,
        `runtimes[${index}].name`,
        64,
        CAPABILITY_NAME,
      );
      const version = boundedString(
        runtime.version,
        `runtimes[${index}].version`,
        64,
      );
      if (semver().valid(version) === null)
        invalid(`runtimes[${index}].version is not semver`);
      return Object.freeze({ name, version });
    });
    if (new Set(mapped.map((item) => item.name)).size !== mapped.length)
      invalid('runtimes repeats a runtime name');
    runtimes = Object.freeze(
      mapped.sort((left, right) => left.name.localeCompare(right.name)),
    );
  }
  const labels =
    source.labels === undefined
      ? undefined
      : normalizedLabels(source.labels, 'labels', MAX_REMOTE_WORKER_LABELS);
  let capacity: RemoteWorkerCapabilities['capacity'];
  if (source.capacity !== undefined) {
    const candidate = object(source.capacity, 'capacity');
    exactKeys(
      candidate,
      [],
      ['cpuCores', 'diskBytes', 'gpu', 'memoryBytes'],
      'capacity',
    );
    let gpu: NonNullable<RemoteWorkerCapabilities['capacity']>['gpu'];
    if (candidate.gpu !== undefined) {
      if (
        !Array.isArray(candidate.gpu) ||
        candidate.gpu.length > MAX_REMOTE_WORKER_GPUS
      )
        invalid('capacity.gpu is invalid');
      gpu = Object.freeze(
        candidate.gpu.map((item, index) => {
          const device = object(item, `capacity.gpu[${index}]`);
          exactKeys(
            device,
            ['vendor'],
            ['memoryBytes', 'model'],
            `capacity.gpu[${index}]`,
          );
          return Object.freeze({
            vendor: boundedString(
              device.vendor,
              `capacity.gpu[${index}].vendor`,
              64,
              CAPABILITY_NAME,
            ),
            ...(device.model === undefined
              ? {}
              : {
                  model: boundedString(
                    device.model,
                    `capacity.gpu[${index}].model`,
                    128,
                  ),
                }),
            ...(device.memoryBytes === undefined
              ? {}
              : {
                  memoryBytes: positiveInteger(
                    device.memoryBytes,
                    `capacity.gpu[${index}].memoryBytes`,
                  ),
                }),
          });
        }),
      );
    }
    capacity = Object.freeze({
      ...(candidate.cpuCores === undefined
        ? {}
        : {
            cpuCores: positiveInteger(
              candidate.cpuCores,
              'capacity.cpuCores',
              4096,
            ),
          }),
      ...(candidate.memoryBytes === undefined
        ? {}
        : {
            memoryBytes: positiveInteger(
              candidate.memoryBytes,
              'capacity.memoryBytes',
            ),
          }),
      ...(candidate.diskBytes === undefined
        ? {}
        : {
            diskBytes: positiveInteger(
              candidate.diskBytes,
              'capacity.diskBytes',
            ),
          }),
      ...(gpu === undefined ? {} : { gpu }),
    });
  }
  const features =
    source.features === undefined
      ? undefined
      : sortedStrings(source.features, 'features', MAX_REMOTE_WORKER_FEATURES);
  return Object.freeze({
    architecture,
    executors,
    ...(operatingSystem === undefined ? {} : { operatingSystem }),
    ...(runtimes === undefined ? {} : { runtimes }),
    ...(labels === undefined ? {} : { labels }),
    ...(capacity === undefined ? {} : { capacity }),
    ...(features === undefined ? {} : { features }),
  });
}

export function canonicalRemoteWorkerCapabilities(value: unknown): Readonly<{
  capabilities: RemoteWorkerCapabilities;
  json: string;
  hash: string;
}> {
  const capabilities = normalizeRemoteWorkerCapabilities(value);
  const json = JSON.stringify(capabilities);
  return Object.freeze({
    capabilities,
    json,
    hash: createHash('sha256').update(json, 'utf8').digest('hex'),
  });
}

export function parseRemoteWorkerCapabilities(
  record: WorkerSessionRecord,
): RemoteWorkerCapabilities {
  assertWorkerSessionRecord(record);
  const canonical = canonicalRemoteWorkerCapabilities(
    JSON.parse(record.capabilitiesJson) as unknown,
  );
  if (
    canonical.json !== record.capabilitiesJson ||
    canonical.hash !== record.capabilitiesHash
  ) {
    invalid('capabilities snapshot is not canonical');
  }
  return canonical.capabilities;
}

function optionalStringList(
  value: unknown,
  label: string,
): readonly string[] | undefined {
  return value === undefined
    ? undefined
    : sortedStrings(value, label, MAX_REMOTE_PLACEMENT_VALUES);
}

export function normalizeRemoteWorkerPlacement(
  value: unknown,
): RemoteWorkerPlacementSpec {
  const source = object(value, 'placement');
  exactKeys(source, [], ['preferred', 'required'], 'placement');
  let required: RemoteWorkerPlacementSpec['required'];
  if (source.required !== undefined) {
    const candidate = object(source.required, 'placement.required');
    exactKeys(
      candidate,
      [],
      [
        'architectures',
        'executors',
        'features',
        'gpuVendor',
        'labels',
        'minDiskBytes',
        'minMemoryBytes',
        'operatingSystems',
        'runtimes',
      ],
      'placement.required',
    );
    const architectures = optionalStringList(
      candidate.architectures,
      'placement.required.architectures',
    );
    const operatingSystems = optionalStringList(
      candidate.operatingSystems,
      'placement.required.operatingSystems',
    );
    const executors = optionalStringList(
      candidate.executors,
      'placement.required.executors',
    );
    const features = optionalStringList(
      candidate.features,
      'placement.required.features',
    );
    let runtimes: readonly RemoteWorkerRuntimeRequirement[] | undefined;
    if (candidate.runtimes !== undefined) {
      if (
        !Array.isArray(candidate.runtimes) ||
        candidate.runtimes.length > MAX_REMOTE_PLACEMENT_VALUES
      )
        invalid('placement.required.runtimes is invalid');
      const mapped = candidate.runtimes.map((item, index) => {
        const runtime = object(item, `placement.required.runtimes[${index}]`);
        exactKeys(
          runtime,
          ['name'],
          ['versionRange'],
          `placement.required.runtimes[${index}]`,
        );
        const name = boundedString(
          runtime.name,
          `placement.required.runtimes[${index}].name`,
          64,
          CAPABILITY_NAME,
        );
        const versionRange =
          runtime.versionRange === undefined
            ? undefined
            : boundedString(
                runtime.versionRange,
                `placement.required.runtimes[${index}].versionRange`,
                128,
              );
        if (
          versionRange !== undefined &&
          semver().validRange(versionRange) === null
        )
          invalid(
            `placement.required.runtimes[${index}].versionRange is not semver`,
          );
        return Object.freeze({
          name,
          ...(versionRange === undefined ? {} : { versionRange }),
        });
      });
      if (new Set(mapped.map((item) => item.name)).size !== mapped.length)
        invalid('placement.required.runtimes repeats a runtime name');
      runtimes = Object.freeze(
        mapped.sort((left, right) => left.name.localeCompare(right.name)),
      );
    }
    required = Object.freeze({
      ...(architectures === undefined ? {} : { architectures }),
      ...(operatingSystems === undefined ? {} : { operatingSystems }),
      ...(executors === undefined ? {} : { executors }),
      ...(runtimes === undefined ? {} : { runtimes }),
      ...(candidate.labels === undefined
        ? {}
        : {
            labels: normalizedLabels(
              candidate.labels,
              'placement.required.labels',
              MAX_REMOTE_PLACEMENT_VALUES,
            ),
          }),
      ...(candidate.minMemoryBytes === undefined
        ? {}
        : {
            minMemoryBytes: positiveInteger(
              candidate.minMemoryBytes,
              'placement.required.minMemoryBytes',
            ),
          }),
      ...(candidate.minDiskBytes === undefined
        ? {}
        : {
            minDiskBytes: positiveInteger(
              candidate.minDiskBytes,
              'placement.required.minDiskBytes',
            ),
          }),
      ...(candidate.gpuVendor === undefined
        ? {}
        : {
            gpuVendor: boundedString(
              candidate.gpuVendor,
              'placement.required.gpuVendor',
              64,
              CAPABILITY_NAME,
            ),
          }),
      ...(features === undefined ? {} : { features }),
    });
  }
  let preferred: RemoteWorkerPlacementSpec['preferred'];
  if (source.preferred !== undefined) {
    if (
      !Array.isArray(source.preferred) ||
      source.preferred.length > MAX_REMOTE_PLACEMENT_PREFERENCES
    )
      invalid('placement.preferred is invalid');
    preferred = Object.freeze(
      source.preferred.map((item, index) => {
        const preference = object(item, `placement.preferred[${index}]`);
        exactKeys(
          preference,
          ['labels', 'weight'],
          [],
          `placement.preferred[${index}]`,
        );
        const labels = normalizedLabels(
          preference.labels,
          `placement.preferred[${index}].labels`,
          MAX_REMOTE_PLACEMENT_VALUES,
        );
        if (Object.keys(labels).length === 0)
          invalid(`placement.preferred[${index}].labels is empty`);
        return Object.freeze({
          labels,
          weight: positiveInteger(
            preference.weight,
            `placement.preferred[${index}].weight`,
            100,
          ),
        });
      }),
    );
  }
  return Object.freeze({
    ...(required === undefined ? {} : { required }),
    ...(preferred === undefined ? {} : { preferred }),
  });
}

export function effectiveRemoteWorkerPlacement(
  value: unknown,
): RemoteWorkerPlacementSpec {
  const placement = normalizeRemoteWorkerPlacement(value ?? {});
  const executors = placement.required?.executors;
  if (
    executors !== undefined &&
    !executors.includes(REMOTE_WORKER_EXECUTOR_CAPABILITY)
  ) {
    invalid(`placement must require ${REMOTE_WORKER_EXECUTOR_CAPABILITY}`);
  }
  return normalizeRemoteWorkerPlacement({
    ...placement,
    required: {
      ...placement.required,
      executors: executors ?? [REMOTE_WORKER_EXECUTOR_CAPABILITY],
    },
  });
}

function containsLabels(
  actual: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(
    ([key, value]) => actual?.[key] === value,
  );
}

export function evaluateRemoteWorkerPlacement(
  worker: WorkerSessionRecord,
  placementValue: unknown,
  observedAtMs: number,
): RemoteWorkerPlacementDecision {
  assertWorkerSessionRecord(worker);
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0)
    invalid('observedAtMs is invalid');
  const capabilities = parseRemoteWorkerCapabilities(worker);
  const placement = effectiveRemoteWorkerPlacement(placementValue);
  const required = placement.required ?? {};
  const mismatches: RemoteWorkerPlacementMismatch[] = [];
  if (
    worker.status !== 'online' ||
    worker.availableSlots < 1 ||
    worker.leaseExpiresAtMs <= observedAtMs
  )
    mismatches.push('worker_unavailable');
  if (
    required.architectures?.length &&
    !required.architectures.includes(capabilities.architecture)
  )
    mismatches.push('architecture');
  if (
    required.operatingSystems?.length &&
    (!capabilities.operatingSystem ||
      !required.operatingSystems.includes(capabilities.operatingSystem))
  )
    mismatches.push('operating_system');
  if (
    required.executors?.some(
      (executor) => !capabilities.executors.includes(executor),
    )
  )
    mismatches.push('executor');
  if (
    required.runtimes?.some(
      (requirement) =>
        !(capabilities.runtimes ?? []).some(
          (runtime) =>
            runtime.name === requirement.name &&
            (requirement.versionRange === undefined ||
              semver().satisfies(runtime.version, requirement.versionRange, {
                includePrerelease: true,
              })),
        ),
    )
  )
    mismatches.push('runtime');
  if (required.labels && !containsLabels(capabilities.labels, required.labels))
    mismatches.push('label');
  if (
    required.minMemoryBytes !== undefined &&
    (capabilities.capacity?.memoryBytes ?? 0) < required.minMemoryBytes
  )
    mismatches.push('memory');
  if (
    required.minDiskBytes !== undefined &&
    (capabilities.capacity?.diskBytes ?? 0) < required.minDiskBytes
  )
    mismatches.push('disk');
  if (
    required.gpuVendor !== undefined &&
    !(capabilities.capacity?.gpu ?? []).some(
      (gpu) => gpu.vendor === required.gpuVendor,
    )
  )
    mismatches.push('gpu');
  if (
    required.features?.some(
      (feature) => !(capabilities.features ?? []).includes(feature),
    )
  )
    mismatches.push('feature');
  const score = (placement.preferred ?? []).reduce(
    (total, preference) =>
      total +
      (containsLabels(capabilities.labels, preference.labels)
        ? preference.weight
        : 0),
    0,
  );
  return Object.freeze({
    matches: mismatches.length === 0,
    score,
    mismatches: Object.freeze(mismatches),
  });
}
