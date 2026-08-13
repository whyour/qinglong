import type { DatabaseSync } from 'node:sqlite';

import {
  normalizePluginPackageInstallProposal,
  type PluginPackageInstallProposal,
} from '@qinglong/runtime-core/plugin-package-proposal';
import {
  normalizePluginPackageLock,
  normalizePluginPackageInstallRecord,
  type PluginPackageInstallRecord,
  type PluginPackageLock,
} from '@qinglong/runtime-core/plugin-package-install';
import { createPluginPackageResourceGenerationFromReferences } from '@qinglong/runtime-core/plugin-package-resource-generation';
import { createPluginPackageSecretBindingTarget } from '@qinglong/runtime-core/plugin-package-secret-binding';
import {
  createPluginPackageSecretBindingFromPlan,
  createPluginPackageSecretBindingPlan,
  normalizePluginPackageSecretBindingPlan,
  type PluginPackageSecretBindingPlan,
} from '@qinglong/runtime-core/plugin-package-secret-binding-plan';
import {
  createPluginPackageSecretBindingTransitionPlan,
  normalizePluginPackageSecretBindingTransitionPlan,
  type PluginPackageSecretBindingTransitionPlan,
} from '@qinglong/runtime-core/plugin-package-secret-binding-transition-plan';
import {
  createPluginPackageSecretBindingFromTransitionPlan,
  createPluginPackageSecretBindingTransitionReceipt,
} from '@qinglong/runtime-core/plugin-package-secret-binding-transition-receipt';
import { parseSecretRef } from '@qinglong/runtime-core/secret-reference';
import type { SecurityPrincipal } from '@qinglong/runtime-core/security';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyFence,
} from '@qinglong/runtime-core/security';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';

import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';
import { LocalSqliteProjectPolicyRepository } from '../../security/projectPolicyRepository';
import {
  insertLocalSecurityAudit,
  localSecurityAuditFromRow,
  LOCAL_SECURITY_AUDIT_SELECT,
  sameSecurityAuditSemantic,
} from '../../security/securityPersistence';
import { LocalSqlitePluginPackageSecretBindingRepository } from './repository';
import { LocalSqlitePluginPackageSecretBindingTransitionReceiptRepository } from './transitionReceiptRepository';

type Row = Record<string, unknown>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PlanLocalPluginPackageSecretBindingRequest {
  readonly projectId: string;
  readonly packageName: string;
  readonly assignments: readonly Readonly<{
    name: string;
    secretRef: string | null;
  }>[];
  readonly principal: SecurityPrincipal;
  readonly plannedAtMs: number;
}

export interface ExecuteLocalPluginPackageSecretBindingRequest {
  readonly plan: PluginPackageSecretBindingPlan;
  readonly auditEventId: string;
  readonly principal: SecurityPrincipal;
  readonly confirmAuthorization: () => void | Promise<void>;
}

export interface PlanLocalPluginPackageSecretBindingTransitionRequest {
  readonly projectId: string;
  readonly packageName: string;
  readonly assignments: readonly Readonly<{
    name: string;
    secretRef: string | null;
  }>[];
  readonly principal: SecurityPrincipal;
  readonly plannedAtMs: number;
}

export interface ExecuteLocalPluginPackageSecretBindingTransitionRequest {
  readonly plan: PluginPackageSecretBindingTransitionPlan;
  readonly auditEventId: string;
  readonly principal: SecurityPrincipal;
  readonly confirmAuthorization: () => void | Promise<void>;
}

export interface LocalPluginPackageSecretBindingService {
  plan(
    request: PlanLocalPluginPackageSecretBindingRequest,
  ): Promise<Readonly<PluginPackageSecretBindingPlan>>;
  execute(request: ExecuteLocalPluginPackageSecretBindingRequest): Promise<
    Readonly<{
      status: 'created' | 'existing';
      bindingDigest: string;
      generationDigest: string;
    }>
  >;
  planTransition(
    request: PlanLocalPluginPackageSecretBindingTransitionRequest,
  ): Promise<Readonly<PluginPackageSecretBindingTransitionPlan>>;
  executeTransition(
    request: ExecuteLocalPluginPackageSecretBindingTransitionRequest,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      transitionDigest: string;
      receiptDigest: string;
      bindingDigest: string | null;
      generationDigest: string;
    }>
  >;
}

export class LocalPluginPackageSecretBindingConflictError extends Error {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_SECRET_BINDING_CONFLICT';

  constructor(message: string) {
    super(
      `Local Plugin Package Secret binding conflicts with state: ${message}`,
    );
    this.name = 'LocalPluginPackageSecretBindingConflictError';
  }
}

export class LocalPluginPackageSecretBindingUnavailableError extends Error {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_SECRET_BINDING_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Local Plugin Package Secret binding is unavailable', options);
    this.name = 'LocalPluginPackageSecretBindingUnavailableError';
  }
}

function rowText(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string')
    throw new LocalPluginPackageSecretBindingUnavailableError();
  return value;
}

function identity(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as number;
}

function loadCurrent(
  client: DatabaseSync,
  projectId: string,
  packageName: string,
): Readonly<{
  record: PluginPackageInstallRecord;
  lock: PluginPackageLock;
  proposal: PluginPackageInstallProposal;
}> {
  const row = client
    .prepare(
      `SELECT install.record_json AS "recordJson",
              install.lock_json AS "lockJson",
              proposal.proposal_json AS "proposalJson"
       FROM "QingLong3PluginPackageInstallHeads" AS head
       JOIN "QingLong3PluginPackageInstalls" AS install
         ON install.installation_id = head.installation_id
       JOIN "QingLong3PluginPackageAdmissionReceipts" AS admission
         ON admission.installation_id = install.installation_id
       JOIN "QingLong3PluginPackageInstallProposals" AS proposal
         ON proposal.action_ref = admission.action_ref
       LEFT JOIN "QingLong3PluginPackageQuarantineEvents" AS quarantine
         ON quarantine.project_id = install.project_id
        AND quarantine.package_name = install.package_name
        AND quarantine.installation_id = install.installation_id
        AND quarantine.lock_digest = install.lock_digest
       LEFT JOIN "QingLong3PluginPackageLifecycleHeads" AS lifecycle
         ON lifecycle.project_id = install.project_id
        AND lifecycle.package_name = install.package_name
        AND lifecycle.installation_id = install.installation_id
        AND lifecycle.lock_digest = install.lock_digest
       WHERE head.project_id = ?
         AND head.package_name = ?
         AND install.state = 'active'
         AND install.active_lock_digest = install.lock_digest
         AND quarantine.event_digest IS NULL
         AND COALESCE(lifecycle.disposition, 'active') = 'active'
       LIMIT 2`,
    )
    .all(projectId, packageName) as Row[];
  if (row.length !== 1) {
    throw new LocalPluginPackageSecretBindingConflictError(
      'current active Package authority is absent or ambiguous',
    );
  }
  try {
    const record = normalizePluginPackageInstallRecord(
      JSON.parse(rowText(row[0]!, 'recordJson')),
    );
    const lock = normalizePluginPackageLock(
      JSON.parse(rowText(row[0]!, 'lockJson')),
    );
    const proposal = normalizePluginPackageInstallProposal(
      JSON.parse(rowText(row[0]!, 'proposalJson')),
    );
    if (
      record.projectId !== projectId ||
      record.packageName !== packageName ||
      record.lockDigest !== lock.lockDigest ||
      proposal.actionDigest !== lock.approval.actionDigest ||
      proposal.previewDigest !== lock.approval.previewDigest ||
      proposal.actionInput.projectId !== projectId ||
      proposal.actionInput.manifest.metadata.name !== packageName ||
      proposal.actionInput.targetGeneration !== record.targetGeneration ||
      proposal.actionInput.source.contentDigest !== lock.source.contentDigest ||
      proposal.actionInput.manifest.metadata.version !==
        record.packageVersion ||
      proposal.actionInput.manifest.spec.permissions.secrets.length === 0 ||
      !proposal.actionInput.manifest.spec.permissions.tools.includes(
        'secret.use',
      )
    ) {
      throw new Error('current Package provenance drift');
    }
    return Object.freeze({ record, lock, proposal });
  } catch (error) {
    if (error instanceof LocalPluginPackageSecretBindingConflictError)
      throw error;
    throw new LocalPluginPackageSecretBindingUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  }
}

function generationFrom(current: ReturnType<typeof loadCurrent>) {
  const { record, lock } = current;
  return createPluginPackageResourceGenerationFromReferences({
    installationId: record.installationId,
    projectId: record.projectId,
    packageName: record.packageName,
    lockDigest: record.lockDigest,
    generation: record.targetGeneration,
    previousActiveLockDigest: record.previousActiveLockDigest,
    contentDigest: lock.source.contentDigest,
    resources: lock.resources,
  });
}

function loadTransition(
  client: DatabaseSync,
  projectId: string,
  packageName: string,
): Readonly<{
  previous: ReturnType<typeof loadCurrent>;
  next: ReturnType<typeof loadCurrent>;
  previousAttemptGeneration: number;
}> {
  const rows = client
    .prepare(
      `SELECT current.record_json AS "nextRecordJson",
              current.lock_json AS "nextLockJson",
              current_proposal.proposal_json AS "nextProposalJson",
              previous.record_json AS "previousRecordJson",
              previous.lock_json AS "previousLockJson",
              previous_proposal.proposal_json AS "previousProposalJson",
              (
                SELECT MAX(history.target_generation)
                  FROM "QingLong3PluginPackageInstalls" AS history
                 WHERE history.project_id = current.project_id
                   AND history.package_name = current.package_name
                   AND history.target_generation < current.target_generation
              ) AS "previousAttemptGeneration"
       FROM "QingLong3PluginPackageInstallHeads" AS head
       JOIN "QingLong3PluginPackageInstalls" AS current
         ON current.installation_id = head.installation_id
       JOIN "QingLong3PluginPackageAdmissionReceipts" AS current_admission
         ON current_admission.installation_id = current.installation_id
       JOIN "QingLong3PluginPackageInstallProposals" AS current_proposal
         ON current_proposal.action_ref = current_admission.action_ref
       JOIN "QingLong3PluginPackageInstalls" AS previous
         ON previous.project_id = current.project_id
        AND previous.package_name = current.package_name
        AND previous.lock_digest = current.previous_active_lock_digest
       JOIN "QingLong3PluginPackageAdmissionReceipts" AS previous_admission
         ON previous_admission.installation_id = previous.installation_id
       JOIN "QingLong3PluginPackageInstallProposals" AS previous_proposal
         ON previous_proposal.action_ref = previous_admission.action_ref
       WHERE head.project_id = ?
         AND head.package_name = ?
         AND current.state = 'staged'
         AND current.previous_active_lock_digest IS NOT NULL
         AND current.active_lock_digest = current.previous_active_lock_digest
         AND current.target_generation = (
           SELECT MAX(latest.target_generation)
             FROM "QingLong3PluginPackageInstalls" AS latest
            WHERE latest.project_id = current.project_id
              AND latest.package_name = current.package_name
         )
         AND previous.state = 'active'
         AND previous.active_lock_digest = previous.lock_digest
       LIMIT 2`,
    )
    .all(projectId, packageName) as Row[];
  if (rows.length !== 1) {
    throw new LocalPluginPackageSecretBindingConflictError(
      'reviewed staged Package generation is absent or ambiguous',
    );
  }
  try {
    const row = rows[0]!;
    const next = Object.freeze({
      record: normalizePluginPackageInstallRecord(
        JSON.parse(rowText(row, 'nextRecordJson')),
      ),
      lock: normalizePluginPackageLock(
        JSON.parse(rowText(row, 'nextLockJson')),
      ),
      proposal: normalizePluginPackageInstallProposal(
        JSON.parse(rowText(row, 'nextProposalJson')),
      ),
    });
    const previous = Object.freeze({
      record: normalizePluginPackageInstallRecord(
        JSON.parse(rowText(row, 'previousRecordJson')),
      ),
      lock: normalizePluginPackageLock(
        JSON.parse(rowText(row, 'previousLockJson')),
      ),
      proposal: normalizePluginPackageInstallProposal(
        JSON.parse(rowText(row, 'previousProposalJson')),
      ),
    });
    const previousAttemptGeneration = row.previousAttemptGeneration;
    if (
      !Number.isSafeInteger(previousAttemptGeneration) ||
      previousAttemptGeneration !== next.record.targetGeneration - 1 ||
      next.record.projectId !== projectId ||
      next.record.packageName !== packageName ||
      next.record.lockDigest !== next.lock.lockDigest ||
      next.record.previousActiveLockDigest !== previous.lock.lockDigest ||
      next.proposal.actionDigest !== next.lock.approval.actionDigest ||
      next.proposal.previewDigest !== next.lock.approval.previewDigest ||
      next.proposal.actionInput.targetGeneration !==
        next.record.targetGeneration ||
      next.proposal.actionInput.manifest.metadata.name !== packageName ||
      next.proposal.actionInput.source.contentDigest !==
        next.lock.source.contentDigest ||
      previous.record.lockDigest !== previous.lock.lockDigest ||
      previous.proposal.actionDigest !== previous.lock.approval.actionDigest ||
      previous.proposal.previewDigest !==
        previous.lock.approval.previewDigest ||
      previous.proposal.actionInput.targetGeneration !==
        previous.record.targetGeneration ||
      previous.proposal.actionInput.source.contentDigest !==
        previous.lock.source.contentDigest
    ) {
      throw new Error('Package transition provenance drift');
    }
    return Object.freeze({
      previous,
      next,
      previousAttemptGeneration: previousAttemptGeneration as number,
    });
  } catch (error) {
    if (error instanceof LocalPluginPackageSecretBindingConflictError)
      throw error;
    throw new LocalPluginPackageSecretBindingUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  }
}

function transitionGeneration(
  value: ReturnType<typeof loadTransition>['next'],
) {
  return createPluginPackageResourceGenerationFromReferences({
    installationId: value.record.installationId,
    projectId: value.record.projectId,
    packageName: value.record.packageName,
    lockDigest: value.record.lockDigest,
    generation: value.record.targetGeneration,
    previousActiveLockDigest: value.record.previousActiveLockDigest,
    contentDigest: value.lock.source.contentDigest,
    resources: value.lock.resources,
  });
}

function auditRecord(
  plan: Readonly<PluginPackageSecretBindingPlan>,
  eventId: string,
  principal: Readonly<SecurityPrincipal>,
  fence: Readonly<SecurityPolicyFence>,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> {
  return Object.freeze({
    eventId,
    requestId: `package_secret_binding:${plan.planDigest}`,
    operationId: 'plugin_package.secret.bind',
    projectId: plan.target.projectId,
    subject: principal.subject,
    authenticationId: principal.authenticationId,
    outcome: 'allowed',
    reasons: Object.freeze(['owner_confirmed_secret_binding']),
    fence,
    occurredAtMs,
  });
}

function transitionAuditRecord(
  plan: Readonly<PluginPackageSecretBindingTransitionPlan>,
  eventId: string,
  principal: Readonly<SecurityPrincipal>,
  fence: Readonly<SecurityPolicyFence>,
  occurredAtMs: number,
): Readonly<SecurityAuditRecord> {
  return Object.freeze({
    eventId,
    requestId: `package_secret_binding_transition:${plan.transitionDigest}`,
    operationId: 'plugin_package.secret.transition',
    projectId: plan.nextTarget.projectId,
    subject: principal.subject,
    authenticationId: principal.authenticationId,
    outcome: 'allowed',
    reasons: Object.freeze([`owner_confirmed_secret_${plan.kind}`]),
    fence,
    occurredAtMs,
  });
}

function verifySecretVersions(
  client: DatabaseSync,
  plan: Readonly<PluginPackageSecretBindingPlan>,
): void {
  for (const entry of plan.entries) {
    if (entry.secretRef === null) continue;
    const reference = parseSecretRef(entry.secretRef);
    if (reference.version === undefined) {
      throw new LocalPluginPackageSecretBindingConflictError(
        `Secret ${entry.name} reference is not version-pinned`,
      );
    }
    const row = client
      .prepare(
        `SELECT 1 AS present
         FROM "QingLong3LocalSecretEnvelopes"
         WHERE "project_id" = ? AND "secret_name" = ? AND "version" = ?
         LIMIT 2`,
      )
      .all(reference.projectId, reference.name, reference.version) as Row[];
    if (row.length !== 1) {
      throw new LocalPluginPackageSecretBindingConflictError(
        `Secret ${entry.name} version is unavailable`,
      );
    }
  }
}

function verifyPolicyFence(
  client: DatabaseSync,
  principal: Readonly<SecurityPrincipal>,
  fence: Readonly<SecurityPolicyFence>,
  projectId: string,
): void {
  const row = client
    .prepare(
      `SELECT project."status" AS "status",
              project."version" AS "projectVersion",
              binding."version" AS "bindingVersion",
              binding."state" AS "bindingState",
              binding."role" AS "role"
       FROM "QingLong3Projects" AS project
       LEFT JOIN "QingLong3ProjectRoleBindings" AS binding
         ON binding."project_id" = project."id"
        AND binding."subject_type" = ?
        AND binding."subject_id" = ?
        AND binding."version" = (
          SELECT MAX(current."version")
          FROM "QingLong3ProjectRoleBindings" AS current
          WHERE current."project_id" = project."id"
            AND current."subject_type" = ?
            AND current."subject_id" = ?
        )
       WHERE project."id" = ?
       LIMIT 2`,
    )
    .all(
      principal.subject.type,
      principal.subject.id,
      principal.subject.type,
      principal.subject.id,
      projectId,
    ) as Row[];
  const value = row[0];
  if (
    row.length !== 1 ||
    !value ||
    value.status !== 'active' ||
    value.projectVersion !== fence.projectVersion ||
    value.bindingVersion !== fence.bindingVersion ||
    value.bindingState !== 'active' ||
    value.role !== 'owner'
  ) {
    throw new LocalPluginPackageSecretBindingConflictError(
      'Project policy changed after planning',
    );
  }
}

export function createLocalPluginPackageSecretBindingService(
  authorityValue: LocalSqliteOperationAuthority | DatabaseSync,
  now: () => number = Date.now,
): Readonly<LocalPluginPackageSecretBindingService> {
  const authority =
    authorityValue instanceof LocalSqliteOperationAuthority
      ? authorityValue
      : new LocalSqliteOperationAuthority(authorityValue);
  const policy = new ProjectPolicyEngine(
    new LocalSqliteProjectPolicyRepository(authority),
  );
  const bindings = new LocalSqlitePluginPackageSecretBindingRepository(
    authority,
  );
  const transitionReceipts =
    new LocalSqlitePluginPackageSecretBindingTransitionReceiptRepository(
      authority,
    );

  const authorize = async (
    principalValue: SecurityPrincipal,
    projectId: string,
    observedAtMs: number,
  ) => {
    const principal = normalizeSecurityPrincipal(principalValue, observedAtMs);
    if (
      principal.subject.type !== 'user' ||
      principal.assurance !== 'local_console'
    ) {
      throw new LocalPluginPackageSecretBindingConflictError(
        'binding requires a local-console User',
      );
    }
    const decision = await policy.authorize(
      principal,
      projectId,
      'secret.manage',
    );
    if (decision.effect !== 'allow' || decision.fence === null) {
      throw new LocalPluginPackageSecretBindingConflictError(
        'current Project policy denies Secret management',
      );
    }
    return Object.freeze({ principal, fence: decision.fence });
  };

  return Object.freeze({
    async plan(request: PlanLocalPluginPackageSecretBindingRequest) {
      const projectId = identity(request.projectId, 'Project ID', IDENTIFIER);
      const packageName = identity(
        request.packageName,
        'Package name',
        PACKAGE_NAME,
      );
      const plannedAtMs = timestamp(request.plannedAtMs, 'plannedAtMs');
      const authorization = await authorize(
        request.principal,
        projectId,
        plannedAtMs,
      );
      return authority.enqueue(
        async () => {
          verifyPolicyFence(
            authority.client,
            authorization.principal,
            authorization.fence,
            projectId,
          );
          const current = loadCurrent(authority.client, projectId, packageName);
          const generation = generationFrom(current);
          if (bindings.findInTransaction(generation.generationDigest)) {
            throw new LocalPluginPackageSecretBindingConflictError(
              'current generation is already bound; rebind requires a new generation',
            );
          }
          const plan = createPluginPackageSecretBindingPlan({
            generation,
            manifest: current.proposal.actionInput.manifest,
            assignments: request.assignments,
            plannedAtMs,
          });
          verifySecretVersions(authority.client, plan);
          return plan;
        },
        () => new LocalPluginPackageSecretBindingUnavailableError(),
      );
    },

    async execute(request: ExecuteLocalPluginPackageSecretBindingRequest) {
      const plan = normalizePluginPackageSecretBindingPlan(request.plan);
      if (typeof request.confirmAuthorization !== 'function') {
        throw new TypeError('confirmAuthorization is invalid');
      }
      const observedAtMs = timestamp(now(), 'binding execution clock');
      const authorization = await authorize(
        request.principal,
        plan.target.projectId,
        observedAtMs,
      );
      await request.confirmAuthorization();
      return authority.enqueue(
        async () => {
          authority.client.exec('BEGIN IMMEDIATE');
          try {
            const current = loadCurrent(
              authority.client,
              plan.target.projectId,
              plan.target.packageName,
            );
            const expected = createPluginPackageSecretBindingPlan({
              generation: generationFrom(current),
              manifest: current.proposal.actionInput.manifest,
              assignments: plan.entries.map(({ name, secretRef }) => ({
                name,
                secretRef,
              })),
              plannedAtMs: plan.plannedAtMs,
            });
            if (expected.planDigest !== plan.planDigest) {
              throw new LocalPluginPackageSecretBindingConflictError(
                'current Package generation changed after planning',
              );
            }
            verifyPolicyFence(
              authority.client,
              authorization.principal,
              authorization.fence,
              plan.target.projectId,
            );
            verifySecretVersions(authority.client, plan);
            const audit = auditRecord(
              plan,
              identity(request.auditEventId, 'audit event ID', UUID),
              authorization.principal,
              authorization.fence,
              observedAtMs,
            );
            const auditsForPlan = authority.client
              .prepare(
                `SELECT ${LOCAL_SECURITY_AUDIT_SELECT}
                 FROM "QingLong3SecurityAuditEvents"
                 WHERE "request_id" = ? AND "operation_id" = ?
                 LIMIT 2`,
              )
              .all(audit.requestId, audit.operationId) as Row[];
            if (
              auditsForPlan.length > 1 ||
              (auditsForPlan.length === 1 &&
                rowText(auditsForPlan[0]!, 'eventId') !== audit.eventId)
            ) {
              throw new LocalPluginPackageSecretBindingConflictError(
                'binding plan already has another audit identity',
              );
            }
            const existingAudit = authority.client
              .prepare(
                `SELECT ${LOCAL_SECURITY_AUDIT_SELECT}
                 FROM "QingLong3SecurityAuditEvents"
                 WHERE "event_id" = ? LIMIT 2`,
              )
              .get(audit.eventId) as Row | undefined;
            if (existingAudit) {
              if (
                !sameSecurityAuditSemantic(
                  localSecurityAuditFromRow(existingAudit),
                  audit,
                )
              ) {
                throw new LocalPluginPackageSecretBindingConflictError(
                  'audit identity is already used by another operation',
                );
              }
            } else {
              insertLocalSecurityAudit(authority.client, audit);
            }
            const existingBinding = bindings.findInTransaction(
              plan.target.generationDigest,
            );
            const result = existingBinding
              ? (() => {
                  if (
                    existingBinding.authority.kind !==
                      'local-owner-confirmation' ||
                    existingBinding.authority.evidenceDigest !==
                      plan.planDigest ||
                    JSON.stringify(existingBinding.target) !==
                      JSON.stringify(plan.target) ||
                    JSON.stringify(existingBinding.entries) !==
                      JSON.stringify(plan.entries)
                  ) {
                    throw new LocalPluginPackageSecretBindingConflictError(
                      'current generation is already bound by another plan',
                    );
                  }
                  return Object.freeze({
                    status: 'existing' as const,
                    binding: existingBinding,
                  });
                })()
              : bindings.publishInTransaction(
                  createPluginPackageSecretBindingFromPlan(
                    plan,
                    'local-owner-confirmation',
                    observedAtMs,
                  ),
                );
            authority.client.exec('COMMIT');
            return Object.freeze({
              status: result.status,
              bindingDigest: result.binding.bindingDigest,
              generationDigest: result.binding.target.generationDigest,
            });
          } catch (error) {
            if (authority.client.isTransaction)
              authority.client.exec('ROLLBACK');
            if (
              error instanceof LocalPluginPackageSecretBindingConflictError ||
              error instanceof LocalPluginPackageSecretBindingUnavailableError
            ) {
              throw error;
            }
            throw new LocalPluginPackageSecretBindingUnavailableError({
              cause: error instanceof Error ? error : undefined,
            });
          }
        },
        () => new LocalPluginPackageSecretBindingUnavailableError(),
      );
    },

    async planTransition(
      request: PlanLocalPluginPackageSecretBindingTransitionRequest,
    ) {
      const projectId = identity(request.projectId, 'Project ID', IDENTIFIER);
      const packageName = identity(
        request.packageName,
        'Package name',
        PACKAGE_NAME,
      );
      const plannedAtMs = timestamp(request.plannedAtMs, 'plannedAtMs');
      const authorization = await authorize(
        request.principal,
        projectId,
        plannedAtMs,
      );
      return authority.enqueue(
        async () => {
          verifyPolicyFence(
            authority.client,
            authorization.principal,
            authorization.fence,
            projectId,
          );
          const transition = loadTransition(
            authority.client,
            projectId,
            packageName,
          );
          const previousGeneration = generationFrom(transition.previous);
          const previousTarget = createPluginPackageSecretBindingTarget(
            previousGeneration,
            transition.previous.proposal.actionInput.manifest,
          );
          const previousBinding = bindings.findInTransaction(
            previousTarget.generationDigest,
          );
          if (
            transitionReceipts.findInTransaction(
              transitionGeneration(transition.next).generationDigest,
            )
          ) {
            throw new LocalPluginPackageSecretBindingConflictError(
              'staged generation transition is already committed',
            );
          }
          const plan = createPluginPackageSecretBindingTransitionPlan({
            previousTarget,
            previousBinding,
            previousAttemptGeneration: transition.previousAttemptGeneration,
            nextGeneration: transitionGeneration(transition.next),
            nextManifest: transition.next.proposal.actionInput.manifest,
            assignments: request.assignments,
            plannedAtMs,
          });
          if (plan.nextBindingPlan) {
            verifySecretVersions(authority.client, plan.nextBindingPlan);
          }
          return plan;
        },
        () => new LocalPluginPackageSecretBindingUnavailableError(),
      );
    },

    async executeTransition(
      request: ExecuteLocalPluginPackageSecretBindingTransitionRequest,
    ) {
      const plan = normalizePluginPackageSecretBindingTransitionPlan(
        request.plan,
      );
      if (typeof request.confirmAuthorization !== 'function') {
        throw new TypeError('confirmAuthorization is invalid');
      }
      const observedAtMs = timestamp(now(), 'transition execution clock');
      const authorization = await authorize(
        request.principal,
        plan.nextTarget.projectId,
        observedAtMs,
      );
      await request.confirmAuthorization();
      return authority.enqueue(
        async () => {
          authority.client.exec('BEGIN IMMEDIATE');
          try {
            verifyPolicyFence(
              authority.client,
              authorization.principal,
              authorization.fence,
              plan.nextTarget.projectId,
            );
            const auditEventId = identity(
              request.auditEventId,
              'audit event ID',
              UUID,
            );
            const auditsForPlan = authority.client
              .prepare(
                `SELECT ${LOCAL_SECURITY_AUDIT_SELECT}
                 FROM "QingLong3SecurityAuditEvents"
                 WHERE "request_id" = ? AND "operation_id" = ?
                 LIMIT 2`,
              )
              .all(
                `package_secret_binding_transition:${plan.transitionDigest}`,
                'plugin_package.secret.transition',
              ) as Row[];
            if (
              auditsForPlan.length > 1 ||
              (auditsForPlan.length === 1 &&
                rowText(auditsForPlan[0]!, 'eventId') !== auditEventId)
            ) {
              throw new LocalPluginPackageSecretBindingConflictError(
                'transition plan already has another audit identity',
              );
            }
            const existingReceipt = transitionReceipts.findInTransaction(
              plan.nextTarget.generationDigest,
            );
            if (existingReceipt) {
              if (
                existingReceipt.transitionPlan.transitionDigest !==
                  plan.transitionDigest ||
                existingReceipt.authority.kind !== 'local-owner-confirmation' ||
                existingReceipt.authority.evidenceDigest !==
                  plan.transitionDigest ||
                auditsForPlan.length !== 1
              ) {
                throw new LocalPluginPackageSecretBindingConflictError(
                  'generation is committed by another transition authority',
                );
              }
              authority.client.exec('COMMIT');
              return Object.freeze({
                status: 'existing' as const,
                transitionDigest: plan.transitionDigest,
                receiptDigest: existingReceipt.receiptDigest,
                bindingDigest: existingReceipt.bindingDigest,
                generationDigest: plan.nextTarget.generationDigest,
              });
            }
            const transition = loadTransition(
              authority.client,
              plan.nextTarget.projectId,
              plan.nextTarget.packageName,
            );
            const previousTarget = createPluginPackageSecretBindingTarget(
              generationFrom(transition.previous),
              transition.previous.proposal.actionInput.manifest,
            );
            const expected = createPluginPackageSecretBindingTransitionPlan({
              previousTarget,
              previousBinding: bindings.findInTransaction(
                previousTarget.generationDigest,
              ),
              previousAttemptGeneration: transition.previousAttemptGeneration,
              nextGeneration: transitionGeneration(transition.next),
              nextManifest: transition.next.proposal.actionInput.manifest,
              assignments:
                plan.nextBindingPlan?.entries.map(({ name, secretRef }) => ({
                  name,
                  secretRef,
                })) ?? [],
              plannedAtMs: plan.nextBindingPlan?.plannedAtMs ?? observedAtMs,
            });
            if (expected.transitionDigest !== plan.transitionDigest) {
              throw new LocalPluginPackageSecretBindingConflictError(
                'staged Package generation changed after transition planning',
              );
            }
            if (plan.nextBindingPlan) {
              verifySecretVersions(authority.client, plan.nextBindingPlan);
            }
            const audit = transitionAuditRecord(
              plan,
              auditEventId,
              authorization.principal,
              authorization.fence,
              observedAtMs,
            );
            const existingAudit = authority.client
              .prepare(
                `SELECT ${LOCAL_SECURITY_AUDIT_SELECT}
                 FROM "QingLong3SecurityAuditEvents"
                 WHERE "event_id" = ? LIMIT 2`,
              )
              .get(audit.eventId) as Row | undefined;
            if (existingAudit) {
              if (
                !sameSecurityAuditSemantic(
                  localSecurityAuditFromRow(existingAudit),
                  audit,
                )
              ) {
                throw new LocalPluginPackageSecretBindingConflictError(
                  'audit identity is already used by another operation',
                );
              }
            } else {
              insertLocalSecurityAudit(authority.client, audit);
            }
            const binding = createPluginPackageSecretBindingFromTransitionPlan(
              plan,
              'local-owner-confirmation',
              plan.transitionDigest,
              observedAtMs,
            );
            const bindingResult = binding
              ? bindings.publishInTransaction(binding)
              : null;
            const receipt = createPluginPackageSecretBindingTransitionReceipt({
              transitionPlan: plan,
              authority: {
                kind: 'local-owner-confirmation',
                evidenceDigest: plan.transitionDigest,
              },
              binding: bindingResult?.binding ?? null,
              committedAtMs: observedAtMs,
            });
            const receiptResult =
              transitionReceipts.publishInTransaction(receipt);
            authority.client.exec('COMMIT');
            return Object.freeze({
              status: receiptResult.status,
              transitionDigest: plan.transitionDigest,
              receiptDigest: receiptResult.receipt.receiptDigest,
              bindingDigest: receiptResult.receipt.bindingDigest,
              generationDigest: plan.nextTarget.generationDigest,
            });
          } catch (error) {
            if (authority.client.isTransaction)
              authority.client.exec('ROLLBACK');
            if (
              error instanceof LocalPluginPackageSecretBindingConflictError ||
              error instanceof LocalPluginPackageSecretBindingUnavailableError
            ) {
              throw error;
            }
            throw new LocalPluginPackageSecretBindingUnavailableError({
              cause: error instanceof Error ? error : undefined,
            });
          }
        },
        () => new LocalPluginPackageSecretBindingUnavailableError(),
      );
    },
  });
}
