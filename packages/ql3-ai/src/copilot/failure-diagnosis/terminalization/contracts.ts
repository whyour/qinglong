import type { RunRecord } from '@qinglong/runtime-core';
import type {
  StepRunMutation,
  StepRunRecord,
} from '@qinglong/runtime-core/step-run';

import type { CopilotFailureDiagnosisExecutionPlan } from '../admission/contracts';

export const COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_SCHEMA =
  'qinglong/copilot-failure-diagnosis-pre-model-terminalization@v1' as const;
export const COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_COMMAND_SCHEMA =
  'qinglong/copilot-failure-diagnosis-pre-model-terminalization-command@v1' as const;

export const COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_REASONS = [
  'tool_failed',
  'tool_timed_out',
  'log_not_found',
  'log_pending',
  'log_missing',
  'log_retired',
  'tool_budget_exhausted',
  'deadline_exceeded',
  'cancellation_requested',
] as const;

export type CopilotFailureDiagnosisPreModelTerminalizationReason =
  (typeof COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_REASONS)[number];

export type CopilotFailureDiagnosisPreModelTerminalizationStage =
  | 'tool'
  | 'log'
  | 'deadline'
  | 'cancellation';

export type CopilotFailureDiagnosisPreModelTerminalizationOutcome =
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export interface CopilotFailureDiagnosisTerminalStepReference {
  readonly stepRunId: string;
  readonly status: 'failed' | 'timed_out' | 'cancelled';
  readonly version: number;
  readonly mutationId: string;
  readonly mutationDigest: string;
  readonly eventId: string;
}

export interface CopilotFailureDiagnosisPreModelTerminalizationReceipt {
  readonly schema: typeof COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_SCHEMA;
  readonly requestId: string;
  readonly planDigest: string;
  readonly runId: string;
  readonly stage: CopilotFailureDiagnosisPreModelTerminalizationStage;
  readonly reason: CopilotFailureDiagnosisPreModelTerminalizationReason;
  readonly outcome: CopilotFailureDiagnosisPreModelTerminalizationOutcome;
  readonly evidenceDigest: string;
  readonly toolStartId: string | null;
  readonly toolCompletionDigest: string | null;
  readonly terminalSteps: readonly Readonly<CopilotFailureDiagnosisTerminalStepReference>[];
  readonly finalRunVersion: number;
  readonly finalRunEventSequence: number;
  readonly runEventId: string;
  readonly finalizedAtMs: number;
  readonly receiptDigest: string;
}

export interface CopilotFailureDiagnosisPreModelTerminalizationCommand {
  readonly schema: typeof COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_COMMAND_SCHEMA;
  readonly plan: Readonly<CopilotFailureDiagnosisExecutionPlan>;
  readonly expectedRunVersion: number;
  readonly expectedRunEventSequence: number;
  readonly stepMutations: readonly Readonly<StepRunMutation>[];
  readonly receipt: Readonly<CopilotFailureDiagnosisPreModelTerminalizationReceipt>;
  readonly commandDigest: string;
}

export interface CopilotFailureDiagnosisPreModelTerminalizationAuthority {
  readonly plan: Readonly<CopilotFailureDiagnosisExecutionPlan>;
  readonly run: Readonly<
    Pick<
      RunRecord,
      | 'id'
      | 'projectId'
      | 'status'
      | 'version'
      | 'eventSequence'
      | 'cancelRequestedAtMs'
      | 'cancelReason'
    >
  >;
  readonly toolStep: Readonly<StepRunRecord>;
  readonly modelStep: Readonly<StepRunRecord>;
  readonly modelStartExists: boolean;
  readonly observedAtMs: number;
}

export interface CopilotFailureDiagnosisPreModelTerminalizationRepository {
  findByRequestId(
    requestId: string,
  ): Promise<Readonly<CopilotFailureDiagnosisPreModelTerminalizationReceipt> | null>;
  readAuthority(
    requestId: string,
  ): Promise<Readonly<CopilotFailureDiagnosisPreModelTerminalizationAuthority>>;
  commit(
    command: Readonly<CopilotFailureDiagnosisPreModelTerminalizationCommand>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<CopilotFailureDiagnosisPreModelTerminalizationReceipt>;
    }>
  >;
}

export class InvalidCopilotFailureDiagnosisPreModelTerminalizationError extends TypeError {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_INVALID';

  constructor(message: string) {
    super(
      `Copilot failure diagnosis pre-Model terminalization is invalid: ${message}`,
    );
    this.name = 'InvalidCopilotFailureDiagnosisPreModelTerminalizationError';
  }
}

export class CopilotFailureDiagnosisPreModelTerminalizationConflictError extends Error {
  readonly code =
    'COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_CONFLICT';

  constructor(message = 'durable terminalization authority changed') {
    super(
      `Copilot failure diagnosis pre-Model terminalization conflicts: ${message}`,
    );
    this.name = 'CopilotFailureDiagnosisPreModelTerminalizationConflictError';
  }
}

export class CopilotFailureDiagnosisPreModelTerminalizationNotReadyError extends Error {
  readonly code =
    'COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_NOT_READY';

  constructor() {
    super('Copilot failure diagnosis has no terminal pre-Model condition');
    this.name = 'CopilotFailureDiagnosisPreModelTerminalizationNotReadyError';
  }
}

export class CopilotFailureDiagnosisPreModelTerminalizationUnavailableError extends Error {
  readonly code =
    'COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super(
      'Copilot failure diagnosis pre-Model terminalization is unavailable',
      options,
    );
    this.name =
      'CopilotFailureDiagnosisPreModelTerminalizationUnavailableError';
  }
}
