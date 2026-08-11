import { timingSafeEqual } from 'node:crypto';
import {
  LocalSecretUnavailableError,
  assertLocalSecretKeyId,
  type LocalSecretEnvelope,
  type LocalSecretKeyMaterial,
} from '@qinglong/runtime-core/local-secret';
import { decryptLocalSecretEnvelopeToBuffer } from './crypto';

export function ownedLocalSecretKeyMaterial(
  material: LocalSecretKeyMaterial | null,
  expectedKeyId?: string,
): { keyId: string; key: Buffer } {
  if (!material || !(material.key instanceof Uint8Array)) {
    throw new LocalSecretUnavailableError();
  }
  try {
    assertLocalSecretKeyId(material.keyId);
    if (
      (expectedKeyId !== undefined && material.keyId !== expectedKeyId) ||
      material.key.byteLength !== 32
    ) {
      throw new LocalSecretUnavailableError();
    }
    return { keyId: material.keyId, key: Buffer.from(material.key) };
  } catch {
    throw new LocalSecretUnavailableError();
  } finally {
    material.key.fill(0);
  }
}

export function localSecretPlaintextMatches(
  envelope: LocalSecretEnvelope,
  key: Uint8Array,
  expected: string,
): boolean {
  const actual = decryptLocalSecretEnvelopeToBuffer(envelope, key);
  const wanted = Buffer.from(expected, 'utf8');
  try {
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  } finally {
    actual.fill(0);
    wanted.fill(0);
  }
}
