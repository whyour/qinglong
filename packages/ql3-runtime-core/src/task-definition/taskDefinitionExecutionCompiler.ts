import {
  createLocalExecutionContextRecipe,
  createLocalTaskExecutionRevision,
  type LocalDispatchCommand,
  type LocalExecutionContextRecipe,
  type LocalExecutionEnvironmentBinding,
  type LocalTaskExecutionRevision,
} from '../local-runtime/localDispatch';
import {
  normalizeTaskDefinitionRecord,
  type TaskDefinitionRecord,
} from './taskDefinition';
import {
  BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
  InvalidTaskSpecSemanticError,
  TaskSpecSemanticRegistry,
  UnsupportedTaskSpecError,
} from './taskSpecSemantic';
import type { RemoteWorkerPlacementSpec } from '../remote-execution/remoteWorkerPlacement';

export const TASK_DEFINITION_REVISION_REF_PREFIX = 'qltd:v1:';

const TASK_DEFINITION_REVISION_REF_PATTERN =
  /^qltd:v1:([1-9][0-9]{0,9}):([a-f0-9]{64})$/;

export interface TaskDefinitionRevisionRef {
  readonly revision: number;
  readonly contentDigest: string;
}

export interface CommandTaskExecutionPlan {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: string;
  readonly sourceRevision: number;
  readonly sourceContentDigest: string;
  readonly command: LocalDispatchCommand;
  readonly environment: readonly LocalExecutionEnvironmentBinding[];
  readonly workingDirectory?: string;
  readonly timeoutMs?: number;
  readonly placement?: RemoteWorkerPlacementSpec;
  readonly createdAtMs: number;
}

export interface LocalCommandTaskExecutionPlan {
  readonly source: CommandTaskExecutionPlan;
  readonly contextRecipe: LocalExecutionContextRecipe;
  readonly executionRevision: LocalTaskExecutionRevision;
}

export class UnsupportedTaskDefinitionCompilationError extends Error {
  readonly code = 'TASK_DEFINITION_COMPILATION_UNSUPPORTED';

  constructor() {
    super('TaskDefinition cannot be compiled by this execution compiler');
    this.name = 'UnsupportedTaskDefinitionCompilationError';
  }
}

export class InvalidTaskDefinitionCompilationError extends TypeError {
  readonly code = 'TASK_DEFINITION_COMPILATION_INVALID';

  constructor(message: string) {
    super(`TaskDefinition compilation is invalid: ${message}`);
    this.name = 'InvalidTaskDefinitionCompilationError';
  }
}

export function createTaskDefinitionRevisionRef(
  value: TaskDefinitionRevisionRef,
): string {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'contentDigest,revision' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    value.revision > 2_147_483_647 ||
    typeof value.contentDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.contentDigest)
  ) {
    throw new InvalidTaskDefinitionCompilationError(
      'source revision identity is invalid',
    );
  }
  return `${TASK_DEFINITION_REVISION_REF_PREFIX}${value.revision}:${value.contentDigest}`;
}

export function parseTaskDefinitionRevisionRef(
  value: unknown,
): TaskDefinitionRevisionRef {
  if (typeof value !== 'string') {
    throw new InvalidTaskDefinitionCompilationError(
      'source revision reference is invalid',
    );
  }
  const match = TASK_DEFINITION_REVISION_REF_PATTERN.exec(value);
  const revision = match ? Number(match[1]) : Number.NaN;
  const contentDigest = match?.[2];
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision > 2_147_483_647 ||
    !contentDigest ||
    createTaskDefinitionRevisionRef({ revision, contentDigest }) !== value
  ) {
    throw new InvalidTaskDefinitionCompilationError(
      'source revision reference is invalid',
    );
  }
  return Object.freeze({ revision, contentDigest });
}

function canonicalRecord(definition: TaskDefinitionRecord): TaskDefinitionRecord {
  try {
    return normalizeTaskDefinitionRecord(definition);
  } catch {
    throw new InvalidTaskDefinitionCompilationError(
      'source record is invalid',
    );
  }
}

export function compileCommandTaskDefinition(
  definition: TaskDefinitionRecord,
  semanticRegistry: TaskSpecSemanticRegistry,
): CommandTaskExecutionPlan {
  if (!(semanticRegistry instanceof TaskSpecSemanticRegistry)) {
    throw new InvalidTaskDefinitionCompilationError(
      'semantic registry is invalid',
    );
  }
  const source = canonicalRecord(definition);
  if (
    source.kind !== 'command' ||
    source.spec.schema !== BUILT_IN_COMMAND_TASK_SPEC_SCHEMA
  ) {
    throw new UnsupportedTaskDefinitionCompilationError();
  }
  if (!source.enabled) {
    throw new InvalidTaskDefinitionCompilationError('source is disabled');
  }

  let semanticSpec;
  try {
    semanticSpec = semanticRegistry.normalize({
      projectId: source.projectId,
      taskId: source.taskId,
      kind: source.kind,
      spec: source.spec,
    });
  } catch (error) {
    if (error instanceof UnsupportedTaskSpecError) {
      throw new UnsupportedTaskDefinitionCompilationError();
    }
    if (error instanceof InvalidTaskSpecSemanticError) {
      throw new InvalidTaskDefinitionCompilationError(
        'source spec semantics are invalid',
      );
    }
    throw new InvalidTaskDefinitionCompilationError(
      'semantic validation failed',
    );
  }
  if (JSON.stringify(semanticSpec) !== JSON.stringify(source.spec)) {
    throw new InvalidTaskDefinitionCompilationError(
      'source spec is not semantically canonical',
    );
  }

  const config = semanticSpec.config as unknown as Readonly<{
    command: LocalDispatchCommand;
    environment: readonly LocalExecutionEnvironmentBinding[];
    workingDirectory?: string;
    timeoutMs?: number;
    placement?: RemoteWorkerPlacementSpec;
  }>;
  const taskRevision = createTaskDefinitionRevisionRef({
    revision: source.revision,
    contentDigest: source.contentDigest,
  });
  return Object.freeze({
    projectId: source.projectId,
    taskId: source.taskId,
    taskRevision,
    sourceRevision: source.revision,
    sourceContentDigest: source.contentDigest,
    command: config.command,
    environment: config.environment,
    ...(config.workingDirectory === undefined
      ? {}
      : { workingDirectory: config.workingDirectory }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.placement === undefined ? {} : { placement: config.placement }),
    createdAtMs: source.updatedAtMs,
  });
}

export function compileLocalCommandTaskDefinition(
  definition: TaskDefinitionRecord,
  semanticRegistry: TaskSpecSemanticRegistry,
): LocalCommandTaskExecutionPlan {
  const source = compileCommandTaskDefinition(definition, semanticRegistry);
  const contextRecipe = createLocalExecutionContextRecipe({
    environment: source.environment,
    createdAtMs: source.createdAtMs,
  });
  const executionRevision = createLocalTaskExecutionRevision({
    projectId: source.projectId,
    taskId: source.taskId,
    taskRevision: source.taskRevision,
    executorType: 'local_process',
    command: source.command,
    ...(source.workingDirectory === undefined
      ? {}
      : { workingDirectory: source.workingDirectory }),
    ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
    contextRef: contextRecipe.contextRef,
    createdAtMs: source.createdAtMs,
  });
  return Object.freeze({ source, contextRecipe, executionRevision });
}
