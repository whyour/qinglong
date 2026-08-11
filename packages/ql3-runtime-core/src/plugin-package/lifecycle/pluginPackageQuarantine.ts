import { createHash } from 'node:crypto';

import { SECURITY_SUBJECT_TYPES, type SecuritySubject } from '../../security/security';

export const PLUGIN_PACKAGE_QUARANTINE_EVENT_SCHEMA =
  'qinglong/plugin-package-quarantine-event@v1' as const;
export const PLUGIN_PACKAGE_WITHDRAWAL_RECEIPT_SCHEMA =
  'qinglong/plugin-package-withdrawal-receipt@v1' as const;
export const MAX_PLUGIN_PACKAGE_QUARANTINE_TASK_WITHDRAWALS = 128;
export const MAX_PLUGIN_PACKAGE_QUARANTINE_RETAINED_SOURCES = 128;

export type PluginPackageQuarantineInstallState =
  | 'queued'
  | 'staged'
  | 'activating'
  | 'active';
export type PluginPackageQuarantineAuthorizationMode =
  | 'dual_control'
  | 'break_glass';
export type PluginPackageQuarantineReason =
  | 'suspected_key_compromise'
  | 'confirmed_key_compromise';

export interface PluginPackageQuarantineTarget {
  readonly projectId: string;
  readonly packageName: string;
  readonly installationId: string;
  readonly lockDigest: string;
  readonly installState: PluginPackageQuarantineInstallState;
  readonly installVersion: number;
  readonly installRecordDigest: string;
  readonly activeLockDigest: string | null;
}

export interface PluginPackageQuarantineEvent {
  readonly schema: typeof PLUGIN_PACKAGE_QUARANTINE_EVENT_SCHEMA;
  readonly mutationId: string;
  readonly revocationReceiptDigest: string;
  readonly impactDigest: string;
  readonly target: Readonly<PluginPackageQuarantineTarget>;
  readonly proposer: Readonly<SecuritySubject>;
  readonly confirmer: Readonly<SecuritySubject>;
  readonly authorizationMode: PluginPackageQuarantineAuthorizationMode;
  readonly reasonCode: PluginPackageQuarantineReason;
  readonly occurredAtMs: number;
  readonly eventDigest: string;
}

export type CreatePluginPackageQuarantineEventInput = Omit<
  PluginPackageQuarantineEvent,
  'eventDigest' | 'schema'
>;

export interface PluginPackageQuarantineTaskWithdrawal {
  readonly taskId: string;
  readonly previousRevision: number;
  readonly disabledRevision: number;
  readonly previousContentDigest: string;
  readonly disabledContentDigest: string;
}

export interface PluginPackageQuarantineInactiveCapabilityDisposition {
  readonly status: 'not_active';
  readonly taskWithdrawals: readonly [];
  readonly previousActiveVectorDigest: null;
  readonly currentActiveVectorDigest: null;
  readonly currentToolSnapshotDigest: null;
  readonly retainedSourceCount: 0;
}

export interface PluginPackageQuarantineWithdrawnCapabilityDisposition {
  readonly status: 'withdrawn';
  readonly taskWithdrawals: readonly Readonly<PluginPackageQuarantineTaskWithdrawal>[];
  readonly previousActiveVectorDigest: string;
  readonly currentActiveVectorDigest: string;
  readonly currentToolSnapshotDigest: string;
  readonly retainedSourceCount: number;
}

export type PluginPackageQuarantineCapabilityDisposition =
  | Readonly<PluginPackageQuarantineInactiveCapabilityDisposition>
  | Readonly<PluginPackageQuarantineWithdrawnCapabilityDisposition>;

export interface PluginPackageWithdrawalReceipt {
  readonly schema: typeof PLUGIN_PACKAGE_WITHDRAWAL_RECEIPT_SCHEMA;
  readonly eventDigest: string;
  readonly target: Readonly<PluginPackageQuarantineTarget>;
  readonly capability: PluginPackageQuarantineCapabilityDisposition;
  readonly committedAtMs: number;
  readonly receiptDigest: string;
}

export type CreatePluginPackageWithdrawalReceiptInput = Omit<
  PluginPackageWithdrawalReceipt,
  'receiptDigest' | 'schema'
>;

export interface PluginPackageQuarantineRepository {
  findTargetsByLockDigest(
    lockDigest: string,
  ): Promise<readonly Readonly<PluginPackageQuarantineTarget>[]>;
  findByEventDigest(
    eventDigest: string,
  ): Promise<Readonly<PluginPackageWithdrawalReceipt> | null>;
  quarantine(
    event: Readonly<PluginPackageQuarantineEvent>,
    confirmAuthorization: () => void | Promise<void>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackageWithdrawalReceipt>;
    }>
  >;
}

export class InvalidPluginPackageQuarantineError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_QUARANTINE_INVALID';

  constructor(message: string) {
    super(`Plugin Package quarantine is invalid: ${message}`);
    this.name = 'InvalidPluginPackageQuarantineError';
  }
}

export class PluginPackageQuarantineConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_QUARANTINE_CONFLICT';

  constructor(message: string) {
    super(`Plugin Package quarantine conflicts with durable state: ${message}`);
    this.name = 'PluginPackageQuarantineConflictError';
  }
}

export class PluginPackageQuarantineUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_QUARANTINE_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package quarantine is unavailable', options);
    this.name = 'PluginPackageQuarantineUnavailableError';
  }
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SUBJECT_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const EVENT_DIGEST_DOMAIN =
  'qinglong/plugin-package-quarantine-event-digest@v1\0';
const RECEIPT_DIGEST_DOMAIN =
  'qinglong/plugin-package-withdrawal-receipt-digest@v1\0';
const TASK_MUTATION_ID_DOMAIN =
  'qinglong/plugin-package-quarantine-task-mutation-id@v1\0';
const QUARANTINE_MUTATION_ID_DOMAIN =
  'qinglong/plugin-package-quarantine-mutation-id@v1\0';

function invalid(message: string): never {
  throw new InvalidPluginPackageQuarantineError(message);
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(value);
  const sorted = [...expected].sort();
  if (
    actual.some((key) => typeof key !== 'string') ||
    actual.length !== sorted.length ||
    actual
      .map(String)
      .sort()
      .some((key, index) => key !== sorted[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function positiveVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function subject(
  value: SecuritySubject,
  label: string,
): Readonly<SecuritySubject> {
  const record = dataRecord(value, label);
  exactKeys(record, ['id', 'type'], label);
  if (
    typeof value.type !== 'string' ||
    !SECURITY_SUBJECT_TYPES.includes(
      value.type as (typeof SECURITY_SUBJECT_TYPES)[number],
    ) ||
    typeof value.id !== 'string' ||
    value.id.length < 1 ||
    Buffer.byteLength(value.id, 'utf8') > 255 ||
    SUBJECT_CONTROL_PATTERN.test(value.id)
  ) {
    return invalid(`${label} is invalid`);
  }
  return Object.freeze({
    type: value.type as (typeof SECURITY_SUBJECT_TYPES)[number],
    id: value.id,
  });
}

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function normalizeTarget(
  value: PluginPackageQuarantineTarget,
): Readonly<PluginPackageQuarantineTarget> {
  const target = dataRecord(value, 'target');
  exactKeys(
    target,
    [
      'activeLockDigest',
      'installationId',
      'installRecordDigest',
      'installState',
      'installVersion',
      'lockDigest',
      'packageName',
      'projectId',
    ],
    'target',
  );
  if (
    typeof value.projectId !== 'string' ||
    value.projectId.length < 1 ||
    Buffer.byteLength(value.projectId, 'utf8') > 128 ||
    value.projectId.includes('\0') ||
    typeof value.packageName !== 'string' ||
    !PACKAGE_NAME_PATTERN.test(value.packageName) ||
    !['queued', 'staged', 'activating', 'active'].includes(value.installState)
  ) {
    return invalid('target identity or state is invalid');
  }
  const lockDigest = digest(value.lockDigest, 'target lockDigest');
  const activeLockDigest =
    value.activeLockDigest === null
      ? null
      : digest(value.activeLockDigest, 'target activeLockDigest');
  if (
    (value.installState === 'active' && activeLockDigest !== lockDigest) ||
    (value.installState !== 'active' && activeLockDigest === lockDigest)
  ) {
    return invalid('target active lock does not match install state');
  }
  return Object.freeze({
    projectId: value.projectId,
    packageName: value.packageName,
    installationId: identifier(value.installationId, 'target installationId'),
    lockDigest,
    installState: value.installState,
    installVersion: positiveVersion(
      value.installVersion,
      'target installVersion',
    ),
    installRecordDigest: digest(
      value.installRecordDigest,
      'target installRecordDigest',
    ),
    activeLockDigest,
  });
}

function eventFields(
  value: Omit<PluginPackageQuarantineEvent, 'eventDigest'>,
): object {
  return {
    schema: value.schema,
    mutationId: value.mutationId,
    revocationReceiptDigest: value.revocationReceiptDigest,
    impactDigest: value.impactDigest,
    target: value.target,
    proposer: value.proposer,
    confirmer: value.confirmer,
    authorizationMode: value.authorizationMode,
    reasonCode: value.reasonCode,
    occurredAtMs: value.occurredAtMs,
  };
}

export function pluginPackageQuarantineEventDigest(
  value: Omit<PluginPackageQuarantineEvent, 'eventDigest'>,
): string {
  return createHash('sha256')
    .update(EVENT_DIGEST_DOMAIN)
    .update(JSON.stringify(eventFields(value)))
    .digest('hex');
}

export function normalizePluginPackageQuarantineEvent(
  value: PluginPackageQuarantineEvent,
): Readonly<PluginPackageQuarantineEvent> {
  const event = dataRecord(value, 'event');
  exactKeys(
    event,
    [
      'authorizationMode',
      'confirmer',
      'eventDigest',
      'impactDigest',
      'mutationId',
      'occurredAtMs',
      'proposer',
      'reasonCode',
      'revocationReceiptDigest',
      'schema',
      'target',
    ],
    'event',
  );
  if (
    value.schema !== PLUGIN_PACKAGE_QUARANTINE_EVENT_SCHEMA ||
    (value.authorizationMode !== 'dual_control' &&
      value.authorizationMode !== 'break_glass') ||
    (value.reasonCode !== 'suspected_key_compromise' &&
      value.reasonCode !== 'confirmed_key_compromise')
  ) {
    return invalid('event schema or classification is invalid');
  }
  const proposer = subject(value.proposer, 'proposer');
  const confirmer = subject(value.confirmer, 'confirmer');
  if (
    value.authorizationMode === 'dual_control' &&
    sameSubject(proposer, confirmer)
  ) {
    return invalid('dual-control requires distinct subjects');
  }
  const normalized = Object.freeze({
    schema: PLUGIN_PACKAGE_QUARANTINE_EVENT_SCHEMA,
    mutationId: identifier(value.mutationId, 'mutationId'),
    revocationReceiptDigest: digest(
      value.revocationReceiptDigest,
      'revocationReceiptDigest',
    ),
    impactDigest: digest(value.impactDigest, 'impactDigest'),
    target: normalizeTarget(value.target),
    proposer,
    confirmer,
    authorizationMode: value.authorizationMode,
    reasonCode: value.reasonCode,
    occurredAtMs: timestamp(value.occurredAtMs, 'occurredAtMs'),
  });
  const eventDigest = pluginPackageQuarantineEventDigest(normalized);
  if (value.eventDigest !== eventDigest) {
    return invalid('eventDigest does not match event');
  }
  return Object.freeze({ ...normalized, eventDigest });
}

export function createPluginPackageQuarantineEvent(
  input: CreatePluginPackageQuarantineEventInput,
): Readonly<PluginPackageQuarantineEvent> {
  const value = dataRecord(input, 'event input');
  exactKeys(
    value,
    [
      'authorizationMode',
      'confirmer',
      'impactDigest',
      'mutationId',
      'occurredAtMs',
      'proposer',
      'reasonCode',
      'revocationReceiptDigest',
      'target',
    ],
    'event input',
  );
  if (
    (input.authorizationMode !== 'dual_control' &&
      input.authorizationMode !== 'break_glass') ||
    (input.reasonCode !== 'suspected_key_compromise' &&
      input.reasonCode !== 'confirmed_key_compromise')
  ) {
    return invalid('event classification is invalid');
  }
  const proposer = subject(input.proposer, 'proposer');
  const confirmer = subject(input.confirmer, 'confirmer');
  if (
    input.authorizationMode === 'dual_control' &&
    sameSubject(proposer, confirmer)
  ) {
    return invalid('dual-control requires distinct subjects');
  }
  const unsigned: Omit<PluginPackageQuarantineEvent, 'eventDigest'> = {
    schema: PLUGIN_PACKAGE_QUARANTINE_EVENT_SCHEMA,
    mutationId: identifier(input.mutationId, 'mutationId'),
    revocationReceiptDigest: digest(
      input.revocationReceiptDigest,
      'revocationReceiptDigest',
    ),
    impactDigest: digest(input.impactDigest, 'impactDigest'),
    target: normalizeTarget(input.target),
    proposer,
    confirmer,
    authorizationMode: input.authorizationMode,
    reasonCode: input.reasonCode,
    occurredAtMs: timestamp(input.occurredAtMs, 'occurredAtMs'),
  };
  return normalizePluginPackageQuarantineEvent({
    ...unsigned,
    eventDigest: pluginPackageQuarantineEventDigest(unsigned),
  });
}

function normalizeTaskWithdrawal(
  value: PluginPackageQuarantineTaskWithdrawal,
): Readonly<PluginPackageQuarantineTaskWithdrawal> {
  const task = dataRecord(value, 'task withdrawal');
  exactKeys(
    task,
    [
      'disabledContentDigest',
      'disabledRevision',
      'previousContentDigest',
      'previousRevision',
      'taskId',
    ],
    'task withdrawal',
  );
  const previousRevision = positiveVersion(
    value.previousRevision,
    'task previousRevision',
  );
  const disabledRevision = positiveVersion(
    value.disabledRevision,
    'task disabledRevision',
  );
  if (disabledRevision !== previousRevision + 1) {
    return invalid('task disabled revision is not consecutive');
  }
  return Object.freeze({
    taskId: identifier(value.taskId, 'taskId'),
    previousRevision,
    disabledRevision,
    previousContentDigest: digest(
      value.previousContentDigest,
      'task previousContentDigest',
    ),
    disabledContentDigest: digest(
      value.disabledContentDigest,
      'task disabledContentDigest',
    ),
  });
}

function normalizeCapability(
  value: PluginPackageQuarantineCapabilityDisposition,
  target: Readonly<PluginPackageQuarantineTarget>,
): PluginPackageQuarantineCapabilityDisposition {
  const capability = dataRecord(value, 'capability');
  exactKeys(
    capability,
    [
      'currentActiveVectorDigest',
      'currentToolSnapshotDigest',
      'previousActiveVectorDigest',
      'retainedSourceCount',
      'status',
      'taskWithdrawals',
    ],
    'capability',
  );
  if (!Array.isArray(value.taskWithdrawals)) {
    return invalid('task withdrawals must be an array');
  }
  if (value.status === 'not_active') {
    if (
      target.installState === 'active' ||
      value.taskWithdrawals.length !== 0 ||
      value.previousActiveVectorDigest !== null ||
      value.currentActiveVectorDigest !== null ||
      value.currentToolSnapshotDigest !== null ||
      value.retainedSourceCount !== 0
    ) {
      return invalid('inactive capability disposition is inconsistent');
    }
    return Object.freeze({
      status: 'not_active',
      taskWithdrawals: Object.freeze([]) as readonly [],
      previousActiveVectorDigest: null,
      currentActiveVectorDigest: null,
      currentToolSnapshotDigest: null,
      retainedSourceCount: 0,
    });
  }
  if (
    value.status !== 'withdrawn' ||
    target.installState !== 'active' ||
    value.taskWithdrawals.length >
      MAX_PLUGIN_PACKAGE_QUARANTINE_TASK_WITHDRAWALS ||
    !Number.isSafeInteger(value.retainedSourceCount) ||
    value.retainedSourceCount < 0 ||
    value.retainedSourceCount > MAX_PLUGIN_PACKAGE_QUARANTINE_RETAINED_SOURCES
  ) {
    return invalid('withdrawn capability disposition is invalid');
  }
  const taskWithdrawals = Object.freeze(
    value.taskWithdrawals.map(normalizeTaskWithdrawal),
  );
  if (
    taskWithdrawals.some(
      (task, index) =>
        index > 0 &&
        Buffer.compare(
          Buffer.from(taskWithdrawals[index - 1]!.taskId, 'utf8'),
          Buffer.from(task.taskId, 'utf8'),
        ) >= 0,
    )
  ) {
    return invalid('task withdrawals must be unique and sorted');
  }
  const previousActiveVectorDigest = digest(
    value.previousActiveVectorDigest,
    'previousActiveVectorDigest',
  );
  const currentActiveVectorDigest = digest(
    value.currentActiveVectorDigest,
    'currentActiveVectorDigest',
  );
  if (previousActiveVectorDigest === currentActiveVectorDigest) {
    return invalid('active vector did not change');
  }
  return Object.freeze({
    status: 'withdrawn',
    taskWithdrawals,
    previousActiveVectorDigest,
    currentActiveVectorDigest,
    currentToolSnapshotDigest: digest(
      value.currentToolSnapshotDigest,
      'currentToolSnapshotDigest',
    ),
    retainedSourceCount: value.retainedSourceCount,
  });
}

function receiptFields(
  value: Omit<PluginPackageWithdrawalReceipt, 'receiptDigest'>,
): object {
  return {
    schema: value.schema,
    eventDigest: value.eventDigest,
    target: value.target,
    capability: value.capability,
    committedAtMs: value.committedAtMs,
  };
}

export function pluginPackageWithdrawalReceiptDigest(
  value: Omit<PluginPackageWithdrawalReceipt, 'receiptDigest'>,
): string {
  return createHash('sha256')
    .update(RECEIPT_DIGEST_DOMAIN)
    .update(JSON.stringify(receiptFields(value)))
    .digest('hex');
}

export function normalizePluginPackageWithdrawalReceipt(
  value: PluginPackageWithdrawalReceipt,
): Readonly<PluginPackageWithdrawalReceipt> {
  const receipt = dataRecord(value, 'withdrawal receipt');
  exactKeys(
    receipt,
    [
      'capability',
      'committedAtMs',
      'eventDigest',
      'receiptDigest',
      'schema',
      'target',
    ],
    'withdrawal receipt',
  );
  if (value.schema !== PLUGIN_PACKAGE_WITHDRAWAL_RECEIPT_SCHEMA) {
    return invalid('withdrawal receipt schema is invalid');
  }
  const target = normalizeTarget(value.target);
  const normalized = Object.freeze({
    schema: PLUGIN_PACKAGE_WITHDRAWAL_RECEIPT_SCHEMA,
    eventDigest: digest(value.eventDigest, 'eventDigest'),
    target,
    capability: normalizeCapability(value.capability, target),
    committedAtMs: timestamp(value.committedAtMs, 'committedAtMs'),
  });
  const receiptDigest = pluginPackageWithdrawalReceiptDigest(normalized);
  if (value.receiptDigest !== receiptDigest) {
    return invalid('receiptDigest does not match withdrawal receipt');
  }
  return Object.freeze({ ...normalized, receiptDigest });
}

export function createPluginPackageWithdrawalReceipt(
  input: CreatePluginPackageWithdrawalReceiptInput,
): Readonly<PluginPackageWithdrawalReceipt> {
  const value = dataRecord(input, 'withdrawal receipt input');
  exactKeys(
    value,
    ['capability', 'committedAtMs', 'eventDigest', 'target'],
    'withdrawal receipt input',
  );
  const target = normalizeTarget(input.target);
  const unsigned: Omit<PluginPackageWithdrawalReceipt, 'receiptDigest'> = {
    schema: PLUGIN_PACKAGE_WITHDRAWAL_RECEIPT_SCHEMA,
    eventDigest: digest(input.eventDigest, 'eventDigest'),
    target,
    capability: normalizeCapability(input.capability, target),
    committedAtMs: timestamp(input.committedAtMs, 'committedAtMs'),
  };
  return normalizePluginPackageWithdrawalReceipt({
    ...unsigned,
    receiptDigest: pluginPackageWithdrawalReceiptDigest(unsigned),
  });
}

export function assertPluginPackageWithdrawalMatchesEvent(
  eventValue: PluginPackageQuarantineEvent,
  receiptValue: PluginPackageWithdrawalReceipt,
): void {
  const event = normalizePluginPackageQuarantineEvent(eventValue);
  const receipt = normalizePluginPackageWithdrawalReceipt(receiptValue);
  if (
    receipt.eventDigest !== event.eventDigest ||
    JSON.stringify(receipt.target) !== JSON.stringify(event.target) ||
    receipt.committedAtMs < event.occurredAtMs
  ) {
    invalid('withdrawal receipt does not match quarantine event');
  }
}

export function pluginPackageQuarantineTaskMutationId(
  eventDigestValue: string,
  taskIdValue: string,
): string {
  const eventDigest = digest(eventDigestValue, 'eventDigest');
  const taskId = identifier(taskIdValue, 'taskId');
  const value = createHash('sha256')
    .update(TASK_MUTATION_ID_DOMAIN)
    .update(eventDigest)
    .update('\0')
    .update(taskId)
    .digest('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(
    13,
    16,
  )}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

export function pluginPackageQuarantineMutationId(
  revocationReceiptDigestValue: string,
  targetValue: PluginPackageQuarantineTarget,
): string {
  const revocationReceiptDigest = digest(
    revocationReceiptDigestValue,
    'revocationReceiptDigest',
  );
  const target = normalizeTarget(targetValue);
  const value = createHash('sha256')
    .update(QUARANTINE_MUTATION_ID_DOMAIN)
    .update(revocationReceiptDigest)
    .update('\0')
    .update(JSON.stringify(target))
    .digest('hex');
  return `quarantine:${value}`;
}
