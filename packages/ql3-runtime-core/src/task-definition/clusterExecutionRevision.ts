import { createHash } from 'node:crypto';
import {
  createLocalExecutionContextRecipe,
  normalizeLocalDispatchCommand,
  type LocalDispatchCommand,
  type LocalExecutionEnvironmentBinding,
} from '../local-runtime/localDispatch';
import { parseSecretRef } from '../secret/secretReference';
import {
  compileCommandTaskDefinition,
  createTaskDefinitionRevisionRef,
  type CommandTaskExecutionPlan,
} from './taskDefinitionExecutionCompiler';
import type { TaskDefinitionRecord } from './taskDefinition';
import type { TaskSpecSemanticRegistry } from './taskSpecSemantic';
import {
  effectiveRemoteWorkerPlacement,
  type RemoteWorkerPlacementSpec,
} from '../remote-execution/remoteWorkerPlacement';

export const CLUSTER_EXECUTOR_TYPE = 'remote_worker';
export const CLUSTER_EXECUTION_PLAN_SCHEMA = 'qinglong/command-execution@v1';
export const MAX_CLUSTER_EXECUTION_PLAN_BYTES = 96 * 1024;

export interface ClusterTaskExecutionRevisionContent {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: string;
  readonly sourceRevision: number;
  readonly sourceContentDigest: string;
  readonly executorType: typeof CLUSTER_EXECUTOR_TYPE;
  readonly planSchema: typeof CLUSTER_EXECUTION_PLAN_SCHEMA;
  readonly command: LocalDispatchCommand;
  readonly environment: readonly LocalExecutionEnvironmentBinding[];
  readonly environmentBundleRef?: string;
  readonly workingDirectory?: string;
  readonly timeoutMs?: number;
  readonly placement?: RemoteWorkerPlacementSpec;
  readonly createdAtMs: number;
}

export interface ClusterTaskExecutionRevision
  extends ClusterTaskExecutionRevisionContent {
  readonly contentDigest: string;
}

export interface ClusterTaskExecutionRevisionSource {
  resolveClusterTaskExecutionRevision(identity: {
    readonly projectId: string;
    readonly taskId: string;
    readonly sourceRevision: number;
  }): Promise<ClusterTaskExecutionRevision | null>;
}

export class InvalidClusterExecutionRevisionError extends TypeError {
  readonly code = 'CLUSTER_EXECUTION_REVISION_INVALID';

  constructor(message: string) {
    super(`Cluster execution revision is invalid: ${message}`);
    this.name = 'InvalidClusterExecutionRevisionError';
  }
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    /[\u0001-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, 'utf8') > 128
  ) {
    throw new InvalidClusterExecutionRevisionError(`${label} is invalid`);
  }
  return value;
}

function revision(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 2_147_483_647
  ) {
    throw new InvalidClusterExecutionRevisionError('sourceRevision is invalid');
  }
  return value as number;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidClusterExecutionRevisionError('createdAtMs is invalid');
  }
  return value as number;
}

function normalizeContent(
  value: ClusterTaskExecutionRevisionContent,
): ClusterTaskExecutionRevisionContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidClusterExecutionRevisionError('shape is invalid');
  }
  const allowed = new Set([
    'command',
    'createdAtMs',
    'environment',
    'environmentBundleRef',
    'executorType',
    'planSchema',
    'placement',
    'projectId',
    'sourceContentDigest',
    'sourceRevision',
    'taskId',
    'taskRevision',
    'timeoutMs',
    'workingDirectory',
  ]);
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.has(key)) ||
    [
      'command',
      'createdAtMs',
      'environment',
      'executorType',
      'planSchema',
      'projectId',
      'sourceContentDigest',
      'sourceRevision',
      'taskId',
      'taskRevision',
    ].some((key) => !keys.includes(key))
  ) {
    throw new InvalidClusterExecutionRevisionError('shape is invalid');
  }
  const projectId = identifier(value.projectId, 'projectId');
  const taskId = identifier(value.taskId, 'taskId');
  const sourceRevision = revision(value.sourceRevision);
  if (!/^[0-9a-f]{64}$/.test(value.sourceContentDigest)) {
    throw new InvalidClusterExecutionRevisionError(
      'sourceContentDigest is invalid',
    );
  }
  const taskRevision = createTaskDefinitionRevisionRef({
    revision: sourceRevision,
    contentDigest: value.sourceContentDigest,
  });
  if (
    value.taskRevision !== taskRevision ||
    value.executorType !== CLUSTER_EXECUTOR_TYPE ||
    value.planSchema !== CLUSTER_EXECUTION_PLAN_SCHEMA
  ) {
    throw new InvalidClusterExecutionRevisionError(
      'source or executor fence is invalid',
    );
  }
  let command: LocalDispatchCommand;
  let environment: readonly LocalExecutionEnvironmentBinding[];
  let environmentBundleRef: string | undefined;
  try {
    command = normalizeLocalDispatchCommand(value.command);
    environment = createLocalExecutionContextRecipe({
      environment: value.environment,
      createdAtMs: value.createdAtMs,
    }).environment;
    for (const binding of environment) {
      if (
        binding.kind === 'secret' &&
        parseSecretRef(binding.secretRef).projectId !== projectId
      ) {
        throw new Error('cross-project Secret reference');
      }
    }
    if (value.environmentBundleRef !== undefined) {
      const reference = parseSecretRef(value.environmentBundleRef);
      if (
        reference.projectId !== projectId ||
        reference.version === undefined
      ) {
        throw new Error('invalid environment bundle Secret reference');
      }
      environmentBundleRef = value.environmentBundleRef;
    }
  } catch {
    throw new InvalidClusterExecutionRevisionError(
      'command or environment is invalid',
    );
  }
  let workingDirectory: string | undefined;
  if (value.workingDirectory !== undefined) {
    if (
      typeof value.workingDirectory !== 'string' ||
      !value.workingDirectory.startsWith('/') ||
      value.workingDirectory.includes('\0') ||
      Buffer.byteLength(value.workingDirectory, 'utf8') > 4096
    ) {
      throw new InvalidClusterExecutionRevisionError(
        'workingDirectory is invalid',
      );
    }
    workingDirectory = value.workingDirectory;
  }
  let timeoutMs: number | undefined;
  if (value.timeoutMs !== undefined) {
    if (
      !Number.isSafeInteger(value.timeoutMs) ||
      value.timeoutMs < 1 ||
      value.timeoutMs > 365 * 24 * 60 * 60_000
    ) {
      throw new InvalidClusterExecutionRevisionError('timeoutMs is invalid');
    }
    timeoutMs = value.timeoutMs;
  }
  const createdAtMs = timestamp(value.createdAtMs);
  const placement =
    value.placement === undefined
      ? undefined
      : effectiveRemoteWorkerPlacement(value.placement);
  const normalized = Object.freeze({
    projectId,
    taskId,
    taskRevision,
    sourceRevision,
    sourceContentDigest: value.sourceContentDigest,
    executorType: CLUSTER_EXECUTOR_TYPE,
    planSchema: CLUSTER_EXECUTION_PLAN_SCHEMA,
    command,
    environment,
    ...(environmentBundleRef === undefined ? {} : { environmentBundleRef }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(placement === undefined ? {} : { placement }),
    createdAtMs,
  });
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
    MAX_CLUSTER_EXECUTION_PLAN_BYTES
  ) {
    throw new InvalidClusterExecutionRevisionError('plan byte budget exceeded');
  }
  return normalized;
}

function digest(content: ClusterTaskExecutionRevisionContent): string {
  const { createdAtMs: _createdAtMs, ...immutable } = content;
  return createHash('sha256')
    .update('qinglong.cluster-task-execution-revision.v1\0', 'utf8')
    .update(JSON.stringify(immutable), 'utf8')
    .digest('hex');
}

export function createClusterTaskExecutionRevision(
  value: ClusterTaskExecutionRevisionContent,
): ClusterTaskExecutionRevision {
  const content = normalizeContent(value);
  return Object.freeze({ ...content, contentDigest: digest(content) });
}

export function normalizeClusterTaskExecutionRevision(
  value: ClusterTaskExecutionRevision,
): ClusterTaskExecutionRevision {
  const { contentDigest, ...candidate } = value;
  const content = normalizeContent(candidate);
  const expected = digest(content);
  if (contentDigest !== expected) {
    throw new InvalidClusterExecutionRevisionError(
      'contentDigest does not match content',
    );
  }
  return Object.freeze({ ...content, contentDigest: expected });
}

export function compileClusterCommandTaskDefinition(
  definition: TaskDefinitionRecord,
  semanticRegistry: TaskSpecSemanticRegistry,
): ClusterTaskExecutionRevision {
  const plan: CommandTaskExecutionPlan = compileCommandTaskDefinition(
    definition,
    semanticRegistry,
  );
  return createClusterTaskExecutionRevision({
    projectId: plan.projectId,
    taskId: plan.taskId,
    taskRevision: plan.taskRevision,
    sourceRevision: plan.sourceRevision,
    sourceContentDigest: plan.sourceContentDigest,
    executorType: CLUSTER_EXECUTOR_TYPE,
    planSchema: CLUSTER_EXECUTION_PLAN_SCHEMA,
    command: plan.command,
    environment: plan.environment,
    ...(plan.environmentBundleRef === undefined
      ? {}
      : { environmentBundleRef: plan.environmentBundleRef }),
    ...(plan.workingDirectory === undefined
      ? {}
      : { workingDirectory: plan.workingDirectory }),
    ...(plan.timeoutMs === undefined ? {} : { timeoutMs: plan.timeoutMs }),
    placement: effectiveRemoteWorkerPlacement(plan.placement ?? {}),
    createdAtMs: plan.createdAtMs,
  });
}
