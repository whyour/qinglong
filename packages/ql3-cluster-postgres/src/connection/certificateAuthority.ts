import { X509Certificate } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';

export const POSTGRES_CA_MAX_FILE_BYTES = 256 * 1024;
export const POSTGRES_CA_MAX_CERTIFICATES = 16;

export const POSTGRES_CA_FILE_ERROR_CODES = Object.freeze([
  'QL3_POSTGRES_CA_INVALID_PATH',
  'QL3_POSTGRES_CA_UNAVAILABLE',
  'QL3_POSTGRES_CA_NOT_REGULAR',
  'QL3_POSTGRES_CA_INSECURE_PERMISSIONS',
  'QL3_POSTGRES_CA_INVALID_SIZE',
  'QL3_POSTGRES_CA_CHANGED_DURING_READ',
  'QL3_POSTGRES_CA_INVALID_ENCODING',
  'QL3_POSTGRES_CA_INVALID_PEM',
  'QL3_POSTGRES_CA_TOO_MANY_CERTIFICATES',
  'QL3_POSTGRES_CA_NOT_CA',
  'QL3_POSTGRES_CA_DUPLICATE_CERTIFICATE',
] as const);

export type PostgresCertificateAuthorityFileErrorCode =
  (typeof POSTGRES_CA_FILE_ERROR_CODES)[number];

export class PostgresCertificateAuthorityFileError extends TypeError {
  constructor(readonly code: PostgresCertificateAuthorityFileErrorCode) {
    super('PostgreSQL certificate authority file is invalid');
    this.name = 'PostgresCertificateAuthorityFileError';
  }
}

export interface PostgresCertificateAuthorityFileInspection {
  readonly bundle: string;
  readonly fingerprints256: readonly string[];
}

function fail(code: PostgresCertificateAuthorityFileErrorCode): never {
  throw new PostgresCertificateAuthorityFileError(code);
}

function readBoundedRegularFile(filePath: string): Buffer {
  if (
    typeof filePath !== 'string' ||
    filePath.length < 1 ||
    filePath.length > 4096 ||
    /[\0\r\n]/.test(filePath) ||
    !isAbsolute(filePath)
  ) {
    fail('QL3_POSTGRES_CA_INVALID_PATH');
  }

  let descriptor: number;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY);
  } catch {
    fail('QL3_POSTGRES_CA_UNAVAILABLE');
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) fail('QL3_POSTGRES_CA_NOT_REGULAR');
    if ((stat.mode & 0o022) !== 0) {
      fail('QL3_POSTGRES_CA_INSECURE_PERMISSIONS');
    }
    if (
      !Number.isSafeInteger(stat.size) ||
      stat.size < 1 ||
      stat.size > POSTGRES_CA_MAX_FILE_BYTES
    ) {
      fail('QL3_POSTGRES_CA_INVALID_SIZE');
    }

    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) {
      fail('QL3_POSTGRES_CA_CHANGED_DURING_READ');
    }
    return bytes.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Loads one immutable PostgreSQL trust bundle. Kubernetes projected Secret
 * symlinks are accepted because the opened target is validated with fstat.
 */
export function inspectPostgresCertificateAuthorityFile(
  filePath: string,
): PostgresCertificateAuthorityFileInspection {
  const bytes = readBoundedRegularFile(filePath);
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('QL3_POSTGRES_CA_INVALID_ENCODING');
  } finally {
    bytes.fill(0);
  }

  const pattern =
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  const blocks = source.match(pattern) ?? [];
  if (blocks.length < 1 || source.replace(pattern, '').trim().length !== 0) {
    fail('QL3_POSTGRES_CA_INVALID_PEM');
  }
  if (blocks.length > POSTGRES_CA_MAX_CERTIFICATES) {
    fail('QL3_POSTGRES_CA_TOO_MANY_CERTIFICATES');
  }

  const fingerprints = new Set<string>();
  const normalized: string[] = [];
  for (const block of blocks) {
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(block);
    } catch {
      fail('QL3_POSTGRES_CA_INVALID_PEM');
    }
    if (!certificate.ca) fail('QL3_POSTGRES_CA_NOT_CA');
    if (fingerprints.has(certificate.fingerprint256)) {
      fail('QL3_POSTGRES_CA_DUPLICATE_CERTIFICATE');
    }
    fingerprints.add(certificate.fingerprint256);
    normalized.push(certificate.toString().trimEnd());
  }
  return Object.freeze({
    bundle: `${normalized.join('\n')}\n`,
    fingerprints256: Object.freeze([...fingerprints].sort()),
  });
}

export function loadPostgresCertificateAuthorityFile(filePath: string): string {
  return inspectPostgresCertificateAuthorityFile(filePath).bundle;
}
