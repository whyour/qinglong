import {
  assertLocalCompletionReceiptId,
  assertLocalCompletionReceiptJournalCursor,
  assertLocalCompletionReceiptJournalLimit,
  assertLocalCompletionReceiptTimestamp,
  type LocalCompletionReceiptJournal,
} from '@qinglong/runtime-core/local-completion-receipt-journal';
import {
  normalizeLocalExecutionContextRecipe,
  normalizeLocalTaskExecutionRevision,
  type LocalDispatchStore,
} from '@qinglong/runtime-core/local-dispatch';
import type { LocalExecutionControlSource } from '@qinglong/runtime-core/local-execution-control';
import type { LocalRunStartupRecoverySource } from '@qinglong/runtime-core/local-startup-recovery';
import {
  RunRepositoryBusyError,
  RunRepositoryConstraintError,
  RunRepositoryOperationError,
} from '@qinglong/runtime-core/run-repository';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import {
  LocalSqliteDispatchDefinitionConflictError,
  LocalSqliteDispatchDefinitionStore,
} from '../task-definition/dispatchDefinitionStore';
import { LocalSqliteCompletionReceiptJournalStore } from './completionReceiptJournalStore';
import { mapSqliteError } from './runPersistence';
import { LocalSqliteRunReader } from './runReader';

export interface LocalSqliteRunRuntimeCapabilities {
  readonly dispatch: LocalDispatchStore;
  readonly executionControl: LocalExecutionControlSource;
  readonly startupRecovery: LocalRunStartupRecoverySource;
  readonly completionReceipts: LocalCompletionReceiptJournal;
}

function assertQuarantineReference(value: string): void {
  if (
    value.length < 1 ||
    value.length > 255 ||
    !value.startsWith('.quarantine/') ||
    value.includes('..') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new RunRepositoryConstraintError(
      'Completion receipt quarantine reference is invalid',
    );
  }
}

function enqueueRunOperation<T>(
  authority: LocalSqliteOperationAuthority,
  work: () => Promise<T>,
): Promise<T> {
  return authority.enqueue(work, (reason) =>
    reason === 'busy'
      ? new RunRepositoryBusyError()
      : new RunRepositoryOperationError(
          new Error('Local SQLite Run repository is closed'),
        ),
  );
}

/**
 * Projects four least-authority runtime capabilities over one shared SQLite
 * operation authority. The returned objects intentionally have disjoint
 * method surfaces while retaining one connection, queue and close fence.
 */
export function createLocalSqliteRunRuntimeCapabilities(
  authority: LocalSqliteOperationAuthority,
): LocalSqliteRunRuntimeCapabilities {
  const reader = new LocalSqliteRunReader(authority.client);
  const dispatchDefinitions = new LocalSqliteDispatchDefinitionStore(
    authority.client,
  );
  const completionReceipts = new LocalSqliteCompletionReceiptJournalStore(
    authority.client,
  );
  const enqueue = <T>(work: () => Promise<T>) =>
    enqueueRunOperation(authority, work);

  const dispatch: LocalDispatchStore = Object.freeze({
    listLocalDispatchCandidates: (
      options: Parameters<LocalDispatchStore['listLocalDispatchCandidates']>[0],
    ) => enqueue(() => reader.listLocalDispatchCandidates(options)),
    resolveLocalTaskExecutionRevision: (
      identity: Parameters<
        LocalDispatchStore['resolveLocalTaskExecutionRevision']
      >[0],
    ) => enqueue(() => reader.resolveLocalTaskExecutionRevision(identity)),
    resolveLocalExecutionContextRecipe: (
      contextRef: Parameters<
        LocalDispatchStore['resolveLocalExecutionContextRecipe']
      >[0],
    ) => enqueue(() => reader.resolveLocalExecutionContextRecipe(contextRef)),
    appendLocalExecutionContextRecipe: (
      value: Parameters<
        LocalDispatchStore['appendLocalExecutionContextRecipe']
      >[0],
    ) => {
      const recipe = normalizeLocalExecutionContextRecipe(value);
      return enqueue(async () => {
        try {
          return dispatchDefinitions.appendRecipe(recipe);
        } catch (error) {
          if (error instanceof LocalSqliteDispatchDefinitionConflictError) {
            throw new RunRepositoryConstraintError(
              'Local dispatch definition identity already exists',
              error,
            );
          }
          throw mapSqliteError(error);
        }
      });
    },
    appendLocalTaskExecutionRevision: (
      value: Parameters<
        LocalDispatchStore['appendLocalTaskExecutionRevision']
      >[0],
    ) => {
      const revision = normalizeLocalTaskExecutionRevision(value);
      return enqueue(async () => {
        try {
          return dispatchDefinitions.appendRevision(revision);
        } catch (error) {
          if (error instanceof LocalSqliteDispatchDefinitionConflictError) {
            throw new RunRepositoryConstraintError(
              'Local dispatch definition identity already exists',
              error,
            );
          }
          throw mapSqliteError(error);
        }
      });
    },
  });

  const executionControl: LocalExecutionControlSource = Object.freeze({
    listLocalExecutionControlCandidates: (
      options: Parameters<
        LocalExecutionControlSource['listLocalExecutionControlCandidates']
      >[0],
    ) => enqueue(() => reader.listLocalExecutionControlCandidates(options)),
    listLocalActiveExecutions: (
      options: Parameters<
        LocalExecutionControlSource['listLocalActiveExecutions']
      >[0],
    ) => enqueue(() => reader.listLocalActiveExecutions(options)),
  });

  const startupRecovery: LocalRunStartupRecoverySource = Object.freeze({
    inspectCandidates: (
      options?: Parameters<
        LocalRunStartupRecoverySource['inspectCandidates']
      >[0],
    ) => enqueue(() => reader.inspectStartupRecoveryCandidates(options)),
  });

  const completionReceiptJournal: LocalCompletionReceiptJournal = Object.freeze(
    {
      register: (
        command: Parameters<LocalCompletionReceiptJournal['register']>[0],
      ) => {
        assertLocalCompletionReceiptId(command.attemptId, 'attemptId');
        assertLocalCompletionReceiptId(command.runId, 'runId');
        assertLocalCompletionReceiptTimestamp(
          command.registeredAtMs,
          'registeredAtMs',
        );
        return enqueue(async () => {
          try {
            completionReceipts.register(command);
          } catch (error) {
            throw mapSqliteError(error);
          }
        });
      },
      markQuarantined: (
        command: Parameters<
          LocalCompletionReceiptJournal['markQuarantined']
        >[0],
      ) => {
        assertLocalCompletionReceiptId(command.attemptId, 'attemptId');
        assertQuarantineReference(command.quarantineRef);
        assertLocalCompletionReceiptTimestamp(
          command.updatedAtMs,
          'updatedAtMs',
        );
        assertLocalCompletionReceiptTimestamp(
          command.purgeAfterMs,
          'purgeAfterMs',
        );
        if (command.purgeAfterMs < command.updatedAtMs) {
          return Promise.reject(
            new RunRepositoryConstraintError(
              'Completion receipt purge time precedes quarantine time',
            ),
          );
        }
        return enqueue(async () => {
          try {
            completionReceipts.markQuarantined(command);
          } catch (error) {
            throw mapSqliteError(error);
          }
        });
      },
      resolve: (
        attemptId: Parameters<LocalCompletionReceiptJournal['resolve']>[0],
      ) => {
        assertLocalCompletionReceiptId(attemptId, 'attemptId');
        return enqueue(async () => {
          try {
            return completionReceipts.resolve(attemptId);
          } catch (error) {
            throw mapSqliteError(error);
          }
        });
      },
      listCandidates: (
        options: Parameters<LocalCompletionReceiptJournal['listCandidates']>[0],
      ) => {
        assertLocalCompletionReceiptTimestamp(
          options.observedAtMs,
          'observedAtMs',
        );
        const limit = options.limit ?? 32;
        assertLocalCompletionReceiptJournalLimit(limit);
        if (options.cursor) {
          assertLocalCompletionReceiptJournalCursor(options.cursor);
        }
        return enqueue(async () => {
          try {
            return completionReceipts.listCandidates({
              ...options,
              limit,
            });
          } catch (error) {
            throw mapSqliteError(error);
          }
        });
      },
    },
  );

  return Object.freeze({
    dispatch,
    executionControl,
    startupRecovery,
    completionReceipts: completionReceiptJournal,
  });
}
