import { createHash } from 'node:crypto';

import {
  MAX_PLUGIN_PACKAGE_MANIFEST_BYTES,
  normalizePluginPackageManifest,
  type PluginPackageManifest,
} from './pluginPackage';
import {
  pluginPackageContentTreeDigest,
  type PluginPackageContentEntryDescriptor,
} from './pluginPackageBundle';
import {
  PluginPackageInstallUnavailableError,
  assertPluginPackageInstallMatchesLock,
  normalizePluginPackageInstallRecord,
  normalizePluginPackageLock,
  pluginPackageManifestDigest,
  serializePluginPackageManifest,
  type PluginPackageInstallRecord,
  type PluginPackageLock,
} from './installation/pluginPackageInstall';
import type {
  PluginPackageActivationPrerequisite,
  PluginPackageActivationPrerequisiteObservation,
} from './installation/pluginPackageInstallation';
import {
  createPluginPackageResourceGenerationFromReferences,
  normalizePluginPackageResourceGeneration,
  pluginPackageResourceReferencesFromContents,
  type PluginPackageResourceGeneration,
  type PluginPackageResourceGenerationSource,
  type PluginPackageResourceKind,
  type PluginPackageResourceReference,
} from './pluginPackageResourceGeneration';
import {
  assertPluginPackageSecretBindingMatches,
  type PluginPackageSecretBinding,
  type PluginPackageSecretBindingRepository,
} from './secret-binding/binding';
import {
  normalizeTaskDefinitionLabels,
  normalizeTaskDefinitionSpec,
  type TaskDefinitionJson,
  type TaskDefinitionKind,
  type TaskDefinitionSpec,
} from '../task-definition/taskDefinition';
import {
  BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
  TaskSpecSemanticRegistry,
} from '../task-definition/taskSpecSemantic';
import {
  MAX_TOOL_DEFINITIONS,
  normalizeToolDefinition,
  type ToolDefinition,
} from '../tool-execution/tool-registry/toolRegistry';

export const PLUGIN_PACKAGE_TASK_RESOURCE_SCHEMA =
  'qinglong/plugin-package-task-resource@v1' as const;
export const PLUGIN_PACKAGE_WORKFLOW_RESOURCE_SCHEMA =
  'qinglong/plugin-package-workflow-resource@v1' as const;
export const PLUGIN_PACKAGE_PROMPT_RESOURCE_SCHEMA =
  'qinglong/plugin-package-prompt-resource@v1' as const;
export const PLUGIN_PACKAGE_TOOL_RESOURCE_SCHEMA =
  'qinglong/plugin-package-tool-resource@v1' as const;
export const PLUGIN_PACKAGE_MATERIALIZED_REVISION_SCHEMA =
  'qinglong/plugin-package-materialized-revision@v1' as const;

export const MAX_PLUGIN_PACKAGE_MATERIALIZED_RESOURCE_BYTES = 1024 * 1024;
export const MAX_PLUGIN_PACKAGE_MATERIALIZED_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_PLUGIN_PACKAGE_MATERIALIZED_REVISION_JSON_BYTES =
  24 * 1024 * 1024;
export const MAX_PLUGIN_PACKAGE_WORKFLOW_STEPS = 128;
export const MAX_PLUGIN_PACKAGE_PROMPT_PARAMETERS = 64;
export const MAX_PLUGIN_PACKAGE_PROMPT_TEMPLATE_BYTES = 512 * 1024;

export interface PluginPackageTaskResource {
  readonly schema: typeof PLUGIN_PACKAGE_TASK_RESOURCE_SCHEMA;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  readonly kind: TaskDefinitionKind;
  readonly spec: TaskDefinitionSpec;
}

export interface PluginPackageWorkflowStep {
  readonly id: string;
  readonly task: string;
  readonly needs: readonly string[];
}

export interface PluginPackageWorkflowResource {
  readonly schema: typeof PLUGIN_PACKAGE_WORKFLOW_RESOURCE_SCHEMA;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly steps: readonly Readonly<PluginPackageWorkflowStep>[];
}

export interface PluginPackagePromptParameter {
  readonly name: string;
  readonly description?: string;
  readonly required: boolean;
}

export interface PluginPackagePromptResource {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_RESOURCE_SCHEMA;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly template: string;
  readonly parameters: readonly Readonly<PluginPackagePromptParameter>[];
}

export interface PluginPackageToolResource {
  readonly schema: typeof PLUGIN_PACKAGE_TOOL_RESOURCE_SCHEMA;
  readonly definition: Readonly<ToolDefinition>;
}

export type PluginPackageMaterializedResourceValue =
  | Readonly<PluginPackageTaskResource>
  | Readonly<PluginPackageWorkflowResource>
  | Readonly<PluginPackagePromptResource>
  | Readonly<PluginPackageToolResource>;

export interface PluginPackageMaterializedResource {
  readonly kind: PluginPackageResourceKind;
  readonly path: string;
  readonly sourceBytes: number;
  readonly sourceDigest: string;
  readonly value: PluginPackageMaterializedResourceValue;
}

export interface PluginPackageMaterializedRevision {
  readonly schema: typeof PLUGIN_PACKAGE_MATERIALIZED_REVISION_SCHEMA;
  readonly generation: Readonly<PluginPackageResourceGeneration>;
  readonly lock: Readonly<PluginPackageLock>;
  readonly manifest: Readonly<PluginPackageManifest>;
  readonly manifestDigest: string;
  readonly secretBinding?: Readonly<PluginPackageSecretBinding>;
  readonly resources: readonly Readonly<PluginPackageMaterializedResource>[];
  readonly revisionDigest: string;
}

export interface PluginPackageResourceMaterializationEntry {
  readonly reference: Readonly<PluginPackageResourceReference>;
  readonly bytes: Uint8Array;
}

export interface MaterializePluginPackageResourcesInput {
  readonly generation: Readonly<PluginPackageResourceGeneration>;
  readonly lock: Readonly<PluginPackageLock>;
  readonly manifestBytes: Uint8Array;
  readonly secretBinding?: Readonly<PluginPackageSecretBinding>;
  readonly resources: readonly Readonly<PluginPackageResourceMaterializationEntry>[];
  readonly taskSpecSemanticRegistry: TaskSpecSemanticRegistry;
}

export interface PluginPackageResourceLockSource {
  findLock(lockDigest: string): Promise<Readonly<PluginPackageLock> | null>;
}

export interface PluginPackageResourceByteReader {
  /**
   * Reads one immutable staged entry. The reader must apply maximumBytes before
   * buffering the complete entry and stay bound to the generation it opened.
   */
  read(path: string, maximumBytes: number): Promise<Uint8Array>;
  close(): void | Promise<void>;
}

export interface PluginPackageResourceByteSource {
  /**
   * Opens one bounded, caller-owned read session. Implementations must not
   * retain watchers, timers or authoritative cache after close.
   */
  open(
    generation: Readonly<PluginPackageResourceGeneration>,
  ): Promise<PluginPackageResourceByteReader>;
}

export interface MaterializeActivePluginPackageResourcesOptions {
  readonly projectId: string;
  readonly packageName: string;
  readonly generationSource: PluginPackageResourceGenerationSource;
  readonly lockSource: PluginPackageResourceLockSource;
  readonly byteSource: PluginPackageResourceByteSource;
  readonly secretBindingSource?: Pick<
    PluginPackageSecretBindingRepository,
    'find'
  >;
  readonly taskSpecSemanticRegistry: TaskSpecSemanticRegistry;
}

export interface MaterializePluginPackageResourceGenerationOptions {
  readonly generation: Readonly<PluginPackageResourceGeneration>;
  readonly lock: Readonly<PluginPackageLock>;
  readonly byteSource: PluginPackageResourceByteSource;
  readonly secretBindingSource?: Pick<
    PluginPackageSecretBindingRepository,
    'find'
  >;
  readonly taskSpecSemanticRegistry: TaskSpecSemanticRegistry;
}

export interface PluginPackageMaterializedRevisionRepository {
  find(
    generationDigest: string,
  ): Promise<Readonly<PluginPackageMaterializedRevision> | null>;
  publish(revision: Readonly<PluginPackageMaterializedRevision>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      revision: Readonly<PluginPackageMaterializedRevision>;
    }>
  >;
}

export class PluginPackageResourceActivationPrerequisite
  implements PluginPackageActivationPrerequisite
{
  constructor(
    private readonly options: {
      readonly byteSource: PluginPackageResourceByteSource;
      readonly materializedRepository: PluginPackageMaterializedRevisionRepository;
      readonly secretBindingSource?: Pick<
        PluginPackageSecretBindingRepository,
        'find'
      >;
      readonly taskSpecSemanticRegistry: TaskSpecSemanticRegistry;
    },
  ) {
    const authorities = dataRecord(options, 'activation prerequisite options');
    exactKeys(
      authorities,
      ['byteSource', 'materializedRepository', 'taskSpecSemanticRegistry'],
      ['secretBindingSource'],
      'activation prerequisite options',
    );
    if (
      !options.byteSource ||
      typeof options.byteSource.open !== 'function' ||
      !options.materializedRepository ||
      typeof options.materializedRepository.find !== 'function' ||
      typeof options.materializedRepository.publish !== 'function' ||
      (options.secretBindingSource !== undefined &&
        (!options.secretBindingSource ||
          typeof options.secretBindingSource.find !== 'function')) ||
      !(options.taskSpecSemanticRegistry instanceof TaskSpecSemanticRegistry)
    ) {
      invalid('activation prerequisite authority is invalid');
    }
  }

  async inspect(
    recordValue: Readonly<PluginPackageInstallRecord>,
    lockValue: Readonly<PluginPackageLock>,
  ): Promise<Readonly<PluginPackageActivationPrerequisiteObservation>> {
    try {
      const record = normalizePluginPackageInstallRecord(recordValue);
      const lock = normalizePluginPackageLock(lockValue);
      assertPluginPackageInstallMatchesLock(lock, record);
      if (record.state !== 'staged') {
        invalid('activation prerequisite requires a staged install');
      }
      // Generation one may require the post-activation B1 binding ceremony.
      // There is no healthy previous pointer to preserve in that flow.
      if (record.previousActiveLockDigest === null) {
        return Object.freeze({ status: 'ready' as const });
      }
      const generation = createPluginPackageResourceGenerationFromReferences({
        installationId: record.installationId,
        projectId: record.projectId,
        packageName: record.packageName,
        lockDigest: lock.lockDigest,
        generation: lock.targetGeneration,
        previousActiveLockDigest: record.previousActiveLockDigest,
        contentDigest: lock.source.contentDigest,
        resources: lock.resources,
      });
      let revision = await this.options.materializedRepository.find(
        generation.generationDigest,
      );
      if (revision === null) {
        const candidate = await materializePluginPackageResourceGeneration({
          generation,
          lock,
          byteSource: this.options.byteSource,
          ...(this.options.secretBindingSource === undefined
            ? {}
            : { secretBindingSource: this.options.secretBindingSource }),
          taskSpecSemanticRegistry: this.options.taskSpecSemanticRegistry,
        });
        revision = (
          await this.options.materializedRepository.publish(candidate)
        ).revision;
      }
      const durable = normalizePluginPackageMaterializedRevision(
        revision,
        this.options.taskSpecSemanticRegistry,
      );
      if (
        durable.generation.generationDigest !== generation.generationDigest ||
        durable.generation.installationId !== record.installationId ||
        durable.generation.lockDigest !== lock.lockDigest
      ) {
        throw new PluginPackageResourceMaterializationConflictError(
          'durable candidate revision does not match the staged generation',
        );
      }
      return Object.freeze({ status: 'ready' as const });
    } catch (error) {
      if (
        error instanceof InvalidPluginPackageResourceMaterializationError ||
        error instanceof PluginPackageResourceMaterializationConflictError
      ) {
        return Object.freeze({
          status: 'rejected' as const,
          reason: 'activation_fact_conflict' as const,
        });
      }
      if (error instanceof PluginPackageInstallUnavailableError) throw error;
      throw new PluginPackageInstallUnavailableError();
    }
  }
}

export interface PluginPackageTaskDefinitionDraft {
  readonly projectId: string;
  readonly taskId: string;
  readonly name: string;
  readonly description?: string;
  readonly kind: TaskDefinitionKind;
  readonly spec: TaskDefinitionSpec;
  readonly labels: Readonly<Record<string, string>>;
  readonly enabled: boolean;
}

export class InvalidPluginPackageResourceMaterializationError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_RESOURCE_MATERIALIZATION_INVALID';

  constructor(message: string) {
    super(`Plugin Package resource materialization is invalid: ${message}`);
    this.name = 'InvalidPluginPackageResourceMaterializationError';
  }
}

export class PluginPackageResourceMaterializationConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_RESOURCE_MATERIALIZATION_CONFLICT';

  constructor(message: string) {
    super(
      `Plugin Package resource materialization conflicts with state: ${message}`,
    );
    this.name = 'PluginPackageResourceMaterializationConflictError';
  }
}

export class PluginPackageResourceMaterializationUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_RESOURCE_MATERIALIZATION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package resource materialization is unavailable', options);
    this.name = 'PluginPackageResourceMaterializationUnavailableError';
  }
}

const DIGEST = /^[0-9a-f]{64}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESOURCE_ID = /^[a-z][a-z0-9-]{0,62}$/;
const STEP_ID = /^[a-z][a-z0-9-]{0,62}$/;
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const REVISION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-materialized-revision-digest@v1\0',
  'utf8',
);
const PROJECT_PERMISSION_TO_PACKAGE_PERMISSION: Readonly<
  Record<string, string>
> = Object.freeze({
  'artifact.read': 'artifact.read',
  'run.read': 'run.read',
  'run.start': 'run.start',
  'run.stop': 'run.stop',
  'run.retry': 'run.retry',
  'secret.use': 'secret.use',
  'task.read': 'task.read',
  'task.update': 'task.update',
});

function invalid(message: string): never {
  throw new InvalidPluginPackageResourceMaterializationError(message);
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
  optional: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(value);
  const strings = actual.filter(
    (key): key is string => typeof key === 'string',
  );
  const allowed = new Set([...required, ...optional]);
  if (
    actual.length !== strings.length ||
    required.some((key) => !strings.includes(key)) ||
    strings.some((key) => !allowed.has(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function boundedDenseArray(
  value: unknown,
  maximum: number,
  label: string,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
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

function assertDataTree(
  value: unknown,
  budget: { nodes: number },
  depth = 0,
  seen = new Set<object>(),
): void {
  budget.nodes += 1;
  if (budget.nodes > 100_000 || depth > 32) {
    invalid('materialized revision exceeds its structure budget');
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    invalid('materialized revision contains a non-data or cyclic value');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const entries = boundedDenseArray(value, 100_000, 'revision array');
    for (const entry of entries) {
      assertDataTree(entry, budget, depth + 1, seen);
    }
    seen.delete(value);
    return;
  }
  const record = dataRecord(value, 'revision object');
  for (const entry of Object.values(record)) {
    assertDataTree(entry, budget, depth + 1, seen);
  }
  seen.delete(value);
}

function boundedText(
  value: unknown,
  label: string,
  maximumBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.includes('\0') ||
    CONTROL.test(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function boundedTemplate(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_PLUGIN_PACKAGE_PROMPT_TEMPLATE_BYTES
  ) {
    return invalid('Prompt template is invalid');
  }
  return value;
}

function optionalDescription(value: unknown): string | undefined {
  return value === undefined
    ? undefined
    : boundedText(value, 'description', 4096);
}

function resourceId(value: unknown, label = 'resource id'): string {
  const id = boundedText(value, label, 63);
  if (!RESOURCE_ID.test(id)) return invalid(`${label} is invalid`);
  return id;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function byteCount(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_PLUGIN_PACKAGE_MATERIALIZED_RESOURCE_BYTES
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function bytes(value: unknown, maximum: number, label: string): Buffer {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return Buffer.from(value);
}

function parseJson(value: Buffer, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return invalid(`${label} is not strict UTF-8`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid(`${label} is not JSON`);
  }
  return parsed;
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

function materializedRevisionDigest(
  value: Omit<PluginPackageMaterializedRevision, 'revisionDigest'>,
): string {
  return createHash('sha256')
    .update(REVISION_DIGEST_DOMAIN)
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function taskIdentity(packageName: string, id: string): string {
  const taskId = `pkg:${packageName}:${id}`;
  if (Buffer.byteLength(taskId, 'utf8') > 128) {
    return invalid('package Task identity exceeds the TaskDefinition budget');
  }
  return taskId;
}

function normalizeTaskResource(
  value: unknown,
  packageName: string,
  projectId: string,
  manifest: Readonly<PluginPackageManifest>,
  registry: TaskSpecSemanticRegistry,
  secretBinding: Readonly<PluginPackageSecretBinding> | undefined,
  source: boolean,
): Readonly<PluginPackageTaskResource> {
  const task = dataRecord(value, 'Task resource');
  exactKeys(
    task,
    ['schema', 'id', 'name', 'labels', 'enabled', 'kind', 'spec'],
    ['description'],
    'Task resource',
  );
  if (task.schema !== PLUGIN_PACKAGE_TASK_RESOURCE_SCHEMA) {
    return invalid('Task resource schema is unsupported');
  }
  const id = resourceId(task.id, 'Task id');
  const taskId = taskIdentity(packageName, id);
  const kind = task.kind;
  let spec = normalizeTaskDefinitionSpec(task.spec as TaskDefinitionSpec);
  if (kind !== 'command' || spec.schema !== BUILT_IN_COMMAND_TASK_SPEC_SCHEMA) {
    return invalid(
      'Task resource v1 only supports qinglong/command@v1 command tasks',
    );
  }
  if (!manifest.spec.permissions.tools.includes('system.command')) {
    return invalid(
      'command Task requires the approved system.command permission',
    );
  }
  if (!(registry instanceof TaskSpecSemanticRegistry)) {
    return invalid('TaskSpec semantic registry is invalid');
  }
  if (source) {
    spec = compilePackageSecretEnvironment(spec, secretBinding);
  }
  let normalizedSpec: TaskDefinitionSpec;
  try {
    normalizedSpec = registry.normalize({
      projectId,
      taskId,
      kind,
      spec,
    });
  } catch {
    return invalid('Task resource spec semantics are invalid or unsupported');
  }
  assertResolvedPackageSecretEnvironment(normalizedSpec, secretBinding);
  const description = optionalDescription(task.description);
  if (typeof task.enabled !== 'boolean') {
    return invalid('Task enabled is invalid');
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_TASK_RESOURCE_SCHEMA,
    id,
    name: boundedText(task.name, 'Task name', 255),
    ...(description === undefined ? {} : { description }),
    labels: normalizeTaskDefinitionLabels(
      task.labels as Readonly<Record<string, string>>,
    ),
    enabled: task.enabled,
    kind,
    spec: normalizedSpec,
  });
}

function compilePackageSecretEnvironment(
  spec: Readonly<TaskDefinitionSpec>,
  secretBinding: Readonly<PluginPackageSecretBinding> | undefined,
): Readonly<TaskDefinitionSpec> {
  const environment = spec.config.environment;
  if (!Array.isArray(environment)) return spec;
  const entries = new Map(
    (secretBinding?.entries ?? []).map((entry) => [entry.name, entry]),
  );
  const compiled = environment.flatMap((value) => {
    const entry = dataRecord(value, 'Task environment');
    if (entry.kind === 'secret') {
      return invalid('Package Task source cannot contain a direct SecretRef');
    }
    if (entry.kind !== 'package-secret') return [value];
    exactKeys(
      entry,
      ['kind', 'name', 'requirement'],
      [],
      'Package Secret environment',
    );
    const requirement = boundedText(
      entry.requirement,
      'Package Secret requirement',
      128,
    );
    const binding = entries.get(requirement);
    if (!binding) {
      return invalid(
        'Package Task references an undeclared Secret requirement',
      );
    }
    if (binding.secretRef === null) return [];
    return [
      Object.freeze({
        name: entry.name as TaskDefinitionJson,
        kind: 'secret' as const,
        secretRef: binding.secretRef,
      }),
    ];
  });
  return normalizeTaskDefinitionSpec(
    Object.freeze({
      schema: spec.schema,
      config: Object.freeze({
        ...spec.config,
        environment: Object.freeze(compiled),
      }),
    }),
  );
}

function assertResolvedPackageSecretEnvironment(
  spec: Readonly<TaskDefinitionSpec>,
  secretBinding: Readonly<PluginPackageSecretBinding> | undefined,
): void {
  const allowed = new Set(
    (secretBinding?.entries ?? []).flatMap((entry) =>
      entry.secretRef === null ? [] : [entry.secretRef],
    ),
  );
  const environment = spec.config.environment;
  if (!Array.isArray(environment)) return;
  for (const value of environment) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Readonly<Record<string, TaskDefinitionJson>>;
    if (entry.kind === 'secret' && !allowed.has(entry.secretRef as string)) {
      invalid('Task SecretRef is not authorized by the Package binding');
    }
  }
}

function normalizeWorkflowResource(
  value: unknown,
): Readonly<PluginPackageWorkflowResource> {
  const workflow = dataRecord(value, 'Workflow resource');
  exactKeys(
    workflow,
    ['schema', 'id', 'name', 'enabled', 'steps'],
    ['description'],
    'Workflow resource',
  );
  if (workflow.schema !== PLUGIN_PACKAGE_WORKFLOW_RESOURCE_SCHEMA) {
    return invalid('Workflow resource schema is unsupported');
  }
  if (typeof workflow.enabled !== 'boolean') {
    return invalid('Workflow enabled is invalid');
  }
  const ids = new Set<string>();
  const steps = boundedDenseArray(
    workflow.steps,
    MAX_PLUGIN_PACKAGE_WORKFLOW_STEPS,
    'Workflow steps',
  ).map((stepValue) => {
    const step = dataRecord(stepValue, 'Workflow step');
    exactKeys(step, ['id', 'task', 'needs'], [], 'Workflow step');
    const id = boundedText(step.id, 'Workflow step id', 63);
    if (!STEP_ID.test(id) || ids.has(id)) {
      return invalid('Workflow step id is invalid or duplicated');
    }
    ids.add(id);
    const task = resourceId(step.task, 'Workflow Task reference');
    const needs = boundedDenseArray(
      step.needs,
      MAX_PLUGIN_PACKAGE_WORKFLOW_STEPS,
      'Workflow step needs',
    ).map((need) => {
      const dependency = boundedText(need, 'Workflow step dependency', 63);
      if (!STEP_ID.test(dependency)) {
        return invalid('Workflow step dependency is invalid');
      }
      return dependency;
    });
    if (new Set(needs).size !== needs.length || needs.includes(id)) {
      return invalid('Workflow step dependencies are duplicated or recursive');
    }
    return Object.freeze({
      id,
      task,
      needs: Object.freeze([...needs].sort()),
    });
  });
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    if (step.needs.some((need) => !byId.has(need))) {
      return invalid('Workflow step references an unknown dependency');
    }
  }
  const pending = new Map(steps.map((step) => [step.id, new Set(step.needs)]));
  const ready = [...pending.entries()]
    .filter(([, needs]) => needs.size === 0)
    .map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const current = ready.pop()!;
    if (!pending.delete(current)) continue;
    visited += 1;
    for (const [id, needs] of pending) {
      if (needs.delete(current) && needs.size === 0) ready.push(id);
    }
  }
  if (visited !== steps.length) {
    return invalid('Workflow graph contains a cycle');
  }
  const description = optionalDescription(workflow.description);
  return Object.freeze({
    schema: PLUGIN_PACKAGE_WORKFLOW_RESOURCE_SCHEMA,
    id: resourceId(workflow.id, 'Workflow id'),
    name: boundedText(workflow.name, 'Workflow name', 255),
    ...(description === undefined ? {} : { description }),
    enabled: workflow.enabled,
    steps: Object.freeze(
      [...steps].sort((left, right) => left.id.localeCompare(right.id)),
    ),
  });
}

function normalizePromptResource(
  value: unknown,
): Readonly<PluginPackagePromptResource> {
  const prompt = dataRecord(value, 'Prompt resource');
  exactKeys(
    prompt,
    ['schema', 'id', 'name', 'template', 'parameters'],
    ['description'],
    'Prompt resource',
  );
  if (prompt.schema !== PLUGIN_PACKAGE_PROMPT_RESOURCE_SCHEMA) {
    return invalid('Prompt resource schema is unsupported');
  }
  const names = new Set<string>();
  const parameters = boundedDenseArray(
    prompt.parameters,
    MAX_PLUGIN_PACKAGE_PROMPT_PARAMETERS,
    'Prompt parameters',
  ).map((parameterValue) => {
    const parameter = dataRecord(parameterValue, 'Prompt parameter');
    exactKeys(
      parameter,
      ['name', 'required'],
      ['description'],
      'Prompt parameter',
    );
    const name = boundedText(parameter.name, 'Prompt parameter name', 64);
    if (!PARAMETER_NAME.test(name) || names.has(name)) {
      return invalid('Prompt parameter name is invalid or duplicated');
    }
    if (typeof parameter.required !== 'boolean') {
      return invalid('Prompt parameter required flag is invalid');
    }
    names.add(name);
    const description = optionalDescription(parameter.description);
    return Object.freeze({
      name,
      ...(description === undefined ? {} : { description }),
      required: parameter.required,
    });
  });
  const template = boundedTemplate(prompt.template);
  const referenced = new Set<string>();
  for (const match of template.matchAll(
    /\{\{([A-Za-z][A-Za-z0-9_.-]{0,63})\}\}/g,
  )) {
    referenced.add(match[1]!);
  }
  if (
    [...referenced].some((name) => !names.has(name)) ||
    [...names].some((name) => !referenced.has(name))
  ) {
    return invalid(
      'Prompt placeholders and declared parameters must match exactly',
    );
  }
  const description = optionalDescription(prompt.description);
  return Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_RESOURCE_SCHEMA,
    id: resourceId(prompt.id, 'Prompt id'),
    name: boundedText(prompt.name, 'Prompt name', 255),
    ...(description === undefined ? {} : { description }),
    template,
    parameters: Object.freeze(
      [...parameters].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    ),
  });
}

export function normalizePluginPackageWorkflowResource(
  value: unknown,
): Readonly<PluginPackageWorkflowResource> {
  return normalizeWorkflowResource(value);
}

export function normalizePluginPackagePromptResource(
  value: unknown,
): Readonly<PluginPackagePromptResource> {
  return normalizePromptResource(value);
}

function normalizeToolResource(
  value: unknown,
  packageName: string,
  manifest: Readonly<PluginPackageManifest>,
): Readonly<PluginPackageToolResource> {
  const tool = dataRecord(value, 'Tool resource');
  exactKeys(tool, ['schema', 'definition'], [], 'Tool resource');
  if (tool.schema !== PLUGIN_PACKAGE_TOOL_RESOURCE_SCHEMA) {
    return invalid('Tool resource schema is unsupported');
  }
  let definition: Readonly<ToolDefinition>;
  try {
    definition = normalizeToolDefinition(tool.definition);
  } catch {
    return invalid('Tool definition is invalid');
  }
  if (!definition.name.startsWith(`${packageName}.`)) {
    return invalid('Tool name must be namespaced by its Package name');
  }
  const approved = new Set(manifest.spec.permissions.tools);
  for (const permission of definition.requiredPermissions) {
    const packagePermission =
      PROJECT_PERMISSION_TO_PACKAGE_PERMISSION[permission];
    if (
      packagePermission === undefined ||
      !approved.has(packagePermission as never)
    ) {
      return invalid(
        'Tool required permission is not present in the approved Package manifest',
      );
    }
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_TOOL_RESOURCE_SCHEMA,
    definition,
  });
}

function normalizeMaterializedValue(
  kind: PluginPackageResourceKind,
  value: unknown,
  packageName: string,
  projectId: string,
  manifest: Readonly<PluginPackageManifest>,
  registry: TaskSpecSemanticRegistry,
  secretBinding: Readonly<PluginPackageSecretBinding> | undefined,
  source: boolean,
): PluginPackageMaterializedResourceValue {
  switch (kind) {
    case 'task':
      return normalizeTaskResource(
        value,
        packageName,
        projectId,
        manifest,
        registry,
        secretBinding,
        source,
      );
    case 'workflow':
      return normalizeWorkflowResource(value);
    case 'prompt':
      return normalizePromptResource(value);
    case 'tool':
      return normalizeToolResource(value, packageName, manifest);
  }
}

function validateCrossResourceSemantics(
  resources: readonly Readonly<PluginPackageMaterializedResource>[],
): void {
  const ids = new Map<PluginPackageResourceKind, Set<string>>([
    ['task', new Set()],
    ['workflow', new Set()],
    ['prompt', new Set()],
    ['tool', new Set()],
  ]);
  for (const resource of resources) {
    const identity =
      resource.kind === 'tool'
        ? (resource.value as PluginPackageToolResource).definition.name
        : (
            resource.value as
              | PluginPackageTaskResource
              | PluginPackageWorkflowResource
              | PluginPackagePromptResource
          ).id;
    const kindIds = ids.get(resource.kind)!;
    if (kindIds.has(identity)) {
      invalid(`${resource.kind} resource identity is duplicated`);
    }
    kindIds.add(identity);
  }
  const tasks = ids.get('task')!;
  for (const resource of resources) {
    if (resource.kind !== 'workflow') continue;
    const workflow = resource.value as PluginPackageWorkflowResource;
    if (workflow.steps.some((step) => !tasks.has(step.task))) {
      invalid('Workflow references an unknown package Task');
    }
  }
  if (ids.get('tool')!.size > MAX_TOOL_DEFINITIONS) {
    invalid('Package Tool resources exceed the immutable registry budget');
  }
}

function normalizeManifestBytes(
  value: unknown,
  lock: Readonly<PluginPackageLock>,
): Readonly<PluginPackageManifest> {
  const material = bytes(
    value,
    MAX_PLUGIN_PACKAGE_MANIFEST_BYTES,
    'manifest bytes',
  );
  let manifest: Readonly<PluginPackageManifest>;
  try {
    manifest = normalizePluginPackageManifest(
      parseJson(material, 'Package manifest'),
    );
  } catch (error) {
    if (error instanceof InvalidPluginPackageResourceMaterializationError) {
      throw error;
    }
    return invalid('Package manifest semantics are invalid');
  }
  if (
    serializePluginPackageManifest(manifest) !== material.toString('utf8') ||
    pluginPackageManifestDigest(manifest) !== lock.manifestDigest ||
    manifest.metadata.name !== lock.packageName ||
    manifest.metadata.version !== lock.packageVersion
  ) {
    return invalid('Package manifest does not match its immutable lock');
  }
  return manifest;
}

function normalizeRevisionResources(
  values: unknown,
  generation: Readonly<PluginPackageResourceGeneration>,
  manifest: Readonly<PluginPackageManifest>,
  registry: TaskSpecSemanticRegistry,
  secretBinding: Readonly<PluginPackageSecretBinding> | undefined,
): readonly Readonly<PluginPackageMaterializedResource>[] {
  const entries = boundedDenseArray(
    values,
    generation.resources.length,
    'materialized resources',
  );
  if (entries.length !== generation.resources.length) {
    return invalid('materialized resources are incomplete');
  }
  let totalBytes = 0;
  const resources = entries.map((entryValue, index) => {
    const entry = dataRecord(entryValue, 'materialized resource');
    exactKeys(
      entry,
      ['kind', 'path', 'sourceBytes', 'sourceDigest', 'value'],
      [],
      'materialized resource',
    );
    const reference = generation.resources[index]!;
    if (entry.kind !== reference.kind || entry.path !== reference.path) {
      return invalid(
        'materialized resource order or identity does not match generation',
      );
    }
    const sourceBytes = byteCount(entry.sourceBytes, 'resource source bytes');
    totalBytes += sourceBytes;
    if (totalBytes > MAX_PLUGIN_PACKAGE_MATERIALIZED_TOTAL_BYTES) {
      return invalid('materialized resources exceed the total byte budget');
    }
    return Object.freeze({
      kind: reference.kind,
      path: reference.path,
      sourceBytes,
      sourceDigest: digest(entry.sourceDigest, 'resource source digest'),
      value: normalizeMaterializedValue(
        reference.kind,
        entry.value,
        generation.packageName,
        generation.projectId,
        manifest,
        registry,
        secretBinding,
        false,
      ),
    });
  });
  validateCrossResourceSemantics(resources);
  return Object.freeze(resources);
}

function assertGenerationMatchesLock(
  generation: Readonly<PluginPackageResourceGeneration>,
  lock: Readonly<PluginPackageLock>,
): void {
  const previousLockDigest = lock.previousLockDigest ?? null;
  if (
    generation.lockDigest !== lock.lockDigest ||
    generation.projectId !== lock.projectId ||
    generation.packageName !== lock.packageName ||
    generation.generation !== lock.targetGeneration ||
    generation.previousActiveLockDigest !== previousLockDigest ||
    generation.contentDigest !== lock.source.contentDigest ||
    JSON.stringify(generation.resources) !== JSON.stringify(lock.resources)
  ) {
    invalid('active generation does not match its immutable lock');
  }
}

function assertManifestMatchesGeneration(
  manifest: Readonly<PluginPackageManifest>,
  generation: Readonly<PluginPackageResourceGeneration>,
): void {
  const references = pluginPackageResourceReferencesFromContents(
    manifest.spec.contents,
  );
  if (JSON.stringify(references) !== JSON.stringify(generation.resources)) {
    invalid('Package manifest resources do not match active generation');
  }
}

export function normalizePluginPackageMaterializedRevision(
  value: PluginPackageMaterializedRevision,
  taskSpecSemanticRegistry: TaskSpecSemanticRegistry,
): Readonly<PluginPackageMaterializedRevision> {
  assertDataTree(value, { nodes: 0 });
  const revision = dataRecord(value, 'materialized revision');
  exactKeys(
    revision,
    [
      'schema',
      'generation',
      'lock',
      'manifest',
      'manifestDigest',
      'resources',
      'revisionDigest',
    ],
    ['secretBinding'],
    'materialized revision',
  );
  if (revision.schema !== PLUGIN_PACKAGE_MATERIALIZED_REVISION_SCHEMA) {
    return invalid('materialized revision schema is unsupported');
  }
  const generation = normalizePluginPackageResourceGeneration(
    revision.generation as PluginPackageResourceGeneration,
  );
  const lock = normalizePluginPackageLock(revision.lock as PluginPackageLock);
  assertGenerationMatchesLock(generation, lock);
  const manifest = normalizePluginPackageManifest(revision.manifest);
  const manifestDigest = digest(revision.manifestDigest, 'manifest digest');
  if (
    pluginPackageManifestDigest(manifest) !== manifestDigest ||
    manifestDigest !== lock.manifestDigest ||
    manifest.metadata.name !== generation.packageName ||
    manifest.metadata.version !== lock.packageVersion
  ) {
    return invalid('materialized manifest identity or digest is invalid');
  }
  assertManifestMatchesGeneration(manifest, generation);
  const secretBinding = normalizeMaterializationSecretBinding(
    revision.secretBinding as Readonly<PluginPackageSecretBinding> | undefined,
    generation,
    manifest,
  );
  const resources = normalizeRevisionResources(
    revision.resources,
    generation,
    manifest,
    taskSpecSemanticRegistry,
    secretBinding,
  );
  const descriptors: PluginPackageContentEntryDescriptor[] = resources
    .map((resource) =>
      Object.freeze({
        path: resource.path,
        bytes: resource.sourceBytes,
        digest: resource.sourceDigest,
      }),
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    pluginPackageContentTreeDigest(descriptors) !== generation.contentDigest
  ) {
    return invalid('materialized resource bytes do not match the content tree');
  }
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_MATERIALIZED_REVISION_SCHEMA,
    generation,
    lock,
    manifest,
    manifestDigest,
    ...(secretBinding === undefined ? {} : { secretBinding }),
    resources,
  });
  const revisionDigest = digest(revision.revisionDigest, 'revision digest');
  if (materializedRevisionDigest(unsigned) !== revisionDigest) {
    return invalid('materialized revision digest does not match');
  }
  return Object.freeze({ ...unsigned, revisionDigest });
}

export function materializePluginPackageResources(
  value: MaterializePluginPackageResourcesInput,
): Readonly<PluginPackageMaterializedRevision> {
  const input = dataRecord(value, 'materialization input');
  exactKeys(
    input,
    [
      'generation',
      'lock',
      'manifestBytes',
      'resources',
      'taskSpecSemanticRegistry',
    ],
    ['secretBinding'],
    'materialization input',
  );
  const generation = normalizePluginPackageResourceGeneration(value.generation);
  const lock = normalizePluginPackageLock(value.lock);
  assertGenerationMatchesLock(generation, lock);
  const manifest = normalizeManifestBytes(value.manifestBytes, lock);
  assertManifestMatchesGeneration(manifest, generation);
  const secretBinding = normalizeMaterializationSecretBinding(
    value.secretBinding,
    generation,
    manifest,
  );
  const entries = boundedDenseArray(
    value.resources,
    generation.resources.length,
    'resource byte entries',
  );
  if (entries.length !== generation.resources.length) {
    return invalid('resource byte entries are incomplete');
  }
  let totalBytes = 0;
  const resources = entries.map((entryValue, index) => {
    const entry = dataRecord(entryValue, 'resource byte entry');
    exactKeys(entry, ['reference', 'bytes'], [], 'resource byte entry');
    const reference = dataRecord(entry.reference, 'resource reference');
    exactKeys(reference, ['kind', 'path'], [], 'resource reference');
    const expected = generation.resources[index]!;
    if (
      reference.kind !== expected.kind ||
      reference.path !== expected.path ||
      !expected.path.endsWith('.json')
    ) {
      return invalid(
        'resource byte entry identity, order or JSON extension is invalid',
      );
    }
    const material = bytes(
      entry.bytes,
      MAX_PLUGIN_PACKAGE_MATERIALIZED_RESOURCE_BYTES,
      'resource bytes',
    );
    totalBytes += material.byteLength;
    if (totalBytes > MAX_PLUGIN_PACKAGE_MATERIALIZED_TOTAL_BYTES) {
      return invalid('resource bytes exceed the total materialization budget');
    }
    return Object.freeze({
      kind: expected.kind,
      path: expected.path,
      sourceBytes: material.byteLength,
      sourceDigest: createHash('sha256').update(material).digest('hex'),
      value: normalizeMaterializedValue(
        expected.kind,
        parseJson(material, `${expected.kind} resource`),
        generation.packageName,
        generation.projectId,
        manifest,
        value.taskSpecSemanticRegistry,
        secretBinding,
        true,
      ),
    });
  });
  validateCrossResourceSemantics(resources);
  const descriptors = resources
    .map((resource) =>
      Object.freeze({
        path: resource.path,
        bytes: resource.sourceBytes,
        digest: resource.sourceDigest,
      }),
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    pluginPackageContentTreeDigest(descriptors) !== generation.contentDigest
  ) {
    return invalid('resource bytes do not match the active content tree');
  }
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_MATERIALIZED_REVISION_SCHEMA,
    generation,
    lock,
    manifest,
    manifestDigest: lock.manifestDigest,
    ...(secretBinding === undefined ? {} : { secretBinding }),
    resources: Object.freeze(resources),
  });
  return normalizePluginPackageMaterializedRevision(
    Object.freeze({
      ...unsigned,
      revisionDigest: materializedRevisionDigest(unsigned),
    }),
    value.taskSpecSemanticRegistry,
  );
}

function normalizeMaterializationSecretBinding(
  value: Readonly<PluginPackageSecretBinding> | undefined,
  generation: Readonly<PluginPackageResourceGeneration>,
  manifest: Readonly<PluginPackageManifest>,
): Readonly<PluginPackageSecretBinding> | undefined {
  if (manifest.spec.permissions.secrets.length === 0) {
    if (value !== undefined) {
      invalid('Secret binding is forbidden when Manifest declares no Secrets');
    }
    return undefined;
  }
  if (!manifest.spec.permissions.tools.includes('secret.use')) {
    return invalid(
      'Secret-aware Package requires the approved secret.use permission',
    );
  }
  if (value === undefined) {
    return invalid('Secret-aware Package requires an approved binding');
  }
  try {
    return assertPluginPackageSecretBindingMatches(value, generation, manifest);
  } catch {
    return invalid('Secret binding does not match generation and Manifest');
  }
}

function materializationSources(
  value: MaterializeActivePluginPackageResourcesOptions,
): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !value.generationSource ||
    typeof value.generationSource.findActiveResourceGeneration !== 'function' ||
    !value.lockSource ||
    typeof value.lockSource.findLock !== 'function' ||
    !value.byteSource ||
    typeof value.byteSource.open !== 'function' ||
    (value.secretBindingSource !== undefined &&
      (!value.secretBindingSource ||
        typeof value.secretBindingSource.find !== 'function')) ||
    !(value.taskSpecSemanticRegistry instanceof TaskSpecSemanticRegistry)
  ) {
    invalid('active materialization sources are invalid');
  }
  if (
    typeof value.projectId !== 'string' ||
    value.projectId.length < 1 ||
    Buffer.byteLength(value.projectId, 'utf8') > 128 ||
    typeof value.packageName !== 'string' ||
    !PACKAGE_NAME.test(value.packageName)
  ) {
    invalid('active materialization identity is invalid');
  }
}

function generationMaterializationSources(
  value: MaterializePluginPackageResourceGenerationOptions,
): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !value.byteSource ||
    typeof value.byteSource.open !== 'function' ||
    (value.secretBindingSource !== undefined &&
      (!value.secretBindingSource ||
        typeof value.secretBindingSource.find !== 'function')) ||
    !(value.taskSpecSemanticRegistry instanceof TaskSpecSemanticRegistry)
  ) {
    invalid('generation materialization sources are invalid');
  }
}

/**
 * Qualifies one immutable candidate generation without consulting or moving
 * the active pointer. Callers may durably publish the returned revision before
 * activation so deterministic Package errors cannot replace a healthy head.
 */
export async function materializePluginPackageResourceGeneration(
  value: MaterializePluginPackageResourceGenerationOptions,
): Promise<Readonly<PluginPackageMaterializedRevision>> {
  generationMaterializationSources(value);
  try {
    const generation = normalizePluginPackageResourceGeneration(
      value.generation,
    );
    const lock = normalizePluginPackageLock(value.lock);
    assertGenerationMatchesLock(generation, lock);
    const reader = await value.byteSource.open(generation);
    if (
      !reader ||
      typeof reader !== 'object' ||
      typeof reader.read !== 'function' ||
      typeof reader.close !== 'function'
    ) {
      invalid('resource byte source returned an invalid reader');
    }
    let manifestBytes: Uint8Array;
    const resources: PluginPackageResourceMaterializationEntry[] = [];
    try {
      manifestBytes = await reader.read(
        'package.json',
        MAX_PLUGIN_PACKAGE_MANIFEST_BYTES,
      );
      let totalBytes = 0;
      for (const reference of generation.resources) {
        const material = await reader.read(
          reference.path,
          MAX_PLUGIN_PACKAGE_MATERIALIZED_RESOURCE_BYTES,
        );
        if (!(material instanceof Uint8Array)) {
          invalid('resource byte source returned a non-byte value');
        }
        totalBytes += material.byteLength;
        if (totalBytes > MAX_PLUGIN_PACKAGE_MATERIALIZED_TOTAL_BYTES) {
          invalid(
            'resource byte source exceeded the total materialization budget',
          );
        }
        resources.push(Object.freeze({ reference, bytes: material }));
      }
    } finally {
      try {
        await reader.close();
      } catch (error) {
        throw new PluginPackageResourceMaterializationUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
    }
    const manifest = normalizeManifestBytes(manifestBytes, lock);
    const bindingValue =
      manifest.spec.permissions.secrets.length === 0
        ? undefined
        : await value.secretBindingSource?.find(generation.generationDigest);
    return materializePluginPackageResources({
      generation,
      lock,
      manifestBytes,
      ...(bindingValue === undefined || bindingValue === null
        ? {}
        : { secretBinding: bindingValue }),
      resources: Object.freeze(resources),
      taskSpecSemanticRegistry: value.taskSpecSemanticRegistry,
    });
  } catch (error) {
    if (
      error instanceof InvalidPluginPackageResourceMaterializationError ||
      error instanceof PluginPackageResourceMaterializationConflictError ||
      error instanceof PluginPackageResourceMaterializationUnavailableError
    ) {
      throw error;
    }
    throw new PluginPackageResourceMaterializationUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  }
}

export async function materializeActivePluginPackageResources(
  value: MaterializeActivePluginPackageResourcesOptions,
): Promise<Readonly<PluginPackageMaterializedRevision> | null> {
  materializationSources(value);
  try {
    const first = await value.generationSource.findActiveResourceGeneration(
      value.projectId,
      value.packageName,
    );
    if (first === null) return null;
    const generation = normalizePluginPackageResourceGeneration(first);
    if (
      generation.projectId !== value.projectId ||
      generation.packageName !== value.packageName
    ) {
      throw new PluginPackageResourceMaterializationConflictError(
        'generation source returned another Package identity',
      );
    }
    const lockValue = await value.lockSource.findLock(generation.lockDigest);
    if (lockValue === null) {
      throw new PluginPackageResourceMaterializationConflictError(
        'active generation lock is missing',
      );
    }
    const lock = normalizePluginPackageLock(lockValue);
    const revision = await materializePluginPackageResourceGeneration({
      generation,
      lock,
      byteSource: value.byteSource,
      ...(value.secretBindingSource === undefined
        ? {}
        : { secretBindingSource: value.secretBindingSource }),
      taskSpecSemanticRegistry: value.taskSpecSemanticRegistry,
    });
    const secondValue =
      await value.generationSource.findActiveResourceGeneration(
        value.projectId,
        value.packageName,
      );
    if (secondValue === null) {
      throw new PluginPackageResourceMaterializationConflictError(
        'active generation disappeared during materialization',
      );
    }
    const second = normalizePluginPackageResourceGeneration(secondValue);
    if (second.generationDigest !== generation.generationDigest) {
      throw new PluginPackageResourceMaterializationConflictError(
        'active generation changed during materialization',
      );
    }
    return revision;
  } catch (error) {
    if (
      error instanceof InvalidPluginPackageResourceMaterializationError ||
      error instanceof PluginPackageResourceMaterializationConflictError
    ) {
      throw error;
    }
    throw new PluginPackageResourceMaterializationUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  }
}

export function pluginPackageTaskDefinitionDrafts(
  revisionValue: PluginPackageMaterializedRevision,
  taskSpecSemanticRegistry: TaskSpecSemanticRegistry,
): readonly Readonly<PluginPackageTaskDefinitionDraft>[] {
  const revision = normalizePluginPackageMaterializedRevision(
    revisionValue,
    taskSpecSemanticRegistry,
  );
  return Object.freeze(
    revision.resources
      .filter(
        (
          resource,
        ): resource is Readonly<PluginPackageMaterializedResource> & {
          readonly kind: 'task';
          readonly value: Readonly<PluginPackageTaskResource>;
        } => resource.kind === 'task',
      )
      .map((resource) => {
        const task = resource.value;
        return Object.freeze({
          projectId: revision.generation.projectId,
          taskId: taskIdentity(revision.generation.packageName, task.id),
          name: task.name,
          ...(task.description === undefined
            ? {}
            : { description: task.description }),
          kind: task.kind,
          spec: task.spec,
          labels: task.labels,
          enabled: task.enabled,
        });
      }),
  );
}

export function pluginPackageToolDefinitions(
  revisionValue: PluginPackageMaterializedRevision,
  taskSpecSemanticRegistry: TaskSpecSemanticRegistry,
): readonly Readonly<ToolDefinition>[] {
  const revision = normalizePluginPackageMaterializedRevision(
    revisionValue,
    taskSpecSemanticRegistry,
  );
  return Object.freeze(
    revision.resources
      .filter((resource) => resource.kind === 'tool')
      .map(
        (resource) =>
          (resource.value as Readonly<PluginPackageToolResource>).definition,
      ),
  );
}
