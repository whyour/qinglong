import { createHash } from 'crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import {
  assertAuthenticatedPrincipalActive,
  normalizeAuthenticatedPrincipal,
  type AuthenticatedPrincipal,
} from '../domain/authenticatedPrincipal';
import {
  IdentityDirectoryUnavailableError,
  LEGACY_PANEL_IDENTITY_PROVIDER,
  LEGACY_PANEL_PROVIDER_SUBJECT,
} from '../domain/identityDirectory';
import type { IdentityDirectoryRepository } from '../ports/identityDirectoryRepository';
import type {
  LegacyPanelPlatform,
  LegacyPanelSessionSource,
} from '../ports/legacyPanelSessionSource';

const LEGACY_PANEL_JWT_PATTERN =
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_LEGACY_PANEL_TOKEN_LENGTH = 4096;
const MAX_LEGACY_PANEL_JWT_DATA_LENGTH = 256;

export interface AuthenticateLegacyPanelSessionRequest {
  token: string;
  platform: LegacyPanelPlatform;
  nowMs: number;
}

export class LegacyPanelAuthenticationRejectedError extends Error {
  readonly code = 'LEGACY_PANEL_AUTHENTICATION_REJECTED';

  constructor() {
    super('Legacy panel authentication was rejected');
    this.name = 'LegacyPanelAuthenticationRejectedError';
  }
}

export class LegacyPanelAuthenticationUnavailableError extends Error {
  readonly code = 'LEGACY_PANEL_AUTHENTICATION_UNAVAILABLE';

  constructor() {
    super('Legacy panel authentication is unavailable');
    this.name = 'LegacyPanelAuthenticationUnavailableError';
  }
}

function assertExactRequest(request: AuthenticateLegacyPanelSessionRequest) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Legacy panel authentication request is invalid');
  }
  const keys = Object.keys(request).sort();
  const expected = ['nowMs', 'platform', 'token'];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError('Legacy panel authentication request shape is invalid');
  }
  if (
    typeof request.token !== 'string' ||
    request.token.length < 1 ||
    request.token.length > MAX_LEGACY_PANEL_TOKEN_LENGTH ||
    !LEGACY_PANEL_JWT_PATTERN.test(request.token)
  ) {
    throw new LegacyPanelAuthenticationRejectedError();
  }
  if (request.platform !== 'desktop' && request.platform !== 'mobile') {
    throw new TypeError('Legacy panel platform is invalid');
  }
  if (!Number.isSafeInteger(request.nowMs) || request.nowMs < 0) {
    throw new TypeError('Legacy panel authentication time is invalid');
  }
}

function normalizePayload(value: string | JwtPayload): {
  authenticatedAtMs: number;
  expiresAtMs: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LegacyPanelAuthenticationRejectedError();
  }
  const keys = Object.keys(value).sort();
  const expected = ['data', 'exp', 'iat'];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new LegacyPanelAuthenticationRejectedError();
  }
  if (
    typeof value.data !== 'string' ||
    value.data.length < 1 ||
    value.data.length > MAX_LEGACY_PANEL_JWT_DATA_LENGTH ||
    !Number.isSafeInteger(value.iat) ||
    value.iat! < 0 ||
    !Number.isSafeInteger(value.exp) ||
    value.exp! <= value.iat!
  ) {
    throw new LegacyPanelAuthenticationRejectedError();
  }
  const authenticatedAtMs = value.iat! * 1000;
  const expiresAtMs = value.exp! * 1000;
  if (
    !Number.isSafeInteger(authenticatedAtMs) ||
    !Number.isSafeInteger(expiresAtMs)
  ) {
    throw new LegacyPanelAuthenticationRejectedError();
  }
  return { authenticatedAtMs, expiresAtMs };
}

export class LegacyPanelAuthenticationService {
  constructor(
    private readonly identityDirectory: IdentityDirectoryRepository,
    private readonly sessions: LegacyPanelSessionSource,
    private readonly jwtSecret: string,
  ) {
    if (
      typeof jwtSecret !== 'string' ||
      jwtSecret.length < 1 ||
      jwtSecret.length > 4096
    ) {
      throw new TypeError('Legacy panel JWT secret is invalid');
    }
  }

  async authenticate(
    request: AuthenticateLegacyPanelSessionRequest,
  ): Promise<Readonly<AuthenticatedPrincipal>> {
    assertExactRequest(request);
    let payload: { authenticatedAtMs: number; expiresAtMs: number };
    try {
      payload = normalizePayload(
        jwt.verify(request.token, this.jwtSecret, {
          algorithms: ['HS384'],
          clockTimestamp: Math.floor(request.nowMs / 1000),
          clockTolerance: 0,
        }),
      );
    } catch {
      throw new LegacyPanelAuthenticationRejectedError();
    }
    if (
      payload.authenticatedAtMs > request.nowMs ||
      payload.expiresAtMs <= request.nowMs
    ) {
      throw new LegacyPanelAuthenticationRejectedError();
    }

    let active: boolean;
    try {
      active = await this.sessions.isActive(request.token, request.platform);
    } catch {
      throw new LegacyPanelAuthenticationUnavailableError();
    }
    if (!active) throw new LegacyPanelAuthenticationRejectedError();

    let subject;
    try {
      subject = await this.identityDirectory.resolveAuthenticationSubject(
        LEGACY_PANEL_IDENTITY_PROVIDER,
        LEGACY_PANEL_PROVIDER_SUBJECT,
      );
    } catch (error) {
      if (error instanceof IdentityDirectoryUnavailableError) {
        throw new LegacyPanelAuthenticationUnavailableError();
      }
      throw new LegacyPanelAuthenticationUnavailableError();
    }
    if (!subject || subject.type !== 'user') {
      throw new LegacyPanelAuthenticationRejectedError();
    }

    const principal = normalizeAuthenticatedPrincipal({
      subject,
      authenticationId: `legacy_panel:${createHash('sha256')
        .update(request.token, 'utf8')
        .digest('hex')}`,
      authenticatedAtMs: payload.authenticatedAtMs,
      expiresAtMs: payload.expiresAtMs,
      assurance: 'single_factor',
    });
    try {
      assertAuthenticatedPrincipalActive(principal, request.nowMs);
    } catch {
      throw new LegacyPanelAuthenticationRejectedError();
    }
    return principal;
  }
}
