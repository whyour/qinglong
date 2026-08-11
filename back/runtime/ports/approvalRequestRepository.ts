import type {
  ApprovalActionBinding,
  ApprovalDecision,
  ApprovalRequestRecord,
  ApprovedActionDispatchRecord,
  ApprovalRisk,
} from '../domain/approvalRequest';
import type {
  PolicySubject,
  ProjectPolicyFence,
} from '../domain/projectPolicy';

export interface CreateApprovalRequestCommand {
  request: ApprovalRequestRecord;
  authorizationFence: ProjectPolicyFence;
}

export interface CreateApprovalRequestResult {
  status: 'created' | 'existing';
  request: Readonly<ApprovalRequestRecord>;
}

export interface DecideApprovalRequestCommand {
  requestId: string;
  expectedVersion: number;
  decisionId: string;
  decision: ApprovalDecision;
  reasonCode: string;
  decidedBy: PolicySubject;
  decidedAtMs: number;
  authorizationFence: ProjectPolicyFence;
}

export interface DecideApprovalRequestResult {
  status: 'decided' | 'existing';
  request: Readonly<ApprovalRequestRecord>;
}

export interface ConsumeApprovalRequestCommand {
  requestId: string;
  expectedVersion: number;
  consumptionId: string;
  dispatchId: string;
  action: ApprovalActionBinding;
  requestedBy: PolicySubject;
  consumedBy: PolicySubject;
  consumedAtMs: number;
  authorizationFence: ProjectPolicyFence;
}

export interface ConsumeApprovalRequestResult {
  status: 'consumed' | 'existing';
  request: Readonly<ApprovalRequestRecord>;
  dispatch: Readonly<ApprovedActionDispatchRecord>;
}

export interface ListPendingApprovalRequestsQuery {
  projectId: string;
  nowMs: number;
  limit: number;
  afterExpiresAtMs?: number;
  afterId?: string;
  risks?: readonly ApprovalRisk[];
}

export interface ApprovalRequestRepository {
  findById(id: string): Promise<Readonly<ApprovalRequestRecord> | null>;

  create(
    command: CreateApprovalRequestCommand,
  ): Promise<CreateApprovalRequestResult>;

  decide(
    command: DecideApprovalRequestCommand,
  ): Promise<DecideApprovalRequestResult>;

  consume(
    command: ConsumeApprovalRequestCommand,
  ): Promise<ConsumeApprovalRequestResult>;
}
