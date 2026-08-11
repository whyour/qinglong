// Credential ownership: load production mTLS identity and bounded Worker token.
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, parse } from 'node:path';
import { normalizeWorkerCredentialId } from '@qinglong/runtime-core/worker-credential';
import {
  validateWorkerCertificateIdentity,
  type WorkerCertificateIdentitySummary,
} from './workerCertificateIdentity';
import type {
  WorkerCertificateStore,
} from './workerCertificateStore';
import type {
  WorkerCertificateTrustAnchorProvider,
} from './workerCertificateRenewal';
import type {
  WorkerIngressHttpsCredentialProvider,
  WorkerIngressHttpsCredentials,
} from '../remote-execution/transport/workerIngressHttpsClient';

const MAX_CREDENTIAL_TOKEN_BYTES = 256;
const MAX_TLS_MATERIAL_BYTES = 1024 * 1024;
const CREDENTIAL_TOKEN =
  /^ql3w_([A-Za-z0-9][A-Za-z0-9._:-]{0,63})_([A-Za-z0-9_-]{43})$/;

export interface WorkerProductionCredentialProviderOptions {
  readonly certificateStore: Pick<WorkerCertificateStore, 'readActive'>;
  readonly trustAnchors: WorkerCertificateTrustAnchorProvider;
  /** Private, atomically replaceable file containing one ql3w token. */
  readonly credentialTokenFile: string;
  readonly expectedCredentialId?: string;
  readonly now?: () => number;
}

export class WorkerProductionCredentialProviderError extends Error {
  constructor(
    readonly reason: 'invalid_configuration' | 'credentials_unavailable',
    options?: ErrorOptions,
  ) {
    super(`Worker production credentials failed: ${reason}`, options);
    this.name = 'WorkerProductionCredentialProviderError';
  }
}

function privateFilePath(value: string): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    parse(value).root === value ||
    normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) throw new WorkerProductionCredentialProviderError('invalid_configuration');
  return value;
}

function now(provider: () => number): number {
  const value = provider();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkerProductionCredentialProviderError('credentials_unavailable');
  }
  return value;
}

async function readPrivateFile(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  let handle;
  try {
    const parent = await lstat(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.mode & 0o077) !== 0
    ) throw new Error('unsafe parent');
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > maximumBytes ||
      (stat.mode & 0o077) !== 0
    ) throw new Error('unsafe file');
    const bytes = await handle.readFile();
    if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
      bytes.fill(0);
      throw new Error('unsafe bytes');
    }
    return bytes;
  } catch (error) {
    throw new WorkerProductionCredentialProviderError(
      'credentials_unavailable', { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function token(bytes: Buffer, expectedCredentialId?: string): string {
  try {
    let length = bytes.byteLength;
    if (bytes[length - 1] === 0x0a) length -= 1;
    const value = bytes.subarray(0, length).toString('ascii');
    const match = CREDENTIAL_TOKEN.exec(value);
    if (
      !match ||
      bytes.subarray(0, length).some((byte) => byte > 0x7f) ||
      bytes.subarray(0, length).includes(0x0a) ||
      (expectedCredentialId !== undefined &&
        match[1] !== expectedCredentialId)
    ) throw new Error('token is invalid');
    return value;
  } catch (error) {
    throw new WorkerProductionCredentialProviderError(
      'credentials_unavailable', { cause: error },
    );
  } finally {
    bytes.fill(0);
  }
}

function sameIdentity(
  expected: WorkerCertificateIdentitySummary,
  actual: WorkerCertificateIdentitySummary,
): boolean {
  return actual.certificateSha256 === expected.certificateSha256 &&
    actual.publicKeySpkiSha256 === expected.publicKeySpkiSha256 &&
    actual.serialNumber === expected.serialNumber &&
    actual.notBeforeMs === expected.notBeforeMs &&
    actual.notAfterMs === expected.notAfterMs;
}

function copyMaterial(value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from(value, 'utf8');
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_TLS_MATERIAL_BYTES) {
    bytes.fill(0);
    throw new WorkerProductionCredentialProviderError(
      'credentials_unavailable',
    );
  }
  return bytes;
}

/**
 * Loads the current certificate generation and ql3w token for every request.
 * Atomic file replacement therefore rotates credentials without a watcher or
 * a second Agent. Returned Buffer material is disposable by the HTTPS client.
 */
export class WorkerProductionCredentialProvider
  implements WorkerIngressHttpsCredentialProvider {
  private readonly certificateStore: Pick<WorkerCertificateStore, 'readActive'>;
  private readonly trustAnchors: WorkerCertificateTrustAnchorProvider;
  private readonly credentialTokenFile: string;
  private readonly expectedCredentialId?: string;
  private readonly nowProvider: () => number;

  constructor(options: WorkerProductionCredentialProviderOptions) {
    if (
      !options ||
      typeof options.certificateStore?.readActive !== 'function' ||
      typeof options.trustAnchors?.load !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function')
    ) throw new WorkerProductionCredentialProviderError('invalid_configuration');
    let expectedCredentialId: string | undefined;
    try {
      expectedCredentialId = options.expectedCredentialId === undefined
        ? undefined
        : normalizeWorkerCredentialId(options.expectedCredentialId);
    } catch (error) {
      throw new WorkerProductionCredentialProviderError(
        'invalid_configuration', { cause: error },
      );
    }
    this.certificateStore = options.certificateStore;
    this.trustAnchors = options.trustAnchors;
    this.credentialTokenFile = privateFilePath(options.credentialTokenFile);
    this.expectedCredentialId = expectedCredentialId;
    this.nowProvider = options.now ?? Date.now;
  }

  async load(signal?: AbortSignal): Promise<WorkerIngressHttpsCredentials> {
    const operationSignal = signal ?? new AbortController().signal;
    operationSignal.throwIfAborted();
    let certificate: Buffer | undefined;
    let privateKey: Buffer | undefined;
    const anchors: Buffer[] = [];
    try {
      const observedAtMs = now(this.nowProvider);
      const trustAnchors = await this.trustAnchors.load(operationSignal);
      operationSignal.throwIfAborted();
      const active = await this.certificateStore.readActive(
        trustAnchors,
        observedAtMs,
      );
      if (!active) {
        throw new WorkerProductionCredentialProviderError(
          'credentials_unavailable',
        );
      }
      certificate = await readPrivateFile(
        active.certificateChainFile,
        MAX_TLS_MATERIAL_BYTES,
      );
      privateKey = await readPrivateFile(
        active.privateKeyFile,
        MAX_TLS_MATERIAL_BYTES,
      );
      operationSignal.throwIfAborted();
      const summary = validateWorkerCertificateIdentity({
        certificateChainPem: certificate,
        privateKeyPem: privateKey,
        trustAnchors,
        now: observedAtMs,
      });
      if (!sameIdentity(active, summary)) {
        throw new WorkerProductionCredentialProviderError(
          'credentials_unavailable',
        );
      }
      const credentialToken = token(
        await readPrivateFile(
          this.credentialTokenFile,
          MAX_CREDENTIAL_TOKEN_BYTES,
        ),
        this.expectedCredentialId,
      );
      for (const anchor of trustAnchors) anchors.push(copyMaterial(anchor));
      const disposableCertificate = certificate;
      const disposablePrivateKey = privateKey;
      certificate = undefined;
      privateKey = undefined;
      let disposed = false;
      return Object.freeze({
        authorization: `Worker ${credentialToken}`,
        certificateChainPem: disposableCertificate,
        privateKeyPem: disposablePrivateKey,
        trustAnchors: Object.freeze(anchors),
        dispose() {
          if (disposed) return;
          disposed = true;
          disposableCertificate.fill(0);
          disposablePrivateKey.fill(0);
          anchors.forEach((anchor) => anchor.fill(0));
        },
      });
    } catch (error) {
      certificate?.fill(0);
      privateKey?.fill(0);
      anchors.forEach((anchor) => anchor.fill(0));
      if (operationSignal.aborted) throw operationSignal.reason ?? error;
      if (error instanceof WorkerProductionCredentialProviderError) throw error;
      throw new WorkerProductionCredentialProviderError(
        'credentials_unavailable', { cause: error },
      );
    }
  }
}
