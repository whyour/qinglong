import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import { normalizeProjectPolicySubject } from '@qinglong/runtime-core/project-policy';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

// Durable audit read model owned by the credential-management capability.
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MANAGEMENT_OPERATIONS = Object.freeze([
  'model_provider_credential.bind',
  'model_provider_credential.revoke',
] as const);

type Row = Record<string, unknown>;

export const MAX_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_PAGE_SIZE = 32;
export const MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_QUERY_OPERATION_ID =
  'model_provider_credential.audit.list';

export interface ModelProviderCredentialManagementAuditCursor {
  readonly occurredAtMs: number;
  readonly eventId: string;
}

export interface ModelProviderCredentialManagementAuditQuery {
  readonly schemaVersion: 1;
  readonly queryId: string;
  readonly requestId: string;
  readonly projectId: string;
  readonly limit: number;
  readonly before?: ModelProviderCredentialManagementAuditCursor;
}

export interface ModelProviderCredentialManagementAuditRecord {
  readonly eventId: string;
  readonly requestId: string;
  readonly operation: 'provider-credential.bind' | 'provider-credential.revoke';
  readonly actor: Readonly<{ type: 'user'; id: string }>;
  readonly fence: Readonly<{
    projectVersion: number;
    bindingVersion: number;
  }>;
  readonly occurredAtMs: number;
}

export interface ModelProviderCredentialManagementAuditPage {
  readonly projectId: string;
  readonly records: readonly Readonly<ModelProviderCredentialManagementAuditRecord>[];
  readonly nextCursor: Readonly<ModelProviderCredentialManagementAuditCursor> | null;
}

export interface AuthorizedModelProviderCredentialManagementAuditQuery {
  readonly query: ModelProviderCredentialManagementAuditQuery;
  readonly actor: SecuritySubject;
  readonly fence: SecurityPolicyFence;
  readonly audit: SecurityAuditRecord;
}

export interface ModelProviderCredentialManagementAuditQueryRepository {
  listAuthorized(
    query: AuthorizedModelProviderCredentialManagementAuditQuery,
  ): Promise<Readonly<ModelProviderCredentialManagementAuditPage>>;
}

export class InvalidModelProviderCredentialManagementAuditQueryError extends TypeError {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_QUERY_INVALID';

  constructor() {
    super('Model provider credential management audit query is invalid');
    this.name = 'InvalidModelProviderCredentialManagementAuditQueryError';
  }
}

export class ModelProviderCredentialManagementAuditAuthorizationFenceConflictError extends Error {
  readonly code =
    'MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_AUTHORIZATION_FENCE_CONFLICT';

  constructor() {
    super(
      'Model provider credential management audit authorization fence changed',
    );
    this.name =
      'ModelProviderCredentialManagementAuditAuthorizationFenceConflictError';
  }
}

export class ModelProviderCredentialManagementAuditConflictError extends Error {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_CONFLICT';

  constructor() {
    super(
      'Model provider credential management audit query conflicts with durable state',
    );
    this.name = 'ModelProviderCredentialManagementAuditConflictError';
  }
}

export class ModelProviderCredentialManagementAuditUnavailableError extends Error {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Model provider credential management audit is unavailable', options);
    this.name = 'ModelProviderCredentialManagementAuditUnavailableError';
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function invalid(): never {
  throw new InvalidModelProviderCredentialManagementAuditQueryError();
}

function positiveInteger(value: unknown): number {
  const normalized =
    typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(normalized) || (normalized as number) < 1) {
    throw new ModelProviderCredentialManagementAuditUnavailableError();
  }
  return normalized as number;
}

function nonNegativeInteger(value: unknown): number {
  const normalized =
    typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(normalized) || (normalized as number) < 0) {
    throw new ModelProviderCredentialManagementAuditUnavailableError();
  }
  return normalized as number;
}

function string(value: unknown, pattern: RegExp = IDENTITY_PATTERN): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ModelProviderCredentialManagementAuditUnavailableError();
  }
  return value;
}

function normalizeFence(value: SecurityPolicyFence): Readonly<{
  projectVersion: number;
  bindingVersion: number;
}> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['bindingVersion', 'projectVersion']) ||
    !Number.isSafeInteger(value.projectVersion) ||
    value.projectVersion < 1 ||
    !Number.isSafeInteger(value.bindingVersion) ||
    (value.bindingVersion as number) < 1
  ) {
    invalid();
  }
  return Object.freeze({
    projectVersion: value.projectVersion,
    bindingVersion: value.bindingVersion as number,
  });
}

export function normalizeModelProviderCredentialManagementAuditQuery(
  value: ModelProviderCredentialManagementAuditQuery,
): Readonly<ModelProviderCredentialManagementAuditQuery> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(
      value,
      value.before === undefined
        ? ['limit', 'projectId', 'queryId', 'requestId', 'schemaVersion']
        : [
            'before',
            'limit',
            'projectId',
            'queryId',
            'requestId',
            'schemaVersion',
          ],
    ) ||
    value.schemaVersion !== 1 ||
    !UUID_V4_PATTERN.test(value.queryId) ||
    !IDENTITY_PATTERN.test(value.requestId) ||
    !IDENTITY_PATTERN.test(value.projectId) ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > MAX_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_PAGE_SIZE
  ) {
    invalid();
  }
  let before:
    | Readonly<ModelProviderCredentialManagementAuditCursor>
    | undefined;
  if (value.before !== undefined) {
    if (
      !value.before ||
      typeof value.before !== 'object' ||
      Array.isArray(value.before) ||
      !exactKeys(value.before, ['eventId', 'occurredAtMs']) ||
      !Number.isSafeInteger(value.before.occurredAtMs) ||
      value.before.occurredAtMs < 0 ||
      !UUID_V4_PATTERN.test(value.before.eventId)
    ) {
      invalid();
    }
    before = Object.freeze({ ...value.before });
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    queryId: value.queryId,
    requestId: value.requestId,
    projectId: value.projectId,
    limit: value.limit,
    ...(before ? { before } : {}),
  });
}

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

export function normalizeAuthorizedModelProviderCredentialManagementAuditQuery(
  value: AuthorizedModelProviderCredentialManagementAuditQuery,
): Readonly<AuthorizedModelProviderCredentialManagementAuditQuery> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['actor', 'audit', 'fence', 'query'])
  ) {
    invalid();
  }
  try {
    const query = normalizeModelProviderCredentialManagementAuditQuery(
      value.query,
    );
    const actor = normalizeProjectPolicySubject(value.actor);
    const fence = normalizeFence(value.fence);
    const audit = normalizeSecurityAuditRecord(value.audit);
    if (
      actor.type !== 'user' ||
      audit.eventId !== query.queryId ||
      audit.requestId !== query.requestId ||
      audit.operationId !==
        MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_QUERY_OPERATION_ID ||
      audit.projectId !== query.projectId ||
      audit.outcome !== 'allowed' ||
      !audit.subject ||
      !sameSubject(audit.subject, actor) ||
      audit.authenticationId === null ||
      !audit.fence ||
      audit.fence.projectVersion !== fence.projectVersion ||
      audit.fence.bindingVersion !== fence.bindingVersion
    ) {
      invalid();
    }
    return Object.freeze({ query, actor, fence, audit });
  } catch (error) {
    if (
      error instanceof InvalidModelProviderCredentialManagementAuditQueryError
    ) {
      throw error;
    }
    invalid();
  }
}

function auditRecordFromRow(row: Row): Readonly<SecurityAuditRecord> {
  const reasons = row.reasons;
  if (!Array.isArray(reasons)) {
    throw new ModelProviderCredentialManagementAuditUnavailableError();
  }
  try {
    return normalizeSecurityAuditRecord({
      eventId: string(row.eventId, UUID_V4_PATTERN),
      requestId: string(row.requestId),
      operationId: string(row.operationId),
      projectId: string(row.projectId),
      subject: {
        type: string(row.subjectType) as NonNullable<
          SecurityAuditRecord['subject']
        >['type'],
        id: string(row.subjectId),
      },
      authenticationId: string(row.authenticationId),
      outcome: string(row.outcome) as SecurityAuditRecord['outcome'],
      reasons: reasons as string[],
      fence: {
        projectVersion: positiveInteger(row.projectVersion),
        bindingVersion: positiveInteger(row.bindingVersion),
      },
      occurredAtMs: nonNegativeInteger(row.occurredAtMs),
    });
  } catch (error) {
    if (
      error instanceof ModelProviderCredentialManagementAuditUnavailableError
    ) {
      throw error;
    }
    throw new ModelProviderCredentialManagementAuditUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  }
}

function contentFreeRecord(
  audit: Readonly<SecurityAuditRecord>,
): Readonly<ModelProviderCredentialManagementAuditRecord> {
  if (
    !MANAGEMENT_OPERATIONS.includes(
      audit.operationId as (typeof MANAGEMENT_OPERATIONS)[number],
    ) ||
    audit.outcome !== 'allowed' ||
    audit.subject?.type !== 'user' ||
    !audit.fence ||
    audit.fence.bindingVersion === null
  ) {
    throw new ModelProviderCredentialManagementAuditUnavailableError();
  }
  return Object.freeze({
    eventId: audit.eventId,
    requestId: audit.requestId,
    operation:
      audit.operationId === 'model_provider_credential.bind'
        ? ('provider-credential.bind' as const)
        : ('provider-credential.revoke' as const),
    actor: Object.freeze({ type: 'user' as const, id: audit.subject.id }),
    fence: Object.freeze({
      projectVersion: audit.fence.projectVersion,
      bindingVersion: audit.fence.bindingVersion,
    }),
    occurredAtMs: audit.occurredAtMs,
  });
}

async function rollback(client: PostgresClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

function sqlState(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function semanticAuditEqual(
  left: Readonly<SecurityAuditRecord>,
  right: Readonly<SecurityAuditRecord>,
): boolean {
  const { occurredAtMs: _leftTime, ...leftSemantic } = left;
  const { occurredAtMs: _rightTime, ...rightSemantic } = right;
  return JSON.stringify(leftSemantic) === JSON.stringify(rightSemantic);
}

async function confirmFence(
  client: PostgresClient,
  value: Readonly<AuthorizedModelProviderCredentialManagementAuditQuery>,
): Promise<void> {
  const project = await client.query<Row>(
    `SELECT status, version FROM "ql3"."projects" WHERE id = $1`,
    [value.query.projectId],
  );
  const binding = await client.query<Row>(
    `SELECT version, state
       FROM "ql3"."project_role_bindings"
      WHERE project_id = $1 AND subject_type = $2 AND subject_id = $3
      ORDER BY version DESC
      LIMIT 1`,
    [value.query.projectId, value.actor.type, value.actor.id],
  );
  if (
    project.rows.length !== 1 ||
    project.rows[0]?.status !== 'active' ||
    positiveInteger(project.rows[0]?.version) !== value.fence.projectVersion ||
    binding.rows.length !== 1 ||
    binding.rows[0]?.state !== 'active' ||
    positiveInteger(binding.rows[0]?.version) !== value.fence.bindingVersion
  ) {
    throw new ModelProviderCredentialManagementAuditAuthorizationFenceConflictError();
  }
}

async function auditById(
  client: PostgresClient,
  eventId: string,
): Promise<Readonly<SecurityAuditRecord> | null> {
  const result = await client.query<Row>(
    `SELECT event_id AS "eventId", request_id AS "requestId",
            operation_id AS "operationId", project_id AS "projectId",
            subject_type AS "subjectType", subject_id AS "subjectId",
            authentication_id AS "authenticationId", outcome, reasons,
            project_version AS "projectVersion",
            binding_version AS "bindingVersion",
            occurred_at_ms AS "occurredAtMs"
       FROM "ql3"."security_audit_events"
      WHERE event_id = $1
      LIMIT 2`,
    [eventId],
  );
  if (result.rows.length > 1) {
    throw new ModelProviderCredentialManagementAuditConflictError();
  }
  return result.rows[0] ? auditRecordFromRow(result.rows[0]) : null;
}

async function insertAudit(
  client: PostgresClient,
  audit: Readonly<SecurityAuditRecord>,
): Promise<void> {
  await client.query(
    `INSERT INTO "ql3"."security_audit_events" (
       event_id, request_id, operation_id, project_id, subject_type,
       subject_id, authentication_id, outcome, reasons, project_version,
       binding_version, occurred_at_ms
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
    [
      audit.eventId,
      audit.requestId,
      audit.operationId,
      audit.projectId,
      audit.subject?.type ?? null,
      audit.subject?.id ?? null,
      audit.authenticationId,
      audit.outcome,
      JSON.stringify(audit.reasons),
      audit.fence?.projectVersion ?? null,
      audit.fence?.bindingVersion ?? null,
      audit.occurredAtMs,
    ],
  );
}

function mapError(error: unknown): Error {
  if (
    error instanceof InvalidModelProviderCredentialManagementAuditQueryError ||
    error instanceof
      ModelProviderCredentialManagementAuditAuthorizationFenceConflictError ||
    error instanceof ModelProviderCredentialManagementAuditConflictError ||
    error instanceof ModelProviderCredentialManagementAuditUnavailableError
  ) {
    return error;
  }
  if (['23503', '23505', '23514', '40001', '40P01'].includes(sqlState(error))) {
    return new ModelProviderCredentialManagementAuditConflictError();
  }
  return new ModelProviderCredentialManagementAuditUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export class PostgresModelProviderCredentialManagementAuditQueryRepository
  implements ModelProviderCredentialManagementAuditQueryRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError(
        'PostgreSQL model provider credential management audit pool is invalid',
      );
    }
  }

  async listAuthorized(
    input: AuthorizedModelProviderCredentialManagementAuditQuery,
  ): Promise<Readonly<ModelProviderCredentialManagementAuditPage>> {
    const authorized =
      normalizeAuthorizedModelProviderCredentialManagementAuditQuery(input);
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new ModelProviderCredentialManagementAuditUnavailableError({
        cause: error,
      });
    }
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          JSON.stringify([
            authorized.query.projectId,
            'model-provider-credential-audit-query',
            authorized.actor.type,
            authorized.actor.id,
          ]),
        ],
      );
      await confirmFence(client, authorized);
      const storedAudit = await auditById(client, authorized.audit.eventId);
      if (storedAudit && !semanticAuditEqual(storedAudit, authorized.audit)) {
        throw new ModelProviderCredentialManagementAuditConflictError();
      }
      const values: unknown[] = [authorized.query.projectId];
      const before = authorized.query.before;
      let cursor = '';
      if (before) {
        values.push(before.occurredAtMs, before.eventId);
        cursor = 'AND (occurred_at_ms, event_id) < ($2, $3::uuid)';
      }
      values.push(authorized.query.limit + 1);
      const limitParameter = `$${values.length}`;
      const result = await client.query<Row>(
        `SELECT event_id AS "eventId", request_id AS "requestId",
                operation_id AS "operationId", project_id AS "projectId",
                subject_type AS "subjectType", subject_id AS "subjectId",
                authentication_id AS "authenticationId", outcome, reasons,
                project_version AS "projectVersion",
                binding_version AS "bindingVersion",
                occurred_at_ms AS "occurredAtMs"
           FROM "ql3"."security_audit_events"
          WHERE project_id = $1
            AND operation_id IN (
              'model_provider_credential.bind',
              'model_provider_credential.revoke'
            )
            ${cursor}
          ORDER BY occurred_at_ms DESC, event_id DESC
          LIMIT ${limitParameter}`,
        values,
      );
      const hasMore = result.rows.length > authorized.query.limit;
      const records = Object.freeze(
        result.rows
          .slice(0, authorized.query.limit)
          .map((row) => contentFreeRecord(auditRecordFromRow(row))),
      );
      const last = records.at(-1);
      if (!storedAudit) await insertAudit(client, authorized.audit);
      await client.query('COMMIT');
      return Object.freeze({
        projectId: authorized.query.projectId,
        records,
        nextCursor:
          hasMore && last
            ? Object.freeze({
                occurredAtMs: last.occurredAtMs,
                eventId: last.eventId,
              })
            : null,
      });
    } catch (error) {
      await rollback(client);
      throw mapError(error);
    } finally {
      client.release();
    }
  }
}
