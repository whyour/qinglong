import { createHash } from 'node:crypto';

import {
  SECURITY_SUBJECT_TYPES,
  type SecuritySubject,
} from '@qinglong/runtime-core/security';

import {
  MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
  digestModelProviderCredentialBinding,
  normalizeModelProviderCredentialBinding,
  type ModelProviderCredentialBinding,
} from './providerCredential';

export const MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA =
  'qinglong/model-provider-credential-transition-command@v1';
export const MODEL_PROVIDER_CREDENTIAL_TRANSITION_SCHEMA =
  'qinglong/model-provider-credential-transition@v1';

export interface ModelProviderCredentialTransitionCommand {
  readonly schema: typeof MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA;
  readonly mutationId: string;
  readonly projectId: string;
  readonly provider: string;
  readonly expectedGeneration: number;
  readonly action: 'bind' | 'revoke';
  readonly binding: Readonly<ModelProviderCredentialBinding> | null;
  readonly changedBy: Readonly<SecuritySubject>;
  readonly commandDigest: string;
}

export interface ModelProviderCredentialTransition {
  readonly schema: typeof MODEL_PROVIDER_CREDENTIAL_TRANSITION_SCHEMA;
  readonly mutationId: string;
  readonly projectId: string;
  readonly provider: string;
  readonly generation: number;
  readonly action: 'bind' | 'revoke';
  readonly activeBindingRevision: string | null;
  readonly activeBindingDigest: string | null;
  readonly previousTransitionDigest: string | null;
  readonly changedBy: Readonly<SecuritySubject>;
  readonly changedAtMs: number;
  readonly commandDigest: string;
  readonly transitionDigest: string;
}

export interface CommitModelProviderCredentialTransitionResult {
  readonly status: 'created' | 'existing';
  readonly transition: Readonly<ModelProviderCredentialTransition>;
}

export interface ModelProviderCredentialCatalogRepository {
  findCurrentTransition(
    projectId: string,
    provider: string,
  ): Promise<Readonly<ModelProviderCredentialTransition> | null>;
  commit(
    command: Readonly<ModelProviderCredentialTransitionCommand>,
  ): Promise<Readonly<CommitModelProviderCredentialTransitionResult>>;
}

export class InvalidModelProviderCredentialTransitionError extends TypeError {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_TRANSITION_INVALID';

  constructor(message: string) {
    super(`Model provider credential transition is invalid: ${message}`);
    this.name = 'InvalidModelProviderCredentialTransitionError';
  }
}

export class ModelProviderCredentialTransitionConflictError extends Error {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_TRANSITION_CONFLICT';

  constructor() {
    super(
      'The model provider credential transition conflicts with durable state',
    );
    this.name = 'ModelProviderCredentialTransitionConflictError';
  }
}

export class ModelProviderCredentialCatalogUnavailableError extends Error {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_CATALOG_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('The model provider credential catalog is unavailable', options);
    this.name = 'ModelProviderCredentialCatalogUnavailableError';
  }
}

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== [...expectedKeys].sort().join('\0')
  ) {
    throw new InvalidModelProviderCredentialTransitionError(
      `${label} shape is invalid`,
    );
  }
  return value as Record<string, unknown>;
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    throw new InvalidModelProviderCredentialTransitionError(
      `${label} is invalid`,
    );
  }
  return value;
}

function providerIdentity(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER_PATTERN.test(value)) {
    throw new InvalidModelProviderCredentialTransitionError(
      'provider is invalid',
    );
  }
  return value;
}

function generation(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new InvalidModelProviderCredentialTransitionError(
      'generation is invalid',
    );
  }
  return value as number;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidModelProviderCredentialTransitionError(
      'changedAtMs is invalid',
    );
  }
  return value as number;
}

function nullableDigest(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new InvalidModelProviderCredentialTransitionError(
      `${label} is invalid`,
    );
  }
  return value;
}

function subject(value: unknown): Readonly<SecuritySubject> {
  const candidate = exactObject(value, ['id', 'type'], 'changedBy');
  if (
    !SECURITY_SUBJECT_TYPES.includes(candidate.type as SecuritySubject['type'])
  ) {
    throw new InvalidModelProviderCredentialTransitionError(
      'changedBy type is invalid',
    );
  }
  return Object.freeze({
    type: candidate.type as SecuritySubject['type'],
    id: identity(candidate.id, 'changedBy id'),
  });
}

function digest(label: string, value: object): string {
  return createHash('sha256')
    .update(label, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function commandDigestInput(
  command: Omit<ModelProviderCredentialTransitionCommand, 'commandDigest'>,
): object {
  return {
    schema: command.schema,
    mutationId: command.mutationId,
    projectId: command.projectId,
    provider: command.provider,
    expectedGeneration: command.expectedGeneration,
    action: command.action,
    binding: command.binding,
    changedBy: command.changedBy,
  };
}

export function createModelProviderCredentialTransitionCommand(
  value: Omit<ModelProviderCredentialTransitionCommand, 'commandDigest'>,
): Readonly<ModelProviderCredentialTransitionCommand> {
  const candidate = exactObject(
    value,
    [
      'action',
      'binding',
      'changedBy',
      'expectedGeneration',
      'mutationId',
      'projectId',
      'provider',
      'schema',
    ],
    'command',
  );
  if (
    candidate.schema !== MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA
  ) {
    throw new InvalidModelProviderCredentialTransitionError(
      'command schema is invalid',
    );
  }
  const projectId = identity(candidate.projectId, 'projectId');
  const provider = providerIdentity(candidate.provider);
  const action = candidate.action;
  if (action !== 'bind' && action !== 'revoke') {
    throw new InvalidModelProviderCredentialTransitionError(
      'action is invalid',
    );
  }
  let binding: Readonly<ModelProviderCredentialBinding> | null = null;
  if (action === 'bind') {
    if (!candidate.binding) {
      throw new InvalidModelProviderCredentialTransitionError(
        'bind requires a binding',
      );
    }
    try {
      binding = normalizeModelProviderCredentialBinding(
        candidate.binding as ModelProviderCredentialBinding,
      );
    } catch {
      throw new InvalidModelProviderCredentialTransitionError(
        'binding is invalid',
      );
    }
    if (binding.projectId !== projectId || binding.provider !== provider) {
      throw new InvalidModelProviderCredentialTransitionError(
        'binding identity does not match the command',
      );
    }
  } else if (candidate.binding !== null) {
    throw new InvalidModelProviderCredentialTransitionError(
      'revoke cannot contain a binding',
    );
  }
  const command = Object.freeze({
    schema: MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
    mutationId: identity(candidate.mutationId, 'mutationId'),
    projectId,
    provider,
    expectedGeneration: generation(candidate.expectedGeneration, 0),
    action,
    binding,
    changedBy: subject(candidate.changedBy),
  });
  return Object.freeze({
    ...command,
    commandDigest: digest(
      'qinglong/model-provider-credential-transition-command@v1',
      commandDigestInput(command),
    ),
  });
}

export function normalizeModelProviderCredentialTransitionCommand(
  value: ModelProviderCredentialTransitionCommand,
): Readonly<ModelProviderCredentialTransitionCommand> {
  const candidate = exactObject(
    value,
    [
      'action',
      'binding',
      'changedBy',
      'commandDigest',
      'expectedGeneration',
      'mutationId',
      'projectId',
      'provider',
      'schema',
    ],
    'command',
  );
  const normalized = createModelProviderCredentialTransitionCommand({
    schema:
      candidate.schema as typeof MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
    mutationId: candidate.mutationId as string,
    projectId: candidate.projectId as string,
    provider: candidate.provider as string,
    expectedGeneration: candidate.expectedGeneration as number,
    action: candidate.action as 'bind' | 'revoke',
    binding: candidate.binding as ModelProviderCredentialBinding | null,
    changedBy: candidate.changedBy as SecuritySubject,
  });
  if (candidate.commandDigest !== normalized.commandDigest) {
    throw new InvalidModelProviderCredentialTransitionError(
      'commandDigest is invalid',
    );
  }
  return normalized;
}

function transitionDigestInput(
  transition: Omit<ModelProviderCredentialTransition, 'transitionDigest'>,
): object {
  return {
    schema: transition.schema,
    mutationId: transition.mutationId,
    projectId: transition.projectId,
    provider: transition.provider,
    generation: transition.generation,
    action: transition.action,
    activeBindingRevision: transition.activeBindingRevision,
    activeBindingDigest: transition.activeBindingDigest,
    previousTransitionDigest: transition.previousTransitionDigest,
    changedBy: transition.changedBy,
    changedAtMs: transition.changedAtMs,
    commandDigest: transition.commandDigest,
  };
}

export function createModelProviderCredentialTransition(
  commandValue: ModelProviderCredentialTransitionCommand,
  previous: Readonly<ModelProviderCredentialTransition> | null,
  changedAtMs: number,
): Readonly<ModelProviderCredentialTransition> {
  const command =
    normalizeModelProviderCredentialTransitionCommand(commandValue);
  const currentGeneration = previous?.generation ?? 0;
  if (
    command.expectedGeneration !== currentGeneration ||
    (previous !== null &&
      (previous.projectId !== command.projectId ||
        previous.provider !== command.provider))
  ) {
    throw new ModelProviderCredentialTransitionConflictError();
  }
  const transition = Object.freeze({
    schema: MODEL_PROVIDER_CREDENTIAL_TRANSITION_SCHEMA,
    mutationId: command.mutationId,
    projectId: command.projectId,
    provider: command.provider,
    generation: currentGeneration + 1,
    action: command.action,
    activeBindingRevision: command.binding?.revision ?? null,
    activeBindingDigest:
      command.binding === null
        ? null
        : digestModelProviderCredentialBinding(command.binding).slice(7),
    previousTransitionDigest: previous?.transitionDigest ?? null,
    changedBy: command.changedBy,
    changedAtMs: timestamp(changedAtMs),
    commandDigest: command.commandDigest,
  });
  return Object.freeze({
    ...transition,
    transitionDigest: digest(
      'qinglong/model-provider-credential-transition@v1',
      transitionDigestInput(transition),
    ),
  });
}

export function normalizeModelProviderCredentialTransition(
  value: ModelProviderCredentialTransition,
): Readonly<ModelProviderCredentialTransition> {
  const candidate = exactObject(
    value,
    [
      'action',
      'activeBindingDigest',
      'activeBindingRevision',
      'changedAtMs',
      'changedBy',
      'commandDigest',
      'generation',
      'mutationId',
      'previousTransitionDigest',
      'projectId',
      'provider',
      'schema',
      'transitionDigest',
    ],
    'transition',
  );
  if (candidate.schema !== MODEL_PROVIDER_CREDENTIAL_TRANSITION_SCHEMA) {
    throw new InvalidModelProviderCredentialTransitionError(
      'transition schema is invalid',
    );
  }
  const action = candidate.action;
  if (action !== 'bind' && action !== 'revoke') {
    throw new InvalidModelProviderCredentialTransitionError(
      'transition action is invalid',
    );
  }
  const activeBindingRevision =
    candidate.activeBindingRevision === null
      ? null
      : identity(candidate.activeBindingRevision, 'active binding revision');
  const activeBindingDigest = nullableDigest(
    candidate.activeBindingDigest,
    'active binding digest',
  );
  if (
    (action === 'bind' &&
      (activeBindingRevision === null || activeBindingDigest === null)) ||
    (action === 'revoke' &&
      (activeBindingRevision !== null || activeBindingDigest !== null))
  ) {
    throw new InvalidModelProviderCredentialTransitionError(
      'transition binding state is invalid',
    );
  }
  const normalized = Object.freeze({
    schema: MODEL_PROVIDER_CREDENTIAL_TRANSITION_SCHEMA,
    mutationId: identity(candidate.mutationId, 'mutationId'),
    projectId: identity(candidate.projectId, 'projectId'),
    provider: providerIdentity(candidate.provider),
    generation: generation(candidate.generation, 1),
    action,
    activeBindingRevision,
    activeBindingDigest,
    previousTransitionDigest: nullableDigest(
      candidate.previousTransitionDigest,
      'previous transition digest',
    ),
    changedBy: subject(candidate.changedBy),
    changedAtMs: timestamp(candidate.changedAtMs),
    commandDigest: nullableDigest(candidate.commandDigest, 'command digest')!,
  });
  const expectedDigest = digest(
    'qinglong/model-provider-credential-transition@v1',
    transitionDigestInput(normalized),
  );
  if (candidate.transitionDigest !== expectedDigest) {
    throw new InvalidModelProviderCredentialTransitionError(
      'transitionDigest is invalid',
    );
  }
  return Object.freeze({ ...normalized, transitionDigest: expectedDigest });
}

export function modelProviderCredentialBindingForTransition(
  transitionValue: ModelProviderCredentialTransition,
  bindingValue: ModelProviderCredentialBinding | null,
): Readonly<ModelProviderCredentialBinding> | null {
  const transition =
    normalizeModelProviderCredentialTransition(transitionValue);
  if (transition.action === 'revoke') {
    if (bindingValue !== null) {
      throw new ModelProviderCredentialCatalogUnavailableError();
    }
    return null;
  }
  if (bindingValue === null) {
    throw new ModelProviderCredentialCatalogUnavailableError();
  }
  const binding = normalizeModelProviderCredentialBinding(bindingValue);
  if (
    binding.schema !== MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA ||
    binding.projectId !== transition.projectId ||
    binding.provider !== transition.provider ||
    binding.revision !== transition.activeBindingRevision ||
    digestModelProviderCredentialBinding(binding).slice(7) !==
      transition.activeBindingDigest
  ) {
    throw new ModelProviderCredentialCatalogUnavailableError();
  }
  return binding;
}
