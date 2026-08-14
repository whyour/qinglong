import { createHash } from 'node:crypto';

import {
  approvedActionExecutionEffectiveStatus,
  completeApprovedActionExecution,
  normalizeApprovedActionExecutionRecord,
  normalizeApprovedActionExecutionSnapshot,
  type ApprovedActionExecutionRecord,
  type ApprovedActionExecutionSnapshot,
} from './approvedActionExecution';
import type { ProjectPolicyEngine } from '../security/project-policy/projectPolicy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyFence,
  type SecurityPrincipal,
  type SecuritySubject,
} from '../security/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
  type SecurityAuditSink,
} from '../security/audit/securityAudit';

export const APPROVED_ACTION_MANUAL_RECOVERY_SCHEMA =
  'qinglong/approved-action-manual-recovery@v1' as const;
export const APPROVED_ACTION_MANUAL_RECOVERY_DECISIONS = [
  'confirm_failed',
  'abandon_unknown',
] as const;
export const APPROVED_ACTION_MANUAL_RECOVERY_ACTION_TYPES = [
  'plugin_package.secret_binding.bind',
  'plugin_package.secret_binding.transition',
] as const;
export const MAX_APPROVED_ACTION_MANUAL_RECOVERY_AUTH_AGE_MS = 5 * 60_000;

export type ApprovedActionManualRecoveryDecision =
  (typeof APPROVED_ACTION_MANUAL_RECOVERY_DECISIONS)[number];

export interface ApprovedActionManualRecoveryResolutionRecord {
  readonly schema: typeof APPROVED_ACTION_MANUAL_RECOVERY_SCHEMA;
  readonly dispatchId: string;
  readonly dispatchDigest: string;
  readonly projectId: string;
  readonly actionType: string;
  readonly actionDigest: string;
  readonly executionVersion: number;
  readonly executionDigest: string;
  readonly mutationId: string;
  readonly decision: ApprovedActionManualRecoveryDecision;
  readonly evidenceDigest: string;
  readonly reasonCode: string;
  readonly resolvedBy: Readonly<SecuritySubject>;
  readonly authenticationId: string;
  readonly assurance: 'multi_factor' | 'hardware';
  readonly authenticatedAtMs: number;
  readonly authorizationFence: Readonly<SecurityPolicyFence>;
  readonly auditEventId: string;
  readonly resolvedAtMs: number;
  readonly resolutionDigest: string;
}

export interface ApprovedActionManualRecoverySnapshot {
  readonly execution: Readonly<ApprovedActionExecutionSnapshot>;
  readonly resolution: Readonly<ApprovedActionManualRecoveryResolutionRecord> | null;
}

export interface ApprovedActionManualRecoveryInspectRequest {
  readonly projectId: string;
  readonly dispatchId: string;
  readonly auditEventId: string;
  readonly requestId: string;
  readonly principal: Readonly<SecurityPrincipal>;
}

export interface ApprovedActionManualRecoveryResolveRequest
  extends ApprovedActionManualRecoveryInspectRequest {
  readonly expectedExecutionVersion: number;
  readonly expectedExecutionDigest: string;
  readonly mutationId: string;
  readonly decision: ApprovedActionManualRecoveryDecision;
  readonly evidenceDigest: string;
  readonly reasonCode: string;
}

export interface ResolveApprovedActionManualRecoveryCommand {
  readonly previous: Readonly<ApprovedActionExecutionSnapshot>;
  readonly nextExecution: Readonly<ApprovedActionExecutionRecord>;
  readonly resolution: Readonly<ApprovedActionManualRecoveryResolutionRecord>;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface ResolveApprovedActionManualRecoveryResult {
  readonly status: 'resolved' | 'existing';
  readonly snapshot: Readonly<ApprovedActionManualRecoverySnapshot>;
}

export interface ApprovedActionManualRecoveryRepository {
  findByDispatchId(
    dispatchId: string,
  ): Promise<Readonly<ApprovedActionManualRecoverySnapshot> | null>;
  resolve(
    command: Readonly<ResolveApprovedActionManualRecoveryCommand>,
  ): Promise<Readonly<ResolveApprovedActionManualRecoveryResult>>;
}

export interface ApprovedActionManualRecoveryService {
  inspect(
    request: ApprovedActionManualRecoveryInspectRequest,
    confirmAuthorization?: () => void | Promise<void>,
  ): Promise<Readonly<ApprovedActionManualRecoverySnapshot> | null>;
  resolve(
    request: ApprovedActionManualRecoveryResolveRequest,
    confirmAuthorization?: () => void | Promise<void>,
  ): Promise<Readonly<ResolveApprovedActionManualRecoveryResult>>;
}

export class InvalidApprovedActionManualRecoveryError extends TypeError {
  readonly code = 'APPROVED_ACTION_MANUAL_RECOVERY_INVALID';

  constructor(message: string) {
    super(`Approved Action manual recovery is invalid: ${message}`);
    this.name = 'InvalidApprovedActionManualRecoveryError';
  }
}

export class ApprovedActionManualRecoveryAuthorizationError extends Error {
  readonly code = 'APPROVED_ACTION_MANUAL_RECOVERY_AUTHORIZATION_REJECTED';

  constructor() {
    super('Approved Action manual recovery authorization was rejected');
    this.name = 'ApprovedActionManualRecoveryAuthorizationError';
  }
}

export class ApprovedActionManualRecoveryTargetUnavailableError extends Error {
  readonly code = 'APPROVED_ACTION_MANUAL_RECOVERY_TARGET_UNAVAILABLE';

  constructor() {
    super('Approved Action manual recovery target is unavailable');
    this.name = 'ApprovedActionManualRecoveryTargetUnavailableError';
  }
}

export class ApprovedActionManualRecoveryUnsupportedError extends Error {
  readonly code = 'APPROVED_ACTION_MANUAL_RECOVERY_UNSUPPORTED';

  constructor() {
    super('Approved Action does not support manual recovery');
    this.name = 'ApprovedActionManualRecoveryUnsupportedError';
  }
}

export class ApprovedActionManualRecoveryFenceConflictError extends Error {
  readonly code = 'APPROVED_ACTION_MANUAL_RECOVERY_FENCE_CONFLICT';

  constructor() {
    super('Approved Action manual recovery fence changed');
    this.name = 'ApprovedActionManualRecoveryFenceConflictError';
  }
}

export class ApprovedActionManualRecoveryUnavailableError extends Error {
  readonly code = 'APPROVED_ACTION_MANUAL_RECOVERY_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Approved Action manual recovery is unavailable', options);
    this.name = 'ApprovedActionManualRecoveryUnavailableError';
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid(message: string): never {
  throw new InvalidApprovedActionManualRecoveryError(message);
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('value must be an object');
  }
  const actual = Object.keys(value as object).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid('value shape is invalid');
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function reason(value: unknown): string {
  if (typeof value !== 'string' || !REASON_PATTERN.test(value)) {
    invalid('reason code is invalid');
  }
  return value;
}

function digest(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > 2_147_483_647
  ) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function decision(value: unknown): ApprovedActionManualRecoveryDecision {
  if (
    !APPROVED_ACTION_MANUAL_RECOVERY_DECISIONS.includes(
      value as ApprovedActionManualRecoveryDecision,
    )
  ) {
    invalid('decision is invalid');
  }
  return value as ApprovedActionManualRecoveryDecision;
}

function supportedActionType(value: string): boolean {
  return APPROVED_ACTION_MANUAL_RECOVERY_ACTION_TYPES.includes(
    value as (typeof APPROVED_ACTION_MANUAL_RECOVERY_ACTION_TYPES)[number],
  );
}

function subject(value: unknown): Readonly<SecuritySubject> {
  const record = exact(value, ['type', 'id']);
  if (record.type !== 'user') invalid('resolved subject must be a User');
  return Object.freeze({
    type: 'user' as const,
    id: identifier(record.id, 'resolved subject id'),
  });
}

function fence(value: unknown): Readonly<SecurityPolicyFence> {
  const record = exact(value, ['projectVersion', 'bindingVersion']);
  const bindingVersion = integer(record.bindingVersion, 'binding version', 1);
  return Object.freeze({
    projectVersion: integer(record.projectVersion, 'project version', 1),
    bindingVersion,
  });
}

function resolutionWithoutDigest(
  value: Omit<ApprovedActionManualRecoveryResolutionRecord, 'resolutionDigest'>,
): Omit<ApprovedActionManualRecoveryResolutionRecord, 'resolutionDigest'> {
  return {
    schema: APPROVED_ACTION_MANUAL_RECOVERY_SCHEMA,
    dispatchId: value.dispatchId,
    dispatchDigest: value.dispatchDigest,
    projectId: value.projectId,
    actionType: value.actionType,
    actionDigest: value.actionDigest,
    executionVersion: value.executionVersion,
    executionDigest: value.executionDigest,
    mutationId: value.mutationId,
    decision: value.decision,
    evidenceDigest: value.evidenceDigest,
    reasonCode: value.reasonCode,
    resolvedBy: value.resolvedBy,
    authenticationId: value.authenticationId,
    assurance: value.assurance,
    authenticatedAtMs: value.authenticatedAtMs,
    authorizationFence: value.authorizationFence,
    auditEventId: value.auditEventId,
    resolvedAtMs: value.resolvedAtMs,
  };
}

function resolutionDigest(
  value: Omit<ApprovedActionManualRecoveryResolutionRecord, 'resolutionDigest'>,
): string {
  return createHash('sha256')
    .update(APPROVED_ACTION_MANUAL_RECOVERY_SCHEMA)
    .update('\0')
    .update(JSON.stringify(resolutionWithoutDigest(value)))
    .digest('hex');
}

export function normalizeApprovedActionManualRecoveryResolution(
  value: ApprovedActionManualRecoveryResolutionRecord,
): Readonly<ApprovedActionManualRecoveryResolutionRecord> {
  const record = exact(value, [
    'schema',
    'dispatchId',
    'dispatchDigest',
    'projectId',
    'actionType',
    'actionDigest',
    'executionVersion',
    'executionDigest',
    'mutationId',
    'decision',
    'evidenceDigest',
    'reasonCode',
    'resolvedBy',
    'authenticationId',
    'assurance',
    'authenticatedAtMs',
    'authorizationFence',
    'auditEventId',
    'resolvedAtMs',
    'resolutionDigest',
  ]);
  if (record.schema !== APPROVED_ACTION_MANUAL_RECOVERY_SCHEMA) {
    invalid('schema is invalid');
  }
  const normalized = resolutionWithoutDigest({
    schema: APPROVED_ACTION_MANUAL_RECOVERY_SCHEMA,
    dispatchId: identifier(record.dispatchId, 'dispatch id'),
    dispatchDigest: digest(record.dispatchDigest, 'dispatch digest'),
    projectId: identifier(record.projectId, 'project id'),
    actionType: identifier(record.actionType, 'action type'),
    actionDigest: digest(record.actionDigest, 'action digest'),
    executionVersion: integer(record.executionVersion, 'execution version', 1),
    executionDigest: digest(record.executionDigest, 'execution digest'),
    mutationId: identifier(record.mutationId, 'mutation id'),
    decision: decision(record.decision),
    evidenceDigest: digest(record.evidenceDigest, 'evidence digest'),
    reasonCode: reason(record.reasonCode),
    resolvedBy: subject(record.resolvedBy),
    authenticationId: identifier(record.authenticationId, 'authentication id'),
    assurance:
      record.assurance === 'multi_factor' || record.assurance === 'hardware'
        ? record.assurance
        : invalid('assurance is invalid'),
    authenticatedAtMs: timestamp(record.authenticatedAtMs, 'authentication time'),
    authorizationFence: fence(record.authorizationFence),
    auditEventId: uuid(record.auditEventId, 'audit event id'),
    resolvedAtMs: timestamp(record.resolvedAtMs, 'resolution time'),
  });
  if (
    !supportedActionType(normalized.actionType) ||
    normalized.authenticatedAtMs > normalized.resolvedAtMs ||
    normalized.resolvedAtMs - normalized.authenticatedAtMs >
      MAX_APPROVED_ACTION_MANUAL_RECOVERY_AUTH_AGE_MS
  ) {
    invalid('resolution authority is invalid');
  }
  const normalizedDigest = digest(record.resolutionDigest, 'resolution digest');
  if (normalizedDigest !== resolutionDigest(normalized)) {
    invalid('resolution digest does not match');
  }
  return Object.freeze({ ...normalized, resolutionDigest: normalizedDigest });
}

export function normalizeApprovedActionManualRecoverySnapshot(
  value: ApprovedActionManualRecoverySnapshot,
): Readonly<ApprovedActionManualRecoverySnapshot> {
  const record = exact(value, ['execution', 'resolution']);
  const execution = normalizeApprovedActionExecutionSnapshot(
    record.execution as unknown as ApprovedActionExecutionSnapshot,
  );
  const resolution =
    record.resolution === null
      ? null
      : normalizeApprovedActionManualRecoveryResolution(
          record.resolution as ApprovedActionManualRecoveryResolutionRecord,
        );
  if (
    resolution &&
    (resolution.dispatchId !== execution.dispatch.id ||
      resolution.dispatchDigest !== execution.execution.dispatchDigest ||
      resolution.projectId !== execution.dispatch.projectId ||
      resolution.actionType !== execution.dispatch.action.actionType ||
      resolution.actionDigest !== execution.dispatch.action.actionDigest ||
      execution.execution.version !== resolution.executionVersion + 1 ||
      execution.execution.resultMutationId !== resolution.mutationId ||
      execution.execution.resultCode !== resultCodeFor(resolution.decision) ||
      execution.execution.resultDigest !== null ||
      execution.execution.completedAtMs !== resolution.resolvedAtMs ||
      execution.execution.status !== statusFor(resolution.decision))
  ) {
    invalid('resolution is not bound to the execution');
  }
  return Object.freeze({ execution, resolution });
}

function statusFor(
  value: ApprovedActionManualRecoveryDecision,
): 'failed' | 'blocked' {
  return value === 'confirm_failed' ? 'failed' : 'blocked';
}

function outcomeFor(
  value: ApprovedActionManualRecoveryDecision,
): 'failed' | 'indeterminate' {
  return value === 'confirm_failed' ? 'failed' : 'indeterminate';
}

function resultCodeFor(value: ApprovedActionManualRecoveryDecision): string {
  return value === 'confirm_failed'
    ? 'manual_recovery_confirmed_failed'
    : 'manual_recovery_abandoned_unknown';
}

function observedTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApprovedActionManualRecoveryUnavailableError();
  }
  return value;
}

function strongPrincipal(
  value: Readonly<SecurityPrincipal>,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(value, nowMs);
  } catch {
    throw new ApprovedActionManualRecoveryAuthorizationError();
  }
  if (
    principal.subject.type !== 'user' ||
    (principal.assurance !== 'multi_factor' && principal.assurance !== 'hardware') ||
    principal.authenticatedAtMs > nowMs ||
    nowMs - principal.authenticatedAtMs >
      MAX_APPROVED_ACTION_MANUAL_RECOVERY_AUTH_AGE_MS
  ) {
    throw new ApprovedActionManualRecoveryAuthorizationError();
  }
  return principal;
}

function normalizeInspectRequest(
  value: ApprovedActionManualRecoveryInspectRequest,
): Readonly<ApprovedActionManualRecoveryInspectRequest> {
  const record = exact(value, [
    'projectId',
    'dispatchId',
    'auditEventId',
    'requestId',
    'principal',
  ]);
  return Object.freeze({
    projectId: identifier(record.projectId, 'project id'),
    dispatchId: identifier(record.dispatchId, 'dispatch id'),
    auditEventId: uuid(record.auditEventId, 'audit event id'),
    requestId: identifier(record.requestId, 'request id'),
    principal: record.principal as Readonly<SecurityPrincipal>,
  });
}

function normalizeResolveRequest(
  value: ApprovedActionManualRecoveryResolveRequest,
): Readonly<ApprovedActionManualRecoveryResolveRequest> {
  const record = exact(value, [
    'projectId',
    'dispatchId',
    'auditEventId',
    'requestId',
    'principal',
    'expectedExecutionVersion',
    'expectedExecutionDigest',
    'mutationId',
    'decision',
    'evidenceDigest',
    'reasonCode',
  ]);
  return Object.freeze({
    ...normalizeInspectRequest({
      projectId: record.projectId as string,
      dispatchId: record.dispatchId as string,
      auditEventId: record.auditEventId as string,
      requestId: record.requestId as string,
      principal: record.principal as Readonly<SecurityPrincipal>,
    }),
    expectedExecutionVersion: integer(
      record.expectedExecutionVersion,
      'expected execution version',
      1,
    ),
    expectedExecutionDigest: digest(
      record.expectedExecutionDigest,
      'expected execution digest',
    ),
    mutationId: identifier(record.mutationId, 'mutation id'),
    decision: decision(record.decision),
    evidenceDigest: digest(record.evidenceDigest, 'evidence digest'),
    reasonCode: reason(record.reasonCode),
  });
}

function allowedAudit(
  request: Readonly<ApprovedActionManualRecoveryInspectRequest>,
  principal: Readonly<SecurityPrincipal>,
  policyFence: Readonly<SecurityPolicyFence>,
  operationId: 'approval.recover.inspect' | 'approval.recover.resolve',
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> {
  return normalizeSecurityAuditRecord({
    eventId: request.auditEventId,
    requestId: request.requestId,
    operationId,
    projectId: request.projectId,
    subject: principal.subject,
    authenticationId: principal.authenticationId,
    outcome: 'allowed',
    reasons: ['role_grant', 'strong_authentication', 'manual_recovery'],
    fence: policyFence,
    occurredAtMs,
  });
}

function createResolution(
  snapshot: Readonly<ApprovedActionExecutionSnapshot>,
  request: Readonly<ApprovedActionManualRecoveryResolveRequest>,
  principal: Readonly<SecurityPrincipal>,
  policyFence: Readonly<SecurityPolicyFence>,
  resolvedAtMs: number,
): Readonly<ApprovedActionManualRecoveryResolutionRecord> {
  const withoutDigest = resolutionWithoutDigest({
    schema: APPROVED_ACTION_MANUAL_RECOVERY_SCHEMA,
    dispatchId: snapshot.dispatch.id,
    dispatchDigest: snapshot.execution.dispatchDigest,
    projectId: snapshot.dispatch.projectId,
    actionType: snapshot.dispatch.action.actionType,
    actionDigest: snapshot.dispatch.action.actionDigest,
    executionVersion: snapshot.execution.version,
    executionDigest: snapshot.execution.executionDigest,
    mutationId: request.mutationId,
    decision: request.decision,
    evidenceDigest: request.evidenceDigest,
    reasonCode: request.reasonCode,
    resolvedBy: principal.subject,
    authenticationId: principal.authenticationId,
    assurance: principal.assurance as 'multi_factor' | 'hardware',
    authenticatedAtMs: principal.authenticatedAtMs,
    authorizationFence: policyFence,
    auditEventId: request.auditEventId,
    resolvedAtMs,
  });
  return normalizeApprovedActionManualRecoveryResolution({
    ...withoutDigest,
    resolutionDigest: resolutionDigest(withoutDigest),
  });
}

function exactReplay(
  resolution: Readonly<ApprovedActionManualRecoveryResolutionRecord>,
  request: Readonly<ApprovedActionManualRecoveryResolveRequest>,
  principal: Readonly<SecurityPrincipal>,
): boolean {
  return (
    resolution.projectId === request.projectId &&
    resolution.executionVersion === request.expectedExecutionVersion &&
    resolution.executionDigest === request.expectedExecutionDigest &&
    resolution.mutationId === request.mutationId &&
    resolution.decision === request.decision &&
    resolution.evidenceDigest === request.evidenceDigest &&
    resolution.reasonCode === request.reasonCode &&
    resolution.auditEventId === request.auditEventId &&
    resolution.resolvedBy.type === principal.subject.type &&
    resolution.resolvedBy.id === principal.subject.id &&
    resolution.authenticationId === principal.authenticationId
  );
}

async function authorized(
  policy: Pick<ProjectPolicyEngine, 'authorize'>,
  principal: Readonly<SecurityPrincipal>,
  projectId: string,
): Promise<Readonly<SecurityPolicyFence>> {
  let decision;
  try {
    decision = await policy.authorize(principal, projectId, 'approval.recover');
  } catch (error) {
    throw new ApprovedActionManualRecoveryUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (
    decision.effect !== 'allow' ||
    decision.fence === null ||
    decision.fence.bindingVersion === null
  ) {
    throw new ApprovedActionManualRecoveryAuthorizationError();
  }
  return decision.fence;
}

export function createApprovedActionManualRecoveryService(options: Readonly<{
  repository: ApprovedActionManualRecoveryRepository;
  policy: Pick<ProjectPolicyEngine, 'authorize'>;
  audit: SecurityAuditSink;
  now?: () => number;
}>): Readonly<ApprovedActionManualRecoveryService> {
  exact(options, [
    'repository',
    'policy',
    'audit',
    ...(options?.now === undefined ? [] : ['now']),
  ]);
  if (
    typeof options.repository?.findByDispatchId !== 'function' ||
    typeof options.repository?.resolve !== 'function' ||
    typeof options.policy?.authorize !== 'function' ||
    typeof options.audit?.record !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    invalid('options are invalid');
  }
  const now = options.now ?? Date.now;
  return Object.freeze({
    async inspect(
      requestValue: ApprovedActionManualRecoveryInspectRequest,
      confirmAuthorization?: () => void | Promise<void>,
    ) {
      const request = normalizeInspectRequest(requestValue);
      const inspectedAtMs = observedTime(now);
      const principal = strongPrincipal(request.principal, inspectedAtMs);
      const policyFence = await authorized(options.policy, principal, request.projectId);
      let snapshot: Readonly<ApprovedActionManualRecoverySnapshot> | null;
      try {
        const found = await options.repository.findByDispatchId(request.dispatchId);
        snapshot = found ? normalizeApprovedActionManualRecoverySnapshot(found) : null;
      } catch (error) {
        throw new ApprovedActionManualRecoveryUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (snapshot && snapshot.execution.dispatch.projectId !== request.projectId) {
        snapshot = null;
      }
      if (
        snapshot &&
        !supportedActionType(snapshot.execution.dispatch.action.actionType)
      ) {
        throw new ApprovedActionManualRecoveryUnsupportedError();
      }
      await confirmAuthorization?.();
      try {
        await options.audit.record(
          allowedAudit(
            request,
            principal,
            policyFence,
            'approval.recover.inspect',
            inspectedAtMs,
          ),
        );
      } catch (error) {
        throw new ApprovedActionManualRecoveryUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      return snapshot;
    },

    async resolve(
      requestValue: ApprovedActionManualRecoveryResolveRequest,
      confirmAuthorization?: () => void | Promise<void>,
    ) {
      const request = normalizeResolveRequest(requestValue);
      const resolvedAtMs = observedTime(now);
      const principal = strongPrincipal(request.principal, resolvedAtMs);
      const policyFence = await authorized(options.policy, principal, request.projectId);
      let current: Readonly<ApprovedActionManualRecoverySnapshot> | null;
      try {
        const found = await options.repository.findByDispatchId(request.dispatchId);
        current = found ? normalizeApprovedActionManualRecoverySnapshot(found) : null;
      } catch (error) {
        throw new ApprovedActionManualRecoveryUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (!current || current.execution.dispatch.projectId !== request.projectId) {
        throw new ApprovedActionManualRecoveryTargetUnavailableError();
      }
      if (!supportedActionType(current.execution.dispatch.action.actionType)) {
        throw new ApprovedActionManualRecoveryUnsupportedError();
      }
      if (current.resolution) {
        if (!exactReplay(current.resolution, request, principal)) {
          throw new ApprovedActionManualRecoveryFenceConflictError();
        }
        await confirmAuthorization?.();
        return Object.freeze({ status: 'existing' as const, snapshot: current });
      }
      if (
        current.execution.execution.version !== request.expectedExecutionVersion ||
        current.execution.execution.executionDigest !==
          request.expectedExecutionDigest ||
        approvedActionExecutionEffectiveStatus(
          current.execution.execution,
          resolvedAtMs,
        ) !== 'recovery_required' ||
        current.execution.execution.leaseOwner === null ||
        current.execution.execution.leaseToken === null
      ) {
        throw new ApprovedActionManualRecoveryFenceConflictError();
      }
      const resolution = createResolution(
        current.execution,
        request,
        principal,
        policyFence,
        resolvedAtMs,
      );
      const nextExecution = completeApprovedActionExecution(
        current.execution.execution,
        {
          owner: current.execution.execution.leaseOwner,
          leaseToken: current.execution.execution.leaseToken,
          expectedVersion: current.execution.execution.version,
          resultMutationId: request.mutationId,
          outcome: outcomeFor(request.decision),
          resultCode: resultCodeFor(request.decision),
          completedAtMs: resolvedAtMs,
        },
      );
      await confirmAuthorization?.();
      try {
        return await options.repository.resolve({
          previous: current.execution,
          nextExecution,
          resolution,
          audit: allowedAudit(
            request,
            principal,
            policyFence,
            'approval.recover.resolve',
            resolvedAtMs,
          ),
        });
      } catch (error) {
        if (
          error instanceof ApprovedActionManualRecoveryFenceConflictError ||
          error instanceof ApprovedActionManualRecoveryTargetUnavailableError
        ) {
          throw error;
        }
        throw new ApprovedActionManualRecoveryUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      }
    },
  });
}
