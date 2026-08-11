import { createHash } from 'crypto';
import type {
  ExecutionCommand,
  ExecutionResourcePolicy,
  ExecutionSpec,
} from './execution';
import { cloneExecutionSpec } from './executionSpec';
import {
  assertPinnedTaskExecutionRevision,
  type PinnedTaskExecutionRevision,
  type TaskExecutionSpecTemplate,
} from './taskExecutionRevision';

export interface PinnedTaskExecutionRevisionRecord
  extends PinnedTaskExecutionRevision {
  contentDigest: string;
  createdAtMs: number;
}

export class TaskExecutionRevisionCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskExecutionRevisionCorruptError';
  }
}

function frozenCommand(command: ExecutionCommand): ExecutionCommand {
  return command.kind === 'argv'
    ? Object.freeze({
        kind: 'argv' as const,
        file: command.file,
        args: Object.freeze([...command.args]),
      })
    : Object.freeze({
        kind: 'shell' as const,
        command: command.command,
        ...(command.shell === undefined ? {} : { shell: command.shell }),
      });
}

function frozenResourcePolicy(
  policy: ExecutionResourcePolicy | undefined,
): ExecutionResourcePolicy | undefined {
  if (policy === undefined) return undefined;
  return Object.freeze({
    ...(policy.memoryBytes === undefined
      ? {}
      : { memoryBytes: Object.freeze({ ...policy.memoryBytes }) }),
    ...(policy.cpuMillisPerSecond === undefined
      ? {}
      : {
          cpuMillisPerSecond: Object.freeze({
            ...policy.cpuMillisPerSecond,
          }),
        }),
    ...(policy.filesystemIsolation === undefined
      ? {}
      : { filesystemIsolation: policy.filesystemIsolation }),
    ...(policy.networkIsolation === undefined
      ? {}
      : { networkIsolation: policy.networkIsolation }),
  });
}

function normalizedTemplate(
  revision: PinnedTaskExecutionRevision,
): TaskExecutionSpecTemplate {
  const spec: ExecutionSpec = cloneExecutionSpec({
    runId: 'task-revision-normalization-run',
    attemptId: 'task-revision-normalization-attempt',
    projectId: revision.projectId,
    taskId: revision.taskId,
    taskRevision: revision.taskRevision,
    command: revision.execution.command,
    ...(revision.execution.workingDirectory === undefined
      ? {}
      : { workingDirectory: revision.execution.workingDirectory }),
    environmentPolicy: revision.execution.environmentPolicy,
    ...(revision.execution.timeoutMs === undefined
      ? {}
      : { timeoutMs: revision.execution.timeoutMs }),
    terminationGraceMs: revision.execution.terminationGraceMs,
    ...(revision.execution.resourcePolicy === undefined
      ? {}
      : { resourcePolicy: revision.execution.resourcePolicy }),
  });
  const resourcePolicy = frozenResourcePolicy(spec.resourcePolicy);
  return Object.freeze({
    command: frozenCommand(spec.command),
    ...(spec.workingDirectory === undefined
      ? {}
      : { workingDirectory: spec.workingDirectory }),
    environmentPolicy: spec.environmentPolicy,
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    terminationGraceMs: spec.terminationGraceMs,
    ...(resourcePolicy === undefined ? {} : { resourcePolicy }),
  });
}

/** Removes unknown fields, deep-clones mutable values and freezes the result. */
export function normalizePinnedTaskExecutionRevision(
  revision: PinnedTaskExecutionRevision,
): PinnedTaskExecutionRevision {
  assertPinnedTaskExecutionRevision(revision);
  return Object.freeze({
    projectId: revision.projectId,
    taskId: revision.taskId,
    taskRevision: revision.taskRevision,
    executorType: revision.executorType,
    execution: normalizedTemplate(revision),
    contextRef: revision.contextRef,
  });
}

export function taskExecutionRevisionDigest(
  revision: PinnedTaskExecutionRevision,
): string {
  const normalized = normalizePinnedTaskExecutionRevision(revision);
  return createHash('sha256')
    .update(JSON.stringify(normalized), 'utf8')
    .digest('hex');
}

export function createPinnedTaskExecutionRevisionRecord(
  revision: PinnedTaskExecutionRevision,
  createdAtMs: number,
): PinnedTaskExecutionRevisionRecord {
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new RangeError('createdAtMs must be a non-negative safe integer');
  }
  const normalized = normalizePinnedTaskExecutionRevision(revision);
  return Object.freeze({
    ...normalized,
    contentDigest: taskExecutionRevisionDigest(normalized),
    createdAtMs,
  });
}
