import {
  normalizePluginPackageAutomationPublication,
  type PluginPackageAutomationPublication,
} from '@qinglong/runtime-core/plugin-package-automation-publication';
import {
  normalizePluginPackagePromptResource,
  type PluginPackagePromptResource,
} from '@qinglong/runtime-core/plugin-package-resource-materialization';

import { assertLocalModelInvocationFeatureActive } from '../../feature-activation/localModelInvocationFeatureActivation';
import type { LocalModelInvocationOperationAuthority } from '../../model-invocation/localModelInvocationRepository';
import {
  createPluginPackagePromptAdmissionBundle,
  PluginPackagePromptAdmissionConflictError,
  PluginPackagePromptAdmissionNotAllowedError,
  PluginPackagePromptAdmissionUnavailableError,
  pluginPackagePromptDefinitionDigest,
  type PluginPackagePromptAdmissionReceipt,
  type PluginPackagePromptExecutionPlan,
} from '../pluginPackagePromptExecution';
import {
  findAdmission,
  insertAdmission,
  insertEvent,
  insertRun,
  insertStepEvidence,
} from './admissionRecords';
import {
  canonicalJson,
  text,
  type LocalPluginPackagePromptAdmissionMutationGuard,
  type Row,
} from './authority';

function assertCurrentTarget(
  authority: LocalModelInvocationOperationAuthority,
  plan: Readonly<PluginPackagePromptExecutionPlan>,
): void {
  const target = plan.target;
  const guard = authority.client
    .prepare(
      `SELECT publication.publication_json AS "publicationJson"
       FROM "QingLong3PluginPackageAutomationPublicationHeads" AS head
       JOIN "QingLong3PluginPackageAutomationPublications" AS publication
         ON publication.publication_digest = head.publication_digest
       JOIN "QingLong3PluginPackageInstallHeads" AS install_head
         ON install_head.project_id = publication.project_id
        AND install_head.package_name = publication.package_name
        AND install_head.installation_id = publication.installation_id
       JOIN "QingLong3PluginPackageInstalls" AS install
         ON install.installation_id = install_head.installation_id
        AND install.lock_digest = publication.lock_digest
       LEFT JOIN "QingLong3PluginPackageLifecycleHeads" AS lifecycle
         ON lifecycle.project_id = publication.project_id
        AND lifecycle.package_name = publication.package_name
       WHERE head.project_id = ?
         AND head.package_name = ?
         AND head.publication_digest = ?
         AND publication.state = 'active'
         AND install.state = 'active'
         AND install.active_lock_digest = publication.lock_digest
         AND (lifecycle.event_digest IS NULL OR lifecycle.disposition = 'active')
         AND NOT EXISTS (
           SELECT 1 FROM "QingLong3PluginPackageQuarantineEvents" AS quarantine
           WHERE quarantine.project_id = publication.project_id
             AND quarantine.package_name = publication.package_name
             AND quarantine.installation_id = publication.installation_id
             AND quarantine.lock_digest = publication.lock_digest
         )`,
    )
    .get(target.projectId, target.packageName, target.publicationDigest) as
    | Row
    | undefined;
  if (!guard) throw new PluginPackagePromptAdmissionNotAllowedError();

  let publication: Readonly<PluginPackageAutomationPublication>;
  try {
    publication = normalizePluginPackageAutomationPublication(
      JSON.parse(
        text(guard, 'publicationJson'),
      ) as PluginPackageAutomationPublication,
    );
  } catch {
    throw new PluginPackagePromptAdmissionUnavailableError();
  }
  const prompt = publication.definitions.prompts.find(
    ({ id }) => id === target.promptId,
  );
  if (
    publication.publicationDigest !== target.publicationDigest ||
    publication.target.projectId !== target.projectId ||
    publication.target.packageName !== target.packageName ||
    publication.target.installationId !== target.installationId ||
    publication.target.lockDigest !== target.lockDigest ||
    publication.target.generation !== target.generation ||
    publication.target.generationDigest !== target.generationDigest ||
    publication.target.materializedRevisionDigest !==
      target.materializedRevisionDigest ||
    publication.state !== 'active' ||
    !prompt ||
    pluginPackagePromptDefinitionDigest(prompt) !==
      target.promptDefinitionDigest
  ) {
    throw new PluginPackagePromptAdmissionConflictError(
      'the exact Prompt publication drifted',
    );
  }

  const revision = authority.client
    .prepare(
      `SELECT revision_json AS "revisionJson"
       FROM "QingLong3PluginPackageMaterializedRevisions"
       WHERE generation_digest = ? AND project_id = ? AND package_name = ?
         AND generation = ? AND lock_digest = ? AND revision_digest = ?`,
    )
    .get(
      target.generationDigest,
      target.projectId,
      target.packageName,
      target.generation,
      target.lockDigest,
      target.materializedRevisionDigest,
    ) as Row | undefined;
  if (!revision) {
    throw new PluginPackagePromptAdmissionConflictError(
      'the exact materialized revision is absent',
    );
  }
  let resources: unknown;
  try {
    resources = (
      JSON.parse(text(revision, 'revisionJson')) as { resources?: unknown }
    ).resources;
  } catch {
    throw new PluginPackagePromptAdmissionUnavailableError();
  }
  if (!Array.isArray(resources)) {
    throw new PluginPackagePromptAdmissionUnavailableError();
  }
  const matches = resources.filter((resource) => {
    if (!resource || typeof resource !== 'object') return false;
    const candidate = resource as { kind?: unknown; value?: unknown };
    if (candidate.kind !== 'prompt') return false;
    try {
      const value = normalizePluginPackagePromptResource(
        candidate.value,
      ) as Readonly<PluginPackagePromptResource>;
      return (
        value.id === target.promptId &&
        pluginPackagePromptDefinitionDigest(value) ===
          target.promptDefinitionDigest
      );
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    throw new PluginPackagePromptAdmissionConflictError(
      'the exact materialized Prompt evidence drifted',
    );
  }
}

export function admitOperation(
  authority: LocalModelInvocationOperationAuthority,
  mutationGuard: LocalPluginPackagePromptAdmissionMutationGuard | undefined,
  plan: Readonly<PluginPackagePromptExecutionPlan>,
): Readonly<{
  status: 'created' | 'existing';
  receipt: Readonly<PluginPackagePromptAdmissionReceipt>;
}> {
  const bundle = createPluginPackagePromptAdmissionBundle(plan);
  let began = false;
  try {
    authority.client.exec('BEGIN IMMEDIATE');
    began = true;
    const existing = findAdmission(
      authority.client,
      'request_id = ?',
      plan.requestId,
    );
    if (existing) {
      if (
        existing.plan.planDigest !== plan.planDigest ||
        canonicalJson(existing.plan) !== canonicalJson(plan)
      ) {
        throw new PluginPackagePromptAdmissionConflictError(
          'requestId is already bound to another plan',
        );
      }
      mutationGuard?.confirm(plan, true);
      authority.client.exec('COMMIT');
      began = false;
      return Object.freeze({
        status: 'existing' as const,
        receipt: existing.receipt,
      });
    }
    assertLocalModelInvocationFeatureActive(authority.client);
    mutationGuard?.confirm(plan, false);
    assertCurrentTarget(authority, plan);
    insertRun(authority.client, bundle);
    insertEvent(authority.client, bundle.admissionEvent, null);
    insertStepEvidence(authority.client, bundle);
    insertAdmission(authority.client, bundle);
    authority.client.exec('COMMIT');
    began = false;
    return Object.freeze({
      status: 'created' as const,
      receipt: bundle.receipt,
    });
  } finally {
    if (began && authority.client.isTransaction) {
      try {
        authority.client.exec('ROLLBACK');
      } catch {
        // Preserve the original fail-closed error.
      }
    }
  }
}
