import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  openLocalSqliteSecretConfigApplicationDatabase,
  type LocalSecretConfigApplicationReceipt,
  type LocalSecretConfigApplicationSecret,
} from '@qinglong/local-sqlite/secret-config-application';
import {
  encryptLocalSecretEnvelope,
  ownedLocalSecretKeyMaterial,
} from '@qinglong/local-secret';
import {
  LOCAL_SECRET_ALGORITHM,
  normalizeLocalSecretEnvelope,
  type LocalSecretEnvelope,
  type LocalSecretKeyProvider,
} from '@qinglong/runtime-core/local-secret';
import {
  ProjectPolicyEngine,
  ProjectPolicyUnavailableError,
} from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyDecision,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

import {
  visitLegacyEnvironmentAdoption,
  type LegacyEnvironmentCandidate,
} from './environmentInspection';

const DIGEST = /^[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STRONG_USER_ASSURANCES = new Set(['local_console']);

export type ReconciliationSecretConfigDecisionDisposition =
  | 'apply_active_binding'
  | 'preserve_disabled'
  | 'skip';

export interface ReconciliationSecretConfigDecision {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-local-reconciliation-secret-config-decision';
  readonly candidateOrdinal: number;
  readonly candidateDigest: string;
  readonly disposition: ReconciliationSecretConfigDecisionDisposition;
  readonly reason: string;
}

export interface ReconciliationSecretConfigRequirement {
  readonly candidateOrdinal: number;
  readonly candidateType: 'active_binding' | 'disabled_preservation';
  readonly candidateDigest: string;
  readonly sourceSetDigest: string;
  readonly proposedSecretName: string;
  readonly requirement:
    | 'review_apply_binding'
    | 'review_preserve_disabled'
    | 'review_skip_conflict';
}

export interface PreparedReconciliationSecretConfigMaterial {
  readonly ordinal: number;
  readonly disposition: 'active_binding' | 'disabled_preservation';
  readonly candidateDigest: string;
  readonly sourceSetDigest: string;
  readonly environmentName?: string;
  readonly envelope: Readonly<LocalSecretEnvelope>;
}

export interface PrepareReconciliationSecretConfigApplicationOptions {
  readonly sourceClient: DatabaseSync;
  readonly profile: 'edge' | 'standalone';
  readonly projectId: string;
  readonly mutationId: string;
  readonly appliedAtMs: number;
  readonly expectedLegacyInventoryDigest: string;
  readonly decisions: readonly Readonly<ReconciliationSecretConfigDecision>[];
  readonly openRequirements: () => Iterable<ReconciliationSecretConfigRequirement>;
  readonly keyProvider: LocalSecretKeyProvider;
  readonly visitMaterial: (
    material: Readonly<PreparedReconciliationSecretConfigMaterial>,
  ) => void;
}

export interface PreparedReconciliationSecretConfigApplicationEvidence {
  readonly legacyInventoryDigest: string;
  readonly secretCount: number;
  readonly activeBindingCount: number;
  readonly disabledPreservationCount: number;
  readonly materialSetDigest: string;
}

export interface ApplyPreparedReconciliationSecretConfigApplicationOptions {
  readonly databasePath: string;
  readonly profile: 'edge' | 'standalone';
  readonly projectId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly secretConfigPlanDigest: string;
  readonly decisionDigest: string;
  readonly candidateSetDigest: string;
  readonly automationAdoptionSetDigest: string;
  readonly materials: readonly Readonly<PreparedReconciliationSecretConfigMaterial>[];
  readonly principal: Readonly<SecurityPrincipal>;
  readonly appliedAtMs: number;
  readonly authorizationAtMs?: number;
  readonly busyTimeoutMs?: number;
  readonly confirmAuthenticationAuthority: () => void | Promise<void>;
  readonly confirmPreparedAuthority: () => void | Promise<void>;
}

export interface ApplyPreparedReconciliationSecretConfigApplicationResult {
  readonly status: 'inserted' | 'existing';
  readonly receipt: Readonly<LocalSecretConfigApplicationReceipt>;
}

export class ReconciliationSecretConfigApplicationError extends Error {
  readonly code = 'RECONCILIATION_SECRET_CONFIG_APPLICATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Reconciliation Secret/Config application is invalid: ${message}`);
    this.name = 'ReconciliationSecretConfigApplicationError';
  }
}

export class ReconciliationSecretConfigApplicationAuthenticationError extends Error {
  readonly code =
    'RECONCILIATION_SECRET_CONFIG_APPLICATION_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Reconciliation Secret/Config application requires its reviewer');
    this.name = 'ReconciliationSecretConfigApplicationAuthenticationError';
  }
}

export class ReconciliationSecretConfigApplicationAuthorizationError extends Error {
  readonly code = 'RECONCILIATION_SECRET_CONFIG_APPLICATION_FORBIDDEN';

  constructor() {
    super('Reconciliation Secret/Config application is not authorized');
    this.name = 'ReconciliationSecretConfigApplicationAuthorizationError';
  }
}

export class ReconciliationSecretConfigApplicationUnavailableError extends Error {
  readonly code = 'RECONCILIATION_SECRET_CONFIG_APPLICATION_UNAVAILABLE';

  constructor(readonly cause?: unknown) {
    super('Reconciliation Secret/Config application is unavailable');
    this.name = 'ReconciliationSecretConfigApplicationUnavailableError';
  }
}

function fail(message: string, cause?: unknown): never {
  throw new ReconciliationSecretConfigApplicationError(message, cause);
}

function exact(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
}

function deterministicMutationId(batch: string, identity: string): string {
  const bytes = createHash('sha256')
    .update('qinglong3.secret-config-application-material.v1\0')
    .update(batch)
    .update('\0')
    .update(identity)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function iterator<T>(value: Iterable<T>, label: string): Iterator<T> {
  if (
    !value ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    typeof value[Symbol.iterator] !== 'function'
  ) {
    return fail(`${label} is invalid`);
  }
  const selected = value[Symbol.iterator]();
  if (!selected || typeof selected.next !== 'function') {
    return fail(`${label} is invalid`);
  }
  return selected;
}

function normalizeRequirement(
  value: ReconciliationSecretConfigRequirement,
): Readonly<ReconciliationSecretConfigRequirement> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exact(value, [
      'candidateDigest',
      'candidateOrdinal',
      'candidateType',
      'proposedSecretName',
      'requirement',
      'sourceSetDigest',
    ]) ||
    !Number.isSafeInteger(value.candidateOrdinal) ||
    value.candidateOrdinal < 1 ||
    (value.candidateType !== 'active_binding' &&
      value.candidateType !== 'disabled_preservation') ||
    !DIGEST.test(value.candidateDigest) ||
    !DIGEST.test(value.sourceSetDigest) ||
    typeof value.proposedSecretName !== 'string' ||
    value.proposedSecretName.length < 1 ||
    ![
      'review_apply_binding',
      'review_preserve_disabled',
      'review_skip_conflict',
    ].includes(value.requirement)
  ) {
    return fail('plan requirement is invalid');
  }
  return Object.freeze({ ...value });
}

function normalizeDecision(
  value: ReconciliationSecretConfigDecision,
  ordinal: number,
): Readonly<ReconciliationSecretConfigDecision> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exact(value, [
      'candidateDigest',
      'candidateOrdinal',
      'disposition',
      'kind',
      'reason',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'qinglong3-local-reconciliation-secret-config-decision' ||
    value.candidateOrdinal !== ordinal ||
    !DIGEST.test(value.candidateDigest) ||
    !['apply_active_binding', 'preserve_disabled', 'skip'].includes(
      value.disposition,
    ) ||
    typeof value.reason !== 'string'
  ) {
    return fail('review decision is invalid');
  }
  return Object.freeze({ ...value });
}

function assertDecision(
  decision: Readonly<ReconciliationSecretConfigDecision>,
  requirement: Readonly<ReconciliationSecretConfigRequirement>,
  candidate: Readonly<LegacyEnvironmentCandidate>,
): void {
  const expectedDisposition =
    requirement.requirement === 'review_apply_binding'
      ? 'apply_active_binding'
      : requirement.requirement === 'review_preserve_disabled'
      ? 'preserve_disabled'
      : 'skip';
  const sourceSetDigest =
    candidate.kind === 'active_binding'
      ? candidate.sourceSetDigest
      : candidate.sourceDigest;
  if (
    decision.candidateOrdinal !== requirement.candidateOrdinal ||
    decision.candidateDigest !== requirement.candidateDigest ||
    decision.candidateDigest !== candidate.candidateDigest ||
    decision.disposition !== expectedDisposition ||
    requirement.candidateType !== candidate.kind ||
    requirement.sourceSetDigest !== sourceSetDigest
  ) {
    fail('decision, plan and sealed candidate are detached');
  }
}

export function normalizePreparedReconciliationSecretConfigMaterial(
  value: unknown,
): Readonly<PreparedReconciliationSecretConfigMaterial> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('prepared material must be an object');
  }
  const selected = value as Record<string, unknown>;
  const active = selected.disposition === 'active_binding';
  if (
    !exact(selected, [
      'candidateDigest',
      'disposition',
      'envelope',
      ...(active ? ['environmentName'] : []),
      'ordinal',
      'sourceSetDigest',
    ]) ||
    !Number.isSafeInteger(selected.ordinal) ||
    (selected.ordinal as number) < 1 ||
    (!active && selected.disposition !== 'disabled_preservation') ||
    !DIGEST.test(selected.candidateDigest as string) ||
    !DIGEST.test(selected.sourceSetDigest as string) ||
    (active &&
      (typeof selected.environmentName !== 'string' ||
        selected.environmentName.length < 1))
  ) {
    return fail('prepared material is invalid');
  }
  let envelope: Readonly<LocalSecretEnvelope>;
  try {
    envelope = normalizeLocalSecretEnvelope(
      selected.envelope as LocalSecretEnvelope,
    );
  } catch (error) {
    return fail('prepared material envelope is invalid', error);
  }
  return Object.freeze({
    ordinal: selected.ordinal as number,
    disposition: selected.disposition as
      | 'active_binding'
      | 'disabled_preservation',
    candidateDigest: selected.candidateDigest as string,
    sourceSetDigest: selected.sourceSetDigest as string,
    ...(active ? { environmentName: selected.environmentName as string } : {}),
    envelope,
  });
}

export async function prepareReconciliationSecretConfigApplication(
  options: Readonly<PrepareReconciliationSecretConfigApplicationOptions>,
): Promise<Readonly<PreparedReconciliationSecretConfigApplicationEvidence>> {
  if (
    !options ||
    typeof options !== 'object' ||
    (options.profile !== 'edge' && options.profile !== 'standalone') ||
    !UUID_V4.test(options.mutationId) ||
    !DIGEST.test(options.expectedLegacyInventoryDigest) ||
    !Number.isSafeInteger(options.appliedAtMs) ||
    options.appliedAtMs < 0 ||
    !Array.isArray(options.decisions) ||
    options.decisions.length < 1 ||
    typeof options.openRequirements !== 'function' ||
    typeof options.visitMaterial !== 'function' ||
    !options.keyProvider ||
    typeof options.keyProvider.active !== 'function'
  ) {
    fail('preparation options are invalid');
  }
  const requirements = iterator(
    options.openRequirements(),
    'plan requirement stream',
  );
  const decisions = options.decisions.map((decision, index) =>
    normalizeDecision(decision, index + 1),
  );
  if (decisions.some((decision) => decision.disposition === 'skip')) {
    fail('manual-required decision cannot enter application');
  }
  const material = ownedLocalSecretKeyMaterial(
    await options.keyProvider.active(),
  );
  const materialHash = createHash('sha256').update(
    'qinglong3.reconciliation-secret-config-material-set.v1\0',
  );
  let secretCount = 0;
  let activeBindingCount = 0;
  let disabledPreservationCount = 0;
  try {
    const inventory = visitLegacyEnvironmentAdoption(options.sourceClient, {
      profile: options.profile,
      visitCandidate(candidate) {
        const requirementNext = requirements.next();
        if (requirementNext.done) fail('sealed source exceeds plan candidates');
        const requirement = normalizeRequirement(requirementNext.value);
        const decision = decisions[requirement.candidateOrdinal - 1];
        if (!decision) fail('decision stream is shorter than its plan');
        assertDecision(decision, requirement, candidate);
        if (decision.disposition === 'skip') return;
        secretCount += 1;
        const secretMutationId = deterministicMutationId(
          options.mutationId,
          `${requirement.candidateOrdinal}\0${requirement.candidateDigest}`,
        );
        const envelope = encryptLocalSecretEnvelope(
          {
            projectId: options.projectId,
            name: requirement.proposedSecretName,
            version: 1,
            mutationId: secretMutationId,
            keyId: material.keyId,
            algorithm: LOCAL_SECRET_ALGORITHM,
            createdAtMs: options.appliedAtMs,
          },
          candidate.value,
          material.key,
        );
        const prepared = Object.freeze({
          ordinal: secretCount,
          disposition: candidate.kind,
          candidateDigest: candidate.candidateDigest,
          sourceSetDigest: requirement.sourceSetDigest,
          ...(candidate.kind === 'active_binding'
            ? { environmentName: candidate.environmentName }
            : {}),
          envelope,
        });
        materialHash.update('\0').update(JSON.stringify(prepared));
        options.visitMaterial(prepared);
        if (candidate.kind === 'active_binding') activeBindingCount += 1;
        else disabledPreservationCount += 1;
      },
    });
    const extraRequirement = requirements.next();
    if (!extraRequirement.done || decisions.length !== secretCount) {
      fail('decision, plan and sealed candidate counts differ');
    }
    if (inventory.inventoryDigest !== options.expectedLegacyInventoryDigest) {
      fail('sealed legacy inventory drifted');
    }
    return Object.freeze({
      legacyInventoryDigest: inventory.inventoryDigest,
      secretCount,
      activeBindingCount,
      disabledPreservationCount,
      materialSetDigest: materialHash.digest('hex'),
    });
  } finally {
    material.key.fill(0);
  }
}

function strongPrincipal(
  value: Readonly<SecurityPrincipal>,
  atMs: number,
): Readonly<SecurityPrincipal> {
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(value, atMs);
  } catch {
    throw new ReconciliationSecretConfigApplicationAuthenticationError();
  }
  if (
    principal.subject.type !== 'user' ||
    !STRONG_USER_ASSURANCES.has(principal.assurance)
  ) {
    throw new ReconciliationSecretConfigApplicationAuthenticationError();
  }
  return principal;
}

function audit(
  eventId: string,
  operationId: 'secret-config.apply' | 'secret.create',
  options: Readonly<ApplyPreparedReconciliationSecretConfigApplicationOptions>,
  principal: Readonly<SecurityPrincipal>,
  decision: Readonly<SecurityPolicyDecision>,
): Readonly<SecurityAuditRecord> {
  return normalizeSecurityAuditRecord({
    eventId,
    requestId: options.requestId,
    operationId,
    projectId: options.projectId,
    subject: principal.subject,
    authenticationId: principal.authenticationId,
    outcome: 'allowed',
    reasons: decision.reasons,
    fence: decision.fence,
    occurredAtMs: options.appliedAtMs,
  });
}

export async function applyPreparedReconciliationSecretConfigApplication(
  options: Readonly<ApplyPreparedReconciliationSecretConfigApplicationOptions>,
): Promise<Readonly<ApplyPreparedReconciliationSecretConfigApplicationResult>> {
  if (
    !options ||
    typeof options !== 'object' ||
    !UUID_V4.test(options.mutationId) ||
    !REQUEST_ID.test(options.requestId) ||
    (options.profile !== 'edge' && options.profile !== 'standalone') ||
    ![
      options.secretConfigPlanDigest,
      options.decisionDigest,
      options.candidateSetDigest,
      options.automationAdoptionSetDigest,
    ].every((entry) => DIGEST.test(entry)) ||
    !Array.isArray(options.materials) ||
    options.materials.length < 1 ||
    !Number.isSafeInteger(options.appliedAtMs) ||
    options.appliedAtMs < 0 ||
    (options.authorizationAtMs !== undefined &&
      (!Number.isSafeInteger(options.authorizationAtMs) ||
        options.authorizationAtMs < options.appliedAtMs)) ||
    typeof options.confirmAuthenticationAuthority !== 'function' ||
    typeof options.confirmPreparedAuthority !== 'function'
  ) {
    fail('apply options are invalid');
  }
  const materials = options.materials.map(
    normalizePreparedReconciliationSecretConfigMaterial,
  );
  if (materials.some((entry, index) => entry.ordinal !== index + 1)) {
    fail('prepared material ordinal drifted');
  }
  const database = await openLocalSqliteSecretConfigApplicationDatabase({
    databasePath: options.databasePath,
    profile: options.profile,
    ...(options.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: options.busyTimeoutMs }),
  });
  try {
    const principal = strongPrincipal(
      options.principal,
      options.authorizationAtMs ?? options.appliedAtMs,
    );
    await options.confirmAuthenticationAuthority();
    const policy = new ProjectPolicyEngine(database.projectPolicy);
    let decision: Readonly<SecurityPolicyDecision>;
    try {
      decision = await policy.authorize(
        principal,
        options.projectId,
        'secret.manage',
      );
    } catch (error) {
      if (error instanceof ProjectPolicyUnavailableError) {
        throw new ReconciliationSecretConfigApplicationUnavailableError(error);
      }
      throw error;
    }
    if (decision.effect !== 'allow') {
      throw new ReconciliationSecretConfigApplicationAuthorizationError();
    }
    if (!decision.fence || decision.fence.bindingVersion === null) {
      throw new ReconciliationSecretConfigApplicationUnavailableError();
    }
    const secrets: Readonly<LocalSecretConfigApplicationSecret>[] =
      materials.map((entry) =>
        Object.freeze({
          ...entry,
          audit: audit(
            entry.envelope.mutationId,
            'secret.create',
            options,
            principal,
            decision,
          ),
        }),
      );
    const publication = await database.publisher.publish({
      mutationId: options.mutationId,
      projectId: options.projectId,
      profile: options.profile,
      secretConfigPlanDigest: options.secretConfigPlanDigest,
      decisionDigest: options.decisionDigest,
      candidateSetDigest: options.candidateSetDigest,
      automationAdoptionSetDigest: options.automationAdoptionSetDigest,
      subject: principal.subject,
      fence: decision.fence,
      audit: audit(
        options.mutationId,
        'secret-config.apply',
        options,
        principal,
        decision,
      ),
      secrets,
      appliedAtMs: options.appliedAtMs,
      async confirmExternalAuthority() {
        await options.confirmAuthenticationAuthority();
        await options.confirmPreparedAuthority();
      },
    });
    return Object.freeze({
      status: publication.status,
      receipt: publication.application.receipt,
    });
  } catch (error) {
    if (
      error instanceof ReconciliationSecretConfigApplicationError ||
      error instanceof
        ReconciliationSecretConfigApplicationAuthenticationError ||
      error instanceof
        ReconciliationSecretConfigApplicationAuthorizationError ||
      error instanceof ReconciliationSecretConfigApplicationUnavailableError
    ) {
      throw error;
    }
    throw new ReconciliationSecretConfigApplicationUnavailableError(error);
  } finally {
    await database.close();
  }
}
