import {
  type AuthenticatedLocalCommand,
  AuthenticatedLocalCommandAuthenticationError,
  InvalidPluginPackageWorkflowExecutionPlanError,
  LocalPluginPackageWorkflowAdministrationAuthenticationError,
  LocalPluginPackageWorkflowAdministrationAuthorizationError,
  LocalPluginPackageWorkflowAdministrationConfigurationError,
  LocalPluginPackageWorkflowAdministrationNotFoundError,
  LocalPluginPackageWorkflowAdministrationUnavailableError,
  type LocalSqliteAuthenticatedUserCredentialFence,
  LocalSqliteAuthenticatedManagementFenceError,
  type LocalSqlitePluginPackageWorkflowAdministrationDatabase,
  PluginPackageWorkflowAdministrationAuthorizationFenceConflictError,
  PluginPackageWorkflowAdministrationMutationConflictError,
  PluginPackageWorkflowAdmissionConflictError,
  PluginPackageWorkflowAdmissionNotAllowedError,
  type SecurityAuditRecord,
} from './supportAuthority';
import {
  type LocalPluginPackageWorkflowCommand,
  LocalPluginPackageWorkflowCommandConfigurationError,
  type LocalPluginPackageWorkflowCommandRunnerDependencies,
} from './contracts';

export function failureAudit(
  command: Readonly<LocalPluginPackageWorkflowCommand>,
  authenticated: Readonly<AuthenticatedLocalCommand> | undefined,
  error: unknown,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> | null {
  if (
    error instanceof
      LocalPluginPackageWorkflowAdministrationAuthenticationError ||
    error instanceof
      LocalPluginPackageWorkflowAdministrationAuthorizationError ||
    error instanceof LocalPluginPackageWorkflowAdministrationUnavailableError
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
    error instanceof
      PluginPackageWorkflowAdministrationAuthorizationFenceConflictError
  ) {
    outcome = 'denied';
    reason = 'credential_or_policy_fence_rejected';
  } else if (
    error instanceof PluginPackageWorkflowAdministrationMutationConflictError ||
    error instanceof PluginPackageWorkflowAdmissionConflictError
  ) {
    outcome = 'denied';
    reason = 'workflow_admission_conflict';
  } else if (
    error instanceof LocalPluginPackageWorkflowAdministrationNotFoundError ||
    error instanceof
      LocalPluginPackageWorkflowAdministrationConfigurationError ||
    error instanceof LocalPluginPackageWorkflowCommandConfigurationError ||
    error instanceof InvalidPluginPackageWorkflowExecutionPlanError ||
    error instanceof PluginPackageWorkflowAdmissionNotAllowedError
  ) {
    outcome = 'denied';
    reason = 'workflow_admission_rejected';
  } else {
    return null;
  }
  return Object.freeze({
    eventId: command.request.failureAuditEventId,
    requestId: command.request.requestId,
    operationId:
      command.operation === 'workflow.start'
        ? 'workflow.start'
        : command.operation === 'workflow.cancel'
        ? 'workflow.cancel'
        : command.operation === 'workflow.step.list'
        ? 'workflow.step.list'
        : command.operation === 'workflow.event.list'
        ? 'workflow.event.list'
        : command.operation === 'workflow.run.list'
        ? 'workflow.run.list'
        : command.operation === 'workflow.run.inspect'
        ? 'workflow.run.read'
        : 'workflow.read',
    projectId: command.request.projectId,
    subject: authenticated?.principal.subject ?? null,
    authenticationId: authenticated?.principal.authenticationId ?? null,
    outcome,
    reasons: Object.freeze([reason]),
    fence: null,
    occurredAtMs,
  });
}

export function dependencies(
  value: LocalPluginPackageWorkflowCommandRunnerDependencies,
): Readonly<LocalPluginPackageWorkflowCommandRunnerDependencies> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      ['authenticate', 'createService', 'now', 'openDatabase']
        .sort()
        .join('\0') ||
    typeof value.openDatabase !== 'function' ||
    typeof value.authenticate !== 'function' ||
    typeof value.createService !== 'function' ||
    typeof value.now !== 'function'
  ) {
    throw new LocalPluginPackageWorkflowCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

export async function activateFence(
  database: LocalSqlitePluginPackageWorkflowAdministrationDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
): Promise<void> {
  await authenticated.confirm();
  database.activateUserCredentialFence(
    authenticated.databaseFence as Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  );
}
