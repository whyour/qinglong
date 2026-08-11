// Remote Execution transport owns the shared bounded TLS 1.3 Worker Ingress client.
import { Agent, request as nodeHttpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { isIP } from 'node:net';
import { REMOTE_WORKER_ARTIFACT_CONTENT_TYPE } from '@qinglong/runtime-core/remote-worker-completion';

const AUTHORIZATION =
  /^Worker ql3w_([A-Za-z0-9][A-Za-z0-9._:-]{0,63})_([A-Za-z0-9_-]{43})$/;
const WORKER_INGRESS_JSON_PATH =
  /^\/api\/v3\/worker-ingress\/workers\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(register|heartbeat|transition|offers|starting|running|start-failure|secrets|completion|lease-control)$/;
const WORKER_INGRESS_ARTIFACT_PATH =
  /^\/api\/v3\/worker-ingress\/workers\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/artifacts$/;
const MAX_TLS_MATERIAL_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 4096;
const HARD_MAX_REQUEST_BYTES = 64 * 1024;
const HARD_MAX_STREAM_REQUEST_BYTES = 64 * 1024 * 1024 + 4 * 1024 + 4;
const MAX_RESPONSE_BYTES = 128 * 1024;
const CREDENTIAL_POOL_KEY = Symbol('qinglong.worker-ingress-credential-pool-key');

export const WORKER_INGRESS_ARTIFACT_CONTENT_TYPE =
  REMOTE_WORKER_ARTIFACT_CONTENT_TYPE;

export interface WorkerIngressHttpsCredentials {
  readonly authorization: string;
  readonly certificateChainPem: string | Buffer;
  readonly privateKeyPem: string | Buffer;
  readonly trustAnchors: readonly (string | Buffer)[];
  /** Erases provider-owned transient material after the client copies it. */
  readonly dispose?: () => void;
}

export interface WorkerIngressHttpsCredentialProvider {
  load(signal?: AbortSignal): Promise<WorkerIngressHttpsCredentials>;
}

export type WorkerIngressHttpsRequestFactory = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export interface WorkerIngressHttpsClientOptions {
  readonly origin: string | URL;
  readonly credentials: WorkerIngressHttpsCredentialProvider;
  readonly requestTimeoutMs?: number;
  readonly agent?: Agent;
  /** Injectable only for deterministic transport contract tests. */
  readonly requestFactory?: WorkerIngressHttpsRequestFactory;
}

export interface WorkerIngressHttpsPostRequest {
  readonly path: string;
  readonly body: unknown;
  readonly maximumResponseBytes: number;
  /** Defaults to 4 KiB. Larger budgets are opt-in and capped at 64 KiB. */
  readonly maximumRequestBytes?: number;
  readonly signal?: AbortSignal;
}

export interface WorkerIngressHttpsStreamRequest {
  readonly path: string;
  readonly body: AsyncIterable<Uint8Array>;
  readonly byteLength: number;
  readonly maximumResponseBytes: number;
  readonly signal?: AbortSignal;
}

export class WorkerIngressHttpsClientError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'credentials_unavailable'
      | 'request_rejected'
      | 'response_rejected'
      | 'response_too_large'
      | 'closed',
    readonly httpStatus?: number,
  ) {
    super(`Worker ingress HTTPS client failed: ${reason}`);
    this.name = 'WorkerIngressHttpsClientError';
  }
}

function boundedMaterial(value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from(value, 'utf8');
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_TLS_MATERIAL_BYTES) {
    bytes.fill(0);
    throw new WorkerIngressHttpsClientError('credentials_unavailable');
  }
  return bytes;
}

function normalizeOrigin(value: string | URL): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new WorkerIngressHttpsClientError('invalid_configuration');
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== ''
  ) {
    throw new WorkerIngressHttpsClientError('invalid_configuration');
  }
  return origin;
}

interface WorkerIngressHttpsCredentialMaterial {
  readonly authorization: string;
  readonly certificate: Buffer;
  readonly privateKey: Buffer;
  readonly trustAnchors: readonly Buffer[];
  readonly poolKey: string;
}

interface WorkerIngressHttpsAgentRequestOptions extends RequestOptions {
  readonly [CREDENTIAL_POOL_KEY]?: string;
}

class WorkerIngressHttpsAgent extends Agent {
  override getName(options: RequestOptions = {}): string {
    const poolKey = (options as WorkerIngressHttpsAgentRequestOptions)[
      CREDENTIAL_POOL_KEY
    ];
    if (poolKey === undefined) return super.getName(options);
    // Node recomputes the HTTPS pool name when a socket becomes free. The
    // request-local TLS Buffers have already been erased by then, so their
    // mutable contents cannot safely participate in that name.
    return `${super.getName({
      ...options,
      ca: undefined,
      cert: undefined,
      key: undefined,
    })}:qinglong:${poolKey}`;
  }
}

function credentialPoolKey(
  certificate: Buffer,
  privateKey: Buffer,
  trustAnchors: readonly Buffer[],
): string {
  const hash = createHash('sha256');
  for (const value of [certificate, privateKey, ...trustAnchors]) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.byteLength);
    hash.update(length);
    hash.update(value);
    length.fill(0);
  }
  return hash.digest('base64url');
}

async function loadCredentialMaterial(
  provider: WorkerIngressHttpsCredentialProvider,
  signal?: AbortSignal,
): Promise<WorkerIngressHttpsCredentialMaterial> {
  let loaded: WorkerIngressHttpsCredentials;
  try {
    loaded = await provider.load(signal);
  } catch {
    if (signal?.aborted) {
      throw signal.reason ??
        new WorkerIngressHttpsClientError('request_rejected');
    }
    throw new WorkerIngressHttpsClientError('credentials_unavailable');
  }
  let certificate: Buffer | undefined;
  let privateKey: Buffer | undefined;
  const trustAnchors: Buffer[] = [];
  let failure: unknown;
  try {
    if (
      !loaded ||
      !AUTHORIZATION.test(loaded.authorization) ||
      !Array.isArray(loaded.trustAnchors) ||
      loaded.trustAnchors.length < 1 ||
      loaded.trustAnchors.length > 8 ||
      (loaded.dispose !== undefined && typeof loaded.dispose !== 'function')
    ) {
      throw new WorkerIngressHttpsClientError('credentials_unavailable');
    }
    certificate = boundedMaterial(loaded.certificateChainPem);
    privateKey = boundedMaterial(loaded.privateKeyPem);
    for (const anchor of loaded.trustAnchors) {
      trustAnchors.push(boundedMaterial(anchor));
    }
  } catch (error) {
    failure = error;
  }
  try {
    loaded?.dispose?.();
  } catch {
    failure ??= new WorkerIngressHttpsClientError('credentials_unavailable');
  }
  if (failure !== undefined || !certificate || !privateKey) {
    certificate?.fill(0);
    privateKey?.fill(0);
    trustAnchors.forEach((value) => value.fill(0));
    if (failure instanceof WorkerIngressHttpsClientError) throw failure;
    throw new WorkerIngressHttpsClientError('credentials_unavailable');
  }
  return {
    authorization: loaded.authorization,
    certificate,
    privateKey,
    trustAnchors: Object.freeze(trustAnchors),
    poolKey: credentialPoolKey(certificate, privateKey, trustAnchors),
  };
}

function eraseCredentialMaterial(
  material: WorkerIngressHttpsCredentialMaterial,
): void {
  material.certificate.fill(0);
  material.privateKey.fill(0);
  material.trustAnchors.forEach((value) => value.fill(0));
}

export class WorkerIngressHttpsClient {
  private readonly origin: URL;
  private readonly credentials: WorkerIngressHttpsCredentialProvider;
  private readonly requestTimeoutMs: number;
  private readonly requestFactory: WorkerIngressHttpsRequestFactory;
  private readonly agent: Agent;
  private readonly ownsAgent: boolean;
  private closed = false;

  constructor(options: WorkerIngressHttpsClientOptions) {
    if (
      !options ||
      typeof options.credentials?.load !== 'function' ||
      (options.requestFactory !== undefined &&
        typeof options.requestFactory !== 'function')
    ) {
      throw new WorkerIngressHttpsClientError('invalid_configuration');
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1_000 ||
      requestTimeoutMs > 60_000
    ) {
      throw new WorkerIngressHttpsClientError('invalid_configuration');
    }
    this.origin = normalizeOrigin(options.origin);
    this.credentials = options.credentials;
    this.requestTimeoutMs = requestTimeoutMs;
    this.requestFactory = options.requestFactory ?? nodeHttpsRequest;
    this.ownsAgent = options.agent === undefined;
    this.agent = options.agent ?? new WorkerIngressHttpsAgent({
      keepAlive: true,
      maxSockets: 1,
      maxFreeSockets: 1,
      timeout: requestTimeoutMs,
    });
  }

  async postJson(request: WorkerIngressHttpsPostRequest): Promise<Uint8Array> {
    if (this.closed) throw new WorkerIngressHttpsClientError('closed');
    if (
      !request ||
      typeof request.path !== 'string' ||
      !WORKER_INGRESS_JSON_PATH.test(request.path) ||
      !Number.isSafeInteger(request.maximumResponseBytes) ||
      request.maximumResponseBytes < 2 ||
      request.maximumResponseBytes > MAX_RESPONSE_BYTES ||
      (request.maximumRequestBytes !== undefined &&
        (!Number.isSafeInteger(request.maximumRequestBytes) ||
          request.maximumRequestBytes < 2 ||
          request.maximumRequestBytes > HARD_MAX_REQUEST_BYTES))
    ) {
      throw new WorkerIngressHttpsClientError('request_rejected');
    }
    if (request.signal?.aborted) {
      throw request.signal.reason ??
        new WorkerIngressHttpsClientError('request_rejected');
    }
    const material = await loadCredentialMaterial(
      this.credentials,
      request.signal,
    );
    let body: Buffer;
    try {
      body = Buffer.from(JSON.stringify(request.body), 'utf8');
    } catch {
      eraseCredentialMaterial(material);
      throw new WorkerIngressHttpsClientError('request_rejected');
    }
    const maximumRequestBytes = request.maximumRequestBytes ?? MAX_REQUEST_BYTES;
    if (body.byteLength < 2 || body.byteLength > maximumRequestBytes) {
      eraseCredentialMaterial(material);
      body.fill(0);
      throw new WorkerIngressHttpsClientError('request_rejected');
    }
    try {
      return await this.perform(
        request.path,
        body,
        request.maximumResponseBytes,
        material.authorization,
        material.certificate,
        material.privateKey,
        material.trustAnchors,
        material.poolKey,
        request.signal,
      );
    } finally {
      eraseCredentialMaterial(material);
      body.fill(0);
    }
  }

  async postStream(
    request: WorkerIngressHttpsStreamRequest,
  ): Promise<Uint8Array> {
    if (this.closed) throw new WorkerIngressHttpsClientError('closed');
    if (
      !request ||
      typeof request.path !== 'string' ||
      !WORKER_INGRESS_ARTIFACT_PATH.test(request.path) ||
      !request.body ||
      typeof request.body[Symbol.asyncIterator] !== 'function' ||
      !Number.isSafeInteger(request.byteLength) ||
      request.byteLength < 1 ||
      request.byteLength > HARD_MAX_STREAM_REQUEST_BYTES ||
      !Number.isSafeInteger(request.maximumResponseBytes) ||
      request.maximumResponseBytes < 2 ||
      request.maximumResponseBytes > MAX_RESPONSE_BYTES
    ) {
      throw new WorkerIngressHttpsClientError('request_rejected');
    }
    if (request.signal?.aborted) {
      throw request.signal.reason ??
        new WorkerIngressHttpsClientError('request_rejected');
    }
    const material = await loadCredentialMaterial(
      this.credentials,
      request.signal,
    );
    try {
      return await this.performStream(
        request.path,
        request.body,
        request.byteLength,
        request.maximumResponseBytes,
        material.authorization,
        material.certificate,
        material.privateKey,
        material.trustAnchors,
        material.poolKey,
        request.signal,
      );
    } finally {
      eraseCredentialMaterial(material);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsAgent) this.agent.destroy();
  }

  private perform(
    path: string,
    body: Buffer,
    maximumResponseBytes: number,
    authorization: string,
    certificate: Buffer,
    privateKey: Buffer,
    trustAnchors: readonly Buffer[],
    poolKey: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error?: unknown, bytes?: Buffer): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(bytes!);
      };
      let clientRequest: ClientRequest;
      const abort = (): void => {
        clientRequest.destroy(
          signal?.reason instanceof Error
            ? signal.reason
            : new WorkerIngressHttpsClientError('request_rejected'),
        );
      };
      try {
        clientRequest = this.requestFactory({
          protocol: 'https:',
          hostname: this.origin.hostname,
          port: this.origin.port || 443,
          ...(isIP(this.origin.hostname) === 0
            ? { servername: this.origin.hostname }
            : {}),
          method: 'POST',
          path,
          agent: this.agent,
          minVersion: 'TLSv1.3',
          rejectUnauthorized: true,
          cert: certificate,
          key: privateKey,
          ca: [...trustAnchors],
          [CREDENTIAL_POOL_KEY]: poolKey,
          headers: {
            accept: 'application/json',
            authorization,
            'content-type': 'application/json',
            'content-length': String(body.byteLength),
          },
        } as WorkerIngressHttpsAgentRequestOptions, (response) => {
          const contentType = response.headers['content-type'];
          const contentEncoding = response.headers['content-encoding'];
          const contentLength = response.headers['content-length'];
          if (
            response.statusCode !== 200 ||
            typeof contentType !== 'string' ||
            !/^application\/json(?:\s*;|$)/i.test(contentType) ||
            (contentEncoding !== undefined && contentEncoding !== 'identity') ||
            (contentLength !== undefined &&
              (!/^\d+$/.test(contentLength) ||
                Number(contentLength) > maximumResponseBytes))
          ) {
            response.resume();
            settle(new WorkerIngressHttpsClientError(
              'response_rejected', response.statusCode,
            ));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          response.on('data', (chunk: Buffer | string) => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += bytes.byteLength;
            if (total > maximumResponseBytes) {
              chunks.forEach((value) => value.fill(0));
              response.destroy();
              settle(new WorkerIngressHttpsClientError('response_too_large'));
              return;
            }
            chunks.push(Buffer.from(bytes));
          });
          response.once('end', () => {
            if (settled) return;
            const result = Buffer.concat(chunks, total);
            chunks.forEach((value) => value.fill(0));
            if (result.byteLength < 2) {
              result.fill(0);
              settle(new WorkerIngressHttpsClientError('response_rejected'));
              return;
            }
            settle(undefined, result);
          });
          response.once('error', () => {
            chunks.forEach((value) => value.fill(0));
            settle(new WorkerIngressHttpsClientError(
              'response_rejected', response.statusCode,
            ));
          });
        });
      } catch {
        settle(new WorkerIngressHttpsClientError('request_rejected'));
        return;
      }
      clientRequest.once('error', (error) => {
        if (signal?.aborted) settle(signal.reason ?? error);
        else settle(new WorkerIngressHttpsClientError('request_rejected'));
      });
      clientRequest.setTimeout(this.requestTimeoutMs, () => {
        clientRequest.destroy(
          new WorkerIngressHttpsClientError('request_rejected'),
        );
      });
      signal?.addEventListener('abort', abort, { once: true });
      clientRequest.end(body);
    });
  }

  private performStream(
    path: string,
    body: AsyncIterable<Uint8Array>,
    byteLength: number,
    maximumResponseBytes: number,
    authorization: string,
    certificate: Buffer,
    privateKey: Buffer,
    trustAnchors: readonly Buffer[],
    poolKey: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error?: unknown, bytes?: Buffer): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(bytes!);
      };
      let clientRequest: ClientRequest;
      const abort = (): void => {
        clientRequest.destroy(
          signal?.reason instanceof Error
            ? signal.reason
            : new WorkerIngressHttpsClientError('request_rejected'),
        );
      };
      try {
        clientRequest = this.requestFactory({
          protocol: 'https:',
          hostname: this.origin.hostname,
          port: this.origin.port || 443,
          ...(isIP(this.origin.hostname) === 0
            ? { servername: this.origin.hostname }
            : {}),
          method: 'POST',
          path,
          agent: this.agent,
          minVersion: 'TLSv1.3',
          rejectUnauthorized: true,
          cert: certificate,
          key: privateKey,
          ca: [...trustAnchors],
          [CREDENTIAL_POOL_KEY]: poolKey,
          headers: {
            accept: 'application/json',
            authorization,
            'content-type': WORKER_INGRESS_ARTIFACT_CONTENT_TYPE,
            'content-length': String(byteLength),
          },
        } as WorkerIngressHttpsAgentRequestOptions, (response) => {
          const contentType = response.headers['content-type'];
          const contentEncoding = response.headers['content-encoding'];
          const contentLength = response.headers['content-length'];
          if (
            response.statusCode !== 200 ||
            typeof contentType !== 'string' ||
            !/^application\/json(?:\s*;|$)/i.test(contentType) ||
            (contentEncoding !== undefined && contentEncoding !== 'identity') ||
            (contentLength !== undefined &&
              (!/^\d+$/.test(contentLength) ||
                Number(contentLength) > maximumResponseBytes))
          ) {
            response.resume();
            clientRequest.destroy();
            settle(new WorkerIngressHttpsClientError('response_rejected'));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          response.on('data', (chunk: Buffer | string) => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += bytes.byteLength;
            if (total > maximumResponseBytes) {
              chunks.forEach((value) => value.fill(0));
              response.destroy();
              settle(new WorkerIngressHttpsClientError('response_too_large'));
              return;
            }
            chunks.push(Buffer.from(bytes));
          });
          response.once('end', () => {
            if (settled) return;
            const result = Buffer.concat(chunks, total);
            chunks.forEach((value) => value.fill(0));
            if (result.byteLength < 2) {
              result.fill(0);
              settle(new WorkerIngressHttpsClientError('response_rejected'));
              return;
            }
            settle(undefined, result);
          });
          response.once('error', () => {
            chunks.forEach((value) => value.fill(0));
            settle(new WorkerIngressHttpsClientError('response_rejected'));
          });
        });
      } catch {
        settle(new WorkerIngressHttpsClientError('request_rejected'));
        return;
      }
      clientRequest.once('error', (error) => {
        if (signal?.aborted) settle(signal.reason ?? error);
        else settle(new WorkerIngressHttpsClientError('request_rejected'));
      });
      clientRequest.setTimeout(this.requestTimeoutMs, () => {
        clientRequest.destroy(
          new WorkerIngressHttpsClientError('request_rejected'),
        );
      });
      signal?.addEventListener('abort', abort, { once: true });
      void (async () => {
        let total = 0;
        for await (const chunk of body) {
          if (settled) return;
          if (signal?.aborted) throw signal.reason;
          if (!(chunk instanceof Uint8Array)) {
            throw new WorkerIngressHttpsClientError('request_rejected');
          }
          total += chunk.byteLength;
          if (total > byteLength) {
            throw new WorkerIngressHttpsClientError('request_rejected');
          }
          if (!clientRequest.write(chunk)) {
            await once(
              clientRequest,
              'drain',
              signal ? { signal } : undefined,
            );
          }
        }
        if (total !== byteLength) {
          throw new WorkerIngressHttpsClientError('request_rejected');
        }
        clientRequest.end();
      })().catch((error: unknown) => {
        clientRequest.destroy(
          error instanceof Error
            ? error
            : new WorkerIngressHttpsClientError('request_rejected'),
        );
      });
    });
  }
}
