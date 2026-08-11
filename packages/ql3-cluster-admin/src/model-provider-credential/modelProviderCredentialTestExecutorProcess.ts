import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { normalize, parse } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  normalizeModelProviderCredentialTestAllowlist,
  type ModelProviderCredentialTestAllowlist,
} from '@qinglong/ai/model-provider-credential-test-connection';
import {
  PostgresModelProviderCredentialTestExecutionRepository,
  assertPostgresModelProviderCredentialTesterReady,
  type PostgresModelProviderCredentialTesterReadinessReport,
} from '@qinglong/ai/postgres-model-provider-credential-test-connection';
import { PostgresModelProviderCredentialReader } from '@qinglong/ai/postgres-model-provider-credential-storage';
import {
  createProjectedModelProviderSecretMaterialProvider,
  type ProjectedModelProviderSecretMaterialProvider,
} from '@qinglong/ai/projected-model-provider-secret-material';
import type { OpenPostgresDatabase } from '@qinglong/runtime-core';
import {
  createPostgresDatabaseOpener,
  isPostgresTlsDnsServername,
  loadPostgresCertificateAuthorityFile,
  loadPostgresConnectionEnvironment,
  type PostgresConnectionOptions,
  type PostgresPoolOptions,
} from '@qinglong/cluster-postgres/ai-credential-tester';

import {
  absoluteManagementEnvironmentFile,
  booleanManagementEnvironmentValue,
  boundedManagementEnvironmentValue,
  integerManagementEnvironmentValue,
  readManagementTlsFile,
} from '../management-support/managementProcessSupport';
import {
  createModelProviderCredentialTestExecutor,
  type ExecuteModelProviderCredentialTestResult,
  type ModelProviderCredentialTestExecutor,
} from './modelProviderCredentialTestExecutor';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_APPLICATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/;
const SAFE_TRANSPORT_FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_COMMAND_BYTES = 4 * 1_024;
const MAX_ALLOWLIST_BYTES = 64 * 1_024;

export interface ModelProviderCredentialTestExecutorCommand {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly testId: string;
}

export type ModelProviderCredentialTestExecutorProcessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type ModelProviderCredentialTestExecutorProcessConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      profile: 'cluster-admin';
      commandFile: string;
      allowlistFile: string;
      secretRootDirectory: string;
      networkPolicyDenyCanary?: Readonly<{
        host: string;
        port: number;
      }>;
      database: Readonly<{
        connection: PostgresConnectionOptions;
        pool: PostgresPoolOptions;
      }>;
    }>;

export type ModelProviderCredentialTestExecutorProcessResult =
  | Readonly<{ status: 'disabled' }>
  | Readonly<{
      status: 'completed';
      database: PostgresModelProviderCredentialTesterReadinessReport;
      test: Readonly<ExecuteModelProviderCredentialTestResult>;
      readonly transportFailureCode?: string;
      readonly transportRequestDigest?: string;
      readonly transportAddressSha256?: string;
      readonly transportPort?: number;
    }>;

export interface RunModelProviderCredentialTestExecutorProcessOptions {
  readonly environment: ModelProviderCredentialTestExecutorProcessEnvironment;
  readonly command?: Readonly<ModelProviderCredentialTestExecutorCommand>;
  readonly allowlist?: Readonly<ModelProviderCredentialTestAllowlist>;
  readonly openDatabase?: OpenPostgresDatabase;
  readonly assertReady?: typeof assertPostgresModelProviderCredentialTesterReady;
  readonly secrets?: Readonly<ProjectedModelProviderSecretMaterialProvider>;
  readonly executor?: Readonly<ModelProviderCredentialTestExecutor>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly transportReady?: (
    baseUrl: string,
    signal: AbortSignal,
  ) => Promise<void>;
}

export class ModelProviderCredentialTestExecutorProcessConfigError extends TypeError {
  readonly code = 'QL3_MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTOR_CONFIG_INVALID';

  constructor(message: string) {
    super(
      `Model provider credential test executor config is invalid: ${message}`,
    );
    this.name = 'ModelProviderCredentialTestExecutorProcessConfigError';
  }
}

function configFailure(
  message: string,
): ModelProviderCredentialTestExecutorProcessConfigError {
  return new ModelProviderCredentialTestExecutorProcessConfigError(message);
}

function transportFailureCode(error: unknown): string {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!candidate || typeof candidate !== 'object') break;
    const value = candidate as {
      readonly cause?: unknown;
      readonly code?: unknown;
      readonly message?: unknown;
    };
    if (
      typeof value.code === 'string' &&
      SAFE_TRANSPORT_FAILURE_CODE.test(value.code)
    ) {
      return value.code;
    }
    const message =
      typeof value.message === 'string' ? value.message.toLowerCase() : '';
    if (
      message.includes('certificate') ||
      message.includes('self signed') ||
      message.includes('unable to verify')
    ) {
      return 'TLS_VALIDATION_FAILED';
    }
    if (message.includes('getaddrinfo')) return 'DNS_LOOKUP_FAILED';
    if (message.includes('bad port')) return 'PORT_REJECTED';
    candidate = value.cause;
  }
  return 'TRANSPORT_FAILED';
}

function transportRequestDigest(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): string {
  const request = input instanceof Request ? input : undefined;
  const url = request?.url ?? String(input);
  const method = init?.method ?? request?.method ?? 'GET';
  return `sha256:${createHash('sha256')
    .update(method.toUpperCase(), 'utf8')
    .update('\0', 'utf8')
    .update(url, 'utf8')
    .digest('hex')}`;
}

function transportFailureEndpoint(
  error: unknown,
): Readonly<{ addressSha256: string; port: number }> | undefined {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!candidate || typeof candidate !== 'object') break;
    const value = candidate as {
      readonly address?: unknown;
      readonly cause?: unknown;
      readonly port?: unknown;
    };
    if (
      typeof value.address === 'string' &&
      value.address.length >= 1 &&
      value.address.length <= 128 &&
      Number.isInteger(value.port) &&
      (value.port as number) >= 1 &&
      (value.port as number) <= 65_535
    ) {
      return Object.freeze({
        addressSha256: `sha256:${createHash('sha256')
          .update(value.address, 'utf8')
          .digest('hex')}`,
        port: value.port as number,
      });
    }
    candidate = value.cause;
  }
  return undefined;
}

async function connectOnce(
  host: string,
  port: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const socket = createConnection({ host, port });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void =>
      finish(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('transport readiness aborted'),
      );
    signal.addEventListener('abort', onAbort, { once: true });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish());
    socket.once('timeout', () => finish(new Error('transport timeout')));
    socket.once('error', (error) => finish(error));
  });
}

async function waitForTransportReady(
  baseUrl: string,
  signal: AbortSignal,
  denyCanary?: Readonly<{ host: string; port: number }>,
): Promise<void> {
  const endpoint = new URL(baseUrl);
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, '');
  const port = endpoint.port
    ? Number(endpoint.port)
    : endpoint.protocol === 'https:'
    ? 443
    : 80;
  while (true) {
    if (signal.aborted) throw signal.reason;
    try {
      await connectOnce(hostname, port, signal, 500);
      if (denyCanary !== undefined) {
        let denied = false;
        try {
          await connectOnce(denyCanary.host, denyCanary.port, signal, 150);
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
          denied = true;
        }
        if (!denied) {
          await delay(50, undefined, { signal });
          continue;
        }
      }
      return;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      await delay(50, undefined, { signal });
    }
  }
}

function boundedValue(
  environment: ModelProviderCredentialTestExecutorProcessEnvironment,
  name: string,
  maximumLength: number,
): string | undefined {
  return boundedManagementEnvironmentValue(
    environment,
    name,
    maximumLength,
    configFailure,
  );
}

function booleanValue(
  environment: ModelProviderCredentialTestExecutorProcessEnvironment,
  name: string,
): boolean {
  return booleanManagementEnvironmentValue(environment, name, configFailure);
}

function integerValue(
  environment: ModelProviderCredentialTestExecutorProcessEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return integerManagementEnvironmentValue(
    environment,
    name,
    fallback,
    minimum,
    maximum,
    configFailure,
  );
}

function absolutePath(
  environment: ModelProviderCredentialTestExecutorProcessEnvironment,
  name: string,
): string {
  const value = absoluteManagementEnvironmentFile(
    environment,
    name,
    configFailure,
  );
  if (normalize(value) !== value || parse(value).root === value) {
    throw configFailure(`${name} is invalid`);
  }
  return value;
}

function loadConnection(
  environment: ModelProviderCredentialTestExecutorProcessEnvironment,
): Readonly<{
  connection: PostgresConnectionOptions;
  pool: PostgresPoolOptions;
}> {
  let connection: PostgresConnectionOptions;
  try {
    connection = loadPostgresConnectionEnvironment(environment, {
      connectionString: 'QL3_POSTGRES_AI_CREDENTIAL_TESTER_URL',
      host: 'QL3_POSTGRES_AI_CREDENTIAL_TESTER_HOST',
      port: 'QL3_POSTGRES_AI_CREDENTIAL_TESTER_PORT',
      database: 'QL3_POSTGRES_AI_CREDENTIAL_TESTER_DATABASE',
      user: 'QL3_POSTGRES_AI_CREDENTIAL_TESTER_USER',
      password: 'QL3_POSTGRES_AI_CREDENTIAL_TESTER_PASSWORD',
    });
  } catch (error) {
    throw configFailure(
      error instanceof Error
        ? error.message
        : 'PostgreSQL AI credential tester connection is invalid',
    );
  }
  const mode =
    environment.QL3_POSTGRES_AI_CREDENTIAL_TESTER_TLS_MODE ?? 'verify-full';
  if (mode !== 'verify-full' && mode !== 'disable') {
    throw configFailure('PostgreSQL TLS mode must be verify-full or disable');
  }
  if (
    mode === 'disable' &&
    !booleanValue(
      environment,
      'QL3_POSTGRES_AI_CREDENTIAL_TESTER_ALLOW_INSECURE',
    )
  ) {
    throw configFailure('disabling PostgreSQL TLS requires explicit opt-in');
  }
  const servername = boundedValue(
    environment,
    'QL3_POSTGRES_AI_CREDENTIAL_TESTER_TLS_SERVERNAME',
    253,
  );
  if (mode === 'verify-full' && !isPostgresTlsDnsServername(servername)) {
    throw configFailure(
      'PostgreSQL TLS servername must be an explicit DNS name',
    );
  }
  const caFile = boundedValue(
    environment,
    'QL3_POSTGRES_AI_CREDENTIAL_TESTER_TLS_CA_FILE',
    4_096,
  );
  if (mode === 'disable' && caFile !== undefined) {
    throw configFailure('PostgreSQL CA file cannot be used with disabled TLS');
  }
  let ca: string | undefined;
  if (caFile !== undefined) {
    try {
      ca = loadPostgresCertificateAuthorityFile(caFile);
    } catch {
      throw configFailure('PostgreSQL CA file is invalid');
    }
  }
  const applicationName =
    boundedValue(
      environment,
      'QL3_POSTGRES_AI_CREDENTIAL_TESTER_APPLICATION_NAME',
      63,
    ) ?? 'qinglong3-ai-credential-tester';
  if (!SAFE_APPLICATION_NAME.test(applicationName)) {
    throw configFailure('PostgreSQL application name is invalid');
  }
  return Object.freeze({
    connection: Object.freeze({
      ...connection,
      tls:
        mode === 'disable'
          ? Object.freeze({ mode: 'disable' as const })
          : Object.freeze({
              mode: 'verify-full' as const,
              servername: servername!,
              ...(ca === undefined ? {} : { ca }),
            }),
    }),
    pool: Object.freeze({
      applicationName,
      maxConnections: integerValue(
        environment,
        'QL3_POSTGRES_AI_CREDENTIAL_TESTER_POOL_MAX',
        1,
        1,
        1,
      ),
      idleTimeoutMs: integerValue(
        environment,
        'QL3_POSTGRES_AI_CREDENTIAL_TESTER_IDLE_TIMEOUT_MS',
        1_000,
        100,
        10_000,
      ),
      connectionTimeoutMs: integerValue(
        environment,
        'QL3_POSTGRES_AI_CREDENTIAL_TESTER_CONNECTION_TIMEOUT_MS',
        5_000,
        100,
        60_000,
      ),
    }),
  });
}

function loadNetworkPolicyDenyCanary(
  environment: ModelProviderCredentialTestExecutorProcessEnvironment,
): Readonly<{ host: string; port: number }> | undefined {
  const host = boundedValue(
    environment,
    'QL3_MODEL_PROVIDER_CREDENTIAL_TEST_DENY_CANARY_HOST',
    253,
  );
  const portValue = boundedValue(
    environment,
    'QL3_MODEL_PROVIDER_CREDENTIAL_TEST_DENY_CANARY_PORT',
    5,
  );
  if (host === undefined && portValue === undefined) return undefined;
  if (
    !isPostgresTlsDnsServername(host) ||
    portValue === undefined ||
    !/^[1-9][0-9]{0,4}$/.test(portValue)
  ) {
    throw configFailure('network policy deny canary is invalid');
  }
  const port = Number(portValue);
  if (port > 65_535) {
    throw configFailure('network policy deny canary is invalid');
  }
  return Object.freeze({ host, port });
}

export function loadModelProviderCredentialTestExecutorProcessConfig(
  environment: ModelProviderCredentialTestExecutorProcessEnvironment,
): Readonly<ModelProviderCredentialTestExecutorProcessConfig> {
  if (!environment || typeof environment !== 'object') {
    throw configFailure('environment is invalid');
  }
  if (
    !booleanValue(
      environment,
      'QL3_MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTOR_ENABLED',
    )
  ) {
    return Object.freeze({ enabled: false as const });
  }
  if (environment.QL3_PROFILE !== 'cluster-admin') {
    throw configFailure('QL3_PROFILE must be cluster-admin');
  }
  const networkPolicyDenyCanary = loadNetworkPolicyDenyCanary(environment);
  return Object.freeze({
    enabled: true as const,
    profile: 'cluster-admin' as const,
    commandFile: absolutePath(
      environment,
      'QL3_MODEL_PROVIDER_CREDENTIAL_TEST_COMMAND_FILE',
    ),
    allowlistFile: absolutePath(
      environment,
      'QL3_MODEL_PROVIDER_CREDENTIAL_TEST_ALLOWLIST_FILE',
    ),
    secretRootDirectory: absolutePath(
      environment,
      'QL3_MODEL_PROVIDER_CREDENTIAL_TEST_SECRET_ROOT',
    ),
    ...(networkPolicyDenyCanary === undefined
      ? {}
      : { networkPolicyDenyCanary }),
    database: loadConnection(environment),
  });
}

function exact(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function normalizeCommand(
  value: unknown,
): Readonly<ModelProviderCredentialTestExecutorCommand> {
  if (
    !exact(value, ['executionId', 'schemaVersion', 'testId']) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (value as { executionId?: unknown }).executionId !== 'string' ||
    !UUID_V4_PATTERN.test((value as { executionId: string }).executionId) ||
    typeof (value as { testId?: unknown }).testId !== 'string' ||
    !UUID_V4_PATTERN.test((value as { testId: string }).testId)
  ) {
    throw configFailure('command is invalid');
  }
  const command = value as ModelProviderCredentialTestExecutorCommand;
  return Object.freeze({
    schemaVersion: 1 as const,
    executionId: command.executionId,
    testId: command.testId,
  });
}

function readJson(filePath: string, maximumBytes: number): unknown {
  const bytes = readManagementTlsFile(filePath, false, configFailure);
  try {
    if (bytes.length > maximumBytes)
      throw configFailure('authority file is too large');
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (
      error instanceof ModelProviderCredentialTestExecutorProcessConfigError
    ) {
      throw error;
    }
    throw configFailure('authority file is invalid');
  } finally {
    bytes.fill(0);
  }
}

function readCommand(
  filePath: string,
): Readonly<ModelProviderCredentialTestExecutorCommand> {
  return normalizeCommand(readJson(filePath, MAX_COMMAND_BYTES));
}

function readAllowlist(
  filePath: string,
): Readonly<ModelProviderCredentialTestAllowlist> {
  try {
    return normalizeModelProviderCredentialTestAllowlist(
      readJson(
        filePath,
        MAX_ALLOWLIST_BYTES,
      ) as ModelProviderCredentialTestAllowlist,
    );
  } catch (error) {
    if (
      error instanceof ModelProviderCredentialTestExecutorProcessConfigError
    ) {
      throw error;
    }
    throw configFailure('allowlist is invalid');
  }
}

export async function runModelProviderCredentialTestExecutorProcess(
  options: RunModelProviderCredentialTestExecutorProcessOptions,
): Promise<Readonly<ModelProviderCredentialTestExecutorProcessResult>> {
  const expectedKeys = ['environment'];
  for (const key of [
    'allowlist',
    'assertReady',
    'command',
    'executor',
    'fetch',
    'monotonicNow',
    'now',
    'openDatabase',
    'secrets',
    'transportReady',
  ]) {
    if (
      (options as unknown as Record<string, unknown> | undefined)?.[key] !==
      undefined
    ) {
      expectedKeys.push(key);
    }
  }
  if (!exact(options, expectedKeys)) throw configFailure('options are invalid');
  const config = loadModelProviderCredentialTestExecutorProcessConfig(
    options.environment,
  );
  if (!config.enabled) return Object.freeze({ status: 'disabled' as const });
  const command = options.command
    ? normalizeCommand(options.command)
    : readCommand(config.commandFile);
  const allowlist = options.allowlist
    ? normalizeModelProviderCredentialTestAllowlist(options.allowlist)
    : readAllowlist(config.allowlistFile);
  const openDatabase =
    options.openDatabase ??
    createPostgresDatabaseOpener({
      role: 'ai-credential-tester',
      connection: config.database.connection,
      pool: config.database.pool,
      onPoolError() {
        // In-flight queries own one-shot availability; there is no listener to withdraw.
      },
    });
  const database = await openDatabase();
  try {
    const evidence = await (
      options.assertReady ?? assertPostgresModelProviderCredentialTesterReady
    )(database.pool);
    const secrets =
      options.secrets ??
      (await createProjectedModelProviderSecretMaterialProvider({
        rootDirectory: config.secretRootDirectory,
      }));
    let observedTransportFailureCode: string | undefined;
    let observedTransportRequestDigest: string | undefined;
    let observedTransportEndpoint:
      | Readonly<{ addressSha256: string; port: number }>
      | undefined;
    const configuredFetch = options.fetch ?? globalThis.fetch;
    const observedFetch: typeof globalThis.fetch = async (input, init) => {
      const requestDigest = transportRequestDigest(input, init);
      try {
        return await configuredFetch(input, init);
      } catch (error) {
        observedTransportFailureCode = transportFailureCode(error);
        observedTransportRequestDigest = requestDigest;
        observedTransportEndpoint = transportFailureEndpoint(error);
        throw error;
      }
    };
    const executor =
      options.executor ??
      createModelProviderCredentialTestExecutor({
        repository: new PostgresModelProviderCredentialTestExecutionRepository(
          database.pool,
        ),
        credentials: new PostgresModelProviderCredentialReader(database.pool),
        secrets,
        fetch: observedFetch,
        transportReady:
          options.transportReady ??
          ((baseUrl, signal) =>
            waitForTransportReady(
              baseUrl,
              signal,
              config.networkPolicyDenyCanary,
            )),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.monotonicNow === undefined
          ? {}
          : { monotonicNow: options.monotonicNow }),
      });
    const result = await executor.execute({
      executionId: command.executionId,
      testId: command.testId,
      allowlist,
    });
    return Object.freeze({
      status: 'completed' as const,
      database: evidence,
      test: result,
      ...(observedTransportFailureCode === undefined
        ? {}
        : {
            transportFailureCode: observedTransportFailureCode,
            transportRequestDigest: observedTransportRequestDigest!,
            ...(observedTransportEndpoint === undefined
              ? {}
              : {
                  transportAddressSha256:
                    observedTransportEndpoint.addressSha256,
                  transportPort: observedTransportEndpoint.port,
                }),
          }),
    });
  } finally {
    await database.close();
  }
}
