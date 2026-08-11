import path from 'node:path';
import {
  ApiCredentialAdministrationMutationConflictError,
  ApiCredentialAdministrationSubjectNotFoundError,
  ApiCredentialAdministrationVersionConflictError,
  AuthenticatedLocalCommandAuthenticationError,
  IdentityAdministrationMutationConflictError,
  IdentityAdministrationVersionConflictError,
  LocalCredentialDeliveryMutationConflictError,
  LocalCredentialOwnerContinuityError,
  LocalIdentityCredentialAdministrationAuthenticationError,
  LocalIdentityCredentialAdministrationAuthorizationError,
  LocalIdentityCredentialAdministrationServiceUnavailableError,
  LocalIdentityCredentialAdministrationUnavailableError,
  LocalIdentityCredentialAuthorizationFenceConflictError,
  LocalIdentityOwnerBindingConflictError,
  LocalSqliteAuthenticatedManagementFenceError,
  type AuthenticatedLocalCommand,
  type LocalCredentialAdministrationDeliverySummary,
  type LocalIdentityCredentialAdministrationService,
  type LocalSqliteAuthenticatedUserCredentialFence,
  type LocalSqliteIdentityCredentialAdministrationDatabase,
  type SecurityAuditRecord,
  type SecuritySubject,
} from './executionAuthority';
import {
  LocalIdentityCredentialCommandConfigurationError,
  LocalIdentityCredentialCommandCurrentCredentialError,
  type LocalApiCredentialIssueCommand,
  type LocalIdentityCredentialCommand,
  type LocalIdentityCredentialCommandResult,
  type LocalIdentityCredentialCommandRunnerDependencies,
} from './contracts';

export function dependencies(
  value: LocalIdentityCredentialCommandRunnerDependencies,
): Readonly<LocalIdentityCredentialCommandRunnerDependencies> {
  const expected = [
    'openDatabase',
    'authenticate',
    'createService',
    'createDelivery',
    'createPepperProvider',
    'randomBytes',
    'now',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== expected.sort().join('\0') ||
    expected.some(
      (key) =>
        typeof value[
          key as keyof LocalIdentityCredentialCommandRunnerDependencies
        ] !== 'function',
    )
  ) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

export function clock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalIdentityCredentialCommandConfigurationError(
      'clock is invalid',
    );
  }
  return value;
}

export function failureAudit(
  command: Readonly<LocalIdentityCredentialCommand>,
  authenticated: Readonly<AuthenticatedLocalCommand> | undefined,
  error: unknown,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> | null {
  if (
    error instanceof LocalIdentityCredentialAdministrationAuthenticationError ||
    error instanceof LocalIdentityCredentialAdministrationAuthorizationError ||
    error instanceof
      LocalIdentityCredentialAdministrationServiceUnavailableError
  ) {
    return null;
  }
  let outcome: SecurityAuditRecord['outcome'];
  let reason: string;
  if (
    !authenticated ||
    error instanceof AuthenticatedLocalCommandAuthenticationError
  ) {
    outcome = 'authentication_rejected';
    reason = 'credential_rejected';
  } else if (
    error instanceof LocalSqliteAuthenticatedManagementFenceError ||
    error instanceof LocalIdentityCredentialAuthorizationFenceConflictError
  ) {
    outcome = 'denied';
    reason = 'credential_or_policy_fence_rejected';
  } else if (
    error instanceof LocalIdentityOwnerBindingConflictError ||
    error instanceof LocalCredentialOwnerContinuityError
  ) {
    outcome = 'denied';
    reason = 'owner_continuity_required';
  } else if (
    error instanceof IdentityAdministrationVersionConflictError ||
    error instanceof ApiCredentialAdministrationVersionConflictError ||
    error instanceof ApiCredentialAdministrationSubjectNotFoundError ||
    error instanceof LocalIdentityCredentialCommandCurrentCredentialError
  ) {
    outcome = 'denied';
    reason = 'current_version_or_subject_conflict';
  } else if (
    error instanceof IdentityAdministrationMutationConflictError ||
    error instanceof ApiCredentialAdministrationMutationConflictError ||
    error instanceof LocalCredentialDeliveryMutationConflictError
  ) {
    outcome = 'denied';
    reason = 'mutation_conflict';
  } else {
    return null;
  }
  return Object.freeze({
    eventId:
      'failureAuditEventId' in command.request
        ? command.request.failureAuditEventId
        : command.request.auditEventId,
    requestId: command.request.requestId,
    operationId: command.operation,
    projectId: command.request.projectId,
    subject: authenticated?.principal.subject ?? null,
    authenticationId: authenticated?.principal.authenticationId ?? null,
    outcome,
    reasons: Object.freeze([reason]),
    fence: null,
    occurredAtMs,
  });
}

export async function activateFence(
  database: LocalSqliteIdentityCredentialAdministrationDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
): Promise<void> {
  await authenticated.confirm();
  database.activateUserCredentialFence(
    authenticated.databaseFence as Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  );
}

export function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

export function activeCredentialResult(
  command: Readonly<LocalApiCredentialIssueCommand>,
  result: Awaited<
    ReturnType<LocalIdentityCredentialAdministrationService['changeCredential']>
  >,
  delivery: Readonly<LocalCredentialAdministrationDeliverySummary>,
): Readonly<LocalIdentityCredentialCommandResult> {
  if (
    result.credential.credentialId !== command.request.credentialId ||
    result.credential.version !== command.request.expectedCurrentVersion + 1 ||
    !sameSubject(result.credential.subject, command.request.target) ||
    result.credential.state !== 'active' ||
    result.delivery?.digest !== delivery.deliveryDigest ||
    delivery.mutationId !== command.request.mutationId ||
    delivery.credentialId !== command.request.credentialId ||
    delivery.projectId !== command.request.projectId ||
    !sameSubject(delivery.subject, command.request.target) ||
    path.dirname(delivery.path) !== command.options.credentialDeliveryDirectory
  ) {
    throw new LocalIdentityCredentialAdministrationUnavailableError();
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status: result.status,
    projectId: command.request.projectId,
    target: result.credential.subject,
    credentialId: result.credential.credentialId,
    version: result.credential.version,
    state: result.credential.state,
    expiresAtMs: result.credential.expiresAtMs,
    delivery: Object.freeze({
      fileName: path.basename(delivery.path),
      digest: delivery.deliveryDigest,
    }),
  });
}
