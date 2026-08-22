import {
  normalizeLocalReconciliationAutomationDecisionPrepareCommand,
  type LocalReconciliationAutomationDecisionPrepareCommand,
} from './decisionContract';
import { LocalDeploymentConfigurationError } from '../../../foundation/error';
import { cutoverDigest } from '../../../cutover/targetEvidence';

const INTENT_SCHEMA =
  'qinglong3-local-reconciliation-automation-decision-intent';
const RECEIPT_SCHEMA =
  'qinglong3-local-reconciliation-automation-decision-receipt';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface LocalReconciliationAutomationDecisionIntent {
  readonly schema: typeof INTENT_SCHEMA;
  readonly schemaVersion: 1;
  readonly command: Readonly<LocalReconciliationAutomationDecisionPrepareCommand>;
  readonly applicationId: string;
  readonly applicationPlanDigest: string;
  readonly legacyInventoryDigest: string;
  readonly profile: 'edge' | 'standalone';
  readonly projectId: string;
  readonly legacyTimezone: string | null;
  readonly instanceId: string;
  readonly cutoverId: string;
  readonly activationDigest: string;
  readonly generation: number;
  readonly preparationDigest: string;
}

export interface LocalReconciliationAutomationDecisionReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_automation_reviewed';
  readonly decisionId: string;
  readonly automationId: string;
  readonly automationPlanDigest: string;
  readonly legacyInventoryDigest: string;
  readonly preparedHeadDigest: string;
  readonly authorizationFileDigest: string;
  readonly signedReceiptDigest: string;
  readonly signedDecisionSetDigest: string;
  readonly reviewFileDigest: string;
  readonly reviewerDigest: string;
  readonly rowCount: number;
  readonly adoptedCount: number;
  readonly skippedCount: number;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly decisionDigest: string;
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation automation decision evidence ${message}`,
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

export function buildLocalReconciliationAutomationDecisionIntent(
  input: Omit<LocalReconciliationAutomationDecisionIntent, 'schema' | 'schemaVersion' | 'preparationDigest'>,
): Readonly<LocalReconciliationAutomationDecisionIntent> {
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

export function normalizeLocalReconciliationAutomationDecisionIntent(
  value: unknown,
): Readonly<LocalReconciliationAutomationDecisionIntent> {
  const intent = exact(
    value,
    [
      'activationDigest',
      'applicationId',
      'applicationPlanDigest',
      'command',
      'cutoverId',
      'generation',
      'instanceId',
      'legacyInventoryDigest',
      'legacyTimezone',
      'preparationDigest',
      'profile',
      'projectId',
      'schema',
      'schemaVersion',
    ],
    'intent',
  );
  const { preparationDigest, ...payload } = intent;
  const normalizedCommand =
    normalizeLocalReconciliationAutomationDecisionPrepareCommand(
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
    ![intent.applicationPlanDigest, intent.legacyInventoryDigest, intent.activationDigest].every(
      (digest) => typeof digest === 'string' && DIGEST_PATTERN.test(digest),
    ) ||
    typeof intent.applicationId !== 'string' ||
    typeof intent.instanceId !== 'string' ||
    typeof intent.cutoverId !== 'string' ||
    typeof intent.projectId !== 'string' ||
    (intent.legacyTimezone !== null &&
      typeof intent.legacyTimezone !== 'string') ||
    !Number.isSafeInteger(intent.generation) ||
    (intent.generation as number) < 1
  ) {
    configurationError('intent binding is invalid');
  }
  return Object.freeze({
    ...normalizedPayload,
    preparationDigest,
  }) as unknown as Readonly<LocalReconciliationAutomationDecisionIntent>;
}

export function buildLocalReconciliationAutomationDecisionReceipt(
  input: Omit<LocalReconciliationAutomationDecisionReceipt, 'schema' | 'schemaVersion' | 'state' | 'decisionDigest'>,
): Readonly<LocalReconciliationAutomationDecisionReceipt> {
  const payload = Object.freeze({
    schema: RECEIPT_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_automation_reviewed' as const,
    ...input,
  });
  return Object.freeze({
    ...payload,
    decisionDigest: cutoverDigest(payload),
  });
}

export function normalizeLocalReconciliationAutomationDecisionReceipt(
  value: unknown,
): Readonly<LocalReconciliationAutomationDecisionReceipt> {
  const receipt = exact(
    value,
    [
      'adoptedCount',
      'authorizationFileDigest',
      'automationId',
      'automationPlanDigest',
      'decisionDigest',
      'decisionId',
      'expiresAtMs',
      'issuedAtMs',
      'legacyInventoryDigest',
      'preparedHeadDigest',
      'reviewFileDigest',
      'reviewerDigest',
      'rowCount',
      'schema',
      'schemaVersion',
      'signedDecisionSetDigest',
      'signedReceiptDigest',
      'skippedCount',
      'state',
    ],
    'receipt',
  );
  const { decisionDigest, ...payload } = receipt;
  if (
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.schemaVersion !== 1 ||
    receipt.state !== 'reconciliation_automation_reviewed' ||
    typeof decisionDigest !== 'string' ||
    !DIGEST_PATTERN.test(decisionDigest) ||
    cutoverDigest(payload) !== decisionDigest ||
    ![
      receipt.automationPlanDigest,
      receipt.legacyInventoryDigest,
      receipt.preparedHeadDigest,
      receipt.authorizationFileDigest,
      receipt.signedReceiptDigest,
      receipt.signedDecisionSetDigest,
      receipt.reviewFileDigest,
      receipt.reviewerDigest,
    ].every(
      (digest) => typeof digest === 'string' && DIGEST_PATTERN.test(digest),
    ) ||
    ![receipt.rowCount, receipt.adoptedCount, receipt.skippedCount].every(
      (count) => Number.isSafeInteger(count) && (count as number) >= 0,
    ) ||
    (receipt.adoptedCount as number) + (receipt.skippedCount as number) !==
      receipt.rowCount ||
    !Number.isSafeInteger(receipt.issuedAtMs) ||
    (receipt.issuedAtMs as number) < 0 ||
    !Number.isSafeInteger(receipt.expiresAtMs) ||
    (receipt.expiresAtMs as number) <= (receipt.issuedAtMs as number) ||
    typeof receipt.decisionId !== 'string' ||
    typeof receipt.automationId !== 'string'
  ) {
    configurationError('receipt binding is invalid');
  }
  return Object.freeze(receipt) as unknown as Readonly<LocalReconciliationAutomationDecisionReceipt>;
}

export function localReconciliationAutomationDecisionEvidenceContents(
  value:
    | Readonly<LocalReconciliationAutomationDecisionIntent>
    | Readonly<LocalReconciliationAutomationDecisionReceipt>,
): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
