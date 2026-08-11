import { normalizeProjectPolicySubject } from '@qinglong/runtime-core/project-policy';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

import {
  normalizeModelProviderCredentialTransitionCommand,
  type CommitModelProviderCredentialTransitionResult,
  type ModelProviderCredentialCatalogRepository,
  type ModelProviderCredentialTransition,
  type ModelProviderCredentialTransitionCommand,
} from './modelProviderCredentialCatalog';

export interface AuthorizedModelProviderCredentialTransitionMutation {
  readonly command: ModelProviderCredentialTransitionCommand;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface ModelProviderCredentialAdministrationRepository
  extends ModelProviderCredentialCatalogRepository {
  commitAuthorized(
    mutation: AuthorizedModelProviderCredentialTransitionMutation,
  ): Promise<Readonly<CommitModelProviderCredentialTransitionResult>>;
}

export const MODEL_PROVIDER_CREDENTIAL_INSPECTION_OPERATION_ID =
  'model_provider_credential.inspect' as const;

export interface AuthorizedModelProviderCredentialInspection {
  readonly projectId: string;
  readonly provider: string;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface ModelProviderCredentialAdministrationInspectionRepository {
  inspectAuthorized(
    inspection: AuthorizedModelProviderCredentialInspection,
  ): Promise<Readonly<ModelProviderCredentialTransition> | null>;
}

export class InvalidModelProviderCredentialAdministrationMutationError extends TypeError {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_ADMINISTRATION_MUTATION_INVALID';

  constructor(message: string) {
    super(
      `Model provider credential administration mutation is invalid: ${message}`,
    );
    this.name = 'InvalidModelProviderCredentialAdministrationMutationError';
  }
}

export class ModelProviderCredentialAdministrationAuthorizationFenceConflictError extends Error {
  readonly code =
    'MODEL_PROVIDER_CREDENTIAL_ADMINISTRATION_AUTHORIZATION_FENCE_CONFLICT';

  constructor() {
    super(
      'Model provider credential administration authorization fence changed',
    );
    this.name =
      'ModelProviderCredentialAdministrationAuthorizationFenceConflictError';
  }
}

export class ModelProviderCredentialAdministrationMutationConflictError extends Error {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_ADMINISTRATION_MUTATION_CONFLICT';

  constructor() {
    super(
      'Model provider credential administration mutation conflicts with durable state',
    );
    this.name = 'ModelProviderCredentialAdministrationMutationConflictError';
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

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    throw new InvalidModelProviderCredentialAdministrationMutationError(
      `${label} is invalid`,
    );
  }
  return value;
}

function normalizeFence(
  value: SecurityPolicyFence,
): Readonly<SecurityPolicyFence> {
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
    throw new InvalidModelProviderCredentialAdministrationMutationError(
      'authorization fence is invalid',
    );
  }
  return Object.freeze({
    projectVersion: value.projectVersion,
    bindingVersion: value.bindingVersion,
  });
}

export function modelProviderCredentialAdministrationOperationId(
  action: ModelProviderCredentialTransitionCommand['action'],
): 'model_provider_credential.bind' | 'model_provider_credential.revoke' {
  if (action === 'bind') return 'model_provider_credential.bind';
  if (action === 'revoke') return 'model_provider_credential.revoke';
  throw new InvalidModelProviderCredentialAdministrationMutationError(
    'action is invalid',
  );
}

export function normalizeAuthorizedModelProviderCredentialTransitionMutation(
  value: AuthorizedModelProviderCredentialTransitionMutation,
): Readonly<AuthorizedModelProviderCredentialTransitionMutation> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['actor', 'audit', 'command', 'fence'])
  ) {
    throw new InvalidModelProviderCredentialAdministrationMutationError(
      'mutation shape is invalid',
    );
  }
  try {
    const command = normalizeModelProviderCredentialTransitionCommand(
      value.command,
    );
    const actor = normalizeProjectPolicySubject(value.actor);
    const fence = normalizeFence(value.fence);
    const audit = normalizeSecurityAuditRecord(value.audit);
    if (
      command.changedBy.type !== 'user' ||
      !sameSubject(command.changedBy, actor) ||
      actor.type !== 'user' ||
      audit.eventId !== command.mutationId ||
      audit.operationId !==
        modelProviderCredentialAdministrationOperationId(command.action) ||
      audit.projectId !== command.projectId ||
      audit.outcome !== 'allowed' ||
      !audit.subject ||
      !sameSubject(audit.subject, actor) ||
      audit.authenticationId === null ||
      !audit.fence ||
      audit.fence.projectVersion !== fence.projectVersion ||
      audit.fence.bindingVersion !== fence.bindingVersion
    ) {
      throw new InvalidModelProviderCredentialAdministrationMutationError(
        'audit binding is invalid',
      );
    }
    return Object.freeze({ command, actor, fence, audit });
  } catch (error) {
    if (
      error instanceof InvalidModelProviderCredentialAdministrationMutationError
    ) {
      throw error;
    }
    throw new InvalidModelProviderCredentialAdministrationMutationError(
      'mutation value is invalid',
    );
  }
}

export function normalizeAuthorizedModelProviderCredentialInspection(
  value: AuthorizedModelProviderCredentialInspection,
): Readonly<AuthorizedModelProviderCredentialInspection> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['actor', 'audit', 'fence', 'projectId', 'provider'])
  ) {
    throw new InvalidModelProviderCredentialAdministrationMutationError(
      'inspection shape is invalid',
    );
  }
  try {
    const projectId = identity(value.projectId, 'projectId');
    const provider = identity(value.provider, 'provider');
    const actor = normalizeProjectPolicySubject(value.actor);
    const fence = normalizeFence(value.fence);
    const audit = normalizeSecurityAuditRecord(value.audit);
    if (
      actor.type !== 'user' ||
      audit.operationId !== MODEL_PROVIDER_CREDENTIAL_INSPECTION_OPERATION_ID ||
      audit.projectId !== projectId ||
      audit.outcome !== 'allowed' ||
      !audit.subject ||
      !sameSubject(audit.subject, actor) ||
      audit.authenticationId === null ||
      !audit.fence ||
      audit.fence.projectVersion !== fence.projectVersion ||
      audit.fence.bindingVersion !== fence.bindingVersion
    ) {
      throw new InvalidModelProviderCredentialAdministrationMutationError(
        'inspection audit binding is invalid',
      );
    }
    return Object.freeze({ projectId, provider, actor, fence, audit });
  } catch (error) {
    if (
      error instanceof InvalidModelProviderCredentialAdministrationMutationError
    ) {
      throw error;
    }
    throw new InvalidModelProviderCredentialAdministrationMutationError(
      'inspection value is invalid',
    );
  }
}
