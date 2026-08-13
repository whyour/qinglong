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
import {
  createPluginPackageSecretBindingFromPlan,
  createPluginPackageSecretBindingPlan,
  normalizePluginPackageSecretBindingPlan,
  type PluginPackageSecretBindingPlan,
} from '@qinglong/runtime-core/plugin-package-secret-binding-plan';
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
  });
}
