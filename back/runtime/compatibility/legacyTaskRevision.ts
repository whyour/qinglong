import { createHash } from 'crypto';

export interface LegacyTaskRevisionInput {
  command: string;
  schedule?: string;
  extraSchedules?: readonly string[];
  taskBefore?: string;
  taskAfter?: string;
  workDirectory?: string;
  logName?: string;
  environmentRevision?: string;
  sourceRevision?: string;
}

export function createLegacyLogArtifactId(logPath: string): string {
  return `legacy-log:${createHash('sha256')
    .update(logPath)
    .digest('hex')
    .slice(0, 25)}`;
}

export function createLegacyTaskRevision(
  input: LegacyTaskRevisionInput,
): string {
  const snapshot = {
    schema: 1,
    command: input.command,
    ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
    ...(input.extraSchedules === undefined
      ? {}
      : { extraSchedules: [...input.extraSchedules] }),
    ...(input.taskBefore === undefined ? {} : { taskBefore: input.taskBefore }),
    ...(input.taskAfter === undefined ? {} : { taskAfter: input.taskAfter }),
    ...(input.workDirectory === undefined
      ? {}
      : { workDirectory: input.workDirectory }),
    ...(input.logName === undefined ? {} : { logName: input.logName }),
    ...(input.environmentRevision === undefined
      ? {}
      : { environmentRevision: input.environmentRevision }),
    ...(input.sourceRevision === undefined
      ? {}
      : { sourceRevision: input.sourceRevision }),
  };
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(snapshot))
    .digest('hex')}`;
}
