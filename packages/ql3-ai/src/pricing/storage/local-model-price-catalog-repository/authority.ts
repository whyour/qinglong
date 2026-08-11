import type { DatabaseSync } from 'node:sqlite';

import type { LocalModelInvocationOperationAuthority } from '../../../model-invocation/localModelInvocationRepository';
import {
  InvalidModelPriceCatalogError,
  ModelPriceCatalogConflictError,
  ModelPriceCatalogUnavailableError,
} from '../../modelPriceCatalog';

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function unavailable(
  cause?: unknown,
): ModelPriceCatalogUnavailableError {
  return new ModelPriceCatalogUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function sqliteConstraint(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  const number = (error as { errcode?: unknown }).errcode;
  return (
    (typeof code === 'string' && code.startsWith('ERR_SQLITE_CONSTRAINT')) ||
    (typeof number === 'number' && (number & 0xff) === 19)
  );
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidModelPriceCatalogError ||
    error instanceof ModelPriceCatalogConflictError ||
    error instanceof ModelPriceCatalogUnavailableError
  ) {
    return error;
  }
  return sqliteConstraint(error)
    ? new ModelPriceCatalogConflictError()
    : unavailable(error);
}

export function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    throw new InvalidModelPriceCatalogError(`${label} is invalid`);
  }
  return value;
}

export class PrivateLocalAuthority
  implements LocalModelInvocationOperationAuthority
{
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

export function isAuthority(
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

export function enqueueOperation<T>(
  authority: LocalModelInvocationOperationAuthority,
  work: () => T,
): Promise<T> {
  return authority.enqueue(async () => {
    try {
      return work();
    } catch (error) {
      throw mapStorageError(error);
    }
  }, unavailable);
}
