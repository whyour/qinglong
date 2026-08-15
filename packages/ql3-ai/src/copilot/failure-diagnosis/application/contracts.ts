import type { SecurityPrincipal } from '@qinglong/runtime-core/security';

import type { CopilotFailureDiagnosisAdmissionReceipt } from '../admission/contracts';
import type { CopilotFailureDiagnosisModelExecutionResult } from '../model-execution/coordinator';
import type { CopilotFailureDiagnosisToolExecutionResult } from '../tool-execution/contracts';

export const MAX_ACTIVE_COPILOT_FAILURE_DIAGNOSIS_APPLICATION_REQUESTS = 64;

export interface ExecuteCopilotFailureDiagnosisApplicationCommand {
  readonly requestId: string;
  readonly traceId: string;
  readonly projectId: string;
  readonly sourceRunId: string;
  readonly principal: Readonly<SecurityPrincipal>;
}

export interface ExecuteCopilotFailureDiagnosisApplicationResult {
  readonly admissionStatus: 'created' | 'existing';
  readonly admission: Readonly<CopilotFailureDiagnosisAdmissionReceipt>;
  readonly tool: Readonly<CopilotFailureDiagnosisToolExecutionResult>;
  readonly model: Readonly<CopilotFailureDiagnosisModelExecutionResult> | null;
  readonly terminalizationRequired: boolean;
}

export class InvalidCopilotFailureDiagnosisApplicationError extends TypeError {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_APPLICATION_INVALID';

  constructor(message: string) {
    super(`Copilot failure diagnosis application is invalid: ${message}`);
    this.name = 'InvalidCopilotFailureDiagnosisApplicationError';
  }
}

export class CopilotFailureDiagnosisApplicationConflictError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_APPLICATION_CONFLICT';

  constructor(message = 'the durable diagnosis request changed') {
    super(`Copilot failure diagnosis application conflicts: ${message}`);
    this.name = 'CopilotFailureDiagnosisApplicationConflictError';
  }
}

export class CopilotFailureDiagnosisApplicationUnavailableError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_APPLICATION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Copilot failure diagnosis application is unavailable', options);
    this.name = 'CopilotFailureDiagnosisApplicationUnavailableError';
  }
}

export class CopilotFailureDiagnosisApplicationBusyError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_APPLICATION_BUSY';

  constructor() {
    super('Copilot failure diagnosis application request budget is exhausted');
    this.name = 'CopilotFailureDiagnosisApplicationBusyError';
  }
}
