import type { PostgresClient } from '@qinglong/runtime-core';
import {
  normalizePluginPackageAutomationPublication,
  type PluginPackageAutomationPublication,
} from '@qinglong/runtime-core/plugin-package-automation-publication';
import {
  normalizePluginPackagePromptResource,
  type PluginPackagePromptResource,
} from '@qinglong/runtime-core/plugin-package-resource-materialization';

import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../../migration/modelInvocationMigration';
import {
  createPluginPackagePromptAdmissionBundle,
  pluginPackagePromptDefinitionDigest,
  PluginPackagePromptAdmissionConflictError,
  PluginPackagePromptAdmissionNotAllowedError,
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
import { json, jsonObject, unavailable, type Row } from './authority';

export interface PostgresPluginPackagePromptAdmissionMutationGuard {
  confirm(
    input: Readonly<{
      client: PostgresClient;
      plan: Readonly<PluginPackagePromptExecutionPlan>;
      replay: boolean;
    }>,
  ): void | Promise<void>;
}

function assertSnapshot(
  plan: Readonly<PluginPackagePromptExecutionPlan>,
  row: Row,
): void {
  let publication: Readonly<PluginPackageAutomationPublication>;
  try {
    publication = normalizePluginPackageAutomationPublication(
      jsonObject(
        row.publicationJson,
      ) as unknown as PluginPackageAutomationPublication,
    );
  } catch {
    throw unavailable();
  }
  const target = plan.target;
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

  const revision = jsonObject(row.revisionJson);
  const resources = revision.resources;
  if (!Array.isArray(resources)) throw unavailable();
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

export async function admitOperation(
  client: PostgresClient,
  mutationGuard: PostgresPluginPackagePromptAdmissionMutationGuard | undefined,
  plan: Readonly<PluginPackagePromptExecutionPlan>,
): Promise<
  Readonly<{
    status: 'created' | 'existing';
    receipt: Readonly<PluginPackagePromptAdmissionReceipt>;
  }>
> {
  const bundle = createPluginPackagePromptAdmissionBundle(plan);
  const existing = await findAdmission(client, 'request_id', plan.requestId);
  if (existing) {
    if (
      existing.plan.planDigest !== plan.planDigest ||
      json(existing.plan) !== json(plan)
    ) {
      throw new PluginPackagePromptAdmissionConflictError(
        'requestId is already bound to another plan',
      );
    }
    await mutationGuard?.confirm({ client, plan, replay: true });
    return Object.freeze({
      status: 'existing' as const,
      receipt: existing.receipt,
    });
  }
  await mutationGuard?.confirm({ client, plan, replay: false });
  const snapshot = await client.query<Row>(
    `SELECT publication_json AS "publicationJson",
            revision_json AS "revisionJson"
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."plugin_package_prompt_admission_snapshot"(
       $1, $2, $3, $4, $5, $6, $7
     )`,
    [
      plan.target.projectId,
      plan.target.packageName,
      plan.target.publicationDigest,
      plan.requestedBySubject.type,
      plan.requestedBySubject.id,
      plan.policyFence.projectVersion,
      plan.policyFence.bindingVersion,
    ],
  );
  if (snapshot.rows.length === 0) {
    throw new PluginPackagePromptAdmissionNotAllowedError();
  }
  if (snapshot.rows.length !== 1) throw unavailable();
  assertSnapshot(plan, snapshot.rows[0]!);
  await insertRun(client, bundle);
  await insertEvent(client, bundle.admissionEvent, null);
  await insertStepEvidence(client, bundle);
  await insertAdmission(client, bundle);
  return Object.freeze({ status: 'created' as const, receipt: bundle.receipt });
}
