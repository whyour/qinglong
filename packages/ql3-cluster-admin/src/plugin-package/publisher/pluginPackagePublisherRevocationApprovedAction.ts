// Cluster Plugin Package publisher boundary; keep Approved Action authority explicit.
import {
  type ApprovedActionHandler,
  type ApprovedActionHandlerExecutionContext,
  type ApprovedActionHandlerInspection,
  type ApprovedActionHandlerResult,
} from '@qinglong/runtime-core/approved-action-dispatcher';
import {
  PLUGIN_PACKAGE_PUBLISHER_REVOCATION_ACTION_TYPE,
  PluginPackagePublisherRevocationProposalBindingConflictError,
  normalizePluginPackagePublisherRevocationProposal,
  resolvePluginPackagePublisherRevocationProposal,
  type PluginPackagePublisherRevocationProposalRepository,
} from '@qinglong/runtime-core/plugin-package-publisher-revocation-proposal';
import type {
  PluginPackagePublisherRevocationReceipt,
} from '@qinglong/runtime-core/plugin-package-publisher-provenance';

export interface ClusterPluginPackagePublisherRevocationExecutionResult {
  readonly safeToAdmit: boolean;
  readonly receiptDigest: string;
  readonly impactDigest: string;
}

export interface ClusterPluginPackagePublisherRevocationExecutionPort {
  run(
    receipt: Readonly<PluginPackagePublisherRevocationReceipt>,
  ): Promise<
    Readonly<ClusterPluginPackagePublisherRevocationExecutionResult>
  >;
}

export class ClusterPluginPackagePublisherRevocationApprovedActionHandler
  implements ApprovedActionHandler
{
  readonly actionType = PLUGIN_PACKAGE_PUBLISHER_REVOCATION_ACTION_TYPE;

  constructor(
    readonly proposals: PluginPackagePublisherRevocationProposalRepository,
    readonly revocations: ClusterPluginPackagePublisherRevocationExecutionPort,
  ) {
    if (
      !proposals ||
      typeof proposals.findProposalByActionRef !== 'function' ||
      !revocations ||
      typeof revocations.run !== 'function'
    ) {
      throw new TypeError(
        'publisher revocation Approved Action authority is invalid',
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
        resultCode: 'publisher_revocation_proposal_unavailable',
      });
    }
    if (!proposal) {
      return Object.freeze({
        status: 'blocked',
        resultCode: 'publisher_revocation_proposal_missing',
      });
    }
    try {
      const normalized =
        normalizePluginPackagePublisherRevocationProposal(proposal);
      resolvePluginPackagePublisherRevocationProposal(
        normalized,
        dispatch,
        dispatch.createdAtMs,
      );
      return Object.freeze({
        status: 'ready',
        actionDigest: normalized.actionDigest,
      });
    } catch {
      return Object.freeze({
        status: 'blocked',
        resultCode: 'publisher_revocation_proposal_rejected',
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
        resultCode: 'publisher_revocation_execution_rejected',
      });
    }
    const proposal = await this.proposals.findProposalByActionRef(
      context.dispatch.action.actionRef,
    );
    if (!proposal) {
      return Object.freeze({
        outcome: 'failed',
        resultCode: 'publisher_revocation_proposal_missing',
      });
    }
    let receipt;
    try {
      receipt = resolvePluginPackagePublisherRevocationProposal(
        proposal,
        context.dispatch,
        startedAtMs,
      );
    } catch (error) {
      if (
        error instanceof
        PluginPackagePublisherRevocationProposalBindingConflictError
      ) {
        return Object.freeze({
          outcome: 'failed',
          resultCode: 'publisher_revocation_proposal_rejected',
        });
      }
      throw error;
    }
    const result = await this.revocations.run(receipt);
    if (!result.safeToAdmit) {
      return Object.freeze({
        outcome: 'indeterminate',
        resultCode: 'publisher_revocation_convergence_incomplete',
      });
    }
    if (
      result.receiptDigest !== receipt.receiptDigest ||
      !/^[0-9a-f]{64}$/.test(result.impactDigest)
    ) {
      return Object.freeze({
        outcome: 'failed',
        resultCode: 'publisher_revocation_result_rejected',
      });
    }
    return Object.freeze({
      outcome: 'succeeded',
      resultCode: 'publisher_revocation_converged',
      resultDigest: result.impactDigest,
    });
  }
}
