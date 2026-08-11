import path from 'path';

export const LEGACY_LOG_OUTPUT_REF_PREFIX = 'legacy-log-v1.';
export const MAX_LEGACY_LOG_PATH_BYTES = 360;
export const MAX_LEGACY_LOG_OUTPUT_REF_BYTES = 512;

function normalizeRelativeLogPath(value: string): string {
  if (
    !value ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_LEGACY_LOG_PATH_BYTES
  ) {
    throw new Error('Legacy log path must be a bounded relative POSIX path');
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('Legacy log path escapes its configured root');
  }
  return normalized;
}

export function createLegacyLogOutputRef(logPath: string): string {
  const normalized = normalizeRelativeLogPath(logPath);
  const outputRef = `${LEGACY_LOG_OUTPUT_REF_PREFIX}${Buffer.from(
    normalized,
    'utf8',
  ).toString('base64url')}`;
  if (Buffer.byteLength(outputRef, 'utf8') > MAX_LEGACY_LOG_OUTPUT_REF_BYTES) {
    throw new Error('Legacy log output reference exceeds its size limit');
  }
  return outputRef;
}

export function parseLegacyLogOutputRef(outputRef?: string): string | null {
  if (
    !outputRef ||
    !outputRef.startsWith(LEGACY_LOG_OUTPUT_REF_PREFIX) ||
    Buffer.byteLength(outputRef, 'utf8') > MAX_LEGACY_LOG_OUTPUT_REF_BYTES
  ) {
    return null;
  }
  const encoded = outputRef.slice(LEGACY_LOG_OUTPUT_REF_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return null;
    const decoded = bytes.toString('utf8');
    if (Buffer.from(decoded, 'utf8').compare(bytes) !== 0) return null;
    const normalized = normalizeRelativeLogPath(decoded);
    return normalized === decoded ? decoded : null;
  } catch {
    return null;
  }
}
