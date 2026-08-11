import { randomBytes } from 'crypto';
import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type { ExecutionContext, ExecutionSpec } from '../../domain/execution';
import { assertCompletionReceiptId } from '../../domain/completionReceipt';
import {
  ExecutorCapabilityUnavailableError,
  InvalidExecutionSpecError,
} from '../../domain/executorErrors';
import { assertLocalExecutionArtifactId } from '../../domain/localExecutionArtifact';
import type { DurableLocalProcessOutput } from './durableLocalProcessOutput';

const CALLBACK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export interface DurableLocalProcessLaunch {
  file: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  outputDescriptor: number;
  closeParentOutput(): Promise<void>;
}

function assertCallback(
  callback: ExecutionContext['completionCallback'],
): asserts callback is NonNullable<ExecutionContext['completionCallback']> {
  if (!callback || !CALLBACK_TOKEN_PATTERN.test(callback.token)) {
    throw new InvalidExecutionSpecError(
      'durable completion requires a bounded base64url callback token',
    );
  }
  if (
    !Number.isSafeInteger(callback.callbackSequence) ||
    callback.callbackSequence < 1
  ) {
    throw new InvalidExecutionSpecError(
      'durable completion requires a positive callback sequence',
    );
  }
}

function launcherEnvironment(
  environment: NodeJS.ProcessEnv,
  spec: ExecutionSpec,
  context: ExecutionContext,
  capability: DurableLocalProcessOutput,
  receiptTarget: string,
  receiptTemporary: string,
  startedAtMs: number,
  quotaFifo: string | undefined,
  quotaRemainingBytes: number | undefined,
  truncationTarget: string | undefined,
  truncationTemporary: string | undefined,
): NodeJS.ProcessEnv {
  const callback = context.completionCallback!;
  return {
    ...environment,
    QL3_RECEIPT_RUN_ID: spec.runId,
    QL3_RECEIPT_ATTEMPT_ID: spec.attemptId,
    QL3_RECEIPT_CALLBACK_SEQUENCE: String(callback.callbackSequence),
    QL3_RECEIPT_CALLBACK_TOKEN: callback.token,
    QL3_RECEIPT_STARTED_AT_MS: String(startedAtMs),
    QL3_RECEIPT_TARGET: receiptTarget,
    QL3_RECEIPT_TEMPORARY: receiptTemporary,
    ...(quotaFifo === undefined
      ? {}
      : {
          QL3_OUTPUT_QUOTA_FIFO: quotaFifo,
          QL3_OUTPUT_QUOTA_REMAINING_BYTES: String(quotaRemainingBytes),
          QL3_OUTPUT_ARTIFACT_ID: capability.logArtifactId!,
          QL3_OUTPUT_MAXIMUM_BYTES: String(capability.maximumBytes),
          QL3_OUTPUT_TRUNCATION_TARGET: truncationTarget!,
          QL3_OUTPUT_TRUNCATION_TEMPORARY: truncationTemporary!,
        }),
    ...(spec.command.kind === 'shell'
      ? {
          QL3_LAUNCH_SHELL: spec.command.shell ?? '/bin/bash',
          QL3_LAUNCH_SHELL_COMMAND: spec.command.command,
        }
      : {}),
  };
}

export async function prepareDurableLocalProcessLaunch(
  spec: ExecutionSpec,
  context: ExecutionContext,
  environment: NodeJS.ProcessEnv,
  capability: DurableLocalProcessOutput,
  launcherPath: string | undefined,
  startedAtMs: number,
): Promise<DurableLocalProcessLaunch> {
  if (!launcherPath) {
    throw new ExecutorCapabilityUnavailableError('durableLocalCompletion');
  }
  if (!path.isAbsolute(launcherPath) || launcherPath.includes('\0')) {
    throw new InvalidExecutionSpecError(
      'durable launcher path must be absolute and contain no NUL',
    );
  }
  assertCallback(context.completionCallback);
  assertCompletionReceiptId(spec.runId, 'runId');
  assertCompletionReceiptId(spec.attemptId, 'attemptId');
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) {
    throw new InvalidExecutionSpecError(
      'durable completion start time must be a non-negative safe integer',
    );
  }

  const launcher = await fs.lstat(launcherPath);
  if (!launcher.isFile()) {
    throw new InvalidExecutionSpecError(
      'durable launcher must be a regular file',
    );
  }

  const receiptDirectory = path.join(
    capability.completionReceiptRoot,
    spec.attemptId.slice(0, 2),
  );
  const receiptTarget = path.join(receiptDirectory, `${spec.attemptId}.json`);
  const receiptTemporary = path.join(
    receiptDirectory,
    `.${spec.attemptId}.${randomBytes(16).toString('hex')}.tmp`,
  );
  await fs.mkdir(path.dirname(capability.outputFilePath), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(receiptDirectory, { recursive: true, mode: 0o700 });

  const output = await fs.open(
    capability.outputFilePath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let quotaFifo: string | undefined;
  let quotaRemainingBytes: number | undefined;
  let truncationTarget: string | undefined;
  let truncationTemporary: string | undefined;
  try {
    const stat = await output.stat();
    if (!stat.isFile()) {
      throw new InvalidExecutionSpecError(
        'durable output target must be a regular file',
      );
    }
    await output.chmod(0o600);
    if (capability.maximumBytes !== undefined) {
      if (
        !Number.isSafeInteger(capability.maximumBytes) ||
        capability.maximumBytes < 1 ||
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0 ||
        stat.size > capability.maximumBytes
      ) {
        throw new InvalidExecutionSpecError(
          'durable output quota or existing size is invalid',
        );
      }
      quotaRemainingBytes = capability.maximumBytes - stat.size;
      if (!capability.logArtifactId) {
        throw new InvalidExecutionSpecError(
          'durable output quota requires a Local Artifact identity',
        );
      }
      try {
        assertLocalExecutionArtifactId(capability.logArtifactId);
      } catch {
        throw new InvalidExecutionSpecError(
          'durable output Local Artifact identity is invalid',
        );
      }
      if (
        path.basename(capability.outputFilePath) !==
        `${capability.logArtifactId}.log`
      ) {
        throw new InvalidExecutionSpecError(
          'durable output path does not match its Local Artifact identity',
        );
      }
      quotaFifo = path.join(
        path.dirname(capability.outputFilePath),
        `.${path.basename(capability.outputFilePath)}.fifo`,
      );
      truncationTarget = path.join(
        path.dirname(capability.outputFilePath),
        `.${path.basename(capability.outputFilePath)}.truncated.json`,
      );
      truncationTemporary = path.join(
        path.dirname(capability.outputFilePath),
        `.${path.basename(capability.outputFilePath)}.truncated.tmp`,
      );
    }
  } catch (error) {
    await output.close().catch(() => undefined);
    throw error;
  }

  const launchMode = spec.command.kind;
  const args =
    spec.command.kind === 'argv'
      ? [launcherPath, launchMode, spec.command.file, ...spec.command.args]
      : [launcherPath, launchMode];
  return {
    file: '/bin/sh',
    args,
    environment: launcherEnvironment(
      environment,
      spec,
      context,
      capability,
      receiptTarget,
      receiptTemporary,
      startedAtMs,
      quotaFifo,
      quotaRemainingBytes,
      truncationTarget,
      truncationTemporary,
    ),
    outputDescriptor: output.fd,
    closeParentOutput: () => output.close(),
  };
}
