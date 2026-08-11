import { createHash } from 'node:crypto';
import {
  normalizeAppendWorkerCredentialCommand,
  normalizeWorkerCredentialId,
  normalizeWorkerCredentialMutationId,
  type AppendWorkerCredentialCommand,
  type AppendWorkerCredentialResult,
  type ResolvedWorkerCredentialMutation,
  type WorkerCredentialAdministrationRepository,
} from './workerCredential';
import type {
  HeartbeatWorkerSessionCommand,
  TransitionWorkerSessionCommand,
  WorkerSessionRecord,
  WorkerSessionRepository,
} from './workerSession';

export const WORKER_CREDENTIAL_DELIVERY_STATES = [
  'credential_committed',
  'published',
  'observed',
  'previous_revoked',
] as const;

export type WorkerCredentialDeliveryState =
  (typeof WORKER_CREDENTIAL_DELIVERY_STATES)[number];

export interface WorkerCredentialDeliveryIntent {
  readonly deliveryId: string;
  readonly workerId: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly previousCredentialId: string | null;
  readonly secretDigest: string;
  readonly tokenDigest: string;
  readonly deploymentTargetDigest: string;
  readonly deploymentGeneration: string;
  readonly stagedAtMs: number;
}

export interface WorkerCredentialDeliveryRecord {
  readonly deliveryId: string;
  readonly version: number;
  readonly state: WorkerCredentialDeliveryState;
  readonly workerId: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly previousCredentialId: string | null;
  readonly secretDigest: string;
  readonly tokenDigest: string;
  readonly deploymentTargetDigest: string;
  readonly deploymentGeneration: string;
  readonly stagedAtMs: number;
  readonly credentialCommittedAtMs: number;
  readonly publishedAtMs: number | null;
  readonly publicationDigest: string | null;
  readonly observedAtMs: number | null;
  readonly observedSessionId: string | null;
  readonly observedSessionVersion: number | null;
  readonly previousRevokedAtMs: number | null;
}

export interface CommitWorkerCredentialDeliveryCommand {
  readonly credential: AppendWorkerCredentialCommand;
  readonly delivery: WorkerCredentialDeliveryRecord;
}

export interface PublishWorkerCredentialDeliveryCommand {
  readonly deliveryId: string;
  readonly expectedVersion: number;
  readonly publicationDigest: string;
  readonly publishedAtMs: number;
}

export interface RevokePreviousWorkerCredentialDeliveryCommand {
  readonly credential: AppendWorkerCredentialCommand;
  readonly delivery: WorkerCredentialDeliveryRecord;
}

export const MAX_WORKER_CREDENTIAL_DELIVERY_RECOVERY_PAGE_SIZE = 64;
export const MAX_WORKER_CREDENTIAL_STAGE_DISCARD_PAGE_SIZE = 64;

export const WORKER_CREDENTIAL_STAGE_DISCARD_STATES = [
  'discard_authorized',
  'discarded',
] as const;

export type WorkerCredentialStageDiscardState =
  (typeof WORKER_CREDENTIAL_STAGE_DISCARD_STATES)[number];

export interface WorkerCredentialStageDiscardRecord
  extends WorkerCredentialDeliveryIntent {
  readonly version: number;
  readonly state: WorkerCredentialStageDiscardState;
  readonly authorizedAtMs: number;
  readonly discardedAtMs: number | null;
}

export interface MarkWorkerCredentialStageDiscardedCommand {
  readonly deliveryId: string;
  readonly expectedVersion: number;
}

export interface WorkerCredentialStageDiscardRecoveryPage {
  readonly observedAtMs: number;
  readonly discards: readonly Readonly<WorkerCredentialStageDiscardRecord>[];
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

const WORKER_CREDENTIAL_DELIVERY_TOKEN_DIGEST_DOMAIN = Buffer.from(
  'qinglong/worker-credential-delivery-token@v1\0',
  'utf8',
);

export function workerCredentialDeliveryTokenDigest(
  token: Uint8Array,
): string {
  if (
    !(token instanceof Uint8Array) ||
    token.byteLength < 1 ||
    token.byteLength > 256
  ) {
    throw new TypeError('Worker credential delivery token bytes are invalid');
  }
  return createHash('sha256')
    .update(WORKER_CREDENTIAL_DELIVERY_TOKEN_DIGEST_DOMAIN)
    .update(token)
    .digest('hex');
}

export interface WorkerCredentialDeliveryRecoveryPage {
  readonly observedAtMs: number;
  readonly deliveries: readonly Readonly<WorkerCredentialDeliveryRecord>[];
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface AuthenticatedWorkerCredentialIdentity {
  readonly workerId: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
}

export interface AuthenticatedWorkerSessionRepository
  extends WorkerSessionRepository {
  heartbeatAuthenticated(
    command: HeartbeatWorkerSessionCommand,
    credential: AuthenticatedWorkerCredentialIdentity,
  ): Promise<WorkerSessionRecord>;
  transitionAuthenticated(
    command: TransitionWorkerSessionCommand,
    credential: AuthenticatedWorkerCredentialIdentity,
  ): Promise<WorkerSessionRecord>;
}

export interface ResolvedWorkerCredentialDelivery
  extends ResolvedWorkerCredentialMutation {
  readonly delivery: Readonly<WorkerCredentialDeliveryRecord>;
}

export interface WorkerCredentialDeliveryAdministrationRepository
  extends WorkerCredentialAdministrationRepository {
  resolveDelivery(
    deliveryId: string,
  ): Promise<Readonly<WorkerCredentialDeliveryRecord> | null>;
  resolveDelivered(
    deliveryId: string,
  ): Promise<ResolvedWorkerCredentialDelivery | null>;
  commitDelivered(
    command: CommitWorkerCredentialDeliveryCommand,
  ): Promise<AppendWorkerCredentialResult>;
  markPublished(
    command: PublishWorkerCredentialDeliveryCommand,
  ): Promise<Readonly<WorkerCredentialDeliveryRecord>>;
  listRecoveryPage(options?: Readonly<{
    afterDeliveryId?: string;
    limit?: number;
  }>): Promise<Readonly<WorkerCredentialDeliveryRecoveryPage>>;
  revokePreviousDelivered(
    command: RevokePreviousWorkerCredentialDeliveryCommand,
  ): Promise<AppendWorkerCredentialResult>;
  resolveStageDiscard(
    deliveryId: string,
  ): Promise<Readonly<WorkerCredentialStageDiscardRecord> | null>;
  authorizeStageDiscard(
    intent: WorkerCredentialDeliveryIntent,
  ): Promise<Readonly<WorkerCredentialStageDiscardRecord>>;
  markStageDiscarded(
    command: MarkWorkerCredentialStageDiscardedCommand,
  ): Promise<Readonly<WorkerCredentialStageDiscardRecord>>;
  listStageDiscardRecoveryPage(options?: Readonly<{
    afterDeliveryId?: string;
    limit?: number;
  }>): Promise<Readonly<WorkerCredentialStageDiscardRecoveryPage>>;
}

export class WorkerCredentialDeliveryConflictError extends Error {
  readonly code = 'WORKER_CREDENTIAL_DELIVERY_CONFLICT';
  constructor() {
    super('Worker credential delivery conflicts with an existing fact');
    this.name = 'WorkerCredentialDeliveryConflictError';
  }
}

export class WorkerCredentialDeliveryUnavailableError extends Error {
  readonly code = 'WORKER_CREDENTIAL_DELIVERY_UNAVAILABLE';
  constructor() {
    super('Worker credential delivery is unavailable');
    this.name = 'WorkerCredentialDeliveryUnavailableError';
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exact(value: object, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${name} shape is invalid`);
  }
}

function time(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} is invalid`);
  }
  return value;
}

function nullableTime(name: string, value: number | null): number | null {
  return value === null ? null : time(name, value);
}

function digest(name: string, value: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

export function normalizeAuthenticatedWorkerCredentialIdentity(
  value: AuthenticatedWorkerCredentialIdentity,
): Readonly<AuthenticatedWorkerCredentialIdentity> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Authenticated Worker credential identity is invalid');
  }
  exact(
    value,
    ['workerId', 'credentialId', 'credentialVersion'],
    'Authenticated Worker credential identity',
  );
  if (typeof value.workerId !== 'string' || !SAFE_ID.test(value.workerId)) {
    throw new TypeError('Authenticated Worker identity is invalid');
  }
  normalizeWorkerCredentialId(value.credentialId);
  if (
    !Number.isSafeInteger(value.credentialVersion) ||
    value.credentialVersion < 1 ||
    value.credentialVersion > 2_147_483_647
  ) {
    throw new RangeError('Authenticated Worker credential version is invalid');
  }
  return Object.freeze({ ...value });
}

export function normalizeWorkerCredentialDeliveryIntent(
  value: WorkerCredentialDeliveryIntent,
): Readonly<WorkerCredentialDeliveryIntent> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Worker credential delivery intent is invalid');
  }
  exact(
    value,
    [
      'deliveryId',
      'workerId',
      'credentialId',
      'credentialVersion',
      'previousCredentialId',
      'secretDigest',
      'tokenDigest',
      'deploymentTargetDigest',
      'deploymentGeneration',
      'stagedAtMs',
    ],
    'Worker credential delivery intent',
  );
  normalizeWorkerCredentialMutationId(value.deliveryId);
  normalizeWorkerCredentialId(value.credentialId);
  if (value.previousCredentialId !== null) {
    normalizeWorkerCredentialId(value.previousCredentialId);
    if (value.previousCredentialId === value.credentialId) {
      throw new TypeError('Worker credential delivery requires a new credential ID');
    }
  }
  if (
    typeof value.workerId !== 'string' ||
    !SAFE_ID.test(value.workerId) ||
    typeof value.deploymentGeneration !== 'string' ||
    !SAFE_ID.test(value.deploymentGeneration) ||
    value.credentialVersion !== 1
  ) {
    throw new TypeError('Worker credential delivery intent identity is invalid');
  }
  digest('Worker credential delivery secret digest', value.secretDigest);
  digest('Worker credential delivery token digest', value.tokenDigest);
  digest(
    'Worker credential delivery deployment target digest',
    value.deploymentTargetDigest,
  );
  time('Worker credential delivery stagedAtMs', value.stagedAtMs);
  return Object.freeze({ ...value });
}

export function normalizeWorkerCredentialStageDiscardRecord(
  value: WorkerCredentialStageDiscardRecord,
): Readonly<WorkerCredentialStageDiscardRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Worker credential stage discard record is invalid');
  }
  exact(
    value,
    [
      'deliveryId',
      'version',
      'state',
      'workerId',
      'credentialId',
      'credentialVersion',
      'previousCredentialId',
      'secretDigest',
      'tokenDigest',
      'deploymentTargetDigest',
      'deploymentGeneration',
      'stagedAtMs',
      'authorizedAtMs',
      'discardedAtMs',
    ],
    'Worker credential stage discard record',
  );
  const intent = normalizeWorkerCredentialDeliveryIntent({
    deliveryId: value.deliveryId,
    workerId: value.workerId,
    credentialId: value.credentialId,
    credentialVersion: value.credentialVersion,
    previousCredentialId: value.previousCredentialId,
    secretDigest: value.secretDigest,
    tokenDigest: value.tokenDigest,
    deploymentTargetDigest: value.deploymentTargetDigest,
    deploymentGeneration: value.deploymentGeneration,
    stagedAtMs: value.stagedAtMs,
  });
  const authorizedAtMs = time(
    'Worker credential stage discard authorization',
    value.authorizedAtMs,
  );
  const discardedAtMs = nullableTime(
    'Worker credential stage discard completion',
    value.discardedAtMs,
  );
  if (
    !WORKER_CREDENTIAL_STAGE_DISCARD_STATES.includes(value.state) ||
    value.version !==
      WORKER_CREDENTIAL_STAGE_DISCARD_STATES.indexOf(value.state) + 1 ||
    (value.state === 'discard_authorized' && discardedAtMs !== null) ||
    (value.state === 'discarded' &&
      (discardedAtMs === null || discardedAtMs < authorizedAtMs))
  ) {
    throw new TypeError('Worker credential stage discard state is invalid');
  }
  return Object.freeze({
    ...intent,
    version: value.version,
    state: value.state,
    authorizedAtMs,
    discardedAtMs,
  });
}

export function normalizeMarkWorkerCredentialStageDiscardedCommand(
  value: MarkWorkerCredentialStageDiscardedCommand,
): Readonly<MarkWorkerCredentialStageDiscardedCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Worker credential stage discard completion is invalid');
  }
  exact(
    value,
    ['deliveryId', 'expectedVersion'],
    'Worker credential stage discard completion',
  );
  normalizeWorkerCredentialMutationId(value.deliveryId);
  if (value.expectedVersion !== 1) {
    throw new RangeError('Worker credential stage discard fence is invalid');
  }
  return Object.freeze({ ...value });
}

export function normalizeWorkerCredentialStageDiscardRecoveryPage(
  value: WorkerCredentialStageDiscardRecoveryPage,
): Readonly<WorkerCredentialStageDiscardRecoveryPage> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Worker credential stage discard recovery page is invalid');
  }
  exact(
    value,
    [
      'observedAtMs',
      'discards',
      'truncated',
      ...(value.nextCursor === undefined ? [] : ['nextCursor']),
    ],
    'Worker credential stage discard recovery page',
  );
  time('Worker credential stage discard recovery observation', value.observedAtMs);
  if (
    !Array.isArray(value.discards) ||
    value.discards.length > MAX_WORKER_CREDENTIAL_STAGE_DISCARD_PAGE_SIZE ||
    typeof value.truncated !== 'boolean'
  ) {
    throw new TypeError('Worker credential stage discard recovery bound is invalid');
  }
  const discards = value.discards.map((record) =>
    normalizeWorkerCredentialStageDiscardRecord(record));
  for (let index = 0; index < discards.length; index += 1) {
    if (
      discards[index]!.state !== 'discard_authorized' ||
      value.observedAtMs < discards[index]!.authorizedAtMs ||
      (index > 0 && discards[index - 1]!.deliveryId >= discards[index]!.deliveryId)
    ) {
      throw new TypeError('Worker credential stage discard recovery order is invalid');
    }
  }
  const last = discards.at(-1);
  if (
    value.truncated !== (value.nextCursor !== undefined) ||
    (value.nextCursor !== undefined &&
      (!last || value.nextCursor !== last.deliveryId))
  ) {
    throw new TypeError('Worker credential stage discard recovery cursor is invalid');
  }
  return Object.freeze({
    observedAtMs: value.observedAtMs,
    discards: Object.freeze(discards),
    truncated: value.truncated,
    ...(value.nextCursor === undefined
      ? {}
      : { nextCursor: value.nextCursor }),
  });
}

export function normalizeWorkerCredentialDeliveryRecord(
  value: WorkerCredentialDeliveryRecord,
): Readonly<WorkerCredentialDeliveryRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Worker credential delivery record is invalid');
  }
  exact(
    value,
    [
      'deliveryId',
      'version',
      'state',
      'workerId',
      'credentialId',
      'credentialVersion',
      'previousCredentialId',
      'secretDigest',
      'tokenDigest',
      'deploymentTargetDigest',
      'deploymentGeneration',
      'stagedAtMs',
      'credentialCommittedAtMs',
      'publishedAtMs',
      'publicationDigest',
      'observedAtMs',
      'observedSessionId',
      'observedSessionVersion',
      'previousRevokedAtMs',
    ],
    'Worker credential delivery record',
  );
  normalizeWorkerCredentialMutationId(value.deliveryId);
  normalizeWorkerCredentialDeliveryIntent({
    deliveryId: value.deliveryId,
    workerId: value.workerId,
    credentialId: value.credentialId,
    credentialVersion: value.credentialVersion,
    previousCredentialId: value.previousCredentialId,
    secretDigest: value.secretDigest,
    tokenDigest: value.tokenDigest,
    deploymentTargetDigest: value.deploymentTargetDigest,
    deploymentGeneration: value.deploymentGeneration,
    stagedAtMs: value.stagedAtMs,
  });
  if (!WORKER_CREDENTIAL_DELIVERY_STATES.includes(value.state)) {
    throw new TypeError('Worker credential delivery state is invalid');
  }
  const stagedAtMs = time(
    'Worker credential delivery stagedAtMs',
    value.stagedAtMs,
  );
  const credentialCommittedAtMs = time(
    'Worker credential delivery credentialCommittedAtMs',
    value.credentialCommittedAtMs,
  );
  const publishedAtMs = nullableTime(
    'Worker credential delivery publishedAtMs',
    value.publishedAtMs,
  );
  const observedAtMs = nullableTime(
    'Worker credential delivery observedAtMs',
    value.observedAtMs,
  );
  const previousRevokedAtMs = nullableTime(
    'Worker credential delivery previousRevokedAtMs',
    value.previousRevokedAtMs,
  );
  if (credentialCommittedAtMs < stagedAtMs) {
    throw new RangeError('Worker credential delivery commit precedes staging');
  }
  const expectedVersion =
    WORKER_CREDENTIAL_DELIVERY_STATES.indexOf(value.state) + 1;
  if (value.version !== expectedVersion) {
    throw new RangeError('Worker credential delivery version is invalid');
  }
  const published = expectedVersion >= 2;
  const observed = expectedVersion >= 3;
  const revoked = expectedVersion >= 4;
  if (
    published !== (publishedAtMs !== null) ||
    published !== (value.publicationDigest !== null) ||
    observed !== (observedAtMs !== null) ||
    observed !== (value.observedSessionId !== null) ||
    observed !== (value.observedSessionVersion !== null) ||
    revoked !== (previousRevokedAtMs !== null)
  ) {
    throw new TypeError('Worker credential delivery state evidence is incomplete');
  }
  if (value.publicationDigest !== null) {
    digest(
      'Worker credential delivery publication digest',
      value.publicationDigest,
    );
  }
  if (
    value.observedSessionId !== null &&
    !UUID_V7.test(value.observedSessionId)
  ) {
    throw new TypeError('Worker credential delivery observed Session is invalid');
  }
  if (
    value.observedSessionVersion !== null &&
    (!Number.isSafeInteger(value.observedSessionVersion) ||
      value.observedSessionVersion < 1)
  ) {
    throw new RangeError('Worker credential delivery observed version is invalid');
  }
  if (
    (publishedAtMs !== null && publishedAtMs < credentialCommittedAtMs) ||
    (observedAtMs !== null &&
      (publishedAtMs === null || observedAtMs < publishedAtMs)) ||
    (previousRevokedAtMs !== null &&
      (observedAtMs === null || previousRevokedAtMs < observedAtMs))
  ) {
    throw new RangeError('Worker credential delivery evidence time is invalid');
  }
  if (revoked && value.previousCredentialId === null) {
    throw new TypeError('Worker credential delivery has no previous credential');
  }
  return Object.freeze({ ...value });
}

export function normalizeCommitWorkerCredentialDeliveryCommand(
  value: CommitWorkerCredentialDeliveryCommand,
): Readonly<CommitWorkerCredentialDeliveryCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Worker credential delivery commit is invalid');
  }
  exact(value, ['credential', 'delivery'], 'Worker credential delivery commit');
  const credential = normalizeAppendWorkerCredentialCommand(value.credential);
  const delivery = normalizeWorkerCredentialDeliveryRecord(value.delivery);
  if (
    credential.mutation.operation !== 'issue' ||
    credential.expectedCurrentVersion !== 0 ||
    delivery.state !== 'credential_committed' ||
    delivery.deliveryId !== credential.mutation.mutationId ||
    delivery.credentialId !== credential.credential.credentialId ||
    delivery.credentialVersion !== credential.credential.version ||
    delivery.workerId !== credential.credential.workerId ||
    delivery.secretDigest !== credential.credential.secretDigest ||
    delivery.credentialCommittedAtMs !== credential.credential.createdAtMs
  ) {
    throw new TypeError('Worker credential delivery commit authority is invalid');
  }
  return Object.freeze({ credential, delivery });
}

export function normalizePublishWorkerCredentialDeliveryCommand(
  value: PublishWorkerCredentialDeliveryCommand,
): Readonly<PublishWorkerCredentialDeliveryCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Worker credential delivery publication is invalid');
  }
  exact(
    value,
    ['deliveryId', 'expectedVersion', 'publicationDigest', 'publishedAtMs'],
    'Worker credential delivery publication',
  );
  normalizeWorkerCredentialMutationId(value.deliveryId);
  if (value.expectedVersion !== 1) {
    throw new RangeError('Worker credential delivery publication fence is invalid');
  }
  digest(
    'Worker credential delivery publication digest',
    value.publicationDigest,
  );
  time('Worker credential delivery publishedAtMs', value.publishedAtMs);
  return Object.freeze({ ...value });
}

export function normalizeRevokePreviousWorkerCredentialDeliveryCommand(
  value: RevokePreviousWorkerCredentialDeliveryCommand,
): Readonly<RevokePreviousWorkerCredentialDeliveryCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Worker credential delivery revoke is invalid');
  }
  exact(value, ['credential', 'delivery'], 'Worker credential delivery revoke');
  const credential = normalizeAppendWorkerCredentialCommand(value.credential);
  const delivery = normalizeWorkerCredentialDeliveryRecord(value.delivery);
  if (
    credential.mutation.operation !== 'revoke' ||
    credential.expectedCurrentVersion !== 1 ||
    credential.credential.version !== 2 ||
    credential.credential.state !== 'revoked' ||
    delivery.version !== 4 ||
    delivery.state !== 'previous_revoked' ||
    delivery.previousCredentialId === null ||
    delivery.previousCredentialId !== credential.credential.credentialId ||
    delivery.workerId !== credential.credential.workerId ||
    delivery.previousRevokedAtMs !== credential.credential.createdAtMs
  ) {
    throw new TypeError('Worker credential delivery revoke authority is invalid');
  }
  return Object.freeze({ credential, delivery });
}

export function normalizeWorkerCredentialDeliveryRecoveryPage(
  value: WorkerCredentialDeliveryRecoveryPage,
): Readonly<WorkerCredentialDeliveryRecoveryPage> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Worker credential delivery recovery page is invalid');
  }
  const expected = [
    'observedAtMs',
    'deliveries',
    'truncated',
    ...(value.nextCursor === undefined ? [] : ['nextCursor']),
  ];
  exact(value, expected, 'Worker credential delivery recovery page');
  time('Worker credential delivery recovery observation', value.observedAtMs);
  if (
    !Array.isArray(value.deliveries) ||
    value.deliveries.length > MAX_WORKER_CREDENTIAL_DELIVERY_RECOVERY_PAGE_SIZE ||
    typeof value.truncated !== 'boolean'
  ) {
    throw new TypeError('Worker credential delivery recovery page bound is invalid');
  }
  const deliveries = value.deliveries.map(
    (delivery) => normalizeWorkerCredentialDeliveryRecord(delivery),
  );
  for (let index = 0; index < deliveries.length; index += 1) {
    const delivery = deliveries[index]!;
    if (
      delivery.state === 'previous_revoked' ||
      (delivery.state === 'observed' && delivery.previousCredentialId === null) ||
      value.observedAtMs <
        (delivery.observedAtMs ??
          delivery.publishedAtMs ??
          delivery.credentialCommittedAtMs) ||
      (index > 0 && deliveries[index - 1]!.deliveryId >= delivery.deliveryId)
    ) {
      throw new TypeError('Worker credential delivery recovery page order is invalid');
    }
  }
  const last = deliveries.at(-1);
  if (
    value.truncated !== (value.nextCursor !== undefined) ||
    (value.nextCursor !== undefined &&
      (!last || value.nextCursor !== last.deliveryId))
  ) {
    throw new TypeError('Worker credential delivery recovery cursor is invalid');
  }
  return Object.freeze({
    observedAtMs: value.observedAtMs,
    deliveries: Object.freeze(deliveries),
    truncated: value.truncated,
    ...(value.nextCursor === undefined
      ? {}
      : { nextCursor: value.nextCursor }),
  });
}
