/** Shared bounded TLS HTTP host boundary for cluster management planes. */
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';

import {
  PluginPackageManagementAuthorizationError,
  PluginPackageManagementConflictError,
  PluginPackageManagementQuotaExceededError,
  PluginPackageManagementRequestError,
  PluginPackageManagementUnavailableError,
} from '@qinglong/runtime-core/plugin-package-management';
import { ClusterPluginPackageIdentityAssertionAuthenticationError } from './pluginPackageIdentityAssertion';
import {
  ClusterPluginPackageIdentityKeysetUnavailableError,
  type ClusterPluginPackageIdentityKeysetFile,
} from './pluginPackageIdentityKeyset';
import {
  ClusterPluginPackageManagementTransportAuthenticationError,
  ClusterPluginPackageManagementTransportRequestError,
  ClusterPluginPackageManagementTransportUnavailableError,
} from '../plugin-package/management/pluginPackageManagementTransport';
import {
  WorkerCredentialManagementAuthorizationError,
  WorkerCredentialManagementConflictError,
  WorkerCredentialManagementQuotaExceededError,
  WorkerCredentialManagementRequestError,
  WorkerCredentialManagementUnavailableError,
} from '../worker-credential/management-server/workerCredentialManagement';
import {
  ClusterWorkerCredentialManagementTransportAuthenticationError,
  ClusterWorkerCredentialManagementTransportRequestError,
  ClusterWorkerCredentialManagementTransportUnavailableError,
} from '../worker-credential/management-server/workerCredentialManagementTransport';
import {
  ClusterAutomationManagementAuthorizationError,
  ClusterAutomationManagementConflictError,
  ClusterAutomationManagementRequestError,
  ClusterAutomationManagementUnavailableError,
} from '../automation-management/automationManagement';
import {
  ClusterAutomationManagementTransportAuthenticationError,
  ClusterAutomationManagementTransportRequestError,
  ClusterAutomationManagementTransportUnavailableError,
} from '../automation-management/automationManagementTransport';
import {
  ClusterApprovalManagementTransportAuthenticationError,
  ClusterApprovalManagementTransportAuthorizationError,
  ClusterApprovalManagementTransportConflictError,
  ClusterApprovalManagementTransportRequestError,
  ClusterApprovalManagementTransportTargetUnavailableError,
  ClusterApprovalManagementTransportUnavailableError,
} from '../approval-management/approvalManagementTransport';
import {
  ClusterModelProviderCredentialManagementAuthenticationError,
  ClusterModelProviderCredentialManagementAuthorizationError,
  ClusterModelProviderCredentialManagementConflictError,
  ClusterModelProviderCredentialManagementQuotaExceededError,
  ClusterModelProviderCredentialManagementRequestError,
  ClusterModelProviderCredentialManagementUnavailableError,
} from '../model-provider-credential/modelProviderCredentialManagement';
import {
  ClusterModelProviderCredentialManagementTransportAuthenticationError,
  ClusterModelProviderCredentialManagementTransportRequestError,
  ClusterModelProviderCredentialManagementTransportUnavailableError,
} from '../model-provider-credential/modelProviderCredentialManagementTransport';

export const CLUSTER_PLUGIN_PACKAGE_MANAGEMENT_PATH =
  '/api/v3/plugin-packages/management';
export const CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_PATH =
  '/api/v3/worker-credentials/management';
export const CLUSTER_AUTOMATION_MANAGEMENT_PATH =
  '/api/v3/automations/management';
export const CLUSTER_APPROVAL_MANAGEMENT_PATH = '/api/v3/approvals/management';
export const CLUSTER_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_PATH =
  '/api/v3/provider-credentials/management';
export type ClusterAuthenticatedManagementPath =
  | typeof CLUSTER_PLUGIN_PACKAGE_MANAGEMENT_PATH
  | typeof CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_PATH
  | typeof CLUSTER_AUTOMATION_MANAGEMENT_PATH
  | typeof CLUSTER_APPROVAL_MANAGEMENT_PATH
  | typeof CLUSTER_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_PATH;
const MANAGEMENT_PATHS = new Set<ClusterAuthenticatedManagementPath>([
  CLUSTER_PLUGIN_PACKAGE_MANAGEMENT_PATH,
  CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_PATH,
  CLUSTER_AUTOMATION_MANAGEMENT_PATH,
  CLUSTER_APPROVAL_MANAGEMENT_PATH,
  CLUSTER_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_PATH,
]);
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_PEER_REQUEST_LIMIT = 60;
const DEFAULT_GLOBAL_REQUEST_LIMIT = 600;
const DEFAULT_MAX_RATE_LIMIT_PEERS = 1_024;
const MAX_AUTHORIZATION_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export interface ClusterPluginPackageManagementHttpLimits {
  readonly maxBodyBytes?: number;
  readonly maxConnections?: number;
  readonly maxConcurrentRequests?: number;
  readonly requestTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  readonly rateWindowMs?: number;
  readonly peerRequestLimit?: number;
  readonly globalRequestLimit?: number;
  readonly maxRateLimitPeers?: number;
}

export interface StartClusterPluginPackageManagementHttpOptions {
  readonly host: string;
  readonly port: number;
  readonly tls: Readonly<{
    readonly privateKey: Buffer;
    readonly certificate: Buffer;
    readonly clientCertificateAuthority?: Buffer;
    readonly clientCertificateRevocationList?: Buffer;
  }>;
  readonly transport: ClusterAuthenticatedManagementTransport;
  readonly identities: ClusterPluginPackageIdentityKeysetFile;
  readonly managementPath?: ClusterAuthenticatedManagementPath;
  readonly limits?: ClusterPluginPackageManagementHttpLimits;
  readonly now?: () => number;
  readonly createRequestId?: () => string;
  readonly onError?: (error: unknown) => void;
}

export interface ClusterAuthenticatedManagementTransport {
  execute(
    command: unknown,
    authentication: Readonly<{
      authenticate(): Promise<unknown>;
    }>,
  ): Promise<unknown>;
}

export interface ClusterPluginPackageManagementHttpApplication {
  readonly status: 'active';
  readonly address: Readonly<{ host: string; port: number }>;
  availabilityStatus(): 'ready' | 'unavailable' | 'stopped';
  withdraw(error?: unknown): void;
  close(): Promise<void>;
}

export class ClusterPluginPackageManagementHttpConfigurationError extends TypeError {
  readonly code = 'CLUSTER_PLUGIN_PACKAGE_MANAGEMENT_HTTP_CONFIG_INVALID';

  constructor(message: string) {
    super(
      `Cluster Plugin Package management HTTP configuration is invalid: ${message}`,
    );
    this.name = 'ClusterPluginPackageManagementHttpConfigurationError';
  }
}

class HttpRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly responseCode: string,
    readonly retryAfterMs?: number,
  ) {
    super(responseCode);
  }
}

interface ReviewedLimits {
  readonly maxBodyBytes: number;
  readonly maxConnections: number;
  readonly maxConcurrentRequests: number;
  readonly requestTimeoutMs: number;
  readonly drainTimeoutMs: number;
  readonly rateWindowMs: number;
  readonly peerRequestLimit: number;
  readonly globalRequestLimit: number;
  readonly maxRateLimitPeers: number;
}

interface RateBucket {
  windowStartedAtMs: number;
  count: number;
  lastSeenAtMs: number;
}

class BoundedRateLimiter {
  readonly #peers = new Map<string, RateBucket>();
  #global: RateBucket;

  constructor(
    private readonly limits: ReviewedLimits,
    private readonly now: () => number,
  ) {
    const nowMs = this.currentTime();
    this.#global = {
      windowStartedAtMs: nowMs,
      count: 0,
      lastSeenAtMs: nowMs,
    };
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('HTTP rate-limit clock is invalid');
    }
    return value;
  }

  private retryAfter(
    bucket: RateBucket,
    limit: number,
    nowMs: number,
  ): number | null {
    if (nowMs >= bucket.windowStartedAtMs + this.limits.rateWindowMs) {
      bucket.windowStartedAtMs = nowMs;
      bucket.count = 0;
    }
    bucket.lastSeenAtMs = nowMs;
    if (bucket.count >= limit) {
      return Math.max(
        1,
        bucket.windowStartedAtMs + this.limits.rateWindowMs - nowMs,
      );
    }
    return null;
  }

  private evictOldestPeer(): void {
    let oldestKey: string | undefined;
    let oldestAtMs = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.#peers) {
      if (bucket.lastSeenAtMs < oldestAtMs) {
        oldestAtMs = bucket.lastSeenAtMs;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.#peers.delete(oldestKey);
  }

  consume(peerValue: string | undefined): number | null {
    const nowMs = this.currentTime();
    const globalRetry = this.retryAfter(
      this.#global,
      this.limits.globalRequestLimit,
      nowMs,
    );
    if (globalRetry !== null) return globalRetry;
    const peer =
      typeof peerValue === 'string' &&
      peerValue.length >= 1 &&
      peerValue.length <= 128 &&
      !CONTROL_PATTERN.test(peerValue)
        ? peerValue
        : '<unknown>';
    let bucket = this.#peers.get(peer);
    if (!bucket) {
      if (this.#peers.size >= this.limits.maxRateLimitPeers) {
        this.evictOldestPeer();
      }
      bucket = {
        windowStartedAtMs: nowMs,
        count: 0,
        lastSeenAtMs: nowMs,
      };
      this.#peers.set(peer, bucket);
    }
    const peerRetry = this.retryAfter(
      bucket,
      this.limits.peerRequestLimit,
      nowMs,
    );
    if (peerRetry !== null) return peerRetry;
    this.#global.count += 1;
    bucket.count += 1;
    return null;
  }
}

function configurationFailure(
  message: string,
): ClusterPluginPackageManagementHttpConfigurationError {
  return new ClusterPluginPackageManagementHttpConfigurationError(message);
}

function integer(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw configurationFailure(`${label} is invalid`);
  }
  return candidate;
}

function reviewedLimits(
  value: ClusterPluginPackageManagementHttpLimits | undefined,
): ReviewedLimits {
  if (
    value !== undefined &&
    (!value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) =>
          ![
            'maxBodyBytes',
            'maxConnections',
            'maxConcurrentRequests',
            'requestTimeoutMs',
            'drainTimeoutMs',
            'rateWindowMs',
            'peerRequestLimit',
            'globalRequestLimit',
            'maxRateLimitPeers',
          ].includes(key),
      ))
  ) {
    throw configurationFailure('limits are invalid');
  }
  const limits = value ?? {};
  const reviewed = {
    maxBodyBytes: integer(
      limits.maxBodyBytes,
      DEFAULT_MAX_BODY_BYTES,
      1_024,
      256 * 1024,
      'maximum body bytes',
    ),
    maxConnections: integer(
      limits.maxConnections,
      DEFAULT_MAX_CONNECTIONS,
      1,
      512,
      'maximum connections',
    ),
    maxConcurrentRequests: integer(
      limits.maxConcurrentRequests,
      DEFAULT_MAX_CONCURRENT_REQUESTS,
      1,
      256,
      'maximum concurrent requests',
    ),
    requestTimeoutMs: integer(
      limits.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1_000,
      60_000,
      'request timeout',
    ),
    drainTimeoutMs: integer(
      limits.drainTimeoutMs,
      DEFAULT_DRAIN_TIMEOUT_MS,
      100,
      60_000,
      'drain timeout',
    ),
    rateWindowMs: integer(
      limits.rateWindowMs,
      DEFAULT_RATE_WINDOW_MS,
      1_000,
      5 * 60_000,
      'rate window',
    ),
    peerRequestLimit: integer(
      limits.peerRequestLimit,
      DEFAULT_PEER_REQUEST_LIMIT,
      1,
      10_000,
      'peer request limit',
    ),
    globalRequestLimit: integer(
      limits.globalRequestLimit,
      DEFAULT_GLOBAL_REQUEST_LIMIT,
      1,
      100_000,
      'global request limit',
    ),
    maxRateLimitPeers: integer(
      limits.maxRateLimitPeers,
      DEFAULT_MAX_RATE_LIMIT_PEERS,
      1,
      16_384,
      'maximum rate-limit peers',
    ),
  };
  if (reviewed.globalRequestLimit < reviewed.peerRequestLimit) {
    throw configurationFailure(
      'global request limit cannot be below the peer limit',
    );
  }
  return Object.freeze(reviewed);
}

function rawHeaderCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function bearerAssertion(request: IncomingMessage): string {
  if (
    rawHeaderCount(request, 'authorization') !== 1 ||
    typeof request.headers.authorization !== 'string'
  ) {
    throw new HttpRequestError(401, 'authentication_required');
  }
  const value = request.headers.authorization;
  if (
    !value.startsWith('Bearer ') ||
    value.length <= 7 ||
    Buffer.byteLength(value, 'utf8') > MAX_AUTHORIZATION_BYTES ||
    CONTROL_PATTERN.test(value)
  ) {
    throw new HttpRequestError(401, 'authentication_required');
  }
  return value.slice(7);
}

function assertRequestHeaders(
  request: IncomingMessage,
  maxBodyBytes: number,
): void {
  if (
    rawHeaderCount(request, 'content-type') !== 1 ||
    request.headers['content-type'] !== 'application/json'
  ) {
    throw new HttpRequestError(415, 'unsupported_media_type');
  }
  if (
    request.headers['content-encoding'] !== undefined ||
    request.headers.expect !== undefined
  ) {
    throw new HttpRequestError(400, 'request_invalid');
  }
  if (rawHeaderCount(request, 'content-length') > 1) {
    throw new HttpRequestError(400, 'request_invalid');
  }
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined) {
    if (
      !/^(?:0|[1-9][0-9]*)$/.test(contentLength) ||
      Number(contentLength) > maxBodyBytes
    ) {
      throw new HttpRequestError(413, 'request_too_large');
    }
  }
}

async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > maxBodyBytes) {
      throw new HttpRequestError(413, 'request_too_large');
    }
    chunks.push(chunk);
  }
  if (length < 1) {
    throw new HttpRequestError(400, 'request_invalid');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks, length),
    );
  } catch {
    throw new HttpRequestError(400, 'request_invalid');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpRequestError(400, 'request_invalid');
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  value: Readonly<Record<string, unknown>>,
  retryAfterMs?: number,
): void {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_RESPONSE_BYTES) {
    throw new Error('management response exceeds its hard limit');
  }
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', String(body.length));
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  if (retryAfterMs !== undefined) {
    response.setHeader(
      'retry-after',
      String(Math.max(1, Math.ceil(retryAfterMs / 1_000))),
    );
  }
  response.end(body);
}

function responseError(error: unknown): HttpRequestError {
  if (error instanceof HttpRequestError) return error;
  if (
    error instanceof ClusterPluginPackageIdentityAssertionAuthenticationError ||
    error instanceof
      ClusterPluginPackageManagementTransportAuthenticationError ||
    error instanceof
      ClusterWorkerCredentialManagementTransportAuthenticationError ||
    error instanceof ClusterAutomationManagementTransportAuthenticationError ||
    error instanceof ClusterApprovalManagementTransportAuthenticationError ||
    error instanceof
      ClusterModelProviderCredentialManagementTransportAuthenticationError ||
    error instanceof ClusterModelProviderCredentialManagementAuthenticationError
  ) {
    return new HttpRequestError(401, 'authentication_required');
  }
  if (
    error instanceof ClusterPluginPackageManagementTransportRequestError ||
    error instanceof ClusterWorkerCredentialManagementTransportRequestError ||
    error instanceof ClusterAutomationManagementTransportRequestError ||
    error instanceof ClusterApprovalManagementTransportRequestError ||
    error instanceof ClusterAutomationManagementRequestError ||
    error instanceof
      ClusterModelProviderCredentialManagementTransportRequestError ||
    error instanceof ClusterModelProviderCredentialManagementRequestError ||
    error instanceof PluginPackageManagementRequestError ||
    error instanceof WorkerCredentialManagementRequestError
  ) {
    return new HttpRequestError(400, 'request_invalid');
  }
  if (
    error instanceof PluginPackageManagementAuthorizationError ||
    error instanceof WorkerCredentialManagementAuthorizationError ||
    error instanceof ClusterAutomationManagementAuthorizationError ||
    error instanceof ClusterApprovalManagementTransportAuthorizationError ||
    error instanceof ClusterModelProviderCredentialManagementAuthorizationError
  ) {
    return new HttpRequestError(403, 'forbidden');
  }
  if (
    error instanceof PluginPackageManagementConflictError ||
    error instanceof WorkerCredentialManagementConflictError ||
    error instanceof ClusterAutomationManagementConflictError ||
    error instanceof ClusterApprovalManagementTransportConflictError ||
    error instanceof ClusterModelProviderCredentialManagementConflictError
  ) {
    return new HttpRequestError(409, 'conflict');
  }
  if (error instanceof PluginPackageManagementQuotaExceededError) {
    return new HttpRequestError(429, 'quota_exceeded', error.retryAfterMs);
  }
  if (error instanceof WorkerCredentialManagementQuotaExceededError) {
    return new HttpRequestError(429, 'quota_exceeded', error.retryAfterMs);
  }
  if (
    error instanceof ClusterModelProviderCredentialManagementQuotaExceededError
  ) {
    return new HttpRequestError(429, 'quota_exceeded', error.retryAfterMs);
  }
  if (
    error instanceof ClusterApprovalManagementTransportTargetUnavailableError
  ) {
    return new HttpRequestError(404, 'not_found');
  }
  if (
    error instanceof ClusterPluginPackageIdentityKeysetUnavailableError ||
    error instanceof ClusterPluginPackageManagementTransportUnavailableError ||
    error instanceof
      ClusterWorkerCredentialManagementTransportUnavailableError ||
    error instanceof ClusterAutomationManagementTransportUnavailableError ||
    error instanceof ClusterApprovalManagementTransportUnavailableError ||
    error instanceof ClusterAutomationManagementUnavailableError ||
    error instanceof
      ClusterModelProviderCredentialManagementTransportUnavailableError ||
    error instanceof ClusterModelProviderCredentialManagementUnavailableError ||
    error instanceof PluginPackageManagementUnavailableError ||
    error instanceof WorkerCredentialManagementUnavailableError
  ) {
    return new HttpRequestError(503, 'unavailable');
  }
  return new HttpRequestError(500, 'internal_error');
}

async function listen(
  server: HttpsServer,
  port: number,
  host: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startClusterPluginPackageManagementHttp(
  options: StartClusterPluginPackageManagementHttpOptions,
): Promise<Readonly<ClusterPluginPackageManagementHttpApplication>> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        ![
          'host',
          'port',
          'tls',
          'transport',
          'identities',
          'managementPath',
          'limits',
          'now',
          'createRequestId',
          'onError',
        ].includes(key),
    ) ||
    typeof options.host !== 'string' ||
    options.host.length < 1 ||
    options.host.length > 255 ||
    CONTROL_PATTERN.test(options.host) ||
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535 ||
    !options.tls ||
    typeof options.tls !== 'object' ||
    Array.isArray(options.tls) ||
    Object.keys(options.tls).some(
      (key) =>
        key !== 'privateKey' &&
        key !== 'certificate' &&
        key !== 'clientCertificateAuthority' &&
        key !== 'clientCertificateRevocationList',
    ) ||
    !Buffer.isBuffer(options.tls.privateKey) ||
    options.tls.privateKey.length < 1 ||
    options.tls.privateKey.length > 256 * 1024 ||
    !Buffer.isBuffer(options.tls.certificate) ||
    options.tls.certificate.length < 1 ||
    options.tls.certificate.length > 256 * 1024 ||
    (options.tls.clientCertificateAuthority !== undefined &&
      (!Buffer.isBuffer(options.tls.clientCertificateAuthority) ||
        options.tls.clientCertificateAuthority.length < 1 ||
        options.tls.clientCertificateAuthority.length > 256 * 1024)) ||
    (options.tls.clientCertificateRevocationList !== undefined &&
      (!Buffer.isBuffer(options.tls.clientCertificateRevocationList) ||
        options.tls.clientCertificateRevocationList.length < 1 ||
        options.tls.clientCertificateRevocationList.length > 256 * 1024)) ||
    (options.tls.clientCertificateAuthority === undefined) !==
      (options.tls.clientCertificateRevocationList === undefined) ||
    !options.transport ||
    typeof options.transport.execute !== 'function' ||
    !options.identities ||
    typeof options.identities.bind !== 'function' ||
    typeof options.identities.reload !== 'function' ||
    (options.managementPath !== undefined &&
      !MANAGEMENT_PATHS.has(options.managementPath)) ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.createRequestId !== undefined &&
      typeof options.createRequestId !== 'function') ||
    (options.onError !== undefined && typeof options.onError !== 'function')
  ) {
    throw configurationFailure('options are invalid');
  }
  const limits = reviewedLimits(options.limits);
  const managementPath =
    options.managementPath ?? CLUSTER_PLUGIN_PACKAGE_MANAGEMENT_PATH;
  const now = options.now ?? Date.now;
  const createRequestId = options.createRequestId ?? randomUUID;
  const clientCertificateRequired =
    options.tls.clientCertificateAuthority !== undefined;
  const rateLimiter = new BoundedRateLimiter(limits, now);
  let availability: 'ready' | 'unavailable' | 'stopped' = 'ready';
  let inFlight = 0;
  const sockets = new Set<Duplex>();

  let server: HttpsServer;
  try {
    server = createServer({
      key: options.tls.privateKey,
      cert: options.tls.certificate,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      honorCipherOrder: true,
      ...(clientCertificateRequired
        ? {
            ca: options.tls.clientCertificateAuthority,
            crl: options.tls.clientCertificateRevocationList,
          }
        : {}),
      requestCert: clientCertificateRequired,
      // Health probes intentionally remain reachable without a client
      // certificate. Every non-health route checks TLSSocket.authorized before
      // reading Authorization or request body bytes.
      rejectUnauthorized: false,
    });
  } finally {
    options.tls.privateKey.fill(0);
  }
  server.maxHeadersCount = 32;
  server.maxConnections = limits.maxConnections;
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = Math.min(5_000, limits.requestTimeoutMs);
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics must never replace the stable HTTP response.
    }
  };

  server.on('checkContinue', (request, response) => {
    response.setHeader('connection', 'close');
    response.once('finish', () => request.destroy());
    writeJson(response, 417, {
      schemaVersion: 1,
      error: { code: 'request_invalid' },
    });
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) {
      socket.end(
        'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
    }
  });
  server.on('tlsClientError', () => {
    // TLS failures are unauthenticated network noise, not diagnostics.
  });

  server.on('request', (request, response) => {
    void (async () => {
      const requestId = createRequestId();
      if (
        typeof requestId !== 'string' ||
        requestId.length < 1 ||
        requestId.length > 128 ||
        CONTROL_PATTERN.test(requestId)
      ) {
        throw new Error('HTTP request id is invalid');
      }
      response.setHeader('x-request-id', requestId);
      const url = request.url;
      if (request.method === 'GET' && url === '/livez') {
        writeJson(response, 200, {
          schemaVersion: 1,
          status: 'live',
        });
        return;
      }
      if (request.method === 'GET' && url === '/readyz') {
        writeJson(response, availability === 'ready' ? 200 : 503, {
          schemaVersion: 1,
          status: availability === 'ready' ? 'ready' : 'not_ready',
        });
        return;
      }
      if (
        clientCertificateRequired &&
        !(request.socket as TLSSocket).authorized
      ) {
        throw new HttpRequestError(401, 'client_certificate_required');
      }
      if (request.method !== 'POST' || url !== managementPath) {
        throw new HttpRequestError(404, 'not_found');
      }
      if (availability !== 'ready') {
        throw new HttpRequestError(503, 'unavailable');
      }
      const retryAfterMs = rateLimiter.consume(request.socket.remoteAddress);
      if (retryAfterMs !== null) {
        writeJson(
          response,
          429,
          {
            schemaVersion: 1,
            requestId,
            error: { code: 'rate_limited' },
          },
          retryAfterMs,
        );
        return;
      }
      if (inFlight >= limits.maxConcurrentRequests) {
        throw new HttpRequestError(503, 'overloaded');
      }
      inFlight += 1;
      try {
        const assertion = bearerAssertion(request);
        const authentication = options.identities.bind(assertion);
        const principal = await authentication.authenticate();
        assertRequestHeaders(request, limits.maxBodyBytes);
        const command = await readJsonBody(request, limits.maxBodyBytes);
        const result = await options.transport.execute(
          command,
          Object.freeze({
            async authenticate() {
              return principal;
            },
          }),
        );
        writeJson(response, 200, {
          schemaVersion: 1,
          requestId,
          result,
        });
      } finally {
        inFlight -= 1;
      }
    })().catch((error) => {
      const mapped = responseError(error);
      if (mapped.statusCode === 500) report(error);
      if (!request.destroyed) {
        response.once('finish', () => request.destroy());
      }
      if (!response.headersSent && !response.destroyed) {
        response.setHeader('connection', 'close');
        writeJson(
          response,
          mapped.statusCode,
          {
            schemaVersion: 1,
            requestId:
              typeof response.getHeader('x-request-id') === 'string'
                ? response.getHeader('x-request-id')
                : 'unavailable',
            error: { code: mapped.responseCode },
          },
          mapped.retryAfterMs,
        );
      } else if (!response.destroyed) {
        response.destroy();
      }
    });
  });

  try {
    await listen(server, options.port, options.host);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    for (const socket of sockets) socket.destroy();
    throw new Error('management HTTP server address is unavailable');
  }
  const networkAddress = address as AddressInfo;
  let closePromise: Promise<void> | undefined;

  return Object.freeze({
    status: 'active' as const,
    address: Object.freeze({
      host: networkAddress.address,
      port: networkAddress.port,
    }),
    availabilityStatus: () => availability,
    withdraw(error?: unknown) {
      if (availability !== 'ready') return;
      availability = 'unavailable';
      if (error !== undefined) report(error);
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      availability = 'stopped';
      closePromise = new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
          finish();
        }, limits.drainTimeoutMs);
        server.close(finish);
      });
      return closePromise;
    },
  });
}
