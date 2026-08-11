import { createHash } from 'node:crypto';

import {
  InvalidPluginPackageResourceMaterializationError,
  PluginPackageResourceMaterializationConflictError,
  PluginPackageResourceMaterializationUnavailableError,
  normalizePluginPackageMaterializedRevision,
  normalizePluginPackagePromptResource,
  normalizePluginPackageWorkflowResource,
  type PluginPackageMaterializedRevision,
  type PluginPackageMaterializedRevisionRepository,
  type PluginPackagePromptResource,
  type PluginPackageWorkflowResource,
} from './pluginPackageResourceMaterialization';
import type { PluginPackageResourceGenerationSource } from './pluginPackageResourceGeneration';
import { TaskSpecSemanticRegistry } from '../task-definition/taskSpecSemantic';

export const PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_SCHEMA =
  'qinglong/plugin-package-automation-publication@v1' as const;
export const PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_STATES = [
  'active',
  'withdrawn',
  'absent',
] as const;
export const MAX_PLUGIN_PACKAGE_AUTOMATION_WORKFLOWS = 128;
export const MAX_PLUGIN_PACKAGE_AUTOMATION_PROMPTS = 128;
export const MAX_PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_BYTES =
  12 * 1024 * 1024;

export type PluginPackageAutomationPublicationState =
  (typeof PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_STATES)[number];

export interface PluginPackageAutomationPublicationTarget {
  readonly projectId: string;
  readonly packageName: string;
  readonly installationId: string;
  readonly lockDigest: string;
  readonly generation: number;
  readonly generationDigest: string;
  readonly materializedRevisionDigest: string;
}

export interface PluginPackageAutomationDefinitions {
  readonly workflows: readonly Readonly<PluginPackageWorkflowResource>[];
  readonly prompts: readonly Readonly<PluginPackagePromptResource>[];
}

export interface PluginPackageAutomationPublication {
  readonly schema: typeof PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_SCHEMA;
  readonly target: Readonly<PluginPackageAutomationPublicationTarget>;
  readonly state: PluginPackageAutomationPublicationState;
  readonly version: number;
  readonly previousPublicationDigest: string | null;
  readonly lifecycleEventDigest: string | null;
  readonly definitions: Readonly<PluginPackageAutomationDefinitions>;
  readonly publishedAtMs: number;
  readonly publicationDigest: string;
}

export interface PluginPackageAutomationPublicationRepository {
  findCurrent(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageAutomationPublication> | null>;
  findByDigest(
    publicationDigest: string,
  ): Promise<Readonly<PluginPackageAutomationPublication> | null>;
  publish(
    publication: Readonly<PluginPackageAutomationPublication>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      publication: Readonly<PluginPackageAutomationPublication>;
    }>
  >;
}

export interface PluginPackageAutomationPublicationStartGuard {
  isStartAllowed(
    projectId: string,
    packageName: string,
    publicationDigest: string,
  ): Promise<boolean>;
}

export class InvalidPluginPackageAutomationPublicationError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_INVALID';

  constructor(message: string) {
    super(`Plugin Package automation publication is invalid: ${message}`);
    this.name = 'InvalidPluginPackageAutomationPublicationError';
  }
}

export class PluginPackageAutomationPublicationConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_CONFLICT';

  constructor(message: string) {
    super(
      `Plugin Package automation publication conflicts with state: ${message}`,
    );
    this.name = 'PluginPackageAutomationPublicationConflictError';
  }
}

export class PluginPackageAutomationPublicationUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package automation publication is unavailable', options);
    this.name = 'PluginPackageAutomationPublicationUnavailableError';
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PUBLICATION_DIGEST_DOMAIN =
  'qinglong/plugin-package-automation-publication-digest@v1\0';

function invalid(message: string): never {
  throw new InvalidPluginPackageAutomationPublicationError(message);
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
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key) => typeof key !== 'string') ||
    actual
      .map(String)
      .sort()
      .some((key, index) => key !== canonical[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
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

function positiveInteger(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 2_147_483_647
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function nullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : digest(value, label);
}

function normalizeTarget(
  value: PluginPackageAutomationPublicationTarget,
): Readonly<PluginPackageAutomationPublicationTarget> {
  const target = dataRecord(value, 'publication target');
  exactKeys(
    target,
    [
      'generation',
      'generationDigest',
      'installationId',
      'lockDigest',
      'materializedRevisionDigest',
      'packageName',
      'projectId',
    ],
    'publication target',
  );
  return Object.freeze({
    projectId: identifier(value.projectId, 'projectId'),
    packageName: packageName(value.packageName),
    installationId: identifier(value.installationId, 'installationId'),
    lockDigest: digest(value.lockDigest, 'lockDigest'),
    generation: positiveInteger(value.generation, 'generation'),
    generationDigest: digest(value.generationDigest, 'generationDigest'),
    materializedRevisionDigest: digest(
      value.materializedRevisionDigest,
      'materializedRevisionDigest',
    ),
  });
}

function normalizeDenseArray(
  value: unknown,
  maximum: number,
  label: string,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    Object.keys(value).some((key, index) => key !== String(index))
  ) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function normalizeDefinitions(
  value: PluginPackageAutomationDefinitions,
): Readonly<PluginPackageAutomationDefinitions> {
  const definitions = dataRecord(value, 'automation definitions');
  exactKeys(definitions, ['prompts', 'workflows'], 'automation definitions');
  const workflows = normalizeDenseArray(
    value.workflows,
    MAX_PLUGIN_PACKAGE_AUTOMATION_WORKFLOWS,
    'workflows',
  )
    .map(normalizePluginPackageWorkflowResource)
    .sort((left, right) => left.id.localeCompare(right.id));
  const prompts = normalizeDenseArray(
    value.prompts,
    MAX_PLUGIN_PACKAGE_AUTOMATION_PROMPTS,
    'prompts',
  )
    .map(normalizePluginPackagePromptResource)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (
    workflows.some(
      (workflow, index) =>
        index > 0 && workflows[index - 1]!.id === workflow.id,
    ) ||
    prompts.some(
      (prompt, index) => index > 0 && prompts[index - 1]!.id === prompt.id,
    )
  ) {
    return invalid('automation definition identity is duplicated');
  }
  return Object.freeze({
    workflows: Object.freeze(workflows),
    prompts: Object.freeze(prompts),
  });
}

function fields(
  value: Omit<PluginPackageAutomationPublication, 'publicationDigest'>,
): object {
  return {
    schema: value.schema,
    target: value.target,
    state: value.state,
    version: value.version,
    previousPublicationDigest: value.previousPublicationDigest,
    lifecycleEventDigest: value.lifecycleEventDigest,
    definitions: value.definitions,
    publishedAtMs: value.publishedAtMs,
  };
}

export function pluginPackageAutomationPublicationDigest(
  value: Omit<PluginPackageAutomationPublication, 'publicationDigest'>,
): string {
  return createHash('sha256')
    .update(PUBLICATION_DIGEST_DOMAIN)
    .update(JSON.stringify(fields(value)))
    .digest('hex');
}

function bounded(
  value: Readonly<PluginPackageAutomationPublication>,
): Readonly<PluginPackageAutomationPublication> {
  if (
    Buffer.byteLength(JSON.stringify(value), 'utf8') >
    MAX_PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_BYTES
  ) {
    return invalid('encoded publication exceeds the size limit');
  }
  return value;
}

function normalizedWithoutDigest(
  value: Omit<PluginPackageAutomationPublication, 'publicationDigest'>,
): Omit<PluginPackageAutomationPublication, 'publicationDigest'> {
  if (
    typeof value.state !== 'string' ||
    !PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_STATES.includes(
      value.state as PluginPackageAutomationPublicationState,
    )
  ) {
    return invalid('publication state is invalid');
  }
  const version = positiveInteger(value.version, 'version');
  const previousPublicationDigest = nullableDigest(
    value.previousPublicationDigest,
    'previousPublicationDigest',
  );
  const lifecycleEventDigest = nullableDigest(
    value.lifecycleEventDigest,
    'lifecycleEventDigest',
  );
  const definitions = normalizeDefinitions(value.definitions);
  const definitionCount =
    definitions.workflows.length + definitions.prompts.length;
  if (
    (version === 1 &&
      ((value.state !== 'active' && value.state !== 'absent') ||
        previousPublicationDigest !== null ||
        lifecycleEventDigest !== null)) ||
    (version > 1 && previousPublicationDigest === null) ||
    (value.state === 'absent'
      ? definitionCount !== 0
      : definitionCount === 0) ||
    (value.state === 'withdrawn' && lifecycleEventDigest === null)
  ) {
    return invalid('publication version chain is invalid');
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_SCHEMA,
    target: normalizeTarget(value.target),
    state: value.state as PluginPackageAutomationPublicationState,
    version,
    previousPublicationDigest,
    lifecycleEventDigest,
    definitions,
    publishedAtMs: timestamp(value.publishedAtMs, 'publishedAtMs'),
  });
}

export function normalizePluginPackageAutomationPublication(
  value: PluginPackageAutomationPublication,
): Readonly<PluginPackageAutomationPublication> {
  const publication = dataRecord(value, 'automation publication');
  exactKeys(
    publication,
    [
      'definitions',
      'lifecycleEventDigest',
      'previousPublicationDigest',
      'publicationDigest',
      'publishedAtMs',
      'schema',
      'state',
      'target',
      'version',
    ],
    'automation publication',
  );
  if (value.schema !== PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_SCHEMA) {
    return invalid('publication schema is invalid');
  }
  const unsigned = normalizedWithoutDigest(value);
  const publicationDigest = pluginPackageAutomationPublicationDigest(unsigned);
  if (
    typeof value.publicationDigest !== 'string' ||
    value.publicationDigest !== publicationDigest
  ) {
    return invalid('publicationDigest does not match publication');
  }
  return bounded(Object.freeze({ ...unsigned, publicationDigest }));
}

export function pluginPackageAutomationDefinitionsFromRevision(
  revisionValue: PluginPackageMaterializedRevision,
  registry: TaskSpecSemanticRegistry,
): Readonly<PluginPackageAutomationDefinitions> | null {
  if (!(registry instanceof TaskSpecSemanticRegistry)) {
    return invalid('TaskSpec semantic registry is invalid');
  }
  const revision = normalizePluginPackageMaterializedRevision(
    revisionValue,
    registry,
  );
  const workflows = revision.resources
    .filter(({ kind }) => kind === 'workflow')
    .map(({ value }) =>
      normalizePluginPackageWorkflowResource(value),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const prompts = revision.resources
    .filter(({ kind }) => kind === 'prompt')
    .map(({ value }) => normalizePluginPackagePromptResource(value))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (workflows.length === 0 && prompts.length === 0) return null;
  return Object.freeze({
    workflows: Object.freeze(workflows),
    prompts: Object.freeze(prompts),
  });
}

export function createInitialPluginPackageAutomationPublication(
  revisionValue: PluginPackageMaterializedRevision,
  registry: TaskSpecSemanticRegistry,
  publishedAtMsValue: number,
): Readonly<PluginPackageAutomationPublication> {
  const revision = normalizePluginPackageMaterializedRevision(
    revisionValue,
    registry,
  );
  const definitions =
    pluginPackageAutomationDefinitionsFromRevision(revision, registry) ??
    Object.freeze({
      workflows: Object.freeze([]),
      prompts: Object.freeze([]),
    });
  const state = definitions.workflows.length > 0 ||
    definitions.prompts.length > 0
    ? ('active' as const)
    : ('absent' as const);
  const unsigned = normalizedWithoutDigest({
    schema: PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_SCHEMA,
    target: {
      projectId: revision.generation.projectId,
      packageName: revision.generation.packageName,
      installationId: revision.generation.installationId,
      lockDigest: revision.generation.lockDigest,
      generation: revision.generation.generation,
      generationDigest: revision.generation.generationDigest,
      materializedRevisionDigest: revision.revisionDigest,
    },
    state,
    version: 1,
    previousPublicationDigest: null,
    lifecycleEventDigest: null,
    definitions,
    publishedAtMs: publishedAtMsValue,
  });
  return bounded(
    Object.freeze({
      ...unsigned,
      publicationDigest: pluginPackageAutomationPublicationDigest(unsigned),
    }),
  );
}

export function assertPluginPackageAutomationPublicationSuccessor(
  previousValue: Readonly<PluginPackageAutomationPublication>,
  nextValue: Readonly<PluginPackageAutomationPublication>,
): void {
  const previous = normalizePluginPackageAutomationPublication(previousValue);
  const next = normalizePluginPackageAutomationPublication(nextValue);
  if (
    next.previousPublicationDigest !== previous.publicationDigest ||
    next.version !== previous.version + 1 ||
    next.publishedAtMs < previous.publishedAtMs
  ) {
    invalid('publication successor fence is invalid');
  }
  const samePackage =
    next.target.projectId === previous.target.projectId &&
    next.target.packageName === previous.target.packageName;
  if (!samePackage) {
    invalid('publication successor changes Package ownership');
  }
  if (next.lifecycleEventDigest === null) {
    if (
      (next.state !== 'active' && next.state !== 'absent') ||
      next.target.generation <= previous.target.generation ||
      next.target.installationId === previous.target.installationId ||
      next.target.lockDigest === previous.target.lockDigest ||
      next.target.generationDigest === previous.target.generationDigest ||
      next.target.materializedRevisionDigest ===
        previous.target.materializedRevisionDigest
    ) {
      invalid('generation successor is invalid');
    }
    return;
  }
  if (
    JSON.stringify(next.target) !== JSON.stringify(previous.target) ||
    JSON.stringify(next.definitions) !== JSON.stringify(previous.definitions) ||
    !(
      (previous.state === 'active' && next.state === 'withdrawn') ||
      (previous.state === 'withdrawn' && next.state === 'active')
    )
  ) {
    invalid('lifecycle successor is invalid');
  }
}

export function createNextPluginPackageAutomationPublication(
  revisionValue: PluginPackageMaterializedRevision,
  registry: TaskSpecSemanticRegistry,
  previousValue: Readonly<PluginPackageAutomationPublication>,
  publishedAtMsValue: number,
): Readonly<PluginPackageAutomationPublication> {
  const revision = normalizePluginPackageMaterializedRevision(
    revisionValue,
    registry,
  );
  const previous = normalizePluginPackageAutomationPublication(previousValue);
  const definitions =
    pluginPackageAutomationDefinitionsFromRevision(revision, registry) ??
    Object.freeze({
      workflows: Object.freeze([]),
      prompts: Object.freeze([]),
    });
  const state = definitions.workflows.length > 0 ||
    definitions.prompts.length > 0
    ? ('active' as const)
    : ('absent' as const);
  const unsigned = normalizedWithoutDigest({
    schema: PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_SCHEMA,
    target: {
      projectId: revision.generation.projectId,
      packageName: revision.generation.packageName,
      installationId: revision.generation.installationId,
      lockDigest: revision.generation.lockDigest,
      generation: revision.generation.generation,
      generationDigest: revision.generation.generationDigest,
      materializedRevisionDigest: revision.revisionDigest,
    },
    state,
    version: previous.version + 1,
    previousPublicationDigest: previous.publicationDigest,
    lifecycleEventDigest: null,
    definitions,
    publishedAtMs: publishedAtMsValue,
  });
  const next = bounded(
    Object.freeze({
      ...unsigned,
      publicationDigest: pluginPackageAutomationPublicationDigest(unsigned),
    }),
  );
  assertPluginPackageAutomationPublicationSuccessor(previous, next);
  return next;
}

export function createPluginPackageAutomationLifecyclePublication(input: {
  readonly previous: Readonly<PluginPackageAutomationPublication>;
  readonly state: PluginPackageAutomationPublicationState;
  readonly lifecycleEventDigest: string;
  readonly publishedAtMs: number;
}): Readonly<PluginPackageAutomationPublication> {
  const value = dataRecord(input, 'automation lifecycle publication input');
  exactKeys(
    value,
    ['lifecycleEventDigest', 'previous', 'publishedAtMs', 'state'],
    'automation lifecycle publication input',
  );
  const previous = normalizePluginPackageAutomationPublication(
    input.previous,
  );
  if (
    previous.state === 'absent' ||
    (previous.state === 'active' && input.state !== 'withdrawn') ||
    (previous.state === 'withdrawn' && input.state !== 'active')
  ) {
    return invalid('lifecycle publication must toggle its state');
  }
  const publishedAtMs = timestamp(input.publishedAtMs, 'publishedAtMs');
  if (publishedAtMs < previous.publishedAtMs) {
    return invalid('publishedAtMs precedes the previous publication');
  }
  const unsigned = normalizedWithoutDigest({
    schema: PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_SCHEMA,
    target: previous.target,
    state: input.state,
    version: previous.version + 1,
    previousPublicationDigest: previous.publicationDigest,
    lifecycleEventDigest: digest(
      input.lifecycleEventDigest,
      'lifecycleEventDigest',
    ),
    definitions: previous.definitions,
    publishedAtMs,
  });
  const next = bounded(
    Object.freeze({
      ...unsigned,
      publicationDigest: pluginPackageAutomationPublicationDigest(unsigned),
    }),
  );
  assertPluginPackageAutomationPublicationSuccessor(previous, next);
  return next;
}

export const MAX_PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_RECOVERY_PAGE_SIZE = 64;
export const MAX_PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_RECOVERY_PAGES = 64;

export interface PluginPackageAutomationPublicationPendingCandidate {
  readonly projectId: string;
  readonly packageName: string;
}

export interface PluginPackageAutomationPublicationRecoveryCursor {
  readonly projectId: string;
  readonly packageName: string;
}

export interface PluginPackageAutomationPublicationRecoveryPage {
  readonly candidates: readonly Readonly<PluginPackageAutomationPublicationPendingCandidate>[];
  readonly truncated: boolean;
  readonly next?: Readonly<PluginPackageAutomationPublicationRecoveryCursor>;
}

export interface PluginPackageAutomationPublicationRecoverySource {
  listPendingPage(options: {
    readonly limit: number;
    readonly after?: Readonly<PluginPackageAutomationPublicationRecoveryCursor>;
  }): Promise<Readonly<PluginPackageAutomationPublicationRecoveryPage>>;
}

export type PluginPackageAutomationPublicationCurrentResult = Readonly<{
  status: 'current';
  publication: 'created' | 'existing';
  generationDigest: string;
  record: Readonly<PluginPackageAutomationPublication>;
}>;

export type PluginPackageAutomationPublicationResult =
  | PluginPackageAutomationPublicationCurrentResult
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'superseded'; generationDigest: string }>;

export type PluginPackageAutomationPublicationRecoveryItemStatus =
  | 'manual_required'
  | 'retry'
  | 'settled'
  | 'superseded';

export interface PluginPackageAutomationPublicationRecoveryItem {
  readonly projectId: string;
  readonly packageName: string;
  readonly status: PluginPackageAutomationPublicationRecoveryItemStatus;
}

export interface PluginPackageAutomationPublicationRecoveryCycleResult {
  readonly pages: number;
  readonly scanned: number;
  readonly settled: number;
  readonly retry: number;
  readonly manualRequired: number;
  readonly superseded: number;
  readonly remaining: boolean;
  readonly safeToAdmit: boolean;
}

function boundedPositiveInteger(
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

export function assertPluginPackageAutomationPublicationRecoveryPageSize(
  value: number,
): void {
  boundedPositiveInteger(
    value,
    MAX_PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_RECOVERY_PAGE_SIZE,
    'automation recovery page size',
  );
}

function normalizeRecoveryCandidate(
  value: PluginPackageAutomationPublicationPendingCandidate,
): Readonly<PluginPackageAutomationPublicationPendingCandidate> {
  const candidate = dataRecord(value, 'automation recovery candidate');
  exactKeys(
    candidate,
    ['packageName', 'projectId'],
    'automation recovery candidate',
  );
  return Object.freeze({
    projectId: identifier(value.projectId, 'projectId'),
    packageName: packageName(value.packageName),
  });
}

export function normalizePluginPackageAutomationPublicationRecoveryCursor(
  value: PluginPackageAutomationPublicationRecoveryCursor,
): Readonly<PluginPackageAutomationPublicationRecoveryCursor> {
  const cursor = dataRecord(value, 'automation recovery cursor');
  exactKeys(
    cursor,
    ['packageName', 'projectId'],
    'automation recovery cursor',
  );
  return Object.freeze({
    projectId: identifier(value.projectId, 'projectId'),
    packageName: packageName(value.packageName),
  });
}

function compareRecoveryCandidates(
  left: Readonly<PluginPackageAutomationPublicationPendingCandidate>,
  right: Readonly<PluginPackageAutomationPublicationPendingCandidate>,
): number {
  return (
    left.projectId.localeCompare(right.projectId) ||
    left.packageName.localeCompare(right.packageName)
  );
}

function normalizeRecoveryPage(
  value: PluginPackageAutomationPublicationRecoveryPage,
  limit: number,
): Readonly<PluginPackageAutomationPublicationRecoveryPage> {
  const page = dataRecord(value, 'automation recovery page');
  const keys = Reflect.ownKeys(page);
  if (
    keys.some((key) => typeof key !== 'string') ||
    keys.some((key) => key !== 'candidates' && key !== 'next' && key !== 'truncated') ||
    !keys.includes('candidates') ||
    !keys.includes('truncated') ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > limit ||
    typeof value.truncated !== 'boolean'
  ) {
    return invalid('automation recovery page is invalid');
  }
  const candidates = Object.freeze(
    value.candidates.map(normalizeRecoveryCandidate),
  );
  if (
    candidates.some(
      (candidate, index) =>
        index > 0 &&
        compareRecoveryCandidates(candidates[index - 1]!, candidate) >= 0,
    )
  ) {
    return invalid('automation recovery candidates must be uniquely sorted');
  }
  const next =
    value.next === undefined
      ? undefined
      : normalizePluginPackageAutomationPublicationRecoveryCursor(value.next);
  const last = candidates.at(-1);
  if (
    value.truncated !== (next !== undefined) ||
    (next &&
      (!last ||
        next.projectId !== last.projectId ||
        next.packageName !== last.packageName))
  ) {
    return invalid('automation recovery continuation is invalid');
  }
  return Object.freeze({
    candidates,
    truncated: value.truncated,
    ...(next ? { next } : {}),
  });
}

export class PluginPackageAutomationPublicationCoordinator {
  readonly #generationSource: PluginPackageResourceGenerationSource;
  readonly #materializedRepository: PluginPackageMaterializedRevisionRepository;
  readonly #repository: PluginPackageAutomationPublicationRepository;
  readonly #registry: TaskSpecSemanticRegistry;
  readonly #now: () => number | Promise<number>;

  constructor(options: {
    readonly generationSource: PluginPackageResourceGenerationSource;
    readonly materializedRepository: PluginPackageMaterializedRevisionRepository;
    readonly repository: PluginPackageAutomationPublicationRepository;
    readonly taskSpecSemanticRegistry: TaskSpecSemanticRegistry;
    readonly now: () => number | Promise<number>;
  }) {
    const value = dataRecord(options, 'automation publication coordinator options');
    exactKeys(
      value,
      [
        'generationSource',
        'materializedRepository',
        'now',
        'repository',
        'taskSpecSemanticRegistry',
      ],
      'automation publication coordinator options',
    );
    if (
      !options.generationSource ||
      typeof options.generationSource.findActiveResourceGeneration !== 'function' ||
      !options.materializedRepository ||
      typeof options.materializedRepository.find !== 'function' ||
      !options.repository ||
      typeof options.repository.findCurrent !== 'function' ||
      typeof options.repository.publish !== 'function' ||
      !(options.taskSpecSemanticRegistry instanceof TaskSpecSemanticRegistry) ||
      typeof options.now !== 'function'
    ) {
      invalid('automation publication coordinator authority is invalid');
    }
    this.#generationSource = options.generationSource;
    this.#materializedRepository = options.materializedRepository;
    this.#repository = options.repository;
    this.#registry = options.taskSpecSemanticRegistry;
    this.#now = options.now;
  }

  async publishActive(
    projectIdValue: string,
    packageNameValue: string,
  ): Promise<Readonly<PluginPackageAutomationPublicationResult>> {
    const identity = {
      projectId: identifier(projectIdValue, 'projectId'),
      packageName: packageName(packageNameValue),
    };
    try {
      const first = await this.#generationSource.findActiveResourceGeneration(
        identity.projectId,
        identity.packageName,
      );
      if (first === null) return Object.freeze({ status: 'absent' as const });
      if (
        first.projectId !== identity.projectId ||
        first.packageName !== identity.packageName
      ) {
        throw new PluginPackageAutomationPublicationConflictError(
          'generation source returned another Package identity',
        );
      }
      const stored = await this.#materializedRepository.find(
        first.generationDigest,
      );
      if (stored === null) {
        throw new PluginPackageAutomationPublicationUnavailableError();
      }
      const revision = normalizePluginPackageMaterializedRevision(
        stored,
        this.#registry,
      );
      if (
        revision.generation.projectId !== identity.projectId ||
        revision.generation.packageName !== identity.packageName ||
        revision.generation.generationDigest !== first.generationDigest
      ) {
        throw new PluginPackageAutomationPublicationConflictError(
          'materialized revision does not match the active generation',
        );
      }
      const current = await this.#repository.findCurrent(
        identity.projectId,
        identity.packageName,
      );
      let publicationStatus: 'created' | 'existing' = 'existing';
      let publication: Readonly<PluginPackageAutomationPublication>;
      if (current?.target.generationDigest === first.generationDigest) {
        if (
          current.target.materializedRevisionDigest !== revision.revisionDigest ||
          current.target.installationId !== revision.generation.installationId ||
          current.target.lockDigest !== revision.generation.lockDigest
        ) {
          throw new PluginPackageAutomationPublicationConflictError(
            'current publication does not match the materialized revision',
          );
        }
        publication = current;
      } else {
        if (
          current &&
          current.target.generation >= revision.generation.generation
        ) {
          throw new PluginPackageAutomationPublicationConflictError(
            'automation publication head is not behind the active generation',
          );
        }
        const publishedAtMs = Math.max(
          timestamp(await this.#now(), 'publishedAtMs'),
          current?.publishedAtMs ?? 0,
        );
        const next = current
          ? createNextPluginPackageAutomationPublication(
              revision,
              this.#registry,
              current,
              publishedAtMs,
            )
          : createInitialPluginPackageAutomationPublication(
              revision,
              this.#registry,
              publishedAtMs,
            );
        const result = await this.#repository.publish(next);
        publicationStatus = result.status;
        publication = result.publication;
      }
      const finalGeneration =
        await this.#generationSource.findActiveResourceGeneration(
          identity.projectId,
          identity.packageName,
        );
      if (
        finalGeneration === null ||
        finalGeneration.generationDigest !== first.generationDigest
      ) {
        return Object.freeze({
          status: 'superseded' as const,
          generationDigest: first.generationDigest,
        });
      }
      return Object.freeze({
        status: 'current' as const,
        publication: publicationStatus,
        generationDigest: first.generationDigest,
        record: publication,
      });
    } catch (error) {
      if (
        error instanceof InvalidPluginPackageAutomationPublicationError ||
        error instanceof PluginPackageAutomationPublicationConflictError ||
        error instanceof PluginPackageAutomationPublicationUnavailableError
      ) {
        throw error;
      }
      if (error instanceof InvalidPluginPackageResourceMaterializationError) {
        throw new InvalidPluginPackageAutomationPublicationError(error.message);
      }
      if (error instanceof PluginPackageResourceMaterializationConflictError) {
        throw new PluginPackageAutomationPublicationConflictError(
          'active generation materialization fence changed',
        );
      }
      if (error instanceof PluginPackageResourceMaterializationUnavailableError) {
        throw new PluginPackageAutomationPublicationUnavailableError({
          cause: error,
        });
      }
      throw new PluginPackageAutomationPublicationUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
}

export class PluginPackageAutomationPublicationRecoveryCoordinator {
  readonly #source: PluginPackageAutomationPublicationRecoverySource;
  readonly #publisher: PluginPackageAutomationPublicationCoordinator;

  constructor(options: {
    readonly source: PluginPackageAutomationPublicationRecoverySource;
    readonly publisher: PluginPackageAutomationPublicationCoordinator;
  }) {
    const value = dataRecord(options, 'automation recovery coordinator options');
    exactKeys(
      value,
      ['publisher', 'source'],
      'automation recovery coordinator options',
    );
    if (
      !options.source ||
      typeof options.source.listPendingPage !== 'function' ||
      !(options.publisher instanceof PluginPackageAutomationPublicationCoordinator)
    ) {
      invalid('automation recovery coordinator authority is invalid');
    }
    this.#source = options.source;
    this.#publisher = options.publisher;
  }

  async recoverPage(options: {
    readonly limit: number;
    readonly after?: Readonly<PluginPackageAutomationPublicationRecoveryCursor>;
  }): Promise<
    Readonly<{
      items: readonly Readonly<PluginPackageAutomationPublicationRecoveryItem>[];
      truncated: boolean;
      next?: Readonly<PluginPackageAutomationPublicationRecoveryCursor>;
    }>
  > {
    const value = dataRecord(options, 'automation recovery page options');
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== 'string') ||
      keys.some((key) => key !== 'after' && key !== 'limit') ||
      !keys.includes('limit')
    ) {
      invalid('automation recovery page options shape is invalid');
    }
    const limit = boundedPositiveInteger(
      options.limit,
      MAX_PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_RECOVERY_PAGE_SIZE,
      'automation recovery page size',
    );
    const after =
      options.after === undefined
        ? undefined
        : normalizePluginPackageAutomationPublicationRecoveryCursor(
            options.after,
          );
    let page: Readonly<PluginPackageAutomationPublicationRecoveryPage>;
    try {
      page = normalizeRecoveryPage(
        await this.#source.listPendingPage({
          limit,
          ...(after ? { after } : {}),
        }),
        limit,
      );
    } catch (error) {
      if (error instanceof InvalidPluginPackageAutomationPublicationError) {
        throw error;
      }
      throw new PluginPackageAutomationPublicationUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    const items: Readonly<PluginPackageAutomationPublicationRecoveryItem>[] = [];
    for (const candidate of page.candidates) {
      let status: PluginPackageAutomationPublicationRecoveryItemStatus;
      try {
        const published = await this.#publisher.publishActive(
          candidate.projectId,
          candidate.packageName,
        );
        status =
          published.status === 'superseded'
            ? 'superseded'
            : 'settled';
      } catch (error) {
        status =
          error instanceof InvalidPluginPackageAutomationPublicationError ||
          error instanceof PluginPackageAutomationPublicationConflictError
            ? 'manual_required'
            : 'retry';
      }
      items.push(Object.freeze({ ...candidate, status }));
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
  ): Promise<Readonly<PluginPackageAutomationPublicationRecoveryCycleResult>> {
    const value = dataRecord(options, 'automation recovery cycle options');
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== 'string') ||
      keys.some((key) => key !== 'maxPages' && key !== 'pageSize')
    ) {
      invalid('automation recovery cycle options shape is invalid');
    }
    const pageSize = boundedPositiveInteger(
      options.pageSize ?? 8,
      MAX_PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_RECOVERY_PAGE_SIZE,
      'automation recovery page size',
    );
    const maxPages = boundedPositiveInteger(
      options.maxPages ?? 8,
      MAX_PLUGIN_PACKAGE_AUTOMATION_PUBLICATION_RECOVERY_PAGES,
      'automation recovery page count',
    );
    const counts = {
      pages: 0,
      scanned: 0,
      settled: 0,
      retry: 0,
      manualRequired: 0,
      superseded: 0,
    };
    let after:
      | Readonly<PluginPackageAutomationPublicationRecoveryCursor>
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
        else if (item.status === 'manual_required') counts.manualRequired += 1;
        else counts.superseded += 1;
      }
      if (!page.truncated) {
        exhausted = true;
        break;
      }
      after = page.next;
    }
    let probe: Readonly<PluginPackageAutomationPublicationRecoveryPage>;
    try {
      probe = normalizeRecoveryPage(
        await this.#source.listPendingPage({ limit: 1 }),
        1,
      );
    } catch (error) {
      throw new PluginPackageAutomationPublicationUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    const remaining = !exhausted || probe.candidates.length > 0;
    return Object.freeze({
      ...counts,
      remaining,
      safeToAdmit:
        !remaining && counts.retry === 0 && counts.manualRequired === 0,
    });
  }
}
