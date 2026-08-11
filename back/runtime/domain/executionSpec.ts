import path from 'path';
import type {
  ExecutionNumericLimit,
  ExecutionResourcePolicy,
  ExecutionSpec,
} from './execution';
import { InvalidExecutionSpecError } from './executorErrors';

export const MAX_EXECUTION_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_TERMINATION_GRACE_MS = 5 * 60 * 1000;
export const MAX_EXECUTION_ARGUMENTS = 4096;
export const MAX_EXECUTION_COMMAND_BYTES = 128 * 1024;

function invalid(message: string): never {
  throw new InvalidExecutionSpecError(message);
}

function assertNonEmptyIdentifier(value: string, name: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid(
      `${name} must be between 1 and 255 characters and contain no control characters`,
    );
  }
}

function assertSafeDuration(
  value: number,
  name: string,
  maximum: number,
  allowZero: boolean,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > maximum
  ) {
    invalid(
      `${name} must be a safe integer between ${
        allowZero ? 0 : 1
      } and ${maximum}`,
    );
  }
}

function assertEnforcement(
  value: unknown,
  name: string,
): asserts value is 'required' | 'best_effort' {
  if (value !== 'required' && value !== 'best_effort') {
    invalid(`${name} enforcement is invalid`);
  }
}

function assertNumericLimit(
  value: ExecutionNumericLimit | undefined,
  name: string,
): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }
  if (!Number.isSafeInteger(value.value) || value.value < 1) {
    invalid(`${name} must be a positive safe integer`);
  }
  assertEnforcement(value.enforcement, name);
}

function assertResourcePolicy(
  policy: ExecutionResourcePolicy | undefined,
): void {
  if (policy === undefined) return;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    invalid('resourcePolicy must be an object');
  }
  assertNumericLimit(policy.memoryBytes, 'memoryBytes');
  assertNumericLimit(policy.cpuMillisPerSecond, 'cpuMillisPerSecond');
  if (policy.filesystemIsolation !== undefined) {
    assertEnforcement(policy.filesystemIsolation, 'filesystemIsolation');
  }
  if (policy.networkIsolation !== undefined) {
    assertEnforcement(policy.networkIsolation, 'networkIsolation');
  }
}

function commandSize(spec: ExecutionSpec): number {
  if (spec.command.kind === 'shell') {
    return Buffer.byteLength(spec.command.command, 'utf8');
  }
  return (
    Buffer.byteLength(spec.command.file, 'utf8') +
    spec.command.args.reduce(
      (total, argument) => total + Buffer.byteLength(argument, 'utf8'),
      0,
    )
  );
}

export function assertExecutionSpec(spec: ExecutionSpec): void {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    invalid('ExecutionSpec must be an object');
  }
  assertNonEmptyIdentifier(spec.runId, 'runId');
  assertNonEmptyIdentifier(spec.attemptId, 'attemptId');
  assertNonEmptyIdentifier(spec.projectId, 'projectId');
  assertNonEmptyIdentifier(spec.taskId, 'taskId');
  assertNonEmptyIdentifier(spec.taskRevision, 'taskRevision');
  assertSafeDuration(
    spec.terminationGraceMs,
    'terminationGraceMs',
    MAX_TERMINATION_GRACE_MS,
    true,
  );
  if (spec.timeoutMs !== undefined) {
    assertSafeDuration(
      spec.timeoutMs,
      'timeoutMs',
      MAX_EXECUTION_TIMEOUT_MS,
      false,
    );
  }
  if (
    spec.environmentPolicy !== 'inherit' &&
    spec.environmentPolicy !== 'isolated'
  ) {
    invalid('environmentPolicy is invalid');
  }
  if (
    spec.workingDirectory !== undefined &&
    (typeof spec.workingDirectory !== 'string' ||
      spec.workingDirectory.includes('\0') ||
      !path.isAbsolute(spec.workingDirectory))
  ) {
    invalid('workingDirectory must be an absolute path containing no NUL');
  }
  if (!spec.command || typeof spec.command !== 'object') {
    invalid('command must be an object');
  }
  if (spec.command.kind === 'argv') {
    if (
      typeof spec.command.file !== 'string' ||
      !spec.command.file ||
      spec.command.file.includes('\0')
    ) {
      invalid('argv command file must be non-empty and contain no NUL');
    }
    if (!Array.isArray(spec.command.args)) {
      invalid('argv command args must be an array');
    }
    if (spec.command.args.length > MAX_EXECUTION_ARGUMENTS) {
      invalid('argv command has too many arguments');
    }
    if (
      spec.command.args.some(
        (argument) => typeof argument !== 'string' || argument.includes('\0'),
      )
    ) {
      invalid('argv command arguments must be strings containing no NUL');
    }
  } else if (spec.command.kind === 'shell') {
    if (
      typeof spec.command.command !== 'string' ||
      !spec.command.command ||
      spec.command.command.includes('\0')
    ) {
      invalid('shell command must be non-empty and contain no NUL');
    }
    if (
      spec.command.shell !== undefined &&
      (typeof spec.command.shell !== 'string' ||
        !path.isAbsolute(spec.command.shell) ||
        spec.command.shell.includes('\0'))
    ) {
      invalid('shell must be an absolute path containing no NUL');
    }
  } else {
    invalid('command kind is invalid');
  }
  if (commandSize(spec) > MAX_EXECUTION_COMMAND_BYTES) {
    invalid('execution command is too large');
  }
  assertResourcePolicy(spec.resourcePolicy);
}

export function cloneExecutionSpec(spec: ExecutionSpec): ExecutionSpec {
  assertExecutionSpec(spec);
  return {
    runId: spec.runId,
    attemptId: spec.attemptId,
    projectId: spec.projectId,
    taskId: spec.taskId,
    taskRevision: spec.taskRevision,
    command:
      spec.command.kind === 'argv'
        ? {
            kind: 'argv',
            file: spec.command.file,
            args: [...spec.command.args],
          }
        : {
            kind: 'shell',
            command: spec.command.command,
            ...(spec.command.shell === undefined
              ? {}
              : { shell: spec.command.shell }),
          },
    ...(spec.workingDirectory === undefined
      ? {}
      : { workingDirectory: spec.workingDirectory }),
    environmentPolicy: spec.environmentPolicy,
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    terminationGraceMs: spec.terminationGraceMs,
    ...(spec.resourcePolicy === undefined
      ? {}
      : {
          resourcePolicy: {
            ...(spec.resourcePolicy.memoryBytes === undefined
              ? {}
              : { memoryBytes: { ...spec.resourcePolicy.memoryBytes } }),
            ...(spec.resourcePolicy.cpuMillisPerSecond === undefined
              ? {}
              : {
                  cpuMillisPerSecond: {
                    ...spec.resourcePolicy.cpuMillisPerSecond,
                  },
                }),
            ...(spec.resourcePolicy.filesystemIsolation === undefined
              ? {}
              : {
                  filesystemIsolation: spec.resourcePolicy.filesystemIsolation,
                }),
            ...(spec.resourcePolicy.networkIsolation === undefined
              ? {}
              : { networkIsolation: spec.resourcePolicy.networkIsolation }),
          },
        }),
  };
}
