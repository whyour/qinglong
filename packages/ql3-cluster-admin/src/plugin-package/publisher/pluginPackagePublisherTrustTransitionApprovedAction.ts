// Cluster Plugin Package publisher boundary; keep transition execution authority explicit.
import {
  type ApprovedActionHandler,
  type ApprovedActionHandlerExecutionContext,
  type ApprovedActionHandlerInspection,
  type ApprovedActionHandlerResult,
} from '@qinglong/runtime-core/approved-action-dispatcher';
import {
  PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_ACTION_TYPES,
  PluginPackagePublisherTrustTransitionBindingConflictError,
  PluginPackagePublisherTrustTransitionConflictError,
  normalizePluginPackagePublisherTrustTransitionProposal,
  resolvePluginPackagePublisherTrustTransitionProposal,
  type PluginPackagePublisherTrustTransitionMode,
  type PluginPackagePublisherTrustTransitionProposalRepository,
  type PluginPackagePublisherTrustTransitionReceipt,
} from '@qinglong/runtime-core/plugin-package-publisher-trust-transition-proposal';

export interface ClusterPluginPackagePublisherTrustTransitionExecutionResult {
  readonly status: 'created' | 'existing';
  readonly receipt: Readonly<PluginPackagePublisherTrustTransitionReceipt>;
  readonly head: Readonly<{
    generation: number;
    effectiveTrustDigest: string;
  }>;
}

export interface ClusterPluginPackagePublisherTrustTransitionExecutionPort {
  applyApprovedTransition(
    input: Readonly<{
      dispatch: ApprovedActionHandlerExecutionContext['dispatch'];
      executedAtMs: number;
    }>,
  ): Promise<
    Readonly<ClusterPluginPackagePublisherTrustTransitionExecutionResult>
  >;
}

export class ClusterPluginPackagePublisherTrustTransitionApprovedActionHandler
  implements ApprovedActionHandler
{
  readonly actionType:
    (typeof PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_ACTION_TYPES)[PluginPackagePublisherTrustTransitionMode];

  constructor(
    readonly mode: PluginPackagePublisherTrustTransitionMode,
    readonly proposals: PluginPackagePublisherTrustTransitionProposalRepository,
    readonly transitions: ClusterPluginPackagePublisherTrustTransitionExecutionPort,
  ) {
    this.actionType =
      PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_ACTION_TYPES[mode];
    if (
      (mode !== 'overlap_add' && mode !== 'safe_retire') ||
      !proposals ||
      typeof proposals.findProposalByActionRef !== 'function' ||
      !transitions ||
      typeof transitions.applyApprovedTransition !== 'function'
    ) {
      throw new TypeError(
        'publisher trust transition Approved Action authority is invalid',
      );
    }
  }

  async inspect(
    dispatch: ApprovedActionHandlerExecutionContext['dispatch'],
  ): Promise<ApprovedActionHandlerInspection> {
    let proposal;
    try {
      proposal = await this.proposals.findProposalByActionRef(
        dispatch.action.actionRef,
      );
    } catch {
      return Object.freeze({
        status: 'retry',
        resultCode: 'publisher_trust_transition_proposal_unavailable',
      });
    }
    if (!proposal) {
      return Object.freeze({
        status: 'blocked',
        resultCode: 'publisher_trust_transition_proposal_missing',
      });
    }
    try {
      const normalized =
        normalizePluginPackagePublisherTrustTransitionProposal(proposal);
      if (
        normalized.actionInput.mode !== this.mode ||
        normalized.actionType !== this.actionType
      ) {
        throw new PluginPackagePublisherTrustTransitionBindingConflictError();
      }
      resolvePluginPackagePublisherTrustTransitionProposal(
        normalized,
        dispatch,
        dispatch.createdAtMs,
        this.mode === 'safe_retire' ? 0 : null,
      );
      return Object.freeze({
        status: 'ready',
        actionDigest: normalized.actionDigest,
      });
    } catch {
      return Object.freeze({
        status: 'blocked',
        resultCode: 'publisher_trust_transition_proposal_rejected',
      });
    }
  }

  async execute(
    context: Readonly<ApprovedActionHandlerExecutionContext>,
  ): Promise<Readonly<ApprovedActionHandlerResult>> {
    const startedAtMs = context.execution.startedAtMs;
    if (
      context.execution.status !== 'executing' ||
      startedAtMs === null ||
      context.execution.leaseOwner !== context.fence.owner ||
      context.execution.leaseToken !== context.fence.leaseToken ||
      context.execution.version !== context.fence.version
    ) {
      return Object.freeze({
        outcome: 'failed',
        resultCode: 'publisher_trust_transition_execution_rejected',
      });
    }
    try {
      const result = await this.transitions.applyApprovedTransition({
        dispatch: context.dispatch,
        executedAtMs: startedAtMs,
      });
      if (
        result.receipt.mode !== this.mode ||
        result.receipt.mutationId !== context.dispatch.id ||
        result.head.generation !== result.receipt.currentGeneration ||
        result.head.effectiveTrustDigest !==
          result.receipt.currentTrustDigest
      ) {
        return Object.freeze({
          outcome: 'failed',
          resultCode: 'publisher_trust_transition_result_rejected',
        });
      }
      return Object.freeze({
        outcome: 'succeeded',
        resultCode:
          this.mode === 'overlap_add'
            ? 'publisher_trust_overlap_added'
            : 'publisher_trust_key_retired',
        resultDigest: result.receipt.receiptDigest,
      });
    } catch (error) {
      if (
        error instanceof
        PluginPackagePublisherTrustTransitionBindingConflictError ||
        error instanceof PluginPackagePublisherTrustTransitionConflictError
      ) {
        return Object.freeze({
          outcome: 'failed',
          resultCode: 'publisher_trust_transition_conflict',
        });
      }
      throw error;
    }
  }
}
