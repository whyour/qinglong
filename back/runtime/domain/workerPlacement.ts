import { satisfies, valid, validRange } from 'semver';
import {
  isWorkerLeaseActive,
  type WorkerCapabilities,
  type WorkerRecord,
} from './worker';

export const MAX_PLACEMENT_VALUES = 16;
export const MAX_PLACEMENT_PREFERENCES = 16;
export const MAX_PLACEMENT_CANDIDATES = 64;

export interface WorkerRuntimeRequirement {
  name: string;
  versionRange?: string;
}

export interface WorkerPlacementRequired {
  architectures?: readonly string[];
  operatingSystems?: readonly string[];
  executors?: readonly string[];
  runtimes?: readonly WorkerRuntimeRequirement[];
  labels?: Readonly<Record<string, string>>;
  minMemoryBytes?: number;
  minDiskBytes?: number;
  gpuVendor?: string;
  features?: readonly string[];
}

export interface WorkerPlacementPreference {
  labels: Readonly<Record<string, string>>;
  weight: number;
}

export interface WorkerPlacementSpec {
  required?: WorkerPlacementRequired;
  preferred?: readonly WorkerPlacementPreference[];
}

export type WorkerPlacementMismatch =
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

export interface WorkerPlacementDecision {
  matches: boolean;
  score: number;
  mismatches: readonly WorkerPlacementMismatch[];
}

export interface WorkerPlacementCandidate {
  worker: WorkerRecord;
  score: number;
}

function invalid(message: string): never {
  throw new TypeError(`Worker PlacementSpec is invalid: ${message}`);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  name: string,
  keys: readonly string[],
): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    invalid(`${name} contains an unknown field`);
  }
}

function stringValue(value: unknown, name: string, maximum = 128): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes('\0') ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_PLACEMENT_VALUES) {
    invalid(`${name} must contain at most ${MAX_PLACEMENT_VALUES} values`);
  }
  const values = value.map((item, index) =>
    stringValue(item, `${name}[${index}]`, 64),
  );
  if (new Set(values).size !== values.length) {
    invalid(`${name} must not contain duplicates`);
  }
  return values.sort();
}

function labels(
  value: unknown,
  name: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const source = object(value, name);
  const entries = Object.entries(source);
  if (entries.length > MAX_PLACEMENT_VALUES) {
    invalid(`${name} must contain at most ${MAX_PLACEMENT_VALUES} labels`);
  }
  return Object.fromEntries(
    entries
      .map(([key, candidate]) => [
        stringValue(key, `${name} key`, 128),
        stringValue(candidate, `${name}.${key}`, 256),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function positiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function runtimes(value: unknown): WorkerRuntimeRequirement[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_PLACEMENT_VALUES) {
    invalid(
      `required.runtimes must contain at most ${MAX_PLACEMENT_VALUES} values`,
    );
  }
  const requirements = value.map((candidate, index) => {
    const requirement = object(candidate, `required.runtimes[${index}]`);
    assertKeys(requirement, `required.runtimes[${index}]`, [
      'name',
      'versionRange',
    ]);
    const name = stringValue(
      requirement.name,
      `required.runtimes[${index}].name`,
      64,
    );
    if (requirement.versionRange === undefined) return { name };
    const versionRange = stringValue(
      requirement.versionRange,
      `required.runtimes[${index}].versionRange`,
      128,
    );
    if (!validRange(versionRange)) {
      invalid(`required.runtimes[${index}].versionRange is not semver`);
    }
    return { name, versionRange };
  });
  if (
    new Set(requirements.map((item) => item.name)).size !== requirements.length
  ) {
    invalid('required.runtimes must not repeat a runtime name');
  }
  return requirements.sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function normalizeRequired(
  value: unknown,
): WorkerPlacementRequired | undefined {
  if (value === undefined) return undefined;
  const required = object(value, 'required');
  assertKeys(required, 'required', [
    'architectures',
    'operatingSystems',
    'executors',
    'runtimes',
    'labels',
    'minMemoryBytes',
    'minDiskBytes',
    'gpuVendor',
    'features',
  ]);
  const architectures = stringList(
    required.architectures,
    'required.architectures',
  );
  const operatingSystems = stringList(
    required.operatingSystems,
    'required.operatingSystems',
  );
  const executors = stringList(required.executors, 'required.executors');
  const runtimeRequirements = runtimes(required.runtimes);
  const requiredLabels = labels(required.labels, 'required.labels');
  const minMemoryBytes = positiveInteger(
    required.minMemoryBytes,
    'required.minMemoryBytes',
  );
  const minDiskBytes = positiveInteger(
    required.minDiskBytes,
    'required.minDiskBytes',
  );
  const gpuVendor =
    required.gpuVendor === undefined
      ? undefined
      : stringValue(required.gpuVendor, 'required.gpuVendor', 64);
  const features = stringList(required.features, 'required.features');
  return {
    ...(architectures === undefined ? {} : { architectures }),
    ...(operatingSystems === undefined ? {} : { operatingSystems }),
    ...(executors === undefined ? {} : { executors }),
    ...(runtimeRequirements === undefined
      ? {}
      : { runtimes: runtimeRequirements }),
    ...(requiredLabels === undefined ? {} : { labels: requiredLabels }),
    ...(minMemoryBytes === undefined ? {} : { minMemoryBytes }),
    ...(minDiskBytes === undefined ? {} : { minDiskBytes }),
    ...(gpuVendor === undefined ? {} : { gpuVendor }),
    ...(features === undefined ? {} : { features }),
  };
}

function normalizePreferred(
  value: unknown,
): WorkerPlacementPreference[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_PLACEMENT_PREFERENCES) {
    invalid(
      `preferred must contain at most ${MAX_PLACEMENT_PREFERENCES} values`,
    );
  }
  return value.map((candidate, index) => {
    const preference = object(candidate, `preferred[${index}]`);
    assertKeys(preference, `preferred[${index}]`, ['labels', 'weight']);
    const preferredLabels = labels(
      preference.labels,
      `preferred[${index}].labels`,
    );
    if (!preferredLabels || Object.keys(preferredLabels).length === 0) {
      invalid(`preferred[${index}].labels must not be empty`);
    }
    if (
      !Number.isSafeInteger(preference.weight) ||
      (preference.weight as number) < 1 ||
      (preference.weight as number) > 100
    ) {
      invalid(`preferred[${index}].weight must be between 1 and 100`);
    }
    return {
      labels: preferredLabels,
      weight: preference.weight as number,
    };
  });
}

export function normalizeWorkerPlacementSpec(
  value: unknown,
): WorkerPlacementSpec {
  const placement = object(value, 'placement');
  assertKeys(placement, 'placement', ['required', 'preferred']);
  const required = normalizeRequired(placement.required);
  const preferred = normalizePreferred(placement.preferred);
  return {
    ...(required === undefined ? {} : { required }),
    ...(preferred === undefined ? {} : { preferred }),
  };
}

function hasLabels(
  capabilities: WorkerCapabilities,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(
    ([key, value]) => capabilities.labels[key] === value,
  );
}

function hasRuntime(
  capabilities: WorkerCapabilities,
  requirement: WorkerRuntimeRequirement,
): boolean {
  return capabilities.runtimes.some((runtime) => {
    if (runtime.name !== requirement.name) return false;
    if (!requirement.versionRange) return true;
    return (
      valid(runtime.version) !== null &&
      satisfies(runtime.version, requirement.versionRange, {
        includePrerelease: true,
      })
    );
  });
}

function matchNormalizedWorkerPlacement(
  worker: WorkerRecord,
  placement: WorkerPlacementSpec,
  observedAtMs: number,
): WorkerPlacementDecision {
  const required = placement.required ?? {};
  const capabilities = worker.capabilities;
  const mismatches: WorkerPlacementMismatch[] = [];
  if (
    worker.status !== 'online' ||
    worker.availableSlots < 1 ||
    !isWorkerLeaseActive(worker, observedAtMs)
  ) {
    mismatches.push('worker_unavailable');
  }
  if (
    required.architectures?.length &&
    !required.architectures.includes(capabilities.architecture)
  ) {
    mismatches.push('architecture');
  }
  if (
    required.operatingSystems?.length &&
    !required.operatingSystems.includes(capabilities.operatingSystem)
  ) {
    mismatches.push('operating_system');
  }
  if (
    required.executors?.some(
      (executor) => !capabilities.executors.includes(executor),
    )
  ) {
    mismatches.push('executor');
  }
  if (
    required.runtimes?.some((runtime) => !hasRuntime(capabilities, runtime))
  ) {
    mismatches.push('runtime');
  }
  if (required.labels && !hasLabels(capabilities, required.labels)) {
    mismatches.push('label');
  }
  if (
    required.minMemoryBytes !== undefined &&
    (capabilities.capacity.memoryBytes ?? 0) < required.minMemoryBytes
  ) {
    mismatches.push('memory');
  }
  if (
    required.minDiskBytes !== undefined &&
    (capabilities.capacity.diskBytes ?? 0) < required.minDiskBytes
  ) {
    mismatches.push('disk');
  }
  if (
    required.gpuVendor !== undefined &&
    !capabilities.capacity.gpu?.some((gpu) => gpu.vendor === required.gpuVendor)
  ) {
    mismatches.push('gpu');
  }
  if (
    required.features?.some(
      (feature) => !capabilities.features.includes(feature),
    )
  ) {
    mismatches.push('feature');
  }
  const score = (placement.preferred ?? []).reduce(
    (total, preference) =>
      total +
      (hasLabels(capabilities, preference.labels) ? preference.weight : 0),
    0,
  );
  return { matches: mismatches.length === 0, score, mismatches };
}

export function matchesWorkerPlacement(
  worker: WorkerRecord,
  placementValue: unknown,
  observedAtMs: number,
): WorkerPlacementDecision {
  return matchNormalizedWorkerPlacement(
    worker,
    normalizeWorkerPlacementSpec(placementValue),
    observedAtMs,
  );
}

export function selectWorkerCandidates(
  workers: readonly WorkerRecord[],
  placement: unknown,
  observedAtMs: number,
  limit = 16,
): WorkerPlacementCandidate[] {
  if (workers.length > MAX_PLACEMENT_CANDIDATES) {
    throw new RangeError(
      `workers must contain at most ${MAX_PLACEMENT_CANDIDATES} candidates`,
    );
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PLACEMENT_CANDIDATES
  ) {
    throw new RangeError(
      `limit must be between 1 and ${MAX_PLACEMENT_CANDIDATES}`,
    );
  }
  const normalizedPlacement = normalizeWorkerPlacementSpec(placement);
  return workers
    .map((worker) => ({
      worker,
      decision: matchNormalizedWorkerPlacement(
        worker,
        normalizedPlacement,
        observedAtMs,
      ),
    }))
    .filter((candidate) => candidate.decision.matches)
    .sort(
      (left, right) =>
        right.decision.score - left.decision.score ||
        right.worker.availableSlots - left.worker.availableSlots ||
        left.worker.id.localeCompare(right.worker.id),
    )
    .slice(0, limit)
    .map(({ worker, decision }) => ({ worker, score: decision.score }));
}
