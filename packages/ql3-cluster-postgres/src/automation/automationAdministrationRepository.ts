// PostgreSQL authorized administration authority for Task and Trigger definitions.
import type {
  PostgresClient,
  PostgresPool,
} from '@qinglong/runtime-core';
import {
  InvalidTaskDefinitionAdministrationReadError,
  TaskDefinitionAdministrationAuthorizationFenceConflictError,
  TaskDefinitionAdministrationMutationConflictError,
  TaskDefinitionAdministrationReadConflictError,
  normalizeAuthorizedTaskDefinitionInspection,
  normalizeAuthorizedTaskDefinitionList,
  normalizeAuthorizedTaskDefinitionRevisionMutation,
  type AuthorizedTaskDefinitionInspection,
  type AuthorizedTaskDefinitionList,
  type AuthorizedTaskDefinitionRevisionMutation,
  type TaskDefinitionAdministrationRepository,
  type TaskDefinitionAdministrationSource,
} from '@qinglong/runtime-core/task-definition-administration';
import {
  InvalidTriggerAdministrationReadError,
  TriggerAdministrationAuthorizationFenceConflictError,
  TriggerAdministrationMutationConflictError,
  TriggerAdministrationReadConflictError,
  normalizeAuthorizedTriggerInspection,
  normalizeAuthorizedTriggerList,
  normalizeAuthorizedTriggerRevisionMutation,
  type AuthorizedTriggerInspection,
  type AuthorizedTriggerList,
  type AuthorizedTriggerRevisionMutation,
  type TriggerAdministrationRepository,
  type TriggerAdministrationSource,
} from '@qinglong/runtime-core/trigger-administration';
import {
  TaskDefinitionUnavailableError,
  type TaskDefinitionPage,
  type TaskDefinitionRecord,
} from '@qinglong/runtime-core/task-definition';
import {
  TriggerUnavailableError,
  type TriggerPage,
  type TriggerRecord,
} from '@qinglong/runtime-core/trigger';
import {
  ADMINISTRATION_AUDIT_SELECT,
  auditFromRow,
  configureAdministrationTransaction,
  insertAdministrationAudit,
  requiredInteger,
  requiredString,
  retryableAdministrationError,
  rollbackAdministrationTransaction,
  sameAdministrationReplayAudit,
  type AdministrationAuditRow,
  type AdministrationRow,
} from '../repository/administrationSupport';
import {
  PostgresTaskDefinitionRepository,
  PostgresTaskDefinitionSource,
} from './taskDefinitionRepository';
import {
  PostgresTriggerRepository,
  PostgresTriggerSource,
} from '../scheduling/triggerRepository';

type FenceConflict = new () => Error;
type MutationConflict = new () => Error;
type ReadConflict = new () => Error;
type StorageUnavailable = new () => Error;
type InvalidRead = new (message: string) => Error;

const AUTHORIZED_READ_TRANSACTION_ATTEMPTS = 3;

function assertPool(pool: PostgresPool): void {
  if (
    !pool ||
    typeof pool.query !== 'function' ||
    typeof pool.connect !== 'function'
  ) {
    throw new TypeError('PostgreSQL automation administration pool is invalid');
  }
}

async function confirmAuthorizationFence(
  client: PostgresClient,
  mutation: Readonly<{
    command: Readonly<{ projectId: string }>;
    actor: Readonly<{ type: string; id: string }>;
    fence: Readonly<{ projectVersion: number; bindingVersion: number | null }>;
  }>,
  FenceConflictError: FenceConflict,
): Promise<void> {
  try {
    const project = await client.query<AdministrationRow>(
      `SELECT status, version
       FROM "ql3"."projects"
       WHERE id = $1`,
      [mutation.command.projectId],
    );
    const binding = await client.query<AdministrationRow>(
      `SELECT version, state
       FROM "ql3"."project_role_bindings"
       WHERE project_id = $1 AND subject_type = $2 AND subject_id = $3
       ORDER BY version DESC
       LIMIT 1`,
      [
        mutation.command.projectId,
        mutation.actor.type,
        mutation.actor.id,
      ],
    );
    if (
      project.rows.length !== 1 ||
      requiredString(project.rows[0]!, 'status') !== 'active' ||
      requiredInteger(project.rows[0]!, 'version') !==
        mutation.fence.projectVersion ||
      binding.rows.length !== 1 ||
      requiredString(binding.rows[0]!, 'state') !== 'active' ||
      requiredInteger(binding.rows[0]!, 'version') !==
        mutation.fence.bindingVersion
    ) {
      throw new FenceConflictError();
    }
  } catch (error) {
    if (error instanceof FenceConflictError) throw error;
    throw new FenceConflictError();
  }
}

async function confirmOrAppendAllowedAudit(
  client: PostgresClient,
  replay: boolean,
  audit: AuthorizedTaskDefinitionRevisionMutation['audit'],
  MutationConflictError: MutationConflict,
): Promise<void> {
  const result = await client.query<AdministrationAuditRow>(
    `SELECT ${ADMINISTRATION_AUDIT_SELECT}
     FROM "ql3"."security_audit_events" AS audit
     WHERE audit.event_id = $1
     LIMIT 2`,
    [audit.eventId],
  );
  if (replay) {
    if (result.rows.length !== 1) throw new MutationConflictError();
    try {
      if (!sameAdministrationReplayAudit(auditFromRow(result.rows[0]!), audit)) {
        throw new MutationConflictError();
      }
    } catch (error) {
      if (error instanceof MutationConflictError) throw error;
      throw new MutationConflictError();
    }
    return;
  }
  if (result.rows.length !== 0) throw new MutationConflictError();
  await insertAdministrationAudit(client, audit);
}

function clientReadPool(client: PostgresClient): PostgresPool {
  return Object.freeze({
    query: client.query.bind(client),
    async connect() {
      return client;
    },
  });
}

function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function confirmReadAuthorizationFence(
  client: PostgresClient,
  read: Readonly<{
    projectId: string;
    actor: Readonly<{ type: string; id: string }>;
    fence: Readonly<{ projectVersion: number; bindingVersion: number | null }>;
  }>,
  FenceConflictError: FenceConflict,
): Promise<void> {
  try {
    const project = await client.query<AdministrationRow>(
      `SELECT status, version
       FROM "ql3"."projects"
       WHERE id = $1
       LIMIT 1`,
      [read.projectId],
    );
    const binding = await client.query<AdministrationRow>(
      `SELECT version, state
       FROM "ql3"."project_role_bindings"
       WHERE project_id = $1 AND subject_type = $2 AND subject_id = $3
       ORDER BY version DESC
       LIMIT 1`,
      [read.projectId, read.actor.type, read.actor.id],
    );
    if (
      project.rows.length !== 1 ||
      requiredString(project.rows[0]!, 'status') !== 'active' ||
      requiredInteger(project.rows[0]!, 'version') !==
        read.fence.projectVersion ||
      binding.rows.length !== 1 ||
      requiredString(binding.rows[0]!, 'state') !== 'active' ||
      requiredInteger(binding.rows[0]!, 'version') !==
        read.fence.bindingVersion
    ) {
      throw new FenceConflictError();
    }
  } catch (error) {
    if (error instanceof FenceConflictError) throw error;
    throw new FenceConflictError();
  }
}

async function assertFreshReadAudit(
  client: PostgresClient,
  eventId: string,
  ReadConflictError: ReadConflict,
): Promise<void> {
  const result = await client.query<AdministrationRow>(
    `SELECT event_id
     FROM "ql3"."security_audit_events"
     WHERE event_id = $1
     LIMIT 2`,
    [eventId],
  );
  if (result.rows.length !== 0) throw new ReadConflictError();
}

async function executeAuthorizedRead<TResult>(
  pool: PostgresPool,
  read: Readonly<{
    projectId: string;
    actor: Readonly<{ type: string; id: string }>;
    fence: Readonly<{ projectVersion: number; bindingVersion: number | null }>;
    audit: AuthorizedTaskDefinitionInspection['audit'];
  }>,
  FenceConflictError: FenceConflict,
  ReadConflictError: ReadConflict,
  InvalidReadError: InvalidRead,
  UnavailableError: StorageUnavailable,
  operation: (client: PostgresClient) => Promise<TResult>,
): Promise<TResult> {
  for (
    let attempt = 0;
    attempt < AUTHORIZED_READ_TRANSACTION_ATTEMPTS;
    attempt += 1
  ) {
    let client: PostgresClient;
    try {
      client = await pool.connect();
    } catch {
      throw new UnavailableError();
    }
    let began = false;
    try {
      await configureAdministrationTransaction(client);
      began = true;
      await confirmReadAuthorizationFence(client, read, FenceConflictError);
      await assertFreshReadAudit(
        client,
        read.audit.eventId,
        ReadConflictError,
      );
      const result = await operation(client);
      await insertAdministrationAudit(client, read.audit);
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (began) await rollbackAdministrationTransaction(client);
      if (
        error instanceof FenceConflictError ||
        error instanceof ReadConflictError ||
        error instanceof InvalidReadError ||
        error instanceof UnavailableError
      ) {
        throw error;
      }
      if (sqlState(error) === '23505') throw new ReadConflictError();
      if (
        retryableAdministrationError(error) &&
        attempt + 1 < AUTHORIZED_READ_TRANSACTION_ATTEMPTS
      ) {
        continue;
      }
      throw new UnavailableError();
    } finally {
      client.release();
    }
  }
  throw new UnavailableError();
}

/** Least-privilege automation-manager Task mutation adapter. */
export class PostgresTaskDefinitionAdministrationRepository
  implements
    TaskDefinitionAdministrationRepository,
    TaskDefinitionAdministrationSource
{
  private readonly taskDefinitions: PostgresTaskDefinitionRepository;

  constructor(private readonly pool: PostgresPool) {
    assertPool(pool);
    this.taskDefinitions = new PostgresTaskDefinitionRepository(pool);
  }

  appendAuthorizedTaskDefinitionRevision(
    input: AuthorizedTaskDefinitionRevisionMutation,
  ) {
    const mutation = normalizeAuthorizedTaskDefinitionRevisionMutation(input);
    return this.taskDefinitions.appendTaskDefinitionRevision(
      mutation.command,
      async (client, { replay }) => {
        await confirmAuthorizationFence(
          client,
          mutation,
          TaskDefinitionAdministrationAuthorizationFenceConflictError,
        );
        await confirmOrAppendAllowedAudit(
          client,
          replay !== null,
          mutation.audit,
          TaskDefinitionAdministrationMutationConflictError,
        );
      },
    );
  }

  findAuthorizedCurrentTaskDefinition(
    input: AuthorizedTaskDefinitionInspection,
  ): Promise<TaskDefinitionRecord | null> {
    const inspection = normalizeAuthorizedTaskDefinitionInspection(input);
    return executeAuthorizedRead(
      this.pool,
      inspection,
      TaskDefinitionAdministrationAuthorizationFenceConflictError,
      TaskDefinitionAdministrationReadConflictError,
      InvalidTaskDefinitionAdministrationReadError,
      TaskDefinitionUnavailableError,
      (client) =>
        new PostgresTaskDefinitionSource(
          clientReadPool(client),
        ).findCurrentTaskDefinition(inspection.projectId, inspection.taskId),
    );
  }

  listAuthorizedTaskDefinitions(
    input: AuthorizedTaskDefinitionList,
  ): Promise<TaskDefinitionPage> {
    const query = normalizeAuthorizedTaskDefinitionList(input);
    return executeAuthorizedRead(
      this.pool,
      query,
      TaskDefinitionAdministrationAuthorizationFenceConflictError,
      TaskDefinitionAdministrationReadConflictError,
      InvalidTaskDefinitionAdministrationReadError,
      TaskDefinitionUnavailableError,
      (client) =>
        new PostgresTaskDefinitionSource(clientReadPool(client)).listTaskDefinitions(
          {
            projectId: query.projectId,
            limit: query.limit,
            ...(query.after ? { after: query.after } : {}),
          },
        ),
    );
  }
}

/** Least-privilege automation-manager Trigger mutation adapter. */
export class PostgresTriggerAdministrationRepository
  implements TriggerAdministrationRepository, TriggerAdministrationSource
{
  private readonly triggers: PostgresTriggerRepository;

  constructor(private readonly pool: PostgresPool) {
    assertPool(pool);
    this.triggers = new PostgresTriggerRepository(pool);
  }

  appendAuthorizedTriggerRevision(input: AuthorizedTriggerRevisionMutation) {
    const mutation = normalizeAuthorizedTriggerRevisionMutation(input);
    return this.triggers.appendTriggerRevision(
      mutation.command,
      async (client, { replay }) => {
        await confirmAuthorizationFence(
          client,
          mutation,
          TriggerAdministrationAuthorizationFenceConflictError,
        );
        await confirmOrAppendAllowedAudit(
          client,
          replay !== null,
          mutation.audit,
          TriggerAdministrationMutationConflictError,
        );
      },
    );
  }

  findAuthorizedCurrentTrigger(
    input: AuthorizedTriggerInspection,
  ): Promise<TriggerRecord | null> {
    const inspection = normalizeAuthorizedTriggerInspection(input);
    return executeAuthorizedRead(
      this.pool,
      inspection,
      TriggerAdministrationAuthorizationFenceConflictError,
      TriggerAdministrationReadConflictError,
      InvalidTriggerAdministrationReadError,
      TriggerUnavailableError,
      (client) =>
        new PostgresTriggerSource(clientReadPool(client)).findCurrentTrigger(
          inspection.projectId,
          inspection.triggerId,
        ),
    );
  }

  listAuthorizedTriggers(input: AuthorizedTriggerList): Promise<TriggerPage> {
    const query = normalizeAuthorizedTriggerList(input);
    return executeAuthorizedRead(
      this.pool,
      query,
      TriggerAdministrationAuthorizationFenceConflictError,
      TriggerAdministrationReadConflictError,
      InvalidTriggerAdministrationReadError,
      TriggerUnavailableError,
      (client) =>
        new PostgresTriggerSource(clientReadPool(client)).listTriggers({
          projectId: query.projectId,
          limit: query.limit,
          ...(query.after ? { after: query.after } : {}),
        }),
    );
  }
}
