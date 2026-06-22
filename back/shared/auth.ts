import { AuthInfo, TokenInfo } from '../data/system';
import { safeCompare } from './security';

/**
 * Validates if a token exists in the authentication info.
 * Supports both legacy string tokens and new TokenInfo array format.
 *
 * @param authInfo - The authentication information
 * @param headerToken - The token to validate
 * @param platform - The platform (desktop, mobile)
 * @returns true if the token is valid, false otherwise
 */
export function isValidToken(
  authInfo: AuthInfo | null | undefined,
  headerToken: string,
  platform: string,
): boolean {
  if (!authInfo || !headerToken) {
    return false;
  }

  const { token = '', tokens = {} } = authInfo;

  // Check legacy token field (constant-time)
  if (token && safeCompare(headerToken, token)) {
    return true;
  }

  // Check platform-specific tokens (support both legacy string and new TokenInfo[] format)
  const platformTokens = tokens[platform];

  // Handle null/undefined platformTokens
  if (platformTokens === null || platformTokens === undefined) {
    return false;
  }

  if (typeof platformTokens === 'string') {
    // Legacy format: single string token
    return safeCompare(headerToken, platformTokens);
  } else if (Array.isArray(platformTokens)) {
    // New format: array of TokenInfo objects (constant-time per entry)
    return platformTokens.some(
      (t: TokenInfo) => t && safeCompare(headerToken, t.value),
    );
  }

  // Unexpected type - log warning and reject
  return false;
}
