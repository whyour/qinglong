import type {
  LocalSqliteRolloutBackupEvidence,
  LocalSqliteSnapshotEvidence,
} from '@qinglong/local-sqlite/rollout-safety';

import { LocalDeploymentConfigurationError } from '../../../foundation/error';
import { cutoverDigest } from '../../../cutover/targetEvidence';
import {
  normalizeLocalReconciliationAutomationApplyCommand,
  type LocalReconciliationAutomationApplyCommand,
} from './applyContract';

const INTENT_SCHEMA = 'qinglong3-local-reconciliation-automation-apply-intent';
const RECEIPT_SCHEMA =
  'qinglong3-local-reconciliation-automation-apply-receipt';
const ROLLBACK_SCHEMA =
  'qinglong3-local-reconciliation-automation-rollback-receipt';
const DIGEST = /^[0-9a-f]{64}$/;

export interface LocalReconciliationAutomationApplyIntent {
  readonly schema: typeof INTENT_SCHEMA;
  readonly schemaVersion: 1;
  readonly command: Readonly<LocalReconciliationAutomationApplyCommand>;
  readonly instanceId: string;
  readonly cutoverId: string;
  readonly activationDigest: string;
  readonly profile: 'edge' | 'standalone';
  readonly projectId: string;
  readonly generation: number;
  readonly stoppedProofDigest: string;
  readonly backup: Readonly<LocalSqliteRolloutBackupEvidence>;
  readonly preparationDigest: string;
}

export interface LocalReconciliationAutomationApplyReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_automation_applied';
  readonly decisionId: string;
  readonly automationId: string;
  readonly mutationId: string;
  readonly preparationDigest: string;
  readonly preparedHeadDigest: string;
  readonly publicationDigest: string;
  readonly adoptedTaskCount: number;
  readonly adoptedTriggerCount: number;
  readonly skippedCount: number;
  readonly targetAfter: Readonly<LocalSqliteSnapshotEvidence>;
  readonly appliedAtMs: number;
  readonly applyDigest: string;
}

export interface LocalReconciliationAutomationRollbackReceipt {
  readonly schema: typeof ROLLBACK_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_automation_rolled_back';
  readonly decisionId: string;
  readonly automationId: string;
  readonly applyDigest: string;
  readonly restored: Readonly<LocalSqliteSnapshotEvidence>;
  readonly rolledBackAtMs: number;
  readonly rollbackDigest: string;
}

function fail(message: string): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation automation apply evidence ${message}`,
  );
}

function exact(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fail(`${label} shape is invalid`);
  return record;
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function snapshot(
  value: unknown,
  label: string,
): Readonly<LocalSqliteSnapshotEvidence> {
  const selected = exact(
    value,
    ['bytes', 'contractVersion', 'pageCount', 'pageSize', 'sha256'],
    label,
  );
  if (
    !validDigest(selected.sha256) ||
    ![selected.bytes, selected.pageCount, selected.pageSize].every(
      (item) => Number.isSafeInteger(item) && (item as number) > 0,
    ) ||
    typeof selected.contractVersion !== 'number'
  )
    fail(`${label} is invalid`);
  return Object.freeze({
    contractVersion: selected.contractVersion,
    sha256: selected.sha256,
    bytes: selected.bytes,
    pageCount: selected.pageCount,
    pageSize: selected.pageSize,
  }) as unknown as Readonly<LocalSqliteSnapshotEvidence>;
}

function backup(value: unknown): Readonly<LocalSqliteRolloutBackupEvidence> {
  const selected = exact(
    value,
    [
      'bytes',
      'contractVersion',
      'pageCount',
      'pageSize',
      'sha256',
      'status',
      'writeContractVersion',
    ],
    'backup',
  );
  const base = snapshot(
    {
      bytes: selected.bytes,
      contractVersion: selected.contractVersion,
      pageCount: selected.pageCount,
      pageSize: selected.pageSize,
      sha256: selected.sha256,
    },
    'backup snapshot',
  );
  if (
    (selected.status !== 'prepared' && selected.status !== 'existing') ||
    typeof selected.writeContractVersion !== 'number'
  )
    fail('backup is invalid');
  return Object.freeze({
    status: selected.status,
    writeContractVersion: selected.writeContractVersion,
    ...base,
  }) as Readonly<LocalSqliteRolloutBackupEvidence>;
}

export function buildLocalReconciliationAutomationApplyIntent(
  input: Omit<
    LocalReconciliationAutomationApplyIntent,
    'schema' | 'schemaVersion' | 'preparationDigest'
  >,
): Readonly<LocalReconciliationAutomationApplyIntent> {
  const payload = Object.freeze({
    schema: INTENT_SCHEMA,
    schemaVersion: 1 as const,
    ...input,
  });
  return Object.freeze({
    ...payload,
    preparationDigest: cutoverDigest(payload),
  });
}

export function normalizeLocalReconciliationAutomationApplyIntent(
  value: unknown,
): Readonly<LocalReconciliationAutomationApplyIntent> {
  const selected = exact(
    value,
    [
      'activationDigest',
      'backup',
      'command',
      'cutoverId',
      'generation',
      'instanceId',
      'preparationDigest',
      'profile',
      'projectId',
      'schema',
      'schemaVersion',
      'stoppedProofDigest',
    ],
    'intent',
  );
  const { preparationDigest, ...raw } = selected;
  const command = normalizeLocalReconciliationAutomationApplyCommand(
    selected.command,
  );
  const normalized = Object.freeze({
    ...raw,
    command,
    backup: backup(selected.backup),
  });
  if (
    selected.schema !== INTENT_SCHEMA ||
    selected.schemaVersion !== 1 ||
    !validDigest(preparationDigest) ||
    cutoverDigest(raw) !== preparationDigest ||
    cutoverDigest(normalized) !== preparationDigest ||
    !validDigest(selected.activationDigest) ||
    !validDigest(selected.stoppedProofDigest) ||
    (selected.profile !== 'edge' && selected.profile !== 'standalone') ||
    !Number.isSafeInteger(selected.generation) ||
    (selected.generation as number) < 1 ||
    ![selected.instanceId, selected.cutoverId, selected.projectId].every(
      (item) => typeof item === 'string' && item.length > 0,
    )
  )
    fail('intent binding is invalid');
  return Object.freeze({
    ...normalized,
    preparationDigest,
  }) as unknown as Readonly<LocalReconciliationAutomationApplyIntent>;
}

export function buildLocalReconciliationAutomationApplyReceipt(
  input: Omit<
    LocalReconciliationAutomationApplyReceipt,
    'schema' | 'schemaVersion' | 'state' | 'applyDigest'
  >,
): Readonly<LocalReconciliationAutomationApplyReceipt> {
  const payload = Object.freeze({
    schema: RECEIPT_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_automation_applied' as const,
    ...input,
  });
  return Object.freeze({ ...payload, applyDigest: cutoverDigest(payload) });
}

export function normalizeLocalReconciliationAutomationApplyReceipt(
  value: unknown,
): Readonly<LocalReconciliationAutomationApplyReceipt> {
  const selected = exact(
    value,
    [
      'adoptedTaskCount',
      'adoptedTriggerCount',
      'appliedAtMs',
      'applyDigest',
      'automationId',
      'decisionId',
      'mutationId',
      'preparationDigest',
      'preparedHeadDigest',
      'publicationDigest',
      'schema',
      'schemaVersion',
      'skippedCount',
      'state',
      'targetAfter',
    ],
    'receipt',
  );
  const { applyDigest, ...payload } = selected;
  const targetAfter = snapshot(selected.targetAfter, 'targetAfter');
  if (
    selected.schema !== RECEIPT_SCHEMA ||
    selected.schemaVersion !== 1 ||
    selected.state !== 'reconciliation_automation_applied' ||
    !validDigest(applyDigest) ||
    cutoverDigest(payload) !== applyDigest ||
    ![
      selected.preparationDigest,
      selected.preparedHeadDigest,
      selected.publicationDigest,
    ].every(validDigest) ||
    ![
      selected.adoptedTaskCount,
      selected.adoptedTriggerCount,
      selected.skippedCount,
      selected.appliedAtMs,
    ].every((item) => Number.isSafeInteger(item) && (item as number) >= 0)
  )
    fail('receipt binding is invalid');
  return Object.freeze({
    ...payload,
    targetAfter,
    applyDigest,
  }) as unknown as Readonly<LocalReconciliationAutomationApplyReceipt>;
}

export function buildLocalReconciliationAutomationRollbackReceipt(
  input: Omit<
    LocalReconciliationAutomationRollbackReceipt,
    'schema' | 'schemaVersion' | 'state' | 'rollbackDigest'
  >,
): Readonly<LocalReconciliationAutomationRollbackReceipt> {
  const payload = Object.freeze({
    schema: ROLLBACK_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_automation_rolled_back' as const,
    ...input,
  });
  return Object.freeze({ ...payload, rollbackDigest: cutoverDigest(payload) });
}

export function normalizeLocalReconciliationAutomationRollbackReceipt(
  value: unknown,
): Readonly<LocalReconciliationAutomationRollbackReceipt> {
  const selected = exact(
    value,
    [
      'applyDigest',
      'automationId',
      'decisionId',
      'restored',
      'rollbackDigest',
      'rolledBackAtMs',
      'schema',
      'schemaVersion',
      'state',
    ],
    'rollback receipt',
  );
  const { rollbackDigest, ...payload } = selected;
  const restored = snapshot(selected.restored, 'restored');
  if (
    selected.schema !== ROLLBACK_SCHEMA ||
    selected.schemaVersion !== 1 ||
    selected.state !== 'reconciliation_automation_rolled_back' ||
    !validDigest(selected.applyDigest) ||
    !validDigest(rollbackDigest) ||
    cutoverDigest(payload) !== rollbackDigest ||
    !Number.isSafeInteger(selected.rolledBackAtMs) ||
    (selected.rolledBackAtMs as number) < 0
  )
    fail('rollback receipt binding is invalid');
  return Object.freeze({
    ...payload,
    restored,
    rollbackDigest,
  }) as unknown as Readonly<LocalReconciliationAutomationRollbackReceipt>;
}

export function localReconciliationAutomationApplyEvidenceContents(
  value:
    | LocalReconciliationAutomationApplyIntent
    | LocalReconciliationAutomationApplyReceipt
    | LocalReconciliationAutomationRollbackReceipt,
): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
