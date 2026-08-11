import { v7 as uuidV7 } from 'uuid';
import type { ExecutionResult } from '../domain/execution';
import type { RunEventRecord, RunRecord } from '../domain/run';
import {
  assertRunDispatchId,
  assertRunDispatchLeaseToken,
  assertRunDispatchLeaseVersion,
  assertRunDispatchWorkerFence,
} from '../domain/runDispatchLease';
import type { RunDispatchLeaseRepository } from '../ports/runDispatchLeaseRepository';
import type {
  RunRepository,
  RunRepositoryTransaction,
} from '../ports/runRepository';
import {
  PrimaryRunCompletionService,
  type PrimaryRunCompletionResult,
} from './primaryRunCompletionService';
import type { AuthenticatedWorkerPrincipal } from './workerControlService';
import { WorkerPrincipalMismatchError } from './workerControlService';

class WorkerAttributedRunTransaction implements RunRepositoryTransaction {
  constructor(
    private readonly transaction: RunRepositoryTransaction,
    private readonly workerId: string,
  ) {}

  findRunById(runId: string) {
    return this.transaction.findRunById(runId);
  }

  findAttemptById(attemptId: string) {
    return this.transaction.findAttemptById(attemptId);
  }

  findLatestAttemptByRunId(runId: string) {
    return this.transaction.findLatestAttemptByRunId(runId);
  }

  findRetryPolicyByRunId(runId: string) {
    return this.transaction.findRetryPolicyByRunId(runId);
  }

  listEvents(
    runId: string,
    options?: { afterSequence?: number; limit?: number },
  ) {
    return this.transaction.listEvents(runId, options);
  }

  listCancellationRequested(options?: { beforeMs?: number; limit?: number }) {
    return this.transaction.listCancellationRequested(options);
  }

  insertRun(run: RunRecord) {
    return this.transaction.insertRun(run);
  }

  insertAttempt(
    attempt: Parameters<RunRepositoryTransaction['insertAttempt']>[0],
  ) {
    return this.transaction.insertAttempt(attempt);
  }

  insertRetryPolicy(
    _policy: Parameters<RunRepositoryTransaction['insertRetryPolicy']>[0],
  ): Promise<void> {
    throw new Error('Worker completion cannot create a Run retry policy');
  }

  compareAndSetRun(run: RunRecord, expectedVersion: number): Promise<boolean> {
    return this.transaction.compareAndSetRun(run, expectedVersion);
  }

  compareAndSetAttempt(
    attempt: Parameters<RunRepositoryTransaction['compareAndSetAttempt']>[0],
    expected: Parameters<RunRepositoryTransaction['compareAndSetAttempt']>[1],
  ): Promise<boolean> {
    return this.transaction.compareAndSetAttempt(attempt, expected);
  }

  compareAndSetRetryPolicy(
    _policy: Parameters<
      RunRepositoryTransaction['compareAndSetRetryPolicy']
    >[0],
    _expectedVersion: number,
  ): Promise<boolean> {
    throw new Error('Worker completion cannot modify a Run retry policy');
  }

  appendEvent(event: RunEventRecord): Promise<void> {
    return this.transaction.appendEvent({
      ...event,
      actorType: 'worker',
      actorId: this.workerId,
    });
  }
}

export interface RemoteRunCompletionCommand {
  runId: string;
  attemptId: string;
  callbackSequence: number;
  result: ExecutionResult;
  executorType: string;
  workerId: string;
  workerSessionId: string;
  workerGeneration: number;
  leaseGeneration: number;
  leaseToken: string;
  expectedLeaseVersion: number;
}

class LeaseFencedRunRepository implements RunRepository {
  constructor(
    private readonly reader: RunRepository,
    private readonly leases: RunDispatchLeaseRepository,
    private readonly command: RemoteRunCompletionCommand,
    private readonly completedAtMs: number,
  ) {}

  findRunById(runId: string) {
    return this.reader.findRunById(runId);
  }

  findAttemptById(attemptId: string) {
    return this.reader.findAttemptById(attemptId);
  }

  findLatestAttemptByRunId(runId: string) {
    return this.reader.findLatestAttemptByRunId(runId);
  }

  findRetryPolicyByRunId(runId: string) {
    return this.reader.findRetryPolicyByRunId(runId);
  }

  listEvents(
    runId: string,
    options?: { afterSequence?: number; limit?: number },
  ): Promise<RunEventRecord[]> {
    return this.reader.listEvents(runId, options);
  }

  listCancellationRequested(options?: {
    beforeMs?: number;
    limit?: number;
  }): Promise<RunRecord[]> {
    return this.reader.listCancellationRequested(options);
  }

  async transaction<T>(
    work: (transaction: RunRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    const result = await this.leases.completeWithLease(
      {
        runId: this.command.runId,
        attemptId: this.command.attemptId,
        workerId: this.command.workerId,
        workerSessionId: this.command.workerSessionId,
        workerGeneration: this.command.workerGeneration,
        leaseGeneration: this.command.leaseGeneration,
        leaseToken: this.command.leaseToken,
        expectedVersion: this.command.expectedLeaseVersion,
        completedAtMs: this.completedAtMs,
      },
      (transaction) =>
        work(
          new WorkerAttributedRunTransaction(
            transaction,
            this.command.workerId,
          ),
        ),
    );
    return result.value;
  }
}

export class RemoteRunCompletionService {
  private readonly clock: { now(): number };
  private readonly createEventId: () => string;

  constructor(
    private readonly runs: RunRepository,
    private readonly leases: RunDispatchLeaseRepository,
    options: { clock?: { now(): number }; createEventId?: () => string } = {},
  ) {
    this.clock = options.clock ?? Date;
    this.createEventId = options.createEventId ?? uuidV7;
  }

  complete(
    principal: AuthenticatedWorkerPrincipal,
    command: RemoteRunCompletionCommand,
  ): Promise<PrimaryRunCompletionResult> {
    this.assertCommand(principal, command);
    const completedAtMs = this.clock.now();
    assertRunDispatchLeaseVersion('completedAtMs', completedAtMs);
    if (completedAtMs < command.result.finishedAtMs) {
      throw new TypeError('Remote completion cannot be observed before finish');
    }
    const repository = new LeaseFencedRunRepository(
      this.runs,
      this.leases,
      command,
      completedAtMs,
    );
    return new PrimaryRunCompletionService(
      repository,
      this.createEventId,
    ).complete({
      runId: command.runId,
      attemptId: command.attemptId,
      callbackSequence: command.callbackSequence,
      result: command.result,
      source: {
        kind: 'executor',
        executorType: command.executorType,
      },
    });
  }

  private assertCommand(
    principal: AuthenticatedWorkerPrincipal,
    command: RemoteRunCompletionCommand,
  ): void {
    if (principal.workerId !== command.workerId) {
      throw new WorkerPrincipalMismatchError();
    }
    assertRunDispatchId('runId', command.runId);
    assertRunDispatchId('attemptId', command.attemptId);
    assertRunDispatchWorkerFence(command);
    assertRunDispatchLeaseToken(command.leaseToken);
    assertRunDispatchLeaseVersion(
      'leaseGeneration',
      command.leaseGeneration,
      true,
    );
    assertRunDispatchLeaseVersion(
      'expectedLeaseVersion',
      command.expectedLeaseVersion,
    );
  }
}
