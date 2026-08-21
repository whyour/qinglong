import { LocalDeploymentConfigurationError } from '../../foundation/error';
import { cutoverDigest } from '../../cutover/targetEvidence';
import type {
  LocalReconciliationReviewAuthorizationDomainDecisionCounts,
  LocalReconciliationReviewAuthorizationEvidence,
} from '../review/authorization';
import {
  LOCAL_RECONCILIATION_REVIEW_DISPOSITIONS,
  type LocalReconciliationReviewDisposition,
} from '../review/decisionFile';
import {
  LOCAL_RECONCILIATION_PLAN_DOMAINS,
  type LocalReconciliationPlanDomain,
} from '../planning/contract';
import type { LocalReconciliationApplicationIntent } from './coordinator';

const PLAN_SCHEMA = 'qinglong3-local-reconciliation-application-plan';
const RECEIPT_SCHEMA =
  'qinglong3-local-reconciliation-application-plan-receipt';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PLAN_BYTES = 64 * 1024;

export type LocalReconciliationApplicationDomainAction =
  | 'no_effect'
  | 'adapter_required'
  | 'manual_external'
  | 'adapter_and_manual';

export interface LocalReconciliationApplicationDatabaseDecisionSummary {
  readonly decisionCount: number;
  readonly dispositionCounts: Readonly<
    Record<LocalReconciliationReviewDisposition, number>
  >;
}

export interface LocalReconciliationApplicationDomainSummary {
  readonly domain: LocalReconciliationPlanDomain;
  readonly legacy: Readonly<LocalReconciliationApplicationDatabaseDecisionSummary>;
  readonly target: Readonly<LocalReconciliationApplicationDatabaseDecisionSummary>;
  readonly action: LocalReconciliationApplicationDomainAction;
  readonly summaryDigest: string;
}

export interface LocalReconciliationApplicationPlan {
  readonly schema: typeof PLAN_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_application_planned';
  readonly applicationId: string;
  readonly reviewId: string;
  readonly profile: 'edge' | 'standalone';
  readonly preparationDigest: string;
  readonly preparedHeadDigest: string;
  readonly reviewDigest: string;
  readonly authorizationDigest: string;
  readonly decisionSetDigest: string;
  readonly decisionCount: number;
  readonly committedAtMs: number;
  readonly domains: readonly Readonly<LocalReconciliationApplicationDomainSummary>[];
  readonly outcome:
    | 'no_effect_ready'
    | 'adapter_required'
    | 'manual_required'
    | 'adapter_and_manual_required';
  readonly applicationPlanDigest: string;
}

export interface LocalReconciliationApplicationPlanReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_application_planned';
  readonly applicationId: string;
  readonly reviewId: string;
  readonly preparationDigest: string;
  readonly preparedHeadDigest: string;
  readonly reviewDigest: string;
  readonly authorizationDigest: string;
  readonly decisionSetDigest: string;
  readonly decisionCount: number;
  readonly applicationPlanDigest: string;
  readonly outcome: LocalReconciliationApplicationPlan['outcome'];
  readonly domainCount: 8;
  readonly committedAtMs: number;
  readonly receiptDigest: string;
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    configurationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    configurationError(`${label} shape is invalid`);
  }
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function counts(
  value: unknown,
  label: string,
): Readonly<Record<LocalReconciliationReviewDisposition, number>> {
  const selected = object(value, label);
  exact(selected, LOCAL_RECONCILIATION_REVIEW_DISPOSITIONS, label);
  if (
    LOCAL_RECONCILIATION_REVIEW_DISPOSITIONS.some(
      (disposition) => !safeCount(selected[disposition]),
    )
  ) {
    configurationError(`${label} is invalid`);
  }
  return Object.freeze(selected) as Readonly<
    Record<LocalReconciliationReviewDisposition, number>
  >;
}

function sumCounts(
  selected: Readonly<Record<LocalReconciliationReviewDisposition, number>>,
): number {
  const total = LOCAL_RECONCILIATION_REVIEW_DISPOSITIONS.reduce(
    (sum, disposition) => sum + BigInt(selected[disposition]),
    0n,
  );
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    configurationError('application decision count overflowed');
  }
  return Number(total);
}

function databaseSummary(
  selected: Readonly<Record<LocalReconciliationReviewDisposition, number>>,
): Readonly<LocalReconciliationApplicationDatabaseDecisionSummary> {
  const dispositionCounts = Object.freeze({ ...selected });
  return Object.freeze({
    decisionCount: sumCounts(dispositionCounts),
    dispositionCounts,
  });
}

function action(
  selected: Readonly<LocalReconciliationReviewAuthorizationDomainDecisionCounts>,
): LocalReconciliationApplicationDomainAction {
  const adapter =
    selected.legacy.adopt_legacy +
      selected.legacy.retain_both +
      selected.target.retain_both >
    0;
  const manual =
    selected.legacy.defer +
      selected.legacy.manual_external +
      selected.target.defer +
      selected.target.manual_external >
    0;
  if (adapter && manual) return 'adapter_and_manual';
  if (adapter) return 'adapter_required';
  if (manual) return 'manual_external';
  return 'no_effect';
}

function outcome(
  domains: readonly Readonly<LocalReconciliationApplicationDomainSummary>[],
): LocalReconciliationApplicationPlan['outcome'] {
  const adapter = domains.some(
    (domain) =>
      domain.action === 'adapter_required' ||
      domain.action === 'adapter_and_manual',
  );
  const manual = domains.some(
    (domain) =>
      domain.action === 'manual_external' ||
      domain.action === 'adapter_and_manual',
  );
  if (adapter && manual) return 'adapter_and_manual_required';
  if (adapter) return 'adapter_required';
  if (manual) return 'manual_required';
  return 'no_effect_ready';
}

export function buildLocalReconciliationApplicationPlan(
  intent: Readonly<LocalReconciliationApplicationIntent>,
  authorization: Readonly<LocalReconciliationReviewAuthorizationEvidence>,
  committedAtMs: number,
  preparedHeadDigest: string,
): Readonly<LocalReconciliationApplicationPlan> {
  if (
    authorization.domainDecisionCounts.length !== 8 ||
    authorization.decisionCount !==
      authorization.domainDecisionCounts.reduce(
        (total, selected) =>
          total + sumCounts(selected.legacy) + sumCounts(selected.target),
        0,
      )
  ) {
    configurationError('authorization domain decision summary drifted');
  }
  const domains = Object.freeze(
    LOCAL_RECONCILIATION_PLAN_DOMAINS.map((domain, index) => {
      const selected = authorization.domainDecisionCounts[index];
      if (!selected || selected.domain !== domain) {
        configurationError('authorization domain ordering drifted');
      }
      const legacy = databaseSummary(selected.legacy);
      const target = databaseSummary(selected.target);
      const selectedAction = action(selected);
      const summaryPayload = Object.freeze({
        domain,
        legacy,
        target,
        action: selectedAction,
      });
      return Object.freeze({
        ...summaryPayload,
        summaryDigest: cutoverDigest(summaryPayload),
      });
    }),
  );
  const payload = Object.freeze({
    schema: PLAN_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_application_planned' as const,
    applicationId: intent.command.request.applicationId,
    reviewId: intent.command.request.reviewId,
    profile: intent.profile,
    preparationDigest: intent.preparationDigest,
    preparedHeadDigest,
    reviewDigest: intent.reviewDigest,
    authorizationDigest: intent.authorizationDigest,
    decisionSetDigest: intent.decisionSetDigest,
    decisionCount: intent.decisionCount,
    committedAtMs,
    domains,
    outcome: outcome(domains),
  });
  const plan = Object.freeze({
    ...payload,
    applicationPlanDigest: cutoverDigest(payload),
  });
  if (
    Buffer.byteLength(`${JSON.stringify(plan, null, 2)}\n`, 'utf8') >
    MAX_PLAN_BYTES
  ) {
    configurationError('reconciliation application plan exceeds 64 KiB');
  }
  return plan;
}

function normalizeDatabaseSummary(
  value: unknown,
  label: string,
): Readonly<LocalReconciliationApplicationDatabaseDecisionSummary> {
  const selected = object(value, label);
  exact(selected, ['decisionCount', 'dispositionCounts'], label);
  const dispositionCounts = counts(
    selected.dispositionCounts,
    `${label} disposition counts`,
  );
  if (
    !safeCount(selected.decisionCount) ||
    selected.decisionCount !== sumCounts(dispositionCounts)
  ) {
    configurationError(`${label} aggregate drifted`);
  }
  return Object.freeze({
    decisionCount: selected.decisionCount,
    dispositionCounts,
  }) as Readonly<LocalReconciliationApplicationDatabaseDecisionSummary>;
}

function normalizeDomain(
  value: unknown,
  expectedDomain: LocalReconciliationPlanDomain,
): Readonly<LocalReconciliationApplicationDomainSummary> {
  const selected = object(value, 'reconciliation application domain');
  exact(
    selected,
    ['action', 'domain', 'legacy', 'summaryDigest', 'target'],
    'reconciliation application domain',
  );
  const legacy = normalizeDatabaseSummary(selected.legacy, 'legacy summary');
  const target = normalizeDatabaseSummary(selected.target, 'target summary');
  const summaryPayload = Object.freeze({
    domain: selected.domain,
    legacy,
    target,
    action: selected.action,
  });
  if (
    selected.domain !== expectedDomain ||
    ![
      'no_effect',
      'adapter_required',
      'manual_external',
      'adapter_and_manual',
    ].includes(selected.action as string) ||
    typeof selected.summaryDigest !== 'string' ||
    !DIGEST_PATTERN.test(selected.summaryDigest) ||
    selected.summaryDigest !== cutoverDigest(summaryPayload)
  ) {
    configurationError('reconciliation application domain drifted');
  }
  const derivedAction = action({
    domain: expectedDomain,
    legacy: legacy.dispositionCounts,
    target: target.dispositionCounts,
  });
  if (selected.action !== derivedAction) {
    configurationError('reconciliation application domain action drifted');
  }
  return Object.freeze({
    domain: expectedDomain,
    legacy,
    target,
    action: selected.action,
    summaryDigest: selected.summaryDigest,
  }) as Readonly<LocalReconciliationApplicationDomainSummary>;
}

export function normalizeLocalReconciliationApplicationPlan(
  value: unknown,
): Readonly<LocalReconciliationApplicationPlan> {
  const plan = object(value, 'reconciliation application plan');
  exact(
    plan,
    [
      'applicationId',
      'applicationPlanDigest',
      'authorizationDigest',
      'committedAtMs',
      'decisionCount',
      'decisionSetDigest',
      'domains',
      'outcome',
      'preparationDigest',
      'preparedHeadDigest',
      'profile',
      'reviewDigest',
      'reviewId',
      'schema',
      'schemaVersion',
      'state',
    ],
    'reconciliation application plan',
  );
  if (!Array.isArray(plan.domains) || plan.domains.length !== 8) {
    configurationError('reconciliation application domains are invalid');
  }
  const domains = Object.freeze(
    LOCAL_RECONCILIATION_PLAN_DOMAINS.map((domain, index) =>
      normalizeDomain((plan.domains as unknown[])[index], domain),
    ),
  );
  const { applicationPlanDigest, ...rawPayload } = plan;
  const payload = Object.freeze({ ...rawPayload, domains });
  const domainDecisionCount = domains.reduce(
    (total, domain) =>
      total + domain.legacy.decisionCount + domain.target.decisionCount,
    0,
  );
  if (
    plan.schema !== PLAN_SCHEMA ||
    plan.schemaVersion !== 1 ||
    plan.state !== 'reconciliation_application_planned' ||
    typeof plan.applicationId !== 'string' ||
    !UUID_V4_PATTERN.test(plan.applicationId) ||
    typeof plan.reviewId !== 'string' ||
    !UUID_V4_PATTERN.test(plan.reviewId) ||
    (plan.profile !== 'edge' && plan.profile !== 'standalone') ||
    !safeCount(plan.decisionCount) ||
    plan.decisionCount !== domainDecisionCount ||
    !Number.isSafeInteger(plan.committedAtMs) ||
    (plan.committedAtMs as number) < 0 ||
    ![
      'no_effect_ready',
      'adapter_required',
      'manual_required',
      'adapter_and_manual_required',
    ].includes(plan.outcome as string) ||
    plan.outcome !== outcome(domains) ||
    [
      plan.preparationDigest,
      plan.preparedHeadDigest,
      plan.reviewDigest,
      plan.authorizationDigest,
      plan.decisionSetDigest,
      applicationPlanDigest,
    ].some(
      (candidate) =>
        typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate),
    ) ||
    cutoverDigest(payload) !== applicationPlanDigest
  ) {
    configurationError('reconciliation application plan drifted');
  }
  return Object.freeze({
    ...(plan as unknown as LocalReconciliationApplicationPlan),
    domains,
  });
}

export function buildLocalReconciliationApplicationPlanReceipt(
  plan: Readonly<LocalReconciliationApplicationPlan>,
): Readonly<LocalReconciliationApplicationPlanReceipt> {
  const payload = Object.freeze({
    schema: RECEIPT_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_application_planned' as const,
    applicationId: plan.applicationId,
    reviewId: plan.reviewId,
    preparationDigest: plan.preparationDigest,
    preparedHeadDigest: plan.preparedHeadDigest,
    reviewDigest: plan.reviewDigest,
    authorizationDigest: plan.authorizationDigest,
    decisionSetDigest: plan.decisionSetDigest,
    decisionCount: plan.decisionCount,
    applicationPlanDigest: plan.applicationPlanDigest,
    outcome: plan.outcome,
    domainCount: 8 as const,
    committedAtMs: plan.committedAtMs,
  });
  return Object.freeze({ ...payload, receiptDigest: cutoverDigest(payload) });
}

export function normalizeLocalReconciliationApplicationPlanReceipt(
  value: unknown,
): Readonly<LocalReconciliationApplicationPlanReceipt> {
  const receipt = object(value, 'reconciliation application receipt');
  exact(
    receipt,
    [
      'applicationId',
      'applicationPlanDigest',
      'authorizationDigest',
      'committedAtMs',
      'decisionCount',
      'decisionSetDigest',
      'domainCount',
      'outcome',
      'preparationDigest',
      'preparedHeadDigest',
      'receiptDigest',
      'reviewDigest',
      'reviewId',
      'schema',
      'schemaVersion',
      'state',
    ],
    'reconciliation application receipt',
  );
  const { receiptDigest, ...payload } = receipt;
  if (
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.schemaVersion !== 1 ||
    receipt.state !== 'reconciliation_application_planned' ||
    typeof receipt.applicationId !== 'string' ||
    !UUID_V4_PATTERN.test(receipt.applicationId) ||
    typeof receipt.reviewId !== 'string' ||
    !UUID_V4_PATTERN.test(receipt.reviewId) ||
    !safeCount(receipt.decisionCount) ||
    receipt.domainCount !== 8 ||
    !Number.isSafeInteger(receipt.committedAtMs) ||
    (receipt.committedAtMs as number) < 0 ||
    ![
      'no_effect_ready',
      'adapter_required',
      'manual_required',
      'adapter_and_manual_required',
    ].includes(receipt.outcome as string) ||
    [
      receipt.preparationDigest,
      receipt.preparedHeadDigest,
      receipt.reviewDigest,
      receipt.authorizationDigest,
      receipt.decisionSetDigest,
      receipt.applicationPlanDigest,
      receiptDigest,
    ].some(
      (candidate) =>
        typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate),
    ) ||
    cutoverDigest(payload) !== receiptDigest
  ) {
    configurationError('reconciliation application receipt drifted');
  }
  return receipt as unknown as Readonly<LocalReconciliationApplicationPlanReceipt>;
}
