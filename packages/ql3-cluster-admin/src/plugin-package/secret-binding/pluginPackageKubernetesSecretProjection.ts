import { createHash } from 'node:crypto';

import { PluginPackageActivationConflictError } from '@qinglong/runtime-core/plugin-package-activation';
import type { PluginPackageResourceGeneration } from '@qinglong/runtime-core/plugin-package-resource-generation';
import type { PluginPackageSecretBinding } from '@qinglong/runtime-core/plugin-package-secret-binding';
import type { PluginPackageSecretBindingTransitionReceipt } from '@qinglong/runtime-core/plugin-package-secret-binding-transition-receipt';
import { secretProjectionFileName } from '@qinglong/runtime-core/secret-projection';

export const PLUGIN_PACKAGE_KUBERNETES_SECRET_PROJECTION_SCHEMA =
  'qinglong/plugin-package-kubernetes-secret-projection@v1' as const;
export const PLUGIN_PACKAGE_KUBERNETES_SECRET_FILE_MODE = 0o440 as const;

const DIGEST = /^[0-9a-f]{64}$/;
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const ASSIGNMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const PROJECTION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-kubernetes-secret-projection-digest@v1\0',
  'utf8',
);

export interface PluginPackageKubernetesSecretProjectionItem {
  readonly key: string;
  readonly path: string;
}

export interface PluginPackageKubernetesSecretProjectionAssignment {
  readonly name: string;
  readonly required: boolean;
  readonly path: string | null;
}

export interface PluginPackageKubernetesSecretProjection {
  readonly schema: typeof PLUGIN_PACKAGE_KUBERNETES_SECRET_PROJECTION_SCHEMA;
  readonly sourceSecretName: string;
  readonly defaultMode: typeof PLUGIN_PACKAGE_KUBERNETES_SECRET_FILE_MODE;
  readonly generationDigest: string;
  readonly bindingDigest: string | null;
  readonly transitionReceiptDigest: string | null;
  readonly items: readonly Readonly<PluginPackageKubernetesSecretProjectionItem>[];
  readonly assignments: readonly Readonly<PluginPackageKubernetesSecretProjectionAssignment>[];
  readonly projectionDigest: string;
}

export interface PluginPackageKubernetesActiveDeployment {
  readonly resourceGeneration: Readonly<PluginPackageResourceGeneration>;
  readonly secretProjection: Readonly<PluginPackageKubernetesSecretProjection> | null;
}

export interface PluginPackageKubernetesProjectedSecretWorkloadVolume {
  readonly volume: Readonly<{
    readonly name: 'plugin-package-values';
    readonly secret: Readonly<{
      readonly secretName: string;
      readonly optional: false;
      readonly defaultMode: typeof PLUGIN_PACKAGE_KUBERNETES_SECRET_FILE_MODE;
      readonly items: readonly Readonly<PluginPackageKubernetesSecretProjectionItem>[];
    }>;
  }>;
  readonly volumeMount: Readonly<{
    readonly name: 'plugin-package-values';
    readonly mountPath: '/var/run/secrets/qinglong3/plugin-package-values';
    readonly readOnly: true;
  }>;
}

function conflict(): never {
  throw new PluginPackageActivationConflictError();
}

function dataRecord(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return conflict();
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
    return conflict();
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    conflict();
  }
}

export function isPluginPackageKubernetesSecretName(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 253 &&
    value.split('.').every((label) => DNS_LABEL.test(label))
  );
}

function digest(
  value: Omit<PluginPackageKubernetesSecretProjection, 'projectionDigest'>,
): string {
  return createHash('sha256')
    .update(PROJECTION_DIGEST_DOMAIN)
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function uniqueItems(
  assignments: readonly Readonly<PluginPackageKubernetesSecretProjectionAssignment>[],
): readonly Readonly<PluginPackageKubernetesSecretProjectionItem>[] {
  const seen = new Set<string>();
  return Object.freeze(
    assignments.flatMap((assignment) => {
      if (assignment.path === null || seen.has(assignment.path)) return [];
      seen.add(assignment.path);
      return [Object.freeze({ key: assignment.path, path: assignment.path })];
    }),
  );
}

export function createPluginPackageKubernetesSecretProjection(
  sourceSecretName: string,
  generationDigest: string,
  binding: Readonly<PluginPackageSecretBinding> | null,
  transition: Readonly<PluginPackageSecretBindingTransitionReceipt> | null,
): Readonly<PluginPackageKubernetesSecretProjection> | null {
  if (
    !isPluginPackageKubernetesSecretName(sourceSecretName) ||
    !DIGEST.test(generationDigest)
  ) {
    return conflict();
  }
  if (transition) {
    if (
      transition.transitionPlan.nextTarget.generationDigest !==
        generationDigest ||
      transition.bindingDigest !== (binding?.bindingDigest ?? null) ||
      JSON.stringify(
        transition.transitionPlan.nextBindingPlan?.entries ?? [],
      ) !== JSON.stringify(binding?.entries ?? [])
    ) {
      return conflict();
    }
  } else if (
    binding !== null &&
    binding.target.generationDigest !== generationDigest
  ) {
    return conflict();
  }
  if (!binding && !transition) return null;

  const assignments = Object.freeze(
    (binding?.entries ?? []).map((entry) =>
      Object.freeze({
        name: entry.name,
        required: entry.required,
        path:
          entry.secretRef === null
            ? null
            : secretProjectionFileName(entry.secretRef),
      }),
    ),
  );
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_KUBERNETES_SECRET_PROJECTION_SCHEMA,
    sourceSecretName,
    defaultMode: PLUGIN_PACKAGE_KUBERNETES_SECRET_FILE_MODE,
    generationDigest,
    bindingDigest: binding?.bindingDigest ?? null,
    transitionReceiptDigest: transition?.receiptDigest ?? null,
    items: uniqueItems(assignments),
    assignments,
  });
  return Object.freeze({ ...unsigned, projectionDigest: digest(unsigned) });
}

export function normalizePluginPackageKubernetesSecretProjection(
  value: unknown,
): Readonly<PluginPackageKubernetesSecretProjection> {
  const candidate = dataRecord(value);
  exactKeys(candidate, [
    'schema',
    'sourceSecretName',
    'defaultMode',
    'generationDigest',
    'bindingDigest',
    'transitionReceiptDigest',
    'items',
    'assignments',
    'projectionDigest',
  ]);
  if (
    candidate.schema !== PLUGIN_PACKAGE_KUBERNETES_SECRET_PROJECTION_SCHEMA ||
    !isPluginPackageKubernetesSecretName(candidate.sourceSecretName) ||
    candidate.defaultMode !== PLUGIN_PACKAGE_KUBERNETES_SECRET_FILE_MODE ||
    typeof candidate.generationDigest !== 'string' ||
    !DIGEST.test(candidate.generationDigest) ||
    (candidate.bindingDigest !== null &&
      (typeof candidate.bindingDigest !== 'string' ||
        !DIGEST.test(candidate.bindingDigest))) ||
    (candidate.transitionReceiptDigest !== null &&
      (typeof candidate.transitionReceiptDigest !== 'string' ||
        !DIGEST.test(candidate.transitionReceiptDigest))) ||
    !Array.isArray(candidate.items) ||
    !Array.isArray(candidate.assignments) ||
    candidate.items.length > 64 ||
    candidate.assignments.length > 64
  ) {
    return conflict();
  }
  const assignments = Object.freeze(
    candidate.assignments.map((value) => {
      const assignment = dataRecord(value);
      exactKeys(assignment, ['name', 'required', 'path']);
      if (
        typeof assignment.name !== 'string' ||
        !ASSIGNMENT_NAME.test(assignment.name) ||
        typeof assignment.required !== 'boolean' ||
        (assignment.path !== null &&
          (typeof assignment.path !== 'string' ||
            !DIGEST.test(assignment.path))) ||
        (assignment.required && assignment.path === null)
      ) {
        return conflict();
      }
      return Object.freeze({
        name: assignment.name,
        required: assignment.required,
        path: assignment.path as string | null,
      });
    }),
  );
  const items = Object.freeze(
    candidate.items.map((value) => {
      const item = dataRecord(value);
      exactKeys(item, ['key', 'path']);
      if (
        typeof item.key !== 'string' ||
        typeof item.path !== 'string' ||
        !DIGEST.test(item.key) ||
        item.path !== item.key
      ) {
        return conflict();
      }
      return Object.freeze({ key: item.key, path: item.path });
    }),
  );
  if (JSON.stringify(items) !== JSON.stringify(uniqueItems(assignments))) {
    return conflict();
  }
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_KUBERNETES_SECRET_PROJECTION_SCHEMA,
    sourceSecretName: candidate.sourceSecretName,
    defaultMode: PLUGIN_PACKAGE_KUBERNETES_SECRET_FILE_MODE,
    generationDigest: candidate.generationDigest,
    bindingDigest: candidate.bindingDigest as string | null,
    transitionReceiptDigest: candidate.transitionReceiptDigest as string | null,
    items,
    assignments,
  });
  if (
    typeof candidate.projectionDigest !== 'string' ||
    candidate.projectionDigest !== digest(unsigned)
  ) {
    return conflict();
  }
  return Object.freeze({
    ...unsigned,
    projectionDigest: candidate.projectionDigest,
  });
}

/**
 * Pure Pod-spec fragment renderer. An empty/revoked projection deliberately
 * returns null: an omitted/empty Secret items mapping can mean "all keys".
 */
export function pluginPackageKubernetesProjectedSecretWorkloadVolume(
  value: Readonly<PluginPackageKubernetesSecretProjection> | null,
): Readonly<PluginPackageKubernetesProjectedSecretWorkloadVolume> | null {
  if (value === null) return null;
  const projection = normalizePluginPackageKubernetesSecretProjection(value);
  if (projection.items.length === 0) return null;
  return Object.freeze({
    volume: Object.freeze({
      name: 'plugin-package-values' as const,
      secret: Object.freeze({
        secretName: projection.sourceSecretName,
        optional: false as const,
        defaultMode: PLUGIN_PACKAGE_KUBERNETES_SECRET_FILE_MODE,
        items: projection.items,
      }),
    }),
    volumeMount: Object.freeze({
      name: 'plugin-package-values' as const,
      mountPath: '/var/run/secrets/qinglong3/plugin-package-values' as const,
      readOnly: true as const,
    }),
  });
}
