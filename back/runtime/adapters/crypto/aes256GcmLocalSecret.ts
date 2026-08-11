import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { TextDecoder } from 'util';
import {
  LOCAL_SECRET_ALGORITHM,
  LocalSecretUnavailableError,
  localSecretBinary,
  localSecretEnvelopeAad,
  normalizeLocalSecretEnvelope,
  type LocalSecretEnvelope,
} from '../../domain/localSecret';

const SECRET_KEY_BYTES = 32;
const SECRET_NONCE_BYTES = 12;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export type LocalSecretNonceFactory = () => Uint8Array;

function ownedSecretKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== SECRET_KEY_BYTES) {
    throw new LocalSecretUnavailableError();
  }
  return Buffer.from(key);
}

export function encryptLocalSecretEnvelope(
  metadata: Omit<LocalSecretEnvelope, 'nonce' | 'ciphertext' | 'authTag'>,
  plaintext: string,
  key: Uint8Array,
  nonceFactory: LocalSecretNonceFactory = () => randomBytes(SECRET_NONCE_BYTES),
): LocalSecretEnvelope {
  const ownedKey = ownedSecretKey(key);
  const plaintextBuffer = Buffer.from(plaintext, 'utf8');
  let nonce: Buffer | undefined;
  try {
    nonce = Buffer.from(nonceFactory());
    if (nonce.length !== SECRET_NONCE_BYTES) {
      throw new LocalSecretUnavailableError();
    }
    const cipher = createCipheriv(LOCAL_SECRET_ALGORITHM, ownedKey, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(localSecretEnvelopeAad(metadata));
    const ciphertext = Buffer.concat([
      cipher.update(plaintextBuffer),
      cipher.final(),
    ]);
    return normalizeLocalSecretEnvelope({
      ...metadata,
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      authTag: cipher.getAuthTag().toString('base64url'),
    });
  } catch (error) {
    if (error instanceof LocalSecretUnavailableError) throw error;
    throw new LocalSecretUnavailableError();
  } finally {
    ownedKey.fill(0);
    plaintextBuffer.fill(0);
    nonce?.fill(0);
  }
}

export function decryptLocalSecretEnvelopeToBuffer(
  envelope: LocalSecretEnvelope,
  key: Uint8Array,
): Buffer {
  const normalized = normalizeLocalSecretEnvelope(envelope);
  const ownedKey = ownedSecretKey(key);
  const nonce = localSecretBinary('nonce', normalized.nonce);
  const ciphertext = localSecretBinary('ciphertext', normalized.ciphertext);
  const authTag = localSecretBinary('authTag', normalized.authTag);
  try {
    const decipher = createDecipheriv(LOCAL_SECRET_ALGORITHM, ownedKey, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(localSecretEnvelopeAad(normalized));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new LocalSecretUnavailableError();
  } finally {
    ownedKey.fill(0);
    nonce.fill(0);
    authTag.fill(0);
  }
}

export function decodeLocalSecretPlaintext(plaintext: Buffer): string {
  try {
    return UTF8_DECODER.decode(plaintext);
  } catch {
    throw new LocalSecretUnavailableError();
  }
}
