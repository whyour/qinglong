// AI management owns explicit feature lifecycle commands.
import path from 'node:path';

import {
  LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
  assertLocalModelInvocationFeatureReady,
  migrateLocalModelInvocationFeature,
} from '@qinglong/ai/model-invocation-migration';
import {
  LocalModelInvocationFeatureActivationRepository,
  LocalModelInvocationFeatureTransitionConflictError,
  LocalModelInvocationFeatureTransitionUnavailableError,
  createLocalModelInvocationFeatureTransitionCommand,
  type LocalModelInvocationFeatureState,
  type LocalModelInvocationFeatureTransition,
} from '@qinglong/ai/local-feature-activation';
import {
  PrivateLocalCommandFileError,
  readPrivateLocalCommandFile,
} from '@qinglong/local-command-file';
import {
  establishAuthenticatedLocalCommand,
  type AuthenticatedLocalCommand,
} from '@qinglong/local-owner-console/authenticated-command';
import {
  LocalSqliteAuthenticatedManagementFenceError,
  LocalSqliteAuthenticatedManagementOwnerError,
  openLocalSqliteAuthenticatedManagementDatabase,
  type LocalSqliteAuthenticatedManagementDatabase,
  type LocalSqliteProfile,
} from '@qinglong/local-sqlite/authenticated-management';

const MAX_PATH_BYTES = 4096;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface LocalAiFeatureCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: LocalSqliteProfile;
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

interface BaseRequest {
  readonly requestId: string;
  readonly failureAuditEventId: string;
}

export interface InspectLocalAiFeatureCommand {
  readonly schemaVersion: 1;
  readonly operation: 'ai-feature.inspect';
  readonly options: LocalAiFeatureCommandOptions;
  readonly request: BaseRequest;
}

export interface ActivateLocalAiFeatureCommand {
  readonly schemaVersion: 1;
  readonly operation: 'ai-feature.activate';
  readonly options: LocalAiFeatureCommandOptions;
  readonly request: BaseRequest & {
    readonly mutationId: string;
    readonly expectedGeneration: number;
    readonly expectedState: 'inactive' | null;
    readonly expectedMigrationDigest: string;
    readonly safety:
      | Readonly<{
          readonly mode: 'fresh_database';
          readonly backupEvidenceDigest: null;
        }>
      | Readonly<{
          readonly mode: 'backup_verified';
          readonly backupEvidenceDigest: string;
        }>;
  };
}

export interface DeactivateLocalAiFeatureCommand {
  readonly schemaVersion: 1;
  readonly operation: 'ai-feature.deactivate';
  readonly options: LocalAiFeatureCommandOptions;
  readonly request: BaseRequest & {
    readonly mutationId: string;
    readonly expectedGeneration: number;
    readonly expectedState: 'active';
    readonly expectedMigrationDigest: string;
    readonly safety: Readonly<{
      readonly mode: 'preserve_existing';
      readonly backupEvidenceDigest: null;
    }>;
  };
}

export type LocalAiFeatureCommand =
  | InspectLocalAiFeatureCommand
  | ActivateLocalAiFeatureCommand
  | DeactivateLocalAiFeatureCommand;

export type LocalAiFeatureSchemaState =
  | 'absent'
  | 'partial_or_drifted'
  | 'ready';

export type LocalAiFeatureCommandResult = Readonly<{
  schemaVersion: 1;
  operation: LocalAiFeatureCommand['operation'];
  migrationPlanDigest: string;
  schemaState: LocalAiFeatureSchemaState;
  activation: Readonly<{
    generation: number;
    state: LocalModelInvocationFeatureState;
    transitionDigest: string;
    committedAtMs: number;
  }> | null;
  runtimeAction: 'none' | 'restart_required';
  status?: 'created' | 'existing';
}>;

export interface LocalAiFeatureCommandRunner {
  run(commandFilePath: string): Promise<Readonly<LocalAiFeatureCommandResult>>;
}

export interface LocalAiFeatureCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqliteAuthenticatedManagementDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly migrate: typeof migrateLocalModelInvocationFeature;
  readonly now: () => number;
}

export class LocalAiFeatureCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_AI_FEATURE_COMMAND_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local AI feature command configuration is invalid: ${message}`);
    this.name = 'LocalAiFeatureCommandConfigurationError';
  }
}

export class LocalAiFeatureDataSafetyError extends Error {
  readonly code = 'LOCAL_AI_FEATURE_DATA_SAFETY_REJECTED';

  constructor() {
    super('Local AI feature data-safety evidence was rejected');
    this.name = 'LocalAiFeatureDataSafetyError';
  }
}

export class LocalAiFeatureInFlightInvocationError extends Error {
  readonly code = 'LOCAL_AI_FEATURE_IN_FLIGHT_INVOCATION';

  constructor() {
    super('Local AI feature has an in-flight invocation');
    this.name = 'LocalAiFeatureInFlightInvocationError';
  }
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalAiFeatureCommandConfigurationError(
      `${label} must be an object`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new LocalAiFeatureCommandConfigurationError(
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
    throw new LocalAiFeatureCommandConfigurationError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

function options(value: unknown): LocalAiFeatureCommandOptions {
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
  for (const key of [
    'deploymentRoot',
    'databasePath',
    'ownerPepperKeyringDirectory',
    'credentialFilePath',
  ] as const) {
    boundedPath(value[key], key);
  }
  if (value.profile !== 'edge' && value.profile !== 'standalone') {
    throw new LocalAiFeatureCommandConfigurationError(
      'profile must be edge or standalone',
    );
  }
  if (
    value.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(value.busyTimeoutMs) ||
      (value.busyTimeoutMs as number) < 100 ||
      (value.busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalAiFeatureCommandConfigurationError(
      'busyTimeoutMs is invalid',
    );
  }
  return Object.freeze(value as unknown as LocalAiFeatureCommandOptions);
}

function baseRequest(
  value: unknown,
  extraKeys: readonly string[],
): asserts value is Record<string, unknown> {
  exactObject(
    value,
    ['requestId', 'failureAuditEventId', ...extraKeys],
    'request',
  );
  if (
    typeof value.requestId !== 'string' ||
    !IDENTITY_PATTERN.test(value.requestId) ||
    typeof value.failureAuditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(value.failureAuditEventId)
  ) {
    throw new LocalAiFeatureCommandConfigurationError(
      'request identity is invalid',
    );
  }
}

function transitionRequest(
  value: unknown,
  operation: 'ai-feature.activate' | 'ai-feature.deactivate',
): void {
  baseRequest(value, [
    'mutationId',
    'expectedGeneration',
    'expectedState',
    'expectedMigrationDigest',
    'safety',
  ]);
  if (
    typeof value.mutationId !== 'string' ||
    !IDENTITY_PATTERN.test(value.mutationId) ||
    !Number.isSafeInteger(value.expectedGeneration) ||
    (value.expectedGeneration as number) < 0 ||
    (value.expectedGeneration as number) > 2_147_483_647 ||
    typeof value.expectedMigrationDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.expectedMigrationDigest)
  ) {
    throw new LocalAiFeatureCommandConfigurationError(
      'transition fence is invalid',
    );
  }
  exactObject(value.safety, ['mode', 'backupEvidenceDigest'], 'safety');
  const candidateSafety = value.safety;
  if (operation === 'ai-feature.activate') {
    if (
      (value.expectedGeneration === 0 && value.expectedState !== null) ||
      ((value.expectedGeneration as number) > 0 &&
        value.expectedState !== 'inactive') ||
      !(
        (candidateSafety.mode === 'fresh_database' &&
          candidateSafety.backupEvidenceDigest === null) ||
        (candidateSafety.mode === 'backup_verified' &&
          typeof candidateSafety.backupEvidenceDigest === 'string' &&
          DIGEST_PATTERN.test(candidateSafety.backupEvidenceDigest))
      )
    ) {
      throw new LocalAiFeatureCommandConfigurationError(
        'activation request is invalid',
      );
    }
  } else if (
    (value.expectedGeneration as number) < 1 ||
    value.expectedState !== 'active' ||
    candidateSafety.mode !== 'preserve_existing' ||
    candidateSafety.backupEvidenceDigest !== null
  ) {
    throw new LocalAiFeatureCommandConfigurationError(
      'deactivation request is invalid',
    );
  }
}

function normalizeCommand(value: unknown): Readonly<LocalAiFeatureCommand> {
  exactObject(
    value,
    ['schemaVersion', 'operation', 'options', 'request'],
    'command',
  );
  if (value.schemaVersion !== 1) {
    throw new LocalAiFeatureCommandConfigurationError(
      'schemaVersion is invalid',
    );
  }
  const commandOptions = options(value.options);
  if (value.operation === 'ai-feature.inspect') {
    baseRequest(value.request, []);
  } else if (
    value.operation === 'ai-feature.activate' ||
    value.operation === 'ai-feature.deactivate'
  ) {
    transitionRequest(value.request, value.operation);
  } else {
    throw new LocalAiFeatureCommandConfigurationError(
      'operation is invalid',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: value.operation,
    options: commandOptions,
    request: Object.freeze(value.request),
  } as LocalAiFeatureCommand);
}

function readCommandFile(
  commandFilePath: string,
): Readonly<LocalAiFeatureCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(commandFilePath));
  } catch (error) {
    if (error instanceof LocalAiFeatureCommandConfigurationError) throw error;
    if (error instanceof PrivateLocalCommandFileError) {
      throw new LocalAiFeatureCommandConfigurationError(
        'command file cannot be read',
        error,
      );
    }
    throw new LocalAiFeatureCommandConfigurationError(
      'command file cannot be read',
      error,
    );
  }
}

function schemaState(
  database: LocalSqliteAuthenticatedManagementDatabase,
): LocalAiFeatureSchemaState {
  const count = database.authority.client
    .prepare(
      `SELECT count(*) AS count
         FROM sqlite_schema
        WHERE type = 'table'
          AND (
            name = 'QingLong3AiSchemaMigrations'
            OR name LIKE 'ModelInvocation%'
            OR name LIKE 'ModelPriceCatalog%'
          )`,
    )
    .get() as { readonly count?: unknown };
  if (count.count === 0) return 'absent';
  try {
    assertLocalModelInvocationFeatureReady(database.authority.client);
    return 'ready';
  } catch {
    return 'partial_or_drifted';
  }
}

function activationSummary(
  transition: Readonly<LocalModelInvocationFeatureTransition> | null,
): LocalAiFeatureCommandResult['activation'] {
  return transition
    ? Object.freeze({
        generation: transition.generation,
        state: transition.state,
        transitionDigest: transition.transitionDigest,
        committedAtMs: transition.committedAtMs,
      })
    : null;
}

function inspect(
  database: LocalSqliteAuthenticatedManagementDatabase,
): Readonly<{
  schemaState: LocalAiFeatureSchemaState;
  current: Readonly<LocalModelInvocationFeatureTransition> | null;
}> {
  const currentSchemaState = schemaState(database);
  if (currentSchemaState !== 'ready') {
    return Object.freeze({ schemaState: currentSchemaState, current: null });
  }
  return Object.freeze({
    schemaState: currentSchemaState,
    current: new LocalModelInvocationFeatureActivationRepository(
      database.authority.client,
    ).findCurrent(),
  });
}

function assertFreshFeatureData(
  database: LocalSqliteAuthenticatedManagementDatabase,
): void {
  if (schemaState(database) === 'absent') return;
  const tables = [
    'ModelInvocationCompletions',
    'ModelInvocationPriceQuotes',
    'ModelInvocationPriceSettlements',
    'ModelInvocationQuotaReservations',
    'ModelInvocationQuotaSettlements',
    'ModelInvocationResolutions',
    'ModelInvocationStarts',
    'ModelInvocationUsageLedger',
    'ModelPriceCatalogAuthorizations',
    'ModelPriceCatalogHeads',
    'ModelPriceCatalogPublications',
  ];
  for (const table of tables) {
    const present = database.authority.client
      .prepare(
        `SELECT count(*) AS count
           FROM sqlite_schema
          WHERE type = 'table' AND name = ?`,
      )
      .get(table) as { readonly count?: unknown };
    if (present.count === 1) {
      const row = database.authority.client
        .prepare(`SELECT count(*) AS count FROM "${table}"`)
        .get() as { readonly count?: unknown };
      if (row.count !== 0) throw new LocalAiFeatureDataSafetyError();
    }
  }
}

function assertNoInFlightInvocation(
  database: LocalSqliteAuthenticatedManagementDatabase,
): void {
  const row = database.authority.client
    .prepare(
      `SELECT count(*) AS count
         FROM "ModelInvocationStarts" start
        WHERE NOT EXISTS (
                SELECT 1
                  FROM "ModelInvocationCompletions" completion
                 WHERE completion.invocation_id = start.invocation_id
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM "ModelInvocationResolutions" resolution
                 WHERE resolution.invocation_id = start.invocation_id
              )`,
    )
    .get() as { readonly count?: unknown };
  if (
    typeof row.count !== 'number' ||
    !Number.isSafeInteger(row.count) ||
    row.count !== 0
  ) {
    throw new LocalAiFeatureInFlightInvocationError();
  }
}

async function confirmOwner(
  database: LocalSqliteAuthenticatedManagementDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
): Promise<void> {
  await authenticated.confirm();
  database.confirmUserCredentialFence(authenticated.databaseFence);
  database.confirmDefaultProjectOwnerFence(authenticated.databaseFence);
}

async function execute(
  command: Readonly<LocalAiFeatureCommand>,
  database: LocalSqliteAuthenticatedManagementDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
  migrate: typeof migrateLocalModelInvocationFeature,
): Promise<Readonly<LocalAiFeatureCommandResult>> {
  await confirmOwner(database, authenticated);
  if (command.operation === 'ai-feature.inspect') {
    const status = inspect(database);
    await confirmOwner(database, authenticated);
    return Object.freeze({
      schemaVersion: 1,
      operation: command.operation,
      migrationPlanDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
      schemaState: status.schemaState,
      activation: activationSummary(status.current),
      runtimeAction: 'none',
    });
  }

  if (
    command.request.expectedMigrationDigest !==
    LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST
  ) {
    throw new LocalModelInvocationFeatureTransitionConflictError();
  }
  if (command.operation === 'ai-feature.activate') {
    const before = inspect(database);
    const isActivationReplay =
      before.current?.mutationId === command.request.mutationId;
    if (
      command.request.safety.mode === 'fresh_database' &&
      before.current !== null &&
      !isActivationReplay
    ) {
      throw new LocalAiFeatureDataSafetyError();
    }
    if (
      command.request.safety.mode === 'fresh_database' &&
      !isActivationReplay
    ) {
      assertFreshFeatureData(database);
    }
    await migrate(database.authority.client);
    assertLocalModelInvocationFeatureReady(database.authority.client);
  } else {
    assertLocalModelInvocationFeatureReady(database.authority.client);
    assertNoInFlightInvocation(database);
  }

  await authenticated.confirm();
  const repository = new LocalModelInvocationFeatureActivationRepository(
    database.authority.client,
    {
      beforeMutation(client, repositoryCommand) {
        if (
          repositoryCommand.principal.subject.type !==
            authenticated.principal.subject.type ||
          repositoryCommand.principal.subject.id !==
            authenticated.principal.subject.id ||
          repositoryCommand.principal.authenticationId !==
            authenticated.principal.authenticationId ||
          repositoryCommand.principal.assurance !==
            authenticated.principal.assurance
        ) {
          throw new LocalSqliteAuthenticatedManagementFenceError();
        }
        database.confirmUserCredentialFence(authenticated.databaseFence);
        database.confirmDefaultProjectOwnerFence(authenticated.databaseFence);
        if (repositoryCommand.state === 'inactive') {
          assertNoInFlightInvocation(database);
        }
        void client;
      },
    },
  );
  const committed = repository.transition(
    createLocalModelInvocationFeatureTransitionCommand({
      featureId: 'model-invocation',
      expectedGeneration: command.request.expectedGeneration,
      expectedState: command.request.expectedState,
      state:
        command.operation === 'ai-feature.activate' ? 'active' : 'inactive',
      mutationId: command.request.mutationId,
      requestId: command.request.requestId,
      expectedMigrationDigest: command.request.expectedMigrationDigest,
      safety: command.request.safety,
      principal: authenticated.principal,
    }),
  );
  return Object.freeze({
    schemaVersion: 1,
    operation: command.operation,
    migrationPlanDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
    schemaState: 'ready',
    activation: activationSummary(committed.transition),
    runtimeAction: 'restart_required',
    status: committed.status,
  });
}

type FailureAudit = Parameters<
  LocalSqliteAuthenticatedManagementDatabase['securityAudit']['record']
>[0];

function failureAudit(
  command: Readonly<LocalAiFeatureCommand>,
  authenticated: Readonly<AuthenticatedLocalCommand> | undefined,
  error: unknown,
  occurredAtMs: number,
): Readonly<FailureAudit> | null {
  let outcome: FailureAudit['outcome'];
  let reason: string;
  if (!authenticated) {
    outcome = 'authentication_rejected';
    reason = 'credential_rejected';
  } else if (error instanceof LocalSqliteAuthenticatedManagementFenceError) {
    outcome = 'denied';
    reason = 'credential_fence_rejected';
  } else if (error instanceof LocalSqliteAuthenticatedManagementOwnerError) {
    outcome = 'denied';
    reason = 'platform_owner_required';
  } else if (error instanceof LocalAiFeatureDataSafetyError) {
    outcome = 'denied';
    reason = 'data_safety_rejected';
  } else if (error instanceof LocalAiFeatureInFlightInvocationError) {
    outcome = 'denied';
    reason = 'in_flight_invocation';
  } else if (
    error instanceof LocalModelInvocationFeatureTransitionConflictError
  ) {
    outcome = 'denied';
    reason = 'transition_conflict';
  } else if (
    error instanceof LocalModelInvocationFeatureTransitionUnavailableError
  ) {
    outcome = 'authorization_unavailable';
    reason = 'transition_unavailable';
  } else {
    outcome = authenticated
      ? 'authorization_unavailable'
      : 'authentication_unavailable';
    reason = authenticated
      ? 'migration_unavailable'
      : 'authentication_unavailable';
  }
  return Object.freeze({
    eventId: command.request.failureAuditEventId,
    requestId: command.request.requestId,
    operationId: command.operation.replace('-', '_').replace('.', '_'),
    projectId: null,
    subject: authenticated?.principal.subject ?? null,
    authenticationId: authenticated?.principal.authenticationId ?? null,
    outcome,
    reasons: Object.freeze([reason]),
    fence: null,
    occurredAtMs,
  });
}

function dependencies(
  value: LocalAiFeatureCommandRunnerDependencies,
): Readonly<LocalAiFeatureCommandRunnerDependencies> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      ['authenticate', 'migrate', 'now', 'openDatabase'].sort().join('\0') ||
    typeof value.openDatabase !== 'function' ||
    typeof value.authenticate !== 'function' ||
    typeof value.migrate !== 'function' ||
    typeof value.now !== 'function'
  ) {
    throw new LocalAiFeatureCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

export function createLocalAiFeatureCommandRunner(
  candidateDependencies: LocalAiFeatureCommandRunnerDependencies = {
    openDatabase: openLocalSqliteAuthenticatedManagementDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    migrate: migrateLocalModelInvocationFeature,
    now: Date.now,
  },
): LocalAiFeatureCommandRunner {
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
            authenticationNamespace: 'local_ai_feature',
          });
          return await execute(
            command,
            database,
            authenticated,
            adapters.migrate,
          );
        } catch (error) {
          const audit = failureAudit(
            command,
            authenticated,
            error,
            adapters.now(),
          );
          if (audit) await database.securityAudit.record(audit);
          throw error;
        }
      } finally {
        await database.close();
      }
    },
  });
}

export function runLocalAiFeatureCommandFile(
  commandFilePath: string,
): Promise<Readonly<LocalAiFeatureCommandResult>> {
  return createLocalAiFeatureCommandRunner().run(commandFilePath);
}
