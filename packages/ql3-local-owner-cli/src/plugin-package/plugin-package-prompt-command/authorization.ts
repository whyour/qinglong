import {
  type LocalSqliteOptionalFeatureRuntimeDatabase,
  type ProjectPermission,
  ProjectPolicyEngine,
  ProjectPolicyUnavailableError,
  type SecurityAuditRecord,
  type SecurityPolicyDecision,
  type SecurityPrincipal,
  normalizeSecurityAuditRecord,
  normalizeSecurityPrincipal,
} from './authorizationAuthority';
import {
  LocalPluginPackagePromptAuthenticationError,
  LocalPluginPackagePromptAuthorizationError,
  type LocalPluginPackagePromptCommand,
  LocalPluginPackagePromptUnavailableError,
} from './contracts';

const STRONG_USER_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);
export const PROMPT_PERMISSIONS = Object.freeze([
  'run.start',
  'model.invoke',
  'secret.use',
] as const satisfies readonly ProjectPermission[]);

function strongUser(
  value: Readonly<SecurityPrincipal>,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  try {
    const principal = normalizeSecurityPrincipal(value, nowMs);
    if (
      principal.subject.type !== 'user' ||
      !STRONG_USER_ASSURANCES.has(principal.assurance)
    ) {
      throw new LocalPluginPackagePromptAuthenticationError();
    }
    return principal;
  } catch (error) {
    if (error instanceof LocalPluginPackagePromptAuthenticationError) {
      throw error;
    }
    throw new LocalPluginPackagePromptAuthenticationError();
  }
}

export function sameFence(
  left: NonNullable<SecurityPolicyDecision['fence']>,
  right: NonNullable<SecurityPolicyDecision['fence']>,
): boolean {
  return (
    left.projectVersion === right.projectVersion &&
    left.bindingVersion === right.bindingVersion
  );
}

export async function authorize(
  database: LocalSqliteOptionalFeatureRuntimeDatabase,
  principalValue: Readonly<SecurityPrincipal>,
  projectId: string,
  nowMs: number,
  permissions: readonly ProjectPermission[] = PROMPT_PERMISSIONS,
): Promise<
  Readonly<{
    principal: Readonly<SecurityPrincipal>;
    decision: Readonly<SecurityPolicyDecision> & {
      readonly fence: NonNullable<SecurityPolicyDecision['fence']>;
    };
  }>
> {
  const principal = strongUser(principalValue, nowMs);
  const policy = new ProjectPolicyEngine(database.projectPolicy);
  let selected: Readonly<SecurityPolicyDecision> | undefined;
  try {
    for (const permission of permissions) {
      const decision = await policy.authorize(principal, projectId, permission);
      if (
        decision.effect !== 'allow' ||
        !decision.fence ||
        decision.fence.bindingVersion === null
      ) {
        throw new LocalPluginPackagePromptAuthorizationError();
      }
      if (selected?.fence && !sameFence(selected.fence, decision.fence)) {
        throw new LocalPluginPackagePromptUnavailableError();
      }
      selected = decision;
    }
  } catch (error) {
    if (
      error instanceof LocalPluginPackagePromptAuthorizationError ||
      error instanceof LocalPluginPackagePromptUnavailableError
    ) {
      throw error;
    }
    if (error instanceof ProjectPolicyUnavailableError) {
      throw new LocalPluginPackagePromptUnavailableError({ cause: error });
    }
    throw new LocalPluginPackagePromptUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (!selected?.fence || selected.fence.bindingVersion === null) {
    throw new LocalPluginPackagePromptUnavailableError();
  }
  return Object.freeze({
    principal,
    decision: Object.freeze({
      ...selected,
      fence: Object.freeze({
        projectVersion: selected.fence.projectVersion,
        bindingVersion: selected.fence.bindingVersion,
      }),
    }),
  });
}

export function allowedAudit(
  command: Readonly<LocalPluginPackagePromptCommand>,
  principal: Readonly<SecurityPrincipal>,
  decision: Readonly<SecurityPolicyDecision> & {
    readonly fence: NonNullable<SecurityPolicyDecision['fence']>;
  },
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> {
  return normalizeSecurityAuditRecord({
    eventId: command.request.auditEventId,
    requestId: command.request.requestId,
    operationId:
      command.operation === 'prompt.execution.inspect'
        ? 'prompt.execution.read'
        : command.operation === 'prompt.execution.output.read'
        ? 'prompt.execution.output.read'
        : command.operation,
    projectId: command.request.projectId,
    subject: principal.subject,
    authenticationId: principal.authenticationId,
    outcome: 'allowed',
    reasons: decision.reasons,
    fence: decision.fence,
    occurredAtMs,
  });
}
