import path from 'node:path';

import {
  ApprovalInspectionAuthorizationError,
  ApprovalInspectionUnavailableError,
  createApprovalInspectionService,
} from '@qinglong/runtime-core/approval-inspection';
import {
  ApprovalDecisionAuthorizationError,
  ApprovalDecisionBindingConflictError,
  ApprovalDecisionTargetUnavailableError,
  ApprovalDecisionUnavailableError,
  createApprovalDecisionService,
  type ApprovalDecisionService,
} from '@qinglong/runtime-core/approval-decision';
import {
  ApprovalMutationConflictError,
  ApprovalPolicyFenceConflictError,
  ApprovalRequestExpiredError,
  ApprovalRequestStateConflictError,
  ApprovalRequestVersionConflictError,
  ApprovalUnavailableError,
  normalizeApprovedActionBinding,
  type ApprovalDecision,
  type ApprovedActionBinding,
} from '@qinglong/runtime-core/approved-action';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';
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
  openLocalSqliteApprovalDecisionDatabase,
  type LocalSqliteApprovalDecisionDatabase,
} from '@qinglong/local-sqlite/approval-decision-database';

const MAX_PATH_BYTES = 4096;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface LocalApprovalCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly profile: 'edge' | 'standalone';
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

interface BaseLocalApprovalRequest {
  readonly projectId: string;
  readonly approvalRequestId: string;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly failureAuditEventId: string;
}

export interface InspectLocalApprovalCommand {
  readonly schemaVersion: 1;
  readonly operation: 'approval.inspect';
  readonly options: LocalApprovalCommandOptions;
  readonly request: BaseLocalApprovalRequest;
}

export interface DecideLocalApprovalCommand {
  readonly schemaVersion: 1;
  readonly operation: 'approval.decide';
  readonly options: LocalApprovalCommandOptions;
  readonly request: BaseLocalApprovalRequest & {
    readonly expectedVersion: 1;
    readonly expectedAction: Readonly<ApprovedActionBinding>;
    readonly decisionId: string;
    readonly decision: ApprovalDecision;
    readonly reasonCode: string;
  };
}

export type LocalApprovalCommand =
  | InspectLocalApprovalCommand
  | DecideLocalApprovalCommand;

export type LocalApprovalCommandResult = Readonly<
  Record<string, unknown> & {
    readonly schemaVersion: 1;
    readonly operation: LocalApprovalCommand['operation'];
  }
>;

export interface LocalApprovalCommandRunner {
  run(commandFilePath: string): Promise<Readonly<LocalApprovalCommandResult>>;
}

export interface LocalApprovalCommandRunnerDependencies {
  readonly openDatabase: typeof openLocalSqliteApprovalDecisionDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
  readonly createDecisionService: typeof createApprovalDecisionService;
  readonly now: () => number;
}

export class LocalApprovalCommandConfigurationError extends TypeError {
  readonly code = 'LOCAL_APPROVAL_COMMAND_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local Approval command is invalid: ${message}`);
    this.name = 'LocalApprovalCommandConfigurationError';
  }
}

export class LocalApprovalCommandAuthorizationError extends Error {
  readonly code = 'LOCAL_APPROVAL_COMMAND_AUTHORIZATION_REJECTED';

  constructor() {
    super('Local Approval command authorization was rejected');
    this.name = 'LocalApprovalCommandAuthorizationError';
  }
}

function exactObject(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')
  ) {
    throw new LocalApprovalCommandConfigurationError(
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
    throw new LocalApprovalCommandConfigurationError(`${label} is invalid`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new LocalApprovalCommandConfigurationError(`${label} is invalid`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new LocalApprovalCommandConfigurationError(`${label} is invalid`);
  }
  return value;
}

function normalizeOptions(value: unknown): Readonly<LocalApprovalCommandOptions> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalApprovalCommandConfigurationError('options are invalid');
  }
  const candidate = value as Record<string, unknown>;
  exactObject(
    candidate,
    [
      'deploymentRoot',
      'databasePath',
      'profile',
      'ownerPepperKeyringDirectory',
      'credentialFilePath',
      ...(candidate.busyTimeoutMs === undefined ? [] : ['busyTimeoutMs']),
    ],
    'options',
  );
  if (
    candidate.profile !== 'edge' &&
    candidate.profile !== 'standalone'
  ) {
    throw new LocalApprovalCommandConfigurationError('profile is invalid');
  }
  if (
    candidate.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(candidate.busyTimeoutMs) ||
      Number(candidate.busyTimeoutMs) < 0 ||
      Number(candidate.busyTimeoutMs) > 60_000)
  ) {
    throw new LocalApprovalCommandConfigurationError(
      'busyTimeoutMs is invalid',
    );
  }
  return Object.freeze({
    deploymentRoot: boundedPath(candidate.deploymentRoot, 'deploymentRoot'),
    databasePath: boundedPath(candidate.databasePath, 'databasePath'),
    profile: candidate.profile,
    ownerPepperKeyringDirectory: boundedPath(
      candidate.ownerPepperKeyringDirectory,
      'ownerPepperKeyringDirectory',
    ),
    credentialFilePath: boundedPath(
      candidate.credentialFilePath,
      'credentialFilePath',
    ),
    ...(candidate.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: Number(candidate.busyTimeoutMs) }),
  });
}

function normalizeAction(value: unknown): Readonly<ApprovedActionBinding> {
  try {
    return normalizeApprovedActionBinding(value as ApprovedActionBinding);
  } catch {
    throw new LocalApprovalCommandConfigurationError(
      'expectedAction is invalid',
    );
  }
}

function normalizeBaseRequest(value: Record<string, unknown>) {
  return Object.freeze({
    projectId: identifier(value.projectId, 'projectId'),
    approvalRequestId: identifier(
      value.approvalRequestId,
      'approvalRequestId',
    ),
    requestId: identifier(value.requestId, 'requestId'),
    auditEventId: uuid(value.auditEventId, 'auditEventId'),
    failureAuditEventId: uuid(
      value.failureAuditEventId,
      'failureAuditEventId',
    ),
  });
}

function normalizeCommand(value: unknown): Readonly<LocalApprovalCommand> {
  exactObject(value, ['schemaVersion', 'operation', 'options', 'request'], 'command');
  if (
    value.schemaVersion !== 1 ||
    (value.operation !== 'approval.inspect' &&
      value.operation !== 'approval.decide')
  ) {
    throw new LocalApprovalCommandConfigurationError('command is invalid');
  }
  const options = normalizeOptions(value.options);
  const request = value.request;
  if (value.operation === 'approval.inspect') {
    exactObject(
      request,
      [
        'projectId',
        'approvalRequestId',
        'requestId',
        'auditEventId',
        'failureAuditEventId',
      ],
      'inspect request',
    );
    return Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      options,
      request: normalizeBaseRequest(request),
    });
  }
  exactObject(
    request,
    [
      'projectId',
      'approvalRequestId',
      'requestId',
      'auditEventId',
      'failureAuditEventId',
      'expectedVersion',
      'expectedAction',
      'decisionId',
      'decision',
      'reasonCode',
    ],
    'decision request',
  );
  if (
    request.expectedVersion !== 1 ||
    (request.decision !== 'approved' && request.decision !== 'rejected') ||
    typeof request.reasonCode !== 'string' ||
    !REASON_PATTERN.test(request.reasonCode)
  ) {
    throw new LocalApprovalCommandConfigurationError(
      'decision tuple is invalid',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: value.operation,
    options,
    request: Object.freeze({
      ...normalizeBaseRequest(request),
      expectedVersion: 1,
      expectedAction: normalizeAction(request.expectedAction),
      decisionId: identifier(request.decisionId, 'decisionId'),
      decision: request.decision,
      reasonCode: request.reasonCode,
    }),
  });
}

function readCommandFile(candidatePath: string): Readonly<LocalApprovalCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(candidatePath));
  } catch (error) {
    if (error instanceof LocalApprovalCommandConfigurationError) throw error;
    throw new LocalApprovalCommandConfigurationError(
      'command file cannot be read',
      error,
    );
  }
}

function failureAudit(
  command: Readonly<LocalApprovalCommand>,
  authenticated: Readonly<AuthenticatedLocalCommand> | undefined,
  error: unknown,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> | null {
  let outcome: SecurityAuditRecord['outcome'];
  let reason: string;
  if (
    !authenticated ||
    error instanceof AuthenticatedLocalCommandAuthenticationError
  ) {
    outcome = 'authentication_rejected';
    reason = 'credential_rejected';
  } else if (
    error instanceof LocalApprovalCommandAuthorizationError ||
    error instanceof ApprovalInspectionAuthorizationError ||
    error instanceof ApprovalDecisionAuthorizationError ||
    error instanceof LocalSqliteAuthenticatedManagementFenceError
  ) {
    outcome = 'denied';
    reason = 'credential_or_policy_fence_rejected';
  } else if (error instanceof ApprovalDecisionTargetUnavailableError) {
    outcome = 'denied';
    reason = 'approval_target_unavailable';
  } else if (error instanceof ApprovalDecisionBindingConflictError) {
    outcome = 'denied';
    reason = 'approval_binding_conflict';
  } else if (
    error instanceof ApprovalRequestVersionConflictError ||
    error instanceof ApprovalRequestStateConflictError ||
    error instanceof ApprovalRequestExpiredError ||
    error instanceof ApprovalMutationConflictError ||
    error instanceof ApprovalPolicyFenceConflictError
  ) {
    outcome = 'denied';
    reason = 'approval_state_or_fence_conflict';
  } else if (
    error instanceof ApprovalDecisionUnavailableError ||
    error instanceof ApprovalInspectionUnavailableError ||
    error instanceof ApprovalUnavailableError
  ) {
    outcome = 'authorization_unavailable';
    reason = 'approval_authority_unavailable';
  } else {
    return null;
  }
  return Object.freeze({
    eventId: command.request.failureAuditEventId,
    requestId: command.request.requestId,
    operationId: command.operation,
    projectId: command.request.projectId,
    subject: authenticated?.principal.subject ?? null,
    authenticationId: authenticated?.principal.authenticationId ?? null,
    outcome,
    reasons: Object.freeze([reason]),
    fence: null,
    occurredAtMs,
  });
}

function dependencies(
  value: LocalApprovalCommandRunnerDependencies,
): Readonly<LocalApprovalCommandRunnerDependencies> {
  exactObject(
    value,
    ['openDatabase', 'authenticate', 'createDecisionService', 'now'],
    'runner dependencies',
  );
  if (
    typeof value.openDatabase !== 'function' ||
    typeof value.authenticate !== 'function' ||
    typeof value.createDecisionService !== 'function' ||
    typeof value.now !== 'function'
  ) {
    throw new LocalApprovalCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

async function activateFence(
  database: LocalSqliteApprovalDecisionDatabase,
  authenticated: Readonly<AuthenticatedLocalCommand>,
): Promise<void> {
  await authenticated.confirm();
  database.activateUserCredentialFence(
    authenticated.databaseFence as Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  );
}

export function createLocalApprovalCommandRunner(
  candidateDependencies: LocalApprovalCommandRunnerDependencies = {
    openDatabase: openLocalSqliteApprovalDecisionDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    createDecisionService: createApprovalDecisionService,
    now: Date.now,
  },
): Readonly<LocalApprovalCommandRunner> {
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
            authenticationNamespace: 'local_approval',
          });
          await activateFence(database, authenticated);
          const policy = new ProjectPolicyEngine(database.projectPolicy);
          if (command.operation === 'approval.inspect') {
            const inspection = createApprovalInspectionService({
              source: database.approvalDetails,
              policy,
              audit: database.securityAudit,
              now: adapters.now,
              confirmAuthorization: async () => {
                await authenticated!.confirm();
                database.confirmUserCredentialFence();
              },
            });
            const detail = await inspection.inspect({
              projectId: command.request.projectId,
              approvalRequestId: command.request.approvalRequestId,
              auditEventId: command.request.auditEventId,
              requestId: command.request.requestId,
              principal: authenticated.principal,
            });
            if (!detail) {
              return Object.freeze({
                schemaVersion: 1 as const,
                operation: command.operation,
                found: false,
              });
            }
            const request = detail.request;
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: command.operation,
              found: true,
              projectId: request.projectId,
              approvalRequestId: request.id,
              version: request.version,
              state: request.state,
              risk: request.risk,
              decisionMode: request.decisionMode,
              expectedAction: request.action,
              requestedBy: request.requestedBy,
              requestedAtMs: request.requestedAtMs,
              expiresAtMs: request.expiresAtMs,
              preview: detail.preview,
            });
          }
          const service: Readonly<ApprovalDecisionService> =
            adapters.createDecisionService({
              approvals: database.approvals,
              policy,
              now: adapters.now,
              confirmAuthorization: async () => {
                await authenticated!.confirm();
                database.confirmUserCredentialFence();
              },
            });
          const result = await service.decide({
            projectId: command.request.projectId,
            approvalRequestId: command.request.approvalRequestId,
            expectedVersion: command.request.expectedVersion,
            expectedAction: command.request.expectedAction,
            decisionId: command.request.decisionId,
            decision: command.request.decision,
            reasonCode: command.request.reasonCode,
            auditEventId: command.request.auditEventId,
            requestId: command.request.requestId,
            principal: authenticated.principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            status: result.status,
            projectId: result.request.projectId,
            approvalRequestId: result.request.id,
            version: result.request.version,
            state: result.request.state,
            decision: result.request.decision,
            reasonCode: result.request.decisionReasonCode,
            decidedBy: result.request.decidedBy,
            decidedAtMs: result.request.decidedAtMs,
            action: result.request.action,
          });
        } catch (error) {
          const failure = failureAudit(
            command,
            authenticated,
            error,
            adapters.now(),
          );
          if (failure) await database.securityAudit.record(failure);
          throw error;
        }
      } finally {
        await database.close();
      }
    },
  });
}

export function runLocalApprovalCommandFile(
  commandFilePath: string,
): Promise<Readonly<LocalApprovalCommandResult>> {
  return createLocalApprovalCommandRunner().run(commandFilePath);
}
