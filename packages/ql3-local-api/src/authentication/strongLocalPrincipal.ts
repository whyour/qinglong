import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';

import type { AuthenticatedLocalApiRequest } from './credentialAuthenticator';
import type { ConsumedLocalPresenceProof } from './localPresenceProof';

export function strongLocalConsolePrincipal(
  authenticated: Readonly<AuthenticatedLocalApiRequest>,
  proof: Readonly<ConsumedLocalPresenceProof>,
): Readonly<SecurityPrincipal> {
  return normalizeSecurityPrincipal(
    {
      subject: authenticated.principal.subject,
      authenticationId: `local_presence:${proof.authorizationId}`,
      authenticatedAtMs: proof.authenticatedAtMs,
      expiresAtMs: Math.min(
        proof.expiresAtMs,
        authenticated.principal.expiresAtMs,
      ),
      assurance: 'local_console',
    },
    proof.authenticatedAtMs,
  );
}
