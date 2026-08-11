import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { LocalCompletionReceiptJournal } from '@qinglong/runtime-core/local-completion-receipt-journal';
import { assertCompletionReceiptId } from '../completion-receipt/completionReceipt';
import {
  createLocalProcessDurableHandle,
  LinuxProcProcessIdentityProvider,
  type LocalProcessIdentityProvider,
} from './localProcessIdentity';

export const BUNDLED_LOCAL_PROCESS_LAUNCHER_SHA256 =
  'db4342ea57f8f7f19e385e204889ac03e97a2f82f42b01f2e59291be4b569153';
export const MAX_LOCAL_PROCESS_ENVIRONMENT_ENTRIES = 256;
export const MAX_LOCAL_PROCESS_ENVIRONMENT_BYTES = 64 * 1024;
export const MAX_LOCAL_PROCESS_ARGUMENTS = 256;
export const MAX_LOCAL_PROCESS_COMMAND_BYTES = 64 * 1024;

const CALLBACK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type LocalProcessCommand =
  | Readonly<{
      kind: 'argv';
      file: string;
      args: readonly string[];
    }>
  | Readonly<{
      kind: 'shell';
      command: string;
      shell?: '/bin/sh' | '/bin/bash';
    }>;

export interface LocalProcessLaunchRequest {
  readonly runId: string;
  readonly attemptId: string;
  /** Optional durable pre-spawn timestamp supplied by a higher-level journal. */
  readonly startedAtMs?: number;
  readonly callbackSequence: number;
  readonly callbackToken: string;
  readonly command: LocalProcessCommand;
  readonly environment?: Readonly<Record<string, string>>;
  readonly workingDirectory?: string;
  readonly output?: LocalProcessOutputPlan;
}

export interface LocalProcessOutputPlan {
  readonly filePath: string;
  readonly maximumBytes: number;
  readonly logArtifactId: string;
}

export interface LocalProcessLaunchCompletion {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface LocalProcessLaunchHandle {
  readonly handleId: string;
  readonly pid: number;
  readonly durableHandle: string;
  readonly startedAtMs: number;
  readonly completion: Promise<LocalProcessLaunchCompletion>;
}

export interface LocalProcessLauncherOptions {
  readonly receiptRoot: string;
  readonly launcherPath?: string;
  readonly expectedLauncherSha256?: string;
  readonly identityProvider?: LocalProcessIdentityProvider;
  readonly clock?: { now(): number };
  readonly createHandleId?: () => string;
}

export class LocalProcessLaunchError extends Error {
  readonly code = 'LOCAL_PROCESS_LAUNCH_FAILED';

  constructor(
    message: string,
    readonly cause?: unknown,
    readonly spawnOutcome: 'no_spawn' | 'unknown' = 'no_spawn',
  ) {
    super(`Local process launch failed: ${message}`);
    this.name = 'LocalProcessLaunchError';
  }
}

function assertBoundedString(
  value: string,
  field: string,
  limit: number,
): void {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > limit
  ) {
    throw new LocalProcessLaunchError(`${field} is invalid`);
  }
}

function assertAbsoluteBoundedPath(value: string, field: string): void {
  if (
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) {
    throw new LocalProcessLaunchError(
      `${field} must be a bounded absolute path`,
    );
  }
}

function assertRequest(request: LocalProcessLaunchRequest): void {
  assertCompletionReceiptId(request.runId, 'runId');
  assertCompletionReceiptId(request.attemptId, 'attemptId');
  if (
    request.startedAtMs !== undefined &&
    (!Number.isSafeInteger(request.startedAtMs) || request.startedAtMs < 0)
  ) {
    throw new LocalProcessLaunchError('started timestamp is invalid');
  }
  if (
    !Number.isSafeInteger(request.callbackSequence) ||
    request.callbackSequence < 1
  ) {
    throw new LocalProcessLaunchError('callback sequence is invalid');
  }
  if (!CALLBACK_TOKEN_PATTERN.test(request.callbackToken)) {
    throw new LocalProcessLaunchError('callback token is invalid');
  }
  if (request.workingDirectory !== undefined) {
    assertAbsoluteBoundedPath(request.workingDirectory, 'working directory');
  }
  if (request.output !== undefined) {
    if (
      !request.output ||
      typeof request.output !== 'object' ||
      Array.isArray(request.output)
    ) {
      throw new LocalProcessLaunchError('output plan is invalid');
    }
    assertAbsoluteBoundedPath(request.output.filePath, 'output file');
    if (
      !Number.isSafeInteger(request.output.maximumBytes) ||
      request.output.maximumBytes < 64 * 1024 ||
      request.output.maximumBytes > 1024 * 1024 * 1024
    ) {
      throw new LocalProcessLaunchError('output quota is invalid');
    }
    if (!/^(?:local|wlog)-[0-9a-f]{30}$/.test(request.output.logArtifactId)) {
      throw new LocalProcessLaunchError('output Artifact identity is invalid');
    }
    if (
      path.basename(request.output.filePath) !==
      `${request.output.logArtifactId}.log`
    ) {
      throw new LocalProcessLaunchError(
        'output path does not match its Artifact identity',
      );
    }
  }
  if (request.command.kind === 'argv') {
    assertAbsoluteBoundedPath(request.command.file, 'command file');
    if (request.command.args.length > MAX_LOCAL_PROCESS_ARGUMENTS) {
      throw new LocalProcessLaunchError('command has too many arguments');
    }
    let bytes = Buffer.byteLength(request.command.file, 'utf8');
    for (const argument of request.command.args) {
      assertBoundedString(argument, 'command argument', 16 * 1024);
      bytes += Buffer.byteLength(argument, 'utf8');
    }
    if (bytes > MAX_LOCAL_PROCESS_COMMAND_BYTES) {
      throw new LocalProcessLaunchError('command exceeds its byte budget');
    }
  } else {
    assertBoundedString(
      request.command.command,
      'shell command',
      MAX_LOCAL_PROCESS_COMMAND_BYTES,
    );
    if (
      request.command.shell !== undefined &&
      request.command.shell !== '/bin/sh' &&
      request.command.shell !== '/bin/bash'
    ) {
      throw new LocalProcessLaunchError('shell is not allowlisted');
    }
  }
}

function normalizedEnvironment(
  source: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const entries = Object.entries(source ?? {});
  if (entries.length > MAX_LOCAL_PROCESS_ENVIRONMENT_ENTRIES) {
    throw new LocalProcessLaunchError('environment entry budget exceeded');
  }
  let bytes = 0;
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of entries) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw new LocalProcessLaunchError('environment name is invalid');
    }
    assertBoundedString(value, 'environment value', 16 * 1024);
    bytes += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_LOCAL_PROCESS_ENVIRONMENT_BYTES) {
      throw new LocalProcessLaunchError('environment byte budget exceeded');
    }
    if (!name.startsWith('QL3_RECEIPT_') && !name.startsWith('QL3_LAUNCH_')) {
      environment[name] = value;
    }
  }
  return environment;
}

function bundledLauncherPath(): string {
  return path.resolve(__dirname, '../../assets/ql3-launcher.sh');
}

function completionOf(
  child: ChildProcess,
): Promise<LocalProcessLaunchCompletion> {
  return new Promise((resolve) => {
    child.once('close', (exitCode, signal) => {
      resolve(Object.freeze({ exitCode, signal }));
    });
  });
}

export class LocalProcessLauncher {
  private readonly receiptRoot: string;
  private readonly launcherPath: string;
  private readonly expectedLauncherSha256: string;
  private readonly identityProvider: LocalProcessIdentityProvider;
  private readonly clock: { now(): number };
  private readonly createHandleId: () => string;

  constructor(
    private readonly journal: Pick<LocalCompletionReceiptJournal, 'register'>,
    options: LocalProcessLauncherOptions,
  ) {
    assertAbsoluteBoundedPath(options.receiptRoot, 'receipt root');
    this.receiptRoot = path.resolve(options.receiptRoot);
    this.launcherPath = options.launcherPath ?? bundledLauncherPath();
    assertAbsoluteBoundedPath(this.launcherPath, 'launcher path');
    this.expectedLauncherSha256 =
      options.expectedLauncherSha256 ?? BUNDLED_LOCAL_PROCESS_LAUNCHER_SHA256;
    if (!/^[a-f0-9]{64}$/.test(this.expectedLauncherSha256)) {
      throw new LocalProcessLaunchError('launcher digest is invalid');
    }
    this.identityProvider =
      options.identityProvider ?? new LinuxProcProcessIdentityProvider();
    this.clock = options.clock ?? { now: Date.now };
    this.createHandleId = options.createHandleId ?? randomUUID;
  }

  async start(
    request: LocalProcessLaunchRequest,
  ): Promise<LocalProcessLaunchHandle> {
    assertRequest(request);
    const environment = normalizedEnvironment(request.environment);
    const observedAtMs = this.clock.now();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new LocalProcessLaunchError('clock returned an invalid timestamp');
    }
    const startedAtMs = request.startedAtMs ?? observedAtMs;
    if (startedAtMs > observedAtMs) {
      throw new LocalProcessLaunchError(
        'started timestamp cannot be after launch observation',
      );
    }
    const handleId = this.createHandleId();
    assertBoundedString(handleId, 'handle id', 255);
    const verifiedLauncher = await this.verifyLauncher();

    const receiptDirectory = path.join(
      this.receiptRoot,
      request.attemptId.slice(0, 2),
    );
    const receiptTarget = path.join(
      receiptDirectory,
      `${request.attemptId}.json`,
    );
    const receiptTemporary = path.join(
      receiptDirectory,
      `.${request.attemptId}.${randomBytes(16).toString('hex')}.tmp`,
    );
    let output: fs.FileHandle | undefined;
    let spawnConfirmed = false;
    try {
      await fs.mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
      await fs.chmod(receiptDirectory, 0o700);
      let outputQuotaFifo: string | undefined;
      let outputQuotaRemainingBytes: number | undefined;
      let outputTruncationTarget: string | undefined;
      let outputTruncationTemporary: string | undefined;
      if (request.output !== undefined) {
        await fs.mkdir(path.dirname(request.output.filePath), {
          recursive: true,
          mode: 0o700,
        });
        output = await fs.open(
          request.output.filePath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_APPEND |
            (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        const stat = await output.stat();
        if (!stat.isFile()) {
          throw new LocalProcessLaunchError(
            'output target is not a regular file',
          );
        }
        if (
          !Number.isSafeInteger(stat.size) ||
          stat.size < 0 ||
          stat.size > request.output.maximumBytes
        ) {
          throw new LocalProcessLaunchError('output target exceeds its quota');
        }
        await output.chmod(0o600);
        const directory = path.dirname(request.output.filePath);
        const base = path.basename(request.output.filePath);
        outputQuotaFifo = path.join(directory, `.${base}.fifo`);
        outputQuotaRemainingBytes = request.output.maximumBytes - stat.size;
        outputTruncationTarget = path.join(
          directory,
          `.${base}.truncated.json`,
        );
        outputTruncationTemporary = path.join(
          directory,
          `.${base}.truncated.tmp`,
        );
      }

      // This is the durable pre-spawn barrier. A crash after this point leaves
      // a database-indexed cleanup candidate and never requires directory scan.
      await this.journal.register({
        runId: request.runId,
        attemptId: request.attemptId,
        registeredAtMs: startedAtMs,
      });

      const launcherEnvironment: NodeJS.ProcessEnv = {
        ...environment,
        QL3_RECEIPT_RUN_ID: request.runId,
        QL3_RECEIPT_ATTEMPT_ID: request.attemptId,
        QL3_RECEIPT_CALLBACK_SEQUENCE: String(request.callbackSequence),
        QL3_RECEIPT_CALLBACK_TOKEN: request.callbackToken,
        QL3_RECEIPT_STARTED_AT_MS: String(startedAtMs),
        QL3_RECEIPT_TARGET: receiptTarget,
        QL3_RECEIPT_TEMPORARY: receiptTemporary,
        ...(request.output === undefined
          ? {}
          : {
              QL3_OUTPUT_QUOTA_FIFO: outputQuotaFifo!,
              QL3_OUTPUT_QUOTA_REMAINING_BYTES: String(
                outputQuotaRemainingBytes,
              ),
              QL3_OUTPUT_ARTIFACT_ID: request.output.logArtifactId,
              QL3_OUTPUT_MAXIMUM_BYTES: String(request.output.maximumBytes),
              QL3_OUTPUT_TRUNCATION_TARGET: outputTruncationTarget!,
              QL3_OUTPUT_TRUNCATION_TEMPORARY: outputTruncationTemporary!,
            }),
        ...(request.command.kind === 'shell'
          ? {
              QL3_LAUNCH_SHELL: request.command.shell ?? '/bin/sh',
              QL3_LAUNCH_SHELL_COMMAND: request.command.command,
            }
          : {}),
      };
      const args =
        request.command.kind === 'argv'
          ? ['/dev/fd/3', 'argv', request.command.file, ...request.command.args]
          : ['/dev/fd/3', 'shell'];
      const child = spawn('/bin/sh', args, {
        cwd: request.workingDirectory,
        env: launcherEnvironment,
        detached: true,
        stdio: output
          ? ['ignore', output.fd, output.fd, verifiedLauncher.fd]
          : ['ignore', 'ignore', 'ignore', verifiedLauncher.fd],
      });
      const completion = completionOf(child);
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        spawnConfirmed = true;
      } finally {
        await output?.close().catch(() => undefined);
        output = undefined;
        await verifiedLauncher.close().catch(() => undefined);
      }
      if (!child.pid) {
        throw new LocalProcessLaunchError(
          'spawn did not return a PID',
          undefined,
          'unknown',
        );
      }
      let identity;
      try {
        identity = await this.identityProvider.capture(child.pid);
      } catch (error) {
        await this.stopUnownedProcess(child.pid, completion);
        throw new LocalProcessLaunchError(
          'durable identity capture failed',
          error,
          'unknown',
        );
      }
      if (!identity) {
        await this.stopUnownedProcess(child.pid, completion);
        throw new LocalProcessLaunchError(
          'platform cannot prove durable local process identity',
          undefined,
          'unknown',
        );
      }
      return Object.freeze({
        handleId,
        pid: child.pid,
        durableHandle: createLocalProcessDurableHandle(handleId, identity),
        startedAtMs,
        completion,
      });
    } catch (error) {
      await output?.close().catch(() => undefined);
      await verifiedLauncher.close().catch(() => undefined);
      if (error instanceof LocalProcessLaunchError) throw error;
      throw new LocalProcessLaunchError(
        'launcher preparation or spawn failed',
        error,
        spawnConfirmed ? 'unknown' : 'no_spawn',
      );
    }
  }

  private async verifyLauncher(): Promise<fs.FileHandle> {
    let launcher: fs.FileHandle | undefined;
    try {
      launcher = await fs.open(
        this.launcherPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const stat = await launcher.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024) {
        throw new LocalProcessLaunchError(
          'launcher is not a bounded regular file',
        );
      }
      const bytes = Buffer.allocUnsafe(stat.size);
      const { bytesRead } = await launcher.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length) {
        throw new LocalProcessLaunchError('launcher changed while being read');
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== this.expectedLauncherSha256) {
        throw new LocalProcessLaunchError(
          'launcher digest does not match review',
        );
      }
      return launcher;
    } catch (error) {
      await launcher?.close().catch(() => undefined);
      if (error instanceof LocalProcessLaunchError) throw error;
      throw new LocalProcessLaunchError('launcher verification failed', error);
    }
  }

  private async stopUnownedProcess(
    pid: number,
    completion: Promise<LocalProcessLaunchCompletion>,
  ): Promise<void> {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      return;
    }
    const closed = await Promise.race([
      completion.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    if (!closed) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // The process may have exited between the timeout and the signal.
      }
    }
  }
}
