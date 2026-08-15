import {
  normalizeSecurityPrincipal,
  type SecurityPolicyDecision,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import type { ProjectPermission } from '@qinglong/runtime-core/project-policy';

import type { ModelInvocationPriceSettlement } from '../../../pricing/pricing';
import type { ModelInvocationUsageLedgerRecord } from '../../../usage/usageLedger';
import type { GenerateResult } from '../../../model-gateway/model';
import type {
  CopilotFailureDiagnosisAdmissionRepository,
  CopilotFailureDiagnosisAdmissionReceipt,
  CopilotFailureDiagnosisExecutionPlan,
} from '../admission/contracts';
import type {
  CopilotFailureDiagnosisFinalizationReceipt,
  CopilotFailureDiagnosisFinalizationRepository,
} from '../model-execution/finalization';
import {
  openCopilotFailureDiagnosisOutputArtifact,
  type CopilotFailureDiagnosisOutputArtifact,
  type CopilotFailureDiagnosisOutputKeyProvider,
} from '../model-execution/outputArtifact';
import type { CopilotFailureDiagnosisOutputCompletionRepository } from '../model-execution/completion';
import type {
  CopilotFailureDiagnosisPreModelTerminalizationReceipt,
  CopilotFailureDiagnosisPreModelTerminalizationRepository,
} from '../terminalization/contracts';

export const COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESULT_SCHEMA =
  'qinglong/copilot-failure-diagnosis-inspection-result@v1' as const;
export const COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESULT_SCHEMA =
  'qinglong/copilot-failure-diagnosis-output-read-result@v1' as const;

export interface CopilotFailureDiagnosisReadTarget {
  readonly principal: Readonly<SecurityPrincipal>;
  readonly projectId: string;
  readonly sourceRunId: string;
  readonly requestId: string;
}

export interface CopilotFailureDiagnosisReadAuthorizer {
  authorize(
    principal: Readonly<SecurityPrincipal>,
    projectId: string,
    permission: ProjectPermission,
  ): Promise<Readonly<SecurityPolicyDecision>>;
}

export interface CopilotFailureDiagnosisReadModelRepository
  extends Pick<
    CopilotFailureDiagnosisOutputCompletionRepository,
    'findCopilotFailureDiagnosisOutput'
  > {
  findUsage(
    invocationId: string,
  ): Promise<Readonly<ModelInvocationUsageLedgerRecord> | null>;
  findPriceSettlement(
    invocationId: string,
  ): Promise<Readonly<ModelInvocationPriceSettlement> | null>;
}

export interface CopilotFailureDiagnosisUsageView {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly currency: 'USD' | null;
  readonly costMicros: number | null;
}

export type CopilotFailureDiagnosisInspectionResult = Readonly<
  | {
      schema: typeof COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESULT_SCHEMA;
      status: 'not_found';
      projectId: string;
      sourceRunId: string;
      requestId: string;
    }
  | {
      schema: typeof COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESULT_SCHEMA;
      status: 'running' | 'terminal';
      projectId: string;
      sourceRunId: string;
      requestId: string;
      diagnosisRunId: string;
      outcome: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | null;
      stage: 'model' | 'tool' | 'log' | 'deadline' | 'cancellation' | null;
      reason: string | null;
      outputAvailable: boolean;
      admittedAtMs: number;
      finalizedAtMs: number | null;
      usage: Readonly<CopilotFailureDiagnosisUsageView> | null;
    }
>;

export type CopilotFailureDiagnosisOutputReadResult = Readonly<
  | {
      schema: typeof COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESULT_SCHEMA;
      status: 'not_found';
      projectId: string;
      sourceRunId: string;
      requestId: string;
    }
  | {
      schema: typeof COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESULT_SCHEMA;
      status: 'available';
      projectId: string;
      sourceRunId: string;
      requestId: string;
      diagnosisRunId: string;
      reference: Readonly<{
        artifactId: string;
        artifactDigest: string;
        contentDigest: string;
        outputBytes: number;
        sealedAtMs: number;
      }>;
      result: Readonly<Pick<GenerateResult, 'text' | 'finishReason' | 'usage'>>;
    }
>;

export class InvalidCopilotFailureDiagnosisReadRequestError extends TypeError {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_READ_INVALID';

  constructor() {
    super('Copilot failure diagnosis read request is invalid');
    this.name = 'InvalidCopilotFailureDiagnosisReadRequestError';
  }
}

export class CopilotFailureDiagnosisReadUnavailableError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_READ_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Copilot failure diagnosis read is unavailable', options);
    this.name = 'CopilotFailureDiagnosisReadUnavailableError';
  }
}

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const OUTCOMES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);
const STAGES = new Set(['tool', 'log', 'deadline', 'cancellation']);
const REASONS = new Set([
  'tool_failed',
  'tool_timed_out',
  'log_not_found',
  'log_pending',
  'log_missing',
  'log_retired',
  'tool_budget_exhausted',
  'deadline_exceeded',
  'cancellation_requested',
]);

function unavailable(
  cause?: unknown,
): CopilotFailureDiagnosisReadUnavailableError {
  return new CopilotFailureDiagnosisReadUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function normalizeTarget(
  value: CopilotFailureDiagnosisReadTarget,
  nowMs: number,
): Readonly<CopilotFailureDiagnosisReadTarget> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['principal', 'projectId', 'requestId', 'sourceRunId']) ||
    typeof value.projectId !== 'string' ||
    !IDENTITY.test(value.projectId) ||
    typeof value.sourceRunId !== 'string' ||
    !RUN_ID.test(value.sourceRunId) ||
    typeof value.requestId !== 'string' ||
    !IDENTITY.test(value.requestId)
  ) {
    throw new InvalidCopilotFailureDiagnosisReadRequestError();
  }
  try {
    return Object.freeze({
      principal: normalizeSecurityPrincipal(value.principal, nowMs),
      projectId: value.projectId,
      sourceRunId: value.sourceRunId,
      requestId: value.requestId,
    });
  } catch {
    throw new InvalidCopilotFailureDiagnosisReadRequestError();
  }
}

function inspectionNotFound(
  target: Omit<CopilotFailureDiagnosisReadTarget, 'principal'>,
): CopilotFailureDiagnosisInspectionResult {
  return Object.freeze({
    schema: COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESULT_SCHEMA,
    status: 'not_found' as const,
    ...target,
  });
}

function outputNotFound(
  target: Omit<CopilotFailureDiagnosisReadTarget, 'principal'>,
): CopilotFailureDiagnosisOutputReadResult {
  return Object.freeze({
    schema: COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESULT_SCHEMA,
    status: 'not_found' as const,
    ...target,
  });
}

function targetView(
  command: Readonly<CopilotFailureDiagnosisReadTarget>,
): Readonly<Omit<CopilotFailureDiagnosisReadTarget, 'principal'>> {
  return Object.freeze({
    projectId: command.projectId,
    sourceRunId: command.sourceRunId,
    requestId: command.requestId,
  });
}

function planMatchesTarget(
  plan: Readonly<CopilotFailureDiagnosisExecutionPlan>,
  command: Readonly<CopilotFailureDiagnosisReadTarget>,
): boolean {
  return (
    plan.requestId === command.requestId &&
    plan.projectId === command.projectId &&
    plan.source?.runId === command.sourceRunId
  );
}

function validPlan(
  plan: Readonly<CopilotFailureDiagnosisExecutionPlan>,
): boolean {
  return (
    !!plan &&
    typeof plan === 'object' &&
    IDENTITY.test(plan.requestId) &&
    IDENTITY.test(plan.projectId) &&
    RUN_ID.test(plan.runId) &&
    RUN_ID.test(plan.source?.runId) &&
    IDENTITY.test(plan.modelStepRunId) &&
    IDENTITY.test(plan.modelInvocationId) &&
    DIGEST.test(plan.planDigest) &&
    safeInteger(plan.plannedAtMs)
  );
}

function validTerminalization(
  value: Readonly<CopilotFailureDiagnosisPreModelTerminalizationReceipt>,
  plan: Readonly<CopilotFailureDiagnosisExecutionPlan>,
): boolean {
  return (
    !!value &&
    value.requestId === plan.requestId &&
    value.planDigest === plan.planDigest &&
    value.runId === plan.runId &&
    STAGES.has(value.stage) &&
    REASONS.has(value.reason) &&
    OUTCOMES.has(value.outcome) &&
    safeInteger(value.finalizedAtMs)
  );
}

function validFinalization(
  value: Readonly<CopilotFailureDiagnosisFinalizationReceipt>,
  plan: Readonly<CopilotFailureDiagnosisExecutionPlan>,
): boolean {
  return (
    !!value &&
    value.requestId === plan.requestId &&
    value.planDigest === plan.planDigest &&
    value.runId === plan.runId &&
    value.modelStepRunId === plan.modelStepRunId &&
    value.invocationId === plan.modelInvocationId &&
    DIGEST.test(value.completionDigest) &&
    OUTCOMES.has(value.outcome) &&
    (value.outputArtifactId === null ||
      IDENTITY.test(value.outputArtifactId)) &&
    (value.outcome === 'succeeded') === (value.outputArtifactId !== null) &&
    safeInteger(value.finalizedAtMs)
  );
}

function validUsage(
  usage: Readonly<ModelInvocationUsageLedgerRecord>,
  plan: Readonly<CopilotFailureDiagnosisExecutionPlan>,
  finalization: Readonly<CopilotFailureDiagnosisFinalizationReceipt>,
): boolean {
  return (
    usage.invocationId === plan.modelInvocationId &&
    usage.projectId === plan.projectId &&
    usage.runId === plan.runId &&
    usage.stepRunId === plan.modelStepRunId &&
    usage.traceId === plan.traceId &&
    usage.completionDigest === finalization.completionDigest &&
    usage.outcome === finalization.outcome &&
    safeInteger(usage.inputTokens) &&
    safeInteger(usage.outputTokens) &&
    safeInteger(usage.totalTokens) &&
    usage.totalTokens === usage.inputTokens + usage.outputTokens &&
    (usage.costMicros === null || safeInteger(usage.costMicros))
  );
}

function settlementMatches(
  settlement: Readonly<ModelInvocationPriceSettlement>,
  usage: Readonly<ModelInvocationUsageLedgerRecord>,
  finalization: Readonly<CopilotFailureDiagnosisFinalizationReceipt>,
): boolean {
  return (
    settlement.invocationId === usage.invocationId &&
    settlement.projectId === usage.projectId &&
    settlement.completionDigest === finalization.completionDigest &&
    settlement.currency === 'USD' &&
    settlement.inputTokens === usage.inputTokens &&
    settlement.outputTokens === usage.outputTokens &&
    safeInteger(settlement.costMicros) &&
    usage.costMicros === settlement.costMicros
  );
}

function validArtifact(
  artifact: Readonly<CopilotFailureDiagnosisOutputArtifact>,
  plan: Readonly<CopilotFailureDiagnosisExecutionPlan>,
  finalization: Readonly<CopilotFailureDiagnosisFinalizationReceipt>,
): boolean {
  return (
    artifact.artifactId === finalization.outputArtifactId &&
    artifact.requestId === plan.requestId &&
    artifact.planDigest === plan.planDigest &&
    artifact.projectId === plan.projectId &&
    artifact.runId === plan.runId &&
    artifact.stepRunId === plan.modelStepRunId &&
    artifact.invocationId === plan.modelInvocationId &&
    DIGEST.test(artifact.artifactDigest) &&
    DIGEST.test(artifact.contentDigest) &&
    safeInteger(artifact.outputBytes) &&
    safeInteger(artifact.sealedAtMs)
  );
}

interface LocatedDiagnosis {
  readonly plan: Readonly<CopilotFailureDiagnosisExecutionPlan>;
  readonly admission: Readonly<CopilotFailureDiagnosisAdmissionReceipt>;
  readonly terminalization: Readonly<CopilotFailureDiagnosisPreModelTerminalizationReceipt> | null;
  readonly finalization: Readonly<CopilotFailureDiagnosisFinalizationReceipt> | null;
}

/**
 * Request-keyed product read boundary. It resolves durable authority before
 * current Policy, never accepts storage/model identities from the caller, and
 * only resolves output key material after every binding is proven.
 */
export class CopilotFailureDiagnosisReadService {
  readonly #admissions: Pick<
    CopilotFailureDiagnosisAdmissionRepository,
    'findByRequestId' | 'findPlanByRequestId'
  >;
  readonly #terminalizations: Pick<
    CopilotFailureDiagnosisPreModelTerminalizationRepository,
    'findByRequestId'
  >;
  readonly #finalizations: Pick<
    CopilotFailureDiagnosisFinalizationRepository,
    'findFinalization'
  >;
  readonly #models: CopilotFailureDiagnosisReadModelRepository;
  readonly #authorizer: CopilotFailureDiagnosisReadAuthorizer;
  readonly #keys: CopilotFailureDiagnosisOutputKeyProvider;
  readonly #now: () => number;

  constructor(
    options: Readonly<{
      admissions: Pick<
        CopilotFailureDiagnosisAdmissionRepository,
        'findByRequestId' | 'findPlanByRequestId'
      >;
      terminalizations: Pick<
        CopilotFailureDiagnosisPreModelTerminalizationRepository,
        'findByRequestId'
      >;
      finalizations: Pick<
        CopilotFailureDiagnosisFinalizationRepository,
        'findFinalization'
      >;
      models: CopilotFailureDiagnosisReadModelRepository;
      authorizer: CopilotFailureDiagnosisReadAuthorizer;
      keys: CopilotFailureDiagnosisOutputKeyProvider;
      now?: () => number;
    }>,
  ) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      typeof options.admissions?.findPlanByRequestId !== 'function' ||
      typeof options.admissions?.findByRequestId !== 'function' ||
      typeof options.terminalizations?.findByRequestId !== 'function' ||
      typeof options.finalizations?.findFinalization !== 'function' ||
      typeof options.models?.findCopilotFailureDiagnosisOutput !== 'function' ||
      typeof options.models?.findUsage !== 'function' ||
      typeof options.models?.findPriceSettlement !== 'function' ||
      typeof options.authorizer?.authorize !== 'function' ||
      typeof options.keys?.resolve !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function')
    ) {
      throw unavailable();
    }
    this.#admissions = options.admissions;
    this.#terminalizations = options.terminalizations;
    this.#finalizations = options.finalizations;
    this.#models = options.models;
    this.#authorizer = options.authorizer;
    this.#keys = options.keys;
    this.#now = options.now ?? Date.now;
  }

  async #locate(
    command: Readonly<CopilotFailureDiagnosisReadTarget>,
    permission: ProjectPermission,
  ): Promise<Readonly<LocatedDiagnosis> | null> {
    let plan;
    let admission;
    try {
      [plan, admission] = await Promise.all([
        this.#admissions.findPlanByRequestId(command.requestId),
        this.#admissions.findByRequestId(command.requestId),
      ]);
    } catch (cause) {
      throw unavailable(cause);
    }
    if (plan === null && admission === null) return null;
    if (plan === null || admission === null) throw unavailable();
    if (!validPlan(plan)) throw unavailable();
    if (!planMatchesTarget(plan, command)) return null;
    if (
      admission.requestId !== plan.requestId ||
      admission.planDigest !== plan.planDigest ||
      admission.runId !== plan.runId ||
      admission.sourceRunId !== plan.source.runId ||
      !safeInteger(admission.admittedAtMs)
    ) {
      throw unavailable();
    }
    let decision;
    try {
      decision = await this.#authorizer.authorize(
        command.principal,
        command.projectId,
        permission,
      );
    } catch (cause) {
      throw unavailable(cause);
    }
    if (
      !decision ||
      typeof decision !== 'object' ||
      !['allow', 'deny', 'require_approval'].includes(decision.effect)
    ) {
      throw unavailable();
    }
    if (decision.effect !== 'allow') return null;
    let terminalization;
    let finalization;
    try {
      [terminalization, finalization] = await Promise.all([
        this.#terminalizations.findByRequestId(command.requestId),
        this.#finalizations.findFinalization(command.requestId),
      ]);
    } catch (cause) {
      throw unavailable(cause);
    }
    if (terminalization && finalization) throw unavailable();
    if (terminalization && !validTerminalization(terminalization, plan)) {
      throw unavailable();
    }
    if (finalization && !validFinalization(finalization, plan)) {
      throw unavailable();
    }
    return Object.freeze({ plan, admission, terminalization, finalization });
  }

  async inspect(
    value: CopilotFailureDiagnosisReadTarget,
  ): Promise<CopilotFailureDiagnosisInspectionResult> {
    const nowMs = this.#now();
    if (!safeInteger(nowMs)) throw unavailable();
    const command = normalizeTarget(value, nowMs);
    const target = targetView(command);
    const located = await this.#locate(command, 'run.read');
    if (!located) return inspectionNotFound(target);
    const { plan, admission, terminalization, finalization } = located;
    if (!terminalization && !finalization) {
      return Object.freeze({
        schema: COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESULT_SCHEMA,
        status: 'running' as const,
        ...target,
        diagnosisRunId: plan.runId,
        outcome: null,
        stage: null,
        reason: null,
        outputAvailable: false,
        admittedAtMs: admission.admittedAtMs,
        finalizedAtMs: null,
        usage: null,
      });
    }
    if (terminalization) {
      return Object.freeze({
        schema: COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESULT_SCHEMA,
        status: 'terminal' as const,
        ...target,
        diagnosisRunId: plan.runId,
        outcome: terminalization.outcome,
        stage: terminalization.stage,
        reason: terminalization.reason,
        outputAvailable: false,
        admittedAtMs: admission.admittedAtMs,
        finalizedAtMs: terminalization.finalizedAtMs,
        usage: Object.freeze({
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          currency: 'USD' as const,
          costMicros: 0,
        }),
      });
    }
    const finalized = finalization!;
    let usage;
    let settlement;
    try {
      [usage, settlement] = await Promise.all([
        this.#models.findUsage(plan.modelInvocationId),
        this.#models.findPriceSettlement(plan.modelInvocationId),
      ]);
    } catch (cause) {
      throw unavailable(cause);
    }
    if (usage && !validUsage(usage, plan, finalized)) throw unavailable();
    if (
      settlement &&
      (!usage || !settlementMatches(settlement, usage, finalized))
    ) {
      throw unavailable();
    }
    return Object.freeze({
      schema: COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESULT_SCHEMA,
      status: 'terminal' as const,
      ...target,
      diagnosisRunId: plan.runId,
      outcome: finalized.outcome,
      stage: 'model' as const,
      reason: null,
      outputAvailable: finalized.outputArtifactId !== null,
      admittedAtMs: admission.admittedAtMs,
      finalizedAtMs: finalized.finalizedAtMs,
      usage:
        usage === null
          ? null
          : Object.freeze({
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
              currency: settlement ? ('USD' as const) : null,
              costMicros: settlement?.costMicros ?? null,
            }),
    });
  }

  async readOutput(
    value: CopilotFailureDiagnosisReadTarget,
  ): Promise<CopilotFailureDiagnosisOutputReadResult> {
    const nowMs = this.#now();
    if (!safeInteger(nowMs)) throw unavailable();
    const command = normalizeTarget(value, nowMs);
    const target = targetView(command);
    const located = await this.#locate(command, 'artifact.read');
    if (!located || !located.finalization) return outputNotFound(target);
    const { plan, finalization } = located;
    const outputArtifactId = finalization.outputArtifactId;
    if (outputArtifactId === null) return outputNotFound(target);
    let artifact;
    try {
      artifact = await this.#models.findCopilotFailureDiagnosisOutput(
        outputArtifactId,
      );
    } catch (cause) {
      throw unavailable(cause);
    }
    if (!artifact) return outputNotFound(target);
    if (!validArtifact(artifact, plan, finalization)) throw unavailable();
    let material;
    try {
      material = await this.#keys.resolve(artifact.keyId);
    } catch (cause) {
      throw unavailable(cause);
    }
    if (
      !material ||
      typeof material !== 'object' ||
      Array.isArray(material) ||
      material.keyId !== artifact.keyId ||
      !(material.key instanceof Uint8Array) ||
      material.key.byteLength !== 32
    ) {
      try {
        material?.key?.fill(0);
      } catch {
        // Invalid key material remains unavailable and must not escape.
      }
      throw unavailable();
    }
    try {
      const opened = openCopilotFailureDiagnosisOutputArtifact(
        artifact,
        material.key,
      );
      return Object.freeze({
        schema: COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESULT_SCHEMA,
        status: 'available' as const,
        ...target,
        diagnosisRunId: plan.runId,
        reference: Object.freeze({
          artifactId: artifact.artifactId,
          artifactDigest: artifact.artifactDigest,
          contentDigest: artifact.contentDigest,
          outputBytes: artifact.outputBytes,
          sealedAtMs: artifact.sealedAtMs,
        }),
        result: Object.freeze({
          text: opened.text,
          finishReason: opened.finishReason,
          usage: Object.freeze({ ...opened.usage }),
        }),
      });
    } catch (cause) {
      throw unavailable(cause);
    } finally {
      try {
        material.key.fill(0);
      } catch (cause) {
        throw unavailable(cause);
      }
    }
  }
}
