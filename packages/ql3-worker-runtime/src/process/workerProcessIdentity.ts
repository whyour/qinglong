// Worker Process owns private bootstrap material and active credential composition.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type {
  WorkerCertificateTrustAnchorProvider,
} from '../credential/workerCertificateRenewal';
import { WorkerCertificateFileStore } from '../credential/workerCertificateStore';
import { validateWorkerCertificateIdentity } from '../credential/workerCertificateIdentity';
import { WorkerProductionCredentialProvider } from '../credential/workerProductionCredentialProvider';
import type { EnabledWorkerProcessConfig } from './workerProcessConfig';

const MAX_TLS_MATERIAL_BYTES = 1024 * 1024;

export class WorkerProcessIdentityError extends Error {
  readonly code = 'QL3_WORKER_PROCESS_IDENTITY_UNAVAILABLE';

  constructor(message: string, options?: ErrorOptions) {
    super(`Worker process identity is unavailable: ${message}`, options);
    this.name = 'WorkerProcessIdentityError';
  }
}

async function readMaterial(
  path: string,
  privateMaterial: boolean,
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > MAX_TLS_MATERIAL_BYTES ||
      (stat.mode & 0o022) !== 0 ||
      (privateMaterial && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error('unsafe identity material metadata');
    }
    const bytes = await handle.readFile();
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > MAX_TLS_MATERIAL_BYTES
    ) {
      bytes.fill(0);
      throw new Error('unsafe identity material size');
    }
    return bytes;
  } catch (error) {
    throw new WorkerProcessIdentityError('material read failed', {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class WorkerTrustAnchorFileProvider
  implements WorkerCertificateTrustAnchorProvider
{
  constructor(private readonly path: string) {
    if (typeof path !== 'string' || path.length < 1) {
      throw new WorkerProcessIdentityError('trust anchor path is invalid');
    }
  }

  async load(signal: AbortSignal): Promise<readonly Buffer[]> {
    if (!(signal instanceof AbortSignal)) {
      throw new WorkerProcessIdentityError('trust signal is invalid');
    }
    signal.throwIfAborted();
    const bytes = await readMaterial(this.path, false);
    try {
      signal.throwIfAborted();
      return Object.freeze([bytes]);
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
  }
}

/**
 * Verifies or bootstraps one durable Worker certificate store, then returns
 * the per-request credential provider. Bootstrap material is optional and is
 * only installed when its validated leaf differs from the active generation.
 */
export async function createWorkerProcessCredentialProvider(
  config: EnabledWorkerProcessConfig['identity'],
): Promise<Readonly<WorkerProductionCredentialProvider>> {
  if (!config || typeof config !== 'object') {
    throw new WorkerProcessIdentityError('configuration is invalid');
  }
  const store = new WorkerCertificateFileStore({
    rootDirectory: config.certificateStoreRoot,
    retainedGenerations: 2,
  });
  const trustAnchors = new WorkerTrustAnchorFileProvider(
    config.trustAnchorFile,
  );
  const signal = new AbortController().signal;
  let anchors: readonly Buffer[] | undefined;
  let privateKey: Buffer | undefined;
  let certificate: Buffer | undefined;
  try {
    anchors = await trustAnchors.load(signal);
    const active = await store.readActive(anchors);
    if (config.bootstrap !== undefined) {
      [privateKey, certificate] = await Promise.all([
        readMaterial(config.bootstrap.privateKeyFile, true),
        readMaterial(config.bootstrap.certificateChainFile, false),
      ]);
      const bootstrap = validateWorkerCertificateIdentity({
        privateKeyPem: privateKey,
        certificateChainPem: certificate,
        trustAnchors: anchors,
      });
      if (active?.certificateSha256 !== bootstrap.certificateSha256) {
        await store.install({
          privateKeyPem: privateKey,
          certificateChainPem: certificate,
          trustAnchors: anchors,
        });
      }
    } else if (!active) {
      throw new WorkerProcessIdentityError(
        'no active identity or bootstrap material',
      );
    }
    return new WorkerProductionCredentialProvider({
      certificateStore: store,
      trustAnchors,
      credentialTokenFile: config.credentialTokenFile,
      ...(config.expectedCredentialId === undefined
        ? {}
        : { expectedCredentialId: config.expectedCredentialId }),
    });
  } catch (error) {
    if (error instanceof WorkerProcessIdentityError) throw error;
    throw new WorkerProcessIdentityError('activation failed', {
      cause: error,
    });
  } finally {
    privateKey?.fill(0);
    certificate?.fill(0);
    anchors?.forEach((anchor) => anchor.fill(0));
  }
}
