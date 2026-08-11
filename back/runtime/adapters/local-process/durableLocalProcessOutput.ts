import path from 'path';
import type { ExecutionOutputSink } from '../../domain/execution';
import { assertLocalExecutionArtifactId } from '../../domain/localExecutionArtifact';

const DURABLE_LOCAL_PROCESS_OUTPUT = Symbol('durable-local-process-output');

export interface DurableLocalProcessOutput {
  outputFilePath: string;
  completionReceiptRoot: string;
  maximumBytes?: number;
  logArtifactId?: string;
}

type CapableExecutionOutputSink = ExecutionOutputSink & {
  [DURABLE_LOCAL_PROCESS_OUTPUT]?: DurableLocalProcessOutput;
};

function assertAbsolutePath(value: string, name: string): void {
  if (!path.isAbsolute(value) || value.includes('\0')) {
    throw new RangeError(`${name} must be an absolute path containing no NUL`);
  }
}

/**
 * Adds an adapter-local launch capability without widening ExecutionContext.
 * The symbol is deliberately non-enumerable so paths cannot leak through
 * routine context serialization or diagnostic logging.
 */
export function enableDurableLocalProcessOutput<T extends ExecutionOutputSink>(
  output: T,
  capability: DurableLocalProcessOutput,
): T {
  assertAbsolutePath(capability.outputFilePath, 'outputFilePath');
  assertAbsolutePath(capability.completionReceiptRoot, 'completionReceiptRoot');
  if (
    capability.maximumBytes !== undefined &&
    (!Number.isSafeInteger(capability.maximumBytes) ||
      capability.maximumBytes < 1)
  ) {
    throw new RangeError('maximumBytes must be a positive safe integer');
  }
  if (
    (capability.maximumBytes === undefined) !==
    (capability.logArtifactId === undefined)
  ) {
    throw new RangeError(
      'maximumBytes and logArtifactId must be provided together',
    );
  }
  if (capability.logArtifactId !== undefined) {
    assertLocalExecutionArtifactId(capability.logArtifactId);
  }
  Object.defineProperty(output, DURABLE_LOCAL_PROCESS_OUTPUT, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ ...capability }),
  });
  return output;
}

export function durableLocalProcessOutput(
  output: ExecutionOutputSink,
): DurableLocalProcessOutput | undefined {
  return (output as CapableExecutionOutputSink)[DURABLE_LOCAL_PROCESS_OUTPUT];
}
