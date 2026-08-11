import { createHash } from 'crypto';
import {
  InvalidProjectPolicyValueError,
  assertProjectPolicyProjectId,
  normalizePolicySubject,
  type PolicySubject,
} from './projectPolicy';

export const OWNER_BOOTSTRAP_TOKEN_BYTES = 32;
export const OWNER_BOOTSTRAP_CHALLENGE_ID_BYTES = 16;
export const OWNER_BOOTSTRAP_DEFAULT_TTL_MS = 10 * 60 * 1000;
export const OWNER_BOOTSTRAP_MIN_TTL_MS = 60 * 1000;
export const OWNER_BOOTSTRAP_MAX_TTL_MS = 30 * 60 * 1000;
export const OWNER_BOOTSTRAP_MAX_VERSION = 2_147_483_647;
export const OWNER_BOOTSTRAP_SYSTEM_SUBJECT = Object.freeze({
  type: 'system' as const,
  id: 'owner-bootstrap',
});

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_DOMAIN = 'qinglong3-owner-bootstrap-v1\0';

export interface ProjectOwnerBootstrapChallengeRecord {
  projectId: string;
  version: number;
  challengeId: string;
  tokenDigest: string;
  issuedAtMs: number;
  expiresAtMs: number;
  consumedAtMs?: number;
  claimedSubject?: PolicySubject;
}

export class InvalidProjectOwnerBootstrapValueError extends TypeError {
  constructor(message: string) {
    super(`Project owner bootstrap value is invalid: ${message}`);
    this.name = 'InvalidProjectOwnerBootstrapValueError';
  }
}

export class ProjectOwnerBootstrapUnauthorizedError extends Error {
  readonly code = 'PROJECT_OWNER_BOOTSTRAP_UNAUTHORIZED';

  constructor() {
    super('Project owner bootstrap caller is not authorized');
    this.name = 'ProjectOwnerBootstrapUnauthorizedError';
  }
}

export class ProjectOwnerBootstrapProjectNotFoundError extends Error {
  readonly code = 'PROJECT_OWNER_BOOTSTRAP_PROJECT_NOT_FOUND';

  constructor() {
    super('Project does not exist');
    this.name = 'ProjectOwnerBootstrapProjectNotFoundError';
  }
}

export class ProjectOwnerBootstrapProjectInactiveError extends Error {
  readonly code = 'PROJECT_OWNER_BOOTSTRAP_PROJECT_INACTIVE';

  constructor() {
    super('Project is not active');
    this.name = 'ProjectOwnerBootstrapProjectInactiveError';
  }
}

export class ProjectOwnerBootstrapProjectNotPristineError extends Error {
  readonly code = 'PROJECT_OWNER_BOOTSTRAP_PROJECT_NOT_PRISTINE';

  constructor() {
    super('Project owner bootstrap is no longer available');
    this.name = 'ProjectOwnerBootstrapProjectNotPristineError';
  }
}

export class ProjectOwnerBootstrapChallengeActiveError extends Error {
  readonly code = 'PROJECT_OWNER_BOOTSTRAP_CHALLENGE_ACTIVE';

  constructor() {
    super('A Project owner bootstrap challenge is already active');
    this.name = 'ProjectOwnerBootstrapChallengeActiveError';
  }
}

export class ProjectOwnerBootstrapClaimRejectedError extends Error {
  readonly code = 'PROJECT_OWNER_BOOTSTRAP_CLAIM_REJECTED';

  constructor() {
    super('Project owner bootstrap claim was rejected');
    this.name = 'ProjectOwnerBootstrapClaimRejectedError';
  }
}

export class ProjectOwnerBootstrapUnavailableError extends Error {
  readonly code = 'PROJECT_OWNER_BOOTSTRAP_UNAVAILABLE';

  constructor() {
    super('Project owner bootstrap is unavailable');
    this.name = 'ProjectOwnerBootstrapUnavailableError';
  }
}

function assertTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidProjectOwnerBootstrapValueError(`${name} is invalid`);
  }
}

export function assertProjectOwnerBootstrapToken(value: string): void {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    throw new InvalidProjectOwnerBootstrapValueError('token is invalid');
  }
}

export function assertProjectOwnerBootstrapChallengeId(value: string): void {
  if (typeof value !== 'string' || !CHALLENGE_ID_PATTERN.test(value)) {
    throw new InvalidProjectOwnerBootstrapValueError('challengeId is invalid');
  }
}

export function assertProjectOwnerBootstrapTokenDigest(value: string): void {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new InvalidProjectOwnerBootstrapValueError('tokenDigest is invalid');
  }
}

export function assertProjectOwnerBootstrapTtl(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < OWNER_BOOTSTRAP_MIN_TTL_MS ||
    value > OWNER_BOOTSTRAP_MAX_TTL_MS
  ) {
    throw new InvalidProjectOwnerBootstrapValueError('ttlMs is invalid');
  }
}

export function digestProjectOwnerBootstrapToken(
  projectId: string,
  challengeId: string,
  token: string,
): string {
  assertProjectPolicyProjectId(projectId);
  assertProjectOwnerBootstrapChallengeId(challengeId);
  assertProjectOwnerBootstrapToken(token);
  return createHash('sha256')
    .update(DIGEST_DOMAIN, 'utf8')
    .update(projectId, 'utf8')
    .update('\0', 'utf8')
    .update(challengeId, 'utf8')
    .update('\0', 'utf8')
    .update(token, 'utf8')
    .digest('hex');
}

export function normalizeProjectOwnerBootstrapChallengeRecord(
  value: ProjectOwnerBootstrapChallengeRecord,
): Readonly<ProjectOwnerBootstrapChallengeRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProjectOwnerBootstrapValueError(
      'challenge must be an object',
    );
  }
  const consumed = value.consumedAtMs !== undefined;
  const expected = consumed
    ? [
        'challengeId',
        'claimedSubject',
        'consumedAtMs',
        'expiresAtMs',
        'issuedAtMs',
        'projectId',
        'tokenDigest',
        'version',
      ]
    : [
        'challengeId',
        'expiresAtMs',
        'issuedAtMs',
        'projectId',
        'tokenDigest',
        'version',
      ];
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new InvalidProjectOwnerBootstrapValueError(
      'challenge shape is invalid',
    );
  }
  try {
    assertProjectPolicyProjectId(value.projectId);
  } catch (error) {
    if (error instanceof InvalidProjectPolicyValueError) {
      throw new InvalidProjectOwnerBootstrapValueError('projectId is invalid');
    }
    throw error;
  }
  if (
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    value.version > OWNER_BOOTSTRAP_MAX_VERSION
  ) {
    throw new InvalidProjectOwnerBootstrapValueError('version is invalid');
  }
  assertProjectOwnerBootstrapChallengeId(value.challengeId);
  assertProjectOwnerBootstrapTokenDigest(value.tokenDigest);
  assertTimestamp('issuedAtMs', value.issuedAtMs);
  assertTimestamp('expiresAtMs', value.expiresAtMs);
  if (value.expiresAtMs <= value.issuedAtMs) {
    throw new InvalidProjectOwnerBootstrapValueError('lifetime is invalid');
  }
  if (!consumed) return Object.freeze({ ...value });
  assertTimestamp('consumedAtMs', value.consumedAtMs!);
  if (value.consumedAtMs! < value.issuedAtMs) {
    throw new InvalidProjectOwnerBootstrapValueError(
      'consumption time is invalid',
    );
  }
  if (!value.claimedSubject) {
    throw new InvalidProjectOwnerBootstrapValueError(
      'claimedSubject is required',
    );
  }
  const claimedSubject = normalizePolicySubject(value.claimedSubject);
  return Object.freeze({ ...value, claimedSubject });
}
