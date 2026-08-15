import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';

import {
  BUILTIN_RUN_LOG_EXCERPT_TOOL,
  createBuiltInRunLogExcerptToolHandlerBinding,
} from '@qinglong/runtime-core/builtin-run-log-excerpt-tool';
import type { RunRepositoryReader } from '@qinglong/runtime-core/run-repository';
import type { ToolPolicyAuthorizer } from '@qinglong/runtime-core/tool-registry';
import { prepareToolInvocation } from '@qinglong/runtime-core/tool-registry';
import type { ProjectToolDefinitionSnapshotRepository } from '@qinglong/runtime-core/project-tool-definition-snapshot';
import { projectToolDefinitionRegistry } from '@qinglong/runtime-core/project-tool-definition-snapshot';
import {
  createToolInvocationInputArtifact,
  createToolInvocationPreviewArtifact,
  type ToolInvocationArtifactKeyProvider,
  type ToolInvocationArtifactRepository,
  type ToolInvocationPreviewDocument,
} from '@qinglong/runtime-core/tool-invocation-artifact';
import {
  TrustedToolHandlerBindingRegistry,
  createTrustedToolInvocationPlan,
} from '@qinglong/runtime-core/trusted-tool-invocation';

import { MAX_MODEL_INVOCATION_MS } from '../../../model-gateway/model';
import { prepareCopilotFailureDiagnosisExecution } from '../admission/plan';
import type {
  CopilotFailureDiagnosisAdmissionRepository,
  CopilotFailureDiagnosisExecutionPlan,
  PrepareCopilotFailureDiagnosisModelIntent,
} from '../admission/contracts';
import {
  executeCopilotFailureDiagnosisTool,
  type CopilotFailureDiagnosisToolExecutionDependencies,
} from '../tool-execution/coordinator';
import {
  CopilotFailureDiagnosisToolExecutionDeadlineExceededError,
  type CopilotFailureDiagnosisToolExecutionResult,
} from '../tool-execution/contracts';
import {
  executeCopilotFailureDiagnosisModel,
  type CopilotFailureDiagnosisModelExecutionDependencies,
} from '../model-execution/coordinator';
import {
  terminalizeCopilotFailureDiagnosisBeforeModel,
  type CopilotFailureDiagnosisPreModelTerminalizationDependencies,
  type CopilotFailureDiagnosisPreModelTerminalizationTrigger,
} from '../terminalization/coordinator';
import { CopilotFailureDiagnosisPreModelTerminalizationNotReadyError } from '../terminalization/contracts';
import {
  CopilotFailureDiagnosisApplicationBusyError,
  CopilotFailureDiagnosisApplicationConflictError,
  CopilotFailureDiagnosisApplicationUnavailableError,
  InvalidCopilotFailureDiagnosisApplicationError,
  MAX_ACTIVE_COPILOT_FAILURE_DIAGNOSIS_APPLICATION_REQUESTS,
  type ExecuteCopilotFailureDiagnosisApplicationCommand,
  type ExecuteCopilotFailureDiagnosisApplicationResult,
} from './contracts';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const NONCE_DOMAIN = Buffer.from(
  'qinglong/copilot-failure-diagnosis-tool-invocation-nonce@v1\0',
  'utf8',
);
const IDENTITY_DOMAIN = Buffer.from(
  'qinglong/copilot-failure-diagnosis-application-identity@v1\0',
  'utf8',
);

export interface CopilotFailureDiagnosisApplicationDependencies {
  readonly admissions: CopilotFailureDiagnosisAdmissionRepository;
  readonly snapshots: Pick<
    ProjectToolDefinitionSnapshotRepository,
    'findCurrent'
  >;
  readonly runs: Pick<
    RunRepositoryReader,
    'findRunById' | 'findLatestAttemptByRunId'
  >;
  readonly artifacts: ToolInvocationArtifactRepository;
  readonly invocationKeys: Pick<
    ToolInvocationArtifactKeyProvider,
    'active' | 'resolve'
  >;
  readonly authorizer: ToolPolicyAuthorizer;
  readonly tool: CopilotFailureDiagnosisToolExecutionDependencies;
  readonly model: CopilotFailureDiagnosisModelExecutionDependencies;
  readonly terminalizations: CopilotFailureDiagnosisPreModelTerminalizationDependencies;
  readonly executeTool: typeof executeCopilotFailureDiagnosisTool;
  readonly executeModel: typeof executeCopilotFailureDiagnosisModel;
  readonly terminalizeBeforeModel: typeof terminalizeCopilotFailureDiagnosisBeforeModel;
  readonly modelIntent: Readonly<PrepareCopilotFailureDiagnosisModelIntent>;
  readonly executionTimeoutMs: number;
  readonly now?: () => number;
  readonly nonceFactory?: (
    input: Readonly<{
      key: Uint8Array;
      keyId: string;
      requestId: string;
      projectId: string;
      sourceRunId: string;
      invocationActionDigest: string;
    }>,
  ) => Uint8Array;
}

interface ActiveRequest {
  readonly digest: string;
  readonly promise: Promise<
    Readonly<ExecuteCopilotFailureDiagnosisApplicationResult>
  >;
}

function invalid(message: string): never {
  throw new InvalidCopilotFailureDiagnosisApplicationError(message);
}

function unavailable(cause?: unknown): never {
  throw new CopilotFailureDiagnosisApplicationUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function identity(prefix: string, requestId: string): string {
  return `${prefix}:${createHash('sha256')
    .update(IDENTITY_DOMAIN)
    .update(prefix)
    .update('\0')
    .update(requestId)
    .digest('hex')
    .slice(0, 32)}`;
}

function preview(
  sourceRunId: string,
  sourceAttemptId: string,
): Readonly<ToolInvocationPreviewDocument> {
  return Object.freeze({
    title: 'Diagnose failed Run',
    summary: 'Read one bounded, redacted and untrusted execution log excerpt',
    fields: Object.freeze([
      Object.freeze({
        kind: 'identifier' as const,
        label: 'Run',
        value: sourceRunId,
      }),
      Object.freeze({
        kind: 'identifier' as const,
        label: 'Attempt',
        value: sourceAttemptId,
      }),
    ]),
    warnings: Object.freeze(['potentially_sensitive_output']),
  });
}

function defaultNonce(
  input: Readonly<{
    key: Uint8Array;
    keyId: string;
    requestId: string;
    projectId: string;
    sourceRunId: string;
    invocationActionDigest: string;
  }>,
): Uint8Array {
  const derived = createHmac('sha256', Buffer.from(input.key))
    .update(NONCE_DOMAIN)
    .update(
      JSON.stringify({
        keyId: input.keyId,
        requestId: input.requestId,
        projectId: input.projectId,
        sourceRunId: input.sourceRunId,
        invocationActionDigest: input.invocationActionDigest,
      }),
    )
    .digest();
  try {
    return Buffer.from(derived.subarray(0, 12));
  } finally {
    derived.fill(0);
  }
}

function normalizeCommand(
  value: ExecuteCopilotFailureDiagnosisApplicationCommand,
): Readonly<ExecuteCopilotFailureDiagnosisApplicationCommand> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      ['principal', 'projectId', 'requestId', 'sourceRunId', 'traceId'].join(
        '\0',
      ) ||
    !ID_PATTERN.test(value.requestId) ||
    !ID_PATTERN.test(value.traceId) ||
    !ID_PATTERN.test(value.projectId) ||
    !RUN_ID_PATTERN.test(value.sourceRunId) ||
    !value.principal ||
    typeof value.principal !== 'object' ||
    Array.isArray(value.principal)
  ) {
    return invalid('command is invalid');
  }
  return Object.freeze({
    requestId: value.requestId,
    traceId: value.traceId,
    projectId: value.projectId,
    sourceRunId: value.sourceRunId,
    principal: value.principal,
  });
}

function assertDependencies(
  value: CopilotFailureDiagnosisApplicationDependencies,
): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.admissions?.findByRequestId !== 'function' ||
    typeof value.admissions?.findPlanByRequestId !== 'function' ||
    typeof value.admissions?.admit !== 'function' ||
    typeof value.snapshots?.findCurrent !== 'function' ||
    typeof value.runs?.findRunById !== 'function' ||
    typeof value.runs?.findLatestAttemptByRunId !== 'function' ||
    typeof value.artifacts?.put !== 'function' ||
    typeof value.invocationKeys?.active !== 'function' ||
    typeof value.invocationKeys?.resolve !== 'function' ||
    typeof value.authorizer?.authorize !== 'function' ||
    typeof value.executeTool !== 'function' ||
    typeof value.executeModel !== 'function' ||
    !value.tool ||
    !value.model ||
    typeof value.terminalizations?.repository?.findByRequestId !== 'function' ||
    typeof value.terminalizations?.repository?.readAuthority !== 'function' ||
    typeof value.terminalizations?.repository?.commit !== 'function' ||
    typeof value.terminalizeBeforeModel !== 'function' ||
    !value.modelIntent ||
    typeof value.modelIntent !== 'object' ||
    !Number.isSafeInteger(value.executionTimeoutMs) ||
    value.executionTimeoutMs < 1 ||
    value.executionTimeoutMs > MAX_MODEL_INVOCATION_MS ||
    (value.now !== undefined && typeof value.now !== 'function') ||
    (value.nonceFactory !== undefined &&
      typeof value.nonceFactory !== 'function')
  ) {
    return invalid('dependencies are invalid');
  }
  if (
    value.tool.admissions !== value.admissions ||
    value.tool.snapshots !== value.snapshots ||
    value.tool.runs !== value.runs ||
    value.tool.artifacts !== value.artifacts ||
    value.tool.invocationKeys !== value.invocationKeys ||
    value.model.admissions !== value.admissions ||
    value.model.unlocks !== value.tool.unlocks
  ) {
    return invalid('dependency authorities are not shared');
  }
}

function sameSubject(
  left: Readonly<{ type: string; id: string }>,
  right: Readonly<{ type: string; id: string }>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function sameModelIntent(
  plan: Readonly<CopilotFailureDiagnosisExecutionPlan>,
  configured: Readonly<PrepareCopilotFailureDiagnosisModelIntent>,
): boolean {
  return (
    plan.model.provider === configured.provider &&
    plan.model.model === configured.model &&
    plan.model.modelBoundary === configured.modelBoundary &&
    plan.model.responseLanguage === configured.responseLanguage &&
    plan.model.maxOutputTokens === configured.maxOutputTokens &&
    JSON.stringify(plan.model.egressPolicy) ===
      JSON.stringify(configured.egressPolicy)
  );
}

function nonceInput(
  plan: Readonly<CopilotFailureDiagnosisExecutionPlan>,
  key: Uint8Array,
) {
  return Object.freeze({
    key,
    keyId: plan.tool.invocationArtifact.keyId,
    requestId: plan.requestId,
    projectId: plan.projectId,
    sourceRunId: plan.source.runId,
    invocationActionDigest: plan.tool.invocationActionDigest,
  });
}

export class CopilotFailureDiagnosisApplicationService {
  readonly #dependencies: CopilotFailureDiagnosisApplicationDependencies;
  readonly #active = new Map<string, ActiveRequest>();

  constructor(dependencies: CopilotFailureDiagnosisApplicationDependencies) {
    assertDependencies(dependencies);
    this.#dependencies = dependencies;
  }

  execute(
    commandValue: ExecuteCopilotFailureDiagnosisApplicationCommand,
  ): Promise<Readonly<ExecuteCopilotFailureDiagnosisApplicationResult>> {
    const command = normalizeCommand(commandValue);
    const commandDigest = digest(command);
    const active = this.#active.get(command.requestId);
    if (active) {
      if (active.digest !== commandDigest) {
        throw new CopilotFailureDiagnosisApplicationConflictError();
      }
      return active.promise;
    }
    if (
      this.#active.size >=
      MAX_ACTIVE_COPILOT_FAILURE_DIAGNOSIS_APPLICATION_REQUESTS
    ) {
      throw new CopilotFailureDiagnosisApplicationBusyError();
    }
    const promise = this.#execute(command).finally(() => {
      this.#active.delete(command.requestId);
    });
    this.#active.set(command.requestId, { digest: commandDigest, promise });
    return promise;
  }

  async #execute(
    command: Readonly<ExecuteCopilotFailureDiagnosisApplicationCommand>,
  ): Promise<Readonly<ExecuteCopilotFailureDiagnosisApplicationResult>> {
    const existing = await this.#dependencies.admissions.findPlanByRequestId(
      command.requestId,
    );
    let plan: Readonly<CopilotFailureDiagnosisExecutionPlan>;
    let admissionStatus: 'created' | 'existing';
    let admission;
    if (existing) {
      if (
        existing.projectId !== command.projectId ||
        existing.source.runId !== command.sourceRunId ||
        existing.traceId !== command.traceId ||
        !sameSubject(existing.requestedBySubject, command.principal.subject) ||
        !sameModelIntent(existing, this.#dependencies.modelIntent)
      ) {
        throw new CopilotFailureDiagnosisApplicationConflictError();
      }
      plan = existing;
      const admitted = await this.#dependencies.admissions.admit(plan);
      admissionStatus = admitted.status;
      admission = admitted.receipt;
      await this.#materializeArtifacts(plan);
    } else {
      const prepared = await this.#prepare(command);
      plan = prepared.plan;
      const admitted = await this.#dependencies.admissions.admit(plan);
      admissionStatus = admitted.status;
      admission = admitted.receipt;
      try {
        await this.#dependencies.artifacts.put(
          prepared.inputArtifact,
          prepared.previewArtifact,
        );
      } catch (cause) {
        throw new CopilotFailureDiagnosisApplicationUnavailableError({
          cause: cause instanceof Error ? cause : undefined,
        });
      }
    }
    const boundary = await this.#preModel(plan.requestId, { kind: 'boundary' });
    if (boundary) {
      return Object.freeze({
        admissionStatus,
        admission,
        tool: null,
        model: null,
        terminalization: boundary,
        terminalizationRequired: false,
      });
    }
    let tool: Readonly<CopilotFailureDiagnosisToolExecutionResult>;
    try {
      tool = await this.#dependencies.executeTool(
        {
          requestId: plan.requestId,
          principal: command.principal,
          authorizer: this.#dependencies.authorizer,
        },
        this.#dependencies.tool,
      );
    } catch (cause) {
      if (
        !(
          cause instanceof
          CopilotFailureDiagnosisToolExecutionDeadlineExceededError
        )
      ) {
        throw cause;
      }
      const terminalization = await this.#dependencies.terminalizeBeforeModel(
        plan.requestId,
        { kind: 'boundary' },
        this.#dependencies.terminalizations,
      );
      return Object.freeze({
        admissionStatus,
        admission,
        tool: null,
        model: null,
        terminalization: terminalization.receipt,
        terminalizationRequired: false,
      });
    }
    if (tool.outcome !== 'succeeded') {
      const terminalization = await this.#dependencies.terminalizeBeforeModel(
        plan.requestId,
        { kind: 'tool_failure', completion: tool.completion },
        this.#dependencies.terminalizations,
      );
      return Object.freeze({
        admissionStatus,
        admission,
        tool,
        model: null,
        terminalization: terminalization.receipt,
        terminalizationRequired: false,
      });
    }
    const projection = await this.#preModel(plan.requestId, {
      kind: 'tool_projection',
      completion: tool.completion,
      output: tool.output,
    });
    if (projection) {
      return Object.freeze({
        admissionStatus,
        admission,
        tool,
        model: null,
        terminalization: projection,
        terminalizationRequired: false,
      });
    }
    const afterToolBoundary = await this.#preModel(plan.requestId, {
      kind: 'boundary',
    });
    if (afterToolBoundary) {
      return Object.freeze({
        admissionStatus,
        admission,
        tool,
        model: null,
        terminalization: afterToolBoundary,
        terminalizationRequired: false,
      });
    }
    const model = await this.#dependencies.executeModel(
      plan.requestId,
      this.#dependencies.model,
    );
    return Object.freeze({
      admissionStatus,
      admission,
      tool,
      model,
      terminalization: null,
      terminalizationRequired: false,
    });
  }

  async #preModel(
    requestId: string,
    trigger: CopilotFailureDiagnosisPreModelTerminalizationTrigger,
  ) {
    try {
      const result = await this.#dependencies.terminalizeBeforeModel(
        requestId,
        trigger,
        this.#dependencies.terminalizations,
      );
      return result.receipt;
    } catch (cause) {
      if (
        cause instanceof
        CopilotFailureDiagnosisPreModelTerminalizationNotReadyError
      ) {
        return null;
      }
      throw cause;
    }
  }

  async #prepare(
    command: Readonly<ExecuteCopilotFailureDiagnosisApplicationCommand>,
  ) {
    const now = this.#clock();
    let run;
    let attempt;
    let snapshotRecord;
    try {
      [run, attempt, snapshotRecord] = await Promise.all([
        this.#dependencies.runs.findRunById(command.sourceRunId),
        this.#dependencies.runs.findLatestAttemptByRunId(command.sourceRunId),
        this.#dependencies.snapshots.findCurrent(command.projectId),
      ]);
    } catch (cause) {
      return unavailable(cause);
    }
    if (
      !run ||
      !attempt ||
      !snapshotRecord ||
      run.projectId !== command.projectId ||
      attempt.runId !== run.id ||
      !['failed', 'timed_out'].includes(run.status) ||
      !['failed', 'timed_out', 'lost'].includes(attempt.status) ||
      (run.status === 'failed' &&
        !['failed', 'lost'].includes(attempt.status)) ||
      (run.status === 'timed_out' && attempt.status !== 'timed_out') ||
      !Number.isSafeInteger(attempt.finishedAtMs) ||
      typeof attempt.logArtifactId !== 'string'
    ) {
      throw new CopilotFailureDiagnosisApplicationConflictError(
        'source Run is not an exact diagnosable terminal fence',
      );
    }
    const snapshot = snapshotRecord.snapshot;
    const binding = createBuiltInRunLogExcerptToolHandlerBinding(snapshot, [
      'cluster-control',
    ]);
    const bindings = new TrustedToolHandlerBindingRegistry(snapshot, [binding]);
    const invocation = await prepareToolInvocation(
      projectToolDefinitionRegistry(snapshot),
      {
        projectId: command.projectId,
        principal: command.principal,
        nowMs: now,
        tool: BUILTIN_RUN_LOG_EXCERPT_TOOL,
        input: { runId: run.id, attemptId: attempt.id },
      },
      this.#dependencies.authorizer,
    );
    if (invocation.status !== 'ready') {
      throw new CopilotFailureDiagnosisApplicationConflictError(
        'Tool admission is not ready',
      );
    }
    const key = await this.#dependencies.invocationKeys.active();
    try {
      const baseIdentity = identity('cda', command.requestId);
      const nonce = (this.#dependencies.nonceFactory ?? defaultNonce)({
        key: key.key,
        keyId: key.keyId,
        requestId: command.requestId,
        projectId: command.projectId,
        sourceRunId: run.id,
        invocationActionDigest: invocation.actionDigest,
      });
      const tool = createTrustedToolInvocationPlan(bindings, invocation, {
        actionRef: baseIdentity,
        profile: 'cluster-control',
        preview: preview(run.id, attempt.id),
        inputArtifactId: identity('cdia', command.requestId),
        previewArtifactId: identity('cdpa', command.requestId),
        artifactKeyId: key.keyId,
        artifactKey: key.key,
        artifactNonce: nonce,
        sealedAtMs: now,
      });
      nonce.fill(0);
      const plan = prepareCopilotFailureDiagnosisExecution({
        requestId: command.requestId,
        traceId: command.traceId,
        source: {
          runId: run.id,
          runVersion: run.version,
          runStatus: run.status as 'failed' | 'timed_out',
          attemptId: attempt.id,
          attemptStatus: attempt.status as 'failed' | 'timed_out' | 'lost',
          attemptFinishedAtMs: attempt.finishedAtMs!,
          logArtifactId: attempt.logArtifactId,
        },
        toolPlan: tool.plan,
        bindings,
        model: this.#dependencies.modelIntent,
        deadlineAtMs: now + this.#dependencies.executionTimeoutMs,
        plannedAtMs: now,
      });
      return Object.freeze({
        plan,
        inputArtifact: tool.inputArtifact,
        previewArtifact: tool.previewArtifact,
      });
    } finally {
      key.key.fill(0);
    }
  }

  async #materializeArtifacts(
    plan: Readonly<CopilotFailureDiagnosisExecutionPlan>,
  ): Promise<void> {
    const material = await this.#dependencies.invocationKeys.resolve(
      plan.tool.invocationArtifact.keyId,
    );
    if (!material || material.keyId !== plan.tool.invocationArtifact.keyId) {
      return unavailable();
    }
    try {
      const nonce = (this.#dependencies.nonceFactory ?? defaultNonce)(
        nonceInput(plan, material.key),
      );
      const inputArtifact = createToolInvocationInputArtifact(
        {
          artifactId: plan.tool.invocationArtifact.artifactId,
          projectId: plan.projectId,
          actionRef: plan.tool.actionRef,
          requestedBy: plan.requestedBySubject,
          tool: BUILTIN_RUN_LOG_EXCERPT_TOOL,
          input: {
            attemptId: plan.source.attemptId,
            runId: plan.source.runId,
          },
          inputDigest: plan.tool.invocationArtifact.inputDigest,
          invocationActionDigest: plan.tool.invocationActionDigest,
          keyId: material.keyId,
          key: material.key,
          sealedAtMs: plan.tool.sealedAtMs,
        },
        () => nonce,
      );
      nonce.fill(0);
      const previewArtifact = createToolInvocationPreviewArtifact({
        artifactId: plan.tool.previewArtifact.artifactId,
        projectId: plan.projectId,
        actionRef: plan.tool.actionRef,
        actionDigest: plan.tool.actionDigest,
        redactionContractDigest:
          plan.tool.previewArtifact.redactionContractDigest,
        preview: preview(plan.source.runId, plan.source.attemptId),
        sealedAtMs: plan.tool.sealedAtMs,
      });
      if (
        inputArtifact.artifactDigest !==
          plan.tool.invocationArtifact.artifactDigest ||
        previewArtifact.artifactDigest !==
          plan.tool.previewArtifact.artifactDigest
      ) {
        throw new CopilotFailureDiagnosisApplicationConflictError(
          'durable Tool Artifact references cannot be reconstructed',
        );
      }
      await this.#dependencies.artifacts.put(inputArtifact, previewArtifact);
    } finally {
      material.key.fill(0);
    }
  }

  #clock(): number {
    let value: number;
    try {
      value = (this.#dependencies.now ?? Date.now)();
    } catch (cause) {
      return unavailable(cause);
    }
    if (!Number.isSafeInteger(value) || value < 0) return invalid('clock');
    if (
      value + this.#dependencies.executionTimeoutMs >
      Number.MAX_SAFE_INTEGER
    ) {
      return invalid('deadline overflows');
    }
    return value;
  }
}
