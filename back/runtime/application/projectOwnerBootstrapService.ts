import { randomBytes } from 'crypto';
import {
  assertAuthenticatedPrincipalActive,
  normalizeAuthenticatedPrincipal,
  type AuthenticatedPrincipal,
} from '../domain/authenticatedPrincipal';
import { assertProjectPolicyProjectId } from '../domain/projectPolicy';
import {
  OWNER_BOOTSTRAP_CHALLENGE_ID_BYTES,
  OWNER_BOOTSTRAP_DEFAULT_TTL_MS,
  OWNER_BOOTSTRAP_SYSTEM_SUBJECT,
  OWNER_BOOTSTRAP_TOKEN_BYTES,
  ProjectOwnerBootstrapUnauthorizedError,
  assertProjectOwnerBootstrapChallengeId,
  assertProjectOwnerBootstrapToken,
  assertProjectOwnerBootstrapTtl,
  digestProjectOwnerBootstrapToken,
} from '../domain/projectOwnerBootstrap';
import type { ProjectOwnerBootstrapRepository } from '../ports/projectOwnerBootstrapRepository';

export interface IssueProjectOwnerBootstrapRequest {
  projectId: string;
  issuer: AuthenticatedPrincipal;
  nowMs: number;
  ttlMs?: number;
}

export interface IssuedProjectOwnerBootstrapChallenge {
  projectId: string;
  challengeId: string;
  token: string;
  expiresAtMs: number;
}

export interface ClaimProjectOwnerBootstrapRequest {
  projectId: string;
  challengeId: string;
  token: string;
  principal: AuthenticatedPrincipal;
  nowMs: number;
}

export interface ProjectOwnerBootstrapRandomSource {
  bytes(size: number): Uint8Array;
}

const CRYPTO_RANDOM_SOURCE: ProjectOwnerBootstrapRandomSource = {
  bytes: randomBytes,
};

function encodeRandom(
  source: ProjectOwnerBootstrapRandomSource,
  size: number,
): string {
  const bytes = source.bytes(size);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
    throw new TypeError('Project owner bootstrap random source is invalid');
  }
  try {
    return Buffer.from(bytes).toString('base64url');
  } finally {
    bytes.fill(0);
  }
}

function assertExactRequestKeys(
  value: object,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new TypeError('Project owner bootstrap request shape is invalid');
  }
}

export class ProjectOwnerBootstrapService {
  constructor(
    private readonly repository: ProjectOwnerBootstrapRepository,
    private readonly randomSource: ProjectOwnerBootstrapRandomSource = CRYPTO_RANDOM_SOURCE,
  ) {}

  async issue(
    request: IssueProjectOwnerBootstrapRequest,
  ): Promise<Readonly<IssuedProjectOwnerBootstrapChallenge>> {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError(
        'Project owner bootstrap issue request must be an object',
      );
    }
    assertExactRequestKeys(
      request,
      request.ttlMs === undefined
        ? ['projectId', 'issuer', 'nowMs']
        : ['projectId', 'issuer', 'nowMs', 'ttlMs'],
    );
    assertProjectPolicyProjectId(request.projectId);
    const issuer = normalizeAuthenticatedPrincipal(request.issuer);
    assertAuthenticatedPrincipalActive(issuer, request.nowMs);
    if (
      issuer.subject.type !== OWNER_BOOTSTRAP_SYSTEM_SUBJECT.type ||
      issuer.subject.id !== OWNER_BOOTSTRAP_SYSTEM_SUBJECT.id ||
      issuer.assurance !== 'local_console'
    ) {
      throw new ProjectOwnerBootstrapUnauthorizedError();
    }
    const ttlMs = request.ttlMs ?? OWNER_BOOTSTRAP_DEFAULT_TTL_MS;
    assertProjectOwnerBootstrapTtl(ttlMs);
    const expiresAtMs = request.nowMs + ttlMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
      throw new TypeError('Project owner bootstrap expiry is invalid');
    }
    const challengeId = encodeRandom(
      this.randomSource,
      OWNER_BOOTSTRAP_CHALLENGE_ID_BYTES,
    );
    const token = encodeRandom(this.randomSource, OWNER_BOOTSTRAP_TOKEN_BYTES);
    assertProjectOwnerBootstrapChallengeId(challengeId);
    assertProjectOwnerBootstrapToken(token);
    const tokenDigest = digestProjectOwnerBootstrapToken(
      request.projectId,
      challengeId,
      token,
    );
    await this.repository.issue({
      projectId: request.projectId,
      challengeId,
      tokenDigest,
      issuedAtMs: request.nowMs,
      expiresAtMs,
    });
    return Object.freeze({
      projectId: request.projectId,
      challengeId,
      token,
      expiresAtMs,
    });
  }

  async claim(request: ClaimProjectOwnerBootstrapRequest) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError(
        'Project owner bootstrap claim request must be an object',
      );
    }
    assertExactRequestKeys(request, [
      'projectId',
      'challengeId',
      'token',
      'principal',
      'nowMs',
    ]);
    assertProjectPolicyProjectId(request.projectId);
    assertProjectOwnerBootstrapChallengeId(request.challengeId);
    assertProjectOwnerBootstrapToken(request.token);
    const principal = normalizeAuthenticatedPrincipal(request.principal);
    assertAuthenticatedPrincipalActive(principal, request.nowMs);
    if (principal.subject.type !== 'user') {
      throw new ProjectOwnerBootstrapUnauthorizedError();
    }
    return this.repository.claim({
      projectId: request.projectId,
      challengeId: request.challengeId,
      tokenDigest: digestProjectOwnerBootstrapToken(
        request.projectId,
        request.challengeId,
        request.token,
      ),
      subject: principal.subject,
      claimedAtMs: request.nowMs,
    });
  }
}
