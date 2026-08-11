import {
  LocalOwnerPepperCatalogFullError,
  LocalOwnerPepperGenerationConflictError,
  LocalOwnerPepperKeyNotActivatableError,
  LocalOwnerPepperMutationConflictError,
  LocalOwnerPepperRepositoryUnavailableError,
  MAX_LOCAL_OWNER_PEPPER_KEYS,
  normalizeActivateLocalOwnerPepperKeyCommand,
  normalizeRegisterLocalOwnerPepperKeyCommand,
  type ActivateLocalOwnerPepperKeyCommand,
  type ActivateLocalOwnerPepperKeyResult,
  type LocalOwnerPepperActivationRecord,
  type LocalOwnerPepperKeyRecord,
  type LocalOwnerPepperKeyState,
  type LocalOwnerPepperReferenceRepository,
  type LocalOwnerPepperReferenceSummary,
  type RegisterLocalOwnerPepperKeyCommand,
  type RegisterLocalOwnerPepperKeyResult,
} from '@qinglong/runtime-core/local-owner-pepper';
import { assertApiCredentialPepperKeyId } from '@qinglong/runtime-core/api-credential';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

interface KeyRow {
  pepper_key_id: unknown;
  material_digest: unknown;
  backup_digest: unknown;
  state: unknown;
  version: unknown;
  register_mutation_id: unknown;
  activate_mutation_id: unknown;
  retire_mutation_id: unknown;
  registered_at_ms: unknown;
  activated_at_ms: unknown;
  retired_at_ms: unknown;
}

interface ActivationRow {
  generation: unknown;
  mutation_id: unknown;
  expected_generation: unknown;
  previous_pepper_key_id: unknown;
  active_pepper_key_id: unknown;
  material_digest: unknown;
  backup_digest: unknown;
  activated_at_ms: unknown;
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const KEY_STATES = new Set<LocalOwnerPepperKeyState>([
  'recovery_required',
  'staged',
  'active',
  'retired',
]);

function requiredString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new LocalOwnerPepperRepositoryUnavailableError();
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === null) return undefined;
  return requiredString(value);
}

function integer(value: unknown, minimum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > 2_147_483_647
  ) {
    throw new LocalOwnerPepperRepositoryUnavailableError();
  }
  return value;
}

function optionalTimestamp(value: unknown): number | undefined {
  if (value === null) return undefined;
  return timestamp(value);
}

function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LocalOwnerPepperRepositoryUnavailableError();
  }
  return value;
}

function digest(value: unknown): string {
  const result = requiredString(value);
  if (!DIGEST_PATTERN.test(result)) {
    throw new LocalOwnerPepperRepositoryUnavailableError();
  }
  return result;
}

function keyRecord(row: KeyRow): Readonly<LocalOwnerPepperKeyRecord> {
  const pepperKeyId = requiredString(row.pepper_key_id);
  const state = requiredString(row.state) as LocalOwnerPepperKeyState;
  try {
    assertApiCredentialPepperKeyId(pepperKeyId);
  } catch {
    throw new LocalOwnerPepperRepositoryUnavailableError();
  }
  if (!KEY_STATES.has(state)) {
    throw new LocalOwnerPepperRepositoryUnavailableError();
  }
  const materialDigest = optionalString(row.material_digest);
  const backupDigest = optionalString(row.backup_digest);
  if (
    (materialDigest !== undefined && !DIGEST_PATTERN.test(materialDigest)) ||
    (backupDigest !== undefined && !DIGEST_PATTERN.test(backupDigest)) ||
    (materialDigest === undefined) !== (backupDigest === undefined)
  ) {
    throw new LocalOwnerPepperRepositoryUnavailableError();
  }
  return Object.freeze({
    pepperKeyId,
    ...(materialDigest === undefined ? {} : { materialDigest }),
    ...(backupDigest === undefined ? {} : { backupDigest }),
    state,
    version: integer(row.version, 1),
    ...(optionalString(row.register_mutation_id) === undefined
      ? {}
      : { registerMutationId: requiredString(row.register_mutation_id) }),
    ...(optionalString(row.activate_mutation_id) === undefined
      ? {}
      : { activateMutationId: requiredString(row.activate_mutation_id) }),
    ...(optionalString(row.retire_mutation_id) === undefined
      ? {}
      : { retireMutationId: requiredString(row.retire_mutation_id) }),
    registeredAtMs: timestamp(row.registered_at_ms),
    ...(optionalTimestamp(row.activated_at_ms) === undefined
      ? {}
      : { activatedAtMs: timestamp(row.activated_at_ms) }),
    ...(optionalTimestamp(row.retired_at_ms) === undefined
      ? {}
      : { retiredAtMs: timestamp(row.retired_at_ms) }),
  });
}

function activationRecord(
  row: ActivationRow,
): Readonly<LocalOwnerPepperActivationRecord> {
  const activePepperKeyId = requiredString(row.active_pepper_key_id);
  const previousPepperKeyId = optionalString(row.previous_pepper_key_id);
  try {
    assertApiCredentialPepperKeyId(activePepperKeyId);
    if (previousPepperKeyId !== undefined) {
      assertApiCredentialPepperKeyId(previousPepperKeyId);
    }
  } catch {
    throw new LocalOwnerPepperRepositoryUnavailableError();
  }
  return Object.freeze({
    generation: integer(row.generation, 1),
    mutationId: requiredString(row.mutation_id),
    expectedGeneration: integer(row.expected_generation, 0),
    ...(previousPepperKeyId === undefined ? {} : { previousPepperKeyId }),
    activePepperKeyId,
    materialDigest: digest(row.material_digest),
    backupDigest: digest(row.backup_digest),
    activatedAtMs: timestamp(row.activated_at_ms),
  });
}

function sameRegistration(
  key: LocalOwnerPepperKeyRecord,
  command: RegisterLocalOwnerPepperKeyCommand,
): boolean {
  return (
    key.pepperKeyId === command.pepperKeyId &&
    key.materialDigest === command.materialDigest &&
    key.backupDigest === command.backupDigest &&
    key.registerMutationId === command.mutationId &&
    key.registeredAtMs === command.registeredAtMs
  );
}

function sameActivation(
  activation: LocalOwnerPepperActivationRecord,
  command: ActivateLocalOwnerPepperKeyCommand,
): boolean {
  return (
    activation.mutationId === command.mutationId &&
    activation.activePepperKeyId === command.pepperKeyId &&
    activation.expectedGeneration === command.expectedGeneration &&
    activation.previousPepperKeyId === command.expectedActivePepperKeyId &&
    activation.activatedAtMs === command.activatedAtMs
  );
}

const KEY_SELECT = `
SELECT pepper_key_id, material_digest, backup_digest, state, version,
       register_mutation_id, activate_mutation_id, retire_mutation_id,
       registered_at_ms, activated_at_ms, retired_at_ms
FROM "QingLong3LocalOwnerPepperKeys"`;

const ACTIVATION_SELECT = `
SELECT generation, mutation_id, expected_generation,
       previous_pepper_key_id, active_pepper_key_id,
       material_digest, backup_digest, activated_at_ms
FROM "QingLong3LocalOwnerPepperActivations"`;

export class LocalSqliteOwnerPepperRepository
  implements LocalOwnerPepperReferenceRepository
{
  private readonly authority: LocalSqliteOperationAuthority;

  constructor(authority: LocalSqliteOperationAuthority) {
    this.authority = authority;
  }

  resolveKey(
    pepperKeyId: string,
  ): Promise<Readonly<LocalOwnerPepperKeyRecord> | null> {
    try {
      assertApiCredentialPepperKeyId(pepperKeyId);
    } catch {
      throw new LocalOwnerPepperRepositoryUnavailableError();
    }
    return this.authority.enqueue(
      async () => {
        try {
          const row = this.authority.client
            .prepare(`${KEY_SELECT} WHERE pepper_key_id = ?`)
            .get(pepperKeyId) as KeyRow | undefined;
          return row ? keyRecord(row) : null;
        } catch (error) {
          if (error instanceof LocalOwnerPepperRepositoryUnavailableError) {
            throw error;
          }
          throw new LocalOwnerPepperRepositoryUnavailableError();
        }
      },
      () => new LocalOwnerPepperRepositoryUnavailableError(),
    );
  }

  resolveActive(): Promise<Readonly<LocalOwnerPepperActivationRecord> | null> {
    return this.authority.enqueue(
      async () => {
        try {
          const row = this.authority.client
            .prepare(`${ACTIVATION_SELECT} ORDER BY generation DESC LIMIT 1`)
            .get() as ActivationRow | undefined;
          return row ? activationRecord(row) : null;
        } catch (error) {
          if (error instanceof LocalOwnerPepperRepositoryUnavailableError) {
            throw error;
          }
          throw new LocalOwnerPepperRepositoryUnavailableError();
        }
      },
      () => new LocalOwnerPepperRepositoryUnavailableError(),
    );
  }

  inspectReferences(
    pepperKeyId: string,
    inspectedAtMs: number,
  ): Promise<Readonly<LocalOwnerPepperReferenceSummary>> {
    try {
      assertApiCredentialPepperKeyId(pepperKeyId);
    } catch {
      throw new LocalOwnerPepperRepositoryUnavailableError();
    }
    if (!Number.isSafeInteger(inspectedAtMs) || inspectedAtMs < 0) {
      throw new LocalOwnerPepperRepositoryUnavailableError();
    }
    return this.authority.enqueue(
      async () => {
        try {
          const keyRow = this.authority.client
            .prepare(`${KEY_SELECT} WHERE pepper_key_id = ?`)
            .get(pepperKeyId) as KeyRow | undefined;
          if (!keyRow) throw new LocalOwnerPepperRepositoryUnavailableError();
          const key = keyRecord(keyRow);
          const historical = this.authority.client
            .prepare(
              `SELECT COUNT(*) AS count
               FROM "QingLong3ApiCredentialPepperBindings"
               WHERE "pepper_key_id" = ?`,
            )
            .get(pepperKeyId) as { count?: unknown } | undefined;
          const current = this.authority.client
            .prepare(
              `SELECT COUNT(*) AS count
               FROM "QingLong3ApiCredentialPepperBindings" AS binding
               JOIN "QingLong3ApiCredentials" AS credential
                 ON credential."credential_id" = binding."credential_id"
                AND credential."version" = binding."credential_version"
               WHERE binding."pepper_key_id" = ?
                 AND credential."state" = 'active'
                 AND credential."expires_at_ms" > ?
                 AND NOT EXISTS (
                   SELECT 1 FROM "QingLong3ApiCredentials" AS later
                   WHERE later."credential_id" = credential."credential_id"
                     AND later."version" > credential."version"
                 )`,
            )
            .get(pepperKeyId, inspectedAtMs) as { count?: unknown } | undefined;
          const inFlight = this.authority.client
            .prepare(
              `SELECT COUNT(*) AS count
               FROM "QingLong3LocalOwnerCredentialRecoveries" AS recovery
               WHERE recovery."state" <> 'completed'
                 AND (
                   EXISTS (
                     SELECT 1
                     FROM "QingLong3ApiCredentialPepperBindings" AS previous
                     WHERE previous."credential_id" = recovery."previous_credential_id"
                       AND previous."credential_version" = recovery."previous_credential_version"
                       AND previous."pepper_key_id" = ?
                   )
                   OR EXISTS (
                     SELECT 1
                     FROM "QingLong3ApiCredentialPepperBindings" AS replacement
                     WHERE replacement."credential_id" = recovery."replacement_credential_id"
                       AND replacement."credential_version" = recovery."replacement_credential_version"
                       AND replacement."pepper_key_id" = ?
                   )
                 )`,
            )
            .get(pepperKeyId, pepperKeyId) as { count?: unknown } | undefined;
          const currentCredentialReferences = integer(current?.count, 0);
          const inFlightRecoveryReferences = integer(inFlight?.count, 0);
          return Object.freeze({
            pepperKeyId,
            inspectedAtMs,
            currentCredentialReferences,
            inFlightRecoveryReferences,
            historicalCredentialReferences: integer(historical?.count, 0),
            runtimeReferencesClear:
              key.state === 'retired' &&
              currentCredentialReferences === 0 &&
              inFlightRecoveryReferences === 0,
          });
        } catch (error) {
          if (error instanceof LocalOwnerPepperRepositoryUnavailableError) {
            throw error;
          }
          throw new LocalOwnerPepperRepositoryUnavailableError();
        }
      },
      () => new LocalOwnerPepperRepositoryUnavailableError(),
    );
  }

  register(
    input: RegisterLocalOwnerPepperKeyCommand,
  ): Promise<RegisterLocalOwnerPepperKeyResult> {
    const command = normalizeRegisterLocalOwnerPepperKeyCommand(input);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        client.exec('BEGIN IMMEDIATE');
        try {
          const replay = client
            .prepare(`${KEY_SELECT} WHERE register_mutation_id = ?`)
            .get(command.mutationId) as KeyRow | undefined;
          if (replay) {
            const key = keyRecord(replay);
            if (!sameRegistration(key, command)) {
              throw new LocalOwnerPepperMutationConflictError();
            }
            client.exec('COMMIT');
            return Object.freeze({ status: 'existing' as const, key });
          }
          const existingRow = client
            .prepare(`${KEY_SELECT} WHERE pepper_key_id = ?`)
            .get(command.pepperKeyId) as KeyRow | undefined;
          if (existingRow) {
            const existing = keyRecord(existingRow);
            if (existing.state !== 'recovery_required') {
              throw new LocalOwnerPepperMutationConflictError();
            }
            const changed = client
              .prepare(
                `UPDATE "QingLong3LocalOwnerPepperKeys"
                 SET material_digest = ?, backup_digest = ?, state = 'staged',
                     version = version + 1, register_mutation_id = ?,
                     registered_at_ms = ?
                 WHERE pepper_key_id = ? AND version = ?
                   AND state = 'recovery_required'`,
              )
              .run(
                command.materialDigest,
                command.backupDigest,
                command.mutationId,
                command.registeredAtMs,
                command.pepperKeyId,
                existing.version,
              );
            if (changed.changes !== 1) {
              throw new LocalOwnerPepperMutationConflictError();
            }
          } else {
            const count = client
              .prepare(
                `SELECT COUNT(*) AS count FROM "QingLong3LocalOwnerPepperKeys"`,
              )
              .get() as { count?: unknown } | undefined;
            if (integer(count?.count, 0) >= MAX_LOCAL_OWNER_PEPPER_KEYS) {
              throw new LocalOwnerPepperCatalogFullError();
            }
            client
              .prepare(
                `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
                   pepper_key_id, material_digest, backup_digest, state,
                   version, register_mutation_id, registered_at_ms
                 ) VALUES (?, ?, ?, 'staged', 1, ?, ?)`,
              )
              .run(
                command.pepperKeyId,
                command.materialDigest,
                command.backupDigest,
                command.mutationId,
                command.registeredAtMs,
              );
          }
          const key = keyRecord(
            client
              .prepare(`${KEY_SELECT} WHERE pepper_key_id = ?`)
              .get(command.pepperKeyId) as unknown as KeyRow,
          );
          client.exec('COMMIT');
          return Object.freeze({ status: 'inserted' as const, key });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (
            error instanceof LocalOwnerPepperMutationConflictError ||
            error instanceof LocalOwnerPepperCatalogFullError ||
            error instanceof LocalOwnerPepperRepositoryUnavailableError
          ) {
            throw error;
          }
          throw new LocalOwnerPepperRepositoryUnavailableError();
        }
      },
      () => new LocalOwnerPepperRepositoryUnavailableError(),
    );
  }

  activate(
    input: ActivateLocalOwnerPepperKeyCommand,
  ): Promise<ActivateLocalOwnerPepperKeyResult> {
    const command = normalizeActivateLocalOwnerPepperKeyCommand(input);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        client.exec('BEGIN IMMEDIATE');
        try {
          const replay = client
            .prepare(`${ACTIVATION_SELECT} WHERE mutation_id = ?`)
            .get(command.mutationId) as ActivationRow | undefined;
          if (replay) {
            const activation = activationRecord(replay);
            if (!sameActivation(activation, command)) {
              throw new LocalOwnerPepperMutationConflictError();
            }
            client.exec('COMMIT');
            return Object.freeze({ status: 'existing' as const, activation });
          }
          const currentRow = client
            .prepare(`${ACTIVATION_SELECT} ORDER BY generation DESC LIMIT 1`)
            .get() as ActivationRow | undefined;
          const current = currentRow ? activationRecord(currentRow) : null;
          const generation = current?.generation ?? 0;
          if (
            generation !== command.expectedGeneration ||
            current?.activePepperKeyId !== command.expectedActivePepperKeyId
          ) {
            throw new LocalOwnerPepperGenerationConflictError();
          }
          const targetRow = client
            .prepare(`${KEY_SELECT} WHERE pepper_key_id = ?`)
            .get(command.pepperKeyId) as KeyRow | undefined;
          const target = targetRow ? keyRecord(targetRow) : null;
          if (
            !target ||
            target.state !== 'staged' ||
            !target.materialDigest ||
            !target.backupDigest ||
            command.activatedAtMs < target.registeredAtMs
          ) {
            throw new LocalOwnerPepperKeyNotActivatableError();
          }
          if (current) {
            const retired = client
              .prepare(
                `UPDATE "QingLong3LocalOwnerPepperKeys"
                 SET state = 'retired', version = version + 1,
                     retire_mutation_id = ?, retired_at_ms = ?
                 WHERE pepper_key_id = ? AND state = 'active'`,
              )
              .run(
                command.mutationId,
                command.activatedAtMs,
                current.activePepperKeyId,
              );
            if (retired.changes !== 1) {
              throw new LocalOwnerPepperGenerationConflictError();
            }
          }
          const activated = client
            .prepare(
              `UPDATE "QingLong3LocalOwnerPepperKeys"
               SET state = 'active', version = version + 1,
                   activate_mutation_id = ?, activated_at_ms = ?
               WHERE pepper_key_id = ? AND version = ? AND state = 'staged'`,
            )
            .run(
              command.mutationId,
              command.activatedAtMs,
              command.pepperKeyId,
              target.version,
            );
          if (activated.changes !== 1) {
            throw new LocalOwnerPepperGenerationConflictError();
          }
          client
            .prepare(
              `INSERT INTO "QingLong3LocalOwnerPepperActivations" (
                 generation, mutation_id, expected_generation,
                 previous_pepper_key_id, active_pepper_key_id,
                 material_digest, backup_digest, activated_at_ms
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              generation + 1,
              command.mutationId,
              command.expectedGeneration,
              current?.activePepperKeyId ?? null,
              command.pepperKeyId,
              target.materialDigest,
              target.backupDigest,
              command.activatedAtMs,
            );
          const activation = activationRecord(
            client
              .prepare(`${ACTIVATION_SELECT} WHERE mutation_id = ?`)
              .get(command.mutationId) as unknown as ActivationRow,
          );
          client.exec('COMMIT');
          return Object.freeze({ status: 'inserted' as const, activation });
        } catch (error) {
          if (client.isTransaction) client.exec('ROLLBACK');
          if (
            error instanceof LocalOwnerPepperMutationConflictError ||
            error instanceof LocalOwnerPepperGenerationConflictError ||
            error instanceof LocalOwnerPepperKeyNotActivatableError ||
            error instanceof LocalOwnerPepperRepositoryUnavailableError
          ) {
            throw error;
          }
          throw new LocalOwnerPepperRepositoryUnavailableError();
        }
      },
      () => new LocalOwnerPepperRepositoryUnavailableError(),
    );
  }
}
