import { RUN_STATUSES, type RunStatus } from '@qinglong/runtime-core';
import type {
  ClusterRunCancellationRepository,
  ClusterRunCancellationResult,
} from '@qinglong/runtime-core/cluster-run-cancellation';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';

import type {
  CopilotFailureDiagnosisAdmissionRepository,
  CopilotFailureDiagnosisAdmissionReceipt,
  CopilotFailureDiagnosisExecutionPlan,
} from '../admission/contracts';
import { normalizeCopilotFailureDiagnosisAdmissionReceipt } from '../admission/durableEvidence';
import { normalizeCopilotFailureDiagnosisExecutionPlan } from '../admission/plan';
import {
  terminalizeCopilotFailureDiagnosisBeforeModel,
  type CopilotFailureDiagnosisPreModelTerminalizationDependencies,
} from '../terminalization/coordinator';
import {
  CopilotFailureDiagnosisPreModelTerminalizationConflictError,
  CopilotFailureDiagnosisPreModelTerminalizationNotReadyError,
  CopilotFailureDiagnosisPreModelTerminalizationUnavailableError,
} from '../terminalization/contracts';

export const COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_RESULT_SCHEMA =
  'qinglong/copilot-failure-diagnosis-cancellation-result@v1' as const;

export interface CopilotFailureDiagnosisCancellationCommand {
  readonly projectId: string;
  readonly sourceRunId: string;
  readonly requestId: string;
  readonly mutationId: string;
  readonly eventId: string;
  readonly subject: Readonly<SecuritySubject>;
  readonly policyFence: Readonly<SecurityPolicyFence>;
}

export interface CopilotFailureDiagnosisCancellationResult {
  readonly schema: typeof COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_RESULT_SCHEMA;
  readonly status: ClusterRunCancellationResult['status'];
  readonly convergence: 'terminal' | 'model_in_flight';
  readonly projectId: string;
  readonly sourceRunId: string;
  readonly requestId: string;
  readonly diagnosisRunId: string;
  readonly runStatus: RunStatus;
  readonly outcome: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | null;
  readonly runVersion: number;
  readonly eventSequence: number;
  readonly cancelRequestedAtMs: number | null;
  readonly cancelReason:
    | 'user'
    | 'policy'
    | 'shutdown'
    | 'reconcile'
    | 'timeout'
    | null;
}

export interface CopilotFailureDiagnosisCancellationDependencies {
  readonly admissions: Pick<
    CopilotFailureDiagnosisAdmissionRepository,
    'findByRequestId' | 'findPlanByRequestId'
  >;
  readonly cancellations: ClusterRunCancellationRepository;
  readonly terminalizations: CopilotFailureDiagnosisPreModelTerminalizationDependencies;
  readonly terminalizeBeforeModel?: typeof terminalizeCopilotFailureDiagnosisBeforeModel;
}

export class InvalidCopilotFailureDiagnosisCancellationError extends TypeError {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_INVALID';

  constructor() {
    super('Copilot failure diagnosis cancellation is invalid');
    this.name = 'InvalidCopilotFailureDiagnosisCancellationError';
  }
}

export class CopilotFailureDiagnosisCancellationNotFoundError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_NOT_FOUND';

  constructor() {
    super('Copilot failure diagnosis cancellation target does not exist');
    this.name = 'CopilotFailureDiagnosisCancellationNotFoundError';
  }
}

export class CopilotFailureDiagnosisCancellationUnavailableError extends Error {
  readonly code = 'COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Copilot failure diagnosis cancellation is unavailable', options);
    this.name = 'CopilotFailureDiagnosisCancellationUnavailableError';
  }
}

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const TERMINAL = new Set<RunStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

function unavailable(cause?: unknown): never {
  throw new CopilotFailureDiagnosisCancellationUnavailableError({
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

function command(
  value: CopilotFailureDiagnosisCancellationCommand,
): Readonly<CopilotFailureDiagnosisCancellationCommand> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'eventId',
      'mutationId',
      'policyFence',
      'projectId',
      'requestId',
      'sourceRunId',
      'subject',
    ]) ||
    !IDENTITY.test(value.projectId) ||
    !RUN_ID.test(value.sourceRunId) ||
    !IDENTITY.test(value.requestId) ||
    !IDENTITY.test(value.mutationId) ||
    !IDENTITY.test(value.eventId) ||
    !value.subject ||
    typeof value.subject !== 'object' ||
    !value.policyFence ||
    typeof value.policyFence !== 'object'
  ) {
    throw new InvalidCopilotFailureDiagnosisCancellationError();
  }
  return Object.freeze({ ...value });
}

function evidenceMatches(
  plan: Readonly<CopilotFailureDiagnosisExecutionPlan>,
  receipt: Readonly<CopilotFailureDiagnosisAdmissionReceipt>,
): boolean {
  return (
    receipt.requestId === plan.requestId &&
    receipt.planDigest === plan.planDigest &&
    receipt.runId === plan.runId &&
    receipt.sourceRunId === plan.source.runId &&
    receipt.sourceRunVersion === plan.source.runVersion &&
    receipt.sourceAttemptId === plan.source.attemptId &&
    receipt.toolStepRunId === plan.toolStepRunId &&
    receipt.modelStepRunId === plan.modelStepRunId
  );
}

function targetMatches(
  plan: Readonly<CopilotFailureDiagnosisExecutionPlan>,
  value: Readonly<CopilotFailureDiagnosisCancellationCommand>,
): boolean {
  return (
    plan.projectId === value.projectId &&
    plan.source.runId === value.sourceRunId &&
    plan.requestId === value.requestId
  );
}

function result(
  target: Readonly<CopilotFailureDiagnosisCancellationCommand>,
  cancellation: Readonly<ClusterRunCancellationResult>,
  state: Readonly<{
    convergence: CopilotFailureDiagnosisCancellationResult['convergence'];
    runStatus: RunStatus;
    runVersion: number;
    eventSequence: number;
    cancelRequestedAtMs?: number;
    cancelReason?: NonNullable<
      CopilotFailureDiagnosisCancellationResult['cancelReason']
    >;
  }>,
): Readonly<CopilotFailureDiagnosisCancellationResult> {
  if (
    cancellation.projectId !== target.projectId ||
    !RUN_STATUSES.includes(state.runStatus) ||
    !Number.isSafeInteger(state.runVersion) ||
    state.runVersion < 0 ||
    !Number.isSafeInteger(state.eventSequence) ||
    state.eventSequence < 0 ||
    (state.convergence === 'terminal') !== TERMINAL.has(state.runStatus) ||
    (state.convergence === 'model_in_flight' && state.runStatus !== 'running')
  ) {
    return unavailable();
  }
  return Object.freeze({
    schema: COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_RESULT_SCHEMA,
    status: cancellation.status,
    convergence: state.convergence,
    projectId: target.projectId,
    sourceRunId: target.sourceRunId,
    requestId: target.requestId,
    diagnosisRunId: cancellation.runId,
    runStatus: state.runStatus,
    outcome: TERMINAL.has(state.runStatus)
      ? (state.runStatus as 'succeeded' | 'failed' | 'timed_out' | 'cancelled')
      : null,
    runVersion: state.runVersion,
    eventSequence: state.eventSequence,
    cancelRequestedAtMs: state.cancelRequestedAtMs ?? null,
    cancelReason: state.cancelReason ?? null,
  });
}

/**
 * Resolves an external request key to its server-owned diagnosis Run, writes
 * one ordinary Run cancellation intent, then converges only while no Model
 * invocation start exists.
 */
export class CopilotFailureDiagnosisCancellationService {
  readonly #dependencies: Readonly<CopilotFailureDiagnosisCancellationDependencies>;
  readonly #terminalize: typeof terminalizeCopilotFailureDiagnosisBeforeModel;

  constructor(dependencies: CopilotFailureDiagnosisCancellationDependencies) {
    if (
      !dependencies ||
      typeof dependencies !== 'object' ||
      Array.isArray(dependencies) ||
      typeof dependencies.admissions?.findByRequestId !== 'function' ||
      typeof dependencies.admissions?.findPlanByRequestId !== 'function' ||
      typeof dependencies.cancellations?.requestUserCancellation !==
        'function' ||
      typeof dependencies.terminalizations?.repository?.findByRequestId !==
        'function' ||
      typeof dependencies.terminalizations?.repository?.readAuthority !==
        'function' ||
      typeof dependencies.terminalizations?.repository?.commit !== 'function' ||
      (dependencies.terminalizeBeforeModel !== undefined &&
        typeof dependencies.terminalizeBeforeModel !== 'function')
    ) {
      throw new InvalidCopilotFailureDiagnosisCancellationError();
    }
    this.#dependencies = Object.freeze({ ...dependencies });
    this.#terminalize =
      dependencies.terminalizeBeforeModel ??
      terminalizeCopilotFailureDiagnosisBeforeModel;
  }

  async cancel(
    value: CopilotFailureDiagnosisCancellationCommand,
  ): Promise<Readonly<CopilotFailureDiagnosisCancellationResult>> {
    const target = command(value);
    let plan: Readonly<CopilotFailureDiagnosisExecutionPlan> | null;
    let receipt: Readonly<CopilotFailureDiagnosisAdmissionReceipt> | null;
    try {
      const located = await Promise.all([
        this.#dependencies.admissions.findPlanByRequestId(target.requestId),
        this.#dependencies.admissions.findByRequestId(target.requestId),
      ]);
      plan = located[0]
        ? normalizeCopilotFailureDiagnosisExecutionPlan(located[0])
        : null;
      receipt = located[1]
        ? normalizeCopilotFailureDiagnosisAdmissionReceipt(located[1])
        : null;
    } catch (cause) {
      return unavailable(cause);
    }
    if (!plan || !receipt || !targetMatches(plan, target)) {
      throw new CopilotFailureDiagnosisCancellationNotFoundError();
    }
    if (!evidenceMatches(plan, receipt)) return unavailable();

    const cancellation =
      await this.#dependencies.cancellations.requestUserCancellation({
        projectId: target.projectId,
        runId: plan.runId,
        mutationId: target.mutationId,
        eventId: target.eventId,
        subject: target.subject,
        policyFence: target.policyFence,
      });
    if (
      cancellation.projectId !== target.projectId ||
      cancellation.runId !== plan.runId
    ) {
      return unavailable();
    }
    if (TERMINAL.has(cancellation.runStatus)) {
      return result(target, cancellation, {
        convergence: 'terminal',
        runStatus: cancellation.runStatus,
        runVersion: cancellation.runVersion,
        eventSequence: cancellation.eventSequence,
        ...(cancellation.cancelRequestedAtMs === undefined
          ? {}
          : { cancelRequestedAtMs: cancellation.cancelRequestedAtMs }),
        ...(cancellation.cancelReason === undefined
          ? {}
          : { cancelReason: cancellation.cancelReason }),
      });
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const terminalized = await this.#terminalize(
          target.requestId,
          { kind: 'boundary' },
          this.#dependencies.terminalizations,
        );
        return result(target, cancellation, {
          convergence: 'terminal',
          runStatus: terminalized.receipt.outcome,
          runVersion: terminalized.receipt.finalRunVersion,
          eventSequence: terminalized.receipt.finalRunEventSequence,
          ...(cancellation.cancelRequestedAtMs === undefined
            ? {}
            : { cancelRequestedAtMs: cancellation.cancelRequestedAtMs }),
          ...(cancellation.cancelReason === undefined
            ? {}
            : { cancelReason: cancellation.cancelReason }),
        });
      } catch (cause) {
        if (
          !(
            cause instanceof
            CopilotFailureDiagnosisPreModelTerminalizationConflictError
          ) &&
          !(
            cause instanceof
            CopilotFailureDiagnosisPreModelTerminalizationNotReadyError
          )
        ) {
          if (
            cause instanceof
            CopilotFailureDiagnosisPreModelTerminalizationUnavailableError
          ) {
            return unavailable(cause);
          }
          return unavailable(cause);
        }
      }

      try {
        const authority =
          await this.#dependencies.terminalizations.repository.readAuthority(
            target.requestId,
          );
        if (
          !targetMatches(authority.plan, target) ||
          authority.plan.planDigest !== plan.planDigest ||
          authority.run.id !== plan.runId ||
          authority.run.projectId !== target.projectId ||
          authority.run.version !== authority.run.eventSequence
        ) {
          return unavailable();
        }
        if (TERMINAL.has(authority.run.status)) {
          return result(target, cancellation, {
            convergence: 'terminal',
            runStatus: authority.run.status,
            runVersion: authority.run.version,
            eventSequence: authority.run.eventSequence,
            ...(authority.run.cancelRequestedAtMs === undefined
              ? {}
              : { cancelRequestedAtMs: authority.run.cancelRequestedAtMs }),
            ...(authority.run.cancelReason === undefined
              ? {}
              : { cancelReason: authority.run.cancelReason }),
          });
        }
        if (
          authority.run.status === 'running' &&
          authority.modelStartExists &&
          authority.run.cancelRequestedAtMs !== undefined &&
          authority.run.cancelReason !== undefined
        ) {
          return result(target, cancellation, {
            convergence: 'model_in_flight',
            runStatus: 'running',
            runVersion: authority.run.version,
            eventSequence: authority.run.eventSequence,
            cancelRequestedAtMs: authority.run.cancelRequestedAtMs,
            cancelReason: authority.run.cancelReason,
          });
        }
        if (
          attempt === 0 &&
          authority.run.status === 'running' &&
          !authority.modelStartExists &&
          authority.run.cancelRequestedAtMs !== undefined &&
          authority.run.cancelReason !== undefined
        ) {
          continue;
        }
        return unavailable();
      } catch (cause) {
        return unavailable(cause);
      }
    }
    return unavailable();
  }
}
