import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import { normalizeSecurityPrincipal } from '@qinglong/runtime-core/security';
import { normalizePluginPackageAutomationPublication } from '@qinglong/runtime-core/plugin-package-automation-publication';

import {
  createPluginPackagePromptCatalogResult,
  type PluginPackagePromptCatalogCapability,
  type PluginPackagePromptCatalogResult,
} from '../pluginPackagePromptCatalog';
import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../../migration/modelInvocationMigration';
import {
  PluginPackagePromptExecutor,
  type ExecutePluginPackagePromptResult,
} from '../pluginPackagePromptExecutor';
import {
  PluginPackagePromptAdmissionNotAllowedError,
  PluginPackagePromptAdmissionConflictError,
  PluginPackagePromptAdmissionUnavailableError,
  type PluginPackagePromptExecutionPlan,
} from '../pluginPackagePromptExecution';
import {
  PostgresPluginPackagePromptAdmissionRepository,
  type PostgresPluginPackagePromptAdmissionMutationGuard,
} from '../postgresPluginPackagePromptAdmissionRepository';
import {
  PostgresPluginPackagePromptApplicationUnavailableError,
  unavailable,
  type PostgresPluginPackagePromptExecutionCapability,
  type PostgresPluginPackagePromptExecutionCommand,
} from './contracts';

interface PromptPublicationRow extends Record<string, unknown> {
  readonly publicationJson: unknown;
}

const API_CREDENTIAL_AUTHENTICATION =
  /^api_credential:([A-Za-z0-9][A-Za-z0-9._:-]{0,63}):([1-9]\d*)$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function integer(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function promptExecutionCommand(
  value: PostgresPluginPackagePromptExecutionCommand,
): Readonly<PostgresPluginPackagePromptExecutionCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginPackagePromptAdmissionUnavailableError();
  }
  const required = [
    'auditEventId',
    'deadlineAtMs',
    'maxOutputTokens',
    'model',
    'packageName',
    'parameters',
    'plannedAtMs',
    'policyFence',
    'principal',
    'projectId',
    'promptId',
    'provider',
    'requestId',
    'traceId',
  ];
  const optional = new Set(['output', 'signal', 'temperature']);
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.has(key)) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.projectId) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.packageName) ||
    !UUID_V4.test(value.auditEventId) ||
    !Number.isSafeInteger(value.plannedAtMs) ||
    value.plannedAtMs < 0 ||
    !Number.isSafeInteger(value.deadlineAtMs) ||
    value.deadlineAtMs <= value.plannedAtMs ||
    !value.policyFence ||
    !Number.isSafeInteger(value.policyFence.projectVersion) ||
    value.policyFence.projectVersion < 1 ||
    !Number.isSafeInteger(value.policyFence.bindingVersion) ||
    value.policyFence.bindingVersion < 1
  ) {
    throw new PluginPackagePromptAdmissionNotAllowedError();
  }
  try {
    return Object.freeze({
      ...value,
      principal: normalizeSecurityPrincipal(value.principal, value.plannedAtMs),
    });
  } catch {
    throw new PluginPackagePromptAdmissionNotAllowedError();
  }
}

async function confirmPromptExecutionAuthorization(
  client: PostgresClient,
  command: Readonly<PostgresPluginPackagePromptExecutionCommand>,
  plan: Readonly<PluginPackagePromptExecutionPlan>,
  replay: boolean,
): Promise<void> {
  const subject = command.principal.subject;
  if (
    plan.target.projectId !== command.projectId ||
    plan.target.packageName !== command.packageName ||
    plan.target.promptId !== command.promptId ||
    plan.requestedBySubject.type !== subject.type ||
    plan.requestedBySubject.id !== subject.id ||
    plan.policyFence.projectVersion !== command.policyFence.projectVersion ||
    plan.policyFence.bindingVersion !== command.policyFence.bindingVersion
  ) {
    throw new PluginPackagePromptAdmissionNotAllowedError();
  }
  const credential = API_CREDENTIAL_AUTHENTICATION.exec(
    command.principal.authenticationId,
  );
  const credentialVersion = integer(credential?.[2]);
  if (!credential || credentialVersion === null || credentialVersion < 1) {
    throw new PluginPackagePromptAdmissionNotAllowedError();
  }
  const result = await client.query<{ readonly authorized: unknown }>(
    `SELECT "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."plugin_package_prompt_authorize_admission"(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
     ) AS authorized`,
    [
      credential[1],
      credentialVersion,
      command.projectId,
      subject.type,
      subject.id,
      command.policyFence.projectVersion,
      command.policyFence.bindingVersion,
      command.auditEventId,
      plan.requestId,
      plan.plannedAtMs,
      replay,
    ],
  );
  if (result.rows.length !== 1 || result.rows[0]?.authorized !== true) {
    throw new PluginPackagePromptAdmissionNotAllowedError();
  }
}

type PromptExecutorFactory = (
  guard: PostgresPluginPackagePromptAdmissionMutationGuard,
) => PluginPackagePromptExecutor;

/** Server-derived Cluster Prompt product adapter with transaction-bound auth. */
export class PostgresPluginPackagePromptExecutionService
  implements PostgresPluginPackagePromptExecutionCapability
{
  private readonly admissions: PostgresPluginPackagePromptAdmissionRepository;

  constructor(
    private readonly pool: PostgresPool,
    private readonly createExecutor: PromptExecutorFactory,
  ) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function' ||
      typeof createExecutor !== 'function'
    ) {
      throw new PluginPackagePromptAdmissionUnavailableError();
    }
    this.admissions = new PostgresPluginPackagePromptAdmissionRepository(pool);
  }

  async execute(
    value: Readonly<PostgresPluginPackagePromptExecutionCommand>,
  ): Promise<Readonly<ExecutePluginPackagePromptResult>> {
    const command = promptExecutionCommand(value);
    let existing: Readonly<PluginPackagePromptExecutionPlan> | null;
    let snapshot;
    try {
      existing = await this.admissions.findPlanByRequestId(command.requestId);
      if (
        existing &&
        (existing.target.projectId !== command.projectId ||
          existing.target.packageName !== command.packageName ||
          existing.target.promptId !== command.promptId)
      ) {
        throw new PluginPackagePromptAdmissionConflictError(
          'requestId is already bound to another Prompt target',
        );
      }
      if (
        existing &&
        (existing.requestedBySubject.type !== command.principal.subject.type ||
          existing.requestedBySubject.id !== command.principal.subject.id ||
          existing.policyFence.projectVersion !==
            command.policyFence.projectVersion ||
          existing.policyFence.bindingVersion !==
            command.policyFence.bindingVersion)
      ) {
        throw new PluginPackagePromptAdmissionNotAllowedError();
      }
      snapshot = await this.pool.query<PromptPublicationRow>(
        existing
          ? `SELECT publication_json AS "publicationJson"
               FROM "ql3"."plugin_package_automation_publications"
              WHERE project_id = $1 AND package_name = $2
                AND publication_digest = $3 AND state = 'active'
              LIMIT 2`
          : `SELECT publication.publication_json AS "publicationJson"
               FROM "ql3"."plugin_package_automation_publication_heads" AS head
               JOIN "ql3"."plugin_package_automation_publications" AS publication
                 ON publication.publication_digest = head.publication_digest
              WHERE head.project_id = $1 AND head.package_name = $2
                AND head.state = 'active' AND publication.state = 'active'
              LIMIT 2`,
        existing
          ? [
              command.projectId,
              command.packageName,
              existing.target.publicationDigest,
            ]
          : [command.projectId, command.packageName],
      );
    } catch (cause) {
      if (
        cause instanceof PluginPackagePromptAdmissionConflictError ||
        cause instanceof PluginPackagePromptAdmissionNotAllowedError
      ) {
        throw cause;
      }
      throw new PluginPackagePromptAdmissionUnavailableError({
        cause: cause instanceof Error ? cause : undefined,
      });
    }
    if (snapshot.rows.length === 0) {
      throw new PluginPackagePromptAdmissionNotAllowedError();
    }
    if (snapshot.rows.length !== 1) {
      throw new PluginPackagePromptAdmissionUnavailableError();
    }
    try {
      const raw = snapshot.rows[0]!.publicationJson;
      const publication = normalizePluginPackageAutomationPublication(
        typeof raw === 'string' ? JSON.parse(raw) : raw,
      );
      const expectedPublicationDigest =
        existing?.target.publicationDigest ?? publication.publicationDigest;
      if (
        publication.target.projectId !== command.projectId ||
        publication.target.packageName !== command.packageName ||
        publication.publicationDigest !== expectedPublicationDigest ||
        publication.state !== 'active' ||
        !publication.definitions.prompts.some(
          (prompt) => prompt.id === command.promptId,
        )
      ) {
        throw new PluginPackagePromptAdmissionUnavailableError();
      }
      const executor = this.createExecutor({
        confirm: ({ client, plan, replay }) =>
          confirmPromptExecutionAuthorization(client, command, plan, replay),
      });
      if (!executor || typeof executor.execute !== 'function') {
        throw new PluginPackagePromptAdmissionUnavailableError();
      }
      return await executor.execute({
        publication,
        expectedPublicationDigest,
        promptId: command.promptId,
        requestId: command.requestId,
        traceId: command.traceId,
        requestedBySubject: command.principal.subject,
        policyFence: command.policyFence,
        parameters: command.parameters,
        provider: command.provider,
        model: command.model,
        maxOutputTokens: command.maxOutputTokens,
        ...(command.temperature === undefined
          ? {}
          : { temperature: command.temperature }),
        ...(command.output === undefined ? {} : { output: command.output }),
        deadlineAtMs: existing?.deadlineAtMs ?? command.deadlineAtMs,
        plannedAtMs: existing?.plannedAtMs ?? command.plannedAtMs,
        ...(command.signal === undefined ? {} : { signal: command.signal }),
      });
    } catch (cause) {
      if (
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        typeof cause.code === 'string' &&
        cause.code.startsWith('PLUGIN_PACKAGE_PROMPT_')
      ) {
        throw cause;
      }
      throw new PluginPackagePromptAdmissionUnavailableError({
        cause: cause instanceof Error ? cause : undefined,
      });
    }
  }
}

/** Bounded content-free Prompt discovery over the current Package publication. */
export class PostgresPluginPackagePromptCatalogService
  implements PluginPackagePromptCatalogCapability
{
  constructor(private readonly pool: Pick<PostgresPool, 'query'>) {
    if (!pool || typeof pool.query !== 'function') {
      throw unavailable();
    }
  }

  async inspect(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackagePromptCatalogResult>> {
    try {
      const snapshot = await this.pool.query<PromptPublicationRow>(
        `SELECT publication.publication_json AS "publicationJson"
           FROM "ql3"."plugin_package_automation_publication_heads" AS head
           JOIN "ql3"."plugin_package_automation_publications" AS publication
             ON publication.publication_digest = head.publication_digest
          WHERE head.project_id = $1 AND head.package_name = $2
          LIMIT 2`,
        [projectId, packageName],
      );
      if (snapshot.rows.length === 0) {
        return createPluginPackagePromptCatalogResult(
          projectId,
          packageName,
          null,
        );
      }
      if (snapshot.rows.length !== 1) throw unavailable();
      const raw = snapshot.rows[0]!.publicationJson;
      const publication = normalizePluginPackageAutomationPublication(
        typeof raw === 'string' ? JSON.parse(raw) : raw,
      );
      return createPluginPackagePromptCatalogResult(
        projectId,
        packageName,
        publication,
      );
    } catch (cause) {
      if (
        cause instanceof PostgresPluginPackagePromptApplicationUnavailableError
      ) {
        throw cause;
      }
      throw unavailable(cause);
    }
  }
}
