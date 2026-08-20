// Worker Process owns bounded environment-to-runtime configuration mapping.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  isAbsolute,
  normalize,
  parse,
} from 'node:path';
import {
  canonicalRemoteWorkerCapabilities,
  REMOTE_WORKER_EXECUTOR_CAPABILITY,
  remoteWorkerArchitectureForNodeRuntime,
  type RemoteWorkerCapabilities,
} from '@qinglong/runtime-core/remote-dispatch';

const MAX_CAPABILITIES_FILE_BYTES = 20 * 1024;
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type WorkerProcessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface DisabledWorkerProcessConfig {
  readonly enabled: false;
  readonly profile: string;
}

export interface EnabledWorkerProcessConfig {
  readonly enabled: true;
  readonly profile: 'worker';
  readonly capacityProfile: 'edge' | 'node';
  readonly workerId: string;
  readonly origin: string;
  readonly capabilities: RemoteWorkerCapabilities;
  readonly maxConcurrentRuns: number;
  readonly storage: Readonly<{
    readonly journalRoot: string;
    readonly logRoot: string;
    readonly receiptRoot: string;
  }>;
  readonly identity: Readonly<{
    readonly certificateStoreRoot: string;
    readonly trustAnchorFile: string;
    readonly credentialTokenFile: string;
    readonly expectedCredentialId?: string;
    readonly bootstrap?: Readonly<{
      readonly privateKeyFile: string;
      readonly certificateChainFile: string;
    }>;
  }>;
  readonly lifecycle: Readonly<{
    readonly cadenceMs: number;
    readonly leaseDurationMs: number;
    readonly heartbeatIntervalMs: number;
    readonly drainTimeoutMs: number;
    readonly drainPollMs: number;
    readonly requestTimeoutMs: number;
    readonly maximumJournalEntries: number;
    readonly maximumRecordsPerTick: number;
    readonly maximumSupervisionRecordsPerTick: number;
  }>;
  readonly executor: Readonly<{
    readonly launcherPath?: string;
    readonly expectedLauncherSha256?: string;
  }>;
}

export type WorkerProcessConfig =
  | DisabledWorkerProcessConfig
  | EnabledWorkerProcessConfig;

export class WorkerProcessConfigError extends TypeError {
  readonly code = 'QL3_WORKER_PROCESS_CONFIG_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(`Worker process configuration is invalid: ${message}`, options);
    this.name = 'WorkerProcessConfigError';
  }
}

function booleanValue(
  environment: WorkerProcessEnvironment,
  name: string,
  fallback: boolean,
): boolean {
  const value = environment[name];
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new WorkerProcessConfigError(`${name} must be true or false`);
}

function boundedValue(
  environment: WorkerProcessEnvironment,
  name: string,
  maximumBytes: number,
  required = false,
): string | undefined {
  const value = environment[name];
  if (value === undefined || value === '') {
    if (required) throw new WorkerProcessConfigError(`${name} is required`);
    return undefined;
  }
  if (
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    /[\0\r\n]/.test(value)
  ) {
    throw new WorkerProcessConfigError(`${name} is invalid`);
  }
  return value;
}

function integerValue(
  environment: WorkerProcessEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = environment[name];
  if (value === undefined || value === '') return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new WorkerProcessConfigError(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new WorkerProcessConfigError(
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function absolutePath(
  environment: WorkerProcessEnvironment,
  name: string,
  required = true,
): string | undefined {
  const value = boundedValue(environment, name, 4096, required);
  if (value === undefined) return undefined;
  if (
    !isAbsolute(value) ||
    parse(value).root === value ||
    normalize(value) !== value
  ) {
    throw new WorkerProcessConfigError(`${name} must be a normalized absolute path`);
  }
  return value;
}

function origin(environment: WorkerProcessEnvironment): string {
  const value = boundedValue(
    environment,
    'QL3_WORKER_CONTROL_ORIGIN',
    2048,
    true,
  )!;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new WorkerProcessConfigError(
      'QL3_WORKER_CONTROL_ORIGIN is invalid',
      { cause: error },
    );
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new WorkerProcessConfigError(
      'QL3_WORKER_CONTROL_ORIGIN must be an HTTPS origin',
    );
  }
  return parsed.origin;
}

async function capabilities(path: string): Promise<RemoteWorkerCapabilities> {
  let handle;
  let bytes: Buffer | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 2 ||
      stat.size > MAX_CAPABILITIES_FILE_BYTES ||
      (stat.mode & 0o022) !== 0
    ) {
      throw new Error('unsafe capabilities metadata');
    }
    bytes = await handle.readFile();
    if (
      bytes.byteLength < 2 ||
      bytes.byteLength > MAX_CAPABILITIES_FILE_BYTES
    ) {
      throw new Error('unsafe capabilities size');
    }
    const parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
    const normalized = canonicalRemoteWorkerCapabilities(parsed).capabilities;
    if (!normalized.executors.includes(REMOTE_WORKER_EXECUTOR_CAPABILITY))
      throw new Error('remote-worker executor capability is required');
    const runtimeArchitecture = remoteWorkerArchitectureForNodeRuntime(
      process.arch,
      (process.config.variables as Readonly<Record<string, unknown>>)[
        'arm_version'
      ],
    );
    if (normalized.architecture !== runtimeArchitecture)
      throw new Error('capability architecture does not match the Node runtime');
    return normalized;
  } catch (error) {
    throw new WorkerProcessConfigError(
      'QL3_WORKER_CAPABILITIES_FILE is unavailable or invalid',
      { cause: error },
    );
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

export async function loadWorkerProcessConfig(
  environment: WorkerProcessEnvironment,
): Promise<WorkerProcessConfig> {
  if (
    !environment ||
    typeof environment !== 'object' ||
    Array.isArray(environment)
  ) {
    throw new WorkerProcessConfigError('environment must be an object');
  }
  const enabled = booleanValue(
    environment,
    'QL3_WORKER_RUNTIME_ENABLED',
    false,
  );
  const profile = environment.QL_DEPLOYMENT_PROFILE ?? 'standalone';
  if (!enabled) return Object.freeze({ enabled: false, profile });
  if (profile !== 'worker') {
    throw new WorkerProcessConfigError(
      'enabled runtime requires QL_DEPLOYMENT_PROFILE=worker',
    );
  }

  const capacityProfile =
    boundedValue(environment, 'QL3_WORKER_CAPACITY_PROFILE', 8) ?? 'edge';
  if (capacityProfile !== 'edge' && capacityProfile !== 'node') {
    throw new WorkerProcessConfigError(
      'QL3_WORKER_CAPACITY_PROFILE must be edge or node',
    );
  }
  const edge = capacityProfile === 'edge';
  const workerId = boundedValue(
    environment,
    'QL3_WORKER_ID',
    128,
    true,
  )!;
  if (!WORKER_ID.test(workerId)) {
    throw new WorkerProcessConfigError('QL3_WORKER_ID is invalid');
  }
  const expectedCredentialId = boundedValue(
    environment,
    'QL3_WORKER_EXPECTED_CREDENTIAL_ID',
    64,
  );
  if (
    expectedCredentialId !== undefined &&
    !CREDENTIAL_ID.test(expectedCredentialId)
  ) {
    throw new WorkerProcessConfigError(
      'QL3_WORKER_EXPECTED_CREDENTIAL_ID is invalid',
    );
  }
  const bootstrapPrivateKeyFile = absolutePath(
    environment,
    'QL3_WORKER_IDENTITY_BOOTSTRAP_PRIVATE_KEY_FILE',
    false,
  );
  const bootstrapCertificateChainFile = absolutePath(
    environment,
    'QL3_WORKER_IDENTITY_BOOTSTRAP_CERTIFICATE_FILE',
    false,
  );
  if (
    (bootstrapPrivateKeyFile === undefined) !==
    (bootstrapCertificateChainFile === undefined)
  ) {
    throw new WorkerProcessConfigError(
      'Worker identity bootstrap key and certificate must be configured together',
    );
  }
  const launcherPath = absolutePath(
    environment,
    'QL3_WORKER_LAUNCHER_PATH',
    false,
  );
  const expectedLauncherSha256 = boundedValue(
    environment,
    'QL3_WORKER_LAUNCHER_SHA256',
    64,
  );
  if (
    (launcherPath === undefined) !==
      (expectedLauncherSha256 === undefined) ||
    (expectedLauncherSha256 !== undefined &&
      !SHA256.test(expectedLauncherSha256))
  ) {
    throw new WorkerProcessConfigError(
      'Worker launcher path and SHA-256 must be configured together',
    );
  }
  const capabilitiesFile = absolutePath(
    environment,
    'QL3_WORKER_CAPABILITIES_FILE',
  )!;
  const leaseDurationMs = integerValue(
    environment,
    'QL3_WORKER_SESSION_LEASE_DURATION_MS',
    45_000,
    15_000,
    10 * 60_000,
  );
  const heartbeatIntervalMs = integerValue(
    environment,
    'QL3_WORKER_HEARTBEAT_INTERVAL_MS',
    10_000,
    5_000,
    5 * 60_000,
  );
  if (heartbeatIntervalMs * 2 > leaseDurationMs) {
    throw new WorkerProcessConfigError(
      'Worker heartbeat interval must fit twice inside the Session lease',
    );
  }

  return Object.freeze({
    enabled: true,
    profile: 'worker',
    capacityProfile,
    workerId,
    origin: origin(environment),
    capabilities: await capabilities(capabilitiesFile),
    maxConcurrentRuns: integerValue(
      environment,
      'QL3_WORKER_MAX_CONCURRENT_RUNS',
      edge ? 1 : 8,
      1,
      edge ? 4 : 64,
    ),
    storage: Object.freeze({
      journalRoot: absolutePath(
        environment,
        'QL3_WORKER_JOURNAL_ROOT',
      )!,
      logRoot: absolutePath(environment, 'QL3_WORKER_LOG_ROOT')!,
      receiptRoot: absolutePath(
        environment,
        'QL3_WORKER_RECEIPT_ROOT',
      )!,
    }),
    identity: Object.freeze({
      certificateStoreRoot: absolutePath(
        environment,
        'QL3_WORKER_CERTIFICATE_STORE_ROOT',
      )!,
      trustAnchorFile: absolutePath(
        environment,
        'QL3_WORKER_TRUST_ANCHOR_FILE',
      )!,
      credentialTokenFile: absolutePath(
        environment,
        'QL3_WORKER_CREDENTIAL_TOKEN_FILE',
      )!,
      ...(expectedCredentialId === undefined
        ? {}
        : { expectedCredentialId }),
      ...(bootstrapPrivateKeyFile === undefined
        ? {}
        : {
            bootstrap: Object.freeze({
              privateKeyFile: bootstrapPrivateKeyFile,
              certificateChainFile: bootstrapCertificateChainFile!,
            }),
          }),
    }),
    lifecycle: Object.freeze({
      cadenceMs: integerValue(
        environment,
        'QL3_WORKER_CADENCE_MS',
        edge ? 2_000 : 500,
        100,
        60_000,
      ),
      leaseDurationMs,
      heartbeatIntervalMs,
      drainTimeoutMs: integerValue(
        environment,
        'QL3_WORKER_DRAIN_TIMEOUT_MS',
        edge ? 60_000 : 5 * 60_000,
        1_000,
        10 * 60_000,
      ),
      drainPollMs: integerValue(
        environment,
        'QL3_WORKER_DRAIN_POLL_MS',
        edge ? 500 : 100,
        25,
        5_000,
      ),
      requestTimeoutMs: integerValue(
        environment,
        'QL3_WORKER_REQUEST_TIMEOUT_MS',
        15_000,
        100,
        120_000,
      ),
      maximumJournalEntries: integerValue(
        environment,
        'QL3_WORKER_MAXIMUM_JOURNAL_ENTRIES',
        edge ? 64 : 256,
        1,
        1024,
      ),
      maximumRecordsPerTick: integerValue(
        environment,
        'QL3_WORKER_MAXIMUM_RECORDS_PER_TICK',
        edge ? 4 : 16,
        1,
        64,
      ),
      maximumSupervisionRecordsPerTick: integerValue(
        environment,
        'QL3_WORKER_MAXIMUM_SUPERVISION_RECORDS_PER_TICK',
        edge ? 4 : 32,
        1,
        64,
      ),
    }),
    executor: Object.freeze({
      ...(launcherPath === undefined
        ? {}
        : {
            launcherPath,
            expectedLauncherSha256: expectedLauncherSha256!,
          }),
    }),
  });
}
