import { createHmac } from 'node:crypto';

import { assertApiCredentialId } from './apiCredential';

export const API_CREDENTIAL_SECRET_BYTES = 32;
export const API_CREDENTIAL_DIGEST_DOMAIN = 'qinglong-api-credential-v1\0';

const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class InvalidApiCredentialTokenValueError extends TypeError {
  constructor(message: string) {
    super(`API credential token value is invalid: ${message}`);
    this.name = 'InvalidApiCredentialTokenValueError';
  }
}

function decodeCanonical(name: string, value: string): Buffer {
  if (typeof value !== 'string' || !BASE64URL_32_PATTERN.test(value)) {
    throw new InvalidApiCredentialTokenValueError(
      `${name} must be canonical base64url for 32 bytes`,
    );
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.byteLength !== API_CREDENTIAL_SECRET_BYTES ||
    decoded.toString('base64url') !== value
  ) {
    decoded.fill(0);
    throw new InvalidApiCredentialTokenValueError(
      `${name} must be canonical base64url for 32 bytes`,
    );
  }
  return decoded;
}

export function assertApiCredentialPepper(value: string): void {
  const decoded = decodeCanonical('pepper', value);
  decoded.fill(0);
}

export function assertApiCredentialSecret(value: string): void {
  const decoded = decodeCanonical('secret', value);
  decoded.fill(0);
}

export function apiCredentialSecretDigest(
  pepperBase64Url: string,
  credentialId: string,
  secretBase64Url: string,
): string {
  try {
    assertApiCredentialId(credentialId);
  } catch {
    throw new InvalidApiCredentialTokenValueError('credentialId is invalid');
  }
  const pepper = decodeCanonical('pepper', pepperBase64Url);
  const secret = decodeCanonical('secret', secretBase64Url);
  let result: Buffer | undefined;
  try {
    result = createHmac('sha256', pepper)
      .update(API_CREDENTIAL_DIGEST_DOMAIN, 'utf8')
      .update(credentialId, 'utf8')
      .update('\0', 'utf8')
      .update(secret)
      .digest();
    return result.toString('hex');
  } finally {
    result?.fill(0);
    pepper.fill(0);
    secret.fill(0);
  }
}

export function formatApiCredentialToken(
  credentialId: string,
  secretBase64Url: string,
): string {
  try {
    assertApiCredentialId(credentialId);
    assertApiCredentialSecret(secretBase64Url);
  } catch (error) {
    if (error instanceof InvalidApiCredentialTokenValueError) throw error;
    throw new InvalidApiCredentialTokenValueError('credentialId is invalid');
  }
  return `ql3c_${credentialId}_${secretBase64Url}`;
}
