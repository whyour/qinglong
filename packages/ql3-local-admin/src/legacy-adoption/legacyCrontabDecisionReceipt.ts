// Legacy Adoption owns canonical reviewed decision receipts and verification.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import {
  visitLegacyCrontabAdoptionDiagnostics,
  type LegacyCrontabAdoptionClassification,
  type LegacyCrontabAdoptionDiagnostic,
  type LegacyCrontabAdoptionInventory,
} from './legacyCrontabAdoption';

export const MAX_LEGACY_CRONTAB_DECISION_RECEIPT_LIFETIME_MS = 30 * 60 * 1_000;
export const MAX_LEGACY_CRONTAB_DECISION_AUTHENTICATION_AGE_MS = 5 * 60 * 1_000;

export const LEGACY_CRONTAB_ADOPTION_DECISION_DISPOSITIONS = Object.freeze([
  'adopt',
  'adopt_shell_compatibility',
  'skip',
] as const);

export const LEGACY_CRONTAB_ADOPTION_DECISION_REASONS = Object.freeze([
  'reviewed_lossless',
  'reviewed_shell_compatibility',
  'operator_excluded',
  'unsupported_semantics',
  'malformed_source',
  'security_review_required',
] as const);

export type LegacyCrontabAdoptionDecisionDisposition =
  (typeof LEGACY_CRONTAB_ADOPTION_DECISION_DISPOSITIONS)[number];
export type LegacyCrontabAdoptionDecisionReason =
  (typeof LEGACY_CRONTAB_ADOPTION_DECISION_REASONS)[number];

export interface LegacyCrontabAdoptionDecision {
  readonly rowOrdinal: number;
  readonly sourceDigest: string;
  readonly disposition: LegacyCrontabAdoptionDecisionDisposition;
  readonly reason: LegacyCrontabAdoptionDecisionReason;
}

export interface LegacyCrontabAdoptionDecisionCounts {
  readonly adopt: number;
  readonly adopt_shell_compatibility: number;
  readonly skip: number;
}

export interface LegacyCrontabAdoptionDecisionSetEvidence {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-legacy-crontab-adoption-decision-set';
  readonly rowCount: number;
  readonly dispositions: LegacyCrontabAdoptionDecisionCounts;
  readonly decisionDigest: string;
}

export interface LegacyCrontabAdoptionDecisionReceiptPayload {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-legacy-crontab-adoption-decision-receipt';
  readonly decisionId: string;
  readonly profile: 'edge' | 'standalone';
  readonly planDigest: string;
  readonly inventoryDigest: string;
  readonly reviewer: Readonly<SecurityPrincipal>;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly decisions: LegacyCrontabAdoptionDecisionSetEvidence;
}

export interface LegacyCrontabAdoptionDecisionReceipt
  extends LegacyCrontabAdoptionDecisionReceiptPayload {
  readonly receiptDigest: string;
}

export interface CreateLegacyCrontabAdoptionDecisionReceiptContext {
  readonly decisionId: string;
  readonly profile: 'edge' | 'standalone';
  readonly planDigest: string;
  readonly inventoryDigest: string;
  readonly reviewer: SecurityPrincipal;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export class LegacyCrontabAdoptionDecisionReceiptError extends Error {
  readonly code = 'LEGACY_CRONTAB_ADOPTION_DECISION_RECEIPT_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Legacy Crontab adoption decision receipt is invalid: ${message}`);
    this.name = 'LegacyCrontabAdoptionDecisionReceiptError';
  }
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LegacyCrontabAdoptionDecisionReceiptError(
      `${label} must be an object`,
    );
  }
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new LegacyCrontabAdoptionDecisionReceiptError(
      `${label} shape is invalid`,
    );
  }
}

function sha256Json(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(value))
    .digest('hex');
}

function normalizeContext(
  value: CreateLegacyCrontabAdoptionDecisionReceiptContext,
): Readonly<CreateLegacyCrontabAdoptionDecisionReceiptContext> {
  exactKeys(
    value,
    [
      'decisionId',
      'expiresAtMs',
      'inventoryDigest',
      'issuedAtMs',
      'planDigest',
      'profile',
      'reviewer',
    ],
    'receipt context',
  );
  if (!UUID_V7_PATTERN.test(value.decisionId)) {
    throw new LegacyCrontabAdoptionDecisionReceiptError(
      'decisionId must be a lowercase UUIDv7',
    );
  }
  if (value.profile !== 'edge' && value.profile !== 'standalone') {
    throw new LegacyCrontabAdoptionDecisionReceiptError('profile is invalid');
  }
  if (
    !DIGEST_PATTERN.test(value.planDigest) ||
    !DIGEST_PATTERN.test(value.inventoryDigest)
  ) {
    throw new LegacyCrontabAdoptionDecisionReceiptError(
      'plan or inventory digest is invalid',
    );
  }
  if (
    !Number.isSafeInteger(value.issuedAtMs) ||
    value.issuedAtMs < 0 ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs <= value.issuedAtMs ||
    value.expiresAtMs - value.issuedAtMs >
      MAX_LEGACY_CRONTAB_DECISION_RECEIPT_LIFETIME_MS
  ) {
    throw new LegacyCrontabAdoptionDecisionReceiptError(
      'receipt lifetime is invalid',
    );
  }
  let reviewer: Readonly<SecurityPrincipal>;
  try {
    reviewer = normalizeSecurityPrincipal(value.reviewer, value.issuedAtMs);
  } catch (error) {
    throw new LegacyCrontabAdoptionDecisionReceiptError(
      'reviewer is invalid or inactive',
      error,
    );
  }
  if (
    reviewer.subject.type !== 'user' ||
    !['hardware', 'local_console', 'multi_factor'].includes(
      reviewer.assurance,
    ) ||
    value.issuedAtMs - reviewer.authenticatedAtMs >
      MAX_LEGACY_CRONTAB_DECISION_AUTHENTICATION_AGE_MS ||
    value.expiresAtMs > reviewer.expiresAtMs
  ) {
    throw new LegacyCrontabAdoptionDecisionReceiptError(
      'reviewer lacks recent strong user authority',
    );
  }
  return Object.freeze({
    decisionId: value.decisionId,
    profile: value.profile,
    planDigest: value.planDigest,
    inventoryDigest: value.inventoryDigest,
    reviewer,
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs,
  });
}

function normalizeDecision(value: unknown): LegacyCrontabAdoptionDecision {
  exactKeys(
    value,
    ['disposition', 'reason', 'rowOrdinal', 'sourceDigest'],
    'decision',
  );
  if (
    !Number.isSafeInteger(value.rowOrdinal) ||
    (value.rowOrdinal as number) < 1 ||
    !DIGEST_PATTERN.test(value.sourceDigest as string)
  ) {
    throw new LegacyCrontabAdoptionDecisionReceiptError(
      'decision identity is invalid',
    );
  }
  if (
    !LEGACY_CRONTAB_ADOPTION_DECISION_DISPOSITIONS.includes(
      value.disposition as LegacyCrontabAdoptionDecisionDisposition,
    ) ||
    !LEGACY_CRONTAB_ADOPTION_DECISION_REASONS.includes(
      value.reason as LegacyCrontabAdoptionDecisionReason,
    )
  ) {
    throw new LegacyCrontabAdoptionDecisionReceiptError(
      'decision disposition or reason is invalid',
    );
  }
  return Object.freeze({
    rowOrdinal: value.rowOrdinal as number,
    sourceDigest: value.sourceDigest as string,
    disposition: value.disposition as LegacyCrontabAdoptionDecisionDisposition,
    reason: value.reason as LegacyCrontabAdoptionDecisionReason,
  });
}

export function parseLegacyCrontabAdoptionDecision(
  value: unknown,
): LegacyCrontabAdoptionDecision {
  return normalizeDecision(value);
}

function assertDecisionAllowed(
  classification: LegacyCrontabAdoptionClassification,
  decision: LegacyCrontabAdoptionDecision,
): void {
  const pair = `${decision.disposition}:${decision.reason}`;
  const allowed: Readonly<
    Record<LegacyCrontabAdoptionClassification, readonly string[]>
  > = {
    lossless: [
      'adopt:reviewed_lossless',
      'skip:operator_excluded',
      'skip:security_review_required',
    ],
    requires_shell_compatibility: [
      'adopt_shell_compatibility:reviewed_shell_compatibility',
      'skip:operator_excluded',
      'skip:security_review_required',
    ],
    requires_manual_action: [
      'skip:operator_excluded',
      'skip:security_review_required',
      'skip:unsupported_semantics',
    ],
    malformed: ['skip:malformed_source'],
  };
  if (!allowed[classification].includes(pair)) {
    throw new LegacyCrontabAdoptionDecisionReceiptError(
      `decision is not allowed for ${classification}`,
    );
  }
}

function decisionSemanticEvidence(
  diagnostic: LegacyCrontabAdoptionDiagnostic,
  decision: LegacyCrontabAdoptionDecision,
): object {
  return {
    rowOrdinal: diagnostic.rowOrdinal,
    sourceDigest: diagnostic.sourceDigest,
    classification: diagnostic.classification,
    reasons: diagnostic.reasons,
    enabled: diagnostic.enabled,
    triggerCount: diagnostic.triggerCount,
    taskSpecDigest: diagnostic.taskSpecDigest ?? null,
    triggerSpecDigests: diagnostic.triggerSpecDigests ?? [],
    disposition: decision.disposition,
    decisionReason: decision.reason,
  };
}

function decisionIterator(
  value: Iterable<LegacyCrontabAdoptionDecision>,
): Iterator<LegacyCrontabAdoptionDecision> {
  if (
    !value ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    typeof value[Symbol.iterator] !== 'function'
  ) {
    throw new LegacyCrontabAdoptionDecisionReceiptError(
      'decisions must be an iterable',
    );
  }
  const iterator = value[Symbol.iterator]();
  if (!iterator || typeof iterator.next !== 'function') {
    throw new LegacyCrontabAdoptionDecisionReceiptError(
      'decision iterator is invalid',
    );
  }
  return iterator;
}

function summarizeDecisions(
  client: DatabaseSync,
  timezone: string | null,
  expectedInventoryDigest: string,
  values: Iterable<LegacyCrontabAdoptionDecision>,
): Readonly<{
  inventory: LegacyCrontabAdoptionInventory;
  evidence: LegacyCrontabAdoptionDecisionSetEvidence;
}> {
  const iterator = decisionIterator(values);
  const counts: Record<LegacyCrontabAdoptionDecisionDisposition, number> = {
    adopt: 0,
    adopt_shell_compatibility: 0,
    skip: 0,
  };
  const hash = createHash('sha256').update(
    'qinglong3.legacy-crontab-adoption-decision-set.v1\0',
  );
  let complete = false;
  try {
    const inventory = visitLegacyCrontabAdoptionDiagnostics(
      client,
      timezone,
      (diagnostic) => {
        const next = iterator.next();
        if (next.done) {
          throw new LegacyCrontabAdoptionDecisionReceiptError(
            `decision for row ${diagnostic.rowOrdinal} is missing`,
          );
        }
        const decision = normalizeDecision(next.value);
        if (
          decision.rowOrdinal !== diagnostic.rowOrdinal ||
          decision.sourceDigest !== diagnostic.sourceDigest
        ) {
          throw new LegacyCrontabAdoptionDecisionReceiptError(
            `decision for row ${diagnostic.rowOrdinal} does not match source`,
          );
        }
        assertDecisionAllowed(diagnostic.classification, decision);
        counts[decision.disposition] += 1;
        hash
          .update('\0')
          .update(
            JSON.stringify(decisionSemanticEvidence(diagnostic, decision)),
          );
      },
    );
    const extra = iterator.next();
    if (!extra.done) {
      throw new LegacyCrontabAdoptionDecisionReceiptError(
        'decision set contains an extra row',
      );
    }
    if (inventory.inventoryDigest !== expectedInventoryDigest) {
      throw new LegacyCrontabAdoptionDecisionReceiptError(
        'source inventory no longer matches the reviewed plan',
      );
    }
    complete = true;
    return Object.freeze({
      inventory,
      evidence: Object.freeze({
        schemaVersion: 1,
        kind: 'qinglong3-legacy-crontab-adoption-decision-set',
        rowCount: inventory.rowCount,
        dispositions: Object.freeze({ ...counts }),
        decisionDigest: hash.digest('hex'),
      }),
    });
  } catch (error) {
    if (error instanceof LegacyCrontabAdoptionDecisionReceiptError) {
      throw error;
    }
    throw new LegacyCrontabAdoptionDecisionReceiptError(
      'decision set inspection failed',
      error,
    );
  } finally {
    if (!complete && typeof iterator.return === 'function') {
      try {
        iterator.return();
      } catch {
        // The original validation error remains authoritative.
      }
    }
  }
}

export function createLegacyCrontabAdoptionDecisionReceipt(
  client: DatabaseSync,
  timezone: string | null,
  context: CreateLegacyCrontabAdoptionDecisionReceiptContext,
  decisions: Iterable<LegacyCrontabAdoptionDecision>,
): LegacyCrontabAdoptionDecisionReceipt {
  const normalized = normalizeContext(context);
  const summarized = summarizeDecisions(
    client,
    timezone,
    normalized.inventoryDigest,
    decisions,
  );
  const payload: LegacyCrontabAdoptionDecisionReceiptPayload = Object.freeze({
    schemaVersion: 1,
    kind: 'qinglong3-legacy-crontab-adoption-decision-receipt',
    decisionId: normalized.decisionId,
    profile: normalized.profile,
    planDigest: normalized.planDigest,
    inventoryDigest: normalized.inventoryDigest,
    reviewer: normalized.reviewer,
    issuedAtMs: normalized.issuedAtMs,
    expiresAtMs: normalized.expiresAtMs,
    decisions: summarized.evidence,
  });
  return Object.freeze({
    ...payload,
    receiptDigest: sha256Json(
      'qinglong3.legacy-crontab-adoption-decision-receipt.v1',
      payload,
    ),
  });
}

export function verifyLegacyCrontabAdoptionDecisionReceipt(
  client: DatabaseSync,
  timezone: string | null,
  value: unknown,
  decisions: Iterable<LegacyCrontabAdoptionDecision>,
  observedAtMs: number,
): LegacyCrontabAdoptionDecisionReceipt {
  exactKeys(
    value,
    [
      'decisionId',
      'decisions',
      'expiresAtMs',
      'inventoryDigest',
      'issuedAtMs',
      'kind',
      'planDigest',
      'profile',
      'receiptDigest',
      'reviewer',
      'schemaVersion',
    ],
    'receipt',
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'qinglong3-legacy-crontab-adoption-decision-receipt' ||
    !Number.isSafeInteger(observedAtMs) ||
    observedAtMs < (value.issuedAtMs as number) ||
    observedAtMs >= (value.expiresAtMs as number)
  ) {
    throw new LegacyCrontabAdoptionDecisionReceiptError(
      'receipt version or active lifetime is invalid',
    );
  }
  const computed = createLegacyCrontabAdoptionDecisionReceipt(
    client,
    timezone,
    {
      decisionId: value.decisionId as string,
      profile: value.profile as 'edge' | 'standalone',
      planDigest: value.planDigest as string,
      inventoryDigest: value.inventoryDigest as string,
      reviewer: value.reviewer as SecurityPrincipal,
      issuedAtMs: value.issuedAtMs as number,
      expiresAtMs: value.expiresAtMs as number,
    },
    decisions,
  );
  exactKeys(
    value.decisions,
    ['decisionDigest', 'dispositions', 'kind', 'rowCount', 'schemaVersion'],
    'decision set evidence',
  );
  const suppliedDecisions = value.decisions;
  const suppliedCounts = suppliedDecisions.dispositions;
  exactKeys(
    suppliedCounts,
    ['adopt', 'adopt_shell_compatibility', 'skip'],
    'decision disposition counts',
  );
  if (
    value.receiptDigest !== computed.receiptDigest ||
    suppliedDecisions.schemaVersion !== computed.decisions.schemaVersion ||
    suppliedDecisions.kind !== computed.decisions.kind ||
    suppliedDecisions.rowCount !== computed.decisions.rowCount ||
    suppliedDecisions.decisionDigest !== computed.decisions.decisionDigest ||
    suppliedCounts.adopt !== computed.decisions.dispositions.adopt ||
    suppliedCounts.adopt_shell_compatibility !==
      computed.decisions.dispositions.adopt_shell_compatibility ||
    suppliedCounts.skip !== computed.decisions.dispositions.skip
  ) {
    throw new LegacyCrontabAdoptionDecisionReceiptError(
      'receipt content or digest does not match',
    );
  }
  return computed;
}
