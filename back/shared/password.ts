import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const deriveKey = promisify(scrypt);
const HASH_PREFIX = 'scrypt$';

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = (await deriveKey(password, salt, 64)) as Buffer;
  return `${HASH_PREFIX}${salt}$${key.toString('hex')}`;
}

export function isPasswordHash(password: string): boolean {
  return /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(password);
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  if (!isPasswordHash(stored)) {
    // Existing installations migrate after a successful password check.
    const input = Buffer.from(password);
    const expected = Buffer.from(stored);
    return input.length === expected.length && timingSafeEqual(input, expected);
  }
  const [, salt, hash] = stored.split('$');
  const key = (await deriveKey(password, salt, 64)) as Buffer;
  return timingSafeEqual(key, Buffer.from(hash, 'hex'));
}
