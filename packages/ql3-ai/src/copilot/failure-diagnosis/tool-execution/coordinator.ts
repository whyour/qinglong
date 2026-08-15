import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { RunRepositoryReader } from '@qinglong/runtime-core/run-repository';
import {
  transitionStepRunMutation,
  type StepRunRepository,
} from '@qinglong/runtime-core/step-run';
import {
  createToolExecutionEvidenceBundle,
  toolExecutionAdmissionEvidence,
  TOOL_EXECUTION_START_AUDIT_OPERATION,
} from '@qinglong/runtime-core/tool-execution-evidence';
import {
  createToolExecutionStartCommand,
  normalizeToolExecutionStartBarrierRecord,
  type ToolExecutionStartBarrierRecord,
  type ToolExecutionStartBarrierRepository,
} from '@qinglong/runtime-core/tool-execution-start-barrier';
import type { ToolExecutionCompletionRepository } from '@qinglong/runtime-core/tool-execution-completion';
import type { ToolExecutionFailureCompletionRepository } from '@qinglong/runtime-core/tool-execution-failure-completion';
import type { ToolExecutionResultRekeyReader } from '@qinglong/runtime-core/tool-result-rekey';
import type { ToolResultKeyCatalogReader } from '@qinglong/runtime-core/tool-result-key-catalog';
import type { ProjectToolDefinitionSnapshotRepository } from '@qinglong/runtime-core/project-tool-definition-snapshot';
import {
  toolInvocationInputArtifactReference,
  toolInvocationPreviewArtifactReference,
  type ToolInvocationArtifactKeyProvider,
  type ToolInvocationArtifactRepository,
} from '@qinglong/runtime-core/tool-invocation-artifact';
import {
  admitTrustedToolExecution,
  trustedToolContractIdentityDigest,
} from '@qinglong/runtime-core/trusted-tool-invocation';
import { TrustedToolExecutionAdapterRegistry } from '@qinglong/runtime-core/trusted-tool-execution';
import { executeAndCompleteTrustedTool } from '@qinglong/runtime-core/trusted-tool-completion';
import { BuiltInRunLogExcerptToolAdapter } from '@qinglong/runtime-core/builtin-run-log-excerpt-tool';
import type { RunAttemptLogReadPort } from '@qinglong/runtime-core/builtin-run-log-excerpt-projection';

import {
  CopilotFailureDiagnosisToolExecutionConflictError,
  CopilotFailureDiagnosisToolExecutionDeadlineExceededError,
  CopilotFailureDiagnosisToolExecutionUnavailableError,
  InvalidCopilotFailureDiagnosisToolExecutionError,
  type CopilotFailureDiagnosisToolExecutionAdmissionReader,
  type CopilotFailureDiagnosisToolExecutionResult,
  type CopilotFailureDiagnosisToolUnlockRepository,
  type ExecuteCopilotFailureDiagnosisToolInput,
} from './contracts';
import { restoreCopilotFailureDiagnosisTrustedToolAuthority } from './planAuthority';
import { createCopilotFailureDiagnosisToolUnlockCommand } from './unlockProtocol';

export interface CopilotFailureDiagnosisToolExecutionDependencies {
  readonly admissions: CopilotFailureDiagnosisToolExecutionAdmissionReader;
  readonly snapshots: Pick<
    ProjectToolDefinitionSnapshotRepository,
    'findCurrent'
  >;
  readonly artifacts: ToolInvocationArtifactRepository;
  readonly invocationKeys: Pick<ToolInvocationArtifactKeyProvider, 'resolve'>;
  readonly resultKeys: Pick<ToolInvocationArtifactKeyProvider, 'resolve'>;
  readonly stepRuns: Pick<StepRunRepository, 'findById'>;
  readonly runs: Pick<RunRepositoryReader, 'findRunById'>;
  readonly barriers: ToolExecutionStartBarrierRepository;
  readonly completions: ToolExecutionCompletionRepository;
  readonly failureCompletions: ToolExecutionFailureCompletionRepository;
  readonly resultKeyCatalog: ToolResultKeyCatalogReader;
  readonly resultRekeys: ToolExecutionResultRekeyReader;
  readonly logs: RunAttemptLogReadPort;
  readonly unlocks: CopilotFailureDiagnosisToolUnlockRepository;
  readonly now?: () => number;
  readonly nonceFactory?: () => Uint8Array;
}

const IDENTITY_DOMAIN = Buffer.from(
  'qinglong/copilot-failure-diagnosis-tool-execution-identity@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidCopilotFailureDiagnosisToolExecutionError(message);
}

function unavailable(cause?: unknown): never {
  throw new CopilotFailureDiagnosisToolExecutionUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function hash(value: unknown): string {
  return createHash('sha256')
    .update(IDENTITY_DOMAIN)
    .update(JSON.stringify(value))
    .digest('hex');
}

function identity(prefix: string, planDigest: string): string {
  const maximumDigestLength = 35 - prefix.length;
  return `${prefix}:${hash({ prefix, planDigest }).slice(
    0,
    maximumDigestLength,
  )}`;
}

function traceIdentity(planDigest: string): string {
  return hash({ prefix: 'trace', planDigest }).slice(0, 32);
}

function spanIdentity(planDigest: string): string {
  return hash({ prefix: 'span', planDigest }).slice(0, 16);
}

function auditEventIdentity(planDigest: string): string {
  const value = hash({ prefix: 'audit', planDigest }).slice(0, 32).split('');
  value[12] = '4';
  value[16] = '8';
  const hex = value.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function clock(now: (() => number) | undefined): number {
  let value: number;
  try {
    value = (now ?? Date.now)();
  } catch (cause) {
    return unavailable(cause);
  }
  if (!Number.isSafeInteger(value) || value < 0) return unavailable();
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertDependencies(
  dependencies: CopilotFailureDiagnosisToolExecutionDependencies,
): void {
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    typeof dependencies.admissions?.findByRequestId !== 'function' ||
    typeof dependencies.admissions?.findPlanByRequestId !== 'function' ||
    typeof dependencies.snapshots?.findCurrent !== 'function' ||
    typeof dependencies.artifacts?.findInput !== 'function' ||
    typeof dependencies.artifacts?.findPreview !== 'function' ||
    typeof dependencies.invocationKeys?.resolve !== 'function' ||
    typeof dependencies.resultKeys?.resolve !== 'function' ||
    typeof dependencies.stepRuns?.findById !== 'function' ||
    typeof dependencies.runs?.findRunById !== 'function' ||
    typeof dependencies.barriers?.findByStartId !== 'function' ||
    typeof dependencies.barriers?.prepare !== 'function' ||
    typeof dependencies.completions?.findByStartId !== 'function' ||
    typeof dependencies.failureCompletions?.findByStartId !== 'function' ||
    typeof dependencies.resultKeyCatalog?.findCurrent !== 'function' ||
    typeof dependencies.resultRekeys?.findHeadByArtifactId !== 'function' ||
    typeof dependencies.logs?.read !== 'function' ||
    typeof dependencies.unlocks?.findByRequestId !== 'function' ||
    typeof dependencies.unlocks?.commit !== 'function' ||
    (dependencies.now !== undefined &&
      typeof dependencies.now !== 'function') ||
    (dependencies.nonceFactory !== undefined &&
      typeof dependencies.nonceFactory !== 'function')
  ) {
    return invalid('dependencies are invalid');
  }
}

async function durablePlan(
  requestId: string,
  dependencies: CopilotFailureDiagnosisToolExecutionDependencies,
) {
  let plan;
  let receipt;
  try {
    [plan, receipt] = await Promise.all([
      dependencies.admissions.findPlanByRequestId(requestId),
      dependencies.admissions.findByRequestId(requestId),
    ]);
  } catch (cause) {
    return unavailable(cause);
  }
  if (
    !plan ||
    !receipt ||
    plan.requestId !== requestId ||
    receipt.requestId !== requestId ||
    receipt.planDigest !== plan.planDigest ||
    receipt.runId !== plan.runId ||
    receipt.toolStepRunId !== plan.toolStepRunId ||
    receipt.modelStepRunId !== plan.modelStepRunId
  ) {
    throw new CopilotFailureDiagnosisToolExecutionConflictError(
      'diagnosis admission evidence is incomplete',
    );
  }
  return plan;
}

async function currentAuthority(
  plan: Awaited<ReturnType<typeof durablePlan>>,
  dependencies: CopilotFailureDiagnosisToolExecutionDependencies,
) {
  let record;
  try {
    record = await dependencies.snapshots.findCurrent(plan.projectId);
  } catch (cause) {
    return unavailable(cause);
  }
  if (!record) {
    throw new CopilotFailureDiagnosisToolExecutionConflictError(
      'the current Project Tool snapshot is absent',
    );
  }
  return restoreCopilotFailureDiagnosisTrustedToolAuthority(
    plan,
    record.snapshot,
  );
}

async function assertArtifacts(
  plan: Awaited<ReturnType<typeof durablePlan>>,
  dependencies: CopilotFailureDiagnosisToolExecutionDependencies,
): Promise<void> {
  let input;
  let preview;
  try {
    [input, preview] = await Promise.all([
      dependencies.artifacts.findInput(plan.tool.invocationArtifact.artifactId),
      dependencies.artifacts.findPreview(plan.tool.previewArtifact.artifactId),
    ]);
  } catch (cause) {
    return unavailable(cause);
  }
  if (
    !input ||
    !preview ||
    !sameValue(
      toolInvocationInputArtifactReference(input),
      plan.tool.invocationArtifact,
    ) ||
    !sameValue(
      toolInvocationPreviewArtifactReference(preview),
      plan.tool.previewArtifact,
    ) ||
    input.projectId !== plan.projectId ||
    input.actionRef !== plan.tool.actionRef ||
    preview.projectId !== plan.projectId ||
    preview.actionRef !== plan.tool.actionRef ||
    input.sealedAtMs !== plan.tool.sealedAtMs ||
    preview.sealedAtMs !== plan.tool.sealedAtMs
  ) {
    throw new CopilotFailureDiagnosisToolExecutionConflictError(
      'the durable Tool invocation Artifacts changed',
    );
  }
}

function barrierMatches(
  barrierValue: ToolExecutionStartBarrierRecord,
  plan: Awaited<ReturnType<typeof durablePlan>>,
  startId: string,
): Readonly<ToolExecutionStartBarrierRecord> {
  const barrier = normalizeToolExecutionStartBarrierRecord(barrierValue);
  if (
    barrier.startId !== startId ||
    barrier.projectId !== plan.projectId ||
    barrier.runId !== plan.runId ||
    barrier.stepRunId !== plan.toolStepRunId ||
    barrier.actionRef !== plan.tool.actionRef ||
    barrier.planDigest !== plan.tool.planDigest ||
    barrier.actionDigest !== plan.tool.actionDigest ||
    barrier.snapshotDigest !== plan.tool.snapshotDigest ||
    barrier.definitionDigest !== plan.tool.definitionDigest ||
    barrier.bindingDigest !== plan.tool.bindingDigest ||
    !sameValue(barrier.invocationArtifact, plan.tool.invocationArtifact) ||
    !sameValue(barrier.previewArtifact, plan.tool.previewArtifact) ||
    !sameValue(barrier.requestedBy, plan.requestedBySubject) ||
    barrier.profile !== 'cluster-control' ||
    !sameValue(barrier.policyFence, plan.policyFence) ||
    barrier.approvalRequestId !== null ||
    barrier.approvalDispatchId !== null ||
    barrier.approvalDispatchDigest !== null ||
    barrier.previousStepRunVersion !== 1 ||
    barrier.startedStepRunVersion !== 2
  ) {
    throw new CopilotFailureDiagnosisToolExecutionConflictError(
      'the durable Tool start barrier changed',
    );
  }
  return barrier;
}

async function prepareStart(
  plan: Awaited<ReturnType<typeof durablePlan>>,
  input: ExecuteCopilotFailureDiagnosisToolInput,
  authority: Awaited<ReturnType<typeof currentAuthority>>,
  dependencies: CopilotFailureDiagnosisToolExecutionDependencies,
  startId: string,
): Promise<Readonly<ToolExecutionStartBarrierRecord>> {
  let existing;
  try {
    existing = await dependencies.barriers.findByStartId(startId);
  } catch (cause) {
    return unavailable(cause);
  }
  if (existing) return barrierMatches(existing, plan, startId);

  await assertArtifacts(plan, dependencies);
  let stepRun;
  let run;
  try {
    [stepRun, run] = await Promise.all([
      dependencies.stepRuns.findById(plan.toolStepRunId),
      dependencies.runs.findRunById(plan.runId),
    ]);
  } catch (cause) {
    return unavailable(cause);
  }
  if (
    !stepRun ||
    !run ||
    stepRun.id !== plan.toolStepRunId ||
    stepRun.runId !== plan.runId ||
    stepRun.kind !== 'tool' ||
    stepRun.status !== 'ready' ||
    stepRun.version !== 1 ||
    stepRun.definitionRef !== 'tool:qinglong.run.log.excerpt@1.0.0' ||
    stepRun.definitionDigest !== plan.tool.definitionDigest ||
    run.id !== plan.runId ||
    run.projectId !== plan.projectId ||
    run.status !== 'running' ||
    run.version !== run.eventSequence
  ) {
    throw new CopilotFailureDiagnosisToolExecutionConflictError(
      'the Tool StepRun is not startable',
    );
  }
  const startedAtMs = clock(dependencies.now);
  if (
    startedAtMs < plan.plannedAtMs ||
    startedAtMs + authority.plan.timeoutSeconds * 1_000 > plan.deadlineAtMs
  ) {
    throw new CopilotFailureDiagnosisToolExecutionDeadlineExceededError();
  }
  const evidence = createToolExecutionEvidenceBundle({
    traceId: traceIdentity(plan.planDigest),
    spanId: spanIdentity(plan.planDigest),
    projectId: plan.projectId,
    runId: plan.runId,
    stepRunId: plan.toolStepRunId,
    invocationPlanDigest: authority.plan.planDigest,
    bindingDigest: authority.binding.bindingDigest,
    adapterDigest: trustedToolContractIdentityDigest(authority.binding.adapter),
    redactionContractDigest: trustedToolContractIdentityDigest(
      authority.binding.redactionContract,
    ),
    auditContractDigest: trustedToolContractIdentityDigest(
      authority.binding.auditContract,
    ),
    audit: {
      eventId: auditEventIdentity(plan.planDigest),
      requestId: plan.requestId,
      operationId: TOOL_EXECUTION_START_AUDIT_OPERATION,
      projectId: plan.projectId,
      subject: plan.requestedBySubject,
      authenticationId: input.principal.authenticationId,
      outcome: 'allowed',
      reasons: ['copilot_failure_diagnosis_tool_start'],
      fence: plan.policyFence,
      occurredAtMs: startedAtMs,
    },
    createdAtMs: startedAtMs,
  });
  const admission = await admitTrustedToolExecution(
    authority.bindings,
    authority.plan,
    {
      principal: input.principal,
      profile: 'cluster-control',
      nowMs: startedAtMs,
      authorizer: input.authorizer,
      evidence: {
        stepRun: {
          id: stepRun.id,
          version: stepRun.version,
          digest: stepRun.stepRunDigest,
        },
        ...toolExecutionAdmissionEvidence(evidence),
      },
    },
  );
  const mutationId = identity('cdstm', plan.planDigest);
  const eventId = identity('cdste', plan.planDigest);
  const mutation = transitionStepRunMutation(
    stepRun,
    {
      expectedVersion: stepRun.version,
      expectedDigest: stepRun.stepRunDigest,
      mutationId,
      to: 'running',
      atMs: startedAtMs,
    },
    {
      expectedRunVersion: run.version,
      expectedRunEventSequence: run.eventSequence,
      eventId,
      dedupeKey: eventId,
      actor: plan.requestedBySubject,
    },
  );
  const command = createToolExecutionStartCommand({
    startId,
    admission,
    evidence,
    stepRunMutation: mutation,
  });
  try {
    const prepared = await dependencies.barriers.prepare(command);
    if (!['created', 'existing'].includes(prepared.status)) {
      return unavailable();
    }
    return barrierMatches(prepared.barrier, plan, startId);
  } catch (cause) {
    let recovered;
    try {
      recovered = await dependencies.barriers.findByStartId(startId);
    } catch {
      throw cause;
    }
    if (recovered) return barrierMatches(recovered, plan, startId);
    throw cause;
  }
}

function completionIdentities(planDigest: string) {
  return Object.freeze({
    success: Object.freeze({
      create() {
        return Object.freeze({
          artifactId: identity('cdra', planDigest),
          mutationId: identity('cdscm', planDigest),
          eventId: identity('cdsce', planDigest),
        });
      },
    }),
    failure: Object.freeze({
      create() {
        return Object.freeze({
          mutationId: identity('cdfcm', planDigest),
          eventId: identity('cdfce', planDigest),
        });
      },
    }),
  });
}

async function unlockModel(
  plan: Awaited<ReturnType<typeof durablePlan>>,
  completion: Parameters<
    typeof createCopilotFailureDiagnosisToolUnlockCommand
  >[0]['completion'],
  dependencies: CopilotFailureDiagnosisToolExecutionDependencies,
) {
  let existing;
  try {
    existing = await dependencies.unlocks.findByRequestId(plan.requestId);
  } catch (cause) {
    return unavailable(cause);
  }
  if (existing) {
    if (
      existing.planDigest !== plan.planDigest ||
      existing.toolCompletionDigest !== completion.completionDigest
    ) {
      throw new CopilotFailureDiagnosisToolExecutionConflictError(
        'the durable model unlock changed',
      );
    }
    return Object.freeze({ status: 'existing' as const, receipt: existing });
  }
  let modelStepRun;
  let run;
  try {
    [modelStepRun, run] = await Promise.all([
      dependencies.stepRuns.findById(plan.modelStepRunId),
      dependencies.runs.findRunById(plan.runId),
    ]);
  } catch (cause) {
    return unavailable(cause);
  }
  if (!modelStepRun || !run) return unavailable();
  const command = createCopilotFailureDiagnosisToolUnlockCommand({
    plan,
    completion,
    modelStepRun,
    run: {
      id: run.id,
      projectId: run.projectId,
      status: run.status,
      version: run.version,
      eventSequence: run.eventSequence,
    },
  });
  try {
    return await dependencies.unlocks.commit(command);
  } catch (cause) {
    let recovered;
    try {
      recovered = await dependencies.unlocks.findByRequestId(plan.requestId);
    } catch {
      throw cause;
    }
    if (
      recovered &&
      recovered.planDigest === plan.planDigest &&
      recovered.toolCompletionDigest === completion.completionDigest
    ) {
      return Object.freeze({
        status: 'existing' as const,
        receipt: recovered,
      });
    }
    throw cause;
  }
}

export async function executeCopilotFailureDiagnosisTool(
  input: ExecuteCopilotFailureDiagnosisToolInput,
  dependencies: CopilotFailureDiagnosisToolExecutionDependencies,
): Promise<Readonly<CopilotFailureDiagnosisToolExecutionResult>> {
  assertDependencies(dependencies);
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input.requestId !== 'string' ||
    typeof input.authorizer?.authorize !== 'function'
  ) {
    return invalid('input is invalid');
  }
  const plan = await durablePlan(input.requestId, dependencies);
  const authority = await currentAuthority(plan, dependencies);
  const startId = identity('cds', plan.planDigest);
  const barrier = await prepareStart(
    plan,
    input,
    authority,
    dependencies,
    startId,
  );
  const definitions = authority.bindings.definitionRegistry();
  const adapters = new TrustedToolExecutionAdapterRegistry(authority.bindings, [
    new BuiltInRunLogExcerptToolAdapter(
      authority.binding,
      'cluster-control',
      definitions,
      dependencies.logs,
    ),
  ]);
  const ids = completionIdentities(plan.planDigest);
  const completed = await executeAndCompleteTrustedTool(barrier.startId, {
    barriers: dependencies.barriers,
    artifacts: dependencies.artifacts,
    keys: dependencies.invocationKeys,
    adapters,
    completions: dependencies.completions,
    failureCompletions: dependencies.failureCompletions,
    stepRuns: dependencies.stepRuns,
    runs: dependencies.runs,
    resultKeyCatalog: dependencies.resultKeyCatalog,
    resultRekeys: dependencies.resultRekeys,
    resultKeys: dependencies.resultKeys,
    identities: ids.success,
    failureIdentities: ids.failure,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.nonceFactory === undefined
      ? {}
      : { nonceFactory: dependencies.nonceFactory }),
  });
  if (completed.outcome !== 'succeeded') {
    return Object.freeze({
      outcome: completed.outcome,
      completionStatus: completed.status,
      unlockStatus: null,
      completion: completed.completion,
    });
  }
  const unlock = await unlockModel(plan, completed.completion, dependencies);
  return Object.freeze({
    outcome: 'succeeded' as const,
    completionStatus: completed.status,
    unlockStatus: unlock.status,
    completion: completed.completion,
    output: completed.output,
    unlock: unlock.receipt,
  });
}
