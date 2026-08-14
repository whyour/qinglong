import type { RunLogModelContextProjection } from '@qinglong/runtime-core/run-log-model-context-projection';

import type { GenerateRequest } from '../../model-gateway/model';

export const FAILURE_DIAGNOSIS_PROMPT_PROTOCOL =
  'qinglong/copilot-failure-diagnosis-prompt@v1' as const;
export const FAILURE_DIAGNOSIS_CONTEXT_SCHEMA =
  'qinglong/copilot-failure-diagnosis-context@v1' as const;
export const FAILURE_DIAGNOSIS_EGRESS_POLICY_SCHEMA =
  'qinglong/copilot-model-egress-policy@v1' as const;
export const FAILURE_DIAGNOSIS_EGRESS_EVIDENCE_SCHEMA =
  'qinglong/copilot-model-egress-evidence@v1' as const;

export const FAILURE_DIAGNOSIS_MODEL_BOUNDARIES = [
  'on_device',
  'external',
] as const;
export const FAILURE_DIAGNOSIS_RESPONSE_LANGUAGES = ['en', 'zh-CN'] as const;

export const MAX_FAILURE_DIAGNOSIS_INPUT_BYTES = 64 * 1024;
export const MAX_FAILURE_DIAGNOSIS_OUTPUT_TOKENS = 4_096;

export type FailureDiagnosisModelBoundary =
  (typeof FAILURE_DIAGNOSIS_MODEL_BOUNDARIES)[number];
export type FailureDiagnosisResponseLanguage =
  (typeof FAILURE_DIAGNOSIS_RESPONSE_LANGUAGES)[number];

export interface FailureDiagnosisModelEgressPolicy {
  readonly schema: typeof FAILURE_DIAGNOSIS_EGRESS_POLICY_SCHEMA;
  readonly revision: string;
  readonly potentiallySensitiveDataBoundaries: readonly FailureDiagnosisModelBoundary[];
  readonly maxInputBytes: number;
  readonly maxOutputTokens: number;
}

export interface PrepareFailureDiagnosisPromptPlan {
  readonly provider: string;
  readonly model: string;
  readonly modelBoundary: FailureDiagnosisModelBoundary;
  readonly profile: 'edge' | 'standalone' | 'cluster-control';
  readonly responseLanguage: FailureDiagnosisResponseLanguage;
  readonly projection: Readonly<RunLogModelContextProjection>;
  readonly maxOutputTokens: number;
  readonly egressPolicy: Readonly<FailureDiagnosisModelEgressPolicy>;
}

export interface FailureDiagnosisModelEgressEvidence {
  readonly schema: typeof FAILURE_DIAGNOSIS_EGRESS_EVIDENCE_SCHEMA;
  readonly policyRevision: string;
  readonly modelBoundary: FailureDiagnosisModelBoundary;
  readonly sourceClassification: 'untrusted_execution_output';
  readonly residualSensitivity: 'potentially_sensitive';
  readonly instructionPolicy: 'data_only_never_execute';
  readonly actionAuthority: 'none';
  readonly suspectedPromptInjection: boolean;
  readonly redactionContract: 'recognized_credentials_v1';
  readonly redactionReplacements: number;
  readonly inputBytes: number;
  readonly maxOutputTokens: number;
}

export interface FailureDiagnosisCompletionRequirements {
  readonly residualSensitivity: 'potentially_sensitive';
  readonly persistence: 'encrypted_only';
  readonly plaintextAudit: 'forbidden';
  readonly actionAuthority: 'none';
}

export interface FailureDiagnosisPromptPlan {
  readonly protocol: typeof FAILURE_DIAGNOSIS_PROMPT_PROTOCOL;
  readonly request: Readonly<GenerateRequest>;
  readonly egressEvidence: Readonly<FailureDiagnosisModelEgressEvidence>;
  readonly completionRequirements: Readonly<FailureDiagnosisCompletionRequirements>;
}

export class InvalidFailureDiagnosisPromptValueError extends TypeError {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_VALUE_INVALID';

  constructor(message: string) {
    super(`Failure diagnosis prompt value is invalid: ${message}`);
    this.name = 'InvalidFailureDiagnosisPromptValueError';
  }
}

export class FailureDiagnosisModelEgressDeniedError extends Error {
  readonly code = 'COPILOT_MODEL_EGRESS_DENIED';

  constructor() {
    super(
      'Potentially sensitive failure diagnosis data cannot cross this model boundary',
    );
    this.name = 'FailureDiagnosisModelEgressDeniedError';
  }
}

export class FailureDiagnosisPromptBudgetExceededError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_BUDGET_EXCEEDED';

  constructor() {
    super('The failure diagnosis prompt exceeded its bounded budget');
    this.name = 'FailureDiagnosisPromptBudgetExceededError';
  }
}
