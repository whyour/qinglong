import { createHash } from 'node:crypto';

import {
  MAX_PLUGIN_PACKAGE_SECRETS,
  normalizePluginPackageManifest,
  type PluginPackageManifest,
  type PluginPackageSecretRequirement,
} from '../pluginPackage';
import { pluginPackageManifestDigest } from '../installation/pluginPackageInstall';
import {
  normalizePluginPackageResourceGeneration,
  type PluginPackageResourceGeneration,
} from '../pluginPackageResourceGeneration';
import { parseSecretRef } from '../../secret/secretReference';

export const PLUGIN_PACKAGE_SECRET_BINDING_SCHEMA =
  'qinglong/plugin-package-secret-binding@v1' as const;
export const PLUGIN_PACKAGE_SECRET_BINDING_AUTHORITY_KINDS = [
  'approved-action-execution',
  'local-owner-confirmation',
] as const;
export const MAX_PLUGIN_PACKAGE_SECRET_BINDING_JSON_BYTES = 64 * 1024;

export type PluginPackageSecretBindingAuthorityKind =
  (typeof PLUGIN_PACKAGE_SECRET_BINDING_AUTHORITY_KINDS)[number];

export interface PluginPackageSecretBindingTarget {
  readonly installationId: string;
  readonly projectId: string;
  readonly packageName: string;
  readonly lockDigest: string;
  readonly generation: number;
  readonly generationDigest: string;
  readonly manifestDigest: string;
}

export interface PluginPackageSecretBindingEntry {
  readonly name: string;
  readonly required: boolean;
  readonly secretRef: string | null;
}

export interface PluginPackageSecretBindingAuthority {
  readonly kind: PluginPackageSecretBindingAuthorityKind;
  readonly evidenceDigest: string;
}

export interface PluginPackageSecretBinding {
  readonly schema: typeof PLUGIN_PACKAGE_SECRET_BINDING_SCHEMA;
  readonly target: Readonly<PluginPackageSecretBindingTarget>;
  readonly entries: readonly Readonly<PluginPackageSecretBindingEntry>[];
  readonly authority: Readonly<PluginPackageSecretBindingAuthority>;
  readonly boundAtMs: number;
  readonly bindingDigest: string;
}

export interface PluginPackageSecretBindingAssignment {
  readonly name: string;
  readonly secretRef: string | null;
}

export interface CreatePluginPackageSecretBindingInput {
  readonly generation: Readonly<PluginPackageResourceGeneration>;
  readonly manifest: Readonly<PluginPackageManifest>;
  readonly assignments: readonly Readonly<PluginPackageSecretBindingAssignment>[];
  readonly authority: Readonly<PluginPackageSecretBindingAuthority>;
  readonly boundAtMs: number;
}

export interface CreatePluginPackageSecretBindingFromEntriesInput {
  readonly target: Readonly<PluginPackageSecretBindingTarget>;
  readonly entries: readonly Readonly<PluginPackageSecretBindingEntry>[];
  readonly authority: Readonly<PluginPackageSecretBindingAuthority>;
  readonly boundAtMs: number;
}

export interface PluginPackageSecretBindingRepository {
  find(
    generationDigest: string,
  ): Promise<Readonly<PluginPackageSecretBinding> | null>;
  publish(binding: Readonly<PluginPackageSecretBinding>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      binding: Readonly<PluginPackageSecretBinding>;
    }>
  >;
}

export class InvalidPluginPackageSecretBindingError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_SECRET_BINDING_INVALID';

  constructor(message: string) {
    super(`Plugin Package Secret binding is invalid: ${message}`);
    this.name = 'InvalidPluginPackageSecretBindingError';
  }
}

export class PluginPackageSecretBindingConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_SECRET_BINDING_CONFLICT';

  constructor(message: string) {
    super(`Plugin Package Secret binding conflicts with state: ${message}`);
    this.name = 'PluginPackageSecretBindingConflictError';
  }
}

export class PluginPackageSecretBindingUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_SECRET_BINDING_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package Secret binding is unavailable', options);
    this.name = 'PluginPackageSecretBindingUnavailableError';
  }
}

const DIGEST = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const BINDING_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-secret-binding-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidPluginPackageSecretBindingError(message);
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
  const stringKeys = actual.filter(
    (key): key is string => typeof key === 'string',
  );
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    stringKeys.length !== canonical.length ||
    stringKeys.sort().some((key, index) => key !== canonical[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function denseArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_PLUGIN_PACKAGE_SECRETS) {
    return invalid(`${label} is invalid`);
  }
  const keys = Object.keys(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    !ownKeys.includes('length') ||
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index))
  ) {
    return invalid(`${label} must be a dense data array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.some((key) => {
      const descriptor = descriptors[key];
      return (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      );
    })
  ) {
    return invalid(`${label} must be a dense data array`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function packageName(value: unknown): string {
  if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) {
    return invalid('Package name is invalid');
  }
  return value;
}

function generation(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 2_147_483_647
  ) {
    return invalid('generation is invalid');
  }
  return value as number;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid('boundAtMs is invalid');
  }
  return value as number;
}

function secretName(value: unknown): string {
  if (typeof value !== 'string' || !SECRET_NAME.test(value)) {
    return invalid('Secret requirement name is invalid');
  }
  return value;
}

function normalizeAuthority(
  value: unknown,
): Readonly<PluginPackageSecretBindingAuthority> {
  const authority = dataRecord(value, 'authority');
  exactKeys(authority, ['evidenceDigest', 'kind'], 'authority');
  if (
    !PLUGIN_PACKAGE_SECRET_BINDING_AUTHORITY_KINDS.includes(
      authority.kind as PluginPackageSecretBindingAuthorityKind,
    )
  ) {
    return invalid('authority kind is invalid');
  }
  return Object.freeze({
    kind: authority.kind as PluginPackageSecretBindingAuthorityKind,
    evidenceDigest: digest(
      authority.evidenceDigest,
      'authority evidence digest',
    ),
  });
}

function normalizeEntries(
  value: unknown,
  projectId: string,
): readonly Readonly<PluginPackageSecretBindingEntry>[] {
  const values = denseArray(value, 'entries');
  if (values.length === 0) return invalid('entries must not be empty');
  const seen = new Set<string>();
  const entries = values.map((entryValue) => {
    const entry = dataRecord(entryValue, 'entry');
    exactKeys(entry, ['name', 'required', 'secretRef'], 'entry');
    const name = secretName(entry.name);
    if (seen.has(name)) return invalid('Secret requirement is duplicated');
    seen.add(name);
    if (typeof entry.required !== 'boolean') {
      return invalid('Secret requirement required flag is invalid');
    }
    if (entry.secretRef === null) {
      if (entry.required) return invalid(`required Secret ${name} is unbound`);
      return Object.freeze({ name, required: false, secretRef: null });
    }
    let reference;
    try {
      reference = parseSecretRef(entry.secretRef);
    } catch {
      return invalid(`Secret ${name} reference is invalid`);
    }
    if (reference.projectId !== projectId) {
      return invalid(`Secret ${name} reference crosses Project boundary`);
    }
    if (reference.version === undefined) {
      return invalid(`Secret ${name} reference must pin an explicit version`);
    }
    return Object.freeze({
      name,
      required: entry.required,
      secretRef: entry.secretRef as string,
    });
  });
  const sorted = [...entries].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  if (entries.some((entry, index) => entry !== sorted[index])) {
    return invalid('entries are not in canonical order');
  }
  return Object.freeze(entries);
}

function targetFromGeneration(
  generation: Readonly<PluginPackageResourceGeneration>,
  manifestDigest: string,
): Readonly<PluginPackageSecretBindingTarget> {
  return Object.freeze({
    installationId: generation.installationId,
    projectId: generation.projectId,
    packageName: generation.packageName,
    lockDigest: generation.lockDigest,
    generation: generation.generation,
    generationDigest: generation.generationDigest,
    manifestDigest,
  });
}

export function createPluginPackageSecretBindingTarget(
  generationValue: Readonly<PluginPackageResourceGeneration>,
  manifestValue: Readonly<PluginPackageManifest>,
): Readonly<PluginPackageSecretBindingTarget> {
  const generation = normalizePluginPackageResourceGeneration(generationValue);
  const manifest = normalizePluginPackageManifest(manifestValue);
  if (manifest.metadata.name !== generation.packageName) {
    return invalid('Manifest Package does not match generation');
  }
  return targetFromGeneration(
    generation,
    pluginPackageManifestDigest(manifest),
  );
}

function unsignedBinding(
  target: Readonly<PluginPackageSecretBindingTarget>,
  entries: readonly Readonly<PluginPackageSecretBindingEntry>[],
  authority: Readonly<PluginPackageSecretBindingAuthority>,
  boundAtMs: number,
): Omit<PluginPackageSecretBinding, 'bindingDigest'> {
  return {
    schema: PLUGIN_PACKAGE_SECRET_BINDING_SCHEMA,
    target,
    entries,
    authority,
    boundAtMs,
  };
}

function bindingDigest(
  value: Omit<PluginPackageSecretBinding, 'bindingDigest'>,
): string {
  return createHash('sha256')
    .update(BINDING_DIGEST_DOMAIN)
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function entriesFromAssignments(
  requirements: readonly Readonly<PluginPackageSecretRequirement>[],
  assignmentsValue: unknown,
  projectId: string,
): readonly Readonly<PluginPackageSecretBindingEntry>[] {
  if (requirements.length === 0) {
    return invalid('Manifest does not declare Secret requirements');
  }
  const assignments = denseArray(assignmentsValue, 'assignments');
  const mapped = new Map<string, string | null>();
  for (const assignmentValue of assignments) {
    const assignment = dataRecord(assignmentValue, 'assignment');
    exactKeys(assignment, ['name', 'secretRef'], 'assignment');
    const name = secretName(assignment.name);
    if (mapped.has(name)) return invalid('Secret assignment is duplicated');
    if (
      assignment.secretRef !== null &&
      typeof assignment.secretRef !== 'string'
    ) {
      return invalid(`Secret ${name} assignment is invalid`);
    }
    mapped.set(name, assignment.secretRef as string | null);
  }
  if (
    mapped.size !== requirements.length ||
    requirements.some((requirement) => !mapped.has(requirement.name))
  ) {
    return invalid('assignments do not exactly match Manifest requirements');
  }
  return normalizeEntries(
    requirements.map((requirement) => ({
      name: requirement.name,
      required: requirement.required,
      secretRef: mapped.get(requirement.name) ?? null,
    })),
    projectId,
  );
}

export function createPluginPackageSecretBinding(
  input: CreatePluginPackageSecretBindingInput,
): Readonly<PluginPackageSecretBinding> {
  const generation = normalizePluginPackageResourceGeneration(input.generation);
  const manifest = normalizePluginPackageManifest(input.manifest);
  if (manifest.metadata.name !== generation.packageName) {
    return invalid('Manifest Package does not match generation');
  }
  const target = targetFromGeneration(
    generation,
    pluginPackageManifestDigest(manifest),
  );
  const entries = entriesFromAssignments(
    manifest.spec.permissions.secrets,
    input.assignments,
    generation.projectId,
  );
  const authority = normalizeAuthority(input.authority);
  const boundAtMs = timestamp(input.boundAtMs);
  const unsigned = unsignedBinding(target, entries, authority, boundAtMs);
  return Object.freeze({ ...unsigned, bindingDigest: bindingDigest(unsigned) });
}

export function createPluginPackageSecretBindingFromEntries(
  input: CreatePluginPackageSecretBindingFromEntriesInput,
): Readonly<PluginPackageSecretBinding> {
  const target = normalizeTarget(input.target);
  const entries = normalizeEntries(input.entries, target.projectId);
  const authority = normalizeAuthority(input.authority);
  const boundAtMs = timestamp(input.boundAtMs);
  const unsigned = unsignedBinding(target, entries, authority, boundAtMs);
  return normalizePluginPackageSecretBinding({
    ...unsigned,
    bindingDigest: bindingDigest(unsigned),
  });
}

function normalizeTarget(
  value: unknown,
): Readonly<PluginPackageSecretBindingTarget> {
  const targetValue = dataRecord(value, 'target');
  exactKeys(
    targetValue,
    [
      'generation',
      'generationDigest',
      'installationId',
      'lockDigest',
      'manifestDigest',
      'packageName',
      'projectId',
    ],
    'target',
  );
  return Object.freeze({
    installationId: identifier(targetValue.installationId, 'installation ID'),
    projectId: identifier(targetValue.projectId, 'Project ID'),
    packageName: packageName(targetValue.packageName),
    lockDigest: digest(targetValue.lockDigest, 'lock digest'),
    generation: generation(targetValue.generation),
    generationDigest: digest(targetValue.generationDigest, 'generation digest'),
    manifestDigest: digest(targetValue.manifestDigest, 'Manifest digest'),
  });
}

export function normalizePluginPackageSecretBindingTarget(
  value: unknown,
): Readonly<PluginPackageSecretBindingTarget> {
  return normalizeTarget(value);
}

export function normalizePluginPackageSecretBinding(
  value: unknown,
): Readonly<PluginPackageSecretBinding> {
  const binding = dataRecord(value, 'binding');
  exactKeys(
    binding,
    ['authority', 'bindingDigest', 'boundAtMs', 'entries', 'schema', 'target'],
    'binding',
  );
  if (binding.schema !== PLUGIN_PACKAGE_SECRET_BINDING_SCHEMA) {
    return invalid('schema is unsupported');
  }
  const target = normalizeTarget(binding.target);
  const entries = normalizeEntries(binding.entries, target.projectId);
  const authority = normalizeAuthority(binding.authority);
  const boundAtMs = timestamp(binding.boundAtMs);
  const unsigned = unsignedBinding(target, entries, authority, boundAtMs);
  if (
    digest(binding.bindingDigest, 'binding digest') !== bindingDigest(unsigned)
  ) {
    return invalid('binding digest does not match content');
  }
  const normalized = Object.freeze({
    ...unsigned,
    bindingDigest: binding.bindingDigest as string,
  });
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
    MAX_PLUGIN_PACKAGE_SECRET_BINDING_JSON_BYTES
  ) {
    return invalid('durable JSON byte budget exceeded');
  }
  return normalized;
}

export function assertPluginPackageSecretBindingMatches(
  value: unknown,
  generationValue: Readonly<PluginPackageResourceGeneration>,
  manifestValue: Readonly<PluginPackageManifest>,
): Readonly<PluginPackageSecretBinding> {
  const binding = normalizePluginPackageSecretBinding(value);
  const generation = normalizePluginPackageResourceGeneration(generationValue);
  const manifest = normalizePluginPackageManifest(manifestValue);
  const expectedTarget = targetFromGeneration(
    generation,
    pluginPackageManifestDigest(manifest),
  );
  if (JSON.stringify(binding.target) !== JSON.stringify(expectedTarget)) {
    return invalid('target does not match generation and Manifest');
  }
  if (
    binding.entries.length !== manifest.spec.permissions.secrets.length ||
    binding.entries.some((entry, index) => {
      const requirement = manifest.spec.permissions.secrets[index];
      return (
        requirement === undefined ||
        entry.name !== requirement.name ||
        entry.required !== requirement.required
      );
    })
  ) {
    return invalid('entries do not exactly match Manifest requirements');
  }
  return binding;
}
