import { createHash } from 'node:crypto';

import {
  createPluginPackageSecretBindingFromEntries,
  normalizePluginPackageSecretBinding,
  type PluginPackageSecretBinding,
  type PluginPackageSecretBindingAuthorityKind,
} from './binding';
import {
  normalizePluginPackageSecretBindingTransitionPlan,
  type PluginPackageSecretBindingTransitionPlan,
} from './transitionPlan';

export const PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_RECEIPT_SCHEMA =
  'qinglong/plugin-package-secret-binding-transition-receipt@v1' as const;
export const MAX_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_RECEIPT_JSON_BYTES =
  192 * 1024;

export interface PluginPackageSecretBindingTransitionReceiptAuthority {
  readonly kind: PluginPackageSecretBindingAuthorityKind;
  readonly evidenceDigest: string;
}

export interface PluginPackageSecretBindingTransitionReceipt {
  readonly schema: typeof PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_RECEIPT_SCHEMA;
  readonly transitionPlan: Readonly<PluginPackageSecretBindingTransitionPlan>;
  readonly authority: Readonly<PluginPackageSecretBindingTransitionReceiptAuthority>;
  readonly bindingDigest: string | null;
  readonly committedAtMs: number;
  readonly receiptDigest: string;
}

export interface CreatePluginPackageSecretBindingTransitionReceiptInput {
  readonly transitionPlan: Readonly<PluginPackageSecretBindingTransitionPlan>;
  readonly authority: Readonly<PluginPackageSecretBindingTransitionReceiptAuthority>;
  readonly binding: Readonly<PluginPackageSecretBinding> | null;
  readonly committedAtMs: number;
}

const DIGEST = /^[0-9a-f]{64}$/;
const RECEIPT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-secret-binding-transition-receipt-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new TypeError(
    `Plugin Package Secret binding transition receipt is invalid: ${message}`,
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

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid('committedAtMs is invalid');
  }
  return value as number;
}

function authority(
  value: unknown,
): Readonly<PluginPackageSecretBindingTransitionReceiptAuthority> {
  const candidate = dataRecord(value, 'authority');
  exactKeys(candidate, ['evidenceDigest', 'kind'], 'authority');
  if (
    candidate.kind !== 'approved-action-execution' &&
    candidate.kind !== 'local-owner-confirmation'
  ) {
    return invalid('authority kind is invalid');
  }
  if (
    typeof candidate.evidenceDigest !== 'string' ||
    !DIGEST.test(candidate.evidenceDigest)
  ) {
    return invalid('authority evidence digest is invalid');
  }
  return Object.freeze({
    kind: candidate.kind,
    evidenceDigest: candidate.evidenceDigest,
  });
}

function unsigned(
  transitionPlan: Readonly<PluginPackageSecretBindingTransitionPlan>,
  normalizedAuthority: Readonly<PluginPackageSecretBindingTransitionReceiptAuthority>,
  bindingDigest: string | null,
  committedAtMs: number,
): Omit<PluginPackageSecretBindingTransitionReceipt, 'receiptDigest'> {
  return Object.freeze({
    schema: PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_RECEIPT_SCHEMA,
    transitionPlan,
    authority: normalizedAuthority,
    bindingDigest,
    committedAtMs,
  });
}

function receiptDigest(
  value: Omit<PluginPackageSecretBindingTransitionReceipt, 'receiptDigest'>,
): string {
  return createHash('sha256')
    .update(RECEIPT_DIGEST_DOMAIN)
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function bounded(
  value: Readonly<PluginPackageSecretBindingTransitionReceipt>,
): Readonly<PluginPackageSecretBindingTransitionReceipt> {
  if (
    Buffer.byteLength(JSON.stringify(value), 'utf8') >
    MAX_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_RECEIPT_JSON_BYTES
  ) {
    return invalid('durable JSON byte budget exceeded');
  }
  return value;
}

function assertBinding(
  transitionPlan: Readonly<PluginPackageSecretBindingTransitionPlan>,
  bindingValue: Readonly<PluginPackageSecretBinding> | null,
  normalizedAuthority: Readonly<PluginPackageSecretBindingTransitionReceiptAuthority>,
  committedAtMs: number,
): Readonly<PluginPackageSecretBinding> | null {
  if (transitionPlan.nextBindingPlan === null) {
    if (bindingValue !== null) {
      return invalid(
        'binding is forbidden when the transition revokes all requirements',
      );
    }
    return null;
  }
  if (bindingValue === null) {
    return invalid('binding is required by the transition plan');
  }
  const binding = normalizePluginPackageSecretBinding(bindingValue);
  if (
    JSON.stringify(binding.target) !==
      JSON.stringify(transitionPlan.nextTarget) ||
    JSON.stringify(binding.entries) !==
      JSON.stringify(transitionPlan.nextBindingPlan.entries) ||
    binding.authority.kind !== normalizedAuthority.kind ||
    binding.authority.evidenceDigest !== normalizedAuthority.evidenceDigest ||
    binding.boundAtMs !== committedAtMs
  ) {
    return invalid(
      'binding does not match the transition, authority, and commit',
    );
  }
  return binding;
}

export function createPluginPackageSecretBindingFromTransitionPlan(
  planValue: Readonly<PluginPackageSecretBindingTransitionPlan>,
  authorityKind: PluginPackageSecretBindingAuthorityKind,
  evidenceDigest: string,
  boundAtMs: number,
): Readonly<PluginPackageSecretBinding> | null {
  const plan = normalizePluginPackageSecretBindingTransitionPlan(planValue);
  if (plan.nextBindingPlan === null) return null;
  return createPluginPackageSecretBindingFromEntries({
    target: plan.nextTarget,
    entries: plan.nextBindingPlan.entries,
    authority: { kind: authorityKind, evidenceDigest },
    boundAtMs,
  });
}

export function createPluginPackageSecretBindingTransitionReceipt(
  input: CreatePluginPackageSecretBindingTransitionReceiptInput,
): Readonly<PluginPackageSecretBindingTransitionReceipt> {
  const candidate = dataRecord(input, 'receipt input');
  exactKeys(
    candidate,
    ['authority', 'binding', 'committedAtMs', 'transitionPlan'],
    'receipt input',
  );
  const transitionPlan = normalizePluginPackageSecretBindingTransitionPlan(
    input.transitionPlan,
  );
  const normalizedAuthority = authority(input.authority);
  const committedAtMs = timestamp(input.committedAtMs);
  if (committedAtMs < (transitionPlan.nextBindingPlan?.plannedAtMs ?? 0)) {
    return invalid('commit precedes the reviewed next binding plan');
  }
  const binding = assertBinding(
    transitionPlan,
    input.binding,
    normalizedAuthority,
    committedAtMs,
  );
  const value = unsigned(
    transitionPlan,
    normalizedAuthority,
    binding?.bindingDigest ?? null,
    committedAtMs,
  );
  return bounded(
    Object.freeze({ ...value, receiptDigest: receiptDigest(value) }),
  );
}

export function normalizePluginPackageSecretBindingTransitionReceipt(
  value: unknown,
): Readonly<PluginPackageSecretBindingTransitionReceipt> {
  const candidate = dataRecord(value, 'receipt');
  exactKeys(
    candidate,
    [
      'authority',
      'bindingDigest',
      'committedAtMs',
      'receiptDigest',
      'schema',
      'transitionPlan',
    ],
    'receipt',
  );
  if (
    candidate.schema !== PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_RECEIPT_SCHEMA
  ) {
    return invalid('schema is unsupported');
  }
  const transitionPlan = normalizePluginPackageSecretBindingTransitionPlan(
    candidate.transitionPlan,
  );
  const normalizedAuthority = authority(candidate.authority);
  const committedAtMs = timestamp(candidate.committedAtMs);
  if (committedAtMs < (transitionPlan.nextBindingPlan?.plannedAtMs ?? 0)) {
    return invalid('commit precedes the reviewed next binding plan');
  }
  const bindingDigestValue = candidate.bindingDigest;
  if (
    (bindingDigestValue !== null &&
      (typeof bindingDigestValue !== 'string' ||
        !DIGEST.test(bindingDigestValue))) ||
    (transitionPlan.nextBindingPlan === null) !== (bindingDigestValue === null)
  ) {
    return invalid('binding digest presence is inconsistent with transition');
  }
  const normalized = unsigned(
    transitionPlan,
    normalizedAuthority,
    bindingDigestValue as string | null,
    committedAtMs,
  );
  if (
    typeof candidate.receiptDigest !== 'string' ||
    !DIGEST.test(candidate.receiptDigest) ||
    candidate.receiptDigest !== receiptDigest(normalized)
  ) {
    return invalid('receipt digest does not match content');
  }
  return bounded(
    Object.freeze({ ...normalized, receiptDigest: candidate.receiptDigest }),
  );
}

export interface PluginPackageSecretBindingTransitionReceiptRepository {
  find(
    generationDigest: string,
  ): Promise<Readonly<PluginPackageSecretBindingTransitionReceipt> | null>;
}
