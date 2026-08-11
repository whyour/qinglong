import { timingSafeEqual } from 'crypto';
import {
  QueryTypes,
  Sequelize,
  Transaction,
  UniqueConstraintError,
} from 'sequelize';
import {
  PROJECT_ROLE_BINDING_TABLE,
  PROJECT_TABLE,
} from '../../../migrations/0017-project-policy';
import { PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE } from '../../../migrations/0018-project-owner-bootstrap';
import {
  assertProjectPolicyProjectId,
  normalizePolicySubject,
  normalizeProjectRoleBindingRecord,
  type ProjectRoleBindingRecord,
} from '../../domain/projectPolicy';
import {
  OWNER_BOOTSTRAP_MAX_VERSION,
  OWNER_BOOTSTRAP_SYSTEM_SUBJECT,
  ProjectOwnerBootstrapChallengeActiveError,
  ProjectOwnerBootstrapClaimRejectedError,
  ProjectOwnerBootstrapProjectInactiveError,
  ProjectOwnerBootstrapProjectNotFoundError,
  ProjectOwnerBootstrapProjectNotPristineError,
  ProjectOwnerBootstrapUnavailableError,
  assertProjectOwnerBootstrapChallengeId,
  assertProjectOwnerBootstrapTokenDigest,
  normalizeProjectOwnerBootstrapChallengeRecord,
  type ProjectOwnerBootstrapChallengeRecord,
} from '../../domain/projectOwnerBootstrap';
import type {
  ClaimProjectOwnerBootstrapChallengeCommand,
  ClaimProjectOwnerBootstrapChallengeResult,
  IssueProjectOwnerBootstrapChallengeCommand,
  ProjectOwnerBootstrapRepository,
} from '../../ports/projectOwnerBootstrapRepository';

const RETRY_ATTEMPTS = 5;

interface ProjectStatusRow {
  status: string;
}

interface BootstrapChallengeRow {
  project_id: string;
  version: number;
  challenge_id: string;
  token_digest: string;
  issued_at_ms: number | string;
  expires_at_ms: number | string;
  consumed_at_ms: number | string | null;
  claimed_subject_type: string | null;
  claimed_subject_id: string | null;
}

interface BootstrapBindingRow {
  project_id: string;
  subject_type: string;
  subject_id: string;
  version: number;
  state: string;
  role: string | null;
  mutation_id: string;
  changed_by_type: string;
  changed_by_id: string;
  created_at_ms: number | string;
}

function assertExactKeys(value: object, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new TypeError('Project owner bootstrap command shape is invalid');
  }
}

function assertTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Project owner bootstrap ${name} is invalid`);
  }
}

function normalizeIssueCommand(
  command: IssueProjectOwnerBootstrapChallengeCommand,
): Readonly<IssueProjectOwnerBootstrapChallengeCommand> {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('Project owner bootstrap issue command is invalid');
  }
  assertExactKeys(command, [
    'projectId',
    'challengeId',
    'tokenDigest',
    'issuedAtMs',
    'expiresAtMs',
  ]);
  assertProjectPolicyProjectId(command.projectId);
  assertProjectOwnerBootstrapChallengeId(command.challengeId);
  assertProjectOwnerBootstrapTokenDigest(command.tokenDigest);
  assertTimestamp('issuedAtMs', command.issuedAtMs);
  assertTimestamp('expiresAtMs', command.expiresAtMs);
  if (command.expiresAtMs <= command.issuedAtMs) {
    throw new TypeError('Project owner bootstrap lifetime is invalid');
  }
  return Object.freeze({ ...command });
}

function normalizeClaimCommand(
  command: ClaimProjectOwnerBootstrapChallengeCommand,
): Readonly<ClaimProjectOwnerBootstrapChallengeCommand> {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('Project owner bootstrap claim command is invalid');
  }
  assertExactKeys(command, [
    'projectId',
    'challengeId',
    'tokenDigest',
    'subject',
    'claimedAtMs',
  ]);
  assertProjectPolicyProjectId(command.projectId);
  assertProjectOwnerBootstrapChallengeId(command.challengeId);
  assertProjectOwnerBootstrapTokenDigest(command.tokenDigest);
  const subject = normalizePolicySubject(command.subject);
  if (subject.type !== 'user') {
    throw new ProjectOwnerBootstrapClaimRejectedError();
  }
  assertTimestamp('claimedAtMs', command.claimedAtMs);
  return Object.freeze({ ...command, subject });
}

function rowToChallenge(
  row: BootstrapChallengeRow,
): Readonly<ProjectOwnerBootstrapChallengeRecord> {
  return normalizeProjectOwnerBootstrapChallengeRecord({
    projectId: row.project_id,
    version: Number(row.version),
    challengeId: row.challenge_id,
    tokenDigest: row.token_digest,
    issuedAtMs: Number(row.issued_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
    ...(row.consumed_at_ms === null
      ? {}
      : {
          consumedAtMs: Number(row.consumed_at_ms),
          claimedSubject: {
            type: row.claimed_subject_type as NonNullable<
              ProjectOwnerBootstrapChallengeRecord['claimedSubject']
            >['type'],
            id: row.claimed_subject_id!,
          },
        }),
  });
}

function rowToBinding(
  row: BootstrapBindingRow,
): Readonly<ProjectRoleBindingRecord> {
  return normalizeProjectRoleBindingRecord({
    projectId: row.project_id,
    subject: {
      type: row.subject_type as ProjectRoleBindingRecord['subject']['type'],
      id: row.subject_id,
    },
    version: Number(row.version),
    state: row.state as ProjectRoleBindingRecord['state'],
    ...(row.role === null
      ? {}
      : { role: row.role as NonNullable<ProjectRoleBindingRecord['role']> }),
    mutationId: row.mutation_id,
    changedBy: {
      type: row.changed_by_type as ProjectRoleBindingRecord['changedBy']['type'],
      id: row.changed_by_id,
    },
    createdAtMs: Number(row.created_at_ms),
  });
}

function digestMatches(expected: string, actual: string): boolean {
  assertProjectOwnerBootstrapTokenDigest(expected);
  assertProjectOwnerBootstrapTokenDigest(actual);
  return timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(actual, 'hex'),
  );
}

function mutationId(challengeId: string): string {
  return `owner-bootstrap:${challengeId}`;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  for (const candidate of [
    error,
    'original' in error ? error.original : undefined,
    'parent' in error ? error.parent : undefined,
  ]) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      'code' in candidate &&
      typeof candidate.code === 'string'
    ) {
      return candidate.code;
    }
  }
  return undefined;
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2 ** attempt));
}

function isExpectedError(error: unknown): boolean {
  return (
    error instanceof ProjectOwnerBootstrapChallengeActiveError ||
    error instanceof ProjectOwnerBootstrapClaimRejectedError ||
    error instanceof ProjectOwnerBootstrapProjectInactiveError ||
    error instanceof ProjectOwnerBootstrapProjectNotFoundError ||
    error instanceof ProjectOwnerBootstrapProjectNotPristineError ||
    error instanceof ProjectOwnerBootstrapUnavailableError
  );
}

export class LegacySequelizeProjectOwnerBootstrapRepository
  implements ProjectOwnerBootstrapRepository
{
  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Project owner bootstrap repository is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
  }

  async issue(
    rawCommand: IssueProjectOwnerBootstrapChallengeCommand,
  ): Promise<Readonly<ProjectOwnerBootstrapChallengeRecord>> {
    const command = normalizeIssueCommand(rawCommand);
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.database.transaction(
          { type: Transaction.TYPES.IMMEDIATE },
          async (transaction) => {
            await this.assertActiveProject(command.projectId, transaction);
            if ((await this.bindingCount(command.projectId, transaction)) > 0) {
              throw new ProjectOwnerBootstrapProjectNotPristineError();
            }
            const latest = await this.latestChallenge(
              command.projectId,
              transaction,
            );
            if (
              latest?.consumedAtMs !== undefined ||
              (latest && latest.expiresAtMs > command.issuedAtMs)
            ) {
              if (latest?.consumedAtMs !== undefined) {
                throw new ProjectOwnerBootstrapProjectNotPristineError();
              }
              throw new ProjectOwnerBootstrapChallengeActiveError();
            }
            const version = (latest?.version ?? 0) + 1;
            if (version > OWNER_BOOTSTRAP_MAX_VERSION) {
              throw new ProjectOwnerBootstrapUnavailableError();
            }
            await this.database.query(
              `INSERT INTO "${PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE}"
                 (project_id, version, challenge_id, token_digest,
                  issued_at_ms, expires_at_ms, consumed_at_ms,
                  claimed_subject_type, claimed_subject_id)
               VALUES
                 (:projectId, :version, :challengeId, :tokenDigest,
                  :issuedAtMs, :expiresAtMs, NULL, NULL, NULL)`,
              {
                type: QueryTypes.INSERT,
                replacements: { ...command, version },
                transaction,
              },
            );
            return normalizeProjectOwnerBootstrapChallengeRecord({
              ...command,
              version,
            });
          },
        );
      } catch (error) {
        if (isExpectedError(error)) throw error;
        if (
          errorCode(error) === 'SQLITE_BUSY' &&
          attempt < RETRY_ATTEMPTS - 1
        ) {
          await retryDelay(attempt);
          continue;
        }
        if (error instanceof UniqueConstraintError) {
          throw new ProjectOwnerBootstrapUnavailableError();
        }
        throw new ProjectOwnerBootstrapUnavailableError();
      }
    }
    throw new ProjectOwnerBootstrapUnavailableError();
  }

  async claim(
    rawCommand: ClaimProjectOwnerBootstrapChallengeCommand,
  ): Promise<ClaimProjectOwnerBootstrapChallengeResult> {
    const command = normalizeClaimCommand(rawCommand);
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.database.transaction(
          { type: Transaction.TYPES.IMMEDIATE },
          async (transaction) => {
            await this.assertActiveProject(command.projectId, transaction);
            const latest = await this.latestChallenge(
              command.projectId,
              transaction,
            );
            if (
              !latest ||
              latest.challengeId !== command.challengeId ||
              !digestMatches(latest.tokenDigest, command.tokenDigest)
            ) {
              throw new ProjectOwnerBootstrapClaimRejectedError();
            }
            if (latest.consumedAtMs !== undefined) {
              if (
                latest.claimedSubject?.type !== command.subject.type ||
                latest.claimedSubject.id !== command.subject.id
              ) {
                throw new ProjectOwnerBootstrapClaimRejectedError();
              }
              const binding = await this.bootstrapBinding(
                command.projectId,
                latest.challengeId,
                transaction,
              );
              if (
                !binding ||
                binding.subject.type !== command.subject.type ||
                binding.subject.id !== command.subject.id ||
                binding.role !== 'owner' ||
                binding.state !== 'active'
              ) {
                throw new ProjectOwnerBootstrapUnavailableError();
              }
              return { status: 'existing', binding };
            }
            if (
              command.claimedAtMs < latest.issuedAtMs ||
              command.claimedAtMs >= latest.expiresAtMs
            ) {
              throw new ProjectOwnerBootstrapClaimRejectedError();
            }
            if ((await this.bindingCount(command.projectId, transaction)) > 0) {
              throw new ProjectOwnerBootstrapProjectNotPristineError();
            }
            const binding = normalizeProjectRoleBindingRecord({
              projectId: command.projectId,
              subject: command.subject,
              version: 1,
              state: 'active',
              role: 'owner',
              mutationId: mutationId(latest.challengeId),
              changedBy: OWNER_BOOTSTRAP_SYSTEM_SUBJECT,
              createdAtMs: command.claimedAtMs,
            });
            const [, consumedCount] = await this.database.query(
              `UPDATE "${PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE}"
                  SET consumed_at_ms = :claimedAtMs,
                      claimed_subject_type = :subjectType,
                      claimed_subject_id = :subjectId
                WHERE project_id = :projectId
                  AND version = :version
                  AND challenge_id = :challengeId
                  AND consumed_at_ms IS NULL`,
              {
                type: QueryTypes.UPDATE,
                replacements: {
                  projectId: command.projectId,
                  version: latest.version,
                  challengeId: latest.challengeId,
                  claimedAtMs: command.claimedAtMs,
                  subjectType: command.subject.type,
                  subjectId: command.subject.id,
                },
                transaction,
              },
            );
            if (consumedCount !== 1) {
              throw new ProjectOwnerBootstrapUnavailableError();
            }
            await this.database.query(
              `INSERT INTO "${PROJECT_ROLE_BINDING_TABLE}"
                 (project_id, subject_type, subject_id, version, state, role,
                  mutation_id, changed_by_type, changed_by_id, created_at_ms)
               VALUES
                 (:projectId, :subjectType, :subjectId, 1, 'active', 'owner',
                  :mutationId, :changedByType, :changedById, :createdAtMs)`,
              {
                type: QueryTypes.INSERT,
                replacements: {
                  projectId: binding.projectId,
                  subjectType: binding.subject.type,
                  subjectId: binding.subject.id,
                  mutationId: binding.mutationId,
                  changedByType: binding.changedBy.type,
                  changedById: binding.changedBy.id,
                  createdAtMs: binding.createdAtMs,
                },
                transaction,
              },
            );
            return { status: 'claimed', binding };
          },
        );
      } catch (error) {
        if (isExpectedError(error)) throw error;
        if (
          errorCode(error) === 'SQLITE_BUSY' &&
          attempt < RETRY_ATTEMPTS - 1
        ) {
          await retryDelay(attempt);
          continue;
        }
        throw new ProjectOwnerBootstrapUnavailableError();
      }
    }
    throw new ProjectOwnerBootstrapUnavailableError();
  }

  private async assertActiveProject(
    projectId: string,
    transaction: Transaction,
  ): Promise<void> {
    const projects = await this.database.query<ProjectStatusRow>(
      `SELECT status FROM "${PROJECT_TABLE}" WHERE id = :projectId LIMIT 2`,
      {
        type: QueryTypes.SELECT,
        replacements: { projectId },
        transaction,
      },
    );
    if (projects.length === 0) {
      throw new ProjectOwnerBootstrapProjectNotFoundError();
    }
    if (projects.length !== 1 || projects[0].status !== 'active') {
      throw new ProjectOwnerBootstrapProjectInactiveError();
    }
  }

  private async bindingCount(
    projectId: string,
    transaction: Transaction,
  ): Promise<number> {
    const rows = await this.database.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count
         FROM "${PROJECT_ROLE_BINDING_TABLE}"
        WHERE project_id = :projectId`,
      {
        type: QueryTypes.SELECT,
        replacements: { projectId },
        transaction,
      },
    );
    const count = Number(rows[0]?.count);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new ProjectOwnerBootstrapUnavailableError();
    }
    return count;
  }

  private async latestChallenge(
    projectId: string,
    transaction: Transaction,
  ): Promise<Readonly<ProjectOwnerBootstrapChallengeRecord> | null> {
    const rows = await this.database.query<BootstrapChallengeRow>(
      `SELECT project_id, version, challenge_id, token_digest,
              issued_at_ms, expires_at_ms, consumed_at_ms,
              claimed_subject_type, claimed_subject_id
         FROM "${PROJECT_OWNER_BOOTSTRAP_CHALLENGE_TABLE}"
        WHERE project_id = :projectId
        ORDER BY version DESC
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { projectId },
        transaction,
      },
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new ProjectOwnerBootstrapUnavailableError();
    return rowToChallenge(rows[0]);
  }

  private async bootstrapBinding(
    projectId: string,
    challengeId: string,
    transaction: Transaction,
  ): Promise<Readonly<ProjectRoleBindingRecord> | null> {
    const rows = await this.database.query<BootstrapBindingRow>(
      `SELECT project_id, subject_type, subject_id, version, state, role,
              mutation_id, changed_by_type, changed_by_id, created_at_ms
         FROM "${PROJECT_ROLE_BINDING_TABLE}"
        WHERE project_id = :projectId
          AND mutation_id = :mutationId
        LIMIT 2`,
      {
        type: QueryTypes.SELECT,
        replacements: { projectId, mutationId: mutationId(challengeId) },
        transaction,
      },
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new ProjectOwnerBootstrapUnavailableError();
    return rowToBinding(rows[0]);
  }
}
