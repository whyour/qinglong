import type { RunEventRecord, RunRecord } from '@qinglong/runtime-core';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';
import type { StepRunMutation } from '@qinglong/runtime-core/step-run';
import type {
  ToolInvocationInputArtifactReference,
  ToolInvocationPreviewArtifactReference,
} from '@qinglong/runtime-core/tool-invocation-artifact';
import type {
  TrustedToolHandlerBindingRegistry,
  TrustedToolInvocationPlan,
} from '@qinglong/runtime-core/trusted-tool-invocation';

import type {
  FailureDiagnosisModelBoundary,
  FailureDiagnosisModelEgressPolicy,
  FailureDiagnosisResponseLanguage,
} from '../contracts';

export const COPILOT_FAILURE_DIAGNOSIS_EXECUTION_PLAN_SCHEMA =
  'qinglong/copilot-failure-diagnosis-execution-plan@v1' as const;
export const COPILOT_FAILURE_DIAGNOSIS_ADMISSION_RECEIPT_SCHEMA =
  'qinglong/copilot-failure-diagnosis-admission-receipt@v1' as const;
export const COPILOT_FAILURE_DIAGNOSIS_SOURCE_RUN_STATUSES = [
  'failed',
  'timed_out',
] as const;
export const COPILOT_FAILURE_DIAGNOSIS_SOURCE_ATTEMPT_STATUSES = [
  'failed',
  'timed_out',
  'lost',
] as const;
export const MAX_COPILOT_FAILURE_DIAGNOSIS_EXECUTION_PLAN_BYTES = 32 * 1024;
export const MAX_COPILOT_FAILURE_DIAGNOSIS_ADMISSION_RECEIPT_BYTES = 16 * 1024;

export type CopilotFailureDiagnosisSourceRunStatus =
  (typeof COPILOT_FAILURE_DIAGNOSIS_SOURCE_RUN_STATUSES)[number];
export type CopilotFailureDiagnosisSourceAttemptStatus =
  (typeof COPILOT_FAILURE_DIAGNOSIS_SOURCE_ATTEMPT_STATUSES)[number];

export interface CopilotFailureDiagnosisSourceFence {
  readonly runId: string;
  readonly runVersion: number;
  readonly runStatus: CopilotFailureDiagnosisSourceRunStatus;
  readonly attemptId: string;
  readonly attemptStatus: CopilotFailureDiagnosisSourceAttemptStatus;
  readonly attemptFinishedAtMs: number;
  readonly logArtifactId: string;
}

export interface PrepareCopilotFailureDiagnosisModelIntent {
  readonly provider: string;
  readonly model: string;
  readonly modelBoundary: FailureDiagnosisModelBoundary;
  readonly responseLanguage: FailureDiagnosisResponseLanguage;
  readonly maxOutputTokens: number;
  readonly egressPolicy: Readonly<FailureDiagnosisModelEgressPolicy>;
}

export interface CopilotFailureDiagnosisModelIntent
  extends PrepareCopilotFailureDiagnosisModelIntent {
  readonly egressPolicyDigest: string;
  readonly intentDigest: string;
}

export interface CopilotFailureDiagnosisToolIntent {
  readonly actionRef: string;
  readonly planDigest: string;
  readonly actionDigest: string;
  readonly invocationActionDigest: string;
  readonly snapshotDigest: string;
  readonly definitionDigest: string;
  readonly bindingDigest: string;
  readonly invocationArtifact: Readonly<ToolInvocationInputArtifactReference>;
  readonly previewArtifact: Readonly<ToolInvocationPreviewArtifactReference>;
  readonly sealedAtMs: number;
}

export interface PrepareCopilotFailureDiagnosisExecutionInput {
  readonly requestId: string;
  readonly traceId: string;
  readonly source: Readonly<CopilotFailureDiagnosisSourceFence>;
  readonly toolPlan: Readonly<TrustedToolInvocationPlan>;
  readonly bindings: TrustedToolHandlerBindingRegistry;
  readonly model: Readonly<PrepareCopilotFailureDiagnosisModelIntent>;
  readonly deadlineAtMs: number;
  readonly plannedAtMs: number;
}

export interface CopilotFailureDiagnosisExecutionPlan {
  readonly schema: typeof COPILOT_FAILURE_DIAGNOSIS_EXECUTION_PLAN_SCHEMA;
  readonly requestId: string;
  readonly runId: string;
  readonly toolStepRunId: string;
  readonly modelStepRunId: string;
  readonly modelInvocationId: string;
  readonly traceId: string;
  readonly projectId: string;
  readonly requestedBySubject: Readonly<SecuritySubject>;
  readonly policyFence: Readonly<SecurityPolicyFence>;
  readonly source: Readonly<CopilotFailureDiagnosisSourceFence>;
  readonly tool: Readonly<CopilotFailureDiagnosisToolIntent>;
  readonly model: Readonly<CopilotFailureDiagnosisModelIntent>;
  readonly deadlineAtMs: number;
  readonly plannedAtMs: number;
  readonly planDigest: string;
}

export interface CopilotFailureDiagnosisAdmissionReceipt {
  readonly schema: typeof COPILOT_FAILURE_DIAGNOSIS_ADMISSION_RECEIPT_SCHEMA;
  readonly requestId: string;
  readonly planDigest: string;
  readonly runId: string;
  readonly sourceRunId: string;
  readonly sourceRunVersion: number;
  readonly sourceAttemptId: string;
  readonly toolStepRunId: string;
  readonly toolStepRunDigest: string;
  readonly toolMutationId: string;
  readonly toolEventId: string;
  readonly modelStepRunId: string;
  readonly modelStepRunDigest: string;
  readonly modelMutationId: string;
  readonly modelEventId: string;
  readonly finalRunVersion: 3;
  readonly finalRunEventSequence: 3;
  readonly admittedAtMs: number;
  readonly receiptDigest: string;
}

export interface CopilotFailureDiagnosisAdmissionBundle {
  readonly plan: Readonly<CopilotFailureDiagnosisExecutionPlan>;
  readonly run: Readonly<RunRecord>;
  readonly admissionEvent: Readonly<RunEventRecord>;
  readonly toolStepMutation: Readonly<StepRunMutation>;
  readonly modelStepMutation: Readonly<StepRunMutation>;
  readonly receipt: Readonly<CopilotFailureDiagnosisAdmissionReceipt>;
}

export interface CopilotFailureDiagnosisAdmissionRepository {
  findByRequestId(
    requestId: string,
  ): Promise<Readonly<CopilotFailureDiagnosisAdmissionReceipt> | null>;
  findPlanByRequestId(
    requestId: string,
  ): Promise<Readonly<CopilotFailureDiagnosisExecutionPlan> | null>;
  admit(plan: Readonly<CopilotFailureDiagnosisExecutionPlan>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<CopilotFailureDiagnosisAdmissionReceipt>;
    }>
  >;
}

export class InvalidCopilotFailureDiagnosisExecutionPlanError extends TypeError {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_EXECUTION_PLAN_INVALID';

  constructor(message: string) {
    super(`Copilot failure diagnosis execution plan is invalid: ${message}`);
    this.name = 'InvalidCopilotFailureDiagnosisExecutionPlanError';
  }
}

export class CopilotFailureDiagnosisAdmissionConflictError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_ADMISSION_CONFLICT';

  constructor(message = 'durable diagnosis admission identity changed') {
    super(`Copilot failure diagnosis admission conflicts: ${message}`);
    this.name = 'CopilotFailureDiagnosisAdmissionConflictError';
  }
}

export class CopilotFailureDiagnosisAdmissionNotAllowedError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_ADMISSION_NOT_ALLOWED';

  constructor() {
    super('The source Run is not eligible for failure diagnosis');
    this.name = 'CopilotFailureDiagnosisAdmissionNotAllowedError';
  }
}

export class CopilotFailureDiagnosisAdmissionUnavailableError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_ADMISSION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Copilot failure diagnosis admission is unavailable', options);
    this.name = 'CopilotFailureDiagnosisAdmissionUnavailableError';
  }
}
