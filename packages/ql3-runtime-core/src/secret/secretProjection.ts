import { createHash } from 'node:crypto';

import { parseSecretRef } from './secretReference';

export const SECRET_PROJECTION_FILE_NAME_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Maps one canonical SecretRef to a path-free, non-reversible projection key.
 * The function does not inspect or resolve Secret material.
 */
export function secretProjectionFileName(secretRef: string): string {
  parseSecretRef(secretRef);
  const result = createHash('sha256').update(secretRef, 'utf8').digest('hex');
  if (!SECRET_PROJECTION_FILE_NAME_PATTERN.test(result)) {
    throw new TypeError('Secret projection file name is invalid');
  }
  return result;
}
