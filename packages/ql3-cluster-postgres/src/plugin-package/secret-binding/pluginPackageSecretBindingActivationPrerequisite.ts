import type { PostgresPool } from '@qinglong/runtime-core';
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

import {
  postgresRequiredJsonObject,
  postgresRequiredString,
} from '../../repository/definitionRepositorySupport';
import { PostgresPluginPackageSecretBindingTransitionRepository } from './pluginPackageSecretBindingTransitionRepository';

type Row = Record<string, unknown>;

function unavailable(cause?: unknown): Error {
  return new Error('Secret binding activation prerequisite is unavailable', {
    cause: cause instanceof Error ? cause : undefined,
  });
}

export class PostgresPluginPackageSecretBindingActivationPrerequisite
  implements PluginPackageActivationPrerequisite
{
  readonly #receipts: PostgresPluginPackageSecretBindingTransitionRepository;

  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL Secret binding activation prerequisite pool is invalid',
      );
    }
    this.#receipts = new PostgresPluginPackageSecretBindingTransitionRepository(
      pool,
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
    try {
      const result = await this.pool.query<Row>(
        `SELECT proposal.proposal_json AS "proposalJson",
                EXISTS (
                  SELECT 1
                    FROM "ql3"."plugin_package_installs" AS previous
                    JOIN "ql3"."plugin_package_secret_bindings" AS binding
                      ON binding.installation_id = previous.installation_id
                   WHERE previous.project_id = install.project_id
                     AND previous.package_name = install.package_name
                     AND previous.lock_digest = install.previous_active_lock_digest
                ) AS "previousBindingPresent"
         FROM "ql3"."plugin_package_install_heads" AS head
         JOIN "ql3"."plugin_package_installs" AS install
           ON install.installation_id = head.installation_id
         JOIN "ql3"."plugin_package_admission_receipts" AS admission
           ON admission.installation_id = install.installation_id
         JOIN "ql3"."plugin_package_install_proposals" AS proposal
           ON proposal.action_ref = admission.action_ref
         WHERE head.project_id = $1 AND head.package_name = $2
           AND install.installation_id = $3 AND install.lock_digest = $4
           AND install.state = 'staged'
           AND install.previous_active_lock_digest = $5
         LIMIT 2`,
        [
          record.projectId,
          record.packageName,
          record.installationId,
          record.lockDigest,
          record.previousActiveLockDigest,
        ],
      );
      if (result.rows.length !== 1) throw unavailable();
      const proposal = normalizePluginPackageInstallProposal(
        postgresRequiredJsonObject(
          result.rows[0]!.proposalJson,
          unavailable,
        ) as unknown as PluginPackageInstallProposal,
      );
      if (
        proposal.actionDigest !== lock.approval.actionDigest ||
        proposal.previewDigest !== lock.approval.previewDigest ||
        proposal.actionInput.targetGeneration !== record.targetGeneration ||
        proposal.actionInput.source.contentDigest !== lock.source.contentDigest
      ) {
        throw unavailable(
          new Error('Secret binding activation prerequisite provenance drift'),
        );
      }
      const required =
        proposal.actionInput.manifest.spec.permissions.secrets.length > 0 ||
        result.rows[0]!.previousBindingPresent === true;
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
      const receipt = await this.#receipts.find(target.generationDigest);
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
    } catch (error) {
      throw unavailable(error);
    }
  }
}
