// Credential ownership: generate bounded Worker certificate enrollment material.
import 'reflect-metadata';

import { createHash, webcrypto } from 'node:crypto';
import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  PemConverter,
  Pkcs10CertificateRequestGenerator,
} from '@peculiar/x509';

const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_ALGORITHM = Object.freeze({
  name: 'ECDSA',
  namedCurve: 'P-256',
  hash: 'SHA-256',
});
const MAX_PRIVATE_KEY_BYTES = 16 * 1024;
const MAX_CSR_BYTES = 16 * 1024;

export interface GenerateWorkerCertificateEnrollmentOptions {
  readonly workerId: string;
}

export interface WorkerCertificateEnrollmentMaterial {
  readonly algorithm: 'ECDSA_P256_SHA256';
  readonly workerId: string;
  readonly privateKeyPem: Buffer;
  readonly certificateSigningRequestPem: string;
  readonly publicKeySpkiSha256: string;
  dispose(): void;
}

export class WorkerCertificateEnrollmentError extends TypeError {
  constructor(message: string) {
    super(`Worker certificate enrollment is invalid: ${message}`);
    this.name = 'WorkerCertificateEnrollmentError';
  }
}

function assertWorkerId(workerId: string): void {
  if (typeof workerId !== 'string' || !WORKER_ID_PATTERN.test(workerId)) {
    throw new WorkerCertificateEnrollmentError('workerId is invalid');
  }
}

/**
 * Generates a Worker-local P-256 key and a PKCS#10 request. This function does
 * not contact a CA, persist the key or grant any Worker authority.
 */
export async function generateWorkerCertificateEnrollment(
  options: GenerateWorkerCertificateEnrollmentOptions,
): Promise<WorkerCertificateEnrollmentMaterial> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new WorkerCertificateEnrollmentError('options must be an object');
  }
  assertWorkerId(options.workerId);

  let privateKeyPem: Buffer | undefined;
  try {
    const keys = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, [
      'sign',
      'verify',
    ]);
    const request = await Pkcs10CertificateRequestGenerator.create(
      {
        name: `CN=${options.workerId}`,
        keys: keys as unknown as CryptoKeyPair,
        signingAlgorithm: KEY_ALGORITHM,
        extensions: [
          new BasicConstraintsExtension(false, undefined, true),
          new ExtendedKeyUsageExtension([ExtendedKeyUsage.clientAuth], true),
          new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        ],
      },
      webcrypto as unknown as Crypto,
    );
    if (!(await request.verify(webcrypto as unknown as Crypto))) {
      throw new WorkerCertificateEnrollmentError(
        'generated CSR signature is invalid',
      );
    }
    const [privateKey, publicKey] = await Promise.all([
      webcrypto.subtle.exportKey('pkcs8', keys.privateKey),
      webcrypto.subtle.exportKey('spki', keys.publicKey),
    ]);
    privateKeyPem = Buffer.from(
      PemConverter.encode(privateKey, 'PRIVATE KEY'),
      'ascii',
    );
    const certificateSigningRequestPem = request.toString('pem');
    if (
      privateKeyPem.byteLength < 1 ||
      privateKeyPem.byteLength > MAX_PRIVATE_KEY_BYTES ||
      Buffer.byteLength(certificateSigningRequestPem) < 1 ||
      Buffer.byteLength(certificateSigningRequestPem) > MAX_CSR_BYTES
    ) {
      throw new WorkerCertificateEnrollmentError(
        'generated material exceeds its hard limit',
      );
    }
    const publicKeySpkiSha256 = createHash('sha256')
      .update(Buffer.from(publicKey))
      .digest('hex');
    let disposed = false;
    const material: WorkerCertificateEnrollmentMaterial = {
      algorithm: 'ECDSA_P256_SHA256',
      workerId: options.workerId,
      privateKeyPem,
      certificateSigningRequestPem,
      publicKeySpkiSha256,
      dispose() {
        if (disposed) return;
        disposed = true;
        privateKeyPem?.fill(0);
      },
    };
    return Object.freeze(material);
  } catch (error) {
    privateKeyPem?.fill(0);
    if (error instanceof WorkerCertificateEnrollmentError) throw error;
    throw new WorkerCertificateEnrollmentError('key or CSR generation failed');
  }
}
