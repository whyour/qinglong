import { createHash } from 'node:crypto';

import {
  MAX_PLUGIN_PACKAGE_RESOURCE_GENERATION,
  normalizePluginPackageResourceGeneration,
  type PluginPackageResourceGeneration,
} from '../../plugin-package/pluginPackageResourceGeneration';
import {
  normalizePluginPackageMaterializedRevision,
  pluginPackageToolDefinitions,
  type PluginPackageMaterializedRevision,
  type PluginPackageMaterializedRevisionRepository,
} from '../../plugin-package/pluginPackageResourceMaterialization';
import {
  MAX_TOOL_DEFINITIONS,
  ToolDefinitionRegistry,
  normalizeToolDefinition,
  type ToolDefinition,
} from './toolRegistry';
import { TaskSpecSemanticRegistry } from '../../task-definition/taskSpecSemantic';
import { assertProjectPolicyProjectId } from '../../security/project-policy/projectPolicy';

export const PROJECT_TOOL_DEFINITION_SNAPSHOT_SCHEMA =
  'qinglong/project-tool-definition-snapshot@v1' as const;
export const MAX_PROJECT_TOOL_SNAPSHOT_ACTIVE_PACKAGES = 128;
export const MAX_PROJECT_TOOL_DEFINITION_SNAPSHOT_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_TOOL_SNAPSHOT_SOURCE_PAGE_SIZE = 32;
export const MAX_PROJECT_TOOL_SNAPSHOT_RECOVERY_PAGE_SIZE = 64;
export const MAX_PROJECT_TOOL_SNAPSHOT_RECOVERY_PAGES = 64;

export interface ProjectToolDefinitionSnapshotSource {
  readonly installationId: string;
  readonly packageName: string;
  readonly generation: number;
  readonly generationDigest: string;
  readonly lockDigest: string;
  readonly revisionDigest: string;
}

export interface ProjectToolDefinitionSnapshotEntry {
  readonly packageName: string;
  readonly generationDigest: string;
  readonly revisionDigest: string;
  readonly definitionDigest: string;
  readonly definition: Readonly<ToolDefinition>;
}

export interface ProjectToolDefinitionSnapshot {
  readonly schema: typeof PROJECT_TOOL_DEFINITION_SNAPSHOT_SCHEMA;
  readonly projectId: string;
  readonly sources: readonly Readonly<ProjectToolDefinitionSnapshotSource>[];
  readonly definitions: readonly Readonly<ProjectToolDefinitionSnapshotEntry>[];
  readonly activeVectorDigest: string;
  readonly definitionsDigest: string;
  readonly snapshotDigest: string;
}

export interface ProjectToolDefinitionSnapshotContribution {
  readonly generation: Readonly<PluginPackageResourceGeneration>;
  readonly revisionDigest: string;
  readonly definitions: readonly Readonly<ToolDefinition>[];
}

export interface CreateProjectToolDefinitionSnapshotInput {
  readonly projectId: string;
  readonly contributions: readonly Readonly<ProjectToolDefinitionSnapshotContribution>[];
}

export interface ProjectToolDefinitionSnapshotRecord {
  readonly snapshot: Readonly<ProjectToolDefinitionSnapshot>;
  readonly committedAtMs: number;
}

export interface ProjectToolDefinitionSnapshotRepository {
  findCurrent(
    projectId: string,
  ): Promise<Readonly<ProjectToolDefinitionSnapshotRecord> | null>;
  publish(snapshot: Readonly<ProjectToolDefinitionSnapshot>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      record: Readonly<ProjectToolDefinitionSnapshotRecord>;
    }>
  >;
}

export interface ProjectToolDefinitionSnapshotSourceCursor {
  readonly packageName: string;
}

export interface ProjectToolDefinitionSnapshotSourcePage {
  readonly sources: readonly Readonly<ProjectToolDefinitionSnapshotSource>[];
  readonly truncated: boolean;
  readonly next?: Readonly<ProjectToolDefinitionSnapshotSourceCursor>;
}

export interface ProjectToolDefinitionSnapshotPendingProjectCursor {
  readonly projectId: string;
}

export interface ProjectToolDefinitionSnapshotPendingProjectPage {
  readonly projectIds: readonly string[];
  readonly truncated: boolean;
  readonly next?: Readonly<ProjectToolDefinitionSnapshotPendingProjectCursor>;
}

export interface ProjectToolDefinitionSnapshotSourceRepository {
  listActiveSourcePage(options: {
    readonly projectId: string;
    readonly limit: number;
    readonly after?: Readonly<ProjectToolDefinitionSnapshotSourceCursor>;
  }): Promise<Readonly<ProjectToolDefinitionSnapshotSourcePage>>;
  listPendingProjectPage(options: {
    readonly limit: number;
    readonly after?: Readonly<ProjectToolDefinitionSnapshotPendingProjectCursor>;
  }): Promise<Readonly<ProjectToolDefinitionSnapshotPendingProjectPage>>;
}

export interface ProjectToolDefinitionSnapshotPublicationResult {
  readonly status: 'created' | 'existing';
  readonly record: Readonly<ProjectToolDefinitionSnapshotRecord>;
}

export type ProjectToolDefinitionSnapshotRecoveryItemStatus =
  | 'manual_required'
  | 'retry'
  | 'settled';

export interface ProjectToolDefinitionSnapshotRecoveryItem {
  readonly projectId: string;
  readonly status: ProjectToolDefinitionSnapshotRecoveryItemStatus;
}

export interface ProjectToolDefinitionSnapshotRecoveryCycleResult {
  readonly pages: number;
  readonly scanned: number;
  readonly settled: number;
  readonly retry: number;
  readonly manualRequired: number;
  readonly remaining: boolean;
  readonly safeToAdmit: boolean;
}

export class InvalidProjectToolDefinitionSnapshotError extends TypeError {
  readonly code = 'PROJECT_TOOL_DEFINITION_SNAPSHOT_INVALID';

  constructor(message: string) {
    super(`Project Tool Definition snapshot is invalid: ${message}`);
    this.name = 'InvalidProjectToolDefinitionSnapshotError';
  }
}

export class ProjectToolDefinitionSnapshotConflictError extends Error {
  readonly code = 'PROJECT_TOOL_DEFINITION_SNAPSHOT_CONFLICT';

  constructor(message: string) {
    super(`Project Tool Definition snapshot conflicts with state: ${message}`);
    this.name = 'ProjectToolDefinitionSnapshotConflictError';
  }
}

export class ProjectToolDefinitionSnapshotUnavailableError extends Error {
  readonly code = 'PROJECT_TOOL_DEFINITION_SNAPSHOT_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Project Tool Definition snapshot is unavailable', options);
    this.name = 'ProjectToolDefinitionSnapshotUnavailableError';
  }
}

const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ACTIVE_VECTOR_DIGEST_DOMAIN = Buffer.from(
  'qinglong/project-tool-active-vector-digest@v1\0',
  'utf8',
);
const DEFINITION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-definition-digest@v1\0',
  'utf8',
);
const DEFINITIONS_DIGEST_DOMAIN = Buffer.from(
  'qinglong/project-tool-definitions-digest@v1\0',
  'utf8',
);
const SNAPSHOT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/project-tool-definition-snapshot-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidProjectToolDefinitionSnapshotError(message);
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
  required: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== required.length ||
    keys.some((key) => typeof key !== 'string' || !required.includes(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function projectId(value: unknown): string {
  try {
    assertProjectPolicyProjectId(value as string);
  } catch {
    return invalid('projectId is invalid');
  }
  return value as string;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function packageName(value: unknown): string {
  if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) {
    return invalid('packageName is invalid');
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

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = dataRecord(value, 'canonical value');
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function hash(domain: Uint8Array, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function compareSources(
  left: Readonly<ProjectToolDefinitionSnapshotSource>,
  right: Readonly<ProjectToolDefinitionSnapshotSource>,
): number {
  return left.packageName.localeCompare(right.packageName);
}

function compareDefinitions(
  left: Readonly<ProjectToolDefinitionSnapshotEntry>,
  right: Readonly<ProjectToolDefinitionSnapshotEntry>,
): number {
  return (
    left.definition.name.localeCompare(right.definition.name) ||
    left.definition.version.localeCompare(right.definition.version) ||
    left.packageName.localeCompare(right.packageName)
  );
}

function normalizeSource(
  value: ProjectToolDefinitionSnapshotSource,
): Readonly<ProjectToolDefinitionSnapshotSource> {
  const source = dataRecord(value, 'snapshot source');
  exactKeys(
    source,
    [
      'generation',
      'generationDigest',
      'installationId',
      'lockDigest',
      'packageName',
      'revisionDigest',
    ],
    'snapshot source',
  );
  return Object.freeze({
    installationId: identifier(value.installationId, 'installationId'),
    packageName: packageName(value.packageName),
    generation: generation(value.generation),
    generationDigest: digest(value.generationDigest, 'generationDigest'),
    lockDigest: digest(value.lockDigest, 'lockDigest'),
    revisionDigest: digest(value.revisionDigest, 'revisionDigest'),
  });
}

function normalizeEntry(
  value: ProjectToolDefinitionSnapshotEntry,
  sources: ReadonlyMap<string, Readonly<ProjectToolDefinitionSnapshotSource>>,
): Readonly<ProjectToolDefinitionSnapshotEntry> {
  const entry = dataRecord(value, 'snapshot definition');
  exactKeys(
    entry,
    [
      'definition',
      'definitionDigest',
      'generationDigest',
      'packageName',
      'revisionDigest',
    ],
    'snapshot definition',
  );
  const sourcePackageName = packageName(value.packageName);
  const source = sources.get(sourcePackageName);
  if (!source) return invalid('definition source Package is absent');
  const generationDigest = digest(
    value.generationDigest,
    'definition generationDigest',
  );
  const revisionDigest = digest(
    value.revisionDigest,
    'definition revisionDigest',
  );
  if (
    generationDigest !== source.generationDigest ||
    revisionDigest !== source.revisionDigest
  ) {
    return invalid('definition source identity does not match source vector');
  }
  let definition: Readonly<ToolDefinition>;
  try {
    definition = normalizeToolDefinition(value.definition);
  } catch {
    return invalid('Tool definition is invalid');
  }
  if (!definition.name.startsWith(`${sourcePackageName}.`)) {
    return invalid('Tool definition is outside its source Package namespace');
  }
  const definitionDigest = digest(value.definitionDigest, 'definitionDigest');
  if (hash(DEFINITION_DIGEST_DOMAIN, definition) !== definitionDigest) {
    return invalid('Tool definition digest does not match');
  }
  return Object.freeze({
    packageName: sourcePackageName,
    generationDigest,
    revisionDigest,
    definitionDigest,
    definition,
  });
}

function assertUniquelySorted<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
  label: string,
): void {
  if (
    values.some(
      (value, index) => index > 0 && compare(values[index - 1]!, value) >= 0,
    )
  ) {
    invalid(`${label} must be uniquely sorted`);
  }
}

function unsignedSnapshot(
  project: string,
  sources: readonly Readonly<ProjectToolDefinitionSnapshotSource>[],
  definitions: readonly Readonly<ProjectToolDefinitionSnapshotEntry>[],
): Omit<ProjectToolDefinitionSnapshot, 'snapshotDigest'> {
  const activeVectorDigest = projectToolDefinitionActiveVectorDigest(
    project,
    sources,
  );
  const definitionsDigest = hash(DEFINITIONS_DIGEST_DOMAIN, {
    projectId: project,
    definitions,
  });
  return Object.freeze({
    schema: PROJECT_TOOL_DEFINITION_SNAPSHOT_SCHEMA,
    projectId: project,
    sources,
    definitions,
    activeVectorDigest,
    definitionsDigest,
  });
}

export function projectToolDefinitionActiveVectorDigest(
  projectIdValue: string,
  sourceValues: readonly Readonly<ProjectToolDefinitionSnapshotSource>[],
): string {
  const project = projectId(projectIdValue);
  if (
    !Array.isArray(sourceValues) ||
    sourceValues.length > MAX_PROJECT_TOOL_SNAPSHOT_ACTIVE_PACKAGES
  ) {
    return invalid('snapshot source count is invalid');
  }
  const sources = Object.freeze(sourceValues.map(normalizeSource));
  assertUniquelySorted(sources, compareSources, 'snapshot sources');
  return hash(ACTIVE_VECTOR_DIGEST_DOMAIN, {
    projectId: project,
    sources,
  });
}

function assertSnapshotByteBudget(value: unknown): void {
  if (
    Buffer.byteLength(JSON.stringify(value), 'utf8') >
    MAX_PROJECT_TOOL_DEFINITION_SNAPSHOT_JSON_BYTES
  ) {
    invalid('snapshot JSON byte budget exceeded');
  }
}

export function normalizeProjectToolDefinitionSnapshot(
  value: ProjectToolDefinitionSnapshot,
): Readonly<ProjectToolDefinitionSnapshot> {
  const snapshot = dataRecord(value, 'snapshot');
  exactKeys(
    snapshot,
    [
      'activeVectorDigest',
      'definitions',
      'definitionsDigest',
      'projectId',
      'schema',
      'snapshotDigest',
      'sources',
    ],
    'snapshot',
  );
  if (value.schema !== PROJECT_TOOL_DEFINITION_SNAPSHOT_SCHEMA) {
    return invalid('snapshot schema is unsupported');
  }
  const project = projectId(value.projectId);
  if (
    !Array.isArray(value.sources) ||
    value.sources.length > MAX_PROJECT_TOOL_SNAPSHOT_ACTIVE_PACKAGES
  ) {
    return invalid('snapshot source count is invalid');
  }
  const sources = Object.freeze(value.sources.map(normalizeSource));
  assertUniquelySorted(sources, compareSources, 'snapshot sources');
  const byPackage = new Map(
    sources.map((source) => [source.packageName, source] as const),
  );
  if (
    !Array.isArray(value.definitions) ||
    value.definitions.length > MAX_TOOL_DEFINITIONS
  ) {
    return invalid('snapshot definition count is invalid');
  }
  const definitions = Object.freeze(
    value.definitions.map((entry) => normalizeEntry(entry, byPackage)),
  );
  assertUniquelySorted(definitions, compareDefinitions, 'snapshot definitions');
  try {
    new ToolDefinitionRegistry(definitions.map((entry) => entry.definition));
  } catch {
    return invalid('snapshot Tool identity is duplicated');
  }
  const unsigned = unsignedSnapshot(project, sources, definitions);
  if (
    digest(value.activeVectorDigest, 'activeVectorDigest') !==
      unsigned.activeVectorDigest ||
    digest(value.definitionsDigest, 'definitionsDigest') !==
      unsigned.definitionsDigest ||
    digest(value.snapshotDigest, 'snapshotDigest') !==
      hash(SNAPSHOT_DIGEST_DOMAIN, unsigned)
  ) {
    return invalid('snapshot digest does not match');
  }
  const normalized = Object.freeze({
    ...unsigned,
    snapshotDigest: value.snapshotDigest,
  });
  assertSnapshotByteBudget(normalized);
  return normalized;
}

export function projectToolDefinitionSnapshotContribution(
  revisionValue: PluginPackageMaterializedRevision,
  taskSpecSemanticRegistry: TaskSpecSemanticRegistry,
): Readonly<ProjectToolDefinitionSnapshotContribution> {
  if (!(taskSpecSemanticRegistry instanceof TaskSpecSemanticRegistry)) {
    return invalid('Task spec semantic registry is invalid');
  }
  let revision: Readonly<PluginPackageMaterializedRevision>;
  let definitions: readonly Readonly<ToolDefinition>[];
  try {
    revision = normalizePluginPackageMaterializedRevision(
      revisionValue,
      taskSpecSemanticRegistry,
    );
    definitions = pluginPackageToolDefinitions(
      revision,
      taskSpecSemanticRegistry,
    );
  } catch {
    return invalid('materialized revision is invalid');
  }
  return Object.freeze({
    generation: revision.generation,
    revisionDigest: revision.revisionDigest,
    definitions,
  });
}

export function createProjectToolDefinitionSnapshot(
  value: CreateProjectToolDefinitionSnapshotInput,
): Readonly<ProjectToolDefinitionSnapshot> {
  const input = dataRecord(value, 'snapshot input');
  exactKeys(input, ['contributions', 'projectId'], 'snapshot input');
  const project = projectId(value.projectId);
  if (
    !Array.isArray(value.contributions) ||
    value.contributions.length > MAX_PROJECT_TOOL_SNAPSHOT_ACTIVE_PACKAGES
  ) {
    return invalid('snapshot input is invalid');
  }
  const normalized = value.contributions.map((contributionValue) => {
    const contribution = dataRecord(contributionValue, 'snapshot contribution');
    exactKeys(
      contribution,
      ['definitions', 'generation', 'revisionDigest'],
      'snapshot contribution',
    );
    const generation = normalizePluginPackageResourceGeneration(
      contributionValue.generation,
    );
    if (!Array.isArray(contributionValue.definitions)) {
      return invalid('snapshot contribution definitions are invalid');
    }
    const definitions = contributionValue.definitions.map(
      (definitionValue: unknown) => {
        let definition: Readonly<ToolDefinition>;
        try {
          definition = normalizeToolDefinition(definitionValue);
        } catch {
          return invalid('snapshot contribution Tool definition is invalid');
        }
        if (!definition.name.startsWith(`${generation.packageName}.`)) {
          return invalid(
            'snapshot contribution Tool is outside its Package namespace',
          );
        }
        return definition;
      },
    );
    return Object.freeze({
      generation,
      revisionDigest: digest(
        contributionValue.revisionDigest,
        'contribution revisionDigest',
      ),
      definitions: Object.freeze(definitions),
    });
  });
  if (
    normalized.some(
      (contribution) => contribution.generation.projectId !== project,
    )
  ) {
    return invalid('snapshot contributions must belong to one Project');
  }
  normalized.sort((left, right) =>
    left.generation.packageName.localeCompare(right.generation.packageName),
  );
  if (
    normalized.some(
      (revision, index) =>
        index > 0 &&
        normalized[index - 1]!.generation.packageName ===
          revision.generation.packageName,
    )
  ) {
    return invalid('snapshot Package source is duplicated');
  }
  const sources = Object.freeze(
    normalized.map((revision) =>
      Object.freeze({
        installationId: revision.generation.installationId,
        packageName: revision.generation.packageName,
        generation: revision.generation.generation,
        generationDigest: revision.generation.generationDigest,
        lockDigest: revision.generation.lockDigest,
        revisionDigest: revision.revisionDigest,
      }),
    ),
  );
  const definitions: Readonly<ProjectToolDefinitionSnapshotEntry>[] = [];
  for (const contribution of normalized) {
    for (const definition of contribution.definitions) {
      if (definitions.length >= MAX_TOOL_DEFINITIONS) {
        return invalid('snapshot definition count is invalid');
      }
      definitions.push(
        Object.freeze({
          packageName: contribution.generation.packageName,
          generationDigest: contribution.generation.generationDigest,
          revisionDigest: contribution.revisionDigest,
          definitionDigest: hash(DEFINITION_DIGEST_DOMAIN, definition),
          definition,
        }),
      );
    }
  }
  definitions.sort(compareDefinitions);
  try {
    new ToolDefinitionRegistry(definitions.map((entry) => entry.definition));
  } catch {
    return invalid('snapshot Tool identity is duplicated');
  }
  const frozenDefinitions = Object.freeze(definitions);
  const unsigned = unsignedSnapshot(project, sources, frozenDefinitions);
  return normalizeProjectToolDefinitionSnapshot(
    Object.freeze({
      ...unsigned,
      snapshotDigest: hash(SNAPSHOT_DIGEST_DOMAIN, unsigned),
    }),
  );
}

export function projectToolDefinitionRegistry(
  value: ProjectToolDefinitionSnapshot,
): ToolDefinitionRegistry {
  const snapshot = normalizeProjectToolDefinitionSnapshot(value);
  return new ToolDefinitionRegistry(
    snapshot.definitions.map((entry) => entry.definition),
  );
}

export function normalizeProjectToolDefinitionSnapshotRecord(
  value: ProjectToolDefinitionSnapshotRecord,
): Readonly<ProjectToolDefinitionSnapshotRecord> {
  const record = dataRecord(value, 'snapshot record');
  exactKeys(record, ['committedAtMs', 'snapshot'], 'snapshot record');
  if (!Number.isSafeInteger(value.committedAtMs) || value.committedAtMs < 0) {
    return invalid('snapshot committedAtMs is invalid');
  }
  return Object.freeze({
    snapshot: normalizeProjectToolDefinitionSnapshot(value.snapshot),
    committedAtMs: value.committedAtMs,
  });
}

function positiveInteger(
  value: unknown,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function exactKeysWithOptional(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key !== 'string' || !allowed.has(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

export function assertProjectToolDefinitionSnapshotSourcePageSize(
  value: number,
): void {
  positiveInteger(
    value,
    MAX_PROJECT_TOOL_SNAPSHOT_SOURCE_PAGE_SIZE,
    'snapshot source page size',
  );
}

export function assertProjectToolDefinitionSnapshotRecoveryPageSize(
  value: number,
): void {
  positiveInteger(
    value,
    MAX_PROJECT_TOOL_SNAPSHOT_RECOVERY_PAGE_SIZE,
    'snapshot recovery page size',
  );
}

export function normalizeProjectToolDefinitionSnapshotSourceCursor(
  value: ProjectToolDefinitionSnapshotSourceCursor,
): Readonly<ProjectToolDefinitionSnapshotSourceCursor> {
  const cursor = dataRecord(value, 'snapshot source cursor');
  exactKeys(cursor, ['packageName'], 'snapshot source cursor');
  return Object.freeze({ packageName: packageName(value.packageName) });
}

export function normalizeProjectToolDefinitionSnapshotPendingProjectCursor(
  value: ProjectToolDefinitionSnapshotPendingProjectCursor,
): Readonly<ProjectToolDefinitionSnapshotPendingProjectCursor> {
  const cursor = dataRecord(value, 'snapshot pending Project cursor');
  exactKeys(cursor, ['projectId'], 'snapshot pending Project cursor');
  return Object.freeze({ projectId: projectId(value.projectId) });
}

function normalizeSourcePage(
  value: ProjectToolDefinitionSnapshotSourcePage,
  limit: number,
  after: Readonly<ProjectToolDefinitionSnapshotSourceCursor> | undefined,
): Readonly<ProjectToolDefinitionSnapshotSourcePage> {
  const page = dataRecord(value, 'snapshot source page');
  exactKeysWithOptional(
    page,
    ['sources', 'truncated'],
    ['next'],
    'snapshot source page',
  );
  if (
    !Array.isArray(value.sources) ||
    value.sources.length > limit ||
    typeof value.truncated !== 'boolean'
  ) {
    return invalid('snapshot source page is invalid');
  }
  const sources = Object.freeze(value.sources.map(normalizeSource));
  assertUniquelySorted(sources, compareSources, 'snapshot source page');
  if (
    after &&
    sources.some((source) => source.packageName <= after.packageName)
  ) {
    return invalid('snapshot source page crossed its cursor');
  }
  const next =
    value.next === undefined
      ? undefined
      : normalizeProjectToolDefinitionSnapshotSourceCursor(value.next);
  const last = sources.at(-1);
  if (
    value.truncated !== (next !== undefined) ||
    (next && (!last || next.packageName !== last.packageName))
  ) {
    return invalid('snapshot source continuation is invalid');
  }
  return Object.freeze({
    sources,
    truncated: value.truncated,
    ...(next ? { next } : {}),
  });
}

function normalizePendingProjectPage(
  value: ProjectToolDefinitionSnapshotPendingProjectPage,
  limit: number,
  after:
    | Readonly<ProjectToolDefinitionSnapshotPendingProjectCursor>
    | undefined,
): Readonly<ProjectToolDefinitionSnapshotPendingProjectPage> {
  const page = dataRecord(value, 'snapshot pending Project page');
  exactKeysWithOptional(
    page,
    ['projectIds', 'truncated'],
    ['next'],
    'snapshot pending Project page',
  );
  if (
    !Array.isArray(value.projectIds) ||
    value.projectIds.length > limit ||
    typeof value.truncated !== 'boolean'
  ) {
    return invalid('snapshot pending Project page is invalid');
  }
  const projectIds = Object.freeze(value.projectIds.map(projectId));
  if (
    projectIds.some(
      (candidate, index) =>
        (index > 0 &&
          compareUtf8Text(projectIds[index - 1]!, candidate) >= 0) ||
        (after !== undefined &&
          compareUtf8Text(candidate, after.projectId) <= 0),
    )
  ) {
    return invalid(
      'snapshot pending Projects must be uniquely ordered after the cursor',
    );
  }
  const next =
    value.next === undefined
      ? undefined
      : normalizeProjectToolDefinitionSnapshotPendingProjectCursor(value.next);
  const last = projectIds.at(-1);
  if (
    value.truncated !== (next !== undefined) ||
    (next && (!last || next.projectId !== last))
  ) {
    return invalid('snapshot pending Project continuation is invalid');
  }
  return Object.freeze({
    projectIds,
    truncated: value.truncated,
    ...(next ? { next } : {}),
  });
}

function sameSources(
  left: readonly Readonly<ProjectToolDefinitionSnapshotSource>[],
  right: readonly Readonly<ProjectToolDefinitionSnapshotSource>[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareUtf8Text(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sourceMatchesContribution(
  source: Readonly<ProjectToolDefinitionSnapshotSource>,
  contribution: Readonly<ProjectToolDefinitionSnapshotContribution>,
): boolean {
  const generation = contribution.generation;
  return (
    generation.installationId === source.installationId &&
    generation.packageName === source.packageName &&
    generation.generation === source.generation &&
    generation.generationDigest === source.generationDigest &&
    generation.lockDigest === source.lockDigest &&
    contribution.revisionDigest === source.revisionDigest
  );
}

export class ProjectToolDefinitionSnapshotPublicationCoordinator {
  readonly #source: ProjectToolDefinitionSnapshotSourceRepository;
  readonly #materializedRepository: PluginPackageMaterializedRevisionRepository;
  readonly #repository: ProjectToolDefinitionSnapshotRepository;
  readonly #registry: TaskSpecSemanticRegistry;
  readonly #pageSize: number;

  constructor(options: {
    readonly source: ProjectToolDefinitionSnapshotSourceRepository;
    readonly materializedRepository: PluginPackageMaterializedRevisionRepository;
    readonly repository: ProjectToolDefinitionSnapshotRepository;
    readonly taskSpecSemanticRegistry: TaskSpecSemanticRegistry;
    readonly pageSize?: number;
  }) {
    const value = dataRecord(options, 'snapshot publication options');
    exactKeysWithOptional(
      value,
      [
        'materializedRepository',
        'repository',
        'source',
        'taskSpecSemanticRegistry',
      ],
      ['pageSize'],
      'snapshot publication options',
    );
    if (
      !options.source ||
      typeof options.source.listActiveSourcePage !== 'function' ||
      !options.materializedRepository ||
      typeof options.materializedRepository.find !== 'function' ||
      !options.repository ||
      typeof options.repository.findCurrent !== 'function' ||
      typeof options.repository.publish !== 'function' ||
      !(options.taskSpecSemanticRegistry instanceof TaskSpecSemanticRegistry)
    ) {
      invalid('snapshot publication authority is invalid');
    }
    this.#source = options.source;
    this.#materializedRepository = options.materializedRepository;
    this.#repository = options.repository;
    this.#registry = options.taskSpecSemanticRegistry;
    this.#pageSize = positiveInteger(
      options.pageSize ?? 8,
      MAX_PROJECT_TOOL_SNAPSHOT_SOURCE_PAGE_SIZE,
      'snapshot source page size',
    );
  }

  private async observe(
    project: string,
    includeContributions: boolean,
  ): Promise<
    Readonly<{
      sources: readonly Readonly<ProjectToolDefinitionSnapshotSource>[];
      contributions: readonly Readonly<ProjectToolDefinitionSnapshotContribution>[];
    }>
  > {
    const sources: Readonly<ProjectToolDefinitionSnapshotSource>[] = [];
    const contributions: Readonly<ProjectToolDefinitionSnapshotContribution>[] =
      [];
    let after: Readonly<ProjectToolDefinitionSnapshotSourceCursor> | undefined;
    while (true) {
      let page: Readonly<ProjectToolDefinitionSnapshotSourcePage>;
      try {
        page = normalizeSourcePage(
          await this.#source.listActiveSourcePage({
            projectId: project,
            limit: this.#pageSize,
            ...(after ? { after } : {}),
          }),
          this.#pageSize,
          after,
        );
      } catch (error) {
        throw new ProjectToolDefinitionSnapshotUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      for (const source of page.sources) {
        if (sources.length >= MAX_PROJECT_TOOL_SNAPSHOT_ACTIVE_PACKAGES) {
          throw new ProjectToolDefinitionSnapshotConflictError(
            'active Package vector exceeds its reviewed bound',
          );
        }
        sources.push(source);
        if (includeContributions) {
          let revision: Readonly<PluginPackageMaterializedRevision> | null;
          try {
            revision = await this.#materializedRepository.find(
              source.generationDigest,
            );
          } catch (error) {
            throw new ProjectToolDefinitionSnapshotUnavailableError({
              cause: error instanceof Error ? error : undefined,
            });
          }
          if (revision === null) {
            throw new ProjectToolDefinitionSnapshotUnavailableError();
          }
          let contribution: Readonly<ProjectToolDefinitionSnapshotContribution>;
          try {
            contribution = projectToolDefinitionSnapshotContribution(
              revision,
              this.#registry,
            );
          } catch (error) {
            throw new ProjectToolDefinitionSnapshotUnavailableError({
              cause: error instanceof Error ? error : undefined,
            });
          }
          if (
            contribution.generation.projectId !== project ||
            !sourceMatchesContribution(source, contribution)
          ) {
            throw new ProjectToolDefinitionSnapshotConflictError(
              'materialized revision does not match the observed active source',
            );
          }
          contributions.push(contribution);
        }
      }
      if (!page.truncated) break;
      after = page.next;
    }
    try {
      projectToolDefinitionActiveVectorDigest(project, sources);
    } catch (error) {
      throw new ProjectToolDefinitionSnapshotUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    return Object.freeze({
      sources: Object.freeze(sources),
      contributions: Object.freeze(contributions),
    });
  }

  async publishCurrent(
    projectIdValue: string,
  ): Promise<Readonly<ProjectToolDefinitionSnapshotPublicationResult>> {
    const project = projectId(projectIdValue);
    try {
      const existing = await this.#repository.findCurrent(project);
      if (existing) {
        return Object.freeze({ status: 'existing', record: existing });
      }
      const first = await this.observe(project, true);
      const snapshot = createProjectToolDefinitionSnapshot({
        projectId: project,
        contributions: first.contributions,
      });
      if (!sameSources(snapshot.sources, first.sources)) {
        throw new ProjectToolDefinitionSnapshotConflictError(
          'planned snapshot does not match its observed active vector',
        );
      }
      const second = await this.observe(project, false);
      if (!sameSources(first.sources, second.sources)) {
        throw new ProjectToolDefinitionSnapshotConflictError(
          'active Package vector changed during snapshot planning',
        );
      }
      return await this.#repository.publish(snapshot);
    } catch (error) {
      if (
        error instanceof InvalidProjectToolDefinitionSnapshotError ||
        error instanceof ProjectToolDefinitionSnapshotConflictError ||
        error instanceof ProjectToolDefinitionSnapshotUnavailableError
      ) {
        throw error;
      }
      throw new ProjectToolDefinitionSnapshotUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
}

export class ProjectToolDefinitionSnapshotRecoveryCoordinator {
  readonly #source: ProjectToolDefinitionSnapshotSourceRepository;
  readonly #publisher: ProjectToolDefinitionSnapshotPublicationCoordinator;

  constructor(options: {
    readonly source: ProjectToolDefinitionSnapshotSourceRepository;
    readonly publisher: ProjectToolDefinitionSnapshotPublicationCoordinator;
  }) {
    const value = dataRecord(options, 'snapshot recovery options');
    exactKeys(value, ['publisher', 'source'], 'snapshot recovery options');
    if (
      !options.source ||
      typeof options.source.listPendingProjectPage !== 'function' ||
      !(
        options.publisher instanceof
        ProjectToolDefinitionSnapshotPublicationCoordinator
      )
    ) {
      invalid('snapshot recovery authority is invalid');
    }
    this.#source = options.source;
    this.#publisher = options.publisher;
  }

  async recoverPage(options: {
    readonly limit: number;
    readonly after?: Readonly<ProjectToolDefinitionSnapshotPendingProjectCursor>;
  }): Promise<
    Readonly<{
      items: readonly Readonly<ProjectToolDefinitionSnapshotRecoveryItem>[];
      truncated: boolean;
      next?: Readonly<ProjectToolDefinitionSnapshotPendingProjectCursor>;
    }>
  > {
    const value = dataRecord(options, 'snapshot recovery page options');
    exactKeysWithOptional(
      value,
      ['limit'],
      ['after'],
      'snapshot recovery page options',
    );
    assertProjectToolDefinitionSnapshotRecoveryPageSize(options.limit);
    const after =
      options.after === undefined
        ? undefined
        : normalizeProjectToolDefinitionSnapshotPendingProjectCursor(
            options.after,
          );
    let page: Readonly<ProjectToolDefinitionSnapshotPendingProjectPage>;
    try {
      page = normalizePendingProjectPage(
        await this.#source.listPendingProjectPage({
          limit: options.limit,
          ...(after ? { after } : {}),
        }),
        options.limit,
        after,
      );
    } catch (error) {
      throw new ProjectToolDefinitionSnapshotUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    const items: Readonly<ProjectToolDefinitionSnapshotRecoveryItem>[] = [];
    for (const candidateProjectId of page.projectIds) {
      let status: ProjectToolDefinitionSnapshotRecoveryItemStatus;
      try {
        await this.#publisher.publishCurrent(candidateProjectId);
        status = 'settled';
      } catch (error) {
        status =
          error instanceof InvalidProjectToolDefinitionSnapshotError ||
          error instanceof ProjectToolDefinitionSnapshotConflictError
            ? 'manual_required'
            : 'retry';
      }
      items.push(Object.freeze({ projectId: candidateProjectId, status }));
    }
    return Object.freeze({
      items: Object.freeze(items),
      truncated: page.truncated,
      ...(page.next ? { next: page.next } : {}),
    });
  }

  async recover(
    options: {
      readonly pageSize?: number;
      readonly maxPages?: number;
    } = {},
  ): Promise<Readonly<ProjectToolDefinitionSnapshotRecoveryCycleResult>> {
    const value = dataRecord(options, 'snapshot recovery cycle options');
    exactKeysWithOptional(
      value,
      [],
      ['maxPages', 'pageSize'],
      'snapshot recovery cycle options',
    );
    const pageSize = positiveInteger(
      options.pageSize ?? 8,
      MAX_PROJECT_TOOL_SNAPSHOT_RECOVERY_PAGE_SIZE,
      'snapshot recovery page size',
    );
    const maxPages = positiveInteger(
      options.maxPages ?? 8,
      MAX_PROJECT_TOOL_SNAPSHOT_RECOVERY_PAGES,
      'snapshot recovery page count',
    );
    const counts = {
      pages: 0,
      scanned: 0,
      settled: 0,
      retry: 0,
      manualRequired: 0,
    };
    let after:
      | Readonly<ProjectToolDefinitionSnapshotPendingProjectCursor>
      | undefined;
    let exhausted = false;
    while (counts.pages < maxPages) {
      const page = await this.recoverPage({
        limit: pageSize,
        ...(after ? { after } : {}),
      });
      counts.pages += 1;
      counts.scanned += page.items.length;
      for (const item of page.items) {
        if (item.status === 'settled') counts.settled += 1;
        else if (item.status === 'retry') counts.retry += 1;
        else counts.manualRequired += 1;
      }
      if (!page.truncated) {
        exhausted = true;
        break;
      }
      after = page.next;
    }
    let probe: Readonly<ProjectToolDefinitionSnapshotPendingProjectPage>;
    try {
      probe = normalizePendingProjectPage(
        await this.#source.listPendingProjectPage({ limit: 1 }),
        1,
        undefined,
      );
    } catch (error) {
      throw new ProjectToolDefinitionSnapshotUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    const remaining = !exhausted || probe.projectIds.length > 0;
    return Object.freeze({
      ...counts,
      remaining,
      safeToAdmit:
        !remaining && counts.retry === 0 && counts.manualRequired === 0,
    });
  }
}
