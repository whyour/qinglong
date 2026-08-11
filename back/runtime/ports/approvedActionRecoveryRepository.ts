import type {
  ApprovedActionRecoveryCursor,
  ApprovedActionRecoveryDecision,
  ApprovedActionRecoveryFinding,
  ApprovedActionRecoverySnapshot,
} from '../domain/approvedActionRecovery';
import type { PolicySubject } from '../domain/projectPolicy';
import type { ApprovedActionRecoveryAuthorizationFact } from '../domain/approvedActionRecoveryAuthorization';

export interface ListDueApprovedActionRecoveriesQuery {
  nowMs: number;
  limit: number;
  cursor?: ApprovedActionRecoveryCursor;
}

export interface ListDueApprovedActionRecoveriesResult {
  recoveries: readonly ApprovedActionRecoverySnapshot[];
  truncated: boolean;
  nextCursor?: Readonly<ApprovedActionRecoveryCursor>;
}

export interface ClaimApprovedActionRecoveryCommand {
  dispatchId: string;
  owner: string;
  leaseToken: string;
  nowMs: number;
  leaseDurationMs: number;
}

export type ClaimApprovedActionRecoveryResult =
  | {
      status: 'claimed';
      snapshot: Readonly<ApprovedActionRecoverySnapshot>;
    }
  | { status: 'not_found' }
  | {
      status:
        | 'not_due'
        | 'leased'
        | 'execution_active'
        | 'manual_required'
        | 'resolved';
      snapshot: Readonly<ApprovedActionRecoverySnapshot>;
    };

export interface RecordApprovedActionRecoveryFindingCommand {
  dispatchId: string;
  expectedExecutionVersion: number;
  expectedRecoveryVersion: number;
  owner: string;
  leaseToken: string;
  findingMutationId: string;
  finding: Exclude<
    ApprovedActionRecoveryFinding,
    'verified_succeeded' | 'verified_failed'
  >;
  resultCode: string;
  evidenceDigest?: string;
  observedAtMs: number;
  retryAtMs?: number;
}

export interface ResolveApprovedActionRecoveryAutomaticallyCommand {
  dispatchId: string;
  expectedExecutionVersion: number;
  expectedRecoveryVersion: number;
  owner: string;
  leaseToken: string;
  mutationId: string;
  source: 'automatic_evidence';
  decision: Exclude<ApprovedActionRecoveryDecision, 'abandon_unknown'>;
  evidenceDigest: string;
  reasonCode: string;
  resolvedAtMs: number;
}

export interface ResolveApprovedActionRecoveryManuallyCommand {
  dispatchId: string;
  expectedExecutionVersion: number;
  expectedRecoveryVersion: number;
  mutationId: string;
  source: 'human';
  decision: ApprovedActionRecoveryDecision;
  evidenceDigest?: string;
  reasonCode: string;
  resolvedBy: PolicySubject;
  resolvedAtMs: number;
  authorizationFact: ApprovedActionRecoveryAuthorizationFact;
}

export type ResolveApprovedActionRecoveryCommand =
  | ResolveApprovedActionRecoveryAutomaticallyCommand
  | ResolveApprovedActionRecoveryManuallyCommand;

export type ResolveApprovedActionRecoveryResult =
  | {
      status: 'resolved';
      snapshot: Readonly<ApprovedActionRecoverySnapshot>;
    }
  | {
      status: 'already_terminal';
      snapshot: Readonly<ApprovedActionRecoverySnapshot>;
    }
  | { status: 'not_found' };

export interface ApprovedActionRecoveryRepository {
  findById(
    dispatchId: string,
  ): Promise<Readonly<ApprovedActionRecoverySnapshot> | null>;

  listDue(
    query: ListDueApprovedActionRecoveriesQuery,
  ): Promise<ListDueApprovedActionRecoveriesResult>;

  claim(
    command: ClaimApprovedActionRecoveryCommand,
  ): Promise<ClaimApprovedActionRecoveryResult>;

  recordFinding(
    command: RecordApprovedActionRecoveryFindingCommand,
  ): Promise<Readonly<ApprovedActionRecoverySnapshot>>;

  resolve(
    command: ResolveApprovedActionRecoveryCommand,
  ): Promise<ResolveApprovedActionRecoveryResult>;
}
