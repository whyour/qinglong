import { createHmac } from 'node:crypto';
import { normalizeWorkerCredentialId } from './workerCredential';

export const WORKER_CREDENTIAL_TOKEN_LIMITS = Object.freeze({
  secretBytes: 32,
});

const CANONICAL_SECRET = /^[A-Za-z0-9_-]{43}$/;
const DOMAIN = Buffer.from('qinglong-worker-credential-v1\0', 'utf8');

function decode(name: string, value: string): Buffer {
  if (typeof value !== 'string' || !CANONICAL_SECRET.test(value)) {
    throw new TypeError(`${name} must be canonical base64url for 32 bytes`);
  }
  const result = Buffer.from(value, 'base64url');
  if (result.byteLength !== 32 || result.toString('base64url') !== value) {
    result.fill(0);
    throw new TypeError(`${name} must be canonical base64url for 32 bytes`);
  }
  return result;
}

export function assertWorkerCredentialPepper(value: string): void {
  const pepper = decode('Worker credential pepper', value);
  pepper.fill(0);
}

export function workerCredentialSecretDigest(
  pepperBase64Url: string,
  credentialId: string,
  secretBase64Url: string,
): string {
  normalizeWorkerCredentialId(credentialId);
  const pepper = decode('Worker credential pepper', pepperBase64Url);
  const secret = decode('Worker credential secret', secretBase64Url);
  let digest: Buffer | undefined;
  try {
    digest = createHmac('sha256', pepper)
      .update(DOMAIN)
      .update(credentialId, 'utf8')
      .update('\0', 'utf8')
      .update(secret)
      .digest();
    return digest.toString('hex');
  } finally {
    digest?.fill(0);
    pepper.fill(0);
    secret.fill(0);
  }
}

export function formatWorkerCredentialToken(
  credentialId: string,
  secretBase64Url: string,
): string {
  normalizeWorkerCredentialId(credentialId);
  const secret = decode('Worker credential secret', secretBase64Url);
  secret.fill(0);
  return `ql3w_${credentialId}_${secretBase64Url}`;
}
