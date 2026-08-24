import { LocalDeploymentConfigurationError } from '../../foundation/error';
import { cutoverDigest } from '../../cutover/targetEvidence';
import {
  LOCAL_RECONCILIATION_PLAN_DOMAINS,
  type LocalReconciliationPlanDomain,
} from '../planning/contract';

const RECEIPT_SCHEMA = 'qinglong3-local-reconciliation-completion-receipt';
const DIGEST = /^[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface LocalReconciliationCompletionDomainEvidence {
  readonly domain: LocalReconciliationPlanDomain;
  readonly action: 'no_effect' | 'adapter_required';
  readonly evidenceKind:
    | 'application_summary'
    | 'automation_apply'
    | 'run_history_preservation'
    | 'secret_config_application';
  readonly evidenceDigest: string;
}

export interface LocalReconciliationCompletionReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly schemaVersion: 1 | 2 | 3;
  readonly state: 'reconciliation_completed';
  readonly completionId: string;
  readonly applicationId: string;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly cutoverId: string;
  readonly generation: number;
  readonly activationDigest: string;
  readonly applicationPlanDigest: string;
  readonly sourceHeadDigest: string;
  readonly domains: readonly Readonly<LocalReconciliationCompletionDomainEvidence>[];
  readonly adapterCount: 0 | 1 | 2 | 3;
  readonly completedAtMs: number;
  readonly completionDigest: string;
}

function fail(message: string): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation completion evidence ${message}`,
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

function domainEvidence(
  value: unknown,
  expectedDomain: LocalReconciliationPlanDomain,
  schemaVersion: 1 | 2 | 3,
): Readonly<LocalReconciliationCompletionDomainEvidence> {
  const selected = exact(
    value,
    ['action', 'domain', 'evidenceDigest', 'evidenceKind'],
    'domain evidence',
  );
  const noEffect =
    selected.action === 'no_effect' &&
    selected.evidenceKind === 'application_summary';
  const automation =
    expectedDomain === 'automation' &&
    selected.action === 'adapter_required' &&
    selected.evidenceKind === 'automation_apply';
  const runHistory =
    schemaVersion >= 2 &&
    expectedDomain === 'run_history' &&
    selected.action === 'adapter_required' &&
    selected.evidenceKind === 'run_history_preservation';
  const secretConfig =
    schemaVersion === 3 &&
    expectedDomain === 'secret_and_config' &&
    selected.action === 'adapter_required' &&
    selected.evidenceKind === 'secret_config_application';
  if (
    selected.domain !== expectedDomain ||
    (!noEffect && !automation && !runHistory && !secretConfig) ||
    typeof selected.evidenceDigest !== 'string' ||
    !DIGEST.test(selected.evidenceDigest)
  ) {
    fail('domain evidence is invalid');
  }
  return Object.freeze({
    domain: expectedDomain,
    action: selected.action,
    evidenceKind: selected.evidenceKind,
    evidenceDigest: selected.evidenceDigest,
  }) as Readonly<LocalReconciliationCompletionDomainEvidence>;
}

export function buildLocalReconciliationCompletionReceipt(
  input: Omit<
    LocalReconciliationCompletionReceipt,
    'schema' | 'schemaVersion' | 'state' | 'completionDigest'
  >,
): Readonly<LocalReconciliationCompletionReceipt> {
  const schemaVersion = input.domains.some(
    (domain) => domain.evidenceKind === 'secret_config_application',
  )
    ? (3 as const)
    : input.domains.some(
        (domain) => domain.evidenceKind === 'run_history_preservation',
      )
    ? (2 as const)
    : (1 as const);
  const payload = Object.freeze({
    schema: RECEIPT_SCHEMA,
    schemaVersion,
    state: 'reconciliation_completed' as const,
    ...input,
  });
  return Object.freeze({
    ...payload,
    completionDigest: cutoverDigest(payload),
  });
}

export function normalizeLocalReconciliationCompletionReceipt(
  value: unknown,
): Readonly<LocalReconciliationCompletionReceipt> {
  const selected = exact(
    value,
    [
      'activationDigest',
      'adapterCount',
      'applicationId',
      'applicationPlanDigest',
      'completedAtMs',
      'completionDigest',
      'completionId',
      'cutoverId',
      'domains',
      'generation',
      'instanceId',
      'profile',
      'schema',
      'schemaVersion',
      'sourceHeadDigest',
      'state',
    ],
    'receipt',
  );
  if (!Array.isArray(selected.domains) || selected.domains.length !== 8) {
    fail('receipt domain catalog is invalid');
  }
  if (
    selected.schemaVersion !== 1 &&
    selected.schemaVersion !== 2 &&
    selected.schemaVersion !== 3
  ) {
    fail('receipt schema version is invalid');
  }
  const schemaVersion = selected.schemaVersion;
  const rawDomains = selected.domains as unknown[];
  const domains = Object.freeze(
    LOCAL_RECONCILIATION_PLAN_DOMAINS.map((domain, index) =>
      domainEvidence(rawDomains[index], domain, schemaVersion),
    ),
  );
  const adapterCount = domains.filter(
    (domain) => domain.action === 'adapter_required',
  ).length;
  const { completionDigest, ...raw } = selected;
  const normalized = Object.freeze({ ...raw, domains });
  if (
    selected.schema !== RECEIPT_SCHEMA ||
    (schemaVersion === 1 &&
      domains.some((domain) =>
        ['run_history_preservation', 'secret_config_application'].includes(
          domain.evidenceKind,
        ),
      )) ||
    (schemaVersion === 2 &&
      (!domains.some(
        (domain) => domain.evidenceKind === 'run_history_preservation',
      ) ||
        domains.some(
          (domain) => domain.evidenceKind === 'secret_config_application',
        ))) ||
    (schemaVersion === 3 &&
      !domains.some(
        (domain) => domain.evidenceKind === 'secret_config_application',
      )) ||
    selected.state !== 'reconciliation_completed' ||
    typeof selected.completionId !== 'string' ||
    !UUID_V4.test(selected.completionId) ||
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
      completionDigest,
    ].every(
      (candidate) => typeof candidate === 'string' && DIGEST.test(candidate),
    ) ||
    ![0, 1, 2, 3].includes(selected.adapterCount as number) ||
    selected.adapterCount !== adapterCount ||
    !Number.isSafeInteger(selected.completedAtMs) ||
    (selected.completedAtMs as number) < 0 ||
    cutoverDigest(normalized) !== completionDigest
  ) {
    fail('receipt binding is invalid');
  }
  return Object.freeze({
    ...normalized,
    completionDigest,
  }) as unknown as Readonly<LocalReconciliationCompletionReceipt>;
}

export function localReconciliationCompletionReceiptContents(
  receipt: Readonly<LocalReconciliationCompletionReceipt>,
): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}
