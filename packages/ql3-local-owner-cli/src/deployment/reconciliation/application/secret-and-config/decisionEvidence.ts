import { LocalDeploymentConfigurationError } from '../../../foundation/error';
import { cutoverDigest } from '../../../cutover/targetEvidence';
import {
  normalizeLocalReconciliationSecretConfigDecisionPrepareCommand,
  type LocalReconciliationSecretConfigDecisionPrepareCommand,
} from './decisionContract';

const INTENT_SCHEMA =
  'qinglong3-local-reconciliation-secret-config-decision-intent';
const RECEIPT_SCHEMA =
  'qinglong3-local-reconciliation-secret-config-decision-receipt';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface LocalReconciliationSecretConfigDecisionIntent {
  readonly schema: typeof INTENT_SCHEMA;
  readonly schemaVersion: 1;
  readonly command: Readonly<LocalReconciliationSecretConfigDecisionPrepareCommand>;
  readonly applicationId: string;
  readonly applicationPlanDigest: string;
  readonly profile: 'edge' | 'standalone';
  readonly projectId: string;
  readonly secretConfigPlanDigest: string;
  readonly candidateSetDigest: string;
  readonly bundleDigest: string;
  readonly bundleFingerprintDigest: string;
  readonly instanceId: string;
  readonly cutoverId: string;
  readonly activationDigest: string;
  readonly generation: number;
  readonly preparationDigest: string;
}

export interface LocalReconciliationSecretConfigDecisionReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_secret_config_reviewed';
  readonly decisionId: string;
  readonly secretConfigId: string;
  readonly secretConfigPlanDigest: string;
  readonly candidateSetDigest: string;
  readonly applicationPlanDigest: string;
  readonly preparedHeadDigest: string;
  readonly authorizationDigest: string;
  readonly signedDecisionSetDigest: string;
  readonly decisionFileDigest: string;
  readonly reviewerDigest: string;
  readonly candidateCount: number;
  readonly applyBindingCount: number;
  readonly preserveDisabledCount: number;
  readonly skippedCount: number;
  readonly outcome: 'ready' | 'manual_required';
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly decisionDigest: string;
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation secret config decision evidence ${message}`,
  );
}

function exact(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    configurationError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    configurationError(`${label} shape is invalid`);
  }
  return record;
}

export function buildLocalReconciliationSecretConfigDecisionIntent(
  input: Omit<
    LocalReconciliationSecretConfigDecisionIntent,
    'schema' | 'schemaVersion' | 'preparationDigest'
  >,
): Readonly<LocalReconciliationSecretConfigDecisionIntent> {
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

export function normalizeLocalReconciliationSecretConfigDecisionIntent(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigDecisionIntent> {
  const intent = exact(
    value,
    [
      'activationDigest',
      'applicationId',
      'applicationPlanDigest',
      'bundleDigest',
      'bundleFingerprintDigest',
      'candidateSetDigest',
      'command',
      'cutoverId',
      'generation',
      'instanceId',
      'preparationDigest',
      'profile',
      'projectId',
      'schema',
      'schemaVersion',
      'secretConfigPlanDigest',
    ],
    'intent',
  );
  const { preparationDigest, ...payload } = intent;
  const normalizedCommand =
    normalizeLocalReconciliationSecretConfigDecisionPrepareCommand(
      intent.command,
    );
  const normalizedPayload = Object.freeze({
    ...payload,
    command: normalizedCommand,
  });
  if (
    intent.schema !== INTENT_SCHEMA ||
    intent.schemaVersion !== 1 ||
    typeof preparationDigest !== 'string' ||
    !DIGEST_PATTERN.test(preparationDigest) ||
    cutoverDigest(payload) !== preparationDigest ||
    cutoverDigest(normalizedPayload) !== preparationDigest ||
    (intent.profile !== 'edge' && intent.profile !== 'standalone') ||
    ![
      intent.applicationPlanDigest,
      intent.secretConfigPlanDigest,
      intent.candidateSetDigest,
      intent.bundleDigest,
      intent.bundleFingerprintDigest,
      intent.activationDigest,
    ].every(
      (selected) =>
        typeof selected === 'string' && DIGEST_PATTERN.test(selected),
    ) ||
    ![
      intent.applicationId,
      intent.projectId,
      intent.instanceId,
      intent.cutoverId,
    ].every(
      (selected) => typeof selected === 'string' && selected.length > 0,
    ) ||
    !Number.isSafeInteger(intent.generation) ||
    (intent.generation as number) < 1
  ) {
    configurationError('intent binding is invalid');
  }
  return Object.freeze({
    ...normalizedPayload,
    preparationDigest,
  }) as unknown as Readonly<LocalReconciliationSecretConfigDecisionIntent>;
}

export function buildLocalReconciliationSecretConfigDecisionReceipt(
  input: Omit<
    LocalReconciliationSecretConfigDecisionReceipt,
    'schema' | 'schemaVersion' | 'state' | 'decisionDigest'
  >,
): Readonly<LocalReconciliationSecretConfigDecisionReceipt> {
  const payload = Object.freeze({
    schema: RECEIPT_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_secret_config_reviewed' as const,
    ...input,
  });
  return Object.freeze({
    ...payload,
    decisionDigest: cutoverDigest(payload),
  });
}

export function normalizeLocalReconciliationSecretConfigDecisionReceipt(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigDecisionReceipt> {
  const receipt = exact(
    value,
    [
      'applicationPlanDigest',
      'applyBindingCount',
      'authorizationDigest',
      'candidateCount',
      'candidateSetDigest',
      'decisionDigest',
      'decisionFileDigest',
      'decisionId',
      'expiresAtMs',
      'issuedAtMs',
      'outcome',
      'preparedHeadDigest',
      'preserveDisabledCount',
      'reviewerDigest',
      'schema',
      'schemaVersion',
      'secretConfigId',
      'secretConfigPlanDigest',
      'signedDecisionSetDigest',
      'skippedCount',
      'state',
    ],
    'receipt',
  );
  const { decisionDigest, ...payload } = receipt;
  if (
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.schemaVersion !== 1 ||
    receipt.state !== 'reconciliation_secret_config_reviewed' ||
    typeof decisionDigest !== 'string' ||
    !DIGEST_PATTERN.test(decisionDigest) ||
    cutoverDigest(payload) !== decisionDigest ||
    ![
      receipt.secretConfigPlanDigest,
      receipt.candidateSetDigest,
      receipt.applicationPlanDigest,
      receipt.preparedHeadDigest,
      receipt.authorizationDigest,
      receipt.signedDecisionSetDigest,
      receipt.decisionFileDigest,
      receipt.reviewerDigest,
    ].every(
      (selected) =>
        typeof selected === 'string' && DIGEST_PATTERN.test(selected),
    ) ||
    ![
      receipt.candidateCount,
      receipt.applyBindingCount,
      receipt.preserveDisabledCount,
      receipt.skippedCount,
    ].every(
      (selected) => Number.isSafeInteger(selected) && (selected as number) >= 0,
    ) ||
    (receipt.applyBindingCount as number) +
      (receipt.preserveDisabledCount as number) +
      (receipt.skippedCount as number) !==
      receipt.candidateCount ||
    (receipt.outcome !== 'ready' && receipt.outcome !== 'manual_required') ||
    (receipt.outcome === 'ready' && (receipt.skippedCount as number) !== 0) ||
    (receipt.outcome === 'manual_required' &&
      (receipt.skippedCount as number) === 0) ||
    !Number.isSafeInteger(receipt.issuedAtMs) ||
    (receipt.issuedAtMs as number) < 0 ||
    !Number.isSafeInteger(receipt.expiresAtMs) ||
    (receipt.expiresAtMs as number) <= (receipt.issuedAtMs as number) ||
    typeof receipt.decisionId !== 'string' ||
    typeof receipt.secretConfigId !== 'string'
  ) {
    configurationError('receipt binding is invalid');
  }
  return Object.freeze(
    receipt,
  ) as unknown as Readonly<LocalReconciliationSecretConfigDecisionReceipt>;
}

export function localReconciliationSecretConfigDecisionEvidenceContents(
  value:
    | Readonly<LocalReconciliationSecretConfigDecisionIntent>
    | Readonly<LocalReconciliationSecretConfigDecisionReceipt>,
): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
