import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  createLocalSecretRef,
  normalizeLocalSecretEnvelope,
  type LocalSecretEnvelope,
} from '@qinglong/runtime-core/local-secret';
import {
  normalizeProjectPolicySubject,
  type ProjectPolicyRepository,
} from '@qinglong/runtime-core/project-policy';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';
import {
  createTaskDefinitionRecord,
  normalizeAppendTaskDefinitionRevisionCommand,
  normalizeTaskDefinitionRecord,
  type TaskDefinitionJson,
  type TaskDefinitionRecord,
} from '@qinglong/runtime-core/task-definition';
import {
  BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
  createBuiltInTaskSpecSemanticRegistry,
} from '@qinglong/runtime-core/task-spec-semantic';
import { compileLocalCommandTaskDefinition } from '@qinglong/runtime-core/task-definition-execution-compiler';
import {
  createBuiltInTriggerSpecSemanticRegistry,
  createTriggerRecord,
  normalizeAppendTriggerRevisionCommand,
  normalizeTriggerRecord,
  type TriggerRecord,
} from '@qinglong/runtime-core/trigger';

import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';
import { LocalSqliteDispatchDefinitionStore } from '../../task-definition/dispatchDefinitionStore';
import {
  auditLocalSqliteReadiness,
  type LocalSqliteReadinessEvidence,
} from '../../readiness/readiness';
import { LocalSqliteSecurityAuthorityStore } from '../../security/securityAuthorityStore';
import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '../../storage/config';

const DIGEST = /^[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
type Row = Record<string, unknown>;

export interface LocalSecretConfigApplicationSecret {
  readonly ordinal: number;
  readonly disposition: 'active_binding' | 'disabled_preservation';
  readonly candidateDigest: string;
  readonly sourceSetDigest: string;
  readonly environmentName?: string;
  readonly envelope: Readonly<LocalSecretEnvelope>;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface PublishLocalSecretConfigApplicationCommand {
  readonly mutationId: string;
  readonly projectId: string;
  readonly profile: LocalSqliteProfile;
  readonly secretConfigPlanDigest: string;
  readonly decisionDigest: string;
  readonly candidateSetDigest: string;
  readonly automationAdoptionSetDigest: string;
  readonly subject: Readonly<SecuritySubject>;
  readonly fence: Readonly<SecurityPolicyFence>;
  readonly audit: Readonly<SecurityAuditRecord>;
  readonly secrets: readonly Readonly<LocalSecretConfigApplicationSecret>[];
  readonly appliedAtMs: number;
  readonly confirmExternalAuthority: () => void | Promise<void>;
}

export interface LocalSecretConfigApplicationReceipt {
  readonly schema: 'qinglong/local-secret-config-application-receipt@v1';
  readonly mutationId: string;
  readonly projectId: string;
  readonly profile: LocalSqliteProfile;
  readonly secretConfigPlanDigest: string;
  readonly decisionDigest: string;
  readonly candidateSetDigest: string;
  readonly automationAdoptionSetDigest: string;
  readonly activeBindingCount: number;
  readonly disabledPreservationCount: number;
  readonly taskCount: number;
  readonly triggerCount: number;
  readonly publicationDigest: string;
  readonly auditEventId: string;
  readonly appliedAtMs: number;
  readonly physicalErasureGuaranteed: false;
  readonly receiptDigest: string;
}

export interface LocalSecretConfigApplicationRecord {
  readonly receipt: Readonly<LocalSecretConfigApplicationReceipt>;
}

export class LocalSecretConfigApplicationConflictError extends Error {
  readonly code = 'LOCAL_SECRET_CONFIG_APPLICATION_CONFLICT';
  constructor() {
    super('Local Secret/Config application conflicts with durable state');
    this.name = 'LocalSecretConfigApplicationConflictError';
  }
}

export class LocalSecretConfigApplicationAuthorizationFenceConflictError extends Error {
  readonly code =
    'LOCAL_SECRET_CONFIG_APPLICATION_AUTHORIZATION_FENCE_CONFLICT';
  constructor() {
    super('Local Secret/Config application authorization fence changed');
    this.name = 'LocalSecretConfigApplicationAuthorizationFenceConflictError';
  }
}

export class LocalSecretConfigApplicationUnavailableError extends Error {
  readonly code = 'LOCAL_SECRET_CONFIG_APPLICATION_UNAVAILABLE';
  constructor(readonly cause?: unknown) {
    super('Local Secret/Config application storage is unavailable');
    this.name = 'LocalSecretConfigApplicationUnavailableError';
  }
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string')
    throw new LocalSecretConfigApplicationUnavailableError();
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value))
    throw new LocalSecretConfigApplicationUnavailableError();
  return value as number;
}

function json(row: Row, key: string): unknown {
  try {
    return JSON.parse(text(row, key));
  } catch (error) {
    throw new LocalSecretConfigApplicationUnavailableError(error);
  }
}

function sha256(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function deterministicMutationId(
  batch: string,
  kind: string,
  identity: string,
): string {
  const bytes = createHash('sha256')
    .update('qinglong3.secret-config-application-mutation.v1\0')
    .update(batch)
    .update('\0')
    .update(kind)
    .update('\0')
    .update(identity)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function insertAudit(
  client: DatabaseSync,
  audit: Readonly<SecurityAuditRecord>,
): void {
  client
    .prepare(
      `INSERT INTO "QingLong3SecurityAuditEvents" (
       "event_id", "request_id", "operation_id", "project_id",
       "subject_type", "subject_id", "authentication_id", "outcome",
       "reasons_json", "fence_project_version", "fence_binding_version",
       "occurred_at_ms"
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
}

function taskFromRow(row: Row): TaskDefinitionRecord {
  return normalizeTaskDefinitionRecord({
    projectId: text(row, 'projectId'),
    taskId: text(row, 'taskId'),
    revision: integer(row, 'revision'),
    mutationId: text(row, 'mutationId'),
    name: text(row, 'name'),
    ...(row.description === null
      ? {}
      : { description: text(row, 'description') }),
    kind: text(row, 'kind') as TaskDefinitionRecord['kind'],
    spec: json(row, 'specJson') as TaskDefinitionRecord['spec'],
    labels: json(row, 'labelsJson') as TaskDefinitionRecord['labels'],
    enabled: integer(row, 'enabled') === 1,
    contentDigest: text(row, 'contentDigest'),
    createdAtMs: integer(row, 'createdAtMs'),
    updatedAtMs: integer(row, 'updatedAtMs'),
  });
}

function triggerFromRow(row: Row): TriggerRecord {
  return normalizeTriggerRecord({
    projectId: text(row, 'projectId'),
    triggerId: text(row, 'triggerId'),
    revision: integer(row, 'revision'),
    mutationId: text(row, 'mutationId'),
    taskId: text(row, 'taskId'),
    taskRevision: integer(row, 'taskRevision'),
    taskContentDigest: text(row, 'taskContentDigest'),
    spec: json(row, 'specJson') as TriggerRecord['spec'],
    enabled: integer(row, 'enabled') === 1,
    contentDigest: text(row, 'contentDigest'),
    createdAtMs: integer(row, 'createdAtMs'),
    updatedAtMs: integer(row, 'updatedAtMs'),
  });
}

function normalizeCommand(
  command: Readonly<PublishLocalSecretConfigApplicationCommand>,
) {
  if (
    !command ||
    typeof command !== 'object' ||
    !UUID_V4.test(command.mutationId) ||
    (command.profile !== 'edge' && command.profile !== 'standalone') ||
    ![
      command.secretConfigPlanDigest,
      command.decisionDigest,
      command.candidateSetDigest,
      command.automationAdoptionSetDigest,
    ].every((value) => DIGEST.test(value)) ||
    !Array.isArray(command.secrets) ||
    command.secrets.length < 1 ||
    command.secrets.length > (command.profile === 'edge' ? 384 : 768) ||
    !Number.isSafeInteger(command.appliedAtMs) ||
    command.appliedAtMs < 0 ||
    typeof command.confirmExternalAuthority !== 'function'
  )
    throw new LocalSecretConfigApplicationConflictError();
  const subject = normalizeProjectPolicySubject(command.subject);
  const audit = normalizeSecurityAuditRecord(command.audit);
  if (
    !command.fence ||
    !Number.isSafeInteger(command.fence.projectVersion) ||
    command.fence.projectVersion < 1 ||
    !Number.isSafeInteger(command.fence.bindingVersion) ||
    (command.fence.bindingVersion as number) < 1 ||
    audit.eventId !== command.mutationId ||
    audit.operationId !== 'secret-config.apply' ||
    audit.projectId !== command.projectId ||
    audit.subject?.type !== subject.type ||
    audit.subject.id !== subject.id ||
    audit.outcome !== 'allowed' ||
    audit.fence?.projectVersion !== command.fence.projectVersion ||
    audit.fence.bindingVersion !== command.fence.bindingVersion ||
    audit.occurredAtMs !== command.appliedAtMs
  )
    throw new LocalSecretConfigApplicationConflictError();
  const names = new Set<string>();
  const environmentNames = new Set<string>();
  let activeBindingCount = 0;
  let disabledPreservationCount = 0;
  const secrets = command.secrets.map((entry, index) => {
    const envelope = normalizeLocalSecretEnvelope(entry.envelope);
    const itemAudit = normalizeSecurityAuditRecord(entry.audit);
    const active = entry.disposition === 'active_binding';
    if (
      entry.ordinal !== index + 1 ||
      (!active && entry.disposition !== 'disabled_preservation') ||
      !DIGEST.test(entry.candidateDigest) ||
      !DIGEST.test(entry.sourceSetDigest) ||
      envelope.projectId !== command.projectId ||
      envelope.version !== 1 ||
      envelope.createdAtMs !== command.appliedAtMs ||
      !UUID_V4.test(envelope.mutationId) ||
      names.has(envelope.name) ||
      (active
        ? typeof entry.environmentName !== 'string' ||
          !ENVIRONMENT_NAME.test(entry.environmentName) ||
          entry.environmentName.startsWith('QL3_') ||
          environmentNames.has(entry.environmentName)
        : entry.environmentName !== undefined) ||
      itemAudit.eventId !== envelope.mutationId ||
      itemAudit.operationId !== 'secret.create' ||
      itemAudit.projectId !== command.projectId ||
      itemAudit.subject?.type !== subject.type ||
      itemAudit.subject.id !== subject.id ||
      itemAudit.outcome !== 'allowed' ||
      itemAudit.fence?.projectVersion !== command.fence.projectVersion ||
      itemAudit.fence.bindingVersion !== command.fence.bindingVersion ||
      itemAudit.occurredAtMs !== command.appliedAtMs
    )
      throw new LocalSecretConfigApplicationConflictError();
    names.add(envelope.name);
    if (active) {
      activeBindingCount += 1;
      environmentNames.add(entry.environmentName as string);
    } else disabledPreservationCount += 1;
    const secretRef = createLocalSecretRef({
      projectId: command.projectId,
      name: envelope.name,
      version: 1,
    });
    const semantic = {
      ordinal: entry.ordinal,
      disposition: entry.disposition,
      candidateDigest: entry.candidateDigest,
      sourceSetDigest: entry.sourceSetDigest,
      ...(active ? { environmentName: entry.environmentName } : {}),
      secretName: envelope.name,
      secretVersion: 1,
      secretMutationId: envelope.mutationId,
      secretRef,
    };
    return Object.freeze({
      entry,
      envelope,
      audit: itemAudit,
      secretRef,
      itemDigest: sha256(
        'qinglong3.secret-config-application-secret.v1\0',
        semantic,
      ),
    });
  });
  if (
    activeBindingCount > 256 ||
    disabledPreservationCount > (command.profile === 'edge' ? 128 : 512)
  ) {
    throw new LocalSecretConfigApplicationConflictError();
  }
  return Object.freeze({
    subject,
    audit,
    secrets: Object.freeze(secrets),
    activeBindingCount,
    disabledPreservationCount,
  });
}

function findApplication(
  client: DatabaseSync,
  mutationId: string,
): LocalSecretConfigApplicationRecord | null {
  const row = client
    .prepare(
      `SELECT "receipt_json" AS "receiptJson" FROM "QingLong3SecretConfigApplications" WHERE "mutation_id" = ?`,
    )
    .get(mutationId) as Row | undefined;
  if (!row) return null;
  const receipt = json(
    row,
    'receiptJson',
  ) as LocalSecretConfigApplicationReceipt;
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    !DIGEST.test(receipt.receiptDigest)
  ) {
    throw new LocalSecretConfigApplicationUnavailableError();
  }
  const { receiptDigest, ...payload } = receipt;
  if (
    sha256('qinglong3.secret-config-application-receipt.v1\0', payload) !==
    receiptDigest
  ) {
    throw new LocalSecretConfigApplicationUnavailableError();
  }
  return Object.freeze({ receipt: Object.freeze(receipt) });
}

function sameReplay(
  record: Readonly<LocalSecretConfigApplicationRecord>,
  command: Readonly<PublishLocalSecretConfigApplicationCommand>,
  counts: { activeBindingCount: number; disabledPreservationCount: number },
): boolean {
  const receipt = record.receipt;
  return (
    receipt.mutationId === command.mutationId &&
    receipt.projectId === command.projectId &&
    receipt.profile === command.profile &&
    receipt.secretConfigPlanDigest === command.secretConfigPlanDigest &&
    receipt.decisionDigest === command.decisionDigest &&
    receipt.candidateSetDigest === command.candidateSetDigest &&
    receipt.automationAdoptionSetDigest ===
      command.automationAdoptionSetDigest &&
    receipt.activeBindingCount === counts.activeBindingCount &&
    receipt.disabledPreservationCount === counts.disabledPreservationCount &&
    receipt.appliedAtMs === command.appliedAtMs
  );
}

const TASK_SELECT = `
  head."project_id" AS "projectId", head."task_id" AS "taskId",
  revision."revision" AS "revision", revision."mutation_id" AS "mutationId",
  revision."name" AS "name", revision."description" AS "description",
  revision."kind" AS "kind", revision."spec_json" AS "specJson",
  revision."labels_json" AS "labelsJson", revision."enabled" AS "enabled",
  revision."content_digest" AS "contentDigest",
  head."created_at_ms" AS "createdAtMs", revision."created_at_ms" AS "updatedAtMs"`;

const TRIGGER_SELECT = `
  head."project_id" AS "projectId", head."trigger_id" AS "triggerId",
  revision."revision" AS "revision", revision."mutation_id" AS "mutationId",
  revision."task_id" AS "taskId", revision."task_revision" AS "taskRevision",
  revision."task_content_digest" AS "taskContentDigest",
  revision."spec_json" AS "specJson", revision."enabled" AS "enabled",
  revision."content_digest" AS "contentDigest",
  head."created_at_ms" AS "createdAtMs", revision."created_at_ms" AS "updatedAtMs"`;

export class LocalSqliteSecretConfigApplicationPublisher {
  constructor(private readonly authority: LocalSqliteOperationAuthority) {}

  resolve(
    mutationId: string,
  ): Promise<Readonly<LocalSecretConfigApplicationRecord> | null> {
    if (!UUID_V4.test(mutationId))
      return Promise.reject(new LocalSecretConfigApplicationConflictError());
    return this.authority.enqueue(
      async () => findApplication(this.authority.client, mutationId),
      () => new LocalSecretConfigApplicationUnavailableError(),
    );
  }

  publish(
    command: Readonly<PublishLocalSecretConfigApplicationCommand>,
  ): Promise<
    Readonly<{
      status: 'inserted' | 'existing';
      application: LocalSecretConfigApplicationRecord;
    }>
  > {
    const normalized = normalizeCommand(command);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        let began = false;
        try {
          client.exec('BEGIN IMMEDIATE');
          began = true;
          await command.confirmExternalAuthority();
          const replay = findApplication(client, command.mutationId);
          if (replay) {
            if (!sameReplay(replay, command, normalized))
              throw new LocalSecretConfigApplicationConflictError();
            const secretRows = client
              .prepare(
                `SELECT item."secret_name" AS "secretName", item."secret_mutation_id" AS "secretMutationId", item."item_digest" AS "itemDigest", secret."key_id" AS "keyId", secret."nonce" AS "nonce", secret."ciphertext" AS "ciphertext", secret."auth_tag" AS "authTag" FROM "QingLong3SecretConfigApplicationSecrets" AS item JOIN "QingLong3LocalSecretEnvelopes" AS secret ON secret."project_id" = item."project_id" AND secret."secret_name" = item."secret_name" AND secret."version" = item."secret_version" WHERE item."application_mutation_id" = ? ORDER BY item."ordinal"`,
              )
              .all(command.mutationId) as Row[];
            if (
              secretRows.length !== normalized.secrets.length ||
              secretRows.some((row, index) => {
                const expected = normalized.secrets[index]!;
                return (
                  text(row, 'secretName') !== expected.envelope.name ||
                  text(row, 'secretMutationId') !==
                    expected.envelope.mutationId ||
                  text(row, 'itemDigest') !== expected.itemDigest ||
                  text(row, 'keyId') !== expected.envelope.keyId ||
                  !(row.nonce instanceof Uint8Array) ||
                  Buffer.from(row.nonce).toString('base64url') !==
                    expected.envelope.nonce ||
                  !(row.ciphertext instanceof Uint8Array) ||
                  Buffer.from(row.ciphertext).toString('base64url') !==
                    expected.envelope.ciphertext ||
                  !(row.authTag instanceof Uint8Array) ||
                  Buffer.from(row.authTag).toString('base64url') !==
                    expected.envelope.authTag
                );
              })
            )
              throw new LocalSecretConfigApplicationConflictError();
            const taskCount = integer(
              client
                .prepare(
                  `SELECT count(*) AS "count" FROM "QingLong3SecretConfigApplicationTasks" AS item JOIN "QingLong3TaskDefinitions" AS head ON head."project_id" = item."project_id" AND head."task_id" = item."task_id" JOIN "QingLong3TaskDefinitionRevisions" AS revision ON revision."project_id" = item."project_id" AND revision."task_id" = item."task_id" AND revision."revision" = item."task_revision" WHERE item."application_mutation_id" = ? AND head."current_revision" = item."task_revision" AND revision."mutation_id" = item."task_mutation_id" AND revision."content_digest" = item."task_content_digest"`,
                )
                .get(command.mutationId) as Row,
              'count',
            );
            const triggerCount = integer(
              client
                .prepare(
                  `SELECT count(*) AS "count" FROM "QingLong3SecretConfigApplicationTriggers" AS item JOIN "QingLong3Triggers" AS head ON head."project_id" = item."project_id" AND head."trigger_id" = item."trigger_id" JOIN "QingLong3TriggerRevisions" AS revision ON revision."project_id" = item."project_id" AND revision."trigger_id" = item."trigger_id" AND revision."revision" = item."trigger_revision" JOIN "QingLong3LocalTriggerSchedules" AS schedule ON schedule."project_id" = item."project_id" AND schedule."trigger_id" = item."trigger_id" AND schedule."trigger_revision" = item."trigger_revision" WHERE item."application_mutation_id" = ? AND head."current_revision" = item."trigger_revision" AND revision."mutation_id" = item."trigger_mutation_id" AND revision."content_digest" = item."trigger_content_digest"`,
                )
                .get(command.mutationId) as Row,
              'count',
            );
            if (
              taskCount !== replay.receipt.taskCount ||
              triggerCount !== replay.receipt.triggerCount
            )
              throw new LocalSecretConfigApplicationConflictError();
            await command.confirmExternalAuthority();
            client.exec('COMMIT');
            began = false;
            return Object.freeze({
              status: 'existing' as const,
              application: replay,
            });
          }

          const project = client
            .prepare(
              `SELECT "version", "status" FROM "QingLong3Projects" WHERE "id" = ?`,
            )
            .get(command.projectId) as Row | undefined;
          const binding = client
            .prepare(
              `SELECT "version", "state", "role" FROM "QingLong3ProjectRoleBindings" WHERE "project_id" = ? AND "subject_type" = ? AND "subject_id" = ? ORDER BY "version" DESC LIMIT 1`,
            )
            .get(
              command.projectId,
              normalized.subject.type,
              normalized.subject.id,
            ) as Row | undefined;
          if (
            !project ||
            integer(project, 'version') !== command.fence.projectVersion ||
            text(project, 'status') !== 'active' ||
            !binding ||
            integer(binding, 'version') !== command.fence.bindingVersion ||
            text(binding, 'state') !== 'active' ||
            !['owner', 'admin'].includes(text(binding, 'role'))
          )
            throw new LocalSecretConfigApplicationAuthorizationFenceConflictError();

          for (const secret of normalized.secrets) {
            const occupied = client
              .prepare(
                `SELECT 1 FROM "QingLong3LocalSecretEnvelopes" WHERE "project_id" = ? AND "secret_name" = ? LIMIT 1`,
              )
              .get(command.projectId, secret.envelope.name);
            if (occupied) throw new LocalSecretConfigApplicationConflictError();
            const nonce = Buffer.from(secret.envelope.nonce, 'base64url');
            const ciphertext = Buffer.from(
              secret.envelope.ciphertext,
              'base64url',
            );
            const authTag = Buffer.from(secret.envelope.authTag, 'base64url');
            try {
              client
                .prepare(
                  `INSERT INTO "QingLong3LocalSecretEnvelopes" ("project_id", "secret_name", "version", "mutation_id", "key_id", "algorithm", "nonce", "ciphertext", "auth_tag", "created_at_ms") VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  command.projectId,
                  secret.envelope.name,
                  secret.envelope.mutationId,
                  secret.envelope.keyId,
                  secret.envelope.algorithm,
                  nonce,
                  ciphertext,
                  authTag,
                  secret.envelope.createdAtMs,
                );
            } finally {
              nonce.fill(0);
              ciphertext.fill(0);
              authTag.fill(0);
            }
            insertAudit(client, secret.audit);
            client
              .prepare(
                `INSERT INTO "QingLong3SecretConfigApplicationSecrets" ("application_mutation_id", "ordinal", "project_id", "disposition", "candidate_digest", "source_set_digest", "environment_name", "secret_name", "secret_version", "secret_mutation_id", "secret_ref", "item_digest") VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
              )
              .run(
                command.mutationId,
                secret.entry.ordinal,
                command.projectId,
                secret.entry.disposition,
                secret.entry.candidateDigest,
                secret.entry.sourceSetDigest,
                secret.entry.environmentName ?? null,
                secret.envelope.name,
                secret.envelope.mutationId,
                secret.secretRef,
                secret.itemDigest,
              );
          }

          const activeEnvironment = normalized.secrets
            .filter(({ entry }) => entry.disposition === 'active_binding')
            .map(({ entry, secretRef }) =>
              Object.freeze({
                name: entry.environmentName as string,
                kind: 'secret' as const,
                secretRef,
              }),
            );
          const taskRegistry = createBuiltInTaskSpecSemanticRegistry();
          const dispatch = new LocalSqliteDispatchDefinitionStore(client);
          const publicationHash = createHash('sha256')
            .update('qinglong3.secret-config-application-publication.v1\0')
            .update(command.mutationId);
          for (const item of normalized.secrets)
            publicationHash.update('\0').update(item.itemDigest);
          let taskCount = 0;
          if (activeEnvironment.length > 0) {
            const provenance = client
              .prepare(
                `SELECT p."adoption_mutation_id" AS "adoptionMutationId", p."row_ordinal" AS "rowOrdinal", p."task_id" AS "taskId", p."task_revision" AS "taskRevision", p."task_mutation_id" AS "taskMutationId", p."task_content_digest" AS "taskContentDigest", p."trigger_count" AS "triggerCount" FROM "QingLong3LegacyAdoptionTasks" AS p JOIN "QingLong3LegacyAdoptions" AS a ON a."mutation_id" = p."adoption_mutation_id" AND a."project_id" = p."project_id" WHERE p."project_id" = ? ORDER BY a."created_at_ms", p."adoption_mutation_id", p."row_ordinal"`,
              )
              .iterate(command.projectId) as Iterable<Row>;
            let ordinal = 0;
            for (const proof of provenance) {
              ordinal += 1;
              const taskId = text(proof, 'taskId');
              const ownership = client
                .prepare(
                  `SELECT 1 FROM "QingLong3PluginPackageTaskOwnerships" WHERE "project_id" = ? AND "task_id" = ?`,
                )
                .get(command.projectId, taskId);
              const row = client
                .prepare(
                  `SELECT ${TASK_SELECT} FROM "QingLong3TaskDefinitions" AS head JOIN "QingLong3TaskDefinitionRevisions" AS revision ON revision."project_id" = head."project_id" AND revision."task_id" = head."task_id" AND revision."revision" = head."current_revision" WHERE head."project_id" = ? AND head."task_id" = ?`,
                )
                .get(command.projectId, taskId) as Row | undefined;
              if (!row || ownership)
                throw new LocalSecretConfigApplicationConflictError();
              const previous = taskFromRow(row);
              if (
                previous.revision !== 1 ||
                previous.mutationId !== text(proof, 'taskMutationId') ||
                previous.contentDigest !== text(proof, 'taskContentDigest') ||
                previous.kind !== 'command' ||
                previous.spec.schema !== BUILT_IN_COMMAND_TASK_SPEC_SCHEMA
              )
                throw new LocalSecretConfigApplicationConflictError();
              const config = previous.spec.config as Readonly<
                Record<string, TaskDefinitionJson>
              >;
              const existingEnvironment = Array.isArray(config.environment)
                ? config.environment
                : [];
              const existingNames = new Set(
                existingEnvironment.map(
                  (entry) => (entry as { name?: unknown }).name,
                ),
              );
              if (activeEnvironment.some(({ name }) => existingNames.has(name)))
                throw new LocalSecretConfigApplicationConflictError();
              const spec = {
                schema: previous.spec.schema,
                config: {
                  ...config,
                  environment: [...existingEnvironment, ...activeEnvironment],
                },
              };
              const base = normalizeAppendTaskDefinitionRevisionCommand({
                projectId: command.projectId,
                taskId,
                expectedRevision: 1,
                mutationId: deterministicMutationId(
                  command.mutationId,
                  'task',
                  taskId,
                ),
                name: previous.name,
                ...(previous.description === undefined
                  ? {}
                  : { description: previous.description }),
                kind: previous.kind,
                spec,
                labels: previous.labels,
                enabled: previous.enabled,
                occurredAtMs: command.appliedAtMs,
              });
              const normalizedSpec = taskRegistry.normalize({
                projectId: base.projectId,
                taskId: base.taskId,
                kind: base.kind,
                spec: base.spec,
              });
              const current = createTaskDefinitionRecord(
                { ...base, spec: normalizedSpec },
                previous.createdAtMs,
              );
              client
                .prepare(
                  `INSERT INTO "QingLong3TaskDefinitionRevisions" ("project_id", "task_id", "revision", "mutation_id", "name", "description", "kind", "spec_json", "labels_json", "enabled", "content_digest", "created_at_ms") VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  current.projectId,
                  current.taskId,
                  current.mutationId,
                  current.name,
                  current.description ?? null,
                  current.kind,
                  JSON.stringify(current.spec),
                  JSON.stringify(current.labels),
                  current.enabled ? 1 : 0,
                  current.contentDigest,
                  current.updatedAtMs,
                );
              if (current.enabled)
                dispatch.appendPlan(
                  compileLocalCommandTaskDefinition(current, taskRegistry),
                );
              const updated = client
                .prepare(
                  `UPDATE "QingLong3TaskDefinitions" SET "current_revision" = 2, "updated_at_ms" = ? WHERE "project_id" = ? AND "task_id" = ? AND "current_revision" = 1`,
                )
                .run(current.updatedAtMs, current.projectId, current.taskId);
              if (updated.changes !== 1)
                throw new LocalSecretConfigApplicationConflictError();
              const itemDigest = sha256(
                'qinglong3.secret-config-application-task.v1\0',
                {
                  ordinal,
                  adoptionMutationId: text(proof, 'adoptionMutationId'),
                  rowOrdinal: integer(proof, 'rowOrdinal'),
                  taskId,
                  previousContentDigest: previous.contentDigest,
                  taskMutationId: current.mutationId,
                  taskContentDigest: current.contentDigest,
                },
              );
              publicationHash.update('\0').update(itemDigest);
              client
                .prepare(
                  `INSERT INTO "QingLong3SecretConfigApplicationTasks" ("application_mutation_id", "ordinal", "project_id", "adoption_mutation_id", "adoption_row_ordinal", "task_id", "previous_revision", "previous_content_digest", "task_revision", "task_mutation_id", "task_content_digest", "item_digest") VALUES (?, ?, ?, ?, ?, ?, 1, ?, 2, ?, ?, ?)`,
                )
                .run(
                  command.mutationId,
                  ordinal,
                  command.projectId,
                  text(proof, 'adoptionMutationId'),
                  integer(proof, 'rowOrdinal'),
                  current.taskId,
                  previous.contentDigest,
                  current.mutationId,
                  current.contentDigest,
                  itemDigest,
                );
              taskCount = ordinal;
            }
            if (taskCount < 1)
              throw new LocalSecretConfigApplicationConflictError();
          }

          const triggerRegistry = createBuiltInTriggerSpecSemanticRegistry();
          let triggerCount = 0;
          if (taskCount > 0) {
            const provenance = client
              .prepare(
                `SELECT p."adoption_mutation_id" AS "adoptionMutationId", p."row_ordinal" AS "rowOrdinal", p."trigger_ordinal" AS "triggerOrdinal", p."task_id" AS "taskId", p."trigger_id" AS "triggerId", p."trigger_revision" AS "triggerRevision", p."trigger_mutation_id" AS "triggerMutationId", p."trigger_content_digest" AS "triggerContentDigest" FROM "QingLong3LegacyAdoptionTriggers" AS p JOIN "QingLong3LegacyAdoptions" AS a ON a."mutation_id" = p."adoption_mutation_id" AND a."project_id" = p."project_id" WHERE p."project_id" = ? ORDER BY a."created_at_ms", p."adoption_mutation_id", p."row_ordinal", p."trigger_ordinal"`,
              )
              .iterate(command.projectId) as Iterable<Row>;
            let ordinal = 0;
            for (const proof of provenance) {
              ordinal += 1;
              const triggerId = text(proof, 'triggerId');
              const row = client
                .prepare(
                  `SELECT ${TRIGGER_SELECT} FROM "QingLong3Triggers" AS head JOIN "QingLong3TriggerRevisions" AS revision ON revision."project_id" = head."project_id" AND revision."trigger_id" = head."trigger_id" AND revision."revision" = head."current_revision" WHERE head."project_id" = ? AND head."trigger_id" = ?`,
                )
                .get(command.projectId, triggerId) as Row | undefined;
              const taskRow = client
                .prepare(
                  `SELECT ${TASK_SELECT} FROM "QingLong3SecretConfigApplicationTasks" AS item JOIN "QingLong3TaskDefinitions" AS head ON head."project_id" = item."project_id" AND head."task_id" = item."task_id" JOIN "QingLong3TaskDefinitionRevisions" AS revision ON revision."project_id" = item."project_id" AND revision."task_id" = item."task_id" AND revision."revision" = item."task_revision" WHERE item."application_mutation_id" = ? AND item."project_id" = ? AND item."task_id" = ? AND head."current_revision" = item."task_revision"`,
                )
                .get(
                  command.mutationId,
                  command.projectId,
                  text(proof, 'taskId'),
                ) as Row | undefined;
              if (!row || !taskRow)
                throw new LocalSecretConfigApplicationConflictError();
              const task = taskFromRow(taskRow);
              const previous = triggerFromRow(row);
              if (
                previous.revision !== 1 ||
                previous.mutationId !== text(proof, 'triggerMutationId') ||
                previous.contentDigest !== text(proof, 'triggerContentDigest')
              )
                throw new LocalSecretConfigApplicationConflictError();
              const base = normalizeAppendTriggerRevisionCommand({
                projectId: command.projectId,
                triggerId,
                expectedRevision: 1,
                mutationId: deterministicMutationId(
                  command.mutationId,
                  'trigger',
                  triggerId,
                ),
                taskId: task.taskId,
                taskRevision: task.revision,
                taskContentDigest: task.contentDigest,
                spec: previous.spec,
                enabled: previous.enabled,
                occurredAtMs: command.appliedAtMs,
              });
              const spec = triggerRegistry.normalize({
                projectId: base.projectId,
                triggerId: base.triggerId,
                taskId: base.taskId,
                taskRevision: base.taskRevision,
                spec: base.spec,
              });
              const current = createTriggerRecord(
                { ...base, spec },
                previous.createdAtMs,
              );
              client
                .prepare(
                  `INSERT INTO "QingLong3TriggerRevisions" ("project_id", "trigger_id", "revision", "mutation_id", "task_id", "task_revision", "task_content_digest", "spec_json", "enabled", "content_digest", "created_at_ms") VALUES (?, ?, 2, ?, ?, 2, ?, ?, ?, ?, ?)`,
                )
                .run(
                  current.projectId,
                  current.triggerId,
                  current.mutationId,
                  current.taskId,
                  current.taskContentDigest,
                  JSON.stringify(current.spec),
                  current.enabled ? 1 : 0,
                  current.contentDigest,
                  current.updatedAtMs,
                );
              const updated = client
                .prepare(
                  `UPDATE "QingLong3Triggers" SET "current_revision" = 2, "updated_at_ms" = ? WHERE "project_id" = ? AND "trigger_id" = ? AND "current_revision" = 1 AND "task_id" = ?`,
                )
                .run(
                  current.updatedAtMs,
                  current.projectId,
                  current.triggerId,
                  current.taskId,
                );
              if (updated.changes !== 1)
                throw new LocalSecretConfigApplicationConflictError();
              client
                .prepare(
                  `INSERT INTO "QingLong3LocalTriggerSchedules" ("project_id", "trigger_id", "trigger_revision", "next_fire_at_ms", "last_scheduled_at_ms", "state_version", "updated_at_ms") VALUES (?, ?, 2, NULL, NULL, 0, ?) ON CONFLICT ("project_id", "trigger_id") DO UPDATE SET "trigger_revision" = 2, "next_fire_at_ms" = NULL, "last_scheduled_at_ms" = NULL, "state_version" = "QingLong3LocalTriggerSchedules"."state_version" + 1, "updated_at_ms" = excluded."updated_at_ms"`,
                )
                .run(current.projectId, current.triggerId, current.updatedAtMs);
              const itemDigest = sha256(
                'qinglong3.secret-config-application-trigger.v1\0',
                {
                  ordinal,
                  adoptionMutationId: text(proof, 'adoptionMutationId'),
                  rowOrdinal: integer(proof, 'rowOrdinal'),
                  triggerOrdinal: integer(proof, 'triggerOrdinal'),
                  triggerId,
                  previousContentDigest: previous.contentDigest,
                  triggerMutationId: current.mutationId,
                  triggerContentDigest: current.contentDigest,
                },
              );
              publicationHash.update('\0').update(itemDigest);
              client
                .prepare(
                  `INSERT INTO "QingLong3SecretConfigApplicationTriggers" ("application_mutation_id", "ordinal", "project_id", "adoption_mutation_id", "adoption_row_ordinal", "adoption_trigger_ordinal", "task_id", "task_revision", "trigger_id", "previous_revision", "previous_content_digest", "trigger_revision", "trigger_mutation_id", "trigger_content_digest", "item_digest") VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?, 1, ?, 2, ?, ?, ?)`,
                )
                .run(
                  command.mutationId,
                  ordinal,
                  command.projectId,
                  text(proof, 'adoptionMutationId'),
                  integer(proof, 'rowOrdinal'),
                  integer(proof, 'triggerOrdinal'),
                  current.taskId,
                  current.triggerId,
                  previous.contentDigest,
                  current.mutationId,
                  current.contentDigest,
                  itemDigest,
                );
              triggerCount = ordinal;
            }
            const missing = client
              .prepare(
                `SELECT 1 FROM "QingLong3SecretConfigApplicationTasks" AS item JOIN "QingLong3LegacyAdoptionTasks" AS proof ON proof."adoption_mutation_id" = item."adoption_mutation_id" AND proof."row_ordinal" = item."adoption_row_ordinal" WHERE item."application_mutation_id" = ? AND proof."trigger_count" <> (SELECT count(*) FROM "QingLong3LegacyAdoptionTriggers" AS trigger WHERE trigger."adoption_mutation_id" = proof."adoption_mutation_id" AND trigger."row_ordinal" = proof."row_ordinal") LIMIT 1`,
              )
              .get(command.mutationId);
            if (missing) throw new LocalSecretConfigApplicationConflictError();
          }

          const publicationDigest = publicationHash.digest('hex');
          const payload = {
            schema:
              'qinglong/local-secret-config-application-receipt@v1' as const,
            mutationId: command.mutationId,
            projectId: command.projectId,
            profile: command.profile,
            secretConfigPlanDigest: command.secretConfigPlanDigest,
            decisionDigest: command.decisionDigest,
            candidateSetDigest: command.candidateSetDigest,
            automationAdoptionSetDigest: command.automationAdoptionSetDigest,
            activeBindingCount: normalized.activeBindingCount,
            disabledPreservationCount: normalized.disabledPreservationCount,
            taskCount,
            triggerCount,
            publicationDigest,
            auditEventId: command.audit.eventId,
            appliedAtMs: command.appliedAtMs,
            physicalErasureGuaranteed: false as const,
          };
          const receipt = Object.freeze({
            ...payload,
            receiptDigest: sha256(
              'qinglong3.secret-config-application-receipt.v1\0',
              payload,
            ),
          });
          insertAudit(client, normalized.audit);
          client
            .prepare(
              `INSERT INTO "QingLong3SecretConfigApplications" ("mutation_id", "project_id", "profile", "secret_config_plan_digest", "decision_digest", "candidate_set_digest", "automation_adoption_set_digest", "active_binding_count", "disabled_preservation_count", "task_count", "trigger_count", "publication_digest", "audit_event_id", "applied_at_ms", "receipt_digest", "receipt_json") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              command.mutationId,
              command.projectId,
              command.profile,
              command.secretConfigPlanDigest,
              command.decisionDigest,
              command.candidateSetDigest,
              command.automationAdoptionSetDigest,
              normalized.activeBindingCount,
              normalized.disabledPreservationCount,
              taskCount,
              triggerCount,
              publicationDigest,
              command.audit.eventId,
              command.appliedAtMs,
              receipt.receiptDigest,
              JSON.stringify(receipt),
            );
          await command.confirmExternalAuthority();
          const stored = findApplication(client, command.mutationId);
          if (!stored || !sameReplay(stored, command, normalized))
            throw new LocalSecretConfigApplicationUnavailableError();
          client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'inserted' as const,
            application: stored,
          });
        } catch (error) {
          if (began && client.isTransaction)
            try {
              client.exec('ROLLBACK');
            } catch {
              /* preserve original */
            }
          if (
            error instanceof LocalSecretConfigApplicationConflictError ||
            error instanceof
              LocalSecretConfigApplicationAuthorizationFenceConflictError ||
            error instanceof LocalSecretConfigApplicationUnavailableError
          )
            throw error;
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            typeof error.code === 'string' &&
            error.code.startsWith('SQLITE_CONSTRAINT')
          )
            throw new LocalSecretConfigApplicationConflictError();
          throw new LocalSecretConfigApplicationUnavailableError(error);
        }
      },
      () => new LocalSecretConfigApplicationUnavailableError(),
    );
  }
}

export interface LocalSqliteSecretConfigApplicationDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly projectPolicy: ProjectPolicyRepository;
  readonly securityAudit: SecurityAuditSink;
  readonly publisher: LocalSqliteSecretConfigApplicationPublisher;
  close(): Promise<void>;
}

export async function openLocalSqliteSecretConfigApplicationDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteSecretConfigApplicationDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    const security = new LocalSqliteSecurityAuthorityStore(authority);
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      projectPolicy: Object.freeze({
        resolve: (...args: Parameters<ProjectPolicyRepository['resolve']>) =>
          security.resolve(...args),
        append: (...args: Parameters<ProjectPolicyRepository['append']>) =>
          security.append(...args),
      }),
      securityAudit: security,
      publisher: new LocalSqliteSecretConfigApplicationPublisher(authority),
      close() {
        if (!closePromise) closePromise = authority.close();
        return closePromise;
      },
    });
  } catch (error) {
    if (client.isOpen) client.close();
    throw error;
  }
}
