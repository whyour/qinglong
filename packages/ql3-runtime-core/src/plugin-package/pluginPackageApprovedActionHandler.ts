import { createHash } from 'node:crypto';

import {
  PLUGIN_PACKAGE_ADMISSION_AUDIT_OPERATION,
  PLUGIN_PACKAGE_ADMISSION_AUDIT_REASON,
  PLUGIN_PACKAGE_INSTALL_ACTION_TYPE,
  PluginPackageAdmissionBindingConflictError,
  PluginPackageAdmissionReceiptConflictError,
  assertPluginPackageAdmissionReplay,
  type PluginPackageAdmissionRepository,
  type PluginPackageAdmissionRequest,
} from './installation/pluginPackageAdmission';
import type {
  ApprovedActionHandler,
  ApprovedActionHandlerExecutionContext,
  ApprovedActionHandlerInspection,
  ApprovedActionHandlerResult,
} from '../approved-action/approvedActionDispatcher';
import {
  PluginPackageInstallProposalBindingConflictError,
  normalizePluginPackageInstallProposal,
  resolvePluginPackageInstallProposal,
  type PluginPackageInstallProposalRepository,
} from './pluginPackageProposal';
import type { SecurityAuditRecord } from '../security/audit/securityAudit';

function stableDigest(domain: string, dispatchId: string): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(dispatchId)
    .digest('hex');
}

function stableIdentifier(domain: string, dispatchId: string): string {
  return `ppa-${stableDigest(domain, dispatchId)}`;
}

function stableAuditEventId(dispatchId: string): string {
  const bytes = Buffer.from(
    stableDigest('qinglong/plugin-package-admission-audit-id@v1', dispatchId),
    'hex',
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class PluginPackageApprovedActionHandler
  implements ApprovedActionHandler
{
  readonly actionType = PLUGIN_PACKAGE_INSTALL_ACTION_TYPE;

  constructor(
    readonly proposals: PluginPackageInstallProposalRepository,
    readonly admissions: PluginPackageAdmissionRepository,
  ) {
    if (
      !proposals ||
      typeof proposals.findProposalByActionRef !== 'function' ||
      !admissions ||
      typeof admissions.admit !== 'function' ||
      typeof admissions.findAdmissionReceipt !== 'function' ||
      typeof admissions.find !== 'function'
    ) {
      throw new TypeError('Plugin Package Approved Action authority is invalid');
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
        resultCode: 'package_proposal_unavailable',
      });
    }
    if (!proposal) {
      return Object.freeze({
        status: 'blocked',
        resultCode: 'package_proposal_missing',
      });
    }
    try {
      const normalized = normalizePluginPackageInstallProposal(proposal);
      resolvePluginPackageInstallProposal(
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
        resultCode: 'package_proposal_rejected',
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
        resultCode: 'package_execution_rejected',
      });
    }

    const proposal = await this.proposals.findProposalByActionRef(
      context.dispatch.action.actionRef,
    );
    if (!proposal) {
      return Object.freeze({
        outcome: 'failed',
        resultCode: 'package_proposal_missing',
      });
    }
    let lock;
    try {
      lock = resolvePluginPackageInstallProposal(
        proposal,
        context.dispatch,
        startedAtMs,
      );
    } catch (error) {
      if (error instanceof PluginPackageInstallProposalBindingConflictError) {
        return Object.freeze({
          outcome: 'failed',
          resultCode: 'package_proposal_rejected',
        });
      }
      throw error;
    }

    const installationId = stableIdentifier(
      'qinglong/plugin-package-admission-installation-id@v1',
      context.dispatch.id,
    );
    const mutationId = stableIdentifier(
      'qinglong/plugin-package-admission-mutation-id@v1',
      context.dispatch.id,
    );
    const audit: SecurityAuditRecord = Object.freeze({
      eventId: stableAuditEventId(context.dispatch.id),
      requestId: context.dispatch.id,
      operationId: PLUGIN_PACKAGE_ADMISSION_AUDIT_OPERATION,
      projectId: context.dispatch.projectId,
      subject: context.dispatch.consumedBy,
      authenticationId: context.dispatch.approvalAuthenticationId,
      outcome: 'allowed',
      reasons: Object.freeze([PLUGIN_PACKAGE_ADMISSION_AUDIT_REASON]),
      fence: context.dispatch.approvalFence,
      occurredAtMs: startedAtMs,
    });
    const request: PluginPackageAdmissionRequest = Object.freeze({
      lock,
      proposalDigest: proposal.proposalDigest,
      execution: context.execution,
      installationId,
      mutationId,
      admittedAtMs: startedAtMs,
      audit,
    });

    try {
      const result = await this.admissions.admit(request);
      return Object.freeze({
        outcome: 'succeeded',
        resultCode: 'package_admitted',
        resultDigest: result.receipt.receiptDigest,
      });
    } catch (error) {
      if (
        error instanceof PluginPackageAdmissionBindingConflictError ||
        error instanceof PluginPackageAdmissionReceiptConflictError
      ) {
        return Object.freeze({
          outcome: 'failed',
          resultCode: 'package_admission_rejected',
        });
      }
      const receipt = await this.admissions.findAdmissionReceipt(
        context.dispatch.id,
      );
      if (!receipt) throw error;
      const record = await this.admissions.find(
        lock.projectId,
        lock.packageName,
      );
      if (!record || record.installationId !== installationId) throw error;
      assertPluginPackageAdmissionReplay(
        context.dispatch,
        proposal,
        request,
        receipt,
        record,
      );
      return Object.freeze({
        outcome: 'succeeded',
        resultCode: 'package_admitted',
        resultDigest: receipt.receiptDigest,
      });
    }
  }
}
