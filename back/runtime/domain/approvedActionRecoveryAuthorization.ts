import { createHash } from 'crypto';
import type { AuthenticationAssurance } from './authenticatedPrincipal';
import {
  assertApprovalMutationId,
  assertApprovalTimestamp,
} from './approvalRequest';
import {
  assertProjectPolicyProjectId,
  normalizePolicySubject,
  type PolicySubject,
} from './projectPolicy';

export const APPROVED_ACTION_RECOVERY_STRONG_ASSURANCES = [
  'multi_factor',
  'hardware',
  'local_console',
] as const satisfies readonly AuthenticationAssurance[];

export type ApprovedActionRecoveryStrongAssurance =
  (typeof APPROVED_ACTION_RECOVERY_STRONG_ASSURANCES)[number];

export const MAX_APPROVED_ACTION_RECOVERY_AUTH_AGE_MS = 5 * 60 * 1000;
export const MAX_APPROVED_ACTION_RECOVERY_AUTHENTICATION_ID_LENGTH = 128;

export interface ApprovedActionRecoveryAuthorizationFact {
  dispatchId: string;
  projectId: string;
  mutationId: string;
  resolvedBy: Readonly<PolicySubject>;
  authenticationId: string;
  assurance: ApprovedActionRecoveryStrongAssurance;
  authenticatedAtMs: number;
  projectVersion: number;
  bindingVersion: number;
  authorizedAtMs: number;
  factDigest: string;
}

const AUTHENTICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_VERSION = 2_147_483_647;

export class InvalidApprovedActionRecoveryAuthorizationError extends TypeError {
  constructor(message: string) {
    super(`Approved action recovery authorization is invalid: ${message}`);
    this.name = 'InvalidApprovedActionRecoveryAuthorizationError';
  }
}

export class ApprovedActionRecoveryHumanRequiredError extends Error {
  readonly code = 'APPROVED_ACTION_RECOVERY_HUMAN_REQUIRED';

  constructor() {
    super('Manual recovery requires a stable authenticated User');
    this.name = 'ApprovedActionRecoveryHumanRequiredError';
  }
}

export class ApprovedActionRecoveryStrongAuthenticationRequiredError extends Error {
  readonly code = 'APPROVED_ACTION_RECOVERY_STRONG_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Manual recovery requires recent strong authentication');
    this.name = 'ApprovedActionRecoveryStrongAuthenticationRequiredError';
  }
}

export class ApprovedActionRecoveryAuthorizationDeniedError extends Error {
  readonly code = 'APPROVED_ACTION_RECOVERY_AUTHORIZATION_DENIED';

  constructor() {
    super('Manual recovery is denied by Project policy');
    this.name = 'ApprovedActionRecoveryAuthorizationDeniedError';
  }
}

export class ApprovedActionRecoveryNotFoundError extends Error {
  readonly code = 'APPROVED_ACTION_RECOVERY_NOT_FOUND';

  constructor() {
    super('Approved action recovery does not exist');
    this.name = 'ApprovedActionRecoveryNotFoundError';
  }
}

function exactKeys(value: object, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidApprovedActionRecoveryAuthorizationError(
      'fact shape is invalid',
    );
  }
}

function assertVersion(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_VERSION) {
    throw new InvalidApprovedActionRecoveryAuthorizationError(
      `${name} is invalid`,
    );
  }
}

function canonicalFact(
  fact: Omit<ApprovedActionRecoveryAuthorizationFact, 'factDigest'>,
): string {
  return JSON.stringify({
    dispatchId: fact.dispatchId,
    projectId: fact.projectId,
    mutationId: fact.mutationId,
    resolvedByType: fact.resolvedBy.type,
    resolvedById: fact.resolvedBy.id,
    authenticationId: fact.authenticationId,
    assurance: fact.assurance,
    authenticatedAtMs: fact.authenticatedAtMs,
    projectVersion: fact.projectVersion,
    bindingVersion: fact.bindingVersion,
    authorizedAtMs: fact.authorizedAtMs,
  });
}

export function digestApprovedActionRecoveryAuthorizationFact(
  fact: Omit<ApprovedActionRecoveryAuthorizationFact, 'factDigest'>,
): string {
  return createHash('sha256').update(canonicalFact(fact), 'utf8').digest('hex');
}

export function normalizeApprovedActionRecoveryAuthorizationFact(
  value: ApprovedActionRecoveryAuthorizationFact,
): Readonly<ApprovedActionRecoveryAuthorizationFact> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApprovedActionRecoveryAuthorizationError(
      'fact must be an object',
    );
  }
  exactKeys(value, [
    'dispatchId',
    'projectId',
    'mutationId',
    'resolvedBy',
    'authenticationId',
    'assurance',
    'authenticatedAtMs',
    'projectVersion',
    'bindingVersion',
    'authorizedAtMs',
    'factDigest',
  ]);
  assertApprovalMutationId(value.dispatchId);
  assertProjectPolicyProjectId(value.projectId);
  assertApprovalMutationId(value.mutationId);
  const resolvedBy = normalizePolicySubject(value.resolvedBy);
  if (resolvedBy.type !== 'user') {
    throw new InvalidApprovedActionRecoveryAuthorizationError(
      'resolvedBy must be a User',
    );
  }
  if (
    typeof value.authenticationId !== 'string' ||
    value.authenticationId.length < 1 ||
    value.authenticationId.length >
      MAX_APPROVED_ACTION_RECOVERY_AUTHENTICATION_ID_LENGTH ||
    !AUTHENTICATION_ID_PATTERN.test(value.authenticationId)
  ) {
    throw new InvalidApprovedActionRecoveryAuthorizationError(
      'authenticationId is invalid',
    );
  }
  if (!APPROVED_ACTION_RECOVERY_STRONG_ASSURANCES.includes(value.assurance)) {
    throw new InvalidApprovedActionRecoveryAuthorizationError(
      'assurance is not strong',
    );
  }
  assertApprovalTimestamp('authenticatedAtMs', value.authenticatedAtMs);
  assertApprovalTimestamp('authorizedAtMs', value.authorizedAtMs);
  if (
    value.authenticatedAtMs > value.authorizedAtMs ||
    value.authorizedAtMs - value.authenticatedAtMs >
      MAX_APPROVED_ACTION_RECOVERY_AUTH_AGE_MS
  ) {
    throw new InvalidApprovedActionRecoveryAuthorizationError(
      'authentication is not recent',
    );
  }
  assertVersion('projectVersion', value.projectVersion);
  assertVersion('bindingVersion', value.bindingVersion);
  if (
    typeof value.factDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.factDigest)
  ) {
    throw new InvalidApprovedActionRecoveryAuthorizationError(
      'factDigest is invalid',
    );
  }
  const { factDigest, ...unsigned } = value;
  if (digestApprovedActionRecoveryAuthorizationFact(unsigned) !== factDigest) {
    throw new InvalidApprovedActionRecoveryAuthorizationError(
      'factDigest does not match',
    );
  }
  return Object.freeze({ ...value, resolvedBy });
}

export function createApprovedActionRecoveryAuthorizationFact(
  value: Omit<ApprovedActionRecoveryAuthorizationFact, 'factDigest'>,
): Readonly<ApprovedActionRecoveryAuthorizationFact> {
  return normalizeApprovedActionRecoveryAuthorizationFact({
    ...value,
    factDigest: digestApprovedActionRecoveryAuthorizationFact(value),
  });
}
