import type { RunEventRecord, RunRecord } from '@qinglong/runtime-core';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';
import type {
  PluginPackageAutomationPublication,
  PluginPackageAutomationPublicationTarget,
} from '@qinglong/runtime-core/plugin-package-automation-publication';
import type { StepRunMutation } from '@qinglong/runtime-core/step-run';

import type { GenerateRequest } from '../../model-gateway/model';
import type { PluginPackagePromptOutputArtifactRetentionPolicy } from '../../prompt-output/pluginPackagePromptOutputArtifact';

export const PLUGIN_PACKAGE_PROMPT_EXECUTION_PLAN_SCHEMA =
  'qinglong/plugin-package-prompt-execution-plan@v1' as const;
export const PLUGIN_PACKAGE_PROMPT_ADMISSION_RECEIPT_SCHEMA =
  'qinglong/plugin-package-prompt-admission-receipt@v1' as const;
export const PLUGIN_PACKAGE_PROMPT_FINALIZATION_RECEIPT_SCHEMA =
  'qinglong/plugin-package-prompt-finalization-receipt@v1' as const;
export const PLUGIN_PACKAGE_PROMPT_TERMINAL_EVIDENCE_KINDS = [
  'completion',
  'resolution',
] as const;
export const PLUGIN_PACKAGE_PROMPT_FINAL_RUN_STATUSES = [
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export const MAX_PLUGIN_PACKAGE_PROMPT_PARAMETER_VALUE_BYTES = 64 * 1024;
export const MAX_PLUGIN_PACKAGE_PROMPT_EXECUTION_PLAN_BYTES = 32 * 1024;
export const MAX_PLUGIN_PACKAGE_PROMPT_ADMISSION_RECEIPT_BYTES = 16 * 1024;
export const MAX_PLUGIN_PACKAGE_PROMPT_FINALIZATION_RECEIPT_BYTES = 16 * 1024;

export type PluginPackagePromptTerminalEvidenceKind =
  (typeof PLUGIN_PACKAGE_PROMPT_TERMINAL_EVIDENCE_KINDS)[number];
export type PluginPackagePromptFinalRunStatus =
  (typeof PLUGIN_PACKAGE_PROMPT_FINAL_RUN_STATUSES)[number];

export interface PluginPackagePromptExecutionPlanTarget
  extends PluginPackageAutomationPublicationTarget {
  readonly publicationDigest: string;
  readonly promptId: string;
  readonly promptDefinitionDigest: string;
}

export interface PluginPackagePromptExecutionPlan {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_EXECUTION_PLAN_SCHEMA;
  readonly requestId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly traceId: string;
  readonly requestedBySubject: Readonly<SecuritySubject>;
  readonly policyFence: Readonly<PluginPackagePromptExecutionPolicyFence>;
  readonly target: Readonly<PluginPackagePromptExecutionPlanTarget>;
  readonly provider: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly temperature: number | null;
  readonly parameterDigest: string;
  readonly modelRequestDigest: string;
  readonly inputBytes: number;
  /** Absent only on legacy alpha plans; absence has exact live-only semantics. */
  readonly output?: Readonly<PluginPackagePromptOutputIntent>;
  readonly deadlineAtMs: number;
  readonly plannedAtMs: number;
  readonly planDigest: string;
}

export type PluginPackagePromptOutputIntent =
  | Readonly<{ mode: 'live_only' }>
  | Readonly<{
      mode: 'durable_artifact';
      retentionPolicy: Readonly<PluginPackagePromptOutputArtifactRetentionPolicy>;
      retentionPolicyDigest: string;
    }>;

export type PreparePluginPackagePromptOutputIntent =
  | Readonly<{ mode: 'live_only' }>
  | Readonly<{
      mode: 'durable_artifact';
      retentionPolicy: Readonly<PluginPackagePromptOutputArtifactRetentionPolicy>;
    }>;

export interface PluginPackagePromptExecutionPolicyFence
  extends SecurityPolicyFence {
  readonly bindingVersion: number;
}

export interface PreparePluginPackagePromptExecutionInput {
  readonly publication: Readonly<PluginPackageAutomationPublication>;
  readonly expectedPublicationDigest: string;
  readonly promptId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly requestedBySubject: Readonly<SecuritySubject>;
  readonly policyFence: Readonly<PluginPackagePromptExecutionPolicyFence>;
  readonly parameters: Readonly<Record<string, string>>;
  readonly provider: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly deadlineAtMs: number;
  readonly plannedAtMs: number;
  /** Defaults to live_only and is always explicit in newly written plans. */
  readonly output?: Readonly<PreparePluginPackagePromptOutputIntent>;
  /** Transient transport cancellation. It is excluded from every digest. */
  readonly signal?: AbortSignal;
}

export interface PreparedPluginPackagePromptExecution {
  readonly plan: Readonly<PluginPackagePromptExecutionPlan>;
  /** Transient request content. It must never be copied into the admission receipt. */
  readonly request: Readonly<GenerateRequest>;
  /** Transient cancellation. It must never be copied into durable evidence. */
  readonly signal?: AbortSignal;
}

export interface PluginPackagePromptAdmissionReceipt {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_ADMISSION_RECEIPT_SCHEMA;
  readonly requestId: string;
  readonly invocationId: string;
  readonly planDigest: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly stepRunDigest: string;
  readonly mutationId: string;
  readonly eventId: string;
  readonly publicationDigest: string;
  readonly promptId: string;
  readonly finalRunVersion: 2;
  readonly finalRunEventSequence: 2;
  readonly admittedAtMs: number;
  readonly receiptDigest: string;
}

export interface PluginPackagePromptAdmissionBundle {
  readonly plan: Readonly<PluginPackagePromptExecutionPlan>;
  readonly run: Readonly<RunRecord>;
  readonly admissionEvent: Readonly<RunEventRecord>;
  readonly stepMutation: Readonly<StepRunMutation>;
  readonly receipt: Readonly<PluginPackagePromptAdmissionReceipt>;
}

export interface PluginPackagePromptFinalizationReceipt {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_FINALIZATION_RECEIPT_SCHEMA;
  readonly requestId: string;
  readonly invocationId: string;
  readonly planDigest: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly terminalEvidenceKind: PluginPackagePromptTerminalEvidenceKind;
  readonly terminalEvidenceDigest: string;
  readonly finalStepRunDigest: string;
  readonly runStatus: PluginPackagePromptFinalRunStatus;
  readonly eventId: string;
  readonly finalRunVersion: number;
  readonly finalRunEventSequence: number;
  readonly finalizedAtMs: number;
  readonly receiptDigest: string;
}

export interface PluginPackagePromptAdmissionRepository {
  findByRequestId(
    requestId: string,
  ): Promise<Readonly<PluginPackagePromptAdmissionReceipt> | null>;
  findByInvocationId(
    invocationId: string,
  ): Promise<Readonly<PluginPackagePromptAdmissionReceipt> | null>;
  findFinalizationByRequestId(
    requestId: string,
  ): Promise<Readonly<PluginPackagePromptFinalizationReceipt> | null>;
  admit(plan: Readonly<PluginPackagePromptExecutionPlan>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackagePromptAdmissionReceipt>;
    }>
  >;
  finalize(requestId: string): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackagePromptFinalizationReceipt>;
    }>
  >;
}

export class InvalidPluginPackagePromptExecutionPlanError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_EXECUTION_PLAN_INVALID';

  constructor(message: string) {
    super(`Plugin Package Prompt execution plan is invalid: ${message}`);
    this.name = 'InvalidPluginPackagePromptExecutionPlanError';
  }
}

export class PluginPackagePromptAdmissionConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_ADMISSION_CONFLICT';

  constructor(message = 'durable Prompt admission identity changed') {
    super(`Plugin Package Prompt admission conflicts: ${message}`);
    this.name = 'PluginPackagePromptAdmissionConflictError';
  }
}

export class PluginPackagePromptAdmissionNotAllowedError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_ADMISSION_NOT_ALLOWED';

  constructor() {
    super('The Plugin Package Prompt is not currently allowed to execute');
    this.name = 'PluginPackagePromptAdmissionNotAllowedError';
  }
}

export class PluginPackagePromptAdmissionUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_ADMISSION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super(
      'The Plugin Package Prompt admission repository is unavailable',
      options,
    );
    this.name = 'PluginPackagePromptAdmissionUnavailableError';
  }
}

export class PluginPackagePromptResolutionRequiredError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_RESOLUTION_REQUIRED';

  constructor() {
    super('The Plugin Package Prompt model outcome requires resolution');
    this.name = 'PluginPackagePromptResolutionRequiredError';
  }
}

export class PluginPackagePromptExecutionInProgressError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_EXECUTION_IN_PROGRESS';

  constructor() {
    super('The Plugin Package Prompt model invocation is still in progress');
    this.name = 'PluginPackagePromptExecutionInProgressError';
  }
}
