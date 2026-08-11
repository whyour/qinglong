import type { DatabaseSync } from 'node:sqlite';
import {
  InvalidLocalOwnerBootstrapValueError,
  LOCAL_OWNER_BOOTSTRAP_SYSTEM_SUBJECT,
  LocalOwnerBootstrapChallengeActiveError,
  LocalOwnerBootstrapClaimRejectedError,
  LocalOwnerBootstrapIdentityRequiredError,
  LocalOwnerBootstrapMutationConflictError,
  LocalOwnerBootstrapNotPristineError,
  LocalOwnerBootstrapUnavailableError,
  assertLocalOwnerBootstrapMutationId,
  localOwnerSecretDeliveryAcknowledgementSemanticDigest,
  localOwnerBootstrapDigestMatches,
  normalizeClaimLocalOwnerCommand,
  normalizeIssueLocalOwnerBootstrapChallengeCommand,
  normalizeLocalIdentityProvisioningRecord,
  normalizeLocalOwnerBootstrapChallengeRecord,
  normalizeLocalOwnerSecretDeliveryAcknowledgementRecord,
  type ClaimLocalOwnerCommand,
  type ClaimLocalOwnerResult,
  type IssueLocalOwnerBootstrapChallengeCommand,
  type IssueLocalOwnerBootstrapChallengeResult,
  type LocalIdentityProvisioningRecord,
  type LocalOwnerBootstrapChallengeRecord,
  type LocalOwnerBootstrapRepository,
  type LocalOwnerSecretDeliveryAcknowledgementRecord,
  type ProvisionLocalIdentityCommand,
  type ProvisionLocalIdentityResult,
  type RecordLocalOwnerSecretDeliveryAcknowledgementResult,
} from '@qinglong/runtime-core/local-owner-bootstrap';
import {
  assertProjectPolicyProjectId,
  normalizeProjectRoleBinding,
  type ProjectRoleBindingRecord,
} from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityAuditRecord,
  SecurityAuditUnavailableError,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type QueryRow = Record<string, unknown>;

const AUDIT_COLUMNS = [
  'event_id',
  'request_id',
  'operation_id',
  'project_id',
  'subject_type',
  'subject_id',
  'authentication_id',
  'outcome',
  'reasons_json',
  'fence_project_version',
  'fence_binding_version',
  'occurred_at_ms',
] as const;

function requiredString(row: QueryRow, name: string): string {
  const value = row[name];
  if (typeof value !== 'string')
    throw new LocalOwnerBootstrapUnavailableError();
  return value;
}

function optionalString(row: QueryRow, name: string): string | undefined {
  const value = row[name];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new LocalOwnerBootstrapUnavailableError();
  return value;
}

function requiredInteger(row: QueryRow, name: string): number {
  const value = row[name];
  if (!Number.isSafeInteger(value))
    throw new LocalOwnerBootstrapUnavailableError();
  return value as number;
}

function optionalInteger(row: QueryRow, name: string): number | undefined {
  const value = row[name];
  if (value === null || value === undefined) return undefined;
  if (!Number.isSafeInteger(value))
    throw new LocalOwnerBootstrapUnavailableError();
  return value as number;
}

function single(rows: QueryRow[]): QueryRow | undefined {
  if (rows.length > 1) throw new LocalOwnerBootstrapUnavailableError();
  return rows[0];
}

function auditSelect(alias: string, prefix: string): string {
  return AUDIT_COLUMNS.map(
    (column) => `${alias}."${column}" AS "${prefix}${column}"`,
  ).join(', ');
}

function auditFromRow(
  row: QueryRow,
  prefix: string,
): Readonly<SecurityAuditRecord> {
  const subjectType = optionalString(row, `${prefix}subject_type`);
  const subjectId = optionalString(row, `${prefix}subject_id`);
  const authenticationId = optionalString(row, `${prefix}authentication_id`);
  const fenceProjectVersion = optionalInteger(
    row,
    `${prefix}fence_project_version`,
  );
  const fenceBindingVersion = optionalInteger(
    row,
    `${prefix}fence_binding_version`,
  );
  let reasons: unknown;
  try {
    reasons = JSON.parse(requiredString(row, `${prefix}reasons_json`));
  } catch {
    throw new LocalOwnerBootstrapUnavailableError();
  }
  try {
    return normalizeSecurityAuditRecord({
      eventId: requiredString(row, `${prefix}event_id`),
      requestId: requiredString(row, `${prefix}request_id`),
      operationId: requiredString(row, `${prefix}operation_id`),
      projectId: optionalString(row, `${prefix}project_id`) ?? null,
      subject:
        subjectType && subjectId
          ? {
              type: subjectType as NonNullable<
                SecurityAuditRecord['subject']
              >['type'],
              id: subjectId,
            }
          : null,
      authenticationId: authenticationId ?? null,
      outcome: requiredString(
        row,
        `${prefix}outcome`,
      ) as SecurityAuditRecord['outcome'],
      reasons: reasons as readonly string[],
      fence:
        fenceProjectVersion === undefined
          ? null
          : {
              projectVersion: fenceProjectVersion,
              bindingVersion: fenceBindingVersion ?? null,
            },
      occurredAtMs: requiredInteger(row, `${prefix}occurred_at_ms`),
    });
  } catch {
    throw new LocalOwnerBootstrapUnavailableError();
  }
}

function sameAuditSemantic(
  left: Readonly<SecurityAuditRecord>,
  right: Readonly<SecurityAuditRecord>,
): boolean {
  const { occurredAtMs: _left, ...leftSemantic } = left;
  const { occurredAtMs: _right, ...rightSemantic } = right;
  return JSON.stringify(leftSemantic) === JSON.stringify(rightSemantic);
}

function samePrincipal(
  left: LocalIdentityProvisioningRecord['issuer'],
  right: LocalIdentityProvisioningRecord['issuer'],
): boolean {
  return (
    left.subject.type === right.subject.type &&
    left.subject.id === right.subject.id &&
    left.authenticationId === right.authenticationId &&
    left.assurance === right.assurance
  );
}

function insertAudit(
  client: DatabaseSync,
  audit: Readonly<SecurityAuditRecord>,
): void {
  client
    .prepare(
      `INSERT INTO "QingLong3SecurityAuditEvents" (
         "event_id", "request_id", "operation_id", "project_id",
         "subject_type", "subject_id", "authentication_id", "outcome",
         "reasons_json", "fence_project_version", "fence_binding_version",
         "occurred_at_ms"
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      audit.eventId,
      audit.requestId,
      audit.operationId,
      audit.projectId,
      audit.subject?.type ?? null,
      audit.subject?.id ?? null,
      audit.authenticationId,
      audit.outcome,
      JSON.stringify(audit.reasons),
      audit.fence?.projectVersion ?? null,
      audit.fence?.bindingVersion ?? null,
      audit.occurredAtMs,
    );
}

function rollback(client: DatabaseSync, began: boolean): void {
  if (!began || !client.isTransaction) return;
  try {
    client.exec('ROLLBACK');
  } catch {
    // Preserve the original failure.
  }
}

function isDomainError(error: unknown): boolean {
  return (
    error instanceof LocalOwnerBootstrapChallengeActiveError ||
    error instanceof LocalOwnerBootstrapClaimRejectedError ||
    error instanceof LocalOwnerBootstrapIdentityRequiredError ||
    error instanceof LocalOwnerBootstrapMutationConflictError ||
    error instanceof LocalOwnerBootstrapNotPristineError ||
    error instanceof LocalOwnerBootstrapUnavailableError
  );
}

function provisioningFromRow(
  row: QueryRow,
): Readonly<LocalIdentityProvisioningRecord> {
  try {
    return normalizeLocalIdentityProvisioningRecord({
      mutationId: requiredString(row, 'mutation_id'),
      requestId: requiredString(row, 'request_id'),
      identity: {
        subject: {
          type: requiredString(row, 'subject_type') as 'user',
          id: requiredString(row, 'subject_id'),
        },
        status: requiredString(row, 'identity_status') as 'active',
        version: requiredInteger(row, 'identity_version'),
        createdAtMs: requiredInteger(row, 'identity_created_at_ms'),
        updatedAtMs: requiredInteger(row, 'identity_updated_at_ms'),
      },
      credential: {
        credentialId: requiredString(row, 'credential_id'),
        version: requiredInteger(row, 'credential_version'),
        pepperKeyId: requiredString(row, 'pepper_key_id'),
        state: requiredString(row, 'credential_state') as 'active',
        subject: {
          type: requiredString(row, 'subject_type') as 'user',
          id: requiredString(row, 'subject_id'),
        },
        subjectStatus: requiredString(row, 'identity_status') as 'active',
        secretDigest: requiredString(row, 'secret_digest'),
        createdAtMs: requiredInteger(row, 'credential_created_at_ms'),
        notBeforeAtMs: requiredInteger(row, 'not_before_at_ms'),
        expiresAtMs: requiredInteger(row, 'credential_expires_at_ms'),
      },
      issuer: {
        subject: LOCAL_OWNER_BOOTSTRAP_SYSTEM_SUBJECT,
        authenticationId: requiredString(row, 'issuer_authentication_id'),
        authenticatedAtMs: requiredInteger(row, 'issuer_authenticated_at_ms'),
        expiresAtMs: requiredInteger(row, 'issuer_expires_at_ms'),
        assurance: 'local_console',
      },
      audit: auditFromRow(row, 'audit_'),
      createdAtMs: requiredInteger(row, 'created_at_ms'),
    });
  } catch (error) {
    if (error instanceof LocalOwnerBootstrapUnavailableError) throw error;
    throw new LocalOwnerBootstrapUnavailableError();
  }
}

const PROVISIONING_SELECT = `
  SELECT p."mutation_id", p."request_id", p."subject_type", p."subject_id",
         p."credential_id", p."credential_version",
         p."issuer_authentication_id", p."issuer_authenticated_at_ms",
         p."issuer_expires_at_ms", p."created_at_ms",
         identity."status" AS "identity_status",
         identity."version" AS "identity_version",
         identity."created_at_ms" AS "identity_created_at_ms",
         identity."updated_at_ms" AS "identity_updated_at_ms",
         credential."state" AS "credential_state",
         pepper."pepper_key_id" AS "pepper_key_id",
         credential."secret_digest" AS "secret_digest",
         credential."created_at_ms" AS "credential_created_at_ms",
         credential."not_before_at_ms" AS "not_before_at_ms",
         credential."expires_at_ms" AS "credential_expires_at_ms",
         ${auditSelect('audit', 'audit_')}
  FROM "QingLong3LocalIdentityProvisionings" AS p
  JOIN "QingLong3IdentitySubjects" AS identity
    ON identity."subject_type" = p."subject_type"
   AND identity."subject_id" = p."subject_id"
  JOIN "QingLong3ApiCredentials" AS credential
    ON credential."credential_id" = p."credential_id"
   AND credential."version" = p."credential_version"
  LEFT JOIN "QingLong3ApiCredentialPepperBindings" AS pepper
    ON pepper."credential_id" = credential."credential_id"
   AND pepper."credential_version" = credential."version"
  JOIN "QingLong3SecurityAuditEvents" AS audit
    ON audit."event_id" = p."audit_event_id"
`;

function bindingFromRow(row: QueryRow): Readonly<ProjectRoleBindingRecord> {
  try {
    return normalizeProjectRoleBinding({
      projectId: requiredString(row, 'binding_project_id'),
      subject: {
        type: requiredString(row, 'binding_subject_type') as 'user',
        id: requiredString(row, 'binding_subject_id'),
      },
      version: requiredInteger(row, 'binding_version'),
      state: requiredString(row, 'binding_state') as 'active',
      role: requiredString(row, 'binding_role') as 'owner',
      mutationId: requiredString(row, 'binding_mutation_id'),
      changedBy: {
        type: requiredString(row, 'binding_changed_by_type') as 'system',
        id: requiredString(row, 'binding_changed_by_id'),
      },
      createdAtMs: requiredInteger(row, 'binding_created_at_ms'),
    });
  } catch (error) {
    if (error instanceof LocalOwnerBootstrapUnavailableError) throw error;
    throw new LocalOwnerBootstrapUnavailableError();
  }
}

function challengeFromRow(
  row: QueryRow,
): Readonly<LocalOwnerBootstrapChallengeRecord> {
  const consumedAtMs = optionalInteger(row, 'consumed_at_ms');
  try {
    return normalizeLocalOwnerBootstrapChallengeRecord({
      projectId: requiredString(row, 'project_id'),
      version: requiredInteger(row, 'version'),
      issueMutationId: requiredString(row, 'issue_mutation_id'),
      issueRequestId: requiredString(row, 'issue_request_id'),
      challengeId: requiredString(row, 'challenge_id'),
      tokenDigest: requiredString(row, 'token_digest'),
      issuer: {
        subject: LOCAL_OWNER_BOOTSTRAP_SYSTEM_SUBJECT,
        authenticationId: requiredString(row, 'issuer_authentication_id'),
        authenticatedAtMs: requiredInteger(row, 'issuer_authenticated_at_ms'),
        expiresAtMs: requiredInteger(row, 'issuer_expires_at_ms'),
        assurance: 'local_console',
      },
      issuedAtMs: requiredInteger(row, 'issued_at_ms'),
      expiresAtMs: requiredInteger(row, 'expires_at_ms'),
      issueAudit: auditFromRow(row, 'issue_audit_'),
      ...(consumedAtMs === undefined
        ? {}
        : {
            consumedAtMs,
            claimMutationId: requiredString(row, 'claim_mutation_id'),
            claimRequestId: requiredString(row, 'claim_request_id'),
            claimedPrincipal: {
              subject: {
                type: requiredString(row, 'claimed_subject_type') as 'user',
                id: requiredString(row, 'claimed_subject_id'),
              },
              authenticationId: requiredString(row, 'claim_authentication_id'),
              authenticatedAtMs: requiredInteger(
                row,
                'claim_authenticated_at_ms',
              ),
              expiresAtMs: requiredInteger(row, 'claim_expires_at_ms'),
              assurance: requiredString(
                row,
                'claim_assurance',
              ) as 'single_factor',
            },
            credentialId: requiredString(row, 'credential_id'),
            credentialVersion: requiredInteger(row, 'credential_version'),
            binding: bindingFromRow(row),
            claimAudit: auditFromRow(row, 'claim_audit_'),
          }),
    });
  } catch (error) {
    if (error instanceof LocalOwnerBootstrapUnavailableError) throw error;
    throw new LocalOwnerBootstrapUnavailableError();
  }
}

const CHALLENGE_SELECT = `
  SELECT challenge.*,
         ${auditSelect('issue_audit', 'issue_audit_')},
         ${auditSelect('claim_audit', 'claim_audit_')},
         binding."project_id" AS "binding_project_id",
         binding."subject_type" AS "binding_subject_type",
         binding."subject_id" AS "binding_subject_id",
         binding."version" AS "binding_version",
         binding."state" AS "binding_state",
         binding."role" AS "binding_role",
         binding."mutation_id" AS "binding_mutation_id",
         binding."changed_by_type" AS "binding_changed_by_type",
         binding."changed_by_id" AS "binding_changed_by_id",
         binding."created_at_ms" AS "binding_created_at_ms"
  FROM "QingLong3LocalOwnerBootstrapChallenges" AS challenge
  JOIN "QingLong3SecurityAuditEvents" AS issue_audit
    ON issue_audit."event_id" = challenge."issue_audit_event_id"
  LEFT JOIN "QingLong3SecurityAuditEvents" AS claim_audit
    ON claim_audit."event_id" = challenge."claim_audit_event_id"
  LEFT JOIN "QingLong3ProjectRoleBindings" AS binding
    ON binding."project_id" = challenge."project_id"
   AND binding."subject_type" = challenge."claimed_subject_type"
   AND binding."subject_id" = challenge."claimed_subject_id"
   AND binding."mutation_id" = challenge."claim_mutation_id"
`;

function deliveryAcknowledgementFromRow(
  row: QueryRow,
): Readonly<LocalOwnerSecretDeliveryAcknowledgementRecord> {
  try {
    const common = {
      mutationId: requiredString(row, 'mutation_id'),
      requestId: requiredString(row, 'request_id'),
      factDigest: requiredString(row, 'fact_digest'),
      ttlMs: requiredInteger(row, 'ttl_ms'),
      deliveryDigest: requiredString(row, 'delivery_digest'),
      acknowledgedAtMs: requiredInteger(row, 'acknowledged_at_ms'),
    };
    const kind = requiredString(row, 'kind');
    return normalizeLocalOwnerSecretDeliveryAcknowledgementRecord(
      kind === 'credential'
        ? {
            kind,
            ...common,
            subjectId: requiredString(row, 'subject_id'),
            credentialId: requiredString(row, 'credential_id'),
          }
        : {
            kind: kind as 'challenge',
            ...common,
            projectId: requiredString(row, 'project_id'),
            challengeId: requiredString(row, 'challenge_id'),
          },
    );
  } catch (error) {
    if (error instanceof LocalOwnerBootstrapUnavailableError) throw error;
    throw new LocalOwnerBootstrapUnavailableError();
  }
}

function sameDeliveryAcknowledgementSemantic(
  left: Readonly<LocalOwnerSecretDeliveryAcknowledgementRecord>,
  right: Readonly<LocalOwnerSecretDeliveryAcknowledgementRecord>,
): boolean {
  return (
    left.kind === right.kind &&
    left.mutationId === right.mutationId &&
    left.requestId === right.requestId &&
    left.factDigest === right.factDigest &&
    left.ttlMs === right.ttlMs &&
    left.deliveryDigest === right.deliveryDigest &&
    (left.kind === 'credential'
      ? right.kind === 'credential' &&
        left.subjectId === right.subjectId &&
        left.credentialId === right.credentialId
      : right.kind === 'challenge' &&
        left.projectId === right.projectId &&
        left.challengeId === right.challengeId)
  );
}

export class LocalSqliteOwnerBootstrapRepository
  implements LocalOwnerBootstrapRepository
{
  private readonly authority: LocalSqliteOperationAuthority;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
  }

  private resolveProvisioningDirect(
    mutationId: string,
  ): Readonly<LocalIdentityProvisioningRecord> | null {
    const row = single(
      this.authority.client
        .prepare(`${PROVISIONING_SELECT} WHERE p."mutation_id" = ? LIMIT 2`)
        .all(mutationId) as QueryRow[],
    );
    return row ? provisioningFromRow(row) : null;
  }

  resolveProjectVersion(projectId: string): Promise<number | null> {
    assertProjectPolicyProjectId(projectId);
    return this.authority.enqueue(
      async () => {
        try {
          const row = this.authority.client
            .prepare(
              `SELECT "version" FROM "QingLong3Projects"
               WHERE "id" = ? AND "status" = 'active' LIMIT 1`,
            )
            .get(projectId) as QueryRow | undefined;
          return row ? requiredInteger(row, 'version') : null;
        } catch (error) {
          if (error instanceof LocalOwnerBootstrapUnavailableError) throw error;
          throw new LocalOwnerBootstrapUnavailableError();
        }
      },
      () => new LocalOwnerBootstrapUnavailableError(),
    );
  }

  resolveProvisioning(
    mutationId: string,
  ): Promise<Readonly<LocalIdentityProvisioningRecord> | null> {
    try {
      assertLocalOwnerBootstrapMutationId(mutationId);
    } catch (error) {
      return Promise.reject(
        error instanceof InvalidLocalOwnerBootstrapValueError
          ? error
          : new InvalidLocalOwnerBootstrapValueError('mutationId is invalid'),
      );
    }
    return this.authority.enqueue(
      async () => this.resolveProvisioningDirect(mutationId),
      () => new LocalOwnerBootstrapUnavailableError(),
    );
  }

  provision(
    rawCommand: ProvisionLocalIdentityCommand,
  ): Promise<ProvisionLocalIdentityResult> {
    const command = normalizeLocalIdentityProvisioningRecord(rawCommand);
    return this.authority.enqueue(
      async () => {
        let began = false;
        try {
          this.authority.client.exec('BEGIN IMMEDIATE');
          began = true;
          const replay = this.resolveProvisioningDirect(command.mutationId);
          if (replay) {
            if (
              replay.requestId !== command.requestId ||
              !samePrincipal(replay.issuer, command.issuer) ||
              replay.credential.expiresAtMs -
                replay.credential.notBeforeAtMs !==
                command.credential.expiresAtMs -
                  command.credential.notBeforeAtMs ||
              !sameAuditSemantic(replay.audit, command.audit)
            ) {
              throw new LocalOwnerBootstrapMutationConflictError();
            }
            this.authority.client.exec('COMMIT');
            began = false;
            return Object.freeze({
              status: 'existing' as const,
              provisioning: replay,
            });
          }
          const occupied = this.authority.client
            .prepare(
              `SELECT 1 FROM "QingLong3LocalIdentityProvisionings" LIMIT 1`,
            )
            .get();
          const identityCount = this.authority.client
            .prepare(`SELECT 1 FROM "QingLong3IdentitySubjects" LIMIT 1`)
            .get();
          const credentialCount = this.authority.client
            .prepare(`SELECT 1 FROM "QingLong3ApiCredentials" LIMIT 1`)
            .get();
          if (occupied || identityCount || credentialCount) {
            throw new LocalOwnerBootstrapNotPristineError();
          }
          if (
            this.authority.client
              .prepare(
                `SELECT 1 FROM "QingLong3SecurityAuditEvents" WHERE "event_id" = ?`,
              )
              .get(command.audit.eventId)
          ) {
            throw new LocalOwnerBootstrapMutationConflictError();
          }
          this.authority.client
            .prepare(
              `INSERT INTO "QingLong3IdentitySubjects" (
                 "subject_type", "subject_id", "status", "version",
                 "created_at_ms", "updated_at_ms"
               ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              command.identity.subject.type,
              command.identity.subject.id,
              command.identity.status,
              command.identity.version,
              command.identity.createdAtMs,
              command.identity.updatedAtMs,
            );
          this.authority.client
            .prepare(
              `INSERT INTO "QingLong3ApiCredentials" (
                 "credential_id", "version", "state", "subject_type",
                 "subject_id", "secret_digest", "created_at_ms",
                 "not_before_at_ms", "expires_at_ms"
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              command.credential.credentialId,
              command.credential.version,
              command.credential.state,
              command.credential.subject.type,
              command.credential.subject.id,
              command.credential.secretDigest,
              command.credential.createdAtMs,
              command.credential.notBeforeAtMs,
              command.credential.expiresAtMs,
            );
          this.authority.client
            .prepare(
              `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
                 "credential_id", "credential_version", "pepper_key_id"
               ) VALUES (?, ?, ?)`,
            )
            .run(
              command.credential.credentialId,
              command.credential.version,
              command.credential.pepperKeyId,
            );
          insertAudit(this.authority.client, command.audit);
          this.authority.client
            .prepare(
              `INSERT INTO "QingLong3LocalIdentityProvisionings" (
                 "slot", "mutation_id", "request_id", "subject_type",
                 "subject_id", "credential_id", "credential_version",
                 "issuer_authentication_id", "issuer_authenticated_at_ms",
                 "issuer_expires_at_ms", "audit_event_id", "created_at_ms"
               ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              command.mutationId,
              command.requestId,
              command.identity.subject.type,
              command.identity.subject.id,
              command.credential.credentialId,
              command.credential.version,
              command.issuer.authenticationId,
              command.issuer.authenticatedAtMs,
              command.issuer.expiresAtMs,
              command.audit.eventId,
              command.createdAtMs,
            );
          this.authority.client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'inserted' as const,
            provisioning: command,
          });
        } catch (error) {
          rollback(this.authority.client, began);
          if (isDomainError(error)) throw error;
          throw new LocalOwnerBootstrapUnavailableError();
        }
      },
      () => new LocalOwnerBootstrapUnavailableError(),
    );
  }

  private challengeBy(
    column: 'issue_mutation_id' | 'claim_mutation_id',
    value: string,
  ): Readonly<LocalOwnerBootstrapChallengeRecord> | null {
    const row = single(
      this.authority.client
        .prepare(`${CHALLENGE_SELECT} WHERE challenge."${column}" = ? LIMIT 2`)
        .all(value) as QueryRow[],
    );
    return row ? challengeFromRow(row) : null;
  }

  resolveIssuedChallenge(
    mutationId: string,
  ): Promise<Readonly<LocalOwnerBootstrapChallengeRecord> | null> {
    try {
      assertLocalOwnerBootstrapMutationId(mutationId);
    } catch (error) {
      return Promise.reject(
        error instanceof InvalidLocalOwnerBootstrapValueError
          ? error
          : new InvalidLocalOwnerBootstrapValueError('mutationId is invalid'),
      );
    }
    return this.authority.enqueue(
      async () => this.challengeBy('issue_mutation_id', mutationId),
      () => new LocalOwnerBootstrapUnavailableError(),
    );
  }

  private validateDeliveryAcknowledgementFactDirect(
    acknowledgement: Readonly<LocalOwnerSecretDeliveryAcknowledgementRecord>,
    conflict: boolean,
  ): void {
    let matches = false;
    if (acknowledgement.kind === 'credential') {
      const provisioning = this.resolveProvisioningDirect(
        acknowledgement.mutationId,
      );
      matches =
        !!provisioning &&
        provisioning.requestId === acknowledgement.requestId &&
        provisioning.identity.subject.id === acknowledgement.subjectId &&
        provisioning.credential.credentialId === acknowledgement.credentialId &&
        provisioning.credential.secretDigest === acknowledgement.factDigest &&
        provisioning.credential.expiresAtMs -
          provisioning.credential.notBeforeAtMs ===
          acknowledgement.ttlMs;
    } else {
      const challenge = this.challengeBy(
        'issue_mutation_id',
        acknowledgement.mutationId,
      );
      matches =
        !!challenge &&
        challenge.projectId === acknowledgement.projectId &&
        challenge.issueRequestId === acknowledgement.requestId &&
        challenge.challengeId === acknowledgement.challengeId &&
        challenge.tokenDigest === acknowledgement.factDigest &&
        challenge.expiresAtMs - challenge.issuedAtMs === acknowledgement.ttlMs;
    }
    if (!matches) {
      throw conflict
        ? new LocalOwnerBootstrapMutationConflictError()
        : new LocalOwnerBootstrapUnavailableError();
    }
  }

  private resolveDeliveryAcknowledgementDirect(
    mutationId: string,
  ): Readonly<LocalOwnerSecretDeliveryAcknowledgementRecord> | null {
    const liveRow = single(
      this.authority.client
        .prepare(
          `SELECT * FROM "QingLong3LocalOwnerDeliveryAcknowledgements"
           WHERE "mutation_id" = ? LIMIT 2`,
        )
        .all(mutationId) as QueryRow[],
    );
    const compactedRow = single(
      this.authority.client
        .prepare(
          `SELECT * FROM "QingLong3LocalOwnerDeliveryAcknowledgementGc"
           WHERE "acknowledgement_mutation_id" = ? LIMIT 2`,
        )
        .all(mutationId) as QueryRow[],
    );
    if (liveRow && compactedRow) {
      throw new LocalOwnerBootstrapUnavailableError();
    }
    if (!liveRow && !compactedRow) return null;
    if (liveRow) {
      const acknowledgement = deliveryAcknowledgementFromRow(liveRow);
      this.validateDeliveryAcknowledgementFactDirect(acknowledgement, false);
      return acknowledgement;
    }
    const kind = requiredString(compactedRow!, 'acknowledgement_kind');
    const deliveryDigest = requiredString(compactedRow!, 'delivery_digest');
    const acknowledgedAtMs = requiredInteger(
      compactedRow!,
      'acknowledged_at_ms',
    );
    let acknowledgement: Readonly<LocalOwnerSecretDeliveryAcknowledgementRecord>;
    try {
      if (kind === 'credential') {
        const provisioning = this.resolveProvisioningDirect(mutationId);
        if (!provisioning) throw new LocalOwnerBootstrapUnavailableError();
        acknowledgement =
          normalizeLocalOwnerSecretDeliveryAcknowledgementRecord({
            kind,
            mutationId: provisioning.mutationId,
            requestId: provisioning.requestId,
            subjectId: provisioning.identity.subject.id,
            credentialId: provisioning.credential.credentialId,
            factDigest: provisioning.credential.secretDigest,
            deliveryDigest,
            ttlMs:
              provisioning.credential.expiresAtMs -
              provisioning.credential.notBeforeAtMs,
            acknowledgedAtMs,
          });
      } else if (kind === 'challenge') {
        const challenge = this.challengeBy('issue_mutation_id', mutationId);
        if (!challenge) throw new LocalOwnerBootstrapUnavailableError();
        acknowledgement =
          normalizeLocalOwnerSecretDeliveryAcknowledgementRecord({
            kind,
            mutationId: challenge.issueMutationId,
            requestId: challenge.issueRequestId,
            projectId: challenge.projectId,
            challengeId: challenge.challengeId,
            factDigest: challenge.tokenDigest,
            deliveryDigest,
            ttlMs: challenge.expiresAtMs - challenge.issuedAtMs,
            acknowledgedAtMs,
          });
      } else {
        throw new LocalOwnerBootstrapUnavailableError();
      }
    } catch (error) {
      if (error instanceof LocalOwnerBootstrapUnavailableError) throw error;
      throw new LocalOwnerBootstrapUnavailableError();
    }
    if (
      localOwnerSecretDeliveryAcknowledgementSemanticDigest(acknowledgement) !==
      requiredString(compactedRow!, 'acknowledgement_semantic_digest')
    ) {
      throw new LocalOwnerBootstrapUnavailableError();
    }
    this.validateDeliveryAcknowledgementFactDirect(acknowledgement, false);
    return acknowledgement;
  }

  resolveDeliveryAcknowledgement(
    mutationId: string,
  ): Promise<Readonly<LocalOwnerSecretDeliveryAcknowledgementRecord> | null> {
    try {
      assertLocalOwnerBootstrapMutationId(mutationId);
    } catch (error) {
      return Promise.reject(
        error instanceof InvalidLocalOwnerBootstrapValueError
          ? error
          : new InvalidLocalOwnerBootstrapValueError('mutationId is invalid'),
      );
    }
    return this.authority.enqueue(
      async () => this.resolveDeliveryAcknowledgementDirect(mutationId),
      () => new LocalOwnerBootstrapUnavailableError(),
    );
  }

  recordDeliveryAcknowledgement(
    rawAcknowledgement: LocalOwnerSecretDeliveryAcknowledgementRecord,
  ): Promise<RecordLocalOwnerSecretDeliveryAcknowledgementResult> {
    const acknowledgement =
      normalizeLocalOwnerSecretDeliveryAcknowledgementRecord(
        rawAcknowledgement,
      );
    return this.authority.enqueue(
      async () => {
        let began = false;
        try {
          this.authority.client.exec('BEGIN IMMEDIATE');
          began = true;
          const existing = this.resolveDeliveryAcknowledgementDirect(
            acknowledgement.mutationId,
          );
          if (existing) {
            if (
              !sameDeliveryAcknowledgementSemantic(existing, acknowledgement)
            ) {
              throw new LocalOwnerBootstrapMutationConflictError();
            }
            this.authority.client.exec('COMMIT');
            began = false;
            return Object.freeze({
              status: 'existing' as const,
              acknowledgement: existing,
            });
          }
          this.validateDeliveryAcknowledgementFactDirect(acknowledgement, true);
          this.authority.client
            .prepare(
              `INSERT INTO "QingLong3LocalOwnerDeliveryAcknowledgements" (
                 "mutation_id", "kind", "request_id", "project_id",
                 "subject_id", "credential_id", "challenge_id",
                 "fact_digest", "delivery_digest", "ttl_ms",
                 "acknowledged_at_ms", "provisioning_mutation_id",
                 "challenge_mutation_id"
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              acknowledgement.mutationId,
              acknowledgement.kind,
              acknowledgement.requestId,
              acknowledgement.kind === 'challenge'
                ? acknowledgement.projectId
                : null,
              acknowledgement.kind === 'credential'
                ? acknowledgement.subjectId
                : null,
              acknowledgement.kind === 'credential'
                ? acknowledgement.credentialId
                : null,
              acknowledgement.kind === 'challenge'
                ? acknowledgement.challengeId
                : null,
              acknowledgement.factDigest,
              acknowledgement.deliveryDigest,
              acknowledgement.ttlMs,
              acknowledgement.acknowledgedAtMs,
              acknowledgement.kind === 'credential'
                ? acknowledgement.mutationId
                : null,
              acknowledgement.kind === 'challenge'
                ? acknowledgement.mutationId
                : null,
            );
          const stored = this.resolveDeliveryAcknowledgementDirect(
            acknowledgement.mutationId,
          );
          if (
            !stored ||
            !sameDeliveryAcknowledgementSemantic(stored, acknowledgement)
          ) {
            throw new LocalOwnerBootstrapUnavailableError();
          }
          this.authority.client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'inserted' as const,
            acknowledgement: stored,
          });
        } catch (error) {
          rollback(this.authority.client, began);
          if (isDomainError(error)) throw error;
          throw new LocalOwnerBootstrapUnavailableError();
        }
      },
      () => new LocalOwnerBootstrapUnavailableError(),
    );
  }

  issue(
    rawCommand: IssueLocalOwnerBootstrapChallengeCommand,
  ): Promise<IssueLocalOwnerBootstrapChallengeResult> {
    const command =
      normalizeIssueLocalOwnerBootstrapChallengeCommand(rawCommand);
    return this.authority.enqueue(
      async () => {
        let began = false;
        try {
          this.authority.client.exec('BEGIN IMMEDIATE');
          began = true;
          const replay = this.challengeBy(
            'issue_mutation_id',
            command.mutationId,
          );
          if (replay) {
            if (
              replay.projectId !== command.projectId ||
              replay.issueRequestId !== command.requestId ||
              !samePrincipal(replay.issuer, command.issuer) ||
              replay.expiresAtMs - replay.issuedAtMs !==
                command.expiresAtMs - command.issuedAtMs ||
              !sameAuditSemantic(replay.issueAudit, command.audit)
            ) {
              throw new LocalOwnerBootstrapMutationConflictError();
            }
            this.authority.client.exec('COMMIT');
            began = false;
            return Object.freeze({
              status: 'existing' as const,
              challenge: replay,
            });
          }
          if (
            !this.authority.client
              .prepare(
                `SELECT 1 FROM "QingLong3LocalIdentityProvisionings" WHERE "slot" = 1`,
              )
              .get()
          ) {
            throw new LocalOwnerBootstrapIdentityRequiredError();
          }
          const project = this.authority.client
            .prepare(
              `SELECT "version", "status" FROM "QingLong3Projects" WHERE "id" = ?`,
            )
            .get(command.projectId) as QueryRow | undefined;
          if (!project || requiredString(project, 'status') !== 'active') {
            throw new LocalOwnerBootstrapNotPristineError();
          }
          if (
            this.authority.client
              .prepare(
                `SELECT 1 FROM "QingLong3ProjectRoleBindings" WHERE "project_id" = ? LIMIT 1`,
              )
              .get(command.projectId)
          ) {
            throw new LocalOwnerBootstrapNotPristineError();
          }
          const latest = this.authority.client
            .prepare(
              `SELECT "version", "expires_at_ms", "consumed_at_ms"
               FROM "QingLong3LocalOwnerBootstrapChallenges"
               WHERE "project_id" = ? ORDER BY "version" DESC LIMIT 1`,
            )
            .get(command.projectId) as QueryRow | undefined;
          if (latest) {
            if (optionalInteger(latest, 'consumed_at_ms') !== undefined) {
              throw new LocalOwnerBootstrapNotPristineError();
            }
            if (requiredInteger(latest, 'expires_at_ms') > command.issuedAtMs) {
              throw new LocalOwnerBootstrapChallengeActiveError();
            }
          }
          const version = latest ? requiredInteger(latest, 'version') + 1 : 1;
          if (version > 2_147_483_647) {
            throw new LocalOwnerBootstrapUnavailableError();
          }
          if (
            this.authority.client
              .prepare(
                `SELECT 1 FROM "QingLong3SecurityAuditEvents" WHERE "event_id" = ?`,
              )
              .get(command.audit.eventId)
          ) {
            throw new LocalOwnerBootstrapMutationConflictError();
          }
          insertAudit(this.authority.client, command.audit);
          this.authority.client
            .prepare(
              `INSERT INTO "QingLong3LocalOwnerBootstrapChallenges" (
                 "project_id", "version", "issue_mutation_id",
                 "issue_request_id", "challenge_id", "token_digest",
                 "issuer_authentication_id", "issuer_authenticated_at_ms",
                 "issuer_expires_at_ms", "issued_at_ms", "expires_at_ms",
                 "issue_audit_event_id"
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              command.projectId,
              version,
              command.mutationId,
              command.requestId,
              command.challengeId,
              command.tokenDigest,
              command.issuer.authenticationId,
              command.issuer.authenticatedAtMs,
              command.issuer.expiresAtMs,
              command.issuedAtMs,
              command.expiresAtMs,
              command.audit.eventId,
            );
          const inserted = this.challengeBy(
            'issue_mutation_id',
            command.mutationId,
          );
          if (!inserted) throw new LocalOwnerBootstrapUnavailableError();
          this.authority.client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'inserted' as const,
            challenge: inserted,
          });
        } catch (error) {
          rollback(this.authority.client, began);
          if (isDomainError(error)) throw error;
          throw new LocalOwnerBootstrapUnavailableError();
        }
      },
      () => new LocalOwnerBootstrapUnavailableError(),
    );
  }

  claim(rawCommand: ClaimLocalOwnerCommand): Promise<ClaimLocalOwnerResult> {
    const command = normalizeClaimLocalOwnerCommand(rawCommand);
    return this.authority.enqueue(
      async () => {
        let began = false;
        try {
          this.authority.client.exec('BEGIN IMMEDIATE');
          began = true;
          const replay = this.challengeBy(
            'claim_mutation_id',
            command.mutationId,
          );
          if (replay) {
            if (
              replay.projectId !== command.projectId ||
              replay.claimRequestId !== command.requestId ||
              replay.challengeId !== command.challengeId ||
              replay.claimedPrincipal?.subject.type !==
                command.principal.subject.type ||
              replay.claimedPrincipal.subject.id !==
                command.principal.subject.id ||
              replay.claimedPrincipal.authenticationId !==
                command.principal.authenticationId ||
              replay.credentialId !== command.credentialId ||
              replay.credentialVersion !== command.credentialVersion ||
              !sameAuditSemantic(replay.claimAudit!, command.audit)
            ) {
              throw new LocalOwnerBootstrapMutationConflictError();
            }
            this.authority.client.exec('COMMIT');
            began = false;
            return Object.freeze({
              status: 'existing' as const,
              challenge: replay,
              binding: replay.binding!,
            });
          }
          if (
            this.authority.client
              .prepare(
                `SELECT 1 FROM "QingLong3SecurityAuditEvents" WHERE "event_id" = ?`,
              )
              .get(command.audit.eventId)
          ) {
            throw new LocalOwnerBootstrapMutationConflictError();
          }
          const project = this.authority.client
            .prepare(
              `SELECT "version", "status" FROM "QingLong3Projects" WHERE "id" = ?`,
            )
            .get(command.projectId) as QueryRow | undefined;
          if (!project || requiredString(project, 'status') !== 'active') {
            throw new LocalOwnerBootstrapClaimRejectedError();
          }
          const projectVersion = requiredInteger(project, 'version');
          if (command.audit.fence?.projectVersion !== projectVersion) {
            throw new LocalOwnerBootstrapMutationConflictError();
          }
          if (
            this.authority.client
              .prepare(
                `SELECT 1 FROM "QingLong3ProjectRoleBindings" WHERE "project_id" = ? LIMIT 1`,
              )
              .get(command.projectId)
          ) {
            throw new LocalOwnerBootstrapNotPristineError();
          }
          const latest = this.authority.client
            .prepare(
              `SELECT "version", "challenge_id", "token_digest",
                      "issued_at_ms", "expires_at_ms", "consumed_at_ms"
               FROM "QingLong3LocalOwnerBootstrapChallenges"
               WHERE "project_id" = ? ORDER BY "version" DESC LIMIT 1`,
            )
            .get(command.projectId) as QueryRow | undefined;
          if (
            !latest ||
            requiredString(latest, 'challenge_id') !== command.challengeId ||
            optionalInteger(latest, 'consumed_at_ms') !== undefined ||
            command.claimedAtMs < requiredInteger(latest, 'issued_at_ms') ||
            command.claimedAtMs >= requiredInteger(latest, 'expires_at_ms') ||
            !localOwnerBootstrapDigestMatches(
              requiredString(latest, 'token_digest'),
              command.tokenDigest,
            )
          ) {
            throw new LocalOwnerBootstrapClaimRejectedError();
          }
          const credential = this.authority.client
            .prepare(
              `SELECT credential."version", credential."state",
                      credential."subject_type", credential."subject_id",
                      credential."not_before_at_ms", credential."expires_at_ms",
                      identity."status" AS "identity_status"
               FROM "QingLong3ApiCredentials" AS credential
               JOIN "QingLong3IdentitySubjects" AS identity
                 ON identity."subject_type" = credential."subject_type"
                AND identity."subject_id" = credential."subject_id"
               WHERE credential."credential_id" = ?
               ORDER BY credential."version" DESC LIMIT 1`,
            )
            .get(command.credentialId) as QueryRow | undefined;
          if (
            !credential ||
            requiredInteger(credential, 'version') !==
              command.credentialVersion ||
            requiredString(credential, 'state') !== 'active' ||
            requiredString(credential, 'identity_status') !== 'active' ||
            requiredString(credential, 'subject_type') !==
              command.principal.subject.type ||
            requiredString(credential, 'subject_id') !==
              command.principal.subject.id ||
            requiredInteger(credential, 'not_before_at_ms') >
              command.claimedAtMs ||
            requiredInteger(credential, 'expires_at_ms') <= command.claimedAtMs
          ) {
            throw new LocalOwnerBootstrapClaimRejectedError();
          }
          const binding = normalizeProjectRoleBinding({
            projectId: command.projectId,
            subject: command.principal.subject,
            version: 1,
            state: 'active',
            role: 'owner',
            mutationId: command.mutationId,
            changedBy: LOCAL_OWNER_BOOTSTRAP_SYSTEM_SUBJECT,
            createdAtMs: command.claimedAtMs,
          });
          this.authority.client
            .prepare(
              `INSERT INTO "QingLong3ProjectRoleBindings" (
                 "project_id", "subject_type", "subject_id", "version",
                 "state", "role", "mutation_id", "changed_by_type",
                 "changed_by_id", "created_at_ms"
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              binding.projectId,
              binding.subject.type,
              binding.subject.id,
              binding.version,
              binding.state,
              binding.role ?? 'owner',
              binding.mutationId,
              binding.changedBy.type,
              binding.changedBy.id,
              binding.createdAtMs,
            );
          insertAudit(this.authority.client, command.audit);
          const update = this.authority.client
            .prepare(
              `UPDATE "QingLong3LocalOwnerBootstrapChallenges"
               SET "consumed_at_ms" = ?, "claim_mutation_id" = ?,
                   "claim_request_id" = ?, "claimed_subject_type" = ?,
                   "claimed_subject_id" = ?, "credential_id" = ?,
                   "credential_version" = ?, "claim_authentication_id" = ?,
                   "claim_authenticated_at_ms" = ?, "claim_expires_at_ms" = ?,
                   "claim_assurance" = ?, "claim_audit_event_id" = ?
               WHERE "project_id" = ? AND "version" = ?
                 AND "challenge_id" = ? AND "consumed_at_ms" IS NULL`,
            )
            .run(
              command.claimedAtMs,
              command.mutationId,
              command.requestId,
              command.principal.subject.type,
              command.principal.subject.id,
              command.credentialId,
              command.credentialVersion,
              command.principal.authenticationId,
              command.principal.authenticatedAtMs,
              command.principal.expiresAtMs,
              command.principal.assurance,
              command.audit.eventId,
              command.projectId,
              requiredInteger(latest, 'version'),
              command.challengeId,
            );
          if (update.changes !== 1)
            throw new LocalOwnerBootstrapUnavailableError();
          const inserted = this.challengeBy(
            'claim_mutation_id',
            command.mutationId,
          );
          if (!inserted?.binding)
            throw new LocalOwnerBootstrapUnavailableError();
          this.authority.client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'inserted' as const,
            challenge: inserted,
            binding: inserted.binding,
          });
        } catch (error) {
          rollback(this.authority.client, began);
          if (isDomainError(error)) throw error;
          throw new LocalOwnerBootstrapUnavailableError();
        }
      },
      () => new LocalOwnerBootstrapUnavailableError(),
    );
  }

  recordAudit(value: SecurityAuditRecord): Promise<void> {
    const audit = normalizeSecurityAuditRecord(value);
    return this.authority.enqueue(
      async () => {
        try {
          insertAudit(this.authority.client, audit);
        } catch {
          try {
            const row = single(
              this.authority.client
                .prepare(
                  `SELECT ${auditSelect('audit', 'audit_')}
                   FROM "QingLong3SecurityAuditEvents" AS audit
                   WHERE audit."event_id" = ? LIMIT 2`,
                )
                .all(audit.eventId) as QueryRow[],
            );
            if (row && sameAuditSemantic(auditFromRow(row, 'audit_'), audit)) {
              return;
            }
          } catch {
            // Collapse storage and corruption failures.
          }
          throw new SecurityAuditUnavailableError();
        }
      },
      () => new SecurityAuditUnavailableError(),
    );
  }
}
