import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import {
  visitLegacyEnvironmentAdoption,
  type LegacyEnvironmentCandidate,
  type LegacyEnvironmentInventory,
  type LegacyEnvironmentRowInspection,
} from '@qinglong/local-admin/reconciliation-secret-and-config-inspection';
import {
  LegacyAdoptionPublicationDigest,
  legacyAdoptionTaskProvenanceDigest,
  legacyAdoptionTriggerProvenanceDigest,
} from '@qinglong/local-sqlite/adoption-provenance';

import { LocalDeploymentConfigurationError } from '../../../foundation/error';
import { cutoverDigest } from '../../../cutover/targetEvidence';

const HEADER_KIND = 'qinglong3-local-reconciliation-secret-config-plan-header';
const ROW_KIND = 'qinglong3-local-reconciliation-secret-config-plan-row';
const CANDIDATE_KIND =
  'qinglong3-local-reconciliation-secret-config-plan-candidate';
const FOOTER_KIND = 'qinglong3-local-reconciliation-secret-config-plan-footer';
const RECEIPT_SCHEMA =
  'qinglong3-local-reconciliation-secret-config-plan-receipt';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_LINE_BYTES = 64 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;
const MAX_EDGE_AUTOMATION_ADOPTION_RECORDS = 128;
const MAX_STANDALONE_AUTOMATION_ADOPTION_RECORDS = 512;
const MAX_AUTOMATION_ADOPTION_TASKS = 100_000;
const MAX_AUTOMATION_ADOPTION_TRIGGERS = 500_000;
export const MAX_EDGE_LOCAL_RECONCILIATION_SECRET_CONFIG_PLAN_BYTES =
  8 * 1024 * 1024;
export const MAX_STANDALONE_LOCAL_RECONCILIATION_SECRET_CONFIG_PLAN_BYTES =
  32 * 1024 * 1024;

export interface LocalReconciliationSecretConfigPlanHeader {
  readonly schemaVersion: 1;
  readonly kind: typeof HEADER_KIND;
  readonly secretConfigId: string;
  readonly applicationId: string;
  readonly applicationPlanDigest: string;
  readonly reviewDigest: string;
  readonly reviewAuthorizationDigest: string;
  readonly reviewDecisionSetDigest: string;
  readonly reviewDecisionFileDigest: string;
  readonly bundleDigest: string;
  readonly bundleFingerprintDigest: string;
  readonly profile: 'edge' | 'standalone';
  readonly projectId: string;
  readonly tableDisposition: 'absent' | 'manual_external';
  readonly unadaptedLegacyConfigCount: number;
  readonly preparedHeadDigest: string;
  readonly preparedAtMs: number;
  readonly headerDigest: string;
}

export interface LocalReconciliationSecretConfigPlanRow {
  readonly schemaVersion: 1;
  readonly kind: typeof ROW_KIND;
  readonly rowOrdinal: number;
  readonly sourceDigest: string;
  readonly disposition: LegacyEnvironmentRowInspection['disposition'];
  readonly reasons: LegacyEnvironmentRowInspection['reasons'];
  readonly rowPlanDigest: string;
}

export type LocalReconciliationSecretConfigCandidateRequirement =
  | 'review_apply_binding'
  | 'review_preserve_disabled'
  | 'review_skip_conflict';

export type LocalReconciliationSecretConfigTarget =
  | Readonly<{ state: 'absent' }>
  | Readonly<{
      state: 'occupied';
      version: number;
      contentDigest: string;
    }>;

export interface LocalReconciliationSecretConfigPlanCandidate {
  readonly schemaVersion: 1;
  readonly kind: typeof CANDIDATE_KIND;
  readonly candidateOrdinal: number;
  readonly candidateType: LegacyEnvironmentCandidate['kind'];
  readonly candidateDigest: string;
  readonly sourceRowCount: number;
  readonly sourceSetDigest: string;
  readonly proposedSecretName: string;
  readonly target: LocalReconciliationSecretConfigTarget;
  readonly requirement: LocalReconciliationSecretConfigCandidateRequirement;
  readonly candidatePlanDigest: string;
}

export interface LocalReconciliationSecretConfigPlanSummary {
  readonly tableState: LegacyEnvironmentInventory['tableState'];
  readonly rowCount: number;
  readonly activeRowCount: number;
  readonly disabledRowCount: number;
  readonly manualRowCount: number;
  readonly activeGroupCount: number;
  readonly bindingReadyCount: number;
  readonly preservationReadyCount: number;
  readonly manualGroupCount: number;
  readonly eligibleBindingCount: number;
  readonly eligiblePreservationCount: number;
  readonly targetConflictCount: number;
  readonly automationAdoptionRecordCount: number;
  readonly adoptedLegacyTaskCount: number;
  readonly adoptedLegacyTriggerCount: number;
  readonly adoptionProvenanceTaskCount: number;
  readonly adoptionProvenanceTriggerCount: number;
  readonly automationAdoptionProvenanceState:
    | 'complete'
    | 'missing'
    | 'drifted';
  readonly unadaptedLegacyConfigCount: number;
  readonly outcome: 'ready' | 'manual_required' | 'no_effect';
}

export interface LocalReconciliationSecretConfigPlanFooter
  extends LocalReconciliationSecretConfigPlanSummary {
  readonly schemaVersion: 1;
  readonly kind: typeof FOOTER_KIND;
  readonly secretConfigId: string;
  readonly legacyInventoryDigest: string;
  readonly rowSetDigest: string;
  readonly candidateSetDigest: string;
  readonly automationAdoptionSetDigest: string;
  readonly secretConfigPlanDigest: string;
}

export interface LocalReconciliationSecretConfigPlanReceipt
  extends LocalReconciliationSecretConfigPlanSummary {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_secret_config_planned';
  readonly secretConfigId: string;
  readonly applicationId: string;
  readonly applicationPlanDigest: string;
  readonly preparedHeadDigest: string;
  readonly legacyInventoryDigest: string;
  readonly rowSetDigest: string;
  readonly candidateSetDigest: string;
  readonly automationAdoptionSetDigest: string;
  readonly secretConfigPlanDigest: string;
  readonly planFileBytes: number;
  readonly planFileDigest: string;
  readonly preparedAtMs: number;
  readonly receiptDigest: string;
}

export interface WriteLocalReconciliationSecretConfigPlanOptions {
  readonly descriptor: number;
  readonly maxBytes: number;
  readonly header: Omit<
    LocalReconciliationSecretConfigPlanHeader,
    'headerDigest'
  >;
  readonly legacy: DatabaseSync;
  readonly target: DatabaseSync;
}

function fail(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation secret config row plan ${message}`,
    { cause },
  );
}

function exact(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} shape is invalid`);
  }
  return record;
}

function line(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (bytes.byteLength < 3 || bytes.byteLength > MAX_LINE_BYTES + 1) {
    bytes.fill(0);
    fail('record exceeds its line bound');
  }
  return bytes;
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = fs.writeSync(
      descriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
    );
    if (written < 1) fail('write stalled');
    offset += written;
  }
}

function bytesDigest(value: unknown, length: number, label: string): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    fail(`target ${label} is invalid`);
  }
  return createHash('sha256').update(value).digest('hex');
}

function adoptionText(
  row: Readonly<Record<string, unknown>>,
  key: string,
  pattern?: RegExp,
): string {
  const value = row[key];
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    fail(`target Automation adoption ${key} drifted`);
  }
  return value;
}

function adoptionCount(
  row: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
): number {
  const value = row[key];
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    fail(`target Automation adoption ${key} drifted`);
  }
  return value as number;
}

function targetAutomationAdoptionProjection(
  target: DatabaseSync,
  projectId: string,
  profile: 'edge' | 'standalone',
): Readonly<{
  recordCount: number;
  adoptedTaskCount: number;
  adoptedTriggerCount: number;
  provenanceTaskCount: number;
  provenanceTriggerCount: number;
  provenanceState: 'complete' | 'missing' | 'drifted';
  setDigest: string;
}> {
  const maximumRecords =
    profile === 'edge'
      ? MAX_EDGE_AUTOMATION_ADOPTION_RECORDS
      : MAX_STANDALONE_AUTOMATION_ADOPTION_RECORDS;
  const hash = createHash('sha256').update(
    'qinglong3.local-reconciliation-secret-config-automation-adoption-set.v1\0',
  );
  const records = new Map<
    string,
    {
      readonly expectedTaskCount: number;
      readonly expectedTriggerCount: number;
      readonly expectedPublicationDigest: string;
      readonly publication: LegacyAdoptionPublicationDigest;
      taskCount: number;
      triggerCount: number;
    }
  >();
  let recordCount = 0;
  let adoptedTaskCount = 0;
  let adoptedTriggerCount = 0;
  let provenanceTaskCount = 0;
  let provenanceTriggerCount = 0;
  let drifted = false;
  try {
    const rows = target
      .prepare(
        `SELECT "mutation_id" AS "mutationId",
                "decision_id" AS "decisionId",
                "plan_digest" AS "planDigest",
                "inventory_digest" AS "inventoryDigest",
                "decision_digest" AS "decisionDigest",
                "receipt_digest" AS "receiptDigest",
                "authorization_file_digest" AS "authorizationFileDigest",
                "publication_digest" AS "publicationDigest",
                "row_count" AS "rowCount",
                "adopted_task_count" AS "adoptedTaskCount",
                "adopted_trigger_count" AS "adoptedTriggerCount",
                "skipped_count" AS "skippedCount",
                "audit_event_id" AS "auditEventId",
                "created_at_ms" AS "createdAtMs"
         FROM "QingLong3LegacyAdoptions"
         WHERE "project_id" = ?
         ORDER BY "created_at_ms" ASC, "mutation_id" ASC`,
      )
      .iterate(projectId) as Iterable<Readonly<Record<string, unknown>>>;
    for (const row of rows) {
      recordCount += 1;
      if (recordCount > maximumRecords) {
        fail('target Automation adoption projection exceeds profile budget');
      }
      const rowCount = adoptionCount(row, 'rowCount', 100_000);
      const selectedAdoptedTaskCount = adoptionCount(
        row,
        'adoptedTaskCount',
        rowCount,
      );
      const skippedCount = adoptionCount(row, 'skippedCount', rowCount);
      if (selectedAdoptedTaskCount + skippedCount !== rowCount) {
        fail('target Automation adoption row accounting drifted');
      }
      adoptedTaskCount += selectedAdoptedTaskCount;
      if (!Number.isSafeInteger(adoptedTaskCount)) {
        fail('target Automation adoption task count overflowed');
      }
      const selectedAdoptedTriggerCount = adoptionCount(
        row,
        'adoptedTriggerCount',
        500_000,
      );
      adoptedTriggerCount += selectedAdoptedTriggerCount;
      if (!Number.isSafeInteger(adoptedTriggerCount)) {
        fail('target Automation adoption trigger count overflowed');
      }
      const payload = Object.freeze({
        mutationId: adoptionText(row, 'mutationId', UUID_V4_PATTERN),
        decisionId: adoptionText(
          row,
          'decisionId',
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        planDigest: adoptionText(row, 'planDigest', DIGEST_PATTERN),
        inventoryDigest: adoptionText(
          row,
          'inventoryDigest',
          DIGEST_PATTERN,
        ),
        decisionDigest: adoptionText(row, 'decisionDigest', DIGEST_PATTERN),
        receiptDigest: adoptionText(row, 'receiptDigest', DIGEST_PATTERN),
        authorizationFileDigest: adoptionText(
          row,
          'authorizationFileDigest',
          DIGEST_PATTERN,
        ),
        publicationDigest: adoptionText(
          row,
          'publicationDigest',
          DIGEST_PATTERN,
        ),
        rowCount,
        adoptedTaskCount: selectedAdoptedTaskCount,
        adoptedTriggerCount: selectedAdoptedTriggerCount,
        skippedCount,
        auditEventId: adoptionText(row, 'auditEventId', UUID_V4_PATTERN),
        createdAtMs: adoptionCount(
          row,
          'createdAtMs',
          Number.MAX_SAFE_INTEGER,
        ),
      });
      if (payload.auditEventId !== payload.mutationId) {
        fail('target Automation adoption audit binding drifted');
      }
      if (records.has(payload.mutationId)) {
        fail('target Automation adoption identity is duplicated');
      }
      records.set(payload.mutationId, {
        expectedTaskCount: selectedAdoptedTaskCount,
        expectedTriggerCount: selectedAdoptedTriggerCount,
        expectedPublicationDigest: payload.publicationDigest,
        publication: new LegacyAdoptionPublicationDigest(payload.mutationId),
        taskCount: 0,
        triggerCount: 0,
      });
      hash.update('\0').update(JSON.stringify(payload));
    }

    const tasks = target
      .prepare(
        `SELECT provenance."adoption_mutation_id" AS "adoptionMutationId",
                provenance."row_ordinal" AS "rowOrdinal",
                provenance."project_id" AS "projectId",
                provenance."source_digest" AS "sourceDigest",
                provenance."task_id" AS "taskId",
                provenance."task_revision" AS "taskRevision",
                provenance."task_mutation_id" AS "taskMutationId",
                provenance."task_content_digest" AS "taskContentDigest",
                provenance."trigger_count" AS "triggerCount",
                provenance."item_digest" AS "itemDigest",
                head."current_revision" AS "currentRevision",
                revision."mutation_id" AS "storedMutationId",
                revision."content_digest" AS "storedContentDigest",
                ownership."package_name" AS "packageName"
         FROM "QingLong3LegacyAdoptionTasks" AS provenance
         JOIN "QingLong3LegacyAdoptions" AS adoption
           ON adoption."mutation_id" = provenance."adoption_mutation_id"
          AND adoption."project_id" = provenance."project_id"
         LEFT JOIN "QingLong3TaskDefinitions" AS head
           ON head."project_id" = provenance."project_id"
          AND head."task_id" = provenance."task_id"
         LEFT JOIN "QingLong3TaskDefinitionRevisions" AS revision
           ON revision."project_id" = provenance."project_id"
          AND revision."task_id" = provenance."task_id"
          AND revision."revision" = provenance."task_revision"
         LEFT JOIN "QingLong3PluginPackageTaskOwnerships" AS ownership
           ON ownership."project_id" = provenance."project_id"
          AND ownership."task_id" = provenance."task_id"
         WHERE adoption."project_id" = ?
         ORDER BY adoption."created_at_ms" ASC,
                  adoption."mutation_id" ASC,
                  provenance."row_ordinal" ASC`,
      )
      .iterate(projectId) as Iterable<Readonly<Record<string, unknown>>>;
    for (const row of tasks) {
      provenanceTaskCount += 1;
      if (provenanceTaskCount > MAX_AUTOMATION_ADOPTION_TASKS) {
        fail('target Automation adoption Task provenance exceeds budget');
      }
      const adoptionMutationId = adoptionText(
        row,
        'adoptionMutationId',
        UUID_V4_PATTERN,
      );
      const selected = records.get(adoptionMutationId);
      const rowOrdinal = adoptionCount(
        row,
        'rowOrdinal',
        MAX_AUTOMATION_ADOPTION_TASKS,
      );
      const triggerCount = adoptionCount(
        row,
        'triggerCount',
        MAX_AUTOMATION_ADOPTION_TRIGGERS,
      );
      const payload = Object.freeze({
        adoptionMutationId,
        rowOrdinal,
        projectId: adoptionText(row, 'projectId'),
        sourceDigest: adoptionText(row, 'sourceDigest', DIGEST_PATTERN),
        taskId: adoptionText(row, 'taskId'),
        taskRevision: adoptionCount(row, 'taskRevision', 1),
        taskMutationId: adoptionText(row, 'taskMutationId', UUID_V4_PATTERN),
        taskContentDigest: adoptionText(
          row,
          'taskContentDigest',
          DIGEST_PATTERN,
        ),
        triggerCount,
      });
      const itemDigest = adoptionText(row, 'itemDigest', DIGEST_PATTERN);
      selected && (selected.taskCount += 1);
      const currentState = Object.freeze({
        currentRevision: row.currentRevision,
        storedMutationId: row.storedMutationId,
        storedContentDigest: row.storedContentDigest,
        pluginOwned: row.packageName !== null,
      });
      if (
        !selected ||
        payload.projectId !== projectId ||
        payload.rowOrdinal < 1 ||
        payload.taskRevision !== 1 ||
        legacyAdoptionTaskProvenanceDigest(payload) !== itemDigest ||
        currentState.currentRevision !== payload.taskRevision ||
        currentState.storedMutationId !== payload.taskMutationId ||
        currentState.storedContentDigest !== payload.taskContentDigest ||
        currentState.pluginOwned
      ) {
        drifted = true;
      }
      hash.update('\0task\0').update(
        JSON.stringify({
          ...payload,
          itemDigest,
          currentState,
        }),
      );
    }

    const triggers = target
      .prepare(
        `SELECT provenance."adoption_mutation_id" AS "adoptionMutationId",
                provenance."row_ordinal" AS "rowOrdinal",
                provenance."trigger_ordinal" AS "triggerOrdinal",
                provenance."project_id" AS "projectId",
                provenance."task_id" AS "taskId",
                provenance."task_revision" AS "taskRevision",
                provenance."trigger_id" AS "triggerId",
                provenance."trigger_revision" AS "triggerRevision",
                provenance."trigger_mutation_id" AS "triggerMutationId",
                provenance."trigger_content_digest" AS "triggerContentDigest",
                provenance."item_digest" AS "itemDigest",
                head."current_revision" AS "currentRevision",
                revision."mutation_id" AS "storedMutationId",
                revision."content_digest" AS "storedContentDigest",
                schedule."trigger_revision" AS "scheduleRevision"
         FROM "QingLong3LegacyAdoptionTriggers" AS provenance
         JOIN "QingLong3LegacyAdoptions" AS adoption
           ON adoption."mutation_id" = provenance."adoption_mutation_id"
          AND adoption."project_id" = provenance."project_id"
         LEFT JOIN "QingLong3Triggers" AS head
           ON head."project_id" = provenance."project_id"
          AND head."trigger_id" = provenance."trigger_id"
          AND head."task_id" = provenance."task_id"
         LEFT JOIN "QingLong3TriggerRevisions" AS revision
           ON revision."project_id" = provenance."project_id"
          AND revision."trigger_id" = provenance."trigger_id"
          AND revision."revision" = provenance."trigger_revision"
         LEFT JOIN "QingLong3LocalTriggerSchedules" AS schedule
           ON schedule."project_id" = provenance."project_id"
          AND schedule."trigger_id" = provenance."trigger_id"
         WHERE adoption."project_id" = ?
         ORDER BY adoption."created_at_ms" ASC,
                  adoption."mutation_id" ASC,
                  provenance."row_ordinal" ASC,
                  provenance."trigger_ordinal" ASC`,
      )
      .iterate(projectId) as Iterable<Readonly<Record<string, unknown>>>;
    let previousTaskKey = '';
    let previousTriggerOrdinal = 0;
    for (const row of triggers) {
      provenanceTriggerCount += 1;
      if (provenanceTriggerCount > MAX_AUTOMATION_ADOPTION_TRIGGERS) {
        fail('target Automation adoption Trigger provenance exceeds budget');
      }
      const adoptionMutationId = adoptionText(
        row,
        'adoptionMutationId',
        UUID_V4_PATTERN,
      );
      const selected = records.get(adoptionMutationId);
      const rowOrdinal = adoptionCount(
        row,
        'rowOrdinal',
        MAX_AUTOMATION_ADOPTION_TASKS,
      );
      const triggerOrdinal = adoptionCount(
        row,
        'triggerOrdinal',
        MAX_AUTOMATION_ADOPTION_TRIGGERS,
      );
      const taskKey = `${adoptionMutationId}\0${rowOrdinal}`;
      if (taskKey !== previousTaskKey) {
        previousTaskKey = taskKey;
        previousTriggerOrdinal = 0;
      }
      previousTriggerOrdinal += 1;
      const payload = Object.freeze({
        adoptionMutationId,
        rowOrdinal,
        triggerOrdinal,
        projectId: adoptionText(row, 'projectId'),
        taskId: adoptionText(row, 'taskId'),
        taskRevision: adoptionCount(row, 'taskRevision', 1),
        triggerId: adoptionText(row, 'triggerId'),
        triggerRevision: adoptionCount(row, 'triggerRevision', 1),
        triggerMutationId: adoptionText(
          row,
          'triggerMutationId',
          UUID_V4_PATTERN,
        ),
        triggerContentDigest: adoptionText(
          row,
          'triggerContentDigest',
          DIGEST_PATTERN,
        ),
      });
      const itemDigest = adoptionText(row, 'itemDigest', DIGEST_PATTERN);
      selected && (selected.triggerCount += 1);
      const currentState = Object.freeze({
        currentRevision: row.currentRevision,
        storedMutationId: row.storedMutationId,
        storedContentDigest: row.storedContentDigest,
        scheduleRevision: row.scheduleRevision,
      });
      if (
        !selected ||
        payload.projectId !== projectId ||
        payload.rowOrdinal < 1 ||
        payload.triggerOrdinal !== previousTriggerOrdinal ||
        payload.taskRevision !== 1 ||
        payload.triggerRevision !== 1 ||
        legacyAdoptionTriggerProvenanceDigest(payload) !== itemDigest ||
        currentState.currentRevision !== payload.triggerRevision ||
        currentState.storedMutationId !== payload.triggerMutationId ||
        currentState.storedContentDigest !== payload.triggerContentDigest ||
        currentState.scheduleRevision !== payload.triggerRevision
      ) {
        drifted = true;
      }
      hash.update('\0trigger\0').update(
        JSON.stringify({
          ...payload,
          itemDigest,
          currentState,
        }),
      );
    }

    const publicationRows = target
      .prepare(
        `SELECT adoption."mutation_id" AS "adoptionMutationId",
                task."row_ordinal" AS "rowOrdinal",
                task."source_digest" AS "sourceDigest",
                task."task_content_digest" AS "taskContentDigest",
                task."trigger_count" AS "expectedTriggerCount",
                task."item_digest" AS "taskItemDigest",
                trigger."trigger_ordinal" AS "triggerOrdinal",
                trigger."trigger_content_digest" AS "triggerContentDigest",
                trigger."item_digest" AS "triggerItemDigest"
         FROM "QingLong3LegacyAdoptions" AS adoption
         LEFT JOIN "QingLong3LegacyAdoptionTasks" AS task
           ON task."adoption_mutation_id" = adoption."mutation_id"
          AND task."project_id" = adoption."project_id"
         LEFT JOIN "QingLong3LegacyAdoptionTriggers" AS trigger
           ON trigger."adoption_mutation_id" = task."adoption_mutation_id"
          AND trigger."row_ordinal" = task."row_ordinal"
         WHERE adoption."project_id" = ?
         ORDER BY adoption."created_at_ms" ASC,
                  adoption."mutation_id" ASC,
                  task."row_ordinal" ASC,
                  trigger."trigger_ordinal" ASC`,
      )
      .iterate(projectId) as Iterable<Readonly<Record<string, unknown>>>;
    let publicationTaskKey = '';
    let publicationExpectedTriggerCount = 0;
    let publicationTriggerCount = 0;
    for (const row of publicationRows) {
      const adoptionMutationId = adoptionText(
        row,
        'adoptionMutationId',
        UUID_V4_PATTERN,
      );
      const selected = records.get(adoptionMutationId);
      if (!selected) {
        drifted = true;
        continue;
      }
      if (row.rowOrdinal === null) continue;
      const rowOrdinal = adoptionCount(
        row,
        'rowOrdinal',
        MAX_AUTOMATION_ADOPTION_TASKS,
      );
      const taskKey = `${adoptionMutationId}\0${rowOrdinal}`;
      if (taskKey !== publicationTaskKey) {
        if (
          publicationTaskKey !== '' &&
          publicationTriggerCount !== publicationExpectedTriggerCount
        ) {
          drifted = true;
        }
        publicationTaskKey = taskKey;
        publicationTriggerCount = 0;
        publicationExpectedTriggerCount = adoptionCount(
          row,
          'expectedTriggerCount',
          MAX_AUTOMATION_ADOPTION_TRIGGERS,
        );
        selected.publication.appendTask({
          rowOrdinal,
          sourceDigest: adoptionText(row, 'sourceDigest', DIGEST_PATTERN),
          taskContentDigest: adoptionText(
            row,
            'taskContentDigest',
            DIGEST_PATTERN,
          ),
          itemDigest: adoptionText(row, 'taskItemDigest', DIGEST_PATTERN),
        });
      }
      if (row.triggerOrdinal === null) continue;
      publicationTriggerCount += 1;
      if (
        adoptionCount(
          row,
          'triggerOrdinal',
          MAX_AUTOMATION_ADOPTION_TRIGGERS,
        ) !== publicationTriggerCount
      ) {
        drifted = true;
      }
      selected.publication.appendTrigger({
        triggerContentDigest: adoptionText(
          row,
          'triggerContentDigest',
          DIGEST_PATTERN,
        ),
        itemDigest: adoptionText(row, 'triggerItemDigest', DIGEST_PATTERN),
      });
    }
    if (
      publicationTaskKey !== '' &&
      publicationTriggerCount !== publicationExpectedTriggerCount
    ) {
      drifted = true;
    }
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return fail('target Automation adoption projection is unavailable', error);
  }
  const missing = [...records.values()].some(
    (record) =>
      record.taskCount !== record.expectedTaskCount ||
      record.triggerCount !== record.expectedTriggerCount,
  );
  if (!missing) {
    for (const record of records.values()) {
      if (record.publication.digest() !== record.expectedPublicationDigest) {
        drifted = true;
      }
    }
  }
  return Object.freeze({
    recordCount,
    adoptedTaskCount,
    adoptedTriggerCount,
    provenanceTaskCount,
    provenanceTriggerCount,
    provenanceState: drifted
      ? ('drifted' as const)
      : missing
      ? ('missing' as const)
      : ('complete' as const),
    setDigest: hash.digest('hex'),
  });
}

function targetSecret(
  target: DatabaseSync,
  projectId: string,
  secretName: string,
): LocalReconciliationSecretConfigTarget {
  let row: Readonly<Record<string, unknown>> | undefined;
  try {
    row = target
      .prepare(
        `SELECT "version", "mutation_id" AS "mutationId",
                "key_id" AS "keyId", "algorithm", "nonce", "ciphertext",
                "auth_tag" AS "authTag", "created_at_ms" AS "createdAtMs"
         FROM "QingLong3LocalSecretEnvelopes"
         WHERE "project_id" = ? AND "secret_name" = ?
         ORDER BY "version" DESC LIMIT 1`,
      )
      .get(projectId, secretName) as
      | Readonly<Record<string, unknown>>
      | undefined;
  } catch (error) {
    return fail('target Secret projection is unavailable', error);
  }
  if (!row) return Object.freeze({ state: 'absent' as const });
  if (
    !Number.isSafeInteger(row.version) ||
    (row.version as number) < 1 ||
    typeof row.mutationId !== 'string' ||
    row.mutationId.length < 1 ||
    row.mutationId.length > 64 ||
    typeof row.keyId !== 'string' ||
    row.keyId.length < 1 ||
    row.keyId.length > 128 ||
    row.algorithm !== 'aes-256-gcm' ||
    !Number.isSafeInteger(row.createdAtMs) ||
    (row.createdAtMs as number) < 0
  ) {
    fail('target Secret projection drifted');
  }
  if (
    !(row.ciphertext instanceof Uint8Array) ||
    row.ciphertext.byteLength > 16 * 1024
  ) {
    fail('target ciphertext is invalid');
  }
  const contentDigest = cutoverDigest({
    projectId,
    secretName,
    version: row.version,
    mutationId: row.mutationId,
    keyId: row.keyId,
    algorithm: row.algorithm,
    nonceDigest: bytesDigest(row.nonce, 12, 'nonce'),
    ciphertextDigest: bytesDigest(
      row.ciphertext,
      row.ciphertext.byteLength,
      'ciphertext',
    ),
    authTagDigest: bytesDigest(row.authTag, 16, 'auth tag'),
    createdAtMs: row.createdAtMs,
  });
  return Object.freeze({
    state: 'occupied' as const,
    version: row.version as number,
    contentDigest,
  });
}

function secretName(candidate: Readonly<LegacyEnvironmentCandidate>): string {
  const source =
    candidate.kind === 'active_binding'
      ? candidate.environmentName
      : `${candidate.environmentName}\0${candidate.sourceDigest}`;
  const suffix = createHash('sha256').update(source).digest('hex').slice(0, 32);
  return candidate.kind === 'active_binding'
    ? `legacy-db-env-${suffix}`
    : `legacy-db-env-disabled-${suffix}`;
}

function planRow(
  value: Readonly<LegacyEnvironmentRowInspection>,
): Readonly<LocalReconciliationSecretConfigPlanRow> {
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: ROW_KIND,
    rowOrdinal: value.rowOrdinal,
    sourceDigest: value.sourceDigest,
    disposition: value.disposition,
    reasons: value.reasons,
  });
  return Object.freeze({ ...payload, rowPlanDigest: cutoverDigest(payload) });
}

function planCandidate(
  value: Readonly<LegacyEnvironmentCandidate>,
  candidateOrdinal: number,
  target: DatabaseSync,
  projectId: string,
): Readonly<LocalReconciliationSecretConfigPlanCandidate> {
  const proposedSecretName = secretName(value);
  const selectedTarget = targetSecret(target, projectId, proposedSecretName);
  const sourceRowCount =
    value.kind === 'active_binding' ? value.sourceRowCount : 1;
  const sourceSetDigest =
    value.kind === 'active_binding'
      ? value.sourceSetDigest
      : value.sourceDigest;
  const requirement: LocalReconciliationSecretConfigCandidateRequirement =
    selectedTarget.state === 'occupied'
      ? 'review_skip_conflict'
      : value.kind === 'active_binding'
      ? 'review_apply_binding'
      : 'review_preserve_disabled';
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: CANDIDATE_KIND,
    candidateOrdinal,
    candidateType: value.kind,
    candidateDigest: value.candidateDigest,
    sourceRowCount,
    sourceSetDigest,
    proposedSecretName,
    target: selectedTarget,
    requirement,
  });
  return Object.freeze({
    ...payload,
    candidatePlanDigest: cutoverDigest(payload),
  });
}

export function writeLocalReconciliationSecretConfigPlan(
  options: Readonly<WriteLocalReconciliationSecretConfigPlanOptions>,
): Readonly<{
  header: Readonly<LocalReconciliationSecretConfigPlanHeader>;
  footer: Readonly<LocalReconciliationSecretConfigPlanFooter>;
  fileBytes: number;
  fileDigest: string;
}> {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < MAX_LINE_BYTES
  ) {
    fail('byte budget is invalid');
  }
  const header = Object.freeze({
    ...options.header,
    headerDigest: cutoverDigest(options.header),
  });
  const fileHash = createHash('sha256');
  const rowHash = createHash('sha256').update(
    'qinglong3.local-reconciliation-secret-config-row-set.v1\0',
  );
  const candidateHash = createHash('sha256').update(
    'qinglong3.local-reconciliation-secret-config-candidate-set.v1\0',
  );
  let fileBytes = 0;
  const append = (
    value: unknown,
    set: 'none' | 'row' | 'candidate' = 'none',
  ): void => {
    const bytes = line(value);
    try {
      if (fileBytes + bytes.byteLength > options.maxBytes) {
        fail('exceeds profile byte budget');
      }
      writeAll(options.descriptor, bytes);
      fileHash.update(bytes);
      if (set === 'row') rowHash.update(bytes);
      if (set === 'candidate') candidateHash.update(bytes);
      fileBytes += bytes.byteLength;
    } finally {
      bytes.fill(0);
    }
  };
  append(header);
  let candidateOrdinal = 0;
  let eligibleBindingCount = 0;
  let eligiblePreservationCount = 0;
  let targetConflictCount = 0;
  const inventory = visitLegacyEnvironmentAdoption(options.legacy, {
    profile: header.profile,
    visitRow(value) {
      append(planRow(value), 'row');
    },
    visitCandidate(value) {
      candidateOrdinal += 1;
      const candidate = planCandidate(
        value,
        candidateOrdinal,
        options.target,
        header.projectId,
      );
      if (candidate.requirement === 'review_apply_binding') {
        eligibleBindingCount += 1;
      } else if (candidate.requirement === 'review_preserve_disabled') {
        eligiblePreservationCount += 1;
      } else {
        targetConflictCount += 1;
      }
      append(candidate, 'candidate');
    },
  });
  const automationAdoption = targetAutomationAdoptionProjection(
    options.target,
    header.projectId,
    header.profile,
  );
  const summary: LocalReconciliationSecretConfigPlanSummary = Object.freeze({
    tableState: inventory.tableState,
    rowCount: inventory.rowCount,
    activeRowCount: inventory.activeRowCount,
    disabledRowCount: inventory.disabledRowCount,
    manualRowCount: inventory.manualRowCount,
    activeGroupCount: inventory.activeGroupCount,
    bindingReadyCount: inventory.bindingReadyCount,
    preservationReadyCount: inventory.preservationReadyCount,
    manualGroupCount: inventory.manualGroupCount,
    eligibleBindingCount,
    eligiblePreservationCount,
    targetConflictCount,
    automationAdoptionRecordCount: automationAdoption.recordCount,
    adoptedLegacyTaskCount: automationAdoption.adoptedTaskCount,
    adoptedLegacyTriggerCount: automationAdoption.adoptedTriggerCount,
    adoptionProvenanceTaskCount: automationAdoption.provenanceTaskCount,
    adoptionProvenanceTriggerCount: automationAdoption.provenanceTriggerCount,
    automationAdoptionProvenanceState: automationAdoption.provenanceState,
    unadaptedLegacyConfigCount: header.unadaptedLegacyConfigCount,
    outcome:
      (inventory.tableState === 'absent' || inventory.rowCount === 0) &&
      header.unadaptedLegacyConfigCount === 0
        ? ('no_effect' as const)
        : !inventory.mutationReady ||
          targetConflictCount > 0 ||
          header.unadaptedLegacyConfigCount > 0 ||
          automationAdoption.provenanceState !== 'complete' ||
          (eligibleBindingCount > 0 && automationAdoption.adoptedTaskCount < 1)
        ? ('manual_required' as const)
        : ('ready' as const),
  });
  const footerPayload = Object.freeze({
    schemaVersion: 1 as const,
    kind: FOOTER_KIND,
    secretConfigId: header.secretConfigId,
    ...summary,
    legacyInventoryDigest: inventory.inventoryDigest,
    rowSetDigest: rowHash.digest('hex'),
    candidateSetDigest: candidateHash.digest('hex'),
    automationAdoptionSetDigest: automationAdoption.setDigest,
  });
  const footer = Object.freeze({
    ...footerPayload,
    secretConfigPlanDigest: cutoverDigest({
      headerDigest: header.headerDigest,
      ...footerPayload,
    }),
  });
  append(footer);
  return Object.freeze({
    header,
    footer,
    fileBytes,
    fileDigest: fileHash.digest('hex'),
  });
}

export function buildLocalReconciliationSecretConfigPlanReceipt(
  header: Readonly<LocalReconciliationSecretConfigPlanHeader>,
  footer: Readonly<LocalReconciliationSecretConfigPlanFooter>,
  planFileBytes: number,
  planFileDigest: string,
): Readonly<LocalReconciliationSecretConfigPlanReceipt> {
  const payload = Object.freeze({
    schema: RECEIPT_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_secret_config_planned' as const,
    secretConfigId: header.secretConfigId,
    applicationId: header.applicationId,
    applicationPlanDigest: header.applicationPlanDigest,
    preparedHeadDigest: header.preparedHeadDigest,
    legacyInventoryDigest: footer.legacyInventoryDigest,
    rowSetDigest: footer.rowSetDigest,
    candidateSetDigest: footer.candidateSetDigest,
    automationAdoptionSetDigest: footer.automationAdoptionSetDigest,
    secretConfigPlanDigest: footer.secretConfigPlanDigest,
    planFileBytes,
    planFileDigest,
    tableState: footer.tableState,
    rowCount: footer.rowCount,
    activeRowCount: footer.activeRowCount,
    disabledRowCount: footer.disabledRowCount,
    manualRowCount: footer.manualRowCount,
    activeGroupCount: footer.activeGroupCount,
    bindingReadyCount: footer.bindingReadyCount,
    preservationReadyCount: footer.preservationReadyCount,
    manualGroupCount: footer.manualGroupCount,
    eligibleBindingCount: footer.eligibleBindingCount,
    eligiblePreservationCount: footer.eligiblePreservationCount,
    targetConflictCount: footer.targetConflictCount,
    automationAdoptionRecordCount: footer.automationAdoptionRecordCount,
    adoptedLegacyTaskCount: footer.adoptedLegacyTaskCount,
    adoptedLegacyTriggerCount: footer.adoptedLegacyTriggerCount,
    adoptionProvenanceTaskCount: footer.adoptionProvenanceTaskCount,
    adoptionProvenanceTriggerCount: footer.adoptionProvenanceTriggerCount,
    automationAdoptionProvenanceState:
      footer.automationAdoptionProvenanceState,
    unadaptedLegacyConfigCount: footer.unadaptedLegacyConfigCount,
    outcome: footer.outcome,
    preparedAtMs: header.preparedAtMs,
  });
  return Object.freeze({ ...payload, receiptDigest: cutoverDigest(payload) });
}

export function normalizeLocalReconciliationSecretConfigPlanReceipt(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigPlanReceipt> {
  const receipt = exact(
    value,
    [
      'activeGroupCount',
      'activeRowCount',
      'adoptedLegacyTaskCount',
      'adoptedLegacyTriggerCount',
      'adoptionProvenanceTaskCount',
      'adoptionProvenanceTriggerCount',
      'applicationId',
      'applicationPlanDigest',
      'automationAdoptionRecordCount',
      'automationAdoptionProvenanceState',
      'automationAdoptionSetDigest',
      'bindingReadyCount',
      'candidateSetDigest',
      'disabledRowCount',
      'eligibleBindingCount',
      'eligiblePreservationCount',
      'legacyInventoryDigest',
      'manualGroupCount',
      'manualRowCount',
      'outcome',
      'planFileBytes',
      'planFileDigest',
      'preparedAtMs',
      'preparedHeadDigest',
      'preservationReadyCount',
      'receiptDigest',
      'rowCount',
      'rowSetDigest',
      'schema',
      'schemaVersion',
      'secretConfigId',
      'secretConfigPlanDigest',
      'state',
      'tableState',
      'targetConflictCount',
      'unadaptedLegacyConfigCount',
    ],
    'receipt',
  );
  const { receiptDigest, ...payload } = receipt;
  if (
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.schemaVersion !== 1 ||
    receipt.state !== 'reconciliation_secret_config_planned' ||
    typeof receipt.secretConfigId !== 'string' ||
    !UUID_V4_PATTERN.test(receipt.secretConfigId) ||
    typeof receipt.applicationId !== 'string' ||
    !UUID_V4_PATTERN.test(receipt.applicationId) ||
    ![
      receipt.applicationPlanDigest,
      receipt.preparedHeadDigest,
      receipt.legacyInventoryDigest,
      receipt.rowSetDigest,
      receipt.candidateSetDigest,
      receipt.automationAdoptionSetDigest,
      receipt.secretConfigPlanDigest,
      receipt.planFileDigest,
      receiptDigest,
    ].every(
      (candidate) =>
        typeof candidate === 'string' && DIGEST_PATTERN.test(candidate),
    ) ||
    ![
      receipt.rowCount,
      receipt.activeRowCount,
      receipt.disabledRowCount,
      receipt.manualRowCount,
      receipt.activeGroupCount,
      receipt.bindingReadyCount,
      receipt.preservationReadyCount,
      receipt.manualGroupCount,
      receipt.eligibleBindingCount,
      receipt.eligiblePreservationCount,
      receipt.targetConflictCount,
      receipt.automationAdoptionRecordCount,
      receipt.adoptedLegacyTaskCount,
      receipt.adoptedLegacyTriggerCount,
      receipt.adoptionProvenanceTaskCount,
      receipt.adoptionProvenanceTriggerCount,
      receipt.unadaptedLegacyConfigCount,
      receipt.planFileBytes,
      receipt.preparedAtMs,
    ].every((count) => Number.isSafeInteger(count) && (count as number) >= 0) ||
    !['absent', 'supported', 'unsupported_schema', 'budget_exceeded'].includes(
      receipt.tableState as string,
    ) ||
    !['ready', 'manual_required', 'no_effect'].includes(
      receipt.outcome as string,
    ) ||
    !['complete', 'missing', 'drifted'].includes(
      receipt.automationAdoptionProvenanceState as string,
    ) ||
    cutoverDigest(payload) !== receiptDigest
  ) {
    fail('receipt drifted');
  }
  return Object.freeze(
    receipt,
  ) as unknown as Readonly<LocalReconciliationSecretConfigPlanReceipt>;
}

export function hashLocalReconciliationSecretConfigPlanFile(
  descriptor: number,
  expectedBytes: number,
): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let offset = 0;
  while (offset < expectedBytes) {
    const count = fs.readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.byteLength, expectedBytes - offset),
      offset,
    );
    if (count < 1) fail('plan file read stalled');
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  return hash.digest('hex');
}
