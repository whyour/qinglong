import type { DatabaseSync } from 'node:sqlite';

import { parseSecretRef } from '@qinglong/runtime-core/secret-reference';

import {
  ModelProviderCredentialAdministrationAuthorizationFenceConflictError,
  ModelProviderCredentialAdministrationMutationConflictError,
  normalizeAuthorizedModelProviderCredentialInspection,
  normalizeAuthorizedModelProviderCredentialTransitionMutation,
  type AuthorizedModelProviderCredentialInspection,
  type AuthorizedModelProviderCredentialTransitionMutation,
  type ModelProviderCredentialAdministrationInspectionRepository,
  type ModelProviderCredentialAdministrationRepository,
} from './modelProviderCredentialAdministration';
import {
  InvalidModelProviderCredentialTransitionError,
  ModelProviderCredentialCatalogUnavailableError,
  ModelProviderCredentialTransitionConflictError,
  createModelProviderCredentialTransition,
  modelProviderCredentialBindingForTransition,
  normalizeModelProviderCredentialTransition,
  normalizeModelProviderCredentialTransitionCommand,
  type CommitModelProviderCredentialTransitionResult,
  type ModelProviderCredentialTransition,
  type ModelProviderCredentialTransitionCommand,
} from './modelProviderCredentialCatalog';
import type { LocalModelInvocationOperationAuthority } from '../model-invocation/localModelInvocationRepository';
import {
  MODEL_PROVIDER_CREDENTIAL_AUDIT_SCHEMA,
  MODEL_PROVIDER_CREDENTIAL_OPERATIONS,
  digestModelProviderCredentialBinding,
  normalizeModelProviderCredentialBinding,
  type ModelProviderCredentialAuditRecord,
  type ModelProviderCredentialAuditSink,
  type ModelProviderCredentialBinding,
  type ModelProviderCredentialBindingLookup,
  type ModelProviderCredentialBindingSource,
} from './providerCredential';

type Row = Record<string, unknown>;

export type LocalModelProviderCredentialAuthorizationInput =
  | Readonly<{
      kind: 'mutation';
      value: Readonly<AuthorizedModelProviderCredentialTransitionMutation>;
      replay: boolean;
    }>
  | Readonly<{
      kind: 'inspection';
      value: Readonly<AuthorizedModelProviderCredentialInspection>;
      replay: false;
    }>;

export interface LocalModelProviderCredentialAuthorizationGuard {
  confirm(input: LocalModelProviderCredentialAuthorizationInput): void;
}

export interface LocalModelProviderCredentialRepositoryOptions {
  readonly now?: () => number;
  readonly authorization?: LocalModelProviderCredentialAuthorizationGuard;
}

class PrivateLocalAuthority implements LocalModelInvocationOperationAuthority {
  readonly client: DatabaseSync;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(client: DatabaseSync) {
    this.client = client;
  }

  enqueue<T>(
    work: () => Promise<T>,
    rejection: (reason: 'closed' | 'busy') => Error,
  ): Promise<T> {
    if (!this.client.isOpen) return Promise.reject(rejection('closed'));
    if (this.#pending >= 64) return Promise.reject(rejection('busy'));
    this.#pending += 1;
    const result = this.#tail.then(work, work);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.#pending -= 1;
    });
  }
}

function isAuthority(
  value: LocalModelInvocationOperationAuthority | DatabaseSync,
): value is LocalModelInvocationOperationAuthority {
  return (
    !!value &&
    typeof value === 'object' &&
    'client' in value &&
    'enqueue' in value &&
    typeof value.enqueue === 'function'
  );
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new ModelProviderCredentialCatalogUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ModelProviderCredentialCatalogUnavailableError();
  }
  return value as number;
}

function nullableText(row: Row, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}

function sqliteConstraint(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const errcode = (error as { errcode?: unknown }).errcode;
  return (
    (typeof code === 'string' && code.includes('SQLITE_CONSTRAINT')) ||
    (typeof errcode === 'number' && (errcode & 0xff) === 19)
  );
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidModelProviderCredentialTransitionError ||
    error instanceof ModelProviderCredentialTransitionConflictError ||
    error instanceof ModelProviderCredentialCatalogUnavailableError ||
    error instanceof
      ModelProviderCredentialAdministrationAuthorizationFenceConflictError ||
    error instanceof ModelProviderCredentialAdministrationMutationConflictError
  ) {
    return error;
  }
  if (sqliteConstraint(error)) {
    return new ModelProviderCredentialTransitionConflictError();
  }
  return new ModelProviderCredentialCatalogUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
  ) {
    throw new InvalidModelProviderCredentialTransitionError(
      `${label} is invalid`,
    );
  }
  return value;
}

function normalizeUseAudit(
  value: Readonly<ModelProviderCredentialAuditRecord>,
): Readonly<ModelProviderCredentialAuditRecord> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'bindingDigest',
        'bindingRevision',
        'occurredAtMs',
        'operation',
        'projectId',
        'provider',
        'requestId',
        'schema',
      ]
        .sort()
        .join('\0') ||
    value.schema !== MODEL_PROVIDER_CREDENTIAL_AUDIT_SCHEMA ||
    !MODEL_PROVIDER_CREDENTIAL_OPERATIONS.includes(value.operation) ||
    typeof value.bindingDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.bindingDigest) ||
    !Number.isSafeInteger(value.occurredAtMs) ||
    value.occurredAtMs < 0
  ) {
    throw new ModelProviderCredentialCatalogUnavailableError();
  }
  return Object.freeze({
    schema: MODEL_PROVIDER_CREDENTIAL_AUDIT_SCHEMA,
    operation: value.operation,
    projectId: identifier(value.projectId, 'projectId'),
    provider: identifier(value.provider, 'provider'),
    requestId: identifier(value.requestId, 'requestId'),
    bindingRevision: identifier(value.bindingRevision, 'bindingRevision'),
    bindingDigest: value.bindingDigest,
    occurredAtMs: value.occurredAtMs,
  });
}

function sameUseAudit(
  left: Readonly<ModelProviderCredentialAuditRecord>,
  right: Readonly<ModelProviderCredentialAuditRecord>,
): boolean {
  return (
    canonical({ ...left, occurredAtMs: right.occurredAtMs }) ===
    canonical(right)
  );
}

export class LocalModelProviderCredentialRepository
  implements
    ModelProviderCredentialAdministrationRepository,
    ModelProviderCredentialAdministrationInspectionRepository,
    ModelProviderCredentialBindingSource,
    ModelProviderCredentialAuditSink
{
  readonly #authority: LocalModelInvocationOperationAuthority;
  readonly #now: () => number;
  readonly #authorization:
    | LocalModelProviderCredentialAuthorizationGuard
    | undefined;

  constructor(
    authority: LocalModelInvocationOperationAuthority | DatabaseSync,
    options: LocalModelProviderCredentialRepositoryOptions = {},
  ) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some(
        (key) => key !== 'authorization' && key !== 'now',
      ) ||
      (options.now !== undefined && typeof options.now !== 'function') ||
      (options.authorization !== undefined &&
        typeof options.authorization.confirm !== 'function')
    ) {
      throw new TypeError(
        'Local model provider credential repository options are invalid',
      );
    }
    this.#authority = isAuthority(authority)
      ? authority
      : new PrivateLocalAuthority(authority);
    this.#now = options.now ?? Date.now;
    this.#authorization = options.authorization;
  }

  #enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    return this.#authority.enqueue(
      async () => {
        try {
          return await work();
        } catch (error) {
          throw mapStorageError(error);
        }
      },
      () => new ModelProviderCredentialCatalogUnavailableError(),
    );
  }

  #rowByMutation(mutationId: string): Row | undefined {
    return this.#authority.client
      .prepare(
        `SELECT command_json AS "commandJson",
                transition_json AS "transitionJson"
           FROM "ModelInvocationProviderCredentialTransitions"
          WHERE mutation_id = ?`,
      )
      .get(mutationId) as Row | undefined;
  }

  #currentRow(projectId: string, provider: string): Row | undefined {
    return this.#authority.client
      .prepare(
        `SELECT transition_json AS "transitionJson"
           FROM "ModelInvocationProviderCredentialTransitions"
          WHERE project_id = ? AND provider = ?
          ORDER BY generation DESC LIMIT 1`,
      )
      .get(projectId, provider) as Row | undefined;
  }

  #transition(row: Row): Readonly<ModelProviderCredentialTransition> {
    try {
      return normalizeModelProviderCredentialTransition(
        JSON.parse(
          text(row, 'transitionJson'),
        ) as ModelProviderCredentialTransition,
      );
    } catch (error) {
      if (error instanceof ModelProviderCredentialCatalogUnavailableError) {
        throw error;
      }
      throw new ModelProviderCredentialCatalogUnavailableError();
    }
  }

  #current(
    projectId: string,
    provider: string,
  ): Readonly<ModelProviderCredentialTransition> | null {
    const row = this.#currentRow(projectId, provider);
    if (!row) return null;
    const transition = this.#transition(row);
    if (
      transition.projectId !== projectId ||
      transition.provider !== provider
    ) {
      throw new ModelProviderCredentialCatalogUnavailableError();
    }
    return transition;
  }

  #existing(
    command: Readonly<ModelProviderCredentialTransitionCommand>,
  ): Readonly<CommitModelProviderCredentialTransitionResult> | null {
    const row = this.#rowByMutation(command.mutationId);
    if (!row) return null;
    let storedCommand: Readonly<ModelProviderCredentialTransitionCommand>;
    try {
      storedCommand = normalizeModelProviderCredentialTransitionCommand(
        JSON.parse(
          text(row, 'commandJson'),
        ) as ModelProviderCredentialTransitionCommand,
      );
    } catch {
      throw new ModelProviderCredentialCatalogUnavailableError();
    }
    if (canonical(storedCommand) !== canonical(command)) {
      throw new ModelProviderCredentialTransitionConflictError();
    }
    return Object.freeze({
      status: 'existing' as const,
      transition: this.#transition(row),
    });
  }

  #assertSecretExists(binding: Readonly<ModelProviderCredentialBinding>): void {
    let reference;
    try {
      reference = parseSecretRef(binding.secretRef);
    } catch {
      throw new ModelProviderCredentialTransitionConflictError();
    }
    const row =
      reference.version === undefined
        ? this.#authority.client
            .prepare(
              `SELECT version FROM "QingLong3LocalSecretEnvelopes"
              WHERE project_id = ? AND secret_name = ?
              ORDER BY version DESC LIMIT 1`,
            )
            .get(reference.projectId, reference.name)
        : this.#authority.client
            .prepare(
              `SELECT version FROM "QingLong3LocalSecretEnvelopes"
              WHERE project_id = ? AND secret_name = ? AND version = ?`,
            )
            .get(reference.projectId, reference.name, reference.version);
    if (!row) throw new ModelProviderCredentialTransitionConflictError();
  }

  #binding(
    transition: Readonly<ModelProviderCredentialTransition>,
  ): Readonly<ModelProviderCredentialBinding> | null {
    if (transition.action === 'revoke') {
      return modelProviderCredentialBindingForTransition(transition, null);
    }
    const row = this.#authority.client
      .prepare(
        `SELECT binding_digest AS "bindingDigest",
                binding_json AS "bindingJson"
           FROM "ModelInvocationProviderCredentialBindings"
          WHERE project_id = ? AND provider = ? AND revision = ?`,
      )
      .get(
        transition.projectId,
        transition.provider,
        transition.activeBindingRevision,
      ) as Row | undefined;
    if (!row) throw new ModelProviderCredentialCatalogUnavailableError();
    let binding: Readonly<ModelProviderCredentialBinding>;
    try {
      binding = normalizeModelProviderCredentialBinding(
        JSON.parse(text(row, 'bindingJson')) as ModelProviderCredentialBinding,
      );
    } catch {
      throw new ModelProviderCredentialCatalogUnavailableError();
    }
    if (
      digestModelProviderCredentialBinding(binding).slice(7) !==
      text(row, 'bindingDigest')
    ) {
      throw new ModelProviderCredentialCatalogUnavailableError();
    }
    return modelProviderCredentialBindingForTransition(transition, binding);
  }

  #insertBinding(binding: Readonly<ModelProviderCredentialBinding>): void {
    const digest = digestModelProviderCredentialBinding(binding).slice(7);
    const existing = this.#authority.client
      .prepare(
        `SELECT binding_digest AS "bindingDigest",
                binding_json AS "bindingJson"
           FROM "ModelInvocationProviderCredentialBindings"
          WHERE project_id = ? AND provider = ? AND revision = ?`,
      )
      .get(binding.projectId, binding.provider, binding.revision) as
      | Row
      | undefined;
    if (existing) {
      if (
        text(existing, 'bindingDigest') !== digest ||
        text(existing, 'bindingJson') !== canonical(binding)
      ) {
        throw new ModelProviderCredentialTransitionConflictError();
      }
      return;
    }
    this.#authority.client
      .prepare(
        `INSERT INTO "ModelInvocationProviderCredentialBindings" (
           project_id, provider, revision, binding_digest, binding_json
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        binding.projectId,
        binding.provider,
        binding.revision,
        digest,
        canonical(binding),
      );
  }

  #insertTransition(
    command: Readonly<ModelProviderCredentialTransitionCommand>,
    transition: Readonly<ModelProviderCredentialTransition>,
  ): void {
    this.#authority.client
      .prepare(
        `INSERT INTO "ModelInvocationProviderCredentialTransitions" (
           mutation_id, project_id, provider, generation, action,
           active_binding_revision, active_binding_digest,
           previous_transition_digest, changed_by_type, changed_by_id,
           changed_at_ms, command_digest, transition_digest,
           command_json, transition_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transition.mutationId,
        transition.projectId,
        transition.provider,
        transition.generation,
        transition.action,
        transition.activeBindingRevision,
        transition.activeBindingDigest,
        transition.previousTransitionDigest,
        transition.changedBy.type,
        transition.changedBy.id,
        transition.changedAtMs,
        transition.commandDigest,
        transition.transitionDigest,
        canonical(command),
        canonical(transition),
      );
  }

  #commit(
    command: Readonly<ModelProviderCredentialTransitionCommand>,
    authorized?: Readonly<AuthorizedModelProviderCredentialTransitionMutation>,
  ): Readonly<CommitModelProviderCredentialTransitionResult> {
    let began = false;
    try {
      this.#authority.client.exec('BEGIN IMMEDIATE');
      began = true;
      const existing = this.#existing(command);
      if (existing) {
        if (authorized) {
          if (!this.#authorization) {
            throw new ModelProviderCredentialAdministrationAuthorizationFenceConflictError();
          }
          this.#authorization.confirm(
            Object.freeze({
              kind: 'mutation',
              value: authorized,
              replay: true,
            }),
          );
        }
        this.#authority.client.exec('COMMIT');
        began = false;
        return existing;
      }
      if (authorized) {
        if (!this.#authorization) {
          throw new ModelProviderCredentialAdministrationAuthorizationFenceConflictError();
        }
        this.#authorization.confirm(
          Object.freeze({ kind: 'mutation', value: authorized, replay: false }),
        );
      }
      const previous = this.#current(command.projectId, command.provider);
      const changedAtMs = this.#now();
      if (!Number.isSafeInteger(changedAtMs) || changedAtMs < 0) {
        throw new ModelProviderCredentialCatalogUnavailableError();
      }
      const transition = createModelProviderCredentialTransition(
        command,
        previous,
        changedAtMs,
      );
      if (command.binding) {
        this.#assertSecretExists(command.binding);
        this.#insertBinding(command.binding);
      }
      this.#insertTransition(command, transition);
      this.#authority.client.exec('COMMIT');
      began = false;
      return Object.freeze({ status: 'created' as const, transition });
    } finally {
      if (began && this.#authority.client.isTransaction) {
        try {
          this.#authority.client.exec('ROLLBACK');
        } catch {
          // Preserve the original fail-closed error.
        }
      }
    }
  }

  findCurrentTransition(projectIdValue: string, providerValue: string) {
    const projectId = identifier(projectIdValue, 'projectId');
    const provider = identifier(providerValue, 'provider');
    return this.#enqueue(() => this.#current(projectId, provider));
  }

  commit(commandValue: Readonly<ModelProviderCredentialTransitionCommand>) {
    const command =
      normalizeModelProviderCredentialTransitionCommand(commandValue);
    return this.#enqueue(() => this.#commit(command));
  }

  commitAuthorized(
    mutationValue: AuthorizedModelProviderCredentialTransitionMutation,
  ) {
    const mutation =
      normalizeAuthorizedModelProviderCredentialTransitionMutation(
        mutationValue,
      );
    return this.#enqueue(() => this.#commit(mutation.command, mutation));
  }

  inspectAuthorized(
    inspectionValue: AuthorizedModelProviderCredentialInspection,
  ): Promise<Readonly<ModelProviderCredentialTransition> | null> {
    const inspection =
      normalizeAuthorizedModelProviderCredentialInspection(inspectionValue);
    return this.#enqueue(() => {
      if (!this.#authorization) {
        throw new ModelProviderCredentialAdministrationAuthorizationFenceConflictError();
      }
      let began = false;
      try {
        this.#authority.client.exec('BEGIN IMMEDIATE');
        began = true;
        const transition = this.#current(
          inspection.projectId,
          inspection.provider,
        );
        this.#authorization.confirm(
          Object.freeze({
            kind: 'inspection',
            value: inspection,
            replay: false,
          }),
        );
        this.#authority.client.exec('COMMIT');
        began = false;
        return transition;
      } finally {
        if (began && this.#authority.client.isTransaction) {
          try {
            this.#authority.client.exec('ROLLBACK');
          } catch {
            // Preserve the original fail-closed error.
          }
        }
      }
    });
  }

  resolveModelProviderCredentialBinding(
    lookupValue: Readonly<ModelProviderCredentialBindingLookup>,
  ): Promise<Readonly<ModelProviderCredentialBinding> | null> {
    if (
      !lookupValue ||
      typeof lookupValue !== 'object' ||
      Array.isArray(lookupValue) ||
      Object.keys(lookupValue).sort().join('\0') !== 'projectId\0provider'
    ) {
      return Promise.reject(
        new ModelProviderCredentialCatalogUnavailableError(),
      );
    }
    const projectId = identifier(lookupValue.projectId, 'projectId');
    const provider = identifier(lookupValue.provider, 'provider');
    return this.#enqueue(() => {
      const transition = this.#current(projectId, provider);
      return transition ? this.#binding(transition) : null;
    });
  }

  record(
    recordValue: Readonly<ModelProviderCredentialAuditRecord>,
  ): Promise<void> {
    const record = normalizeUseAudit(recordValue);
    return this.#enqueue(() => {
      let began = false;
      try {
        this.#authority.client.exec('BEGIN IMMEDIATE');
        began = true;
        const transition = this.#current(record.projectId, record.provider);
        if (
          !transition ||
          transition.action !== 'bind' ||
          transition.activeBindingRevision !== record.bindingRevision ||
          `sha256:${transition.activeBindingDigest}` !== record.bindingDigest
        ) {
          throw new ModelProviderCredentialTransitionConflictError();
        }
        const existing = this.#authority.client
          .prepare(
            `SELECT audit_json AS "auditJson"
               FROM "ModelInvocationProviderCredentialAudits"
              WHERE operation = ? AND project_id = ? AND provider = ?
                AND request_id = ?`,
          )
          .get(
            record.operation,
            record.projectId,
            record.provider,
            record.requestId,
          ) as Row | undefined;
        if (existing) {
          let stored: Readonly<ModelProviderCredentialAuditRecord>;
          try {
            stored = normalizeUseAudit(
              JSON.parse(
                text(existing, 'auditJson'),
              ) as ModelProviderCredentialAuditRecord,
            );
          } catch {
            throw new ModelProviderCredentialCatalogUnavailableError();
          }
          if (!sameUseAudit(stored, record)) {
            throw new ModelProviderCredentialTransitionConflictError();
          }
        } else {
          this.#authority.client
            .prepare(
              `INSERT INTO "ModelInvocationProviderCredentialAudits" (
                 operation, project_id, provider, request_id,
                 binding_revision, binding_digest, occurred_at_ms, audit_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              record.operation,
              record.projectId,
              record.provider,
              record.requestId,
              record.bindingRevision,
              record.bindingDigest,
              record.occurredAtMs,
              canonical(record),
            );
        }
        this.#authority.client.exec('COMMIT');
        began = false;
      } finally {
        if (began && this.#authority.client.isTransaction) {
          try {
            this.#authority.client.exec('ROLLBACK');
          } catch {
            // Preserve the original fail-closed error.
          }
        }
      }
    });
  }
}
