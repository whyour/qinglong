import { LocalDeploymentConfigurationError } from '../../../foundation/error';
import { cutoverDigest } from '../../../cutover/targetEvidence';

const RECEIPT_SCHEMA =
  'qinglong3-local-reconciliation-run-history-preservation-receipt';
const DIGEST = /^[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface LocalReconciliationRunHistoryPreservationReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_run_history_preserved';
  readonly preservationId: string;
  readonly applicationId: string;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly cutoverId: string;
  readonly generation: number;
  readonly activationDigest: string;
  readonly applicationPlanDigest: string;
  readonly sourceHeadDigest: string;
  readonly reviewDigest: string;
  readonly reviewAuthorizationDigest: string;
  readonly reviewDecisionSetDigest: string;
  readonly reviewDecisionFileDigest: string;
  readonly bundleDigest: string;
  readonly bundleFingerprintDigest: string;
  readonly runHistoryInventoryDigest: string;
  readonly legacyFactCount: number;
  readonly targetFactCount: number;
  readonly preservedAtMs: number;
  readonly preservationDigest: string;
}

function fail(message: string): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation run history evidence ${message}`,
  );
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('receipt must be an object');
  }
  const selected = value as Record<string, unknown>;
  const actual = Object.keys(selected).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail('receipt shape is invalid');
  }
  return selected;
}

export function buildLocalReconciliationRunHistoryPreservationReceipt(
  input: Omit<
    LocalReconciliationRunHistoryPreservationReceipt,
    'schema' | 'schemaVersion' | 'state' | 'preservationDigest'
  >,
): Readonly<LocalReconciliationRunHistoryPreservationReceipt> {
  const payload = Object.freeze({
    schema: RECEIPT_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_run_history_preserved' as const,
    ...input,
  });
  return Object.freeze({
    ...payload,
    preservationDigest: cutoverDigest(payload),
  });
}

export function normalizeLocalReconciliationRunHistoryPreservationReceipt(
  value: unknown,
): Readonly<LocalReconciliationRunHistoryPreservationReceipt> {
  const selected = exact(value, [
    'activationDigest',
    'applicationId',
    'applicationPlanDigest',
    'bundleDigest',
    'bundleFingerprintDigest',
    'cutoverId',
    'generation',
    'instanceId',
    'legacyFactCount',
    'preservationDigest',
    'preservationId',
    'preservedAtMs',
    'profile',
    'reviewAuthorizationDigest',
    'reviewDecisionFileDigest',
    'reviewDecisionSetDigest',
    'reviewDigest',
    'runHistoryInventoryDigest',
    'schema',
    'schemaVersion',
    'sourceHeadDigest',
    'state',
    'targetFactCount',
  ]);
  const { preservationDigest, ...payload } = selected;
  if (
    selected.schema !== RECEIPT_SCHEMA ||
    selected.schemaVersion !== 1 ||
    selected.state !== 'reconciliation_run_history_preserved' ||
    typeof selected.preservationId !== 'string' ||
    !UUID_V4.test(selected.preservationId) ||
    typeof selected.applicationId !== 'string' ||
    !UUID_V4.test(selected.applicationId) ||
    (selected.profile !== 'edge' && selected.profile !== 'standalone') ||
    typeof selected.instanceId !== 'string' ||
    selected.instanceId.length < 1 ||
    typeof selected.cutoverId !== 'string' ||
    selected.cutoverId.length < 1 ||
    !Number.isSafeInteger(selected.generation) ||
    (selected.generation as number) < 1 ||
    ![
      selected.activationDigest,
      selected.applicationPlanDigest,
      selected.sourceHeadDigest,
      selected.reviewDigest,
      selected.reviewAuthorizationDigest,
      selected.reviewDecisionSetDigest,
      selected.reviewDecisionFileDigest,
      selected.bundleDigest,
      selected.bundleFingerprintDigest,
      selected.runHistoryInventoryDigest,
      preservationDigest,
    ].every(
      (candidate) => typeof candidate === 'string' && DIGEST.test(candidate),
    ) ||
    !Number.isSafeInteger(selected.legacyFactCount) ||
    (selected.legacyFactCount as number) < 1 ||
    !Number.isSafeInteger(selected.targetFactCount) ||
    (selected.targetFactCount as number) < 1 ||
    !Number.isSafeInteger(selected.preservedAtMs) ||
    (selected.preservedAtMs as number) < 0 ||
    cutoverDigest(payload) !== preservationDigest
  ) {
    fail('receipt binding is invalid');
  }
  return Object.freeze({
    ...payload,
    preservationDigest,
  }) as unknown as Readonly<LocalReconciliationRunHistoryPreservationReceipt>;
}

export function localReconciliationRunHistoryReceiptContents(
  receipt: Readonly<LocalReconciliationRunHistoryPreservationReceipt>,
): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}
