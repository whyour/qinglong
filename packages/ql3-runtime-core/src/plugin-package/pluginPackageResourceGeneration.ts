import { createHash } from 'node:crypto';

import {
  MAX_PLUGIN_PACKAGE_CONTENT_ENTRIES,
  MAX_PLUGIN_PACKAGE_CONTENT_PATH_BYTES,
  type PluginPackageContents,
} from './pluginPackage';

export const PLUGIN_PACKAGE_RESOURCE_GENERATION_SCHEMA =
  'qinglong/plugin-package-resource-generation@v1' as const;
export const PLUGIN_PACKAGE_RESOURCE_KINDS = [
  'prompt',
  'task',
  'tool',
  'workflow',
] as const;
export const MAX_PLUGIN_PACKAGE_RESOURCE_PATH_BYTES =
  MAX_PLUGIN_PACKAGE_CONTENT_PATH_BYTES;
export const MAX_PLUGIN_PACKAGE_RESOURCE_GENERATION = 2_147_483_647;

export type PluginPackageResourceKind =
  (typeof PLUGIN_PACKAGE_RESOURCE_KINDS)[number];

export interface PluginPackageResourceReference {
  readonly kind: PluginPackageResourceKind;
  readonly path: string;
}

export interface PluginPackageResourceGeneration {
  readonly schema: typeof PLUGIN_PACKAGE_RESOURCE_GENERATION_SCHEMA;
  readonly installationId: string;
  readonly projectId: string;
  readonly packageName: string;
  readonly lockDigest: string;
  readonly generation: number;
  readonly previousActiveLockDigest: string | null;
  readonly contentDigest: string;
  readonly resources: readonly Readonly<PluginPackageResourceReference>[];
  readonly generationDigest: string;
}

export interface CreatePluginPackageResourceGenerationInput {
  readonly installationId: string;
  readonly projectId: string;
  readonly packageName: string;
  readonly lockDigest: string;
  readonly generation: number;
  readonly previousActiveLockDigest: string | null;
  readonly contentDigest: string;
  readonly contents: Readonly<PluginPackageContents>;
}

export interface CreatePluginPackageResourceGenerationFromReferencesInput {
  readonly installationId: string;
  readonly projectId: string;
  readonly packageName: string;
  readonly lockDigest: string;
  readonly generation: number;
  readonly previousActiveLockDigest: string | null;
  readonly contentDigest: string;
  readonly resources: readonly Readonly<PluginPackageResourceReference>[];
}

export interface PluginPackageResourceGenerationSource {
  findActiveResourceGeneration(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageResourceGeneration> | null>;
}

export class InvalidPluginPackageResourceGenerationError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_RESOURCE_GENERATION_INVALID';

  constructor(message: string) {
    super(`Plugin Package resource generation is invalid: ${message}`);
    this.name = 'InvalidPluginPackageResourceGenerationError';
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGEST = /^[0-9a-f]{64}$/;
const RESOURCE_DIRECTORY = Object.freeze({
  prompt: 'prompts',
  task: 'tasks',
  tool: 'tools',
  workflow: 'workflows',
} satisfies Readonly<Record<PluginPackageResourceKind, string>>);
const GENERATION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-resource-generation-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidPluginPackageResourceGenerationError(message);
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

function boundedDenseArray(value: unknown, label: string): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_PLUGIN_PACKAGE_CONTENT_ENTRIES
  ) {
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

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function packageName(value: unknown): string {
  if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) {
    return invalid('package name is invalid');
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function generation(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_PLUGIN_PACKAGE_RESOURCE_GENERATION
  ) {
    return invalid('generation is invalid');
  }
  return value as number;
}

function resourcePath(value: unknown, kind: PluginPackageResourceKind): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_PLUGIN_PACKAGE_RESOURCE_PATH_BYTES ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    return invalid('resource path is invalid');
  }
  const segments = value.split('/');
  if (
    segments.length < 2 ||
    segments[0] !== RESOURCE_DIRECTORY[kind] ||
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    return invalid('resource path is invalid');
  }
  return value;
}

function compareResourceReferences(
  left: Readonly<PluginPackageResourceReference>,
  right: Readonly<PluginPackageResourceReference>,
): number {
  const kind = left.kind.localeCompare(right.kind);
  return kind === 0 ? left.path.localeCompare(right.path) : kind;
}

export function normalizePluginPackageResourceReferences(
  value: unknown,
): readonly Readonly<PluginPackageResourceReference>[] {
  const entries = boundedDenseArray(value, 'resources');
  const seen = new Set<string>();
  const resources = entries.map((entryValue) => {
    const entry = dataRecord(entryValue, 'resource reference');
    exactKeys(entry, ['kind', 'path'], 'resource reference');
    if (
      !PLUGIN_PACKAGE_RESOURCE_KINDS.includes(
        entry.kind as PluginPackageResourceKind,
      )
    ) {
      return invalid('resource kind is invalid');
    }
    const kind = entry.kind as PluginPackageResourceKind;
    const path = resourcePath(entry.path, kind);
    if (seen.has(path)) return invalid('resource path is duplicated');
    seen.add(path);
    return Object.freeze({ kind, path });
  });
  const sorted = [...resources].sort(compareResourceReferences);
  if (
    resources.some(
      (resource, index) =>
        resource.kind !== sorted[index]?.kind ||
        resource.path !== sorted[index]?.path,
    )
  ) {
    return invalid('resources are not in canonical order');
  }
  return Object.freeze(resources);
}

export function pluginPackageResourceReferencesFromContents(
  value: Readonly<PluginPackageContents>,
): readonly Readonly<PluginPackageResourceReference>[] {
  const contents = dataRecord(value, 'contents');
  exactKeys(contents, ['prompts', 'tasks', 'tools', 'workflows'], 'contents');
  const references: PluginPackageResourceReference[] = [];
  const append = (kind: PluginPackageResourceKind, paths: unknown): void => {
    const entries = boundedDenseArray(paths, `${kind} contents`);
    if (
      references.length + entries.length >
      MAX_PLUGIN_PACKAGE_CONTENT_ENTRIES
    ) {
      return invalid('resource budget is exceeded');
    }
    for (const path of entries) {
      references.push(Object.freeze({ kind, path: resourcePath(path, kind) }));
    }
  };
  append('prompt', contents.prompts);
  append('task', contents.tasks);
  append('tool', contents.tools);
  append('workflow', contents.workflows);
  references.sort(compareResourceReferences);
  return normalizePluginPackageResourceReferences(references);
}

function unsignedGeneration(
  value: Omit<PluginPackageResourceGeneration, 'generationDigest'>,
): Omit<PluginPackageResourceGeneration, 'generationDigest'> {
  return value;
}

function resourceGenerationDigest(
  value: Omit<PluginPackageResourceGeneration, 'generationDigest'>,
): string {
  return createHash('sha256')
    .update(GENERATION_DIGEST_DOMAIN)
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function createWithResources(
  input: Record<string, unknown>,
  resources: readonly Readonly<PluginPackageResourceReference>[],
): Readonly<PluginPackageResourceGeneration> {
  const previousActiveLockDigest =
    input.previousActiveLockDigest === null
      ? null
      : digest(input.previousActiveLockDigest, 'previous active lock digest');
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_RESOURCE_GENERATION_SCHEMA,
    installationId: identifier(input.installationId, 'installation id'),
    projectId: identifier(input.projectId, 'project id'),
    packageName: packageName(input.packageName),
    lockDigest: digest(input.lockDigest, 'lock digest'),
    generation: generation(input.generation),
    previousActiveLockDigest,
    contentDigest: digest(input.contentDigest, 'content digest'),
    resources,
  });
  return Object.freeze({
    ...unsigned,
    generationDigest: resourceGenerationDigest(unsignedGeneration(unsigned)),
  });
}

export function createPluginPackageResourceGeneration(
  value: CreatePluginPackageResourceGenerationInput,
): Readonly<PluginPackageResourceGeneration> {
  const input = dataRecord(value, 'generation input');
  exactKeys(
    input,
    [
      'installationId',
      'projectId',
      'packageName',
      'lockDigest',
      'generation',
      'previousActiveLockDigest',
      'contentDigest',
      'contents',
    ],
    'generation input',
  );
  return createWithResources(
    input,
    pluginPackageResourceReferencesFromContents(
      input.contents as Readonly<PluginPackageContents>,
    ),
  );
}

export function createPluginPackageResourceGenerationFromReferences(
  value: CreatePluginPackageResourceGenerationFromReferencesInput,
): Readonly<PluginPackageResourceGeneration> {
  const input = dataRecord(value, 'generation input');
  exactKeys(
    input,
    [
      'installationId',
      'projectId',
      'packageName',
      'lockDigest',
      'generation',
      'previousActiveLockDigest',
      'contentDigest',
      'resources',
    ],
    'generation input',
  );
  return createWithResources(
    input,
    normalizePluginPackageResourceReferences(input.resources),
  );
}

export function normalizePluginPackageResourceGeneration(
  value: unknown,
): Readonly<PluginPackageResourceGeneration> {
  const generationValue = dataRecord(value, 'generation');
  exactKeys(
    generationValue,
    [
      'schema',
      'installationId',
      'projectId',
      'packageName',
      'lockDigest',
      'generation',
      'previousActiveLockDigest',
      'contentDigest',
      'resources',
      'generationDigest',
    ],
    'generation',
  );
  if (generationValue.schema !== PLUGIN_PACKAGE_RESOURCE_GENERATION_SCHEMA) {
    return invalid('schema is invalid');
  }
  const previousActiveLockDigest =
    generationValue.previousActiveLockDigest === null
      ? null
      : digest(
          generationValue.previousActiveLockDigest,
          'previous active lock digest',
        );
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_RESOURCE_GENERATION_SCHEMA,
    installationId: identifier(
      generationValue.installationId,
      'installation id',
    ),
    projectId: identifier(generationValue.projectId, 'project id'),
    packageName: packageName(generationValue.packageName),
    lockDigest: digest(generationValue.lockDigest, 'lock digest'),
    generation: generation(generationValue.generation),
    previousActiveLockDigest,
    contentDigest: digest(generationValue.contentDigest, 'content digest'),
    resources: normalizePluginPackageResourceReferences(
      generationValue.resources,
    ),
  });
  const generationDigest = digest(
    generationValue.generationDigest,
    'generation digest',
  );
  if (
    generationDigest !== resourceGenerationDigest(unsignedGeneration(unsigned))
  ) {
    return invalid('generation digest does not match its payload');
  }
  return Object.freeze({ ...unsigned, generationDigest });
}
