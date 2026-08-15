import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import {
  ClusterCopilotClientConfigurationError,
  ClusterCopilotClientRemoteError,
  ClusterCopilotClientRequestError,
  type ClusterCopilotClientCommand,
  type ClusterCopilotClientResult,
} from '../copilot-client/client';
import {
  type ClusterCopilotConsoleAssets,
} from './assets';
import {
  CLUSTER_COPILOT_CONSOLE_READ_RESPONSE_SCHEMA,
  InvalidClusterCopilotConsoleReadRequestError,
  clusterCopilotConsoleClientCommand,
  normalizeClusterCopilotConsoleReadRequest,
} from './contracts';

export const CLUSTER_COPILOT_CONSOLE_LIMITS = Object.freeze({
  maximumBodyBytes: 4 * 1024,
  maximumResponseBytes: 2 * 1024 * 1024 + 4 * 1024,
  maximumConcurrentRequests: 2,
  maximumConnections: 16,
  shutdownTimeoutMs: 2_000,
});

export interface ClusterCopilotConsoleExecutor {
  execute(
    command: Readonly<ClusterCopilotClientCommand>,
  ): Promise<Readonly<ClusterCopilotClientResult>>;
}

export interface ClusterCopilotConsoleServerOptions {
  readonly assets: Readonly<ClusterCopilotConsoleAssets>;
  readonly executor: ClusterCopilotConsoleExecutor;
  readonly networkBoundary?: ClusterCopilotConsoleNetworkBoundary;
  readonly port: number;
  readonly sessionDigest: Buffer;
}

export type ClusterCopilotConsoleNetworkBoundary =
  | 'host-loopback'
  | 'container-published-loopback';

export interface ClusterCopilotConsoleServer {
  readonly origin: string;
  close(): Promise<void>;
}

export class ClusterCopilotConsoleConfigurationError extends TypeError {
  readonly code = 'QL3_CLUSTER_COPILOT_CONSOLE_CONFIG_INVALID';

  constructor() {
    super('Cluster Copilot Console configuration is invalid');
    this.name = 'ClusterCopilotConsoleConfigurationError';
  }
}

const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_DIGEST_DOMAIN = Buffer.from(
  'qinglong-cluster-copilot-console-session-v1\0',
  'utf8',
);
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "manifest-src 'none'",
  "worker-src 'none'",
].join('; ');

function invalid(): never {
  throw new ClusterCopilotConsoleConfigurationError();
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid();
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return invalid();
  }
  return record;
}

export function clusterCopilotConsoleSessionDigest(value: string): Buffer {
  if (typeof value !== 'string' || !SESSION_TOKEN.test(value)) {
    return invalid();
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.byteLength !== 32 ||
    decoded.toString('base64url') !== value
  ) {
    decoded.fill(0);
    return invalid();
  }
  decoded.fill(0);
  return createHash('sha256')
    .update(SESSION_DIGEST_DOMAIN)
    .update(value, 'ascii')
    .digest();
}

function securityHeaders(contentType: string): Readonly<Record<string, string>> {
  return Object.freeze({
    'cache-control': 'no-store',
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'content-type': contentType,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'origin-agent-cluster': '?1',
    'permissions-policy':
      'camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
}

function send(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const bytes = Buffer.from(body, 'utf8');
  response.writeHead(statusCode, {
    ...securityHeaders(contentType),
    ...extraHeaders,
    connection: 'close',
    'content-length': String(bytes.byteLength),
  });
  response.end(bytes, () => bytes.fill(0));
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  send(
    response,
    statusCode,
    'application/json; charset=utf-8',
    JSON.stringify(body),
    extraHeaders,
  );
}

function headerCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function targetPath(request: IncomingMessage): 'inspect' | 'output' | null {
  if (request.method !== 'POST') return null;
  if (request.url === '/api/v1/copilot/inspect') return 'inspect';
  if (request.url === '/api/v1/copilot/output') return 'output';
  return null;
}

function authorize(
  request: IncomingMessage,
  expectedOrigin: string,
  sessionDigest: Buffer,
): boolean {
  if (
    headerCount(request, 'authorization') !== 1 ||
    headerCount(request, 'origin') !== 1 ||
    request.headers.origin !== expectedOrigin ||
    request.headers.host !== expectedOrigin.slice('http://'.length)
  ) {
    return false;
  }
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== 'string' ||
    !authorization.startsWith('QL3-Console ')
  ) {
    return false;
  }
  let candidate: Buffer | undefined;
  try {
    candidate = clusterCopilotConsoleSessionDigest(
      authorization.slice('QL3-Console '.length),
    );
    return timingSafeEqual(candidate, sessionDigest);
  } catch {
    return false;
  } finally {
    candidate?.fill(0);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (
    headerCount(request, 'content-type') !== 1 ||
    headerCount(request, 'content-length') !== 1 ||
    request.headers['content-type'] !== 'application/json; charset=utf-8' ||
    request.headers['content-encoding'] !== undefined ||
    request.headers['transfer-encoding'] !== undefined ||
    typeof request.headers['content-length'] !== 'string' ||
    !/^[1-9][0-9]*$/.test(request.headers['content-length'])
  ) {
    throw new InvalidClusterCopilotConsoleReadRequestError();
  }
  const expectedLength = Number(request.headers['content-length']);
  if (
    !Number.isSafeInteger(expectedLength) ||
    expectedLength < 2 ||
    expectedLength > CLUSTER_COPILOT_CONSOLE_LIMITS.maximumBodyBytes
  ) {
    throw new InvalidClusterCopilotConsoleReadRequestError();
  }
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.byteLength;
      if (
        length > expectedLength ||
        length > CLUSTER_COPILOT_CONSOLE_LIMITS.maximumBodyBytes
      ) {
        throw new InvalidClusterCopilotConsoleReadRequestError();
      }
      chunks.push(bytes);
    }
    if (request.aborted || length !== expectedLength) {
      throw new InvalidClusterCopilotConsoleReadRequestError();
    }
    const body = Buffer.concat(chunks, length);
    try {
      return JSON.parse(body.toString('utf8'));
    } finally {
      body.fill(0);
    }
  } catch (error) {
    if (error instanceof InvalidClusterCopilotConsoleReadRequestError) {
      throw error;
    }
    throw new InvalidClusterCopilotConsoleReadRequestError();
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function remoteFailure(
  response: ServerResponse,
  error: ClusterCopilotClientRemoteError,
): void {
  const statusCode =
    error.statusCode === 404
      ? 404
      : error.statusCode === 429
        ? 429
        : 502;
  sendJson(
    response,
    statusCode,
    Object.freeze({
      schema: CLUSTER_COPILOT_CONSOLE_READ_RESPONSE_SCHEMA,
      code: error.responseCode,
      requestId: error.requestId,
      retryAfterSeconds: error.retryAfterSeconds,
    }),
    error.retryAfterSeconds === null
      ? {}
      : { 'retry-after': String(error.retryAfterSeconds) },
  );
}

export async function startClusterCopilotConsoleServer(
  options: ClusterCopilotConsoleServerOptions,
): Promise<Readonly<ClusterCopilotConsoleServer>> {
  const optionKeys = ['assets', 'executor', 'port', 'sessionDigest'];
  if (Object.hasOwn(options, 'networkBoundary')) {
    optionKeys.push('networkBoundary');
  }
  const record = exactObject(options, optionKeys);
  const assets = exactObject(record.assets, ['css', 'html', 'javascript']);
  const networkBoundary =
    record.networkBoundary === undefined
      ? 'host-loopback'
      : record.networkBoundary;
  if (
    typeof assets.html !== 'string' ||
    assets.html.length < 1 ||
    typeof assets.css !== 'string' ||
    assets.css.length < 1 ||
    typeof assets.javascript !== 'string' ||
    assets.javascript.length < 1 ||
    !record.executor ||
    typeof (record.executor as ClusterCopilotConsoleExecutor).execute !==
      'function' ||
    !Number.isSafeInteger(record.port) ||
    ((record.port as number) !== 0 &&
      ((record.port as number) < 1_024 || (record.port as number) > 65_535)) ||
    (networkBoundary !== 'host-loopback' &&
      networkBoundary !== 'container-published-loopback') ||
    (networkBoundary === 'container-published-loopback' &&
      (record.port as number) === 0) ||
    !Buffer.isBuffer(record.sessionDigest) ||
    (record.sessionDigest as Buffer).byteLength !== 32
  ) {
    return invalid();
  }
  const sessionDigest = Buffer.from(record.sessionDigest as Buffer);
  const executor = record.executor as ClusterCopilotConsoleExecutor;
  const listenAddress =
    networkBoundary === 'host-loopback' ? '127.0.0.1' : '0.0.0.0';
  let expectedOrigin = '';
  let inFlight = 0;
  let closed = false;

  const server = createServer(async (request, response) => {
    response.shouldKeepAlive = false;
    const hostMatches =
      expectedOrigin !== '' &&
      request.headers.host === expectedOrigin.slice('http://'.length);
    if (request.method === 'GET' && hostMatches) {
      if (request.url === '/') {
        send(response, 200, 'text/html; charset=utf-8', assets.html as string);
        return;
      }
      if (request.url === '/app.css') {
        send(response, 200, 'text/css; charset=utf-8', assets.css as string);
        return;
      }
      if (request.url === '/app.js') {
        send(
          response,
          200,
          'text/javascript; charset=utf-8',
          assets.javascript as string,
        );
        return;
      }
    }

    const operation = targetPath(request);
    if (
      !hostMatches ||
      operation === null ||
      !authorize(request, expectedOrigin, sessionDigest)
    ) {
      sendJson(response, 404, Object.freeze({ code: 'not_found' }));
      request.resume();
      return;
    }
    if (
      inFlight >= CLUSTER_COPILOT_CONSOLE_LIMITS.maximumConcurrentRequests
    ) {
      sendJson(
        response,
        429,
        Object.freeze({
          schema: CLUSTER_COPILOT_CONSOLE_READ_RESPONSE_SCHEMA,
          code: 'cluster_copilot_console_busy',
        }),
        { 'retry-after': '1' },
      );
      request.resume();
      return;
    }

    inFlight += 1;
    try {
      const body = await readJsonBody(request);
      const normalized = normalizeClusterCopilotConsoleReadRequest(body);
      if (normalized.operation !== operation) {
        throw new InvalidClusterCopilotConsoleReadRequestError();
      }
      const result = await executor.execute(
        clusterCopilotConsoleClientCommand(normalized),
      );
      const envelope = Object.freeze({
        schema: CLUSTER_COPILOT_CONSOLE_READ_RESPONSE_SCHEMA,
        operation,
        requestId: result.requestId,
        result,
      });
      const encoded = JSON.stringify(envelope);
      if (
        Buffer.byteLength(encoded, 'utf8') >
        CLUSTER_COPILOT_CONSOLE_LIMITS.maximumResponseBytes
      ) {
        throw new ClusterCopilotClientRequestError();
      }
      send(
        response,
        200,
        'application/json; charset=utf-8',
        encoded,
      );
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
      } else if (
        error instanceof InvalidClusterCopilotConsoleReadRequestError
      ) {
        sendJson(
          response,
          400,
          Object.freeze({
            schema: CLUSTER_COPILOT_CONSOLE_READ_RESPONSE_SCHEMA,
            code: 'invalid_cluster_copilot_console_read_request',
          }),
        );
      } else if (error instanceof ClusterCopilotClientRemoteError) {
        remoteFailure(response, error);
      } else if (
        error instanceof ClusterCopilotClientConfigurationError ||
        error instanceof ClusterCopilotClientRequestError
      ) {
        sendJson(
          response,
          503,
          Object.freeze({
            schema: CLUSTER_COPILOT_CONSOLE_READ_RESPONSE_SCHEMA,
            code: 'cluster_copilot_console_upstream_unavailable',
          }),
        );
      } else {
        sendJson(
          response,
          503,
          Object.freeze({
            schema: CLUSTER_COPILOT_CONSOLE_READ_RESPONSE_SCHEMA,
            code: 'cluster_copilot_console_unavailable',
          }),
        );
      }
    } finally {
      inFlight -= 1;
    }
  });

  server.maxConnections = CLUSTER_COPILOT_CONSOLE_LIMITS.maximumConnections;
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1;
  server.maxRequestsPerSocket = 1;
  server.on('clientError', (_error, socket) => socket.destroy());

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(record.port as number, listenAddress, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') return invalid();
    expectedOrigin = 'http://127.0.0.1:' + String(address.port);
  } catch (error) {
    sessionDigest.fill(0);
    server.closeAllConnections();
    if (error instanceof ClusterCopilotConsoleConfigurationError) throw error;
    throw new ClusterCopilotConsoleConfigurationError();
  }

  return Object.freeze({
    origin: expectedOrigin,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          server.closeAllConnections();
        }, CLUSTER_COPILOT_CONSOLE_LIMITS.shutdownTimeoutMs);
        timeout.unref();
        server.close(() => {
          clearTimeout(timeout);
          resolve();
        });
        server.closeIdleConnections();
      });
      sessionDigest.fill(0);
    },
  });
}
