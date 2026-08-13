import { createHash } from 'node:crypto';

import {
  createPluginPackageSecretBinding,
  createPluginPackageSecretBindingFromEntries,
  type PluginPackageSecretBinding,
  type PluginPackageSecretBindingAssignment,
  type PluginPackageSecretBindingEntry,
  type PluginPackageSecretBindingTarget,
} from './binding';
import type { PluginPackageManifest } from '../pluginPackage';
import type { PluginPackageResourceGeneration } from '../pluginPackageResourceGeneration';

export const PLUGIN_PACKAGE_SECRET_BINDING_PLAN_SCHEMA =
  'qinglong/plugin-package-secret-binding-plan@v1' as const;
export const MAX_PLUGIN_PACKAGE_SECRET_BINDING_PLAN_JSON_BYTES = 64 * 1024;

export interface PluginPackageSecretBindingPlan {
  readonly schema: typeof PLUGIN_PACKAGE_SECRET_BINDING_PLAN_SCHEMA;
  readonly target: Readonly<PluginPackageSecretBindingTarget>;
  readonly entries: readonly Readonly<PluginPackageSecretBindingEntry>[];
  readonly plannedAtMs: number;
  readonly planDigest: string;
}

export interface CreatePluginPackageSecretBindingPlanInput {
  readonly generation: Readonly<PluginPackageResourceGeneration>;
  readonly manifest: Readonly<PluginPackageManifest>;
  readonly assignments: readonly Readonly<PluginPackageSecretBindingAssignment>[];
  readonly plannedAtMs: number;
}

const DIGEST = /^[0-9a-f]{64}$/;
const PLACEHOLDER_EVIDENCE_DIGEST = '0'.repeat(64);
const PLAN_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-secret-binding-plan-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new TypeError(
    `Plugin Package Secret binding plan is invalid: ${message}`,
  );
}

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    invalid('shape is invalid');
  }
}

function unsignedPlan(
  binding: Pick<PluginPackageSecretBinding, 'target' | 'entries'>,
  plannedAtMs: number,
): Omit<PluginPackageSecretBindingPlan, 'planDigest'> {
  if (!Number.isSafeInteger(plannedAtMs) || plannedAtMs < 0) {
    return invalid('plannedAtMs is invalid');
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_SECRET_BINDING_PLAN_SCHEMA,
    target: binding.target,
    entries: binding.entries,
    plannedAtMs,
  });
}

function planDigest(
  value: Omit<PluginPackageSecretBindingPlan, 'planDigest'>,
): string {
  return createHash('sha256')
    .update(PLAN_DIGEST_DOMAIN)
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function withDigest(
  value: Omit<PluginPackageSecretBindingPlan, 'planDigest'>,
): Readonly<PluginPackageSecretBindingPlan> {
  const normalized = Object.freeze({
    ...value,
    planDigest: planDigest(value),
  });
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
    MAX_PLUGIN_PACKAGE_SECRET_BINDING_PLAN_JSON_BYTES
  ) {
    return invalid('durable JSON byte budget exceeded');
  }
  return normalized;
}

export function createPluginPackageSecretBindingPlan(
  input: CreatePluginPackageSecretBindingPlanInput,
): Readonly<PluginPackageSecretBindingPlan> {
  const draft = createPluginPackageSecretBinding({
    generation: input.generation,
    manifest: input.manifest,
    assignments: input.assignments,
    authority: Object.freeze({
      kind: 'local-owner-confirmation',
      evidenceDigest: PLACEHOLDER_EVIDENCE_DIGEST,
    }),
    boundAtMs: 0,
  });
  return withDigest(unsignedPlan(draft, input.plannedAtMs));
}

export function normalizePluginPackageSecretBindingPlan(
  value: unknown,
): Readonly<PluginPackageSecretBindingPlan> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('value must be an object');
  }
  exactKeys(value, [
    'entries',
    'planDigest',
    'plannedAtMs',
    'schema',
    'target',
  ]);
  const candidate = value as PluginPackageSecretBindingPlan;
  if (candidate.schema !== PLUGIN_PACKAGE_SECRET_BINDING_PLAN_SCHEMA) {
    return invalid('schema is unsupported');
  }
  if (
    typeof candidate.planDigest !== 'string' ||
    !DIGEST.test(candidate.planDigest)
  ) {
    return invalid('plan digest is invalid');
  }
  const normalizedBinding = createPluginPackageSecretBindingFromEntries({
    target: candidate.target,
    entries: candidate.entries,
    authority: {
      kind: 'local-owner-confirmation',
      evidenceDigest: PLACEHOLDER_EVIDENCE_DIGEST,
    },
    boundAtMs: 0,
  });
  const unsigned = unsignedPlan(normalizedBinding, candidate.plannedAtMs);
  const normalized = withDigest(unsigned);
  if (normalized.planDigest !== candidate.planDigest) {
    return invalid('plan digest does not match content');
  }
  return normalized;
}

export function createPluginPackageSecretBindingFromPlan(
  planValue: unknown,
  authorityKind: PluginPackageSecretBinding['authority']['kind'],
  boundAtMs: number,
): Readonly<PluginPackageSecretBinding> {
  const plan = normalizePluginPackageSecretBindingPlan(planValue);
  return createPluginPackageSecretBindingFromEntries({
    target: plan.target,
    entries: plan.entries,
    authority: {
      kind: authorityKind,
      evidenceDigest: plan.planDigest,
    },
    boundAtMs,
  });
}
