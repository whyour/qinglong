import type { RunRecord } from '@qinglong/runtime-core';
import type { SecurityPrincipal } from '@qinglong/runtime-core/security';
import type { StepRunMutation } from '@qinglong/runtime-core/step-run';
import type {
  ToolExecutionCompletionRecord,
  ToolExecutionResultArtifactReference,
} from '@qinglong/runtime-core/tool-execution-completion';
import type { ToolJsonValue } from '@qinglong/runtime-core/tool-registry';
import type { ToolExecutionFailureCompletionRecord } from '@qinglong/runtime-core/tool-execution-failure-completion';
import type { ToolPolicyAuthorizer } from '@qinglong/runtime-core/tool-registry';

import type {
  CopilotFailureDiagnosisAdmissionRepository,
  CopilotFailureDiagnosisExecutionPlan,
} from '../admission/contracts';

export const COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_RECEIPT_SCHEMA =
  'qinglong/copilot-failure-diagnosis-tool-unlock-receipt@v1' as const;
export const COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_COMMAND_SCHEMA =
  'qinglong/copilot-failure-diagnosis-tool-unlock-command@v1' as const;
export const MAX_COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_RECEIPT_BYTES =
  16 * 1024;
export const MAX_COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_COMMAND_BYTES =
  48 * 1024;

export interface CopilotFailureDiagnosisToolUnlockReceipt {
  readonly schema: typeof COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_RECEIPT_SCHEMA;
  readonly requestId: string;
  readonly planDigest: string;
  readonly runId: string;
  readonly startId: string;
  readonly barrierDigest: string;
  readonly toolStepRunId: string;
  readonly toolCompletionDigest: string;
  readonly resultArtifact: Readonly<ToolExecutionResultArtifactReference>;
  readonly modelStepRunId: string;
  readonly modelStepRunVersion: number;
  readonly modelStepRunDigest: string;
  readonly modelMutationId: string;
  readonly modelMutationDigest: string;
  readonly modelEventId: string;
  readonly finalRunVersion: number;
  readonly finalRunEventSequence: number;
  readonly unlockedAtMs: number;
  readonly receiptDigest: string;
}

export interface CopilotFailureDiagnosisToolUnlockCommand {
  readonly schema: typeof COPILOT_FAILURE_DIAGNOSIS_TOOL_UNLOCK_COMMAND_SCHEMA;
  readonly plan: Readonly<CopilotFailureDiagnosisExecutionPlan>;
  readonly completion: Readonly<ToolExecutionCompletionRecord>;
  readonly modelStepRunMutation: Readonly<StepRunMutation>;
  readonly receipt: Readonly<CopilotFailureDiagnosisToolUnlockReceipt>;
  readonly commandDigest: string;
}

export interface CopilotFailureDiagnosisToolUnlockRepository {
  findByRequestId(
    requestId: string,
  ): Promise<Readonly<CopilotFailureDiagnosisToolUnlockReceipt> | null>;
  commit(command: CopilotFailureDiagnosisToolUnlockCommand): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<CopilotFailureDiagnosisToolUnlockReceipt>;
    }>
  >;
}

export interface ExecuteCopilotFailureDiagnosisToolInput {
  readonly requestId: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly authorizer: ToolPolicyAuthorizer;
}

export type CopilotFailureDiagnosisToolExecutionResult =
  | Readonly<{
      outcome: 'succeeded';
      completionStatus: 'created' | 'existing';
      unlockStatus: 'created' | 'existing';
      completion: Readonly<ToolExecutionCompletionRecord>;
      output: ToolJsonValue;
      unlock: Readonly<CopilotFailureDiagnosisToolUnlockReceipt>;
    }>
  | Readonly<{
      outcome: 'failed' | 'timed_out';
      completionStatus: 'created' | 'existing';
      unlockStatus: null;
      completion: Readonly<ToolExecutionFailureCompletionRecord>;
    }>;

export class InvalidCopilotFailureDiagnosisToolExecutionError extends TypeError {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_TOOL_EXECUTION_INVALID';

  constructor(message: string) {
    super(`Copilot failure diagnosis Tool execution is invalid: ${message}`);
    this.name = 'InvalidCopilotFailureDiagnosisToolExecutionError';
  }
}

export class CopilotFailureDiagnosisToolExecutionConflictError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_TOOL_EXECUTION_CONFLICT';

  constructor(message = 'durable Tool execution facts changed') {
    super(`Copilot failure diagnosis Tool execution conflicts: ${message}`);
    this.name = 'CopilotFailureDiagnosisToolExecutionConflictError';
  }
}

export class CopilotFailureDiagnosisToolExecutionUnavailableError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_TOOL_EXECUTION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Copilot failure diagnosis Tool execution is unavailable', options);
    this.name = 'CopilotFailureDiagnosisToolExecutionUnavailableError';
  }
}

export class CopilotFailureDiagnosisToolExecutionDeadlineExceededError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_TOOL_EXECUTION_DEADLINE_EXCEEDED';

  constructor() {
    super('Copilot failure diagnosis Tool execution deadline was exceeded');
    this.name = 'CopilotFailureDiagnosisToolExecutionDeadlineExceededError';
  }
}

export type CopilotFailureDiagnosisToolExecutionAdmissionReader = Pick<
  CopilotFailureDiagnosisAdmissionRepository,
  'findByRequestId' | 'findPlanByRequestId'
>;

export type CopilotFailureDiagnosisRunAuthority = Pick<
  RunRecord,
  'id' | 'projectId' | 'status' | 'version' | 'eventSequence'
>;
