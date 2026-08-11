import type {
  ApprovedActionDispatchCursor,
  ApprovedActionDispatchExecutionSnapshot,
} from '../domain/approvedActionDispatchExecution';

export interface ListDueApprovedActionDispatchesQuery {
  nowMs: number;
  limit: number;
  cursor?: ApprovedActionDispatchCursor;
}

export interface ListDueApprovedActionDispatchesResult {
  dispatches: readonly ApprovedActionDispatchExecutionSnapshot[];
  truncated: boolean;
  nextCursor?: Readonly<ApprovedActionDispatchCursor>;
}

export interface ClaimApprovedActionDispatchCommand {
  dispatchId: string;
  owner: string;
  leaseToken: string;
  nowMs: number;
  leaseDurationMs: number;
}

export type ClaimApprovedActionDispatchResult =
  | {
      status: 'claimed';
      snapshot: Readonly<ApprovedActionDispatchExecutionSnapshot>;
    }
  | { status: 'not_found' }
  | {
      status:
        | 'not_due'
        | 'leased'
        | 'executing'
        | 'recovery_required'
        | 'succeeded'
        | 'failed'
        | 'blocked';
      snapshot: Readonly<ApprovedActionDispatchExecutionSnapshot>;
    };

export interface StartApprovedActionDispatchCommand {
  dispatchId: string;
  approvalRequestId: string;
  actionDigest: string;
  owner: string;
  leaseToken: string;
  expectedVersion: number;
  startedAtMs: number;
}

export interface RenewApprovedActionDispatchLeaseCommand {
  dispatchId: string;
  owner: string;
  leaseToken: string;
  expectedVersion: number;
  nowMs: number;
  leaseDurationMs: number;
}

export interface ReleaseApprovedActionDispatchBeforeStartCommand {
  dispatchId: string;
  owner: string;
  leaseToken: string;
  expectedVersion: number;
  resultMutationId: string;
  resultCode: string;
  atMs: number;
  retryAtMs?: number;
}

export interface CompleteApprovedActionDispatchCommand {
  dispatchId: string;
  owner: string;
  leaseToken: string;
  expectedVersion: number;
  resultMutationId: string;
  outcome: 'succeeded' | 'failed' | 'indeterminate';
  resultCode: string;
  completedAtMs: number;
}

export interface ApprovedActionDispatchRepository {
  findById(
    dispatchId: string,
  ): Promise<Readonly<ApprovedActionDispatchExecutionSnapshot> | null>;

  listDue(
    query: ListDueApprovedActionDispatchesQuery,
  ): Promise<ListDueApprovedActionDispatchesResult>;

  claim(
    command: ClaimApprovedActionDispatchCommand,
  ): Promise<ClaimApprovedActionDispatchResult>;

  start(
    command: StartApprovedActionDispatchCommand,
  ): Promise<Readonly<ApprovedActionDispatchExecutionSnapshot>>;

  renew(
    command: RenewApprovedActionDispatchLeaseCommand,
  ): Promise<Readonly<ApprovedActionDispatchExecutionSnapshot>>;

  releaseBeforeStart(
    command: ReleaseApprovedActionDispatchBeforeStartCommand,
  ): Promise<Readonly<ApprovedActionDispatchExecutionSnapshot>>;

  complete(
    command: CompleteApprovedActionDispatchCommand,
  ): Promise<Readonly<ApprovedActionDispatchExecutionSnapshot>>;
}
