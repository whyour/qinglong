import type { DatabaseSync } from 'node:sqlite';

import type { LocalModelInvocationOperationAuthority } from '../../model-invocation/localModelInvocationRepository';
import {
  InvalidPluginPackagePromptExecutionPlanError,
  PluginPackagePromptAdmissionConflictError,
  PluginPackagePromptAdmissionNotAllowedError,
  PluginPackagePromptAdmissionUnavailableError,
  PluginPackagePromptExecutionInProgressError,
  PluginPackagePromptResolutionRequiredError,
  type PluginPackagePromptExecutionPlan,
} from '../pluginPackagePromptExecution';

export type Row = Record<string, unknown>;

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export interface LocalPluginPackagePromptAdmissionMutationGuard {
  confirm(
    plan: Readonly<PluginPackagePromptExecutionPlan>,
    replay: boolean,
  ): void;
}

export function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    throw new InvalidPluginPackagePromptExecutionPlanError(
      `${label} is invalid`,
    );
  }
  return value;
}

export function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new PluginPackagePromptAdmissionUnavailableError();
  }
  return value;
}

export function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PluginPackagePromptAdmissionUnavailableError();
  }
  return value as number;
}

export function nullableText(row: Row, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}

function sqliteConstraint(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const errcode = (error as { errcode?: unknown }).errcode;
  return (
    (typeof code === 'string' &&
      (code === 'ERR_SQLITE_CONSTRAINT' ||
        code.startsWith('SQLITE_CONSTRAINT') ||
        code.startsWith('ERR_SQLITE_CONSTRAINT'))) ||
    (typeof errcode === 'number' && (errcode & 0xff) === 19)
  );
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackagePromptExecutionPlanError ||
    error instanceof PluginPackagePromptAdmissionConflictError ||
    error instanceof PluginPackagePromptAdmissionNotAllowedError ||
    error instanceof PluginPackagePromptAdmissionUnavailableError ||
    error instanceof PluginPackagePromptExecutionInProgressError ||
    error instanceof PluginPackagePromptResolutionRequiredError
  ) {
    return error;
  }
  if (sqliteConstraint(error)) {
    return new PluginPackagePromptAdmissionConflictError();
  }
  return new PluginPackagePromptAdmissionUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
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

export function createAuthority(
  authority: LocalModelInvocationOperationAuthority | DatabaseSync,
): LocalModelInvocationOperationAuthority {
  return isAuthority(authority)
    ? authority
    : new PrivateLocalAuthority(authority);
}

export function enqueueOperation<T>(
  authority: LocalModelInvocationOperationAuthority,
  work: () => T | Promise<T>,
): Promise<T> {
  return authority.enqueue(
    async () => {
      try {
        return await work();
      } catch (error) {
        throw mapStorageError(error);
      }
    },
    () => new PluginPackagePromptAdmissionUnavailableError(),
  );
}
