import { randomUUID, X509Certificate } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { TextDecoder } from 'node:util';

import {
  ClusterPluginPackageManagementClientConfigurationError,
  readCanonicalFile,
} from '../management-support/managementClientConfiguration';
import {
  InvalidClusterCopilotClientCommandError,
  InvalidClusterCopilotClientResponseError,
  normalizeClusterCopilotClientCommand,
  prepareClusterCopilotClientRequest,
  validateClusterCopilotClientResponse,
  type ClusterCopilotClientCommand,
  type ClusterCopilotClientOperation,
} from './contracts';

export {
  CLUSTER_COPILOT_CLIENT_COMMAND_SCHEMA,
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_RESPONSE_SCHEMA,
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESPONSE_SCHEMA,
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESPONSE_SCHEMA,
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_REQUEST_SCHEMA,
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_RESPONSE_SCHEMA,
  InvalidClusterCopilotClientCommandError,
  InvalidClusterCopilotClientResponseError,
  normalizeClusterCopilotClientCommand,
  prepareClusterCopilotClientRequest,
  validateClusterCopilotClientResponse,
} from './contracts';
export type {
  ClusterCopilotClientCommand,
  ClusterCopilotClientOperation,
  ClusterCopilotClientPreparedRequest,
} from './contracts';

export const CLUSTER_COPILOT_CLIENT_CONFIG_SCHEMA =
  'qinglong/cluster-copilot-client-config@v1' as const;

export interface ClusterCopilotClientPaths {
  readonly configFile: string;
  readonly commandFile: string;
  readonly credentialFile: string;
}

export interface ClusterCopilotCommandExecution {
  readonly configFile: string;
  readonly credentialFile: string;
  readonly command: unknown;
}

export interface ClusterCopilotClientOptions {
  readonly createRequestId?: () => string;
  readonly lookup?: LookupFunction;
}

export interface ClusterCopilotClientResult {
  readonly schemaVersion: 1;
  readonly operation: ClusterCopilotClientOperation;
  readonly requestId: string;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface ClusterCopilotClientConfigurationSummary {
  readonly schemaVersion: 1;
  readonly transport: 'https';
  readonly clientCertificate: 'forbidden';
}

export interface ClusterCopilotClientReadiness {
  readonly schemaVersion: 1;
  readonly transport: 'https';
  readonly ready: boolean;
}

interface PreparedClusterCopilotClientConfiguration {
  readonly endpoint: URL;
  readonly servername: string;
  readonly port: number;
  readonly requestTimeoutMs: number;
  readonly caBytes: Buffer;
  dispose(): void;
}

interface JsonResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly rawHeaders: readonly string[];
  readonly body: unknown;
}

export class ClusterCopilotClientConfigurationError extends TypeError {
  readonly code = 'QL3_CLUSTER_COPILOT_CLIENT_CONFIG_INVALID';

  constructor() {
    super('Cluster Copilot client configuration is invalid');
    this.name = 'ClusterCopilotClientConfigurationError';
  }
}

export class ClusterCopilotClientRequestError extends Error {
  readonly code = 'QL3_CLUSTER_COPILOT_CLIENT_REQUEST_FAILED';

  constructor(options?: ErrorOptions) {
    super('Cluster Copilot client request failed', options);
    this.name = 'ClusterCopilotClientRequestError';
  }
}

export class ClusterCopilotClientRemoteError extends Error {
  readonly code = 'QL3_CLUSTER_COPILOT_CLIENT_REMOTE_REJECTED';

  constructor(
    readonly statusCode: number,
    readonly responseCode: string,
    readonly requestId: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super('Cluster Copilot server rejected the request');
    this.name = 'ClusterCopilotClientRemoteError';
  }
}

const MAXIMUM_CONFIG_BYTES = 16 * 1024;
const MAXIMUM_CA_BYTES = 256 * 1024;
const MAXIMUM_COMMAND_BYTES = 16 * 1024;
const MAXIMUM_CREDENTIAL_BYTES = 256;
const MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_READINESS_RESPONSE_BYTES = 1_024;
const DNS_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const API_CREDENTIAL =
  /^ql3c_[A-Za-z0-9][A-Za-z0-9._:-]{0,63}_[A-Za-z0-9_-]{43}$/;
const RESPONSE_CODE = /^[a-z][a-z0-9_]{0,127}$/;

function configurationFailure(): never {
  throw new ClusterCopilotClientConfigurationError();
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return configurationFailure();
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return configurationFailure();
  }
  return value as Record<string, unknown>;
}

function decodeJson(bytes: Buffer, kind: 'config' | 'command'): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    if (kind === 'command') {
      throw new InvalidClusterCopilotClientCommandError();
    }
    return configurationFailure();
  }
}

function prepareConfiguration(
  configFile: string,
): PreparedClusterCopilotClientConfiguration {
  let configBytes: Buffer | undefined;
  let caBytes: Buffer | undefined;
  try {
    configBytes = readCanonicalFile(
      configFile,
      MAXIMUM_CONFIG_BYTES,
      'private',
    );
    const config = exact(decodeJson(configBytes, 'config'), [
      'caFile',
      'endpoint',
      'requestTimeoutMs',
      'schema',
      'servername',
    ]);
    if (
      config.schema !== CLUSTER_COPILOT_CLIENT_CONFIG_SCHEMA ||
      typeof config.endpoint !== 'string' ||
      typeof config.servername !== 'string' ||
      !DNS_NAME.test(config.servername) ||
      isIP(config.servername) !== 0 ||
      typeof config.caFile !== 'string' ||
      !Number.isSafeInteger(config.requestTimeoutMs) ||
      (config.requestTimeoutMs as number) < 1_000 ||
      (config.requestTimeoutMs as number) > 120_000
    ) {
      return configurationFailure();
    }
    let endpoint: URL;
    try {
      endpoint = new URL(config.endpoint);
    } catch {
      return configurationFailure();
    }
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username !== '' ||
      endpoint.password !== '' ||
      endpoint.search !== '' ||
      endpoint.hash !== '' ||
      endpoint.pathname !== '/' ||
      endpoint.hostname !== config.servername ||
      isIP(endpoint.hostname) !== 0
    ) {
      return configurationFailure();
    }
    const port = endpoint.port === '' ? 443 : Number(endpoint.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      return configurationFailure();
    }
    caBytes = readCanonicalFile(
      config.caFile,
      MAXIMUM_CA_BYTES,
      'public-integrity',
    );
    try {
      new X509Certificate(caBytes);
    } catch {
      return configurationFailure();
    }
    let disposed = false;
    return Object.freeze({
      endpoint,
      servername: config.servername,
      port,
      requestTimeoutMs: config.requestTimeoutMs as number,
      caBytes,
      dispose() {
        if (disposed) return;
        disposed = true;
        caBytes?.fill(0);
      },
    });
  } catch (error) {
    caBytes?.fill(0);
    if (error instanceof ClusterCopilotClientConfigurationError) throw error;
    throw new ClusterCopilotClientConfigurationError();
  } finally {
    configBytes?.fill(0);
  }
}

function validateOptions(
  options: ClusterCopilotClientOptions | undefined,
): Readonly<ClusterCopilotClientOptions> {
  if (options === undefined) return Object.freeze({});
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) => key !== 'createRequestId' && key !== 'lookup',
    ) ||
    (options.createRequestId !== undefined &&
      typeof options.createRequestId !== 'function') ||
    (options.lookup !== undefined && typeof options.lookup !== 'function')
  ) {
    return configurationFailure();
  }
  return Object.freeze({ ...options });
}

function rawHeaderCount(rawHeaders: readonly string[], name: string): number {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function responseHeadersValid(
  response: JsonResponse,
  byteLength: number,
): boolean {
  const contentLength = response.headers['content-length'];
  return (
    rawHeaderCount(response.rawHeaders, 'content-type') === 1 &&
    response.headers['content-type'] === 'application/json; charset=utf-8' &&
    response.headers['content-encoding'] === undefined &&
    rawHeaderCount(response.rawHeaders, 'content-length') <= 1 &&
    (contentLength === undefined ||
      (typeof contentLength === 'string' &&
        /^(?:0|[1-9][0-9]*)$/.test(contentLength) &&
        Number(contentLength) === byteLength))
  );
}

function readinessStatus(value: unknown): 'ready' | 'not_ready' {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClusterCopilotClientRequestError();
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    !Object.hasOwn(record, 'status') ||
    (record.status !== 'ready' && record.status !== 'not_ready')
  ) {
    throw new ClusterCopilotClientRequestError();
  }
  return record.status;
}

function requestJson(
  prepared: PreparedClusterCopilotClientConfiguration,
  request: Readonly<{
    method: 'GET' | 'POST';
    path: string;
    requestId?: string;
    authorization?: string;
    body?: Buffer;
  }>,
  maximumResponseBytes: number,
  options: Readonly<ClusterCopilotClientOptions>,
): Promise<Readonly<JsonResponse>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let length = 0;
    const clearChunks = (): void => {
      for (const chunk of chunks) chunk.fill(0);
    };
    const finish = (error: unknown, result?: Readonly<JsonResponse>): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result!);
    };
    const outgoing = httpsRequest(
      {
        protocol: 'https:',
        hostname: prepared.endpoint.hostname,
        port: prepared.port,
        path: request.path,
        method: request.method,
        servername: prepared.servername,
        ca: prepared.caBytes,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        rejectUnauthorized: true,
        agent: false,
        ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
        headers: {
          accept: 'application/json',
          'accept-encoding': 'identity',
          connection: 'close',
          ...(request.authorization === undefined
            ? {}
            : { authorization: request.authorization }),
          ...(request.requestId === undefined
            ? {}
            : { 'x-request-id': request.requestId }),
          ...(request.body === undefined
            ? {}
            : {
                'content-type': 'application/json; charset=utf-8',
                'content-length': String(request.body.length),
              }),
        },
      },
      (incoming) => {
        incoming.once('aborted', () => {
          clearChunks();
          finish(new ClusterCopilotClientRequestError());
        });
        incoming.once('error', (cause) => {
          clearChunks();
          finish(new ClusterCopilotClientRequestError({ cause }));
        });
        incoming.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += bytes.length;
          if (length > maximumResponseBytes) {
            bytes.fill(0);
            clearChunks();
            const error = new ClusterCopilotClientRequestError();
            incoming.destroy();
            outgoing.destroy(error);
            finish(error);
            return;
          }
          chunks.push(bytes);
        });
        incoming.once('end', () => {
          const bytes = Buffer.concat(chunks, length);
          try {
            const provisional: JsonResponse = Object.freeze({
              statusCode: incoming.statusCode ?? 0,
              headers: incoming.headers,
              rawHeaders: Object.freeze([...incoming.rawHeaders]),
              body: null,
            });
            if (!responseHeadersValid(provisional, bytes.length)) {
              throw new ClusterCopilotClientRequestError();
            }
            let body: unknown;
            try {
              body = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(bytes),
              );
            } catch (cause) {
              throw new ClusterCopilotClientRequestError({ cause });
            }
            finish(
              undefined,
              Object.freeze({ ...provisional, body }),
            );
          } catch (error) {
            finish(
              error instanceof ClusterCopilotClientRequestError
                ? error
                : new ClusterCopilotClientRequestError({
                    cause: error instanceof Error ? error : undefined,
                  }),
            );
          } finally {
            bytes.fill(0);
            clearChunks();
          }
        });
      },
    );
    outgoing.setTimeout(prepared.requestTimeoutMs, () => {
      outgoing.destroy(new ClusterCopilotClientRequestError());
    });
    outgoing.once('error', (cause) => {
      clearChunks();
      finish(
        cause instanceof ClusterCopilotClientRequestError
          ? cause
          : new ClusterCopilotClientRequestError({ cause }),
      );
    });
    outgoing.end(request.body);
  });
}

function responseRequestId(
  response: JsonResponse,
  expected: string,
): string {
  const value = response.headers['x-request-id'];
  if (
    rawHeaderCount(response.rawHeaders, 'x-request-id') !== 1 ||
    typeof value !== 'string' ||
    value !== expected
  ) {
    throw new ClusterCopilotClientRequestError();
  }
  return value;
}

function retryAfterSeconds(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,3}$/.test(value)) {
    return null;
  }
  const seconds = Number(value);
  return seconds <= 3_600 ? seconds : null;
}

function remoteCode(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClusterCopilotClientRequestError();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length < 1 ||
    keys.length > 3 ||
    keys[0] !== 'code' ||
    keys.some((key) => key !== 'code' && key !== 'reason' && key !== 'schema') ||
    typeof record.code !== 'string' ||
    !RESPONSE_CODE.test(record.code)
  ) {
    throw new ClusterCopilotClientRequestError();
  }
  return record.code;
}

export function validateClusterCopilotClientConfiguration(
  configFile: string,
): Readonly<ClusterCopilotClientConfigurationSummary> {
  const prepared = prepareConfiguration(configFile);
  try {
    return Object.freeze({
      schemaVersion: 1,
      transport: 'https',
      clientCertificate: 'forbidden',
    });
  } finally {
    prepared.dispose();
  }
}

function readCredentialBytes(credentialFile: string): Buffer {
  let bytes: Buffer | undefined;
  try {
    bytes = readCanonicalFile(
      credentialFile,
      MAXIMUM_CREDENTIAL_BYTES,
      'private',
    );
    if (
      bytes.some((byte) => byte > 0x7f) ||
      !API_CREDENTIAL.test(bytes.toString('ascii'))
    ) {
      return configurationFailure();
    }
    return bytes;
  } catch (error) {
    bytes?.fill(0);
    if (
      error instanceof ClusterCopilotClientConfigurationError
    ) {
      throw error;
    }
    throw new ClusterCopilotClientConfigurationError();
  }
}

export function validateClusterCopilotClientCredentialFile(
  credentialFile: string,
): void {
  const bytes = readCredentialBytes(credentialFile);
  bytes.fill(0);
}

export async function probeClusterCopilotClientReadiness(
  configFile: string,
  options?: ClusterCopilotClientOptions,
): Promise<Readonly<ClusterCopilotClientReadiness>> {
  const normalizedOptions = validateOptions(options);
  const prepared = prepareConfiguration(configFile);
  try {
    const response = await requestJson(
      prepared,
      Object.freeze({ method: 'GET', path: '/readyz' }),
      MAXIMUM_READINESS_RESPONSE_BYTES,
      normalizedOptions,
    );
    const status = readinessStatus(response.body);
    const ready = response.statusCode === 200 && status === 'ready';
    const notReady =
      response.statusCode === 503 && status === 'not_ready';
    if (!ready && !notReady) throw new ClusterCopilotClientRequestError();
    return Object.freeze({ schemaVersion: 1, transport: 'https', ready });
  } catch (error) {
    if (
      error instanceof ClusterCopilotClientConfigurationError ||
      error instanceof ClusterCopilotClientRequestError
    ) {
      throw error;
    }
    throw new ClusterCopilotClientRequestError({
      cause: error instanceof Error ? error : undefined,
    });
  } finally {
    prepared.dispose();
  }
}

async function executeNormalizedClusterCopilotCommand(
  configFile: string,
  credentialFile: string,
  command: Readonly<ClusterCopilotClientCommand>,
  options: Readonly<ClusterCopilotClientOptions>,
): Promise<Readonly<ClusterCopilotClientResult>> {
  let credentialBytes: Buffer | undefined;
  let bodyBytes: Buffer | undefined;
  let prepared: PreparedClusterCopilotClientConfiguration | undefined;
  try {
    prepared = prepareConfiguration(configFile);
    credentialBytes = readCredentialBytes(credentialFile);
    const credential = credentialBytes.toString('ascii');
    const transportRequestId =
      command.operation === 'inspect' || command.operation === 'output'
        ? (options.createRequestId ?? randomUUID)()
        : undefined;
    const request = prepareClusterCopilotClientRequest(
      command,
      transportRequestId,
    );
    if (request.body !== null) {
      bodyBytes = Buffer.from(JSON.stringify(request.body), 'utf8');
      if (
        bodyBytes.length < 2 ||
        bodyBytes.length > MAXIMUM_COMMAND_BYTES
      ) {
        return configurationFailure();
      }
    }
    const response = await requestJson(
      prepared,
      Object.freeze({
        method: request.method,
        path: request.path,
        requestId: request.requestId,
        authorization: `Bearer ${credential}`,
        ...(bodyBytes === undefined ? {} : { body: bodyBytes }),
      }),
      MAXIMUM_RESPONSE_BYTES,
      options,
    );
    const requestId = responseRequestId(response, request.requestId);
    if (request.acceptedStatusCodes.includes(response.statusCode)) {
      return Object.freeze({
        schemaVersion: 1,
        operation: command.operation,
        requestId,
        result: validateClusterCopilotClientResponse(response.body, command),
      });
    }
    if (response.statusCode >= 400 && response.statusCode <= 599) {
      throw new ClusterCopilotClientRemoteError(
        response.statusCode,
        remoteCode(response.body),
        requestId,
        retryAfterSeconds(response.headers['retry-after']),
      );
    }
    throw new ClusterCopilotClientRequestError();
  } catch (error) {
    if (
      error instanceof ClusterPluginPackageManagementClientConfigurationError
    ) {
      throw new ClusterCopilotClientConfigurationError();
    }
    if (
      error instanceof ClusterCopilotClientConfigurationError ||
      error instanceof InvalidClusterCopilotClientCommandError ||
      error instanceof InvalidClusterCopilotClientResponseError ||
      error instanceof ClusterCopilotClientRequestError ||
      error instanceof ClusterCopilotClientRemoteError
    ) {
      throw error;
    }
    throw new ClusterCopilotClientRequestError({
      cause: error instanceof Error ? error : undefined,
    });
  } finally {
    bodyBytes?.fill(0);
    credentialBytes?.fill(0);
    prepared?.dispose();
  }
}

export async function executeClusterCopilotCommand(
  execution: ClusterCopilotCommandExecution,
  options?: ClusterCopilotClientOptions,
): Promise<Readonly<ClusterCopilotClientResult>> {
  const normalizedOptions = validateOptions(options);
  const record = exact(execution, [
    'command',
    'configFile',
    'credentialFile',
  ]);
  const command = normalizeClusterCopilotClientCommand(record.command);
  return executeNormalizedClusterCopilotCommand(
    record.configFile as string,
    record.credentialFile as string,
    command,
    normalizedOptions,
  );
}

export async function executeClusterCopilotClient(
  paths: ClusterCopilotClientPaths,
  options?: ClusterCopilotClientOptions,
): Promise<Readonly<ClusterCopilotClientResult>> {
  const normalizedOptions = validateOptions(options);
  const record = exact(paths, [
    'commandFile',
    'configFile',
    'credentialFile',
  ]);
  let commandBytes: Buffer | undefined;
  try {
    commandBytes = readCanonicalFile(
      record.commandFile as string,
      MAXIMUM_COMMAND_BYTES,
      'private',
    );
    const command = normalizeClusterCopilotClientCommand(
      decodeJson(commandBytes, 'command'),
    );
    return await executeNormalizedClusterCopilotCommand(
      record.configFile as string,
      record.credentialFile as string,
      command,
      normalizedOptions,
    );
  } catch (error) {
    if (
      error instanceof ClusterPluginPackageManagementClientConfigurationError
    ) {
      throw new ClusterCopilotClientConfigurationError();
    }
    throw error;
  } finally {
    commandBytes?.fill(0);
  }
}
