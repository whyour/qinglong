import type {
  ModelInvocationAuditRecord,
  ModelInvocationAuditDisposition,
} from '../model-gateway/model';
import type {
  ModelInvocationCompletionCommand,
  ModelInvocationRepository,
} from './modelInvocation';

export interface ModelInvocationAtomicSuccessCommit<TReference> {
  readonly status: ModelInvocationAuditDisposition['status'];
  readonly reference: Readonly<TReference>;
}

/**
 * Domain-owned extension for one encrypted successful Model output.
 *
 * The generic Model coordinator owns the StepRun/usage/pricing protocol while
 * this extension owns the output identity, exact replay check and dialect
 * transaction that persists the encrypted output beside that protocol.
 */
export interface ModelInvocationAtomicSuccess<TReference> {
  readonly outputRef: string;
  assertAudit(record: Readonly<ModelInvocationAuditRecord>): void;
  find(
    repository: ModelInvocationRepository,
  ): Promise<Readonly<TReference> | null>;
  matches(reference: Readonly<TReference>): boolean;
  commit(
    repository: ModelInvocationRepository,
    command: Readonly<ModelInvocationCompletionCommand>,
  ): Promise<Readonly<ModelInvocationAtomicSuccessCommit<TReference>>>;
  conflict(): Error;
}

export function normalizeModelInvocationAtomicSuccess<TReference>(
  value: ModelInvocationAtomicSuccess<TReference>,
): ModelInvocationAtomicSuccess<TReference> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.outputRef !== 'string' ||
    value.outputRef.length < 1 ||
    value.outputRef.length > 512 ||
    typeof value.assertAudit !== 'function' ||
    typeof value.find !== 'function' ||
    typeof value.matches !== 'function' ||
    typeof value.commit !== 'function' ||
    typeof value.conflict !== 'function'
  ) {
    throw new TypeError('Model invocation atomic success is invalid');
  }
  return value;
}
