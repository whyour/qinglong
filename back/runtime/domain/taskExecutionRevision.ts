import type {
  ExecutionCommand,
  ExecutionResourcePolicy,
  ExecutionSpec,
  ExecutorType,
} from './execution';
import { EXECUTOR_TYPES } from './execution';
import { cloneExecutionSpec } from './executionSpec';
import type { RunDispatchCandidate } from './runDispatchCandidate';

export interface TaskExecutionSpecTemplate {
  command: ExecutionCommand;
  workingDirectory?: string;
  environmentPolicy: ExecutionSpec['environmentPolicy'];
  timeoutMs?: number;
  terminationGraceMs: number;
  resourcePolicy?: ExecutionResourcePolicy;
}

export interface PinnedTaskExecutionRevision {
  projectId: string;
  taskId: string;
  taskRevision: string;
  executorType: ExecutorType;
  execution: TaskExecutionSpecTemplate;
  /** Opaque immutable recipe for Secret, output and callback capabilities. */
  contextRef: string;
}

function assertIdentifier(name: string, value: string, maximum: number): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
}

function templateSpec(
  revision: PinnedTaskExecutionRevision,
  identity: Pick<
    ExecutionSpec,
    'runId' | 'attemptId' | 'projectId' | 'taskId' | 'taskRevision'
  >,
): ExecutionSpec {
  const execution = revision.execution;
  return {
    runId: identity.runId,
    attemptId: identity.attemptId,
    projectId: identity.projectId,
    taskId: identity.taskId,
    taskRevision: identity.taskRevision,
    command: execution.command,
    ...(execution.workingDirectory === undefined
      ? {}
      : { workingDirectory: execution.workingDirectory }),
    environmentPolicy: execution.environmentPolicy,
    ...(execution.timeoutMs === undefined
      ? {}
      : { timeoutMs: execution.timeoutMs }),
    terminationGraceMs: execution.terminationGraceMs,
    ...(execution.resourcePolicy === undefined
      ? {}
      : { resourcePolicy: execution.resourcePolicy }),
  };
}

export function assertPinnedTaskExecutionRevision(
  revision: PinnedTaskExecutionRevision,
): void {
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) {
    throw new TypeError('Pinned Task execution revision must be an object');
  }
  assertIdentifier('projectId', revision.projectId, 128);
  assertIdentifier('taskId', revision.taskId, 255);
  assertIdentifier('taskRevision', revision.taskRevision, 128);
  assertIdentifier('contextRef', revision.contextRef, 512);
  if (!EXECUTOR_TYPES.includes(revision.executorType)) {
    throw new TypeError('Pinned Task executorType is invalid');
  }
  cloneExecutionSpec(
    templateSpec(revision, {
      runId: 'revision-validation-run',
      attemptId: 'revision-validation-attempt',
      projectId: revision.projectId,
      taskId: revision.taskId,
      taskRevision: revision.taskRevision,
    }),
  );
}

export function executionSpecFromPinnedTaskRevision(
  candidate: RunDispatchCandidate,
  revision: PinnedTaskExecutionRevision,
): ExecutionSpec {
  assertPinnedTaskExecutionRevision(revision);
  if (
    revision.projectId !== candidate.projectId ||
    revision.taskId !== candidate.taskId ||
    revision.taskRevision !== candidate.taskRevision ||
    revision.executorType !== candidate.executorType
  ) {
    throw new TypeError(
      'Pinned Task execution revision does not match its dispatch candidate',
    );
  }
  return cloneExecutionSpec(
    templateSpec(revision, {
      runId: candidate.runId,
      attemptId: candidate.attemptId,
      projectId: candidate.projectId,
      taskId: candidate.taskId,
      taskRevision: candidate.taskRevision,
    }),
  );
}
