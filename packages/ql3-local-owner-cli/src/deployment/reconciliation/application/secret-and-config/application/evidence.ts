import type {
  LocalSqliteRolloutBackupEvidence,
  LocalSqliteSnapshotEvidence,
} from '@qinglong/local-sqlite/rollout-safety';

import { LocalDeploymentConfigurationError } from '../../../../foundation/error';
import { cutoverDigest } from '../../../../cutover/targetEvidence';
import {
  normalizeLocalReconciliationSecretConfigApplyCommand,
  type LocalReconciliationSecretConfigApplyCommand,
} from './contract';

const INTENT_SCHEMA =
  'qinglong3-local-reconciliation-secret-config-apply-intent';
const RECEIPT_SCHEMA =
  'qinglong3-local-reconciliation-secret-config-apply-receipt';
const ROLLBACK_SCHEMA =
  'qinglong3-local-reconciliation-secret-config-rollback-receipt';
const DIGEST = /^[0-9a-f]{64}$/;

export interface LocalReconciliationSecretConfigMaterialEvidence {
  readonly fileBytes: number;
  readonly fileDigest: string;
  readonly secretCount: number;
  readonly activeBindingCount: number;
  readonly disabledPreservationCount: number;
  readonly materialSetDigest: string;
}

export interface LocalReconciliationSecretConfigApplyIntent {
  readonly schema: typeof INTENT_SCHEMA;
  readonly schemaVersion: 1;
  readonly command: Readonly<LocalReconciliationSecretConfigApplyCommand>;
  readonly instanceId: string;
  readonly cutoverId: string;
  readonly activationDigest: string;
  readonly profile: 'edge' | 'standalone';
  readonly projectId: string;
  readonly generation: number;
  readonly stoppedProofDigest: string;
  readonly legacyInventoryDigest: string;
  readonly candidateSetDigest: string;
  readonly automationAdoptionSetDigest: string;
  readonly material: Readonly<LocalReconciliationSecretConfigMaterialEvidence>;
  readonly backup: Readonly<LocalSqliteRolloutBackupEvidence>;
  readonly preparationDigest: string;
}

export interface LocalReconciliationSecretConfigApplyReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_secret_config_applied';
  readonly decisionId: string;
  readonly secretConfigId: string;
  readonly mutationId: string;
  readonly preparationDigest: string;
  readonly preparedHeadDigest: string;
  readonly publicationDigest: string;
  readonly publisherReceiptDigest: string;
  readonly activeBindingCount: number;
  readonly disabledPreservationCount: number;
  readonly updatedTaskCount: number;
  readonly updatedTriggerCount: number;
  readonly targetAfter: Readonly<LocalSqliteSnapshotEvidence>;
  readonly appliedAtMs: number;
  readonly applyDigest: string;
}

export interface LocalReconciliationSecretConfigRollbackReceipt {
  readonly schema: typeof ROLLBACK_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_secret_config_rolled_back';
  readonly decisionId: string;
  readonly secretConfigId: string;
  readonly applyDigest: string;
  readonly restored: Readonly<LocalSqliteSnapshotEvidence>;
  readonly rolledBackAtMs: number;
  readonly rollbackDigest: string;
}

function fail(message: string): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation secret config apply evidence ${message}`,
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
  const selected = value as Record<string, unknown>;
  const actual = Object.keys(selected).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} shape is invalid`);
  }
  return selected;
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function nonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
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
    !positive(selected.bytes) ||
    !positive(selected.pageCount) ||
    !positive(selected.pageSize) ||
    !Number.isSafeInteger(selected.contractVersion) ||
    (selected.contractVersion as number) < 1
  ) {
    fail(`${label} is invalid`);
  }
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
    !Number.isSafeInteger(selected.writeContractVersion) ||
    (selected.writeContractVersion as number) < 1
  ) {
    fail('backup is invalid');
  }
  return Object.freeze({
    status: selected.status,
    writeContractVersion: selected.writeContractVersion,
    ...base,
  }) as Readonly<LocalSqliteRolloutBackupEvidence>;
}

function material(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigMaterialEvidence> {
  const selected = exact(
    value,
    [
      'activeBindingCount',
      'disabledPreservationCount',
      'fileBytes',
      'fileDigest',
      'materialSetDigest',
      'secretCount',
    ],
    'material',
  );
  if (
    !positive(selected.fileBytes) ||
    !validDigest(selected.fileDigest) ||
    !validDigest(selected.materialSetDigest) ||
    !positive(selected.secretCount) ||
    !nonnegative(selected.activeBindingCount) ||
    !nonnegative(selected.disabledPreservationCount) ||
    (selected.activeBindingCount as number) +
      (selected.disabledPreservationCount as number) !==
      selected.secretCount
  ) {
    fail('material is invalid');
  }
  return Object.freeze(
    selected,
  ) as unknown as Readonly<LocalReconciliationSecretConfigMaterialEvidence>;
}

export function buildLocalReconciliationSecretConfigApplyIntent(
  input: Omit<
    LocalReconciliationSecretConfigApplyIntent,
    'schema' | 'schemaVersion' | 'preparationDigest'
  >,
): Readonly<LocalReconciliationSecretConfigApplyIntent> {
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

export function normalizeLocalReconciliationSecretConfigApplyIntent(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigApplyIntent> {
  const selected = exact(
    value,
    [
      'activationDigest',
      'automationAdoptionSetDigest',
      'backup',
      'candidateSetDigest',
      'command',
      'cutoverId',
      'generation',
      'instanceId',
      'legacyInventoryDigest',
      'material',
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
  const normalized = Object.freeze({
    ...raw,
    command: normalizeLocalReconciliationSecretConfigApplyCommand(
      selected.command,
    ),
    material: material(selected.material),
    backup: backup(selected.backup),
  });
  if (
    selected.schema !== INTENT_SCHEMA ||
    selected.schemaVersion !== 1 ||
    !validDigest(preparationDigest) ||
    cutoverDigest(raw) !== preparationDigest ||
    cutoverDigest(normalized) !== preparationDigest ||
    ![
      selected.activationDigest,
      selected.stoppedProofDigest,
      selected.legacyInventoryDigest,
      selected.candidateSetDigest,
      selected.automationAdoptionSetDigest,
    ].every(validDigest) ||
    (selected.profile !== 'edge' && selected.profile !== 'standalone') ||
    !positive(selected.generation) ||
    ![selected.instanceId, selected.cutoverId, selected.projectId].every(
      (entry) => typeof entry === 'string' && entry.length > 0,
    )
  ) {
    fail('intent binding is invalid');
  }
  return Object.freeze({
    ...normalized,
    preparationDigest,
  }) as unknown as Readonly<LocalReconciliationSecretConfigApplyIntent>;
}

export function buildLocalReconciliationSecretConfigApplyReceipt(
  input: Omit<
    LocalReconciliationSecretConfigApplyReceipt,
    'schema' | 'schemaVersion' | 'state' | 'applyDigest'
  >,
): Readonly<LocalReconciliationSecretConfigApplyReceipt> {
  const payload = Object.freeze({
    schema: RECEIPT_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_secret_config_applied' as const,
    ...input,
  });
  return Object.freeze({ ...payload, applyDigest: cutoverDigest(payload) });
}

export function normalizeLocalReconciliationSecretConfigApplyReceipt(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigApplyReceipt> {
  const selected = exact(
    value,
    [
      'activeBindingCount',
      'appliedAtMs',
      'applyDigest',
      'decisionId',
      'disabledPreservationCount',
      'mutationId',
      'preparationDigest',
      'preparedHeadDigest',
      'publicationDigest',
      'publisherReceiptDigest',
      'schema',
      'schemaVersion',
      'secretConfigId',
      'state',
      'targetAfter',
      'updatedTaskCount',
      'updatedTriggerCount',
    ],
    'receipt',
  );
  const { applyDigest, ...payload } = selected;
  const targetAfter = snapshot(selected.targetAfter, 'targetAfter');
  if (
    selected.schema !== RECEIPT_SCHEMA ||
    selected.schemaVersion !== 1 ||
    selected.state !== 'reconciliation_secret_config_applied' ||
    !validDigest(applyDigest) ||
    cutoverDigest(payload) !== applyDigest ||
    ![
      selected.preparationDigest,
      selected.preparedHeadDigest,
      selected.publicationDigest,
      selected.publisherReceiptDigest,
    ].every(validDigest) ||
    ![
      selected.activeBindingCount,
      selected.disabledPreservationCount,
      selected.updatedTaskCount,
      selected.updatedTriggerCount,
      selected.appliedAtMs,
    ].every(nonnegative) ||
    typeof selected.decisionId !== 'string' ||
    typeof selected.secretConfigId !== 'string' ||
    typeof selected.mutationId !== 'string'
  ) {
    fail('receipt binding is invalid');
  }
  return Object.freeze({
    ...payload,
    targetAfter,
    applyDigest,
  }) as unknown as Readonly<LocalReconciliationSecretConfigApplyReceipt>;
}

export function buildLocalReconciliationSecretConfigRollbackReceipt(
  input: Omit<
    LocalReconciliationSecretConfigRollbackReceipt,
    'schema' | 'schemaVersion' | 'state' | 'rollbackDigest'
  >,
): Readonly<LocalReconciliationSecretConfigRollbackReceipt> {
  const payload = Object.freeze({
    schema: ROLLBACK_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_secret_config_rolled_back' as const,
    ...input,
  });
  return Object.freeze({
    ...payload,
    rollbackDigest: cutoverDigest(payload),
  });
}

export function normalizeLocalReconciliationSecretConfigRollbackReceipt(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigRollbackReceipt> {
  const selected = exact(
    value,
    [
      'applyDigest',
      'decisionId',
      'restored',
      'rollbackDigest',
      'rolledBackAtMs',
      'schema',
      'schemaVersion',
      'secretConfigId',
      'state',
    ],
    'rollback receipt',
  );
  const { rollbackDigest, ...payload } = selected;
  const restored = snapshot(selected.restored, 'restored');
  if (
    selected.schema !== ROLLBACK_SCHEMA ||
    selected.schemaVersion !== 1 ||
    selected.state !== 'reconciliation_secret_config_rolled_back' ||
    !validDigest(selected.applyDigest) ||
    !validDigest(rollbackDigest) ||
    cutoverDigest(payload) !== rollbackDigest ||
    !nonnegative(selected.rolledBackAtMs) ||
    typeof selected.decisionId !== 'string' ||
    typeof selected.secretConfigId !== 'string'
  ) {
    fail('rollback receipt binding is invalid');
  }
  return Object.freeze({
    ...payload,
    restored,
    rollbackDigest,
  }) as unknown as Readonly<LocalReconciliationSecretConfigRollbackReceipt>;
}

export function localReconciliationSecretConfigApplyEvidenceContents(
  value:
    | Readonly<LocalReconciliationSecretConfigApplyIntent>
    | Readonly<LocalReconciliationSecretConfigApplyReceipt>
    | Readonly<LocalReconciliationSecretConfigRollbackReceipt>,
): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
