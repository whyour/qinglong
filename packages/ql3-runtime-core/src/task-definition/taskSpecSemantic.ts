import {
  TASK_DEFINITION_KINDS,
  assertTaskDefinitionIdentifier,
  normalizeTaskDefinitionSpec,
  type TaskDefinitionJson,
  type TaskDefinitionKind,
  type TaskDefinitionSpec,
} from './taskDefinition';
import { parseSecretRef } from '../secret/secretReference';
import { normalizeRemoteWorkerPlacement } from '../remote-execution/remoteWorkerPlacement';

export const MAX_TASK_SPEC_SEMANTIC_SCHEMAS = 32;
export const BUILT_IN_COMMAND_TASK_SPEC_SCHEMA = 'qinglong/command@v1';
export const MAX_COMMAND_TASK_ENVIRONMENT_ENTRIES = 256;
export const MAX_COMMAND_TASK_ENVIRONMENT_BYTES = 64 * 1024;
export const MAX_COMMAND_TASK_TIMEOUT_MS = 365 * 24 * 60 * 60_000;

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface TaskSpecSemanticContext {
  readonly projectId: string;
  readonly taskId: string;
  readonly kind: TaskDefinitionKind;
  readonly spec: TaskDefinitionSpec;
}

export interface TaskSpecSemanticDescriptor {
  readonly schema: string;
  readonly kind: TaskDefinitionKind;
  normalizeConfig(
    config: Readonly<Record<string, TaskDefinitionJson>>,
    context: Readonly<Omit<TaskSpecSemanticContext, 'spec'>>,
  ): Readonly<Record<string, TaskDefinitionJson>>;
}

export interface TaskSpecSemanticMetadata {
  readonly schema: string;
  readonly kind: TaskDefinitionKind;
}

export class UnsupportedTaskSpecError extends Error {
  readonly code = 'TASK_SPEC_UNSUPPORTED';

  constructor() {
    super('TaskDefinition spec schema is unsupported');
    this.name = 'UnsupportedTaskSpecError';
  }
}

export class InvalidTaskSpecSemanticError extends TypeError {
  readonly code = 'TASK_SPEC_SEMANTIC_INVALID';

  constructor(message: string) {
    super(`TaskDefinition spec semantics are invalid: ${message}`);
    this.name = 'InvalidTaskSpecSemanticError';
  }
}

function exactKeys<T>(
  value: T,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is T & Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskSpecSemanticError(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new InvalidTaskSpecSemanticError(`${label} shape is invalid`);
  }
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
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new InvalidTaskSpecSemanticError(`${label} is invalid`);
  }
  return value;
}

function normalizeCommand(value: unknown): TaskDefinitionJson {
  exactKeys(value, ['kind'], ['args', 'command', 'file', 'shell'], 'command');
  if (value.kind === 'argv') {
    exactKeys(value, ['args', 'file', 'kind'], [], 'argv command');
    const file = boundedText(value.file, 'command file', 4096);
    if (!file.startsWith('/')) {
      throw new InvalidTaskSpecSemanticError(
        'command file must be an absolute path',
      );
    }
    if (!Array.isArray(value.args) || value.args.length > 256) {
      throw new InvalidTaskSpecSemanticError('command arguments are invalid');
    }
    let bytes = Buffer.byteLength(file, 'utf8');
    const args = value.args.map((argument) => {
      const normalized = boundedText(
        argument,
        'command argument',
        16 * 1024,
        true,
      );
      bytes += Buffer.byteLength(normalized, 'utf8');
      return normalized;
    });
    if (bytes > 64 * 1024) {
      throw new InvalidTaskSpecSemanticError('command byte budget exceeded');
    }
    return Object.freeze({
      kind: 'argv',
      file,
      args: Object.freeze(args),
    });
  }
  if (value.kind === 'shell') {
    exactKeys(value, ['command', 'kind'], ['shell'], 'shell command');
    const command = boundedText(value.command, 'shell command', 64 * 1024);
    const shell = value.shell ?? '/bin/sh';
    if (shell !== '/bin/sh' && shell !== '/bin/bash') {
      throw new InvalidTaskSpecSemanticError('shell is not allowlisted');
    }
    return Object.freeze({ kind: 'shell', command, shell });
  }
  throw new InvalidTaskSpecSemanticError('command kind is invalid');
}

function normalizeEnvironment(
  value: unknown,
  projectId: string,
): readonly TaskDefinitionJson[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_COMMAND_TASK_ENVIRONMENT_ENTRIES
  ) {
    throw new InvalidTaskSpecSemanticError('environment is invalid');
  }
  const names = new Set<string>();
  let bytes = 0;
  const environment = value.map((entry) => {
    exactKeys(entry, ['kind', 'name'], ['secretRef', 'value'], 'environment');
    const name = boundedText(entry.name, 'environment name', 128);
    if (
      !ENVIRONMENT_NAME_PATTERN.test(name) ||
      name.startsWith('QL3_') ||
      names.has(name)
    ) {
      throw new InvalidTaskSpecSemanticError(
        'environment name is invalid or duplicated',
      );
    }
    names.add(name);
    bytes += Buffer.byteLength(name, 'utf8');
    if (entry.kind === 'public') {
      exactKeys(entry, ['kind', 'name', 'value'], [], 'public environment');
      const publicValue = boundedText(
        entry.value,
        'environment value',
        16 * 1024,
        true,
      );
      bytes += Buffer.byteLength(publicValue, 'utf8');
      return Object.freeze({ name, kind: 'public', value: publicValue });
    }
    if (entry.kind === 'secret') {
      exactKeys(entry, ['kind', 'name', 'secretRef'], [], 'secret environment');
      const secretRef = boundedText(entry.secretRef, 'secretRef', 512);
      let reference;
      try {
        reference = parseSecretRef(secretRef);
      } catch {
        throw new InvalidTaskSpecSemanticError('secretRef is invalid');
      }
      if (reference.projectId !== projectId) {
        throw new InvalidTaskSpecSemanticError(
          'secretRef belongs to another Project',
        );
      }
      bytes += Buffer.byteLength(secretRef, 'utf8');
      return Object.freeze({ name, kind: 'secret', secretRef });
    }
    throw new InvalidTaskSpecSemanticError(
      'environment binding kind is invalid',
    );
  });
  if (bytes > MAX_COMMAND_TASK_ENVIRONMENT_BYTES) {
    throw new InvalidTaskSpecSemanticError(
      'environment byte budget exceeded',
    );
  }
  environment.sort((left, right) =>
    (left as { name: string }).name.localeCompare(
      (right as { name: string }).name,
    ),
  );
  return Object.freeze(environment);
}

function normalizeCommandConfig(
  config: Readonly<Record<string, TaskDefinitionJson>>,
  context: Readonly<Omit<TaskSpecSemanticContext, 'spec'>>,
): Readonly<Record<string, TaskDefinitionJson>> {
  exactKeys(
    config,
    ['command'],
    ['environment', 'placement', 'timeoutMs', 'workingDirectory'],
    'command config',
  );
  const command = normalizeCommand(config.command);
  const environment = normalizeEnvironment(config.environment ?? [], context.projectId);
  const placement = config.placement === undefined
    ? undefined
    : normalizeRemoteWorkerPlacement(config.placement);
  let workingDirectory: string | undefined;
  if (config.workingDirectory !== undefined) {
    workingDirectory = boundedText(
      config.workingDirectory,
      'workingDirectory',
      4096,
    );
    if (!workingDirectory.startsWith('/')) {
      throw new InvalidTaskSpecSemanticError(
        'workingDirectory must be an absolute path',
      );
    }
  }
  let timeoutMs: number | undefined;
  if (config.timeoutMs !== undefined) {
    if (
      !Number.isSafeInteger(config.timeoutMs) ||
      (config.timeoutMs as number) < 1 ||
      (config.timeoutMs as number) > MAX_COMMAND_TASK_TIMEOUT_MS
    ) {
      throw new InvalidTaskSpecSemanticError('timeoutMs is invalid');
    }
    timeoutMs = config.timeoutMs as number;
  }
  return Object.freeze({
    command,
    environment,
    ...(placement === undefined
      ? {}
      : { placement: placement as unknown as TaskDefinitionJson }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

const BUILT_IN_DESCRIPTORS: readonly TaskSpecSemanticDescriptor[] =
  Object.freeze([
    Object.freeze({
      schema: BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
      kind: 'command' as const,
      normalizeConfig: normalizeCommandConfig,
    }),
  ]);

export class TaskSpecSemanticRegistry {
  readonly #descriptors: ReadonlyMap<
    string,
    TaskSpecSemanticDescriptor
  >;
  readonly #metadata: readonly TaskSpecSemanticMetadata[];

  constructor(descriptors: readonly TaskSpecSemanticDescriptor[]) {
    if (
      !Array.isArray(descriptors) ||
      descriptors.length < 1 ||
      descriptors.length > MAX_TASK_SPEC_SEMANTIC_SCHEMAS
    ) {
      throw new InvalidTaskSpecSemanticError(
        'registry descriptor count is invalid',
      );
    }
    const bySchema = new Map<string, TaskSpecSemanticDescriptor>();
    for (const descriptor of descriptors) {
      exactKeys(
        descriptor,
        ['kind', 'normalizeConfig', 'schema'],
        [],
        'registry descriptor',
      );
      const schema = normalizeTaskDefinitionSpec({
        schema: descriptor.schema,
        config: {},
      }).schema;
      if (
        !TASK_DEFINITION_KINDS.includes(descriptor.kind) ||
        typeof descriptor.normalizeConfig !== 'function' ||
        bySchema.has(schema)
      ) {
        throw new InvalidTaskSpecSemanticError(
          'registry descriptor is invalid or duplicated',
        );
      }
      bySchema.set(
        schema,
        Object.freeze({
          schema,
          kind: descriptor.kind,
          normalizeConfig: descriptor.normalizeConfig,
        }),
      );
    }
    this.#descriptors = bySchema;
    this.#metadata = Object.freeze(
      [...bySchema.values()]
        .map(({ schema, kind }) => Object.freeze({ schema, kind }))
        .sort((left, right) => left.schema.localeCompare(right.schema)),
    );
    Object.freeze(this);
  }

  list(): readonly TaskSpecSemanticMetadata[] {
    return this.#metadata;
  }

  supports(kind: TaskDefinitionKind, schema: string): boolean {
    return this.#descriptors.get(schema)?.kind === kind;
  }

  normalize(context: TaskSpecSemanticContext): TaskDefinitionSpec {
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      throw new InvalidTaskSpecSemanticError('context is invalid');
    }
    exactKeys(
      context,
      ['kind', 'projectId', 'spec', 'taskId'],
      [],
      'semantic context',
    );
    assertTaskDefinitionIdentifier(context.projectId, 'projectId');
    assertTaskDefinitionIdentifier(context.taskId, 'taskId');
    if (!TASK_DEFINITION_KINDS.includes(context.kind)) {
      throw new InvalidTaskSpecSemanticError('TaskDefinition kind is invalid');
    }
    const spec = normalizeTaskDefinitionSpec(context.spec);
    const descriptor = this.#descriptors.get(spec.schema);
    if (!descriptor) throw new UnsupportedTaskSpecError();
    if (descriptor.kind !== context.kind) {
      throw new InvalidTaskSpecSemanticError(
        'schema does not match TaskDefinition kind',
      );
    }
    let config: Readonly<Record<string, TaskDefinitionJson>>;
    try {
      config = descriptor.normalizeConfig(
        spec.config,
        Object.freeze({
          projectId: context.projectId,
          taskId: context.taskId,
          kind: context.kind,
        }),
      );
      return normalizeTaskDefinitionSpec({ schema: spec.schema, config });
    } catch (error) {
      if (error instanceof InvalidTaskSpecSemanticError) throw error;
      throw new InvalidTaskSpecSemanticError('validator rejected the config');
    }
  }
}

export function createBuiltInTaskSpecSemanticRegistry(): TaskSpecSemanticRegistry {
  return new TaskSpecSemanticRegistry(BUILT_IN_DESCRIPTORS);
}

export function createTaskSpecSemanticRegistry(
  extensions: readonly TaskSpecSemanticDescriptor[] = [],
): TaskSpecSemanticRegistry {
  if (
    !Array.isArray(extensions) ||
    extensions.some(
      (descriptor) =>
        !descriptor ||
        typeof descriptor !== 'object' ||
        typeof descriptor.schema !== 'string' ||
        descriptor.schema.startsWith('qinglong/'),
    )
  ) {
    throw new InvalidTaskSpecSemanticError(
      'extension descriptor uses the reserved qinglong namespace',
    );
  }
  return new TaskSpecSemanticRegistry([
    ...BUILT_IN_DESCRIPTORS,
    ...extensions,
  ]);
}
