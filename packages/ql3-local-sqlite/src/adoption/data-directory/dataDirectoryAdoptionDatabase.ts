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

import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';
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

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VALUE_FILE_PATTERN = /^secret-values\/[0-9a-f]{64}\.json$/;

export interface LocalDataDirectoryAppliedModel {
  readonly schema: 'qinglong/legacy-data-directory-applied-model@v1';
  readonly activation: 'disabled';
  readonly config: Readonly<Record<string, unknown>>;
  readonly keyv: Readonly<Record<string, unknown>>;
  readonly ssh: Readonly<Record<string, unknown>>;
  readonly manualReview: Readonly<Record<string, unknown>>;
}

export interface LocalDataDirectoryAdoptionSecretPublication {
  readonly ordinal: number;
  readonly kind: 'environment' | 'ssh_private_key';
  readonly sourceNameDigest: string;
  readonly valueFile: string;
  readonly valueDigest: string;
  readonly envelope: Readonly<LocalSecretEnvelope>;
  readonly secretRef: string;
  readonly itemDigest: string;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface LocalDataDirectoryAdoptionSecretRecord {
  readonly ordinal: number;
  readonly kind: 'environment' | 'ssh_private_key';
  readonly sourceNameDigest: string;
  readonly secretName: string;
  readonly secretVersion: 1;
  readonly secretMutationId: string;
  readonly valueFile: string;
  readonly valueDigest: string;
  readonly secretRef: string;
  readonly itemDigest: string;
}

export interface LocalDataDirectoryAdoptionReceiptPayload {
  readonly schema: 'qinglong/legacy-data-directory-adoption-receipt@v1';
  readonly mutationId: string;
  readonly projectId: string;
  readonly profile: LocalSqliteProfile;
  readonly sourceStageManifestDigest: string;
  readonly transformationDigest: string;
  readonly modelDigest: string;
  readonly secretCount: number;
  readonly environmentSecretCount: number;
  readonly sshSecretCount: number;
  readonly items: readonly Readonly<{
    ordinal: number;
    kind: LocalDataDirectoryAdoptionSecretRecord['kind'];
    sourceNameDigest: string;
    secretRef: string;
    valueFile: string;
    valueDigest: string;
    itemDigest: string;
  }>[];
  readonly publicationDigest: string;
  readonly auditEventId: string;
  readonly committedAtMs: number;
}

export interface LocalDataDirectoryAdoptionReceipt
  extends LocalDataDirectoryAdoptionReceiptPayload {
  readonly receiptDigest: string;
}

export interface LocalDataDirectoryAdoptionRecord {
  readonly mutationId: string;
  readonly projectId: string;
  readonly profile: LocalSqliteProfile;
  readonly sourceStageManifestDigest: string;
  readonly transformationDigest: string;
  readonly modelDigest: string;
  readonly model: Readonly<LocalDataDirectoryAppliedModel>;
  readonly publicationDigest: string;
  readonly auditEventId: string;
  readonly committedAtMs: number;
  readonly receiptDigest: string;
  readonly receipt: Readonly<LocalDataDirectoryAdoptionReceipt>;
  readonly secrets: readonly Readonly<LocalDataDirectoryAdoptionSecretRecord>[];
}

export interface PublishLocalDataDirectoryAdoptionCommand {
  readonly mutationId: string;
  readonly projectId: string;
  readonly profile: LocalSqliteProfile;
  readonly sourceStageManifestDigest: string;
  readonly transformationDigest: string;
  readonly modelDigest: string;
  readonly model: Readonly<LocalDataDirectoryAppliedModel>;
  readonly subject: Readonly<SecuritySubject>;
  readonly fence: Readonly<SecurityPolicyFence>;
  readonly audit: Readonly<SecurityAuditRecord>;
  readonly secrets: readonly Readonly<LocalDataDirectoryAdoptionSecretPublication>[];
  readonly receipt: Readonly<LocalDataDirectoryAdoptionReceipt>;
  readonly confirmExternalAuthority: () => void | Promise<void>;
}

export interface PublishLocalDataDirectoryAdoptionResult {
  readonly status: 'inserted' | 'existing';
  readonly adoption: Readonly<LocalDataDirectoryAdoptionRecord>;
}

export class LocalDataDirectoryAdoptionConflictError extends Error {
  readonly code = 'LOCAL_DATA_DIRECTORY_ADOPTION_CONFLICT';

  constructor() {
    super('Local data directory adoption conflicts with durable state');
    this.name = 'LocalDataDirectoryAdoptionConflictError';
  }
}

export class LocalDataDirectoryAdoptionAuthorizationFenceConflictError extends Error {
  readonly code = 'LOCAL_DATA_DIRECTORY_ADOPTION_AUTHORIZATION_FENCE_CONFLICT';

  constructor() {
    super('Local data directory adoption authorization fence changed');
    this.name = 'LocalDataDirectoryAdoptionAuthorizationFenceConflictError';
  }
}

export class LocalDataDirectoryAdoptionUnavailableError extends Error {
  readonly code = 'LOCAL_DATA_DIRECTORY_ADOPTION_UNAVAILABLE';

  constructor(readonly cause?: unknown) {
    super('Local data directory adoption storage is unavailable');
    this.name = 'LocalDataDirectoryAdoptionUnavailableError';
  }
}

type Row = Record<string, unknown>;

function sha256(domain: string, value: string): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new LocalDataDirectoryAdoptionUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) {
    throw new LocalDataDirectoryAdoptionUnavailableError();
  }
  return value as number;
}

function json(row: Row, key: string): unknown {
  try {
    return JSON.parse(text(row, key));
  } catch (error) {
    throw new LocalDataDirectoryAdoptionUnavailableError(error);
  }
}

function assertModel(
  value: unknown,
): asserts value is LocalDataDirectoryAppliedModel {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'activation',
      'config',
      'keyv',
      'manualReview',
      'schema',
      'ssh',
    ])
  ) {
    throw new LocalDataDirectoryAdoptionConflictError();
  }
  const model = value as Record<string, unknown>;
  const entries = [model.config, model.keyv, model.ssh, model.manualReview];
  if (
    model.schema !== 'qinglong/legacy-data-directory-applied-model@v1' ||
    model.activation !== 'disabled' ||
    entries.some(
      (entry) => !entry || typeof entry !== 'object' || Array.isArray(entry),
    ) ||
    (model.config as Row).schema !==
      'qinglong/legacy-config-transformation@v1' ||
    (model.config as Row).activation !== 'disabled' ||
    (model.keyv as Row).schema !== 'qinglong/legacy-keyv-transformation@v1' ||
    (model.keyv as Row).activation !== 'disabled' ||
    (model.ssh as Row).schema !== 'qinglong/legacy-ssh-transformation@v1' ||
    (model.ssh as Row).activation !== 'disabled' ||
    (model.manualReview as Row).schema !==
      'qinglong/legacy-data-directory-manual-review@v1' ||
    (model.manualReview as Row).required !== false ||
    (model.manualReview as Row).activation !== 'disabled' ||
    Buffer.byteLength(JSON.stringify(value), 'utf8') > 1024 * 1024
  ) {
    throw new LocalDataDirectoryAdoptionConflictError();
  }
}

function itemSemantic(
  item: Omit<LocalDataDirectoryAdoptionSecretRecord, 'itemDigest'>,
): string {
  return JSON.stringify(item);
}

export function createLocalDataDirectorySourceNameDigest(
  kind: LocalDataDirectoryAdoptionSecretRecord['kind'],
  sourceName: string,
): string {
  if (
    (kind !== 'environment' && kind !== 'ssh_private_key') ||
    typeof sourceName !== 'string' ||
    sourceName.length < 1 ||
    sourceName.includes('\0')
  ) {
    throw new LocalDataDirectoryAdoptionConflictError();
  }
  return createHash('sha256')
    .update('qinglong3.legacy-data-directory-source-name.v1\0')
    .update(kind)
    .update('\0')
    .update(sourceName)
    .digest('hex');
}

export function createLocalDataDirectoryAdoptionSecretItem(options: {
  readonly projectId: string;
  readonly ordinal: number;
  readonly kind: LocalDataDirectoryAdoptionSecretRecord['kind'];
  readonly sourceNameDigest: string;
  readonly secretName: string;
  readonly secretMutationId: string;
  readonly valueFile: string;
  readonly valueDigest: string;
}): Readonly<LocalDataDirectoryAdoptionSecretRecord> {
  return createSecretRecord(options);
}

function createSecretRecord(options: {
  readonly projectId: string;
  readonly ordinal: number;
  readonly kind: LocalDataDirectoryAdoptionSecretRecord['kind'];
  readonly sourceNameDigest: string;
  readonly secretName: string;
  readonly secretMutationId: string;
  readonly valueFile: string;
  readonly valueDigest: string;
}): Readonly<LocalDataDirectoryAdoptionSecretRecord> {
  const secretRef = createLocalSecretRef({
    projectId: options.projectId,
    name: options.secretName,
    version: 1,
  });
  const semantic = Object.freeze({
    ordinal: options.ordinal,
    kind: options.kind,
    sourceNameDigest: options.sourceNameDigest,
    secretName: options.secretName,
    secretVersion: 1 as const,
    secretMutationId: options.secretMutationId,
    valueFile: options.valueFile,
    valueDigest: options.valueDigest,
    secretRef,
  });
  return Object.freeze({
    ...semantic,
    itemDigest: sha256(
      'qinglong3.legacy-data-directory-adoption-secret-item.v1\0',
      itemSemantic(semantic),
    ),
  });
}

function publicationDigest(options: {
  readonly mutationId: string;
  readonly projectId: string;
  readonly sourceStageManifestDigest: string;
  readonly transformationDigest: string;
  readonly modelDigest: string;
  readonly secrets: readonly Readonly<LocalDataDirectoryAdoptionSecretRecord>[];
}): string {
  const hash = createHash('sha256')
    .update('qinglong3.legacy-data-directory-adoption-publication.v1\0')
    .update(options.mutationId)
    .update('\0')
    .update(options.projectId)
    .update('\0')
    .update(options.sourceStageManifestDigest)
    .update('\0')
    .update(options.transformationDigest)
    .update('\0')
    .update(options.modelDigest);
  for (const item of options.secrets) hash.update('\0').update(item.itemDigest);
  return hash.digest('hex');
}

export function createLocalDataDirectoryAdoptionReceipt(options: {
  readonly mutationId: string;
  readonly projectId: string;
  readonly profile: LocalSqliteProfile;
  readonly sourceStageManifestDigest: string;
  readonly transformationDigest: string;
  readonly modelDigest: string;
  readonly secrets: readonly Readonly<LocalDataDirectoryAdoptionSecretRecord>[];
  readonly committedAtMs: number;
}): Readonly<LocalDataDirectoryAdoptionReceipt> {
  const environmentSecretCount = options.secrets.filter(
    ({ kind }) => kind === 'environment',
  ).length;
  const sshSecretCount = options.secrets.length - environmentSecretCount;
  const publication = publicationDigest(options);
  const payload: LocalDataDirectoryAdoptionReceiptPayload = {
    schema: 'qinglong/legacy-data-directory-adoption-receipt@v1',
    mutationId: options.mutationId,
    projectId: options.projectId,
    profile: options.profile,
    sourceStageManifestDigest: options.sourceStageManifestDigest,
    transformationDigest: options.transformationDigest,
    modelDigest: options.modelDigest,
    secretCount: options.secrets.length,
    environmentSecretCount,
    sshSecretCount,
    items: Object.freeze(
      options.secrets.map(
        ({
          ordinal,
          kind,
          sourceNameDigest,
          secretRef,
          valueFile,
          valueDigest,
          itemDigest,
        }) =>
          Object.freeze({
            ordinal,
            kind,
            sourceNameDigest,
            secretRef,
            valueFile,
            valueDigest,
            itemDigest,
          }),
      ),
    ),
    publicationDigest: publication,
    auditEventId: options.mutationId,
    committedAtMs: options.committedAtMs,
  };
  return Object.freeze({
    ...payload,
    receiptDigest: sha256(
      'qinglong3.legacy-data-directory-adoption-receipt.v1\0',
      JSON.stringify(payload),
    ),
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseRecord(
  client: DatabaseSync,
  row: Row,
): LocalDataDirectoryAdoptionRecord {
  const profile = text(row, 'profile');
  if (profile !== 'edge' && profile !== 'standalone') {
    throw new LocalDataDirectoryAdoptionUnavailableError();
  }
  const mutationId = text(row, 'mutationId');
  const projectId = text(row, 'projectId');
  const model = json(row, 'modelJson');
  assertModel(model);
  const itemRows = client
    .prepare(
      `SELECT item."ordinal" AS "ordinal", item."kind" AS "kind",
              item."source_name_digest" AS "sourceNameDigest",
              item."secret_name" AS "secretName",
              item."secret_version" AS "secretVersion",
              item."secret_mutation_id" AS "secretMutationId",
              item."value_file" AS "valueFile",
              item."value_digest" AS "valueDigest",
              item."secret_ref" AS "secretRef",
              item."item_digest" AS "itemDigest"
         FROM "QingLong3LegacyDataDirectoryAdoptionSecrets" AS item
         JOIN "QingLong3LocalSecretEnvelopes" AS secret
           ON secret."project_id" = item."project_id"
          AND secret."secret_name" = item."secret_name"
          AND secret."version" = item."secret_version"
          AND secret."mutation_id" = item."secret_mutation_id"
         JOIN "QingLong3SecurityAuditEvents" AS audit
           ON audit."event_id" = item."secret_mutation_id"
          AND audit."project_id" = item."project_id"
          AND audit."operation_id" = 'secret.create'
          AND audit."outcome" = 'allowed'
        WHERE item."adoption_mutation_id" = ?
        ORDER BY item."ordinal"`,
    )
    .all(mutationId) as Row[];
  const secrets = Object.freeze(
    itemRows.map((item, index) => {
      const kind = text(item, 'kind');
      const candidate = createSecretRecord({
        projectId,
        ordinal: integer(item, 'ordinal'),
        kind:
          kind === 'environment' || kind === 'ssh_private_key'
            ? kind
            : (() => {
                throw new LocalDataDirectoryAdoptionUnavailableError();
              })(),
        sourceNameDigest: text(item, 'sourceNameDigest'),
        secretName: text(item, 'secretName'),
        secretMutationId: text(item, 'secretMutationId'),
        valueFile: text(item, 'valueFile'),
        valueDigest: text(item, 'valueDigest'),
      });
      if (
        candidate.ordinal !== index + 1 ||
        candidate.secretVersion !== integer(item, 'secretVersion') ||
        candidate.secretRef !== text(item, 'secretRef') ||
        candidate.itemDigest !== text(item, 'itemDigest')
      ) {
        throw new LocalDataDirectoryAdoptionUnavailableError();
      }
      return candidate;
    }),
  );
  const sourceStageManifestDigest = text(row, 'sourceStageManifestDigest');
  const transformationDigest = text(row, 'transformationDigest');
  const modelDigest = text(row, 'modelDigest');
  const committedAtMs = integer(row, 'committedAtMs');
  const receipt = createLocalDataDirectoryAdoptionReceipt({
    mutationId,
    projectId,
    profile,
    sourceStageManifestDigest,
    transformationDigest,
    modelDigest,
    secrets,
    committedAtMs,
  });
  const storedReceipt = json(row, 'receiptJson');
  if (
    secrets.length !== integer(row, 'secretCount') ||
    receipt.environmentSecretCount !== integer(row, 'environmentSecretCount') ||
    receipt.sshSecretCount !== integer(row, 'sshSecretCount') ||
    receipt.publicationDigest !== text(row, 'publicationDigest') ||
    receipt.auditEventId !== text(row, 'auditEventId') ||
    receipt.receiptDigest !== text(row, 'receiptDigest') ||
    !sameJson(receipt, storedReceipt)
  ) {
    throw new LocalDataDirectoryAdoptionUnavailableError();
  }
  return Object.freeze({
    mutationId,
    projectId,
    profile,
    sourceStageManifestDigest,
    transformationDigest,
    modelDigest,
    model,
    publicationDigest: receipt.publicationDigest,
    auditEventId: receipt.auditEventId,
    committedAtMs,
    receiptDigest: receipt.receiptDigest,
    receipt,
    secrets,
  });
}

const RECORD_SELECT = `
  adoption."mutation_id" AS "mutationId",
  adoption."project_id" AS "projectId",
  adoption."profile" AS "profile",
  adoption."source_stage_manifest_digest" AS "sourceStageManifestDigest",
  adoption."transformation_digest" AS "transformationDigest",
  adoption."model_digest" AS "modelDigest",
  adoption."secret_count" AS "secretCount",
  adoption."environment_secret_count" AS "environmentSecretCount",
  adoption."ssh_secret_count" AS "sshSecretCount",
  adoption."model_json" AS "modelJson",
  adoption."publication_digest" AS "publicationDigest",
  adoption."audit_event_id" AS "auditEventId",
  adoption."committed_at_ms" AS "committedAtMs",
  adoption."receipt_digest" AS "receiptDigest",
  adoption."receipt_json" AS "receiptJson"`;

function findRecord(
  client: DatabaseSync,
  mutationId: string,
  transformationDigest?: string,
): LocalDataDirectoryAdoptionRecord | null {
  const rows = transformationDigest
    ? (client
        .prepare(
          `SELECT ${RECORD_SELECT}
             FROM "QingLong3LegacyDataDirectoryAdoptions" AS adoption
             JOIN "QingLong3SecurityAuditEvents" AS audit
               ON audit."event_id" = adoption."audit_event_id"
              AND audit."project_id" = adoption."project_id"
              AND audit."operation_id" = 'legacy-data.apply'
              AND audit."outcome" = 'allowed'
            WHERE adoption."mutation_id" = ?
               OR adoption."transformation_digest" = ?
            LIMIT 2`,
        )
        .all(mutationId, transformationDigest) as Row[])
    : (client
        .prepare(
          `SELECT ${RECORD_SELECT}
             FROM "QingLong3LegacyDataDirectoryAdoptions" AS adoption
             JOIN "QingLong3SecurityAuditEvents" AS audit
               ON audit."event_id" = adoption."audit_event_id"
              AND audit."project_id" = adoption."project_id"
              AND audit."operation_id" = 'legacy-data.apply'
              AND audit."outcome" = 'allowed'
            WHERE adoption."mutation_id" = ?
            LIMIT 2`,
        )
        .all(mutationId) as Row[]);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new LocalDataDirectoryAdoptionConflictError();
  return parseRecord(client, rows[0]!);
}

function insertAudit(client: DatabaseSync, audit: SecurityAuditRecord): void {
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

function assertCommand(command: PublishLocalDataDirectoryAdoptionCommand): {
  readonly subject: Readonly<SecuritySubject>;
  readonly audit: Readonly<SecurityAuditRecord>;
  readonly secrets: readonly Readonly<{
    publication: LocalDataDirectoryAdoptionSecretPublication;
    record: LocalDataDirectoryAdoptionSecretRecord;
    envelope: LocalSecretEnvelope;
    audit: SecurityAuditRecord;
  }>[];
} {
  if (
    !command ||
    typeof command !== 'object' ||
    !UUID_V4_PATTERN.test(command.mutationId) ||
    (command.profile !== 'edge' && command.profile !== 'standalone') ||
    ![
      command.sourceStageManifestDigest,
      command.transformationDigest,
      command.modelDigest,
    ].every((value) => DIGEST_PATTERN.test(value)) ||
    !Array.isArray(command.secrets) ||
    command.secrets.length > (command.profile === 'edge' ? 128 : 512) ||
    typeof command.confirmExternalAuthority !== 'function'
  ) {
    throw new LocalDataDirectoryAdoptionConflictError();
  }
  assertModel(command.model);
  const subject = normalizeProjectPolicySubject(command.subject);
  const audit = normalizeSecurityAuditRecord(command.audit);
  if (
    !command.fence ||
    !safeInteger(command.fence.projectVersion, 1) ||
    !safeInteger(command.fence.bindingVersion, 1) ||
    audit.eventId !== command.mutationId ||
    audit.operationId !== 'legacy-data.apply' ||
    audit.projectId !== command.projectId ||
    audit.subject?.type !== subject.type ||
    audit.subject.id !== subject.id ||
    audit.outcome !== 'allowed' ||
    audit.fence?.projectVersion !== command.fence.projectVersion ||
    audit.fence.bindingVersion !== command.fence.bindingVersion ||
    audit.occurredAtMs !== command.receipt.committedAtMs
  ) {
    throw new LocalDataDirectoryAdoptionConflictError();
  }
  const names = new Set<string>();
  const mutations = new Set<string>([command.mutationId]);
  const secrets = command.secrets.map((publication, index) => {
    const envelope = normalizeLocalSecretEnvelope(publication.envelope);
    const itemAudit = normalizeSecurityAuditRecord(publication.audit);
    const record = createSecretRecord({
      projectId: command.projectId,
      ordinal: publication.ordinal,
      kind: publication.kind,
      sourceNameDigest: publication.sourceNameDigest,
      secretName: envelope.name,
      secretMutationId: envelope.mutationId,
      valueFile: publication.valueFile,
      valueDigest: publication.valueDigest,
    });
    if (
      publication.ordinal !== index + 1 ||
      envelope.projectId !== command.projectId ||
      envelope.version !== 1 ||
      !UUID_V4_PATTERN.test(envelope.mutationId) ||
      names.has(envelope.name) ||
      mutations.has(envelope.mutationId) ||
      !DIGEST_PATTERN.test(publication.sourceNameDigest) ||
      !DIGEST_PATTERN.test(publication.valueDigest) ||
      !VALUE_FILE_PATTERN.test(publication.valueFile) ||
      publication.secretRef !== record.secretRef ||
      publication.itemDigest !== record.itemDigest ||
      itemAudit.eventId !== envelope.mutationId ||
      itemAudit.operationId !== 'secret.create' ||
      itemAudit.projectId !== command.projectId ||
      itemAudit.subject?.type !== subject.type ||
      itemAudit.subject.id !== subject.id ||
      itemAudit.outcome !== 'allowed' ||
      itemAudit.fence?.projectVersion !== command.fence.projectVersion ||
      itemAudit.fence.bindingVersion !== command.fence.bindingVersion ||
      itemAudit.occurredAtMs !== command.receipt.committedAtMs
    ) {
      throw new LocalDataDirectoryAdoptionConflictError();
    }
    names.add(envelope.name);
    mutations.add(envelope.mutationId);
    return Object.freeze({ publication, record, envelope, audit: itemAudit });
  });
  const expectedReceipt = createLocalDataDirectoryAdoptionReceipt({
    mutationId: command.mutationId,
    projectId: command.projectId,
    profile: command.profile,
    sourceStageManifestDigest: command.sourceStageManifestDigest,
    transformationDigest: command.transformationDigest,
    modelDigest: command.modelDigest,
    secrets: secrets.map(({ record }) => record),
    committedAtMs: command.receipt.committedAtMs,
  });
  if (!sameJson(expectedReceipt, command.receipt)) {
    throw new LocalDataDirectoryAdoptionConflictError();
  }
  return Object.freeze({ subject, audit, secrets: Object.freeze(secrets) });
}

function exactReplay(
  existing: Readonly<LocalDataDirectoryAdoptionRecord>,
  command: Readonly<PublishLocalDataDirectoryAdoptionCommand>,
): boolean {
  return (
    existing.mutationId === command.mutationId &&
    existing.projectId === command.projectId &&
    existing.profile === command.profile &&
    existing.sourceStageManifestDigest === command.sourceStageManifestDigest &&
    existing.transformationDigest === command.transformationDigest &&
    existing.modelDigest === command.modelDigest &&
    sameJson(existing.model, command.model) &&
    sameJson(existing.receipt, command.receipt)
  );
}

export class LocalSqliteDataDirectoryAdoptionPublisher {
  constructor(private readonly authority: LocalSqliteOperationAuthority) {}

  resolve(
    mutationId: string,
  ): Promise<Readonly<LocalDataDirectoryAdoptionRecord> | null> {
    if (!UUID_V4_PATTERN.test(mutationId)) {
      return Promise.reject(new LocalDataDirectoryAdoptionConflictError());
    }
    return this.authority.enqueue(
      async () => findRecord(this.authority.client, mutationId),
      () => new LocalDataDirectoryAdoptionUnavailableError(),
    );
  }

  publish(
    command: Readonly<PublishLocalDataDirectoryAdoptionCommand>,
  ): Promise<PublishLocalDataDirectoryAdoptionResult> {
    const normalized = assertCommand(command);
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        let began = false;
        try {
          client.exec('BEGIN IMMEDIATE');
          began = true;
          const replay = findRecord(
            client,
            command.mutationId,
            command.transformationDigest,
          );
          if (replay) {
            if (!exactReplay(replay, command)) {
              throw new LocalDataDirectoryAdoptionConflictError();
            }
            await command.confirmExternalAuthority();
            client.exec('COMMIT');
            began = false;
            return Object.freeze({
              status: 'existing' as const,
              adoption: replay,
            });
          }

          const project = client
            .prepare(
              `SELECT "version", "status" FROM "QingLong3Projects"
               WHERE "id" = ? LIMIT 1`,
            )
            .get(command.projectId) as Row | undefined;
          if (
            !project ||
            integer(project, 'version') !== command.fence.projectVersion ||
            text(project, 'status') !== 'active'
          ) {
            throw new LocalDataDirectoryAdoptionAuthorizationFenceConflictError();
          }
          const binding = client
            .prepare(
              `SELECT "version", "state", "role"
                 FROM "QingLong3ProjectRoleBindings"
                WHERE "project_id" = ? AND "subject_type" = ? AND "subject_id" = ?
                ORDER BY "version" DESC LIMIT 1`,
            )
            .get(
              command.projectId,
              normalized.subject.type,
              normalized.subject.id,
            ) as Row | undefined;
          if (
            !binding ||
            integer(binding, 'version') !== command.fence.bindingVersion ||
            text(binding, 'state') !== 'active' ||
            !['owner', 'admin'].includes(text(binding, 'role'))
          ) {
            throw new LocalDataDirectoryAdoptionAuthorizationFenceConflictError();
          }

          for (const { envelope, audit } of normalized.secrets) {
            const current = client
              .prepare(
                `SELECT MAX("version") AS "version"
                   FROM "QingLong3LocalSecretEnvelopes"
                  WHERE "project_id" = ? AND "secret_name" = ?`,
              )
              .get(envelope.projectId, envelope.name) as Row;
            if (current.version !== null) {
              throw new LocalDataDirectoryAdoptionConflictError();
            }
            const nonce = Buffer.from(envelope.nonce, 'base64url');
            const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
            const authTag = Buffer.from(envelope.authTag, 'base64url');
            try {
              client
                .prepare(
                  `INSERT INTO "QingLong3LocalSecretEnvelopes" (
                     "project_id", "secret_name", "version", "mutation_id",
                     "key_id", "algorithm", "nonce", "ciphertext", "auth_tag",
                     "created_at_ms"
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  envelope.projectId,
                  envelope.name,
                  envelope.version,
                  envelope.mutationId,
                  envelope.keyId,
                  envelope.algorithm,
                  nonce,
                  ciphertext,
                  authTag,
                  envelope.createdAtMs,
                );
            } finally {
              nonce.fill(0);
              ciphertext.fill(0);
              authTag.fill(0);
            }
            insertAudit(client, audit);
          }
          insertAudit(client, normalized.audit);
          client
            .prepare(
              `INSERT INTO "QingLong3LegacyDataDirectoryAdoptions" (
                 "mutation_id", "project_id", "profile",
                 "source_stage_manifest_digest", "transformation_digest",
                 "model_digest", "secret_count", "environment_secret_count",
                 "ssh_secret_count", "model_json", "publication_digest",
                 "audit_event_id", "committed_at_ms", "receipt_digest",
                 "receipt_json"
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              command.mutationId,
              command.projectId,
              command.profile,
              command.sourceStageManifestDigest,
              command.transformationDigest,
              command.modelDigest,
              command.receipt.secretCount,
              command.receipt.environmentSecretCount,
              command.receipt.sshSecretCount,
              JSON.stringify(command.model),
              command.receipt.publicationDigest,
              command.mutationId,
              command.receipt.committedAtMs,
              command.receipt.receiptDigest,
              JSON.stringify(command.receipt),
            );
          for (const { record } of normalized.secrets) {
            client
              .prepare(
                `INSERT INTO "QingLong3LegacyDataDirectoryAdoptionSecrets" (
                   "adoption_mutation_id", "ordinal", "project_id", "kind",
                   "source_name_digest", "secret_name", "secret_version",
                   "secret_mutation_id", "value_file", "value_digest",
                   "secret_ref", "item_digest"
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                command.mutationId,
                record.ordinal,
                command.projectId,
                record.kind,
                record.sourceNameDigest,
                record.secretName,
                record.secretVersion,
                record.secretMutationId,
                record.valueFile,
                record.valueDigest,
                record.secretRef,
                record.itemDigest,
              );
          }
          const stored = findRecord(client, command.mutationId);
          if (!stored || !exactReplay(stored, command)) {
            throw new LocalDataDirectoryAdoptionUnavailableError();
          }
          await command.confirmExternalAuthority();
          client.exec('COMMIT');
          began = false;
          return Object.freeze({
            status: 'inserted' as const,
            adoption: stored,
          });
        } catch (error) {
          if (began && client.isTransaction) {
            try {
              client.exec('ROLLBACK');
            } catch {
              // Preserve the original failure.
            }
          }
          if (
            error instanceof LocalDataDirectoryAdoptionConflictError ||
            error instanceof
              LocalDataDirectoryAdoptionAuthorizationFenceConflictError ||
            error instanceof LocalDataDirectoryAdoptionUnavailableError
          ) {
            throw error;
          }
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            typeof error.code === 'string' &&
            error.code.startsWith('SQLITE_CONSTRAINT')
          ) {
            throw new LocalDataDirectoryAdoptionConflictError();
          }
          throw new LocalDataDirectoryAdoptionUnavailableError(error);
        }
      },
      () => new LocalDataDirectoryAdoptionUnavailableError(),
    );
  }
}

export interface LocalSqliteDataDirectoryAdoptionDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly projectPolicy: ProjectPolicyRepository;
  readonly securityAudit: SecurityAuditSink;
  readonly publisher: LocalSqliteDataDirectoryAdoptionPublisher;
  close(): Promise<void>;
}

/** Short-lived data-directory adoption authority; runtime hosts must not import it. */
export async function openLocalSqliteDataDirectoryAdoptionDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteDataDirectoryAdoptionDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    const securityAuthority = new LocalSqliteSecurityAuthorityStore(authority);
    const projectPolicy: ProjectPolicyRepository = Object.freeze({
      resolve: (
        ...[projectId, subject]: Parameters<ProjectPolicyRepository['resolve']>
      ) => securityAuthority.resolve(projectId, subject),
      append: (...[command]: Parameters<ProjectPolicyRepository['append']>) =>
        securityAuthority.append(command),
    });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      projectPolicy,
      securityAudit: securityAuthority,
      publisher: new LocalSqliteDataDirectoryAdoptionPublisher(authority),
      close() {
        if (closePromise) return closePromise;
        closePromise = authority.close();
        return closePromise;
      },
    });
  } catch (error) {
    if (client.isOpen) client.close();
    throw error;
  }
}
