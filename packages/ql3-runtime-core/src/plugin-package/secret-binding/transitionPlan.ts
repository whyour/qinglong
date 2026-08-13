import { createHash } from 'node:crypto';

import { normalizePluginPackageResourceGeneration } from '../pluginPackageResourceGeneration';
import {
  normalizePluginPackageManifest,
  type PluginPackageManifest,
} from '../pluginPackage';
import { parseSecretRef } from '../../secret/secretReference';
import {
  createPluginPackageSecretBindingTarget,
  normalizePluginPackageSecretBinding,
  normalizePluginPackageSecretBindingTarget,
  type PluginPackageSecretBinding,
  type PluginPackageSecretBindingAssignment,
  type PluginPackageSecretBindingEntry,
  type PluginPackageSecretBindingTarget,
} from './binding';
import {
  createPluginPackageSecretBindingPlan,
  normalizePluginPackageSecretBindingPlan,
  type PluginPackageSecretBindingPlan,
} from './plan';

export const PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_PLAN_SCHEMA =
  'qinglong/plugin-package-secret-binding-transition-plan@v1' as const;
export const PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_KINDS = [
  'carry-forward',
  'rotate',
  'rebind',
  'revoke',
] as const;
export const PLUGIN_PACKAGE_SECRET_REQUIREMENT_CHANGE_KINDS = [
  'added',
  'removed',
  'tightened',
  'relaxed',
  'unchanged',
] as const;
export const PLUGIN_PACKAGE_SECRET_REFERENCE_CHANGE_KINDS = [
  'bound',
  'revoked',
  'rotated',
  'rebound',
  'unchanged',
] as const;
export const MAX_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_PLAN_JSON_BYTES =
  160 * 1024;

export type PluginPackageSecretBindingTransitionKind =
  (typeof PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_KINDS)[number];
export type PluginPackageSecretRequirementChangeKind =
  (typeof PLUGIN_PACKAGE_SECRET_REQUIREMENT_CHANGE_KINDS)[number];
export type PluginPackageSecretReferenceChangeKind =
  (typeof PLUGIN_PACKAGE_SECRET_REFERENCE_CHANGE_KINDS)[number];

export interface PluginPackageSecretBindingTransitionEntryState {
  readonly required: boolean;
  readonly secretRef: string | null;
}

export interface PluginPackageSecretBindingTransitionChange {
  readonly name: string;
  readonly requirement: PluginPackageSecretRequirementChangeKind;
  readonly reference: PluginPackageSecretReferenceChangeKind;
  readonly previous: Readonly<PluginPackageSecretBindingTransitionEntryState> | null;
  readonly next: Readonly<PluginPackageSecretBindingTransitionEntryState> | null;
}

export interface PluginPackageSecretBindingTransitionPlan {
  readonly schema: typeof PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_PLAN_SCHEMA;
  readonly kind: PluginPackageSecretBindingTransitionKind;
  readonly previousTarget: Readonly<PluginPackageSecretBindingTarget>;
  readonly previousBinding: Readonly<PluginPackageSecretBinding> | null;
  readonly previousActiveLockDigest: string;
  readonly previousAttemptGeneration: number;
  readonly nextTarget: Readonly<PluginPackageSecretBinding['target']>;
  readonly nextBindingPlan: Readonly<PluginPackageSecretBindingPlan> | null;
  readonly changes: readonly Readonly<PluginPackageSecretBindingTransitionChange>[];
  readonly transitionDigest: string;
}

export interface CreatePluginPackageSecretBindingTransitionPlanInput {
  readonly previousTarget: Readonly<PluginPackageSecretBindingTarget>;
  readonly previousBinding: Readonly<PluginPackageSecretBinding> | null;
  readonly previousAttemptGeneration: number;
  readonly nextGeneration: Parameters<
    typeof normalizePluginPackageResourceGeneration
  >[0];
  readonly nextManifest: Readonly<PluginPackageManifest>;
  readonly assignments: readonly Readonly<PluginPackageSecretBindingAssignment>[];
  readonly plannedAtMs: number;
}

const DIGEST = /^[0-9a-f]{64}$/;
const TRANSITION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-secret-binding-transition-plan-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new TypeError(
    `Plugin Package Secret binding transition plan is invalid: ${message}`,
  );
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    )
  ) {
    return invalid(`${label} must contain enumerable data properties`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(value);
  const strings = actual.filter(
    (key): key is string => typeof key === 'string',
  );
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    strings.length !== canonical.length ||
    strings.sort().some((key, index) => key !== canonical[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function entryState(
  entry: Readonly<PluginPackageSecretBindingEntry>,
): Readonly<PluginPackageSecretBindingTransitionEntryState> {
  return Object.freeze({
    required: entry.required,
    secretRef: entry.secretRef,
  });
}

function requirementChange(
  previous: Readonly<PluginPackageSecretBindingEntry> | undefined,
  next: Readonly<PluginPackageSecretBindingEntry> | undefined,
): PluginPackageSecretRequirementChangeKind {
  if (!previous) return 'added';
  if (!next) return 'removed';
  if (previous.required === next.required) return 'unchanged';
  return next.required ? 'tightened' : 'relaxed';
}

function referenceChange(
  previous: Readonly<PluginPackageSecretBindingEntry> | undefined,
  next: Readonly<PluginPackageSecretBindingEntry> | undefined,
): PluginPackageSecretReferenceChangeKind {
  const before = previous?.secretRef ?? null;
  const after = next?.secretRef ?? null;
  if (before === after) return 'unchanged';
  if (before === null) return 'bound';
  if (after === null) return 'revoked';
  const previousReference = parseSecretRef(before);
  const nextReference = parseSecretRef(after);
  if (
    previousReference.projectId === nextReference.projectId &&
    previousReference.name === nextReference.name &&
    previousReference.version !== undefined &&
    nextReference.version !== undefined &&
    nextReference.version > previousReference.version
  ) {
    return 'rotated';
  }
  return 'rebound';
}

function deriveChanges(
  previousEntries: readonly Readonly<PluginPackageSecretBindingEntry>[],
  nextEntries: readonly Readonly<PluginPackageSecretBindingEntry>[],
): readonly Readonly<PluginPackageSecretBindingTransitionChange>[] {
  const previous = new Map(previousEntries.map((entry) => [entry.name, entry]));
  const next = new Map(nextEntries.map((entry) => [entry.name, entry]));
  const names = [...new Set([...previous.keys(), ...next.keys()])].sort();
  return Object.freeze(
    names.map((name) => {
      const before = previous.get(name);
      const after = next.get(name);
      return Object.freeze({
        name,
        requirement: requirementChange(before, after),
        reference: referenceChange(before, after),
        previous: before ? entryState(before) : null,
        next: after ? entryState(after) : null,
      });
    }),
  );
}

function deriveKind(
  changes: readonly Readonly<PluginPackageSecretBindingTransitionChange>[],
): PluginPackageSecretBindingTransitionKind {
  if (
    changes.some(
      (change) =>
        change.requirement === 'removed' || change.reference === 'revoked',
    )
  ) {
    return 'revoke';
  }
  if (
    changes.some(
      (change) =>
        change.requirement !== 'unchanged' ||
        change.reference === 'bound' ||
        change.reference === 'rebound',
    )
  ) {
    return 'rebind';
  }
  if (changes.some((change) => change.reference === 'rotated')) {
    return 'rotate';
  }
  return 'carry-forward';
}

function assertLineage(
  previousTarget: Readonly<PluginPackageSecretBindingTarget>,
  nextTarget: Readonly<PluginPackageSecretBinding['target']>,
  previousActiveLockDigest: unknown,
  previousAttemptGeneration: unknown,
): Readonly<{
  previousActiveLockDigest: string;
  previousAttemptGeneration: number;
}> {
  if (
    typeof previousActiveLockDigest !== 'string' ||
    !DIGEST.test(previousActiveLockDigest) ||
    previousActiveLockDigest !== previousTarget.lockDigest
  ) {
    return invalid('previous active lock digest is invalid');
  }
  if (
    !Number.isSafeInteger(previousAttemptGeneration) ||
    (previousAttemptGeneration as number) < previousTarget.generation ||
    (previousAttemptGeneration as number) >= 2_147_483_647
  ) {
    return invalid('previous attempt generation is invalid');
  }
  if (
    nextTarget.projectId !== previousTarget.projectId ||
    nextTarget.packageName !== previousTarget.packageName ||
    nextTarget.generation !== (previousAttemptGeneration as number) + 1 ||
    nextTarget.installationId === previousTarget.installationId ||
    nextTarget.lockDigest === previousTarget.lockDigest
  ) {
    return invalid(
      'next target is not the immediate durable attempt generation',
    );
  }
  return Object.freeze({
    previousActiveLockDigest,
    previousAttemptGeneration: previousAttemptGeneration as number,
  });
}

function unsignedPlan(
  previousTarget: Readonly<PluginPackageSecretBindingTarget>,
  previousBinding: Readonly<PluginPackageSecretBinding> | null,
  previousActiveLockDigest: string,
  previousAttemptGeneration: number,
  nextTarget: Readonly<PluginPackageSecretBinding['target']>,
  nextBindingPlan: Readonly<PluginPackageSecretBindingPlan> | null,
): Omit<PluginPackageSecretBindingTransitionPlan, 'transitionDigest'> {
  const changes = deriveChanges(
    previousBinding?.entries ?? [],
    nextBindingPlan?.entries ?? [],
  );
  return Object.freeze({
    schema: PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_PLAN_SCHEMA,
    kind: deriveKind(changes),
    previousTarget,
    previousBinding,
    previousActiveLockDigest,
    previousAttemptGeneration,
    nextTarget,
    nextBindingPlan,
    changes,
  });
}

function transitionDigest(
  value: Omit<PluginPackageSecretBindingTransitionPlan, 'transitionDigest'>,
): string {
  return createHash('sha256')
    .update(TRANSITION_DIGEST_DOMAIN)
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function withDigest(
  value: Omit<PluginPackageSecretBindingTransitionPlan, 'transitionDigest'>,
): Readonly<PluginPackageSecretBindingTransitionPlan> {
  const result = Object.freeze({
    ...value,
    transitionDigest: transitionDigest(value),
  });
  if (
    Buffer.byteLength(JSON.stringify(result), 'utf8') >
    MAX_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_PLAN_JSON_BYTES
  ) {
    return invalid('durable JSON byte budget exceeded');
  }
  return result;
}

export function createPluginPackageSecretBindingTransitionPlan(
  input: CreatePluginPackageSecretBindingTransitionPlanInput,
): Readonly<PluginPackageSecretBindingTransitionPlan> {
  const inputValue = dataRecord(input, 'transition plan input');
  exactKeys(
    inputValue,
    [
      'assignments',
      'nextGeneration',
      'nextManifest',
      'plannedAtMs',
      'previousAttemptGeneration',
      'previousBinding',
      'previousTarget',
    ],
    'transition plan input',
  );
  const previousTarget = normalizePluginPackageSecretBindingTarget(
    input.previousTarget,
  );
  const previousBinding =
    input.previousBinding === null
      ? null
      : normalizePluginPackageSecretBinding(input.previousBinding);
  if (
    previousBinding !== null &&
    JSON.stringify(previousBinding.target) !== JSON.stringify(previousTarget)
  ) {
    return invalid('previous binding does not match the previous target');
  }
  const nextGeneration = normalizePluginPackageResourceGeneration(
    input.nextGeneration,
  );
  const nextManifest = normalizePluginPackageManifest(input.nextManifest);
  if (
    nextGeneration.previousActiveLockDigest !==
    previousTarget.lockDigest
  ) {
    return invalid('next generation does not name the previous active lock');
  }
  const nextTarget = createPluginPackageSecretBindingTarget(
    nextGeneration,
    nextManifest,
  );
  const requirements = nextManifest.spec.permissions.secrets;
  if (requirements.length === 0 && input.assignments.length !== 0) {
    return invalid(
      'assignments must be empty when the next Manifest has no Secrets',
    );
  }
  const nextBindingPlan =
    requirements.length === 0
      ? null
      : createPluginPackageSecretBindingPlan({
          generation: nextGeneration,
          manifest: nextManifest,
          assignments: input.assignments,
          plannedAtMs: input.plannedAtMs,
        });
  const lineage = assertLineage(
    previousTarget,
    nextTarget,
    nextGeneration.previousActiveLockDigest,
    input.previousAttemptGeneration,
  );
  return withDigest(
    unsignedPlan(
      previousTarget,
      previousBinding,
      lineage.previousActiveLockDigest,
      lineage.previousAttemptGeneration,
      nextTarget,
      nextBindingPlan,
    ),
  );
}

export function normalizePluginPackageSecretBindingTransitionPlan(
  value: unknown,
): Readonly<PluginPackageSecretBindingTransitionPlan> {
  const plan = dataRecord(value, 'transition plan');
  exactKeys(
    plan,
    [
      'changes',
      'kind',
      'nextBindingPlan',
      'nextTarget',
      'previousActiveLockDigest',
      'previousAttemptGeneration',
      'previousBinding',
      'previousTarget',
      'schema',
      'transitionDigest',
    ],
    'transition plan',
  );
  if (plan.schema !== PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_PLAN_SCHEMA) {
    return invalid('schema is unsupported');
  }
  const previousTarget = normalizePluginPackageSecretBindingTarget(
    plan.previousTarget,
  );
  const previousBinding =
    plan.previousBinding === null
      ? null
      : normalizePluginPackageSecretBinding(plan.previousBinding);
  if (
    previousBinding !== null &&
    JSON.stringify(previousBinding.target) !== JSON.stringify(previousTarget)
  ) {
    return invalid('previous binding does not match the previous target');
  }
  const nextTarget = normalizePluginPackageSecretBindingTarget(plan.nextTarget);
  const nextBindingPlan =
    plan.nextBindingPlan === null
      ? null
      : normalizePluginPackageSecretBindingPlan(plan.nextBindingPlan);
  if (
    nextBindingPlan !== null &&
    JSON.stringify(nextBindingPlan.target) !== JSON.stringify(nextTarget)
  ) {
    return invalid('next binding plan does not match the next target');
  }
  const lineage = assertLineage(
    previousTarget,
    nextTarget,
    plan.previousActiveLockDigest,
    plan.previousAttemptGeneration,
  );
  const unsigned = unsignedPlan(
    previousTarget,
    previousBinding,
    lineage.previousActiveLockDigest,
    lineage.previousAttemptGeneration,
    nextTarget,
    nextBindingPlan,
  );
  if (
    JSON.stringify(plan.changes) !== JSON.stringify(unsigned.changes) ||
    plan.kind !== unsigned.kind
  ) {
    return invalid('derived transition classification does not match content');
  }
  if (
    typeof plan.transitionDigest !== 'string' ||
    !DIGEST.test(plan.transitionDigest) ||
    plan.transitionDigest !== transitionDigest(unsigned)
  ) {
    return invalid('transition digest does not match content');
  }
  return withDigest(unsigned);
}
