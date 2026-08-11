import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { SecurityPrincipal } from '@qinglong/runtime-core/security';

import {
  LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
  assertLocalModelInvocationFeatureReady,
} from '../migration/modelInvocationMigration';

export const LOCAL_MODEL_INVOCATION_FEATURE_ID = 'model-invocation' as const;
export const LOCAL_MODEL_INVOCATION_FEATURE_TRANSITION_SCHEMA =
  'qinglong/model-invocation-feature-transition@v1' as const;
export const LOCAL_MODEL_INVOCATION_FEATURE_STATES = [
  'active',
  'inactive',
] as const;
export const LOCAL_MODEL_INVOCATION_FEATURE_SAFETY_MODES = [
  'fresh_database',
  'backup_verified',
  'preserve_existing',
] as const;

export type LocalModelInvocationFeatureState =
  (typeof LOCAL_MODEL_INVOCATION_FEATURE_STATES)[number];
export type LocalModelInvocationFeatureSafetyMode =
  (typeof LOCAL_MODEL_INVOCATION_FEATURE_SAFETY_MODES)[number];

export interface LocalModelInvocationFeatureTransitionCommand {
  readonly featureId: typeof LOCAL_MODEL_INVOCATION_FEATURE_ID;
  readonly expectedGeneration: number;
  readonly expectedState: LocalModelInvocationFeatureState | null;
  readonly state: LocalModelInvocationFeatureState;
  readonly mutationId: string;
  readonly requestId: string;
  readonly expectedMigrationDigest: string;
  readonly safety: Readonly<{
    readonly mode: LocalModelInvocationFeatureSafetyMode;
    readonly backupEvidenceDigest: string | null;
  }>;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly commandDigest: string;
}

export interface LocalModelInvocationFeatureTransition {
  readonly schema: typeof LOCAL_MODEL_INVOCATION_FEATURE_TRANSITION_SCHEMA;
  readonly featureId: typeof LOCAL_MODEL_INVOCATION_FEATURE_ID;
  readonly generation: number;
  readonly previousGeneration: number | null;
  readonly state: LocalModelInvocationFeatureState;
  readonly mutationId: string;
  readonly requestId: string;
  readonly expectedMigrationDigest: string;
  readonly safety: Readonly<{
    readonly mode: LocalModelInvocationFeatureSafetyMode;
    readonly backupEvidenceDigest: string | null;
  }>;
  readonly changedByUserId: string;
  readonly authenticationId: string;
  readonly assurance: 'local_console';
  readonly commandDigest: string;
  readonly committedAtMs: number;
  readonly transitionDigest: string;
}

export interface CommitLocalModelInvocationFeatureTransitionResult {
  readonly status: 'created' | 'existing';
  readonly transition: Readonly<LocalModelInvocationFeatureTransition>;
}

export interface LocalModelInvocationFeatureActivationRepositoryOptions {
  readonly beforeMutation?: (
    client: DatabaseSync,
    command: Readonly<LocalModelInvocationFeatureTransitionCommand>,
  ) => void;
}

export class InvalidLocalModelInvocationFeatureTransitionError extends TypeError {
  readonly code = 'LOCAL_MODEL_INVOCATION_FEATURE_TRANSITION_INVALID';

  constructor(message: string) {
    super(`Local ModelInvocation feature transition is invalid: ${message}`);
    this.name = 'InvalidLocalModelInvocationFeatureTransitionError';
  }
}

export class LocalModelInvocationFeatureTransitionConflictError extends Error {
  readonly code = 'LOCAL_MODEL_INVOCATION_FEATURE_TRANSITION_CONFLICT';

  constructor() {
    super(
      'Local ModelInvocation feature transition conflicts with durable state',
    );
    this.name = 'LocalModelInvocationFeatureTransitionConflictError';
  }
}

export class LocalModelInvocationFeatureTransitionUnavailableError extends Error {
  readonly code = 'LOCAL_MODEL_INVOCATION_FEATURE_TRANSITION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Local ModelInvocation feature transition is unavailable', options);
    this.name = 'LocalModelInvocationFeatureTransitionUnavailableError';
  }
}

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const COMMAND_DIGEST_DOMAIN = Buffer.from(
  'qinglong/local-model-invocation-feature-command@v1\0',
  'utf8',
);
const TRANSITION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/local-model-invocation-feature-transition@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidLocalModelInvocationFeatureTransitionError(message);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function generation(value: unknown, label: string, minimum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > 2_147_483_647
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function state(value: unknown): LocalModelInvocationFeatureState {
  if (value !== 'active' && value !== 'inactive') {
    return invalid('state is invalid');
  }
  return value;
}

function hash(domain: Buffer, value: object): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function principalIdentity(principal: Readonly<SecurityPrincipal>): Readonly<{
  changedByUserId: string;
  authenticationId: string;
  assurance: 'local_console';
}> {
  if (
    !principal ||
    typeof principal !== 'object' ||
    Array.isArray(principal) ||
    principal.subject?.type !== 'user' ||
    typeof principal.subject.id !== 'string' ||
    principal.subject.id.length < 1 ||
    principal.subject.id.length > 255 ||
    !IDENTITY_PATTERN.test(principal.authenticationId) ||
    principal.assurance !== 'local_console'
  ) {
    return invalid('principal must be a local-console User');
  }
  return Object.freeze({
    changedByUserId: principal.subject.id,
    authenticationId: principal.authenticationId,
    assurance: principal.assurance,
  });
}

function safety(
  value: LocalModelInvocationFeatureTransitionCommand['safety'],
  targetState: LocalModelInvocationFeatureState,
): Readonly<LocalModelInvocationFeatureTransitionCommand['safety']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('safety is invalid');
  }
  const actual = Object.keys(value).sort();
  if (
    actual.length !== 2 ||
    actual[0] !== 'backupEvidenceDigest' ||
    actual[1] !== 'mode'
  ) {
    return invalid('safety shape is invalid');
  }
  const backupEvidenceDigest =
    value.backupEvidenceDigest === null
      ? null
      : digest(value.backupEvidenceDigest, 'backup evidence digest');
  if (
    (targetState === 'active' &&
      !(
        (value.mode === 'fresh_database' && backupEvidenceDigest === null) ||
        (value.mode === 'backup_verified' && backupEvidenceDigest !== null)
      )) ||
    (targetState === 'inactive' &&
      (value.mode !== 'preserve_existing' || backupEvidenceDigest !== null))
  ) {
    return invalid('safety mode does not match the target state');
  }
  return Object.freeze({
    mode: value.mode,
    backupEvidenceDigest,
  });
}

function commandDigestValue(
  value: Omit<LocalModelInvocationFeatureTransitionCommand, 'commandDigest'>,
): object {
  const principal = principalIdentity(value.principal);
  return {
    featureId: value.featureId,
    expectedGeneration: value.expectedGeneration,
    expectedState: value.expectedState,
    state: value.state,
    mutationId: value.mutationId,
    requestId: value.requestId,
    expectedMigrationDigest: value.expectedMigrationDigest,
    safety: value.safety,
    changedByUserId: principal.changedByUserId,
    authenticationId: principal.authenticationId,
    assurance: principal.assurance,
  };
}

export function createLocalModelInvocationFeatureTransitionCommand(
  value: Omit<LocalModelInvocationFeatureTransitionCommand, 'commandDigest'>,
): Readonly<LocalModelInvocationFeatureTransitionCommand> {
  if (
    value.featureId !== LOCAL_MODEL_INVOCATION_FEATURE_ID ||
    (value.expectedState !== null &&
      value.expectedState !== 'active' &&
      value.expectedState !== 'inactive')
  ) {
    return invalid('feature or expected state is invalid');
  }
  const normalizedState = state(value.state);
  const expectedGeneration = generation(
    value.expectedGeneration,
    'expected generation',
    0,
  );
  if (
    (expectedGeneration === 0 && value.expectedState !== null) ||
    (expectedGeneration > 0 && value.expectedState === null) ||
    normalizedState === value.expectedState
  ) {
    return invalid('state transition fence is invalid');
  }
  const normalized = Object.freeze({
    featureId: LOCAL_MODEL_INVOCATION_FEATURE_ID,
    expectedGeneration,
    expectedState: value.expectedState,
    state: normalizedState,
    mutationId: identity(value.mutationId, 'mutation ID'),
    requestId: identity(value.requestId, 'request ID'),
    expectedMigrationDigest: digest(
      value.expectedMigrationDigest,
      'expected migration digest',
    ),
    safety: safety(value.safety, normalizedState),
    principal: value.principal,
  });
  return Object.freeze({
    ...normalized,
    commandDigest: hash(COMMAND_DIGEST_DOMAIN, commandDigestValue(normalized)),
  });
}

function transitionDigestValue(
  value: Omit<LocalModelInvocationFeatureTransition, 'transitionDigest'>,
): object {
  return { ...value };
}

function createTransition(
  command: Readonly<LocalModelInvocationFeatureTransitionCommand>,
  committedAtMs: number,
): Readonly<LocalModelInvocationFeatureTransition> {
  if (!Number.isSafeInteger(committedAtMs) || committedAtMs < 0) {
    return invalid('database clock is invalid');
  }
  const principal = principalIdentity(command.principal);
  const value = Object.freeze({
    schema: LOCAL_MODEL_INVOCATION_FEATURE_TRANSITION_SCHEMA,
    featureId: LOCAL_MODEL_INVOCATION_FEATURE_ID,
    generation: command.expectedGeneration + 1,
    previousGeneration:
      command.expectedGeneration === 0 ? null : command.expectedGeneration,
    state: command.state,
    mutationId: command.mutationId,
    requestId: command.requestId,
    expectedMigrationDigest: command.expectedMigrationDigest,
    safety: command.safety,
    ...principal,
    commandDigest: command.commandDigest,
    committedAtMs,
  });
  return Object.freeze({
    ...value,
    transitionDigest: hash(
      TRANSITION_DIGEST_DOMAIN,
      transitionDigestValue(value),
    ),
  });
}

interface TransitionRow extends Record<string, unknown> {
  readonly transitionJson: unknown;
}

function normalizeTransitionJson(
  value: unknown,
): LocalModelInvocationFeatureTransition {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 32 * 1024
  ) {
    return invalid('durable transition JSON is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid('durable transition JSON is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalid('durable transition JSON is invalid');
  }
  const candidate = parsed as Record<string, unknown>;
  const expectedKeys = [
    'assurance',
    'authenticationId',
    'changedByUserId',
    'commandDigest',
    'committedAtMs',
    'expectedMigrationDigest',
    'featureId',
    'generation',
    'mutationId',
    'previousGeneration',
    'requestId',
    'safety',
    'schema',
    'state',
    'transitionDigest',
  ].sort();
  if (
    Object.keys(candidate).sort().join('\0') !== expectedKeys.join('\0') ||
    candidate.schema !== LOCAL_MODEL_INVOCATION_FEATURE_TRANSITION_SCHEMA ||
    candidate.featureId !== LOCAL_MODEL_INVOCATION_FEATURE_ID ||
    candidate.assurance !== 'local_console' ||
    typeof candidate.changedByUserId !== 'string' ||
    candidate.changedByUserId.length < 1 ||
    candidate.changedByUserId.length > 255 ||
    !IDENTITY_PATTERN.test(candidate.authenticationId as string) ||
    !IDENTITY_PATTERN.test(candidate.mutationId as string) ||
    !IDENTITY_PATTERN.test(candidate.requestId as string)
  ) {
    return invalid('durable transition JSON is invalid');
  }
  const normalizedState = state(candidate.state);
  const normalizedGeneration = generation(
    candidate.generation,
    'durable generation',
    1,
  );
  const previousGeneration =
    candidate.previousGeneration === null
      ? null
      : generation(
          candidate.previousGeneration,
          'durable previous generation',
          1,
        );
  const normalizedSafety = safety(
    candidate.safety as LocalModelInvocationFeatureTransitionCommand['safety'],
    normalizedState,
  );
  const normalized = Object.freeze({
    schema: LOCAL_MODEL_INVOCATION_FEATURE_TRANSITION_SCHEMA,
    featureId: LOCAL_MODEL_INVOCATION_FEATURE_ID,
    generation: normalizedGeneration,
    previousGeneration,
    state: normalizedState,
    mutationId: candidate.mutationId as string,
    requestId: candidate.requestId as string,
    expectedMigrationDigest: digest(
      candidate.expectedMigrationDigest,
      'durable expected migration digest',
    ),
    safety: normalizedSafety,
    changedByUserId: candidate.changedByUserId,
    authenticationId: candidate.authenticationId as string,
    assurance: 'local_console' as const,
    commandDigest: digest(candidate.commandDigest, 'durable command digest'),
    committedAtMs: nonnegativeInteger(
      candidate.committedAtMs,
      'durable committed time',
    ),
  });
  const transitionDigest = digest(
    candidate.transitionDigest,
    'durable transition digest',
  );
  if (
    hash(TRANSITION_DIGEST_DOMAIN, transitionDigestValue(normalized)) !==
    transitionDigest
  ) {
    return invalid('durable transition digest is invalid');
  }
  return Object.freeze({ ...normalized, transitionDigest });
}

function sameCommand(
  command: Readonly<LocalModelInvocationFeatureTransitionCommand>,
  transition: Readonly<LocalModelInvocationFeatureTransition>,
): boolean {
  const principal = principalIdentity(command.principal);
  return (
    transition.featureId === command.featureId &&
    transition.generation === command.expectedGeneration + 1 &&
    transition.previousGeneration ===
      (command.expectedGeneration === 0 ? null : command.expectedGeneration) &&
    transition.state === command.state &&
    transition.mutationId === command.mutationId &&
    transition.requestId === command.requestId &&
    transition.expectedMigrationDigest === command.expectedMigrationDigest &&
    JSON.stringify(transition.safety) === JSON.stringify(command.safety) &&
    transition.changedByUserId === principal.changedByUserId &&
    transition.authenticationId === principal.authenticationId &&
    transition.assurance === principal.assurance &&
    transition.commandDigest === command.commandDigest
  );
}

export class LocalModelInvocationFeatureActivationRepository {
  readonly #beforeMutation:
    | LocalModelInvocationFeatureActivationRepositoryOptions['beforeMutation'];

  constructor(
    private readonly client: DatabaseSync,
    options: LocalModelInvocationFeatureActivationRepositoryOptions = {},
  ) {
    if (
      !client ||
      typeof client !== 'object' ||
      !client.isOpen ||
      typeof options !== 'object' ||
      options === null ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'beforeMutation') ||
      (options.beforeMutation !== undefined &&
        typeof options.beforeMutation !== 'function')
    ) {
      throw new TypeError(
        'Local ModelInvocation feature activation repository options are invalid',
      );
    }
    this.#beforeMutation = options.beforeMutation;
  }

  findCurrent(): Readonly<LocalModelInvocationFeatureTransition> | null {
    assertLocalModelInvocationFeatureReady(this.client);
    const row = this.client
      .prepare(
        `SELECT transition.transition_json AS "transitionJson"
           FROM "ModelInvocationFeatureHead" head
           JOIN "ModelInvocationFeatureTransitions" transition
             ON transition.feature_id = head.feature_id
            AND transition.generation = head.generation
            AND transition.transition_digest = head.transition_digest
          WHERE head.feature_id = ?`,
      )
      .get(LOCAL_MODEL_INVOCATION_FEATURE_ID) as TransitionRow | undefined;
    return row ? normalizeTransitionJson(row.transitionJson) : null;
  }

  transition(
    commandValue: Readonly<LocalModelInvocationFeatureTransitionCommand>,
  ): Readonly<CommitLocalModelInvocationFeatureTransitionResult> {
    const command = createLocalModelInvocationFeatureTransitionCommand({
      featureId: commandValue.featureId,
      expectedGeneration: commandValue.expectedGeneration,
      expectedState: commandValue.expectedState,
      state: commandValue.state,
      mutationId: commandValue.mutationId,
      requestId: commandValue.requestId,
      expectedMigrationDigest: commandValue.expectedMigrationDigest,
      safety: commandValue.safety,
      principal: commandValue.principal,
    });
    if (
      commandValue.commandDigest !== command.commandDigest ||
      command.expectedMigrationDigest !==
        LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST
    ) {
      throw new LocalModelInvocationFeatureTransitionConflictError();
    }
    assertLocalModelInvocationFeatureReady(this.client);
    this.client.exec('BEGIN IMMEDIATE');
    try {
      this.#beforeMutation?.(this.client, command);
      const replay = this.client
        .prepare(
          `SELECT transition_json AS "transitionJson"
             FROM "ModelInvocationFeatureTransitions"
            WHERE mutation_id = ?`,
        )
        .get(command.mutationId) as TransitionRow | undefined;
      if (replay) {
        const transition = normalizeTransitionJson(replay.transitionJson);
        if (!sameCommand(command, transition)) {
          throw new LocalModelInvocationFeatureTransitionConflictError();
        }
        this.client.exec('COMMIT');
        return Object.freeze({ status: 'existing', transition });
      }
      const current = this.findCurrent();
      if (
        current?.generation !==
          (command.expectedGeneration === 0
            ? undefined
            : command.expectedGeneration) ||
        (current?.state ?? null) !== command.expectedState
      ) {
        throw new LocalModelInvocationFeatureTransitionConflictError();
      }
      const clock = this.client
        .prepare(`SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now`)
        .get() as { readonly now?: unknown };
      const transition = createTransition(
        command,
        nonnegativeInteger(clock.now, 'database clock'),
      );
      const transitionJson = JSON.stringify(transition);
      this.client
        .prepare(
          `INSERT INTO "ModelInvocationFeatureTransitions" (
             feature_id, generation, previous_generation, state,
             mutation_id, request_id, expected_migration_digest,
             safety_mode, backup_evidence_digest, changed_by_user_id,
             authentication_id, assurance, command_digest,
             transition_digest, committed_at_ms, transition_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          transition.featureId,
          transition.generation,
          transition.previousGeneration,
          transition.state,
          transition.mutationId,
          transition.requestId,
          transition.expectedMigrationDigest,
          transition.safety.mode,
          transition.safety.backupEvidenceDigest,
          transition.changedByUserId,
          transition.authenticationId,
          transition.assurance,
          transition.commandDigest,
          transition.transitionDigest,
          transition.committedAtMs,
          transitionJson,
        );
      if (command.expectedGeneration === 0) {
        this.client
          .prepare(
            `INSERT INTO "ModelInvocationFeatureHead" (
               feature_id, generation, state, transition_digest, updated_at_ms
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            transition.featureId,
            transition.generation,
            transition.state,
            transition.transitionDigest,
            transition.committedAtMs,
          );
      } else {
        const updated = this.client
          .prepare(
            `UPDATE "ModelInvocationFeatureHead"
                SET generation = ?,
                    state = ?,
                    transition_digest = ?,
                    updated_at_ms = ?
              WHERE feature_id = ?
                AND generation = ?
                AND state = ?`,
          )
          .run(
            transition.generation,
            transition.state,
            transition.transitionDigest,
            transition.committedAtMs,
            transition.featureId,
            command.expectedGeneration,
            command.expectedState,
          );
        if (updated.changes !== 1) {
          throw new LocalModelInvocationFeatureTransitionConflictError();
        }
      }
      this.client.exec('COMMIT');
      return Object.freeze({ status: 'created', transition });
    } catch (error) {
      if (this.client.isTransaction) this.client.exec('ROLLBACK');
      if (
        error instanceof InvalidLocalModelInvocationFeatureTransitionError ||
        error instanceof LocalModelInvocationFeatureTransitionConflictError
      ) {
        throw error;
      }
      throw new LocalModelInvocationFeatureTransitionUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
}

export function assertLocalModelInvocationFeatureActive(
  client: DatabaseSync,
): Readonly<LocalModelInvocationFeatureTransition> {
  const current = new LocalModelInvocationFeatureActivationRepository(
    client,
  ).findCurrent();
  if (current?.state !== 'active') {
    throw new LocalModelInvocationFeatureTransitionUnavailableError();
  }
  return current;
}
