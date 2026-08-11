// Security management owns bounded audit inspection and retention commands.
import path from 'node:path';

import {
  LocalSecurityAuditQueryAuthenticationError,
  LocalSecurityAuditQueryAuthorizationError,
  createLocalSecurityAuditQueryService,
  type LocalSecurityAuditQueryService,
} from '@qinglong/local-admin/security-audit-query';
import {
  LocalSecurityAuditRetentionAuthenticationError,
  LocalSecurityAuditRetentionAuthorizationError,
  createLocalSecurityAuditRetentionService,
  type LocalSecurityAuditRetentionService,
} from '@qinglong/local-admin/security-audit-retention';
import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';
import {
  AuthenticatedLocalCommandAuthenticationError,
  establishAuthenticatedLocalCommand,
  type AuthenticatedLocalCommand,
} from '@qinglong/local-owner-console/authenticated-command';
import {
  LocalSqliteAuthenticatedManagementFenceError,
  type LocalSqliteAuthenticatedUserCredentialFence,
} from '@qinglong/local-sqlite/authenticated-management';
import {
  openLocalSqliteSecurityAuditQueryDatabase,
  type LocalSqliteSecurityAuditQueryDatabase,
} from '@qinglong/local-sqlite/security-audit-query';
import {
  LocalSecurityAuditQueryAuthorizationFenceConflictError,
  LocalSecurityAuditQueryUnavailableError,
  MAX_LOCAL_SECURITY_AUDIT_QUERY_PAGE_SIZE,
} from '@qinglong/runtime-core/local-security-audit-query';
import {
  LocalSecurityAuditCompactionMutationConflictError,
  LocalSecurityAuditRetentionAuthorizationFenceConflictError,
  LocalSecurityAuditRetentionUnavailableError,
  MAX_EDGE_SECURITY_AUDIT_COMPACTION_BATCH_SIZE,
  MAX_LOCAL_SECURITY_AUDIT_RETENTION_MS,
  MAX_STANDALONE_SECURITY_AUDIT_COMPACTION_BATCH_SIZE,
  MIN_LOCAL_SECURITY_AUDIT_RETENTION_MS,
  type LocalSecurityAuditCompactionRecord,
} from '@qinglong/runtime-core/local-security-audit-retention';
import { assertProjectPolicyProjectId } from '@qinglong/runtime-core/project-policy';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';
import {
  normalizeSecurityAuditQuery,
  type SecurityAuditQuery,
  type SecurityAuditQueryCursor,
} from '@qinglong/runtime-core/security-audit-query';

const MAX_PATH_BYTES = 4096;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface LocalSecurityAuditQueryCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: 'edge' | 'standalone';
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

export interface LocalSecurityAuditQueryCommand {
  readonly schemaVersion: 1;
  readonly operation: 'security.audit.list';
  readonly options: LocalSecurityAuditQueryCommandOptions;
  readonly request: {
    readonly authorityProjectId: string;
    readonly query: SecurityAuditQuery;
    readonly requestId: string;
    readonly auditEventId: string;
  };
}

export interface LocalSecurityAuditCompactionCommand {
  readonly schemaVersion: 1;
  readonly operation: 'security.audit.compact';
  readonly options: LocalSecurityAuditQueryCommandOptions;
  readonly request: {
    readonly authorityProjectId: string;
    readonly retentionMs: number;
    readonly eligibleBeforeMs: number;
    readonly limit: number;
    readonly mutationId: string;
    readonly requestId: string;
    readonly failureAuditEventId: string;
  };
}

export type LocalSecurityAuditCommand =
  | LocalSecurityAuditQueryCommand
  | LocalSecurityAuditCompactionCommand;

export interface RedactedLocalSecurityAuditRecord {
  readonly eventId: string;
  readonly requestId: string;
  readonly operationId: string;
  readonly projectId: string | null;
  readonly subject: SecurityAuditRecord['subject'];
  readonly outcome: SecurityAuditRecord['outcome'];
  readonly reasons: readonly string[];
  readonly fence: SecurityAuditRecord['fence'];
  readonly occurredAtMs: number;
}

export interface LocalSecurityAuditQueryCommandResult {
  readonly schemaVersion: 1;
  readonly operation: 'security.audit.list';
  readonly records: readonly Readonly<RedactedLocalSecurityAuditRecord>[];
  readonly nextCursor: Readonly<SecurityAuditQueryCursor> | null;
}

export interface LocalSecurityAuditCompactionCommandResult {
  readonly schemaVersion: 1;
  readonly operation: 'security.audit.compact';
  readonly status: 'inserted' | 'existing';
  readonly mutationId: string;
  readonly retentionMs: number;
  readonly eligibleBeforeMs: number;
  readonly batchLimit: number;
  readonly deletedCount: number;
  readonly deletedPayloadBytes: number;
  readonly first: LocalSecurityAuditCompactionRecord['first'];
  readonly last: LocalSecurityAuditCompactionRecord['last'];
  readonly recordsDigest: string;
  readonly createdAtMs: number;
}

export type LocalSecurityAuditCommandResult =
  | LocalSecurityAuditQueryCommandResult
  | LocalSecurityAuditCompactionCommandResult;

export interface LocalSecurityAuditQueryCommandRunner {
  run(
    commandFilePath: string,
  ): Promise<Readonly<LocalSecurityAuditCommandResult>>;
}

export interface LocalSecurityAuditQueryCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqliteSecurityAuditQueryDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly createService: typeof createLocalSecurityAuditQueryService;
  readonly createRetentionService: typeof createLocalSecurityAuditRetentionService;
  readonly now: () => number;
}

export class LocalSecurityAuditQueryCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_SECURITY_AUDIT_QUERY_COMMAND_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local security audit query command is invalid: ${message}`);
    this.name = 'LocalSecurityAuditQueryCommandConfigurationError';
  }
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalSecurityAuditQueryCommandConfigurationError(
      `${label} must be an object`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new LocalSecurityAuditQueryCommandConfigurationError(
      `${label} shape is invalid`,
    );
  }
}

function boundedPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new LocalSecurityAuditQueryCommandConfigurationError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

function descendant(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new LocalSecurityAuditQueryCommandConfigurationError(
      `${label} must be a descendant of deploymentRoot`,
    );
  }
}

function normalizeOptions(
  value: unknown,
): Readonly<LocalSecurityAuditQueryCommandOptions> {
  const hasBusyTimeout =
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'busyTimeoutMs');
  exactObject(
    value,
    [
      'deploymentRoot',
      'databasePath',
      'profile',
      'ownerPepperKeyringDirectory',
      'credentialFilePath',
      ...(hasBusyTimeout ? ['busyTimeoutMs'] : []),
    ],
    'options',
  );
  const deploymentRoot = boundedPath(value.deploymentRoot, 'deploymentRoot');
  for (const key of [
    'databasePath',
    'ownerPepperKeyringDirectory',
    'credentialFilePath',
  ] as const) {
    descendant(deploymentRoot, boundedPath(value[key], key), key);
  }
  if (value.profile !== 'edge' && value.profile !== 'standalone') {
    throw new LocalSecurityAuditQueryCommandConfigurationError(
      'profile must be edge or standalone',
    );
  }
  if (
    value.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(value.busyTimeoutMs) ||
      (value.busyTimeoutMs as number) < 100 ||
      (value.busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalSecurityAuditQueryCommandConfigurationError(
      'busyTimeoutMs is invalid',
    );
  }
  return Object.freeze(
    value as unknown as LocalSecurityAuditQueryCommandOptions,
  );
}

function normalizeCommand(value: unknown): Readonly<LocalSecurityAuditCommand> {
  exactObject(
    value,
    ['schemaVersion', 'operation', 'options', 'request'],
    'command',
  );
  if (
    value.schemaVersion !== 1 ||
    (value.operation !== 'security.audit.list' &&
      value.operation !== 'security.audit.compact')
  ) {
    throw new LocalSecurityAuditQueryCommandConfigurationError(
      'command version or operation is invalid',
    );
  }
  const options = normalizeOptions(value.options);
  const compact = value.operation === 'security.audit.compact';
  exactObject(
    value.request,
    compact
      ? [
          'authorityProjectId',
          'retentionMs',
          'eligibleBeforeMs',
          'limit',
          'mutationId',
          'requestId',
          'failureAuditEventId',
        ]
      : ['authorityProjectId', 'query', 'requestId', 'auditEventId'],
    'request',
  );
  try {
    assertProjectPolicyProjectId(value.request.authorityProjectId as string);
  } catch {
    throw new LocalSecurityAuditQueryCommandConfigurationError(
      'authority Project identity is invalid',
    );
  }
  if (
    typeof value.request.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(value.request.requestId)
  ) {
    throw new LocalSecurityAuditQueryCommandConfigurationError(
      'audit or request identity is invalid',
    );
  }
  if (compact) {
    const profileLimit =
      options.profile === 'edge'
        ? MAX_EDGE_SECURITY_AUDIT_COMPACTION_BATCH_SIZE
        : MAX_STANDALONE_SECURITY_AUDIT_COMPACTION_BATCH_SIZE;
    if (
      typeof value.request.mutationId !== 'string' ||
      !UUID_V4_PATTERN.test(value.request.mutationId) ||
      typeof value.request.failureAuditEventId !== 'string' ||
      !UUID_V4_PATTERN.test(value.request.failureAuditEventId) ||
      value.request.mutationId === value.request.failureAuditEventId ||
      !Number.isSafeInteger(value.request.retentionMs) ||
      (value.request.retentionMs as number) <
        MIN_LOCAL_SECURITY_AUDIT_RETENTION_MS ||
      (value.request.retentionMs as number) >
        MAX_LOCAL_SECURITY_AUDIT_RETENTION_MS ||
      !Number.isSafeInteger(value.request.eligibleBeforeMs) ||
      (value.request.eligibleBeforeMs as number) < 0 ||
      !Number.isSafeInteger(
        (value.request.eligibleBeforeMs as number) +
          (value.request.retentionMs as number),
      ) ||
      !Number.isSafeInteger(value.request.limit) ||
      (value.request.limit as number) < 1 ||
      (value.request.limit as number) > profileLimit
    ) {
      throw new LocalSecurityAuditQueryCommandConfigurationError(
        'compaction identity, retention fence, or limit is invalid',
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      operation: 'security.audit.compact',
      options,
      request: Object.freeze({
        authorityProjectId: value.request.authorityProjectId as string,
        retentionMs: value.request.retentionMs as number,
        eligibleBeforeMs: value.request.eligibleBeforeMs as number,
        limit: value.request.limit as number,
        mutationId: value.request.mutationId,
        requestId: value.request.requestId,
        failureAuditEventId: value.request.failureAuditEventId,
      }),
    });
  }
  if (
    typeof value.request.auditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(value.request.auditEventId)
  ) {
    throw new LocalSecurityAuditQueryCommandConfigurationError(
      'audit identity is invalid',
    );
  }
  let query: Readonly<SecurityAuditQuery>;
  try {
    query = normalizeSecurityAuditQuery(
      value.request.query as SecurityAuditQuery,
    );
  } catch {
    throw new LocalSecurityAuditQueryCommandConfigurationError(
      'filter, cursor, or limit is invalid',
    );
  }
  if (query.limit > MAX_LOCAL_SECURITY_AUDIT_QUERY_PAGE_SIZE) {
    throw new LocalSecurityAuditQueryCommandConfigurationError(
      'limit exceeds the local maximum of 64',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: 'security.audit.list',
    options,
    request: Object.freeze({
      authorityProjectId: value.request.authorityProjectId as string,
      query,
      requestId: value.request.requestId,
      auditEventId: value.request.auditEventId,
    }),
  });
}

function readCommandFile(
  candidatePath: string,
): Readonly<LocalSecurityAuditCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(candidatePath));
  } catch (error) {
    if (error instanceof LocalSecurityAuditQueryCommandConfigurationError) {
      throw error;
    }
    throw new LocalSecurityAuditQueryCommandConfigurationError(
      'command file cannot be read',
      error,
    );
  }
}

function failureAudit(
  command: Readonly<LocalSecurityAuditCommand>,
  authenticated: Readonly<AuthenticatedLocalCommand> | undefined,
  error: unknown,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> | null {
  if (
    error instanceof LocalSecurityAuditQueryAuthorizationError ||
    error instanceof LocalSecurityAuditQueryUnavailableError ||
    error instanceof LocalSecurityAuditRetentionAuthorizationError ||
    error instanceof LocalSecurityAuditRetentionUnavailableError
  ) {
    return null;
  }
  const eventId =
    command.operation === 'security.audit.compact'
      ? command.request.failureAuditEventId
      : command.request.auditEventId;
  if (
    !authenticated ||
    error instanceof AuthenticatedLocalCommandAuthenticationError ||
    error instanceof LocalSecurityAuditQueryAuthenticationError ||
    error instanceof LocalSecurityAuditRetentionAuthenticationError
  ) {
    return Object.freeze({
      eventId,
      requestId: command.request.requestId,
      operationId: command.operation,
      projectId: command.request.authorityProjectId,
      subject: authenticated?.principal.subject ?? null,
      authenticationId: authenticated?.principal.authenticationId ?? null,
      outcome: 'authentication_rejected',
      reasons: Object.freeze(['credential_rejected']),
      fence: null,
      occurredAtMs,
    });
  }
  if (
    error instanceof LocalSqliteAuthenticatedManagementFenceError ||
    error instanceof LocalSecurityAuditQueryAuthorizationFenceConflictError ||
    error instanceof LocalSecurityAuditRetentionAuthorizationFenceConflictError
  ) {
    return Object.freeze({
      eventId,
      requestId: command.request.requestId,
      operationId: command.operation,
      projectId: command.request.authorityProjectId,
      subject: authenticated.principal.subject,
      authenticationId: authenticated.principal.authenticationId,
      outcome: 'denied',
      reasons: Object.freeze(['credential_or_policy_fence_rejected']),
      fence: null,
      occurredAtMs,
    });
  }
  if (error instanceof LocalSecurityAuditCompactionMutationConflictError) {
    return Object.freeze({
      eventId,
      requestId: command.request.requestId,
      operationId: command.operation,
      projectId: command.request.authorityProjectId,
      subject: authenticated?.principal.subject ?? null,
      authenticationId: authenticated?.principal.authenticationId ?? null,
      outcome: 'denied',
      reasons: Object.freeze(['mutation_conflict']),
      fence: null,
      occurredAtMs,
    });
  }
  return null;
}

function dependencies(
  value: LocalSecurityAuditQueryCommandRunnerDependencies,
): Readonly<LocalSecurityAuditQueryCommandRunnerDependencies> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      [
        'authenticate',
        'createRetentionService',
        'createService',
        'now',
        'openDatabase',
      ]
        .sort()
        .join('\0') ||
    typeof value.openDatabase !== 'function' ||
    typeof value.authenticate !== 'function' ||
    typeof value.createService !== 'function' ||
    typeof value.createRetentionService !== 'function' ||
    typeof value.now !== 'function'
  ) {
    throw new LocalSecurityAuditQueryCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

function redact(
  record: Readonly<SecurityAuditRecord>,
): Readonly<RedactedLocalSecurityAuditRecord> {
  return Object.freeze({
    eventId: record.eventId,
    requestId: record.requestId,
    operationId: record.operationId,
    projectId: record.projectId,
    subject: record.subject,
    outcome: record.outcome,
    reasons: record.reasons,
    fence: record.fence,
    occurredAtMs: record.occurredAtMs,
  });
}

export function createLocalSecurityAuditQueryCommandRunner(
  candidateDependencies: LocalSecurityAuditQueryCommandRunnerDependencies = {
    openDatabase: openLocalSqliteSecurityAuditQueryDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    createService: createLocalSecurityAuditQueryService,
    createRetentionService: createLocalSecurityAuditRetentionService,
    now: Date.now,
  },
): LocalSecurityAuditQueryCommandRunner {
  const adapters = dependencies(candidateDependencies);
  return Object.freeze({
    async run(commandFilePath: string) {
      const command = readCommandFile(commandFilePath);
      const database = await adapters.openDatabase({
        databasePath: command.options.databasePath,
        profile: command.options.profile,
        ...(command.options.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: command.options.busyTimeoutMs }),
      });
      let authenticated: Readonly<AuthenticatedLocalCommand> | undefined;
      try {
        try {
          authenticated = await adapters.authenticate(database, {
            deploymentRoot: command.options.deploymentRoot,
            databasePath: command.options.databasePath,
            ownerPepperKeyringDirectory:
              command.options.ownerPepperKeyringDirectory,
            credentialFilePath: command.options.credentialFilePath,
            authenticationNamespace: 'local_security_audit',
          });
          await authenticated.confirm();
          database.activateUserCredentialFence(
            authenticated.databaseFence as Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
          );
          if (command.operation === 'security.audit.compact') {
            const service: LocalSecurityAuditRetentionService =
              adapters.createRetentionService(
                database.projectPolicy,
                database.securityAuditRetention,
                { now: adapters.now },
              );
            const result = await service.compact({
              authorityProjectId: command.request.authorityProjectId,
              retentionMs: command.request.retentionMs,
              eligibleBeforeMs: command.request.eligibleBeforeMs,
              limit: command.request.limit,
              mutationId: command.request.mutationId,
              requestId: command.request.requestId,
              failureAuditEventId: command.request.failureAuditEventId,
              principal: authenticated.principal,
            });
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: command.operation,
              status: result.status,
              mutationId: result.record.mutationId,
              retentionMs: result.record.retentionMs,
              eligibleBeforeMs: result.record.eligibleBeforeMs,
              batchLimit: result.record.batchLimit,
              deletedCount: result.record.deletedCount,
              deletedPayloadBytes: result.record.deletedPayloadBytes,
              first: result.record.first,
              last: result.record.last,
              recordsDigest: result.record.recordsDigest,
              createdAtMs: result.record.createdAtMs,
            });
          }
          const service: LocalSecurityAuditQueryService =
            adapters.createService(
              database.projectPolicy,
              database.securityAuditQuery,
              { now: adapters.now },
            );
          const result = await service.list({
            authorityProjectId: command.request.authorityProjectId,
            query: command.request.query,
            auditEventId: command.request.auditEventId,
            requestId: command.request.requestId,
            principal: authenticated.principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            records: Object.freeze(result.records.map(redact)),
            nextCursor: result.nextCursor,
          });
        } catch (error) {
          const audit = failureAudit(
            command,
            authenticated,
            error,
            adapters.now(),
          );
          if (audit) {
            try {
              await database.securityAudit.record(audit);
            } catch {
              throw new LocalSecurityAuditQueryUnavailableError();
            }
          }
          throw error;
        }
      } finally {
        await database.close();
      }
    },
  });
}

export function runLocalSecurityAuditQueryCommandFile(
  commandFilePath: string,
): Promise<Readonly<LocalSecurityAuditCommandResult>> {
  return createLocalSecurityAuditQueryCommandRunner().run(commandFilePath);
}
