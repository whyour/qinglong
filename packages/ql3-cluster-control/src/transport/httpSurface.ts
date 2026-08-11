// Transport owns bounded HTTP/TLS parsing, admission dispatch and drain.
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
  type ServerOptions as HttpsServerOptions,
} from 'node:https';
import type {
  ClusterControlAdmissionDisposer,
  ClusterControlReadinessEvidence,
} from '@qinglong/runtime-core';
import {
  createClusterControlAuthenticationShield,
  type ClusterControlAuthenticationShieldRejectionReason,
} from '../authentication/authenticationShield';

export const CLUSTER_CONTROL_HTTP_DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 5800,
  maxHeaderBytes: 16 * 1024,
  maxBodyBytes: 1024 * 1024,
  maxResponseBytes: 1024 * 1024,
  maxInFlightRequests: 64,
  authenticationRateWindowMs: 60_000,
  authenticationRatePerPeer: 300,
  authenticationRateGlobal: 1_200,
  authenticationRateMaxPeers: 4_096,
  requestTimeoutMs: 15_000,
  drainTimeoutMs: 10_000,
});

export const CLUSTER_CONTROL_HTTP_HARD_LIMITS = Object.freeze({
  maxHeaderBytes: 64 * 1024,
  maxBodyBytes: 4 * 1024 * 1024,
  maxStreamingBodyBytes: 64 * 1024 * 1024 + 4 * 1024 + 4,
  maxResponseBytes: 4 * 1024 * 1024,
  maxInFlightRequests: 1024,
  authenticationRateWindowMs: 60 * 60_000,
  authenticationRatePerPeer: 1_000_000,
  authenticationRateGlobal: 1_000_000,
  authenticationRateMaxPeers: 65_536,
  requestTimeoutMs: 120_000,
  drainTimeoutMs: 120_000,
  maxUrlBytes: 8 * 1024,
});

export type ClusterControlHttpMethod =
  | 'DELETE'
  | 'GET'
  | 'PATCH'
  | 'POST'
  | 'PUT';

export interface ClusterControlAdmissionMetadata {
  readonly requestId: string;
  readonly method: ClusterControlHttpMethod;
  readonly path: string;
  readonly query: Readonly<Record<string, readonly string[]>>;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly signal: AbortSignal;
}

export interface ClusterControlAdmissionRequest
  extends ClusterControlAdmissionMetadata {
  readonly body: unknown | null;
}

export interface ClusterControlAdmissionResponse {
  readonly statusCode: number;
  readonly body?: unknown;
}

export interface ClusterControlPreparedJsonAdmission {
  readonly bodyMode?: 'json';
  handle(
    body: unknown | null,
  ): ClusterControlAdmissionResponse | Promise<ClusterControlAdmissionResponse>;
}

export interface ClusterControlStreamingAdmissionBody {
  readonly contentLength: number;
  readonly contentType: string;
  readonly chunks: AsyncIterable<Uint8Array>;
}

export interface ClusterControlPreparedStreamingAdmission {
  readonly bodyMode: 'stream';
  readonly contentType: string;
  readonly maximumBodyBytes: number;
  handleStream(
    body: ClusterControlStreamingAdmissionBody,
  ): ClusterControlAdmissionResponse | Promise<ClusterControlAdmissionResponse>;
}

export type ClusterControlPreparedAdmission =
  | ClusterControlPreparedJsonAdmission
  | ClusterControlPreparedStreamingAdmission;

export interface ClusterControlAdmissionPipeline {
  prepare(
    request: ClusterControlAdmissionMetadata,
  ): ClusterControlPreparedAdmission | Promise<ClusterControlPreparedAdmission>;
}

export interface ClusterControlHttpDiagnostic {
  readonly phase: 'request' | 'drain' | 'server';
  readonly requestId?: string;
  readonly method?: string;
  readonly path?: string;
}

export interface ClusterControlAuthenticationShieldEvent {
  readonly outcome: 'rate_limited' | 'unavailable';
  readonly reason: ClusterControlAuthenticationShieldRejectionReason;
}

export interface ClusterControlMutualTlsOptions {
  readonly privateKey: string | Buffer;
  readonly certificateChain: string | Buffer;
  readonly clientCertificateAuthorities: readonly (string | Buffer)[];
  readonly certificateRevocationLists?: readonly (string | Buffer)[];
}

export interface ClusterControlHttpSurfaceOptions {
  readonly host?: string;
  readonly port?: number;
  readonly maxHeaderBytes?: number;
  readonly maxBodyBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxInFlightRequests?: number;
  readonly authenticationRateWindowMs?: number;
  readonly authenticationRatePerPeer?: number;
  readonly authenticationRateGlobal?: number;
  readonly authenticationRateMaxPeers?: number;
  readonly requestTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  readonly mutualTls?: ClusterControlMutualTlsOptions;
  readonly onError?: (
    diagnostic: ClusterControlHttpDiagnostic,
    error: unknown,
  ) => void | Promise<void>;
  readonly onAuthenticationShieldEvent?: (
    event: ClusterControlAuthenticationShieldEvent,
  ) => void;
}

export interface ClusterControlHttpAddress {
  readonly host: string;
  readonly port: number;
}

export interface ClusterControlHttpSurface {
  readonly address: ClusterControlHttpAddress;
  reloadMutualTls(options: ClusterControlMutualTlsOptions): number;
  installAdmission(
    evidence: ClusterControlReadinessEvidence,
    pipeline: ClusterControlAdmissionPipeline,
  ): ClusterControlAdmissionDisposer;
  close(): Promise<void>;
}

export class ClusterControlHttpConfigurationError extends TypeError {
  constructor(message: string) {
    super(`Cluster-control HTTP configuration is invalid: ${message}`);
    this.name = 'ClusterControlHttpConfigurationError';
  }
}

export class ClusterControlAdmissionDrainTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Cluster-control HTTP admission did not drain within ${timeoutMs}ms`);
    this.name = 'ClusterControlAdmissionDrainTimeoutError';
  }
}

interface ResolvedHttpOptions {
  readonly host: string;
  readonly port: number;
  readonly maxHeaderBytes: number;
  readonly maxBodyBytes: number;
  readonly maxResponseBytes: number;
  readonly maxInFlightRequests: number;
  readonly authenticationRateWindowMs: number;
  readonly authenticationRatePerPeer: number;
  readonly authenticationRateGlobal: number;
  readonly authenticationRateMaxPeers: number;
  readonly requestTimeoutMs: number;
  readonly drainTimeoutMs: number;
  readonly mutualTls?: Readonly<{
    readonly privateKey: Buffer;
    readonly certificateChain: Buffer;
    readonly clientCertificateAuthorities: readonly Buffer[];
    readonly certificateRevocationLists: readonly Buffer[];
  }>;
  readonly onError?: ClusterControlHttpSurfaceOptions['onError'];
  readonly onAuthenticationShieldEvent?: ClusterControlHttpSurfaceOptions['onAuthenticationShieldEvent'];
}

interface AdmissionState {
  readonly evidence: ClusterControlReadinessEvidence;
  readonly pipeline: ClusterControlAdmissionPipeline;
  readonly controller: AbortController;
  readonly inFlight: Set<Promise<void>>;
}

const METHODS = new Set<ClusterControlHttpMethod>([
  'DELETE',
  'GET',
  'PATCH',
  'POST',
  'PUT',
]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const HOST_PATTERN = /^[A-Za-z0-9.:[\]-]{1,253}$/;
const MAX_TLS_MATERIAL_BYTES = 1024 * 1024;
type ClusterControlNodeServer = HttpServer | HttpsServer;

function boundedInteger(
  name: string,
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? defaultValue;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new ClusterControlHttpConfigurationError(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return resolved;
}

function tlsMaterial(name: string, value: string | Buffer): Buffer {
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
    throw new ClusterControlHttpConfigurationError(`${name} is invalid`);
  }
  const bytes = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from(value, 'utf8');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_TLS_MATERIAL_BYTES) {
    bytes.fill(0);
    throw new ClusterControlHttpConfigurationError(
      `${name} must be between 1 byte and 1 MiB`,
    );
  }
  return bytes;
}

function resolveMutualTls(
  value: ClusterControlMutualTlsOptions | undefined,
): ResolvedHttpOptions['mutualTls'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClusterControlHttpConfigurationError(
      'mutualTls must be an object',
    );
  }
  const actualKeys = Object.keys(value);
  const supportedKeys = new Set([
    'certificateChain',
    'certificateRevocationLists',
    'clientCertificateAuthorities',
    'privateKey',
  ]);
  if (
    actualKeys.some((key) => !supportedKeys.has(key)) ||
    !actualKeys.includes('certificateChain') ||
    !actualKeys.includes('clientCertificateAuthorities') ||
    !actualKeys.includes('privateKey')
  ) {
    throw new ClusterControlHttpConfigurationError(
      'mutualTls has unsupported fields',
    );
  }
  if (
    !Array.isArray(value.clientCertificateAuthorities) ||
    value.clientCertificateAuthorities.length < 1 ||
    value.clientCertificateAuthorities.length > 16
  ) {
    throw new ClusterControlHttpConfigurationError(
      'mutualTls.clientCertificateAuthorities must contain 1 to 16 certificates',
    );
  }
  if (
    value.certificateRevocationLists !== undefined &&
    (!Array.isArray(value.certificateRevocationLists) ||
      value.certificateRevocationLists.length < 1 ||
      value.certificateRevocationLists.length > 16)
  ) {
    throw new ClusterControlHttpConfigurationError(
      'mutualTls.certificateRevocationLists must contain 1 to 16 CRLs',
    );
  }
  const privateKey = tlsMaterial('mutualTls.privateKey', value.privateKey);
  const certificateChain = tlsMaterial(
    'mutualTls.certificateChain',
    value.certificateChain,
  );
  const clientCertificateAuthorities: Buffer[] = [];
  const certificateRevocationLists: Buffer[] = [];
  try {
    for (const authority of value.clientCertificateAuthorities) {
      clientCertificateAuthorities.push(
        tlsMaterial('mutualTls.clientCertificateAuthorities', authority),
      );
    }
    for (const revocationList of value.certificateRevocationLists ?? []) {
      certificateRevocationLists.push(
        tlsMaterial('mutualTls.certificateRevocationLists', revocationList),
      );
    }
  } catch (error) {
    privateKey.fill(0);
    certificateChain.fill(0);
    for (const authority of clientCertificateAuthorities) authority.fill(0);
    for (const revocationList of certificateRevocationLists) {
      revocationList.fill(0);
    }
    throw error;
  }
  return Object.freeze({
    privateKey,
    certificateChain,
    clientCertificateAuthorities: Object.freeze(clientCertificateAuthorities),
    certificateRevocationLists: Object.freeze(certificateRevocationLists),
  });
}

function eraseMutualTls(value: ResolvedHttpOptions['mutualTls']): void {
  if (!value) return;
  value.privateKey.fill(0);
  value.certificateChain.fill(0);
  for (const authority of value.clientCertificateAuthorities) authority.fill(0);
  for (const revocationList of value.certificateRevocationLists) {
    revocationList.fill(0);
  }
}

function secureContextOptions(
  value: NonNullable<ResolvedHttpOptions['mutualTls']>,
): Pick<HttpsServerOptions, 'ca' | 'cert' | 'crl' | 'key'> {
  return {
    key: value.privateKey,
    cert: value.certificateChain,
    ca: [...value.clientCertificateAuthorities],
    ...(value.certificateRevocationLists.length === 0
      ? {}
      : { crl: [...value.certificateRevocationLists] }),
  };
}

function resolveOptions(
  options: ClusterControlHttpSurfaceOptions,
): ResolvedHttpOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new ClusterControlHttpConfigurationError('options must be an object');
  }
  const host = options.host ?? CLUSTER_CONTROL_HTTP_DEFAULTS.host;
  if (!HOST_PATTERN.test(host)) {
    throw new ClusterControlHttpConfigurationError('host is invalid');
  }
  const mutualTls = resolveMutualTls(options.mutualTls);
  return {
    host,
    port: boundedInteger(
      'port',
      options.port,
      CLUSTER_CONTROL_HTTP_DEFAULTS.port,
      0,
      65_535,
    ),
    maxHeaderBytes: boundedInteger(
      'maxHeaderBytes',
      options.maxHeaderBytes,
      CLUSTER_CONTROL_HTTP_DEFAULTS.maxHeaderBytes,
      1024,
      CLUSTER_CONTROL_HTTP_HARD_LIMITS.maxHeaderBytes,
    ),
    maxBodyBytes: boundedInteger(
      'maxBodyBytes',
      options.maxBodyBytes,
      CLUSTER_CONTROL_HTTP_DEFAULTS.maxBodyBytes,
      1024,
      CLUSTER_CONTROL_HTTP_HARD_LIMITS.maxBodyBytes,
    ),
    maxResponseBytes: boundedInteger(
      'maxResponseBytes',
      options.maxResponseBytes,
      CLUSTER_CONTROL_HTTP_DEFAULTS.maxResponseBytes,
      1024,
      CLUSTER_CONTROL_HTTP_HARD_LIMITS.maxResponseBytes,
    ),
    maxInFlightRequests: boundedInteger(
      'maxInFlightRequests',
      options.maxInFlightRequests,
      CLUSTER_CONTROL_HTTP_DEFAULTS.maxInFlightRequests,
      1,
      CLUSTER_CONTROL_HTTP_HARD_LIMITS.maxInFlightRequests,
    ),
    authenticationRateWindowMs: boundedInteger(
      'authenticationRateWindowMs',
      options.authenticationRateWindowMs,
      CLUSTER_CONTROL_HTTP_DEFAULTS.authenticationRateWindowMs,
      1_000,
      CLUSTER_CONTROL_HTTP_HARD_LIMITS.authenticationRateWindowMs,
    ),
    authenticationRatePerPeer: boundedInteger(
      'authenticationRatePerPeer',
      options.authenticationRatePerPeer,
      CLUSTER_CONTROL_HTTP_DEFAULTS.authenticationRatePerPeer,
      1,
      CLUSTER_CONTROL_HTTP_HARD_LIMITS.authenticationRatePerPeer,
    ),
    authenticationRateGlobal: boundedInteger(
      'authenticationRateGlobal',
      options.authenticationRateGlobal,
      CLUSTER_CONTROL_HTTP_DEFAULTS.authenticationRateGlobal,
      1,
      CLUSTER_CONTROL_HTTP_HARD_LIMITS.authenticationRateGlobal,
    ),
    authenticationRateMaxPeers: boundedInteger(
      'authenticationRateMaxPeers',
      options.authenticationRateMaxPeers,
      CLUSTER_CONTROL_HTTP_DEFAULTS.authenticationRateMaxPeers,
      1,
      CLUSTER_CONTROL_HTTP_HARD_LIMITS.authenticationRateMaxPeers,
    ),
    requestTimeoutMs: boundedInteger(
      'requestTimeoutMs',
      options.requestTimeoutMs,
      CLUSTER_CONTROL_HTTP_DEFAULTS.requestTimeoutMs,
      100,
      CLUSTER_CONTROL_HTTP_HARD_LIMITS.requestTimeoutMs,
    ),
    drainTimeoutMs: boundedInteger(
      'drainTimeoutMs',
      options.drainTimeoutMs,
      CLUSTER_CONTROL_HTTP_DEFAULTS.drainTimeoutMs,
      100,
      CLUSTER_CONTROL_HTTP_HARD_LIMITS.drainTimeoutMs,
    ),
    ...(mutualTls === undefined ? {} : { mutualTls }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.onAuthenticationShieldEvent === undefined
      ? {}
      : {
          onAuthenticationShieldEvent: options.onAuthenticationShieldEvent,
        }),
  };
}

function requestId(headers: IncomingHttpHeaders): string {
  const candidate = headers['x-request-id'];
  return typeof candidate === 'string' && REQUEST_ID_PATTERN.test(candidate)
    ? candidate
    : randomUUID();
}

function normalizeHeaders(
  headers: IncomingHttpHeaders,
): Readonly<Record<string, string | readonly string[]>> {
  const normalized: Record<string, string | readonly string[]> = Object.create(
    null,
  ) as Record<string, string | readonly string[]>;
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') normalized[name] = value;
    else if (Array.isArray(value)) normalized[name] = Object.freeze([...value]);
  }
  return Object.freeze(normalized);
}

function normalizeQuery(
  parameters: URLSearchParams,
): Readonly<Record<string, readonly string[]>> {
  const grouped: Record<string, string[]> = Object.create(null) as Record<
    string,
    string[]
  >;
  for (const [name, value] of parameters) {
    (grouped[name] ??= []).push(value);
  }
  const normalized: Record<string, readonly string[]> = Object.create(
    null,
  ) as Record<string, readonly string[]>;
  for (const [name, values] of Object.entries(grouped)) {
    normalized[name] = Object.freeze([...values]);
  }
  return Object.freeze(normalized);
}

function responseOpen(response: ServerResponse): boolean {
  return !response.destroyed && !response.writableEnded;
}

function closeUnconsumedRequest(response: ServerResponse): void {
  if (responseOpen(response)) response.setHeader('connection', 'close');
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  maxResponseBytes: number,
  id?: string,
  head = false,
): void {
  if (!responseOpen(response)) return;
  let bytes: Buffer;
  try {
    const serialized = JSON.stringify(body);
    bytes = Buffer.from(serialized === undefined ? 'null' : serialized);
  } catch {
    statusCode = 500;
    bytes = Buffer.from('{"code":"invalid_response"}');
  }
  if (bytes.byteLength > maxResponseBytes) {
    statusCode = 500;
    bytes = Buffer.from('{"code":"response_too_large"}');
  }
  response.statusCode = statusCode;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', head ? 0 : bytes.byteLength);
  response.setHeader('x-content-type-options', 'nosniff');
  if (id) response.setHeader('x-request-id', id);
  response.end(head ? undefined : bytes);
}

async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<unknown | null> {
  const contentEncoding = request.headers['content-encoding'];
  if (contentEncoding && contentEncoding !== 'identity') {
    throw Object.assign(new Error('content encoding is not supported'), {
      statusCode: 415,
      code: 'unsupported_content_encoding',
    });
  }
  const lengthHeader = request.headers['content-length'];
  if (lengthHeader !== undefined) {
    if (!/^\d+$/.test(lengthHeader)) {
      throw Object.assign(new Error('content length is invalid'), {
        statusCode: 400,
        code: 'invalid_content_length',
      });
    }
    if (Number(lengthHeader) > maxBodyBytes) {
      throw Object.assign(new Error('request body is too large'), {
        statusCode: 413,
        code: 'request_too_large',
      });
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    if (signal.aborted) throw signal.reason;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBodyBytes) {
      throw Object.assign(new Error('request body is too large'), {
        statusCode: 413,
        code: 'request_too_large',
      });
    }
    chunks.push(bytes);
  }
  if (total === 0) return null;
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json') {
    throw Object.assign(new Error('content type is not supported'), {
      statusCode: 415,
      code: 'unsupported_content_type',
    });
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
  } catch {
    throw Object.assign(new Error('request JSON is invalid'), {
      statusCode: 400,
      code: 'invalid_json',
    });
  }
}

interface PreparedStreamingBody {
  readonly body: ClusterControlStreamingAdmissionBody;
  isComplete(): boolean;
}

function invalidStreamingRequest(
  message: string,
  statusCode: number,
  code: string,
): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function prepareStreamingBody(
  request: IncomingMessage,
  prepared: ClusterControlPreparedStreamingAdmission,
  signal: AbortSignal,
): PreparedStreamingBody {
  if (
    typeof prepared.contentType !== 'string' ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(
      prepared.contentType,
    ) ||
    !Number.isSafeInteger(prepared.maximumBodyBytes) ||
    prepared.maximumBodyBytes < 1 ||
    prepared.maximumBodyBytes >
      CLUSTER_CONTROL_HTTP_HARD_LIMITS.maxStreamingBodyBytes ||
    typeof prepared.handleStream !== 'function'
  ) {
    throw new Error('admission pipeline returned an invalid stream operation');
  }
  const contentEncoding = request.headers['content-encoding'];
  if (contentEncoding && contentEncoding !== 'identity') {
    throw invalidStreamingRequest(
      'content encoding is not supported',
      415,
      'unsupported_content_encoding',
    );
  }
  const lengthHeader = request.headers['content-length'];
  if (
    typeof lengthHeader !== 'string' ||
    !/^\d+$/.test(lengthHeader) ||
    !Number.isSafeInteger(Number(lengthHeader)) ||
    Number(lengthHeader) < 1
  ) {
    throw invalidStreamingRequest(
      'stream content length is invalid',
      400,
      'invalid_content_length',
    );
  }
  const contentLength = Number(lengthHeader);
  if (contentLength > prepared.maximumBodyBytes) {
    throw invalidStreamingRequest(
      'stream body is too large',
      413,
      'request_too_large',
    );
  }
  const contentType = request.headers['content-type']
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== prepared.contentType) {
    throw invalidStreamingRequest(
      'stream content type is not supported',
      415,
      'unsupported_content_type',
    );
  }

  let iterationStarted = false;
  let complete = false;
  const chunks = Object.freeze({
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      if (iterationStarted) {
        throw new Error('stream body can only be consumed once');
      }
      iterationStarted = true;
      let total = 0;
      for await (const chunk of request) {
        if (signal.aborted) throw signal.reason;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > contentLength) {
          throw invalidStreamingRequest(
            'stream content length does not match its body',
            400,
            'content_length_mismatch',
          );
        }
        yield bytes;
      }
      if (total !== contentLength) {
        throw invalidStreamingRequest(
          'stream content length does not match its body',
          400,
          'content_length_mismatch',
        );
      }
      complete = true;
    },
  });
  return {
    body: Object.freeze({ contentLength, contentType, chunks }),
    isComplete: () => complete,
  };
}

async function notifyError(
  options: ResolvedHttpOptions,
  diagnostic: ClusterControlHttpDiagnostic,
  error: unknown,
): Promise<void> {
  try {
    await options.onError?.(diagnostic, error);
  } catch {
    // Diagnostics cannot change HTTP ownership or error responses.
  }
}

function errorResponse(error: unknown): { statusCode: number; code: string } {
  if (error && typeof error === 'object') {
    const candidate = error as { statusCode?: unknown; code?: unknown };
    if (
      Number.isSafeInteger(candidate.statusCode) &&
      Number(candidate.statusCode) >= 400 &&
      Number(candidate.statusCode) <= 599 &&
      typeof candidate.code === 'string' &&
      /^[a-z][a-z0-9_]{0,63}$/.test(candidate.code)
    ) {
      return {
        statusCode: Number(candidate.statusCode),
        code: candidate.code,
      };
    }
  }
  return { statusCode: 500, code: 'internal_error' };
}

function withTimeoutSignal(
  timeoutMs: number,
  parent: AbortSignal,
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void =>
    controller.abort(
      Object.assign(new Error('admission is draining'), {
        statusCode: 503,
        code: 'admission_draining',
      }),
    );
  parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(
      Object.assign(new Error('request timed out'), {
        statusCode: 504,
        code: 'request_timeout',
      }),
    );
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
    },
  };
}

function raceWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

async function waitForDrain(
  state: AdmissionState,
  timeoutMs: number,
): Promise<void> {
  if (state.inFlight.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...state.inFlight]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ClusterControlAdmissionDrainTimeoutError(timeoutMs)),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function closeServer(
  server: ClusterControlNodeServer,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let completed = false;
    const finish = (error?: Error): void => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (
        error &&
        (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
      )
        reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, timeoutMs);
    timer.unref();
    server.close(finish);
    server.closeIdleConnections?.();
  });
}

/**
 * Starts a bounded, framework-free cluster HTTP surface. Only probes are
 * reachable before admission is installed; API requests are rejected before
 * their bodies are read until activation and recovery have completed.
 */
export async function startClusterControlHttpSurface(
  rawOptions: ClusterControlHttpSurfaceOptions,
): Promise<ClusterControlHttpSurface> {
  const options = resolveOptions(rawOptions);
  let admission: AdmissionState | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const authenticationShield = createClusterControlAuthenticationShield({
    windowMs: options.authenticationRateWindowMs,
    maxRequestsPerPeer: options.authenticationRatePerPeer,
    maxRequestsGlobal: options.authenticationRateGlobal,
    maxTrackedPeers: options.authenticationRateMaxPeers,
  });

  const secureServerOptions:
    | (HttpsServerOptions & {
        readonly maxHeaderSize: number;
      })
    | undefined = options.mutualTls
    ? {
        maxHeaderSize: options.maxHeaderBytes,
        ...secureContextOptions(options.mutualTls),
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        requestCert: true,
        rejectUnauthorized: true,
        handshakeTimeout: 10_000,
      }
    : undefined;
  let secureServer: HttpsServer | undefined;
  let server: ClusterControlNodeServer;
  try {
    secureServer = secureServerOptions
      ? createHttpsServer(secureServerOptions as HttpsServerOptions)
      : undefined;
    server =
      secureServer ??
      createHttpServer({ maxHeaderSize: options.maxHeaderBytes });
  } catch (error) {
    eraseMutualTls(options.mutualTls);
    throw new ClusterControlHttpConfigurationError(
      'mutualTls material could not create a secure context',
    );
  }
  let activeMutualTls = options.mutualTls;
  let tlsGeneration = secureServer ? 1 : 0;
  const tlsSocketGenerations = new WeakMap<object, number>();
  secureServer?.on('secureConnection', (socket) => {
    tlsSocketGenerations.set(socket, tlsGeneration);
  });
  server.requestTimeout = options.requestTimeoutMs;
  server.headersTimeout = Math.min(options.requestTimeoutMs, 10_000);
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;

  const runAdmission = async (
    state: AdmissionState,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    id: string,
    refundAuthenticationAttempt: () => void,
  ): Promise<void> => {
    const method = request.method;
    if (!method || !METHODS.has(method as ClusterControlHttpMethod)) {
      closeUnconsumedRequest(response);
      response.setHeader('allow', [...METHODS].join(', '));
      writeJson(
        response,
        405,
        { code: 'method_not_allowed' },
        options.maxResponseBytes,
        id,
      );
      return;
    }
    if (state.inFlight.size >= options.maxInFlightRequests) {
      refundAuthenticationAttempt();
      closeUnconsumedRequest(response);
      writeJson(
        response,
        503,
        { code: 'admission_capacity_exhausted' },
        options.maxResponseBytes,
        id,
      );
      return;
    }

    const timeout = withTimeoutSignal(
      options.requestTimeoutMs,
      state.controller.signal,
    );
    const work = (async () => {
      let handlerWork: Promise<ClusterControlAdmissionResponse> | undefined;
      let bodyConsumed = false;
      let streamingBody: PreparedStreamingBody | undefined;
      try {
        const metadata = Object.freeze({
          requestId: id,
          method: method as ClusterControlHttpMethod,
          path: url.pathname,
          query: normalizeQuery(url.searchParams),
          headers: normalizeHeaders(request.headers),
          signal: timeout.signal,
        });
        const prepared = await state.pipeline.prepare(metadata);
        refundAuthenticationAttempt();
        if (!prepared || typeof prepared !== 'object') {
          throw new Error('admission pipeline returned an invalid operation');
        }
        if (prepared.bodyMode === 'stream') {
          streamingBody = prepareStreamingBody(
            request,
            prepared,
            timeout.signal,
          );
          handlerWork = Promise.resolve(
            prepared.handleStream(streamingBody.body),
          );
        } else {
          if (
            (prepared.bodyMode !== undefined &&
              prepared.bodyMode !== 'json') ||
            typeof prepared.handle !== 'function'
          ) {
            throw new Error(
              'admission pipeline returned an invalid operation',
            );
          }
          const body = await readJsonBody(
            request,
            options.maxBodyBytes,
            timeout.signal,
          );
          bodyConsumed = true;
          handlerWork = Promise.resolve(prepared.handle(body));
        }
        const result = await raceWithSignal(handlerWork, timeout.signal);
        if (streamingBody && !streamingBody.isComplete()) {
          closeUnconsumedRequest(response);
          throw new Error(
            'stream admission handler did not consume the complete body',
          );
        }
        bodyConsumed = true;
        if (
          !result ||
          typeof result !== 'object' ||
          !Number.isSafeInteger(result.statusCode) ||
          result.statusCode < 200 ||
          result.statusCode > 599
        ) {
          throw new Error('admission handler returned an invalid response');
        }
        writeJson(
          response,
          result.statusCode,
          result.body ?? null,
          options.maxResponseBytes,
          id,
        );
      } catch (error) {
        const failure = errorResponse(error);
        if (!bodyConsumed && !streamingBody?.isComplete()) {
          closeUnconsumedRequest(response);
        }
        await notifyError(
          options,
          { phase: 'request', requestId: id, method, path: url.pathname },
          error,
        );
        writeJson(
          response,
          failure.statusCode,
          { code: failure.code },
          options.maxResponseBytes,
          id,
        );
      } finally {
        timeout.dispose();
        if (handlerWork) await handlerWork.catch(() => undefined);
      }
    })();
    state.inFlight.add(work);
    try {
      await work;
    } finally {
      state.inFlight.delete(work);
    }
  };

  server.on('request', (request, response) => {
    const id = requestId(request.headers);
    if (
      secureServer &&
      tlsSocketGenerations.get(request.socket) !== tlsGeneration
    ) {
      closeUnconsumedRequest(response);
      writeJson(
        response,
        503,
        { code: 'tls_context_reloaded' },
        options.maxResponseBytes,
        id,
      );
      return;
    }
    const rawUrl = request.url ?? '';
    if (
      !rawUrl.startsWith('/') ||
      Buffer.byteLength(rawUrl) > CLUSTER_CONTROL_HTTP_HARD_LIMITS.maxUrlBytes
    ) {
      closeUnconsumedRequest(response);
      writeJson(
        response,
        400,
        { code: 'invalid_url' },
        options.maxResponseBytes,
        id,
      );
      return;
    }
    let url: URL;
    try {
      url = new URL(rawUrl, 'http://cluster-control.invalid');
    } catch {
      closeUnconsumedRequest(response);
      writeJson(
        response,
        400,
        { code: 'invalid_url' },
        options.maxResponseBytes,
        id,
      );
      return;
    }
    const head = request.method === 'HEAD';
    const probe = url.pathname === '/livez' || url.pathname === '/readyz';
    if (probe && request.method !== 'GET' && !head) {
      closeUnconsumedRequest(response);
      response.setHeader('allow', 'GET, HEAD');
      writeJson(
        response,
        405,
        { code: 'method_not_allowed' },
        options.maxResponseBytes,
        id,
      );
      return;
    }
    if (url.pathname === '/livez') {
      writeJson(
        response,
        200,
        { status: 'live' },
        options.maxResponseBytes,
        id,
        head,
      );
      return;
    }
    if (url.pathname === '/readyz') {
      writeJson(
        response,
        admission ? 200 : 503,
        { status: admission ? 'ready' : 'not_ready' },
        options.maxResponseBytes,
        id,
        head,
      );
      return;
    }
    if (!(url.pathname === '/api/v3' || url.pathname.startsWith('/api/v3/'))) {
      closeUnconsumedRequest(response);
      writeJson(
        response,
        404,
        { code: 'not_found' },
        options.maxResponseBytes,
        id,
      );
      return;
    }
    const current = admission;
    if (!current) {
      closeUnconsumedRequest(response);
      writeJson(
        response,
        503,
        { code: 'not_ready' },
        options.maxResponseBytes,
        id,
      );
      return;
    }
    const shield = authenticationShield.consume(request.socket.remoteAddress);
    if (!shield.allowed) {
      const unavailable = shield.reason === 'clock';
      try {
        options.onAuthenticationShieldEvent?.(
          Object.freeze({
            outcome: unavailable ? 'unavailable' : 'rate_limited',
            reason: shield.reason,
          }),
        );
      } catch {
        // A metrics/event observer cannot change transport admission.
      }
      response.setHeader(
        'retry-after',
        String(Math.max(1, Math.ceil(shield.retryAfterMs / 1000))),
      );
      closeUnconsumedRequest(response);
      writeJson(
        response,
        unavailable ? 503 : 429,
        {
          code: unavailable
            ? 'authentication_shield_unavailable'
            : 'authentication_rate_limited',
        },
        options.maxResponseBytes,
        id,
      );
      return;
    }
    void runAdmission(
      current,
      request,
      response,
      url,
      id,
      shield.refund,
    );
  });

  server.on('clientError', (_error, socket) => {
    if (!socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, options.host);
  });

  server.on('error', (error) => {
    void notifyError(options, { phase: 'server' }, error);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server, options.drainTimeoutMs);
    throw new Error('Cluster-control HTTP server has no TCP address');
  }
  const publicAddress = Object.freeze({
    host: options.host,
    port: address.port,
  });

  return {
    address: publicAddress,
    reloadMutualTls(rawMutualTls) {
      if (closed) throw new Error('Cluster-control HTTP surface is closed');
      if (!secureServer || !activeMutualTls) {
        throw new Error('Cluster-control HTTP surface does not use mutual TLS');
      }
      const next = resolveMutualTls(rawMutualTls);
      if (!next) {
        throw new ClusterControlHttpConfigurationError(
          'mutualTls reload material is required',
        );
      }
      const ticketKeys = randomBytes(48);
      try {
        secureServer.setTicketKeys(ticketKeys);
        secureServer.setSecureContext(secureContextOptions(next));
      } catch {
        eraseMutualTls(next);
        throw new ClusterControlHttpConfigurationError(
          'mutualTls reload material could not create a secure context',
        );
      } finally {
        ticketKeys.fill(0);
      }
      const previous = activeMutualTls;
      activeMutualTls = next;
      tlsGeneration += 1;
      eraseMutualTls(previous);
      secureServer.closeIdleConnections?.();
      return tlsGeneration;
    },
    installAdmission(evidence, pipeline) {
      if (closed) throw new Error('Cluster-control HTTP surface is closed');
      if (admission) {
        throw new Error('Cluster-control HTTP admission is already installed');
      }
      if (!pipeline || typeof pipeline.prepare !== 'function') {
        throw new TypeError(
          'Cluster-control HTTP admission pipeline is invalid',
        );
      }
      const state: AdmissionState = {
        evidence,
        pipeline,
        controller: new AbortController(),
        inFlight: new Set(),
      };
      admission = state;
      let disposePromise: Promise<void> | undefined;
      return () => {
        if (disposePromise) return disposePromise;
        disposePromise = (async () => {
          if (admission === state) admission = undefined;
          state.controller.abort(new Error('admission is draining'));
          try {
            await waitForDrain(state, options.drainTimeoutMs);
          } catch (error) {
            await notifyError(options, { phase: 'drain' }, error);
            throw error;
          }
        })();
        return disposePromise;
      };
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closed = true;
        authenticationShield.close();
        const state = admission;
        admission = undefined;
        let primaryError: unknown;
        if (state) {
          state.controller.abort(new Error('HTTP surface is closing'));
          try {
            await waitForDrain(state, options.drainTimeoutMs);
          } catch (error) {
            primaryError = error;
          }
        }
        try {
          await closeServer(server, options.drainTimeoutMs);
        } catch (error) {
          primaryError ??= error;
        } finally {
          eraseMutualTls(activeMutualTls);
          activeMutualTls = undefined;
        }
        if (primaryError) throw primaryError;
      })();
      return closePromise;
    },
  };
}
