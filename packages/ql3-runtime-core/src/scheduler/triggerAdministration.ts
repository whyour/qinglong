import {
  assertTriggerIdentifier,
  assertTriggerPageSize,
  normalizeAppendTriggerRevisionCommand,
  normalizeTriggerCursor,
  type AppendTriggerRevisionCommand,
  type TriggerCursor,
  type TriggerPage,
  type TriggerRecord,
} from './trigger';
import { normalizeProjectPolicySubject } from '../security/project-policy/projectPolicy';
import type { SecurityPolicyFence, SecuritySubject } from '../security/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '../security/audit/securityAudit';

export interface AuthorizedTriggerRevisionMutation {
  readonly command: AppendTriggerRevisionCommand;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface TriggerAdministrationRepository {
  appendAuthorizedTriggerRevision(
    mutation: AuthorizedTriggerRevisionMutation,
  ): Promise<
    Readonly<{
      status: 'created' | 'updated' | 'existing';
      trigger: TriggerRecord;
    }>
  >;
}

export interface AuthorizedTriggerInspection {
  readonly projectId: string;
  readonly triggerId: string;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface AuthorizedTriggerList {
  readonly projectId: string;
  readonly limit: number;
  readonly after?: TriggerCursor;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface TriggerAdministrationSource {
  findAuthorizedCurrentTrigger(
    inspection: AuthorizedTriggerInspection,
  ): Promise<TriggerRecord | null>;
  listAuthorizedTriggers(query: AuthorizedTriggerList): Promise<TriggerPage>;
}

export class InvalidTriggerAdministrationMutationError extends TypeError {
  readonly code = 'TRIGGER_ADMINISTRATION_MUTATION_INVALID';

  constructor(message: string) {
    super(`Trigger administration mutation is invalid: ${message}`);
    this.name = 'InvalidTriggerAdministrationMutationError';
  }
}

export class TriggerAdministrationAuthorizationFenceConflictError extends Error {
  readonly code = 'TRIGGER_ADMINISTRATION_AUTHORIZATION_FENCE_CONFLICT';

  constructor() {
    super('Trigger administration authorization fence changed');
    this.name = 'TriggerAdministrationAuthorizationFenceConflictError';
  }
}

export class TriggerAdministrationMutationConflictError extends Error {
  readonly code = 'TRIGGER_ADMINISTRATION_MUTATION_CONFLICT';

  constructor() {
    super('Trigger administration mutation conflicts with durable state');
    this.name = 'TriggerAdministrationMutationConflictError';
  }
}

export class InvalidTriggerAdministrationReadError extends TypeError {
  readonly code = 'TRIGGER_ADMINISTRATION_READ_INVALID';

  constructor(message: string) {
    super(`Trigger administration read is invalid: ${message}`);
    this.name = 'InvalidTriggerAdministrationReadError';
  }
}

export class TriggerAdministrationReadConflictError extends Error {
  readonly code = 'TRIGGER_ADMINISTRATION_READ_CONFLICT';

  constructor() {
    super('Trigger administration read conflicts with durable state');
    this.name = 'TriggerAdministrationReadConflictError';
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function normalizeFence(value: SecurityPolicyFence): SecurityPolicyFence {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['bindingVersion', 'projectVersion']) ||
    !Number.isSafeInteger(value.projectVersion) ||
    value.projectVersion < 1 ||
    !Number.isSafeInteger(value.bindingVersion) ||
    (value.bindingVersion as number) < 1
  ) {
    throw new InvalidTriggerAdministrationMutationError(
      'authorization fence is invalid',
    );
  }
  return Object.freeze({
    projectVersion: value.projectVersion,
    bindingVersion: value.bindingVersion,
  });
}

export function normalizeAuthorizedTriggerRevisionMutation(
  value: AuthorizedTriggerRevisionMutation,
): Readonly<AuthorizedTriggerRevisionMutation> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['actor', 'audit', 'command', 'fence'])
  ) {
    throw new InvalidTriggerAdministrationMutationError(
      'mutation shape is invalid',
    );
  }
  try {
    const command = normalizeAppendTriggerRevisionCommand(value.command);
    const actor = normalizeProjectPolicySubject(value.actor);
    const fence = normalizeFence(value.fence);
    const audit = normalizeSecurityAuditRecord(value.audit);
    const operationId =
      command.expectedRevision === null ? 'trigger.create' : 'trigger.update';
    if (
      audit.eventId !== command.mutationId ||
      audit.operationId !== operationId ||
      audit.projectId !== command.projectId ||
      audit.outcome !== 'allowed' ||
      !audit.subject ||
      !sameSubject(audit.subject, actor) ||
      audit.authenticationId === null ||
      !audit.fence ||
      audit.fence.projectVersion !== fence.projectVersion ||
      audit.fence.bindingVersion !== fence.bindingVersion
    ) {
      throw new InvalidTriggerAdministrationMutationError(
        'audit binding is invalid',
      );
    }
    return Object.freeze({ command, actor, fence, audit });
  } catch (error) {
    if (error instanceof InvalidTriggerAdministrationMutationError) {
      throw error;
    }
    throw new InvalidTriggerAdministrationMutationError(
      'mutation value is invalid',
    );
  }
}

function normalizeTriggerReadAuthority(
  value: Readonly<{
    projectId: string;
    actor: SecuritySubject;
    fence: SecurityPolicyFence;
    audit: SecurityAuditRecord;
  }>,
): Readonly<{
  projectId: string;
  actor: SecuritySubject;
  fence: SecurityPolicyFence;
  audit: SecurityAuditRecord;
}> {
  const actor = normalizeProjectPolicySubject(value.actor);
  const fence = normalizeFence(value.fence);
  const audit = normalizeSecurityAuditRecord(value.audit);
  if (
    audit.operationId !== 'trigger.read' ||
    audit.projectId !== value.projectId ||
    audit.outcome !== 'allowed' ||
    !audit.subject ||
    !sameSubject(audit.subject, actor) ||
    audit.authenticationId === null ||
    !audit.fence ||
    audit.fence.projectVersion !== fence.projectVersion ||
    audit.fence.bindingVersion !== fence.bindingVersion
  ) {
    throw new InvalidTriggerAdministrationReadError(
      'audit binding is invalid',
    );
  }
  return Object.freeze({
    projectId: value.projectId,
    actor,
    fence,
    audit,
  });
}

export function normalizeAuthorizedTriggerInspection(
  value: AuthorizedTriggerInspection,
): Readonly<AuthorizedTriggerInspection> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['actor', 'audit', 'fence', 'projectId', 'triggerId'])
  ) {
    throw new InvalidTriggerAdministrationReadError(
      'inspection shape is invalid',
    );
  }
  try {
    assertTriggerIdentifier(value.projectId, 'projectId');
    assertTriggerIdentifier(value.triggerId, 'triggerId');
    return Object.freeze({
      ...normalizeTriggerReadAuthority(value),
      triggerId: value.triggerId,
    });
  } catch (error) {
    if (error instanceof InvalidTriggerAdministrationReadError) throw error;
    throw new InvalidTriggerAdministrationReadError(
      'inspection value is invalid',
    );
  }
}

export function normalizeAuthorizedTriggerList(
  value: AuthorizedTriggerList,
): Readonly<AuthorizedTriggerList> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTriggerAdministrationReadError('list shape is invalid');
  }
  const keys = Object.keys(value);
  if (
    !['actor', 'audit', 'fence', 'limit', 'projectId'].every((key) =>
      keys.includes(key),
    ) ||
    keys.some(
      (key) =>
        !['actor', 'after', 'audit', 'fence', 'limit', 'projectId'].includes(
          key,
        ),
    )
  ) {
    throw new InvalidTriggerAdministrationReadError('list shape is invalid');
  }
  try {
    assertTriggerIdentifier(value.projectId, 'projectId');
    assertTriggerPageSize(value.limit);
    const authority = normalizeTriggerReadAuthority(value);
    const after = Object.hasOwn(value, 'after')
      ? normalizeTriggerCursor(value.after as TriggerCursor)
      : undefined;
    return Object.freeze({
      ...authority,
      limit: value.limit,
      ...(after ? { after } : {}),
    });
  } catch (error) {
    if (error instanceof InvalidTriggerAdministrationReadError) throw error;
    throw new InvalidTriggerAdministrationReadError('list value is invalid');
  }
}
