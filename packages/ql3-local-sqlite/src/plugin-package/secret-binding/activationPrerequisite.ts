import type { DatabaseSync } from 'node:sqlite';

import {
  normalizePluginPackageInstallProposal,
  type PluginPackageInstallProposal,
} from '@qinglong/runtime-core/plugin-package-proposal';
import {
  assertPluginPackageInstallMatchesLock,
  normalizePluginPackageInstallRecord,
  normalizePluginPackageLock,
  type PluginPackageInstallRecord,
  type PluginPackageLock,
} from '@qinglong/runtime-core/plugin-package-install';
import type {
  PluginPackageActivationPrerequisite,
  PluginPackageActivationPrerequisiteObservation,
} from '@qinglong/runtime-core/plugin-package-installation';
import { createPluginPackageResourceGenerationFromReferences } from '@qinglong/runtime-core/plugin-package-resource-generation';
import { createPluginPackageSecretBindingTarget } from '@qinglong/runtime-core/plugin-package-secret-binding';

import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';
import { LocalSqlitePluginPackageSecretBindingTransitionReceiptRepository } from './transitionReceiptRepository';

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error('Secret binding activation prerequisite is unavailable');
  }
  return value;
}

export class LocalSqlitePluginPackageSecretBindingActivationPrerequisite
  implements PluginPackageActivationPrerequisite
{
  readonly #authority: LocalSqliteOperationAuthority;
  readonly #receipts: LocalSqlitePluginPackageSecretBindingTransitionReceiptRepository;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.#authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
    this.#receipts =
      new LocalSqlitePluginPackageSecretBindingTransitionReceiptRepository(
        this.#authority,
      );
  }

  async inspect(
    recordValue: Readonly<PluginPackageInstallRecord>,
    lockValue: Readonly<PluginPackageLock>,
  ): Promise<Readonly<PluginPackageActivationPrerequisiteObservation>> {
    const record = normalizePluginPackageInstallRecord(recordValue);
    const lock = normalizePluginPackageLock(lockValue);
    assertPluginPackageInstallMatchesLock(lock, record);
    if (record.state !== 'staged') {
      throw new Error(
        'Secret binding activation prerequisite requires staged install',
      );
    }
    if (record.previousActiveLockDigest === null) {
      return Object.freeze({ status: 'ready' as const });
    }
    return this.#authority.enqueue(
      async () => {
        const row = this.#authority.client
          .prepare(
            `SELECT proposal.proposal_json AS "proposalJson",
                  EXISTS (
                    SELECT 1
                      FROM "QingLong3PluginPackageInstalls" AS previous
                      JOIN "QingLong3PluginPackageSecretBindings" AS binding
                        ON binding.installation_id = previous.installation_id
                     WHERE previous.project_id = install.project_id
                       AND previous.package_name = install.package_name
                       AND previous.lock_digest = install.previous_active_lock_digest
                  ) AS "previousBindingPresent"
           FROM "QingLong3PluginPackageInstallHeads" AS head
           JOIN "QingLong3PluginPackageInstalls" AS install
             ON install.installation_id = head.installation_id
           JOIN "QingLong3PluginPackageAdmissionReceipts" AS admission
             ON admission.installation_id = install.installation_id
           JOIN "QingLong3PluginPackageInstallProposals" AS proposal
             ON proposal.action_ref = admission.action_ref
           WHERE head.project_id = ? AND head.package_name = ?
             AND install.installation_id = ? AND install.lock_digest = ?
             AND install.state = 'staged'
             AND install.previous_active_lock_digest = ?
           LIMIT 2`,
          )
          .all(
            record.projectId,
            record.packageName,
            record.installationId,
            record.lockDigest,
            record.previousActiveLockDigest,
          ) as Row[];
        if (row.length !== 1) {
          throw new Error(
            'Secret binding activation prerequisite is unavailable',
          );
        }
        const proposal = normalizePluginPackageInstallProposal(
          JSON.parse(
            text(row[0]!, 'proposalJson'),
          ) as PluginPackageInstallProposal,
        );
        if (
          proposal.actionDigest !== lock.approval.actionDigest ||
          proposal.previewDigest !== lock.approval.previewDigest ||
          proposal.actionInput.targetGeneration !== record.targetGeneration ||
          proposal.actionInput.source.contentDigest !==
            lock.source.contentDigest
        ) {
          throw new Error(
            'Secret binding activation prerequisite provenance drift',
          );
        }
        const required =
          proposal.actionInput.manifest.spec.permissions.secrets.length > 0 ||
          row[0]!.previousBindingPresent === 1;
        if (!required) return Object.freeze({ status: 'ready' as const });
        const generation = createPluginPackageResourceGenerationFromReferences({
          installationId: record.installationId,
          projectId: record.projectId,
          packageName: record.packageName,
          lockDigest: record.lockDigest,
          generation: record.targetGeneration,
          previousActiveLockDigest: record.previousActiveLockDigest,
          contentDigest: lock.source.contentDigest,
          resources: lock.resources,
        });
        const target = createPluginPackageSecretBindingTarget(
          generation,
          proposal.actionInput.manifest,
        );
        const receipt = this.#receipts.findInTransaction(
          target.generationDigest,
        );
        if (
          !receipt ||
          JSON.stringify(receipt.transitionPlan.nextTarget) !==
            JSON.stringify(target) ||
          receipt.transitionPlan.previousActiveLockDigest !==
            record.previousActiveLockDigest
        ) {
          return Object.freeze({
            status: 'deferred' as const,
            reason: 'secret_binding_transition_required' as const,
          });
        }
        return Object.freeze({ status: 'ready' as const });
      },
      () => new Error('Secret binding activation prerequisite is unavailable'),
    );
  }
}
