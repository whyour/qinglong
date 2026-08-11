// Credential ownership: validate Worker certificate identity and trust semantics.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';

const CERTIFICATE_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const CLIENT_AUTH_OID = '1.3.6.1.5.5.7.3.2';
const MAX_CERTIFICATE_MATERIAL_BYTES = 1024 * 1024;
const MAX_CERTIFICATES = 16;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export type WorkerCertificateIdentityFailureReason =
  | 'invalid_material'
  | 'key_mismatch'
  | 'not_yet_valid'
  | 'expired'
  | 'insufficient_validity'
  | 'not_client_auth'
  | 'untrusted';

export class WorkerCertificateIdentityError extends Error {
  constructor(readonly reason: WorkerCertificateIdentityFailureReason) {
    super(`Worker certificate identity is unavailable: ${reason}`);
    this.name = 'WorkerCertificateIdentityError';
  }
}

export interface ValidateWorkerCertificateIdentityInput {
  readonly privateKeyPem: string | Buffer;
  readonly certificateChainPem: string | Buffer;
  readonly trustAnchors: readonly (string | Buffer)[];
  readonly now?: number;
  readonly minimumRemainingValidityMs?: number;
}

export interface WorkerCertificateIdentitySummary {
  readonly certificateSha256: string;
  readonly publicKeySpkiSha256: string;
  readonly serialNumber: string;
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
}

interface ParsedCertificate {
  readonly certificate: X509Certificate;
  readonly fingerprint: string;
}

function materialBytes(
  value: string | Buffer,
  privateMaterial = false,
): Buffer {
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
    throw new WorkerCertificateIdentityError('invalid_material');
  }
  const bytes = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from(value, 'utf8');
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_CERTIFICATE_MATERIAL_BYTES
  ) {
    bytes.fill(0);
    throw new WorkerCertificateIdentityError('invalid_material');
  }
  if (privateMaterial && !bytes.includes(Buffer.from('PRIVATE KEY'))) {
    bytes.fill(0);
    throw new WorkerCertificateIdentityError('invalid_material');
  }
  return bytes;
}

function splitCertificates(
  value: string | Buffer,
  remaining: { count: number },
): ParsedCertificate[] {
  const bytes = materialBytes(value);
  try {
    const pem = bytes.toString('utf8');
    const matches = pem.match(CERTIFICATE_PATTERN);
    if (!matches || matches.length === 0) {
      throw new WorkerCertificateIdentityError('invalid_material');
    }
    const remainder = matches.reduce(
      (candidate, match) => candidate.replace(match, ''),
      pem,
    );
    remaining.count -= matches.length;
    if (remainder.trim() !== '' || remaining.count < 0) {
      throw new WorkerCertificateIdentityError('invalid_material');
    }
    return matches.map((match) => {
      try {
        const certificate = new X509Certificate(`${match}\n`);
        return {
          certificate,
          fingerprint: createHash('sha256')
            .update(certificate.raw)
            .digest('hex'),
        };
      } catch {
        throw new WorkerCertificateIdentityError('invalid_material');
      }
    });
  } finally {
    bytes.fill(0);
  }
}

function certificateTime(
  certificate: X509Certificate,
  now: number,
): { notBeforeMs: number; notAfterMs: number } {
  const notBeforeMs = Date.parse(certificate.validFrom);
  const notAfterMs = Date.parse(certificate.validTo);
  if (!Number.isFinite(notBeforeMs) || !Number.isFinite(notAfterMs)) {
    throw new WorkerCertificateIdentityError('invalid_material');
  }
  if (now < notBeforeMs) {
    throw new WorkerCertificateIdentityError('not_yet_valid');
  }
  if (now >= notAfterMs) {
    throw new WorkerCertificateIdentityError('expired');
  }
  return { notBeforeMs, notAfterMs };
}

function signedBy(
  certificate: X509Certificate,
  issuer: X509Certificate,
): boolean {
  try {
    return (
      certificate.checkIssued(issuer) && certificate.verify(issuer.publicKey)
    );
  } catch {
    return false;
  }
}

function reachesTrustAnchor(
  certificate: ParsedCertificate,
  intermediates: readonly ParsedCertificate[],
  anchors: readonly ParsedCertificate[],
  visited: ReadonlySet<string>,
): boolean {
  if (
    visited.has(certificate.fingerprint) ||
    visited.size >= MAX_CERTIFICATES
  ) {
    return false;
  }
  const nextVisited = new Set(visited);
  nextVisited.add(certificate.fingerprint);
  for (const anchor of anchors) {
    if (signedBy(certificate.certificate, anchor.certificate)) return true;
  }
  for (const intermediate of intermediates) {
    if (
      !nextVisited.has(intermediate.fingerprint) &&
      signedBy(certificate.certificate, intermediate.certificate) &&
      reachesTrustAnchor(intermediate, intermediates, anchors, nextVisited)
    ) {
      return true;
    }
  }
  return false;
}

function matchingPublicKey(
  privateKeyPem: Buffer,
  certificate: X509Certificate,
): string {
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    throw new WorkerCertificateIdentityError('invalid_material');
  }
  const key = createPublicKey(privateKey).export({
    type: 'spki',
    format: 'der',
  });
  const certificateKey = certificate.publicKey.export({
    type: 'spki',
    format: 'der',
  });
  if (
    key.byteLength !== certificateKey.byteLength ||
    !timingSafeEqual(key, certificateKey)
  ) {
    throw new WorkerCertificateIdentityError('key_mismatch');
  }
  return createHash('sha256').update(key).digest('hex');
}

export function assertWorkerCertificateIdentitySummary(
  value: WorkerCertificateIdentitySummary,
): void {
  if (
    !value ||
    typeof value !== 'object' ||
    !SHA256_HEX_PATTERN.test(value.certificateSha256) ||
    !SHA256_HEX_PATTERN.test(value.publicKeySpkiSha256) ||
    typeof value.serialNumber !== 'string' ||
    !/^[A-Fa-f0-9]{1,128}$/.test(value.serialNumber) ||
    !Number.isSafeInteger(value.notBeforeMs) ||
    !Number.isSafeInteger(value.notAfterMs) ||
    value.notBeforeMs < 0 ||
    value.notAfterMs <= value.notBeforeMs
  ) {
    throw new WorkerCertificateIdentityError('invalid_material');
  }
}

/** Validates key possession, client-auth intent, validity and a bounded chain. */
export function validateWorkerCertificateIdentity(
  input: ValidateWorkerCertificateIdentityInput,
): WorkerCertificateIdentitySummary {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkerCertificateIdentityError('invalid_material');
  }
  const now = input.now ?? Date.now();
  const minimumRemainingValidityMs = input.minimumRemainingValidityMs ?? 0;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(minimumRemainingValidityMs) ||
    minimumRemainingValidityMs < 0 ||
    minimumRemainingValidityMs > 365 * 24 * 60 * 60_000
  ) {
    throw new WorkerCertificateIdentityError('invalid_material');
  }
  if (
    !Array.isArray(input.trustAnchors) ||
    input.trustAnchors.length < 1 ||
    input.trustAnchors.length > MAX_CERTIFICATES
  ) {
    throw new WorkerCertificateIdentityError('invalid_material');
  }

  const remaining = { count: MAX_CERTIFICATES };
  const chain = splitCertificates(input.certificateChainPem, remaining);
  const anchors = input.trustAnchors.flatMap((anchor) =>
    splitCertificates(anchor, remaining),
  );
  const [leaf, ...intermediates] = chain;
  if (!leaf || anchors.length === 0 || leaf.certificate.ca) {
    throw new WorkerCertificateIdentityError('invalid_material');
  }
  const leafTime = certificateTime(leaf.certificate, now);
  if (leafTime.notAfterMs - now < minimumRemainingValidityMs) {
    throw new WorkerCertificateIdentityError('insufficient_validity');
  }
  if (!leaf.certificate.keyUsage?.includes(CLIENT_AUTH_OID)) {
    throw new WorkerCertificateIdentityError('not_client_auth');
  }
  for (const certificate of [...intermediates, ...anchors]) {
    if (!certificate.certificate.ca) {
      throw new WorkerCertificateIdentityError('invalid_material');
    }
    certificateTime(certificate.certificate, now);
  }
  if (!reachesTrustAnchor(leaf, intermediates, anchors, new Set())) {
    throw new WorkerCertificateIdentityError('untrusted');
  }

  const privateKeyPem = materialBytes(input.privateKeyPem, true);
  try {
    const summary = Object.freeze({
      certificateSha256: createHash('sha256')
        .update(leaf.certificate.raw)
        .digest('hex'),
      publicKeySpkiSha256: matchingPublicKey(privateKeyPem, leaf.certificate),
      serialNumber: leaf.certificate.serialNumber,
      notBeforeMs: leafTime.notBeforeMs,
      notAfterMs: leafTime.notAfterMs,
    });
    assertWorkerCertificateIdentitySummary(summary);
    return summary;
  } finally {
    privateKeyPem.fill(0);
  }
}
