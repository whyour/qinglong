import { createHash, timingSafeEqual } from 'node:crypto';
import {
  normalizeApiCredentialRecord,
  type ApiCredentialRecord,
} from '../security/identity-credential/apiCredential';
import {
  normalizeIdentitySubjectRecord,
  type IdentitySubjectRecord,
} from '../security/identity-credential/identityAdministration';
import {
  assertProjectPolicyProjectId,
  normalizeProjectRoleBinding,
  type ProjectRoleBindingRecord,
} from '../security/project-policy/projectPolicy';
import { normalizeSecurityPrincipal, type SecurityPrincipal } from '../security/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '../security/audit/securityAudit';

export const LOCAL_OWNER_BOOTSTRAP_TOKEN_BYTES = 32;
export const LOCAL_OWNER_BOOTSTRAP_CHALLENGE_ID_BYTES = 16;
export const LOCAL_OWNER_BOOTSTRAP_DEFAULT_TTL_MS = 10 * 60 * 1000;
export const LOCAL_OWNER_BOOTSTRAP_MIN_TTL_MS = 60 * 1000;
export const LOCAL_OWNER_BOOTSTRAP_MAX_TTL_MS = 30 * 60 * 1000;
export const LOCAL_OWNER_BOOTSTRAP_SYSTEM_SUBJECT = Object.freeze({
  type: 'system' as const,
  id: 'owner-bootstrap',
});

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHALLENGE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_DOMAIN = 'qinglong3-local-owner-bootstrap-v1\0';
const MAX_VERSION = 2_147_483_647;

export interface LocalIdentityProvisioningRecord {
  readonly mutationId: string;
  readonly requestId: string;
  readonly identity: IdentitySubjectRecord;
  readonly credential: ApiCredentialRecord;
  readonly issuer: SecurityPrincipal;
  readonly audit: SecurityAuditRecord;
  readonly createdAtMs: number;
}

export interface ProvisionLocalIdentityCommand
  extends LocalIdentityProvisioningRecord {}

export interface ProvisionLocalIdentityResult {
  readonly status: 'inserted' | 'existing';
  readonly provisioning: Readonly<LocalIdentityProvisioningRecord>;
}

export interface LocalOwnerBootstrapChallengeRecord {
  readonly projectId: string;
  readonly version: number;
  readonly issueMutationId: string;
  readonly issueRequestId: string;
  readonly challengeId: string;
  readonly tokenDigest: string;
  readonly issuer: SecurityPrincipal;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly issueAudit: SecurityAuditRecord;
  readonly consumedAtMs?: number;
  readonly claimMutationId?: string;
  readonly claimRequestId?: string;
  readonly claimedPrincipal?: SecurityPrincipal;
  readonly credentialId?: string;
  readonly credentialVersion?: number;
  readonly binding?: ProjectRoleBindingRecord;
  readonly claimAudit?: SecurityAuditRecord;
}

export interface IssueLocalOwnerBootstrapChallengeCommand {
  readonly projectId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly challengeId: string;
  readonly tokenDigest: string;
  readonly issuer: SecurityPrincipal;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly audit: SecurityAuditRecord;
}

export interface IssueLocalOwnerBootstrapChallengeResult {
  readonly status: 'inserted' | 'existing';
  readonly challenge: Readonly<LocalOwnerBootstrapChallengeRecord>;
}

export interface ClaimLocalOwnerCommand {
  readonly projectId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly challengeId: string;
  readonly tokenDigest: string;
  readonly principal: SecurityPrincipal;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly claimedAtMs: number;
  readonly audit: SecurityAuditRecord;
}

export interface ClaimLocalOwnerResult {
  readonly status: 'inserted' | 'existing';
  readonly challenge: Readonly<LocalOwnerBootstrapChallengeRecord>;
  readonly binding: Readonly<ProjectRoleBindingRecord>;
}

export interface LocalOwnerCredentialDeliveryAcknowledgementRecord {
  readonly kind: 'credential';
  readonly mutationId: string;
  readonly requestId: string;
  readonly subjectId: string;
  readonly credentialId: string;
  readonly factDigest: string;
  readonly ttlMs: number;
  readonly deliveryDigest: string;
  readonly acknowledgedAtMs: number;
}

export interface LocalOwnerChallengeDeliveryAcknowledgementRecord {
  readonly kind: 'challenge';
  readonly projectId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly challengeId: string;
  readonly factDigest: string;
  readonly ttlMs: number;
  readonly deliveryDigest: string;
  readonly acknowledgedAtMs: number;
}

export type LocalOwnerSecretDeliveryAcknowledgementRecord =
  | LocalOwnerCredentialDeliveryAcknowledgementRecord
  | LocalOwnerChallengeDeliveryAcknowledgementRecord;

export interface RecordLocalOwnerSecretDeliveryAcknowledgementResult {
  readonly status: 'inserted' | 'existing';
  readonly acknowledgement: Readonly<LocalOwnerSecretDeliveryAcknowledgementRecord>;
}

export interface LocalOwnerBootstrapRepository {
  resolveProjectVersion(projectId: string): Promise<number | null>;
  resolveProvisioning(
    mutationId: string,
  ): Promise<Readonly<LocalIdentityProvisioningRecord> | null>;
  resolveIssuedChallenge(
    mutationId: string,
  ): Promise<Readonly<LocalOwnerBootstrapChallengeRecord> | null>;
  resolveDeliveryAcknowledgement(
    mutationId: string,
  ): Promise<Readonly<LocalOwnerSecretDeliveryAcknowledgementRecord> | null>;
  recordDeliveryAcknowledgement(
    acknowledgement: LocalOwnerSecretDeliveryAcknowledgementRecord,
  ): Promise<RecordLocalOwnerSecretDeliveryAcknowledgementResult>;
  provision(
    command: ProvisionLocalIdentityCommand,
  ): Promise<ProvisionLocalIdentityResult>;
  issue(
    command: IssueLocalOwnerBootstrapChallengeCommand,
  ): Promise<IssueLocalOwnerBootstrapChallengeResult>;
  claim(command: ClaimLocalOwnerCommand): Promise<ClaimLocalOwnerResult>;
  recordAudit(audit: SecurityAuditRecord): Promise<void>;
}

export class InvalidLocalOwnerBootstrapValueError extends TypeError {
  constructor(message: string) {
    super(`Local owner bootstrap value is invalid: ${message}`);
    this.name = 'InvalidLocalOwnerBootstrapValueError';
  }
}

export class LocalOwnerBootstrapNotPristineError extends Error {
  readonly code = 'LOCAL_OWNER_BOOTSTRAP_NOT_PRISTINE';

  constructor() {
    super('Local owner bootstrap is no longer available');
    this.name = 'LocalOwnerBootstrapNotPristineError';
  }
}

export class LocalOwnerBootstrapChallengeActiveError extends Error {
  readonly code = 'LOCAL_OWNER_BOOTSTRAP_CHALLENGE_ACTIVE';

  constructor() {
    super('A local owner bootstrap challenge is already active');
    this.name = 'LocalOwnerBootstrapChallengeActiveError';
  }
}

export class LocalOwnerBootstrapIdentityRequiredError extends Error {
  readonly code = 'LOCAL_OWNER_BOOTSTRAP_IDENTITY_REQUIRED';

  constructor() {
    super('A provisioned local identity is required');
    this.name = 'LocalOwnerBootstrapIdentityRequiredError';
  }
}

export class LocalOwnerBootstrapClaimRejectedError extends Error {
  readonly code = 'LOCAL_OWNER_BOOTSTRAP_CLAIM_REJECTED';

  constructor() {
    super('Local owner bootstrap claim was rejected');
    this.name = 'LocalOwnerBootstrapClaimRejectedError';
  }
}

export class LocalOwnerBootstrapMutationConflictError extends Error {
  readonly code = 'LOCAL_OWNER_BOOTSTRAP_MUTATION_CONFLICT';

  constructor() {
    super('Local owner bootstrap mutation conflicts with previous use');
    this.name = 'LocalOwnerBootstrapMutationConflictError';
  }
}

export class LocalOwnerBootstrapUnavailableError extends Error {
  readonly code = 'LOCAL_OWNER_BOOTSTRAP_UNAVAILABLE';

  constructor() {
    super('Local owner bootstrap is unavailable');
    this.name = 'LocalOwnerBootstrapUnavailableError';
  }
}

function exactKeys(
  value: object,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidLocalOwnerBootstrapValueError(`${name} shape is invalid`);
  }
}

function timestamp(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidLocalOwnerBootstrapValueError(`${name} is invalid`);
  }
  return value;
}

export function assertLocalOwnerBootstrapMutationId(value: string): void {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new InvalidLocalOwnerBootstrapValueError('mutationId is invalid');
  }
}

export function assertLocalOwnerBootstrapRequestId(value: string): void {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    throw new InvalidLocalOwnerBootstrapValueError('requestId is invalid');
  }
}

export function assertLocalOwnerBootstrapChallengeId(value: string): void {
  if (typeof value !== 'string' || !CHALLENGE_ID_PATTERN.test(value)) {
    throw new InvalidLocalOwnerBootstrapValueError('challengeId is invalid');
  }
}

export function assertLocalOwnerBootstrapToken(value: string): void {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    throw new InvalidLocalOwnerBootstrapValueError('token is invalid');
  }
}

export function assertLocalOwnerBootstrapTokenDigest(value: string): void {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new InvalidLocalOwnerBootstrapValueError('tokenDigest is invalid');
  }
}

export function assertLocalOwnerBootstrapTtl(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < LOCAL_OWNER_BOOTSTRAP_MIN_TTL_MS ||
    value > LOCAL_OWNER_BOOTSTRAP_MAX_TTL_MS
  ) {
    throw new InvalidLocalOwnerBootstrapValueError('ttlMs is invalid');
  }
}

export function normalizeLocalOwnerSecretDeliveryAcknowledgementRecord(
  value: LocalOwnerSecretDeliveryAcknowledgementRecord,
): Readonly<LocalOwnerSecretDeliveryAcknowledgementRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerBootstrapValueError(
      'delivery acknowledgement must be an object',
    );
  }
  assertLocalOwnerBootstrapMutationId(value.mutationId);
  assertLocalOwnerBootstrapRequestId(value.requestId);
  assertLocalOwnerBootstrapTokenDigest(value.factDigest);
  assertLocalOwnerBootstrapTokenDigest(value.deliveryDigest);
  if (
    !Number.isSafeInteger(value.ttlMs) ||
    value.ttlMs < 1 ||
    !Number.isSafeInteger(value.acknowledgedAtMs) ||
    value.acknowledgedAtMs < 0
  ) {
    throw new InvalidLocalOwnerBootstrapValueError(
      'delivery acknowledgement lifetime is invalid',
    );
  }
  if (value.kind === 'credential') {
    exactKeys(
      value,
      [
        'kind',
        'mutationId',
        'requestId',
        'subjectId',
        'credentialId',
        'factDigest',
        'ttlMs',
        'deliveryDigest',
        'acknowledgedAtMs',
      ],
      'credential delivery acknowledgement',
    );
    if (
      !/^usr_[A-Za-z0-9_-]{22}$/.test(value.subjectId) ||
      !/^own_[A-Za-z0-9_-]{22}$/.test(value.credentialId)
    ) {
      throw new InvalidLocalOwnerBootstrapValueError(
        'credential delivery acknowledgement identity is invalid',
      );
    }
    return Object.freeze({ ...value });
  }
  if (value.kind !== 'challenge') {
    throw new InvalidLocalOwnerBootstrapValueError(
      'delivery acknowledgement kind is invalid',
    );
  }
  exactKeys(
    value,
    [
      'kind',
      'projectId',
      'mutationId',
      'requestId',
      'challengeId',
      'factDigest',
      'ttlMs',
      'deliveryDigest',
      'acknowledgedAtMs',
    ],
    'challenge delivery acknowledgement',
  );
  assertProjectPolicyProjectId(value.projectId);
  assertLocalOwnerBootstrapChallengeId(value.challengeId);
  return Object.freeze({ ...value });
}

export function localOwnerSecretDeliveryAcknowledgementSemanticDigest(
  value: LocalOwnerSecretDeliveryAcknowledgementRecord,
): string {
  const record = normalizeLocalOwnerSecretDeliveryAcknowledgementRecord(value);
  const hash = createHash('sha256')
    .update('qinglong.local-owner-delivery-acknowledgement.v1\0', 'utf8')
    .update(record.kind, 'utf8')
    .update('\0', 'utf8')
    .update(record.mutationId, 'utf8')
    .update('\0', 'utf8')
    .update(record.requestId, 'utf8')
    .update('\0', 'utf8');
  if (record.kind === 'credential') {
    hash
      .update(record.subjectId, 'utf8')
      .update('\0', 'utf8')
      .update(record.credentialId, 'utf8');
  } else {
    hash
      .update(record.projectId, 'utf8')
      .update('\0', 'utf8')
      .update(record.challengeId, 'utf8');
  }
  return hash
    .update('\0', 'utf8')
    .update(record.factDigest, 'utf8')
    .update('\0', 'utf8')
    .update(record.deliveryDigest, 'utf8')
    .update('\0', 'utf8')
    .update(String(record.ttlMs), 'utf8')
    .update('\0', 'utf8')
    .update(String(record.acknowledgedAtMs), 'utf8')
    .digest('hex');
}

export function localOwnerBootstrapTokenDigest(
  projectId: string,
  challengeId: string,
  token: string,
): string {
  if (typeof projectId !== 'string' || !REQUEST_ID_PATTERN.test(projectId)) {
    throw new InvalidLocalOwnerBootstrapValueError('projectId is invalid');
  }
  assertLocalOwnerBootstrapChallengeId(challengeId);
  assertLocalOwnerBootstrapToken(token);
  return createHash('sha256')
    .update(DIGEST_DOMAIN, 'utf8')
    .update(projectId, 'utf8')
    .update('\0', 'utf8')
    .update(challengeId, 'utf8')
    .update('\0', 'utf8')
    .update(token, 'utf8')
    .digest('hex');
}

export function localOwnerBootstrapDigestMatches(
  expected: string,
  actual: string,
): boolean {
  assertLocalOwnerBootstrapTokenDigest(expected);
  assertLocalOwnerBootstrapTokenDigest(actual);
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(actual, 'hex');
  try {
    return timingSafeEqual(left, right);
  } finally {
    left.fill(0);
    right.fill(0);
  }
}

function localConsolePrincipal(
  value: SecurityPrincipal,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(value, nowMs);
  } catch {
    throw new InvalidLocalOwnerBootstrapValueError('issuer is invalid');
  }
  if (
    principal.subject.type !== LOCAL_OWNER_BOOTSTRAP_SYSTEM_SUBJECT.type ||
    principal.subject.id !== LOCAL_OWNER_BOOTSTRAP_SYSTEM_SUBJECT.id ||
    principal.assurance !== 'local_console'
  ) {
    throw new InvalidLocalOwnerBootstrapValueError('issuer is invalid');
  }
  return principal;
}

function userPrincipal(
  value: SecurityPrincipal,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(value, nowMs);
  } catch {
    throw new InvalidLocalOwnerBootstrapValueError('principal is invalid');
  }
  if (principal.subject.type !== 'user') {
    throw new InvalidLocalOwnerBootstrapValueError('principal is invalid');
  }
  return principal;
}

export function normalizeLocalIdentityProvisioningRecord(
  value: LocalIdentityProvisioningRecord,
): Readonly<LocalIdentityProvisioningRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerBootstrapValueError(
      'provisioning must be an object',
    );
  }
  exactKeys(
    value,
    [
      'mutationId',
      'requestId',
      'identity',
      'credential',
      'issuer',
      'audit',
      'createdAtMs',
    ],
    'provisioning',
  );
  assertLocalOwnerBootstrapMutationId(value.mutationId);
  assertLocalOwnerBootstrapRequestId(value.requestId);
  const createdAtMs = timestamp(value.createdAtMs, 'createdAtMs');
  const identity = normalizeIdentitySubjectRecord(value.identity);
  const credential = normalizeApiCredentialRecord(value.credential);
  const issuer = localConsolePrincipal(value.issuer, createdAtMs);
  const audit = normalizeSecurityAuditRecord(value.audit);
  if (
    identity.subject.type !== 'user' ||
    identity.status !== 'active' ||
    identity.version !== 1 ||
    identity.createdAtMs !== createdAtMs ||
    identity.updatedAtMs !== createdAtMs ||
    credential.subject.type !== identity.subject.type ||
    credential.subject.id !== identity.subject.id ||
    credential.subjectStatus !== 'active' ||
    credential.version !== 1 ||
    credential.state !== 'active' ||
    credential.createdAtMs !== createdAtMs ||
    credential.notBeforeAtMs !== createdAtMs ||
    audit.eventId !== value.mutationId ||
    audit.requestId !== value.requestId ||
    audit.operationId !== 'identity.bootstrap_provision' ||
    audit.projectId !== null ||
    audit.subject?.type !== issuer.subject.type ||
    audit.subject.id !== issuer.subject.id ||
    audit.authenticationId !== issuer.authenticationId ||
    audit.outcome !== 'allowed' ||
    audit.reasons.length !== 1 ||
    audit.reasons[0] !== 'local_console_provisioning' ||
    audit.fence !== null ||
    audit.occurredAtMs !== createdAtMs
  ) {
    throw new InvalidLocalOwnerBootstrapValueError(
      'provisioning semantics are invalid',
    );
  }
  return Object.freeze({
    mutationId: value.mutationId,
    requestId: value.requestId,
    identity,
    credential,
    issuer,
    audit,
    createdAtMs,
  });
}

export function normalizeIssueLocalOwnerBootstrapChallengeCommand(
  value: IssueLocalOwnerBootstrapChallengeCommand,
): Readonly<IssueLocalOwnerBootstrapChallengeCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerBootstrapValueError('issue must be an object');
  }
  exactKeys(
    value,
    [
      'projectId',
      'mutationId',
      'requestId',
      'challengeId',
      'tokenDigest',
      'issuer',
      'issuedAtMs',
      'expiresAtMs',
      'audit',
    ],
    'issue',
  );
  if (
    typeof value.projectId !== 'string' ||
    !REQUEST_ID_PATTERN.test(value.projectId)
  ) {
    throw new InvalidLocalOwnerBootstrapValueError('projectId is invalid');
  }
  assertLocalOwnerBootstrapMutationId(value.mutationId);
  assertLocalOwnerBootstrapRequestId(value.requestId);
  assertLocalOwnerBootstrapChallengeId(value.challengeId);
  assertLocalOwnerBootstrapTokenDigest(value.tokenDigest);
  const issuedAtMs = timestamp(value.issuedAtMs, 'issuedAtMs');
  const expiresAtMs = timestamp(value.expiresAtMs, 'expiresAtMs');
  assertLocalOwnerBootstrapTtl(expiresAtMs - issuedAtMs);
  const issuer = localConsolePrincipal(value.issuer, issuedAtMs);
  const audit = normalizeSecurityAuditRecord(value.audit);
  if (
    audit.eventId !== value.mutationId ||
    audit.requestId !== value.requestId ||
    audit.operationId !== 'project.owner_bootstrap_issue' ||
    audit.projectId !== value.projectId ||
    audit.subject?.type !== issuer.subject.type ||
    audit.subject.id !== issuer.subject.id ||
    audit.authenticationId !== issuer.authenticationId ||
    audit.outcome !== 'allowed' ||
    audit.reasons.length !== 1 ||
    audit.reasons[0] !== 'local_console_challenge' ||
    audit.fence !== null ||
    audit.occurredAtMs !== issuedAtMs
  ) {
    throw new InvalidLocalOwnerBootstrapValueError('issue audit is invalid');
  }
  return Object.freeze({ ...value, issuer, audit, issuedAtMs, expiresAtMs });
}

export function normalizeClaimLocalOwnerCommand(
  value: ClaimLocalOwnerCommand,
): Readonly<ClaimLocalOwnerCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerBootstrapValueError('claim must be an object');
  }
  exactKeys(
    value,
    [
      'projectId',
      'mutationId',
      'requestId',
      'challengeId',
      'tokenDigest',
      'principal',
      'credentialId',
      'credentialVersion',
      'claimedAtMs',
      'audit',
    ],
    'claim',
  );
  if (
    typeof value.projectId !== 'string' ||
    !REQUEST_ID_PATTERN.test(value.projectId)
  ) {
    throw new InvalidLocalOwnerBootstrapValueError('projectId is invalid');
  }
  assertLocalOwnerBootstrapMutationId(value.mutationId);
  assertLocalOwnerBootstrapRequestId(value.requestId);
  assertLocalOwnerBootstrapChallengeId(value.challengeId);
  assertLocalOwnerBootstrapTokenDigest(value.tokenDigest);
  const claimedAtMs = timestamp(value.claimedAtMs, 'claimedAtMs');
  const principal = userPrincipal(value.principal, claimedAtMs);
  if (principal.assurance !== 'single_factor') {
    throw new InvalidLocalOwnerBootstrapValueError(
      'claim principal assurance is invalid',
    );
  }
  if (
    typeof value.credentialId !== 'string' ||
    value.credentialId.length < 1 ||
    value.credentialId.length > 64 ||
    !Number.isSafeInteger(value.credentialVersion) ||
    value.credentialVersion < 1 ||
    value.credentialVersion > MAX_VERSION
  ) {
    throw new InvalidLocalOwnerBootstrapValueError(
      'credential fence is invalid',
    );
  }
  const audit = normalizeSecurityAuditRecord(value.audit);
  if (
    audit.eventId !== value.mutationId ||
    audit.requestId !== value.requestId ||
    audit.operationId !== 'project.owner_bootstrap_claim' ||
    audit.projectId !== value.projectId ||
    audit.subject?.type !== principal.subject.type ||
    audit.subject.id !== principal.subject.id ||
    audit.authenticationId !== principal.authenticationId ||
    audit.outcome !== 'allowed' ||
    audit.reasons.length !== 1 ||
    audit.reasons[0] !== 'owner_bootstrap_claim' ||
    audit.fence?.bindingVersion !== 1 ||
    audit.occurredAtMs !== claimedAtMs
  ) {
    throw new InvalidLocalOwnerBootstrapValueError('claim audit is invalid');
  }
  return Object.freeze({ ...value, principal, audit, claimedAtMs });
}

export function normalizeLocalOwnerBootstrapChallengeRecord(
  value: LocalOwnerBootstrapChallengeRecord,
): Readonly<LocalOwnerBootstrapChallengeRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidLocalOwnerBootstrapValueError(
      'challenge must be an object',
    );
  }
  const consumed = value.consumedAtMs !== undefined;
  exactKeys(
    value,
    consumed
      ? [
          'projectId',
          'version',
          'issueMutationId',
          'issueRequestId',
          'challengeId',
          'tokenDigest',
          'issuer',
          'issuedAtMs',
          'expiresAtMs',
          'issueAudit',
          'consumedAtMs',
          'claimMutationId',
          'claimRequestId',
          'claimedPrincipal',
          'credentialId',
          'credentialVersion',
          'binding',
          'claimAudit',
        ]
      : [
          'projectId',
          'version',
          'issueMutationId',
          'issueRequestId',
          'challengeId',
          'tokenDigest',
          'issuer',
          'issuedAtMs',
          'expiresAtMs',
          'issueAudit',
        ],
    'challenge',
  );
  const issue = normalizeIssueLocalOwnerBootstrapChallengeCommand({
    projectId: value.projectId,
    mutationId: value.issueMutationId,
    requestId: value.issueRequestId,
    challengeId: value.challengeId,
    tokenDigest: value.tokenDigest,
    issuer: value.issuer,
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs,
    audit: value.issueAudit,
  });
  if (
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    value.version > MAX_VERSION
  ) {
    throw new InvalidLocalOwnerBootstrapValueError('version is invalid');
  }
  if (!consumed) {
    return Object.freeze({
      projectId: issue.projectId,
      version: value.version,
      issueMutationId: issue.mutationId,
      issueRequestId: issue.requestId,
      challengeId: issue.challengeId,
      tokenDigest: issue.tokenDigest,
      issuer: issue.issuer,
      issuedAtMs: issue.issuedAtMs,
      expiresAtMs: issue.expiresAtMs,
      issueAudit: issue.audit,
    });
  }
  const claim = normalizeClaimLocalOwnerCommand({
    projectId: value.projectId,
    mutationId: value.claimMutationId!,
    requestId: value.claimRequestId!,
    challengeId: value.challengeId,
    tokenDigest: value.tokenDigest,
    principal: value.claimedPrincipal!,
    credentialId: value.credentialId!,
    credentialVersion: value.credentialVersion!,
    claimedAtMs: value.consumedAtMs!,
    audit: value.claimAudit!,
  });
  const binding = normalizeProjectRoleBinding(value.binding!);
  if (
    binding.projectId !== value.projectId ||
    binding.subject.type !== claim.principal.subject.type ||
    binding.subject.id !== claim.principal.subject.id ||
    binding.version !== 1 ||
    binding.state !== 'active' ||
    binding.role !== 'owner' ||
    binding.mutationId !== claim.mutationId ||
    binding.changedBy.type !== LOCAL_OWNER_BOOTSTRAP_SYSTEM_SUBJECT.type ||
    binding.changedBy.id !== LOCAL_OWNER_BOOTSTRAP_SYSTEM_SUBJECT.id ||
    binding.createdAtMs !== claim.claimedAtMs
  ) {
    throw new InvalidLocalOwnerBootstrapValueError(
      'claimed binding is invalid',
    );
  }
  return Object.freeze({
    projectId: issue.projectId,
    version: value.version,
    issueMutationId: issue.mutationId,
    issueRequestId: issue.requestId,
    challengeId: issue.challengeId,
    tokenDigest: issue.tokenDigest,
    issuer: issue.issuer,
    issuedAtMs: issue.issuedAtMs,
    expiresAtMs: issue.expiresAtMs,
    issueAudit: issue.audit,
    consumedAtMs: claim.claimedAtMs,
    claimMutationId: claim.mutationId,
    claimRequestId: claim.requestId,
    claimedPrincipal: claim.principal,
    credentialId: claim.credentialId,
    credentialVersion: claim.credentialVersion,
    binding,
    claimAudit: claim.audit,
  });
}
