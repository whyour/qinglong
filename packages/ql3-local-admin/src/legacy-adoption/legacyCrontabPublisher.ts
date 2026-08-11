// Legacy Adoption owns policy-fenced publication into the local SQLite authority.
import type { DatabaseSync } from 'node:sqlite';
import {
  openLocalSqliteAdoptionDatabase,
  type LocalLegacyAdoptionCandidate,
  type PublishLocalLegacyAdoptionResult,
} from '@qinglong/local-sqlite/adoption';
import type { LocalSqliteProfile } from '@qinglong/local-sqlite/runtime';
import type { LocalSecretKeyProvider } from '@qinglong/runtime-core/local-secret';
import {
  ProjectPolicyEngine,
  ProjectPolicyUnavailableError,
} from '@qinglong/runtime-core/project-policy';
import type { SecurityPolicyDecision } from '@qinglong/runtime-core/security';
import type { SecurityPrincipal } from '@qinglong/runtime-core/security';
import type { SecurityAuditRecord } from '@qinglong/runtime-core/security-audit';
import { iterateLegacyCrontabAdoptionInspections } from './legacyCrontabAdoption';
import {
  withVerifiedLegacyCrontabDecisionAuthorizationFile,
  type VerifiedLegacyCrontabDecisionAuthorizationFileScope,
} from './legacyCrontabDecisionAuthorizationFile';
import {
  verifyLegacyCrontabAdoptionDecisionReceipt,
  type LegacyCrontabAdoptionDecision,
} from './legacyCrontabDecisionReceipt';

export type PublishReviewedLegacyCrontabAdoptionResult =
  PublishLocalLegacyAdoptionResult;

export interface PublishReviewedLegacyCrontabAdoptionOptions {
  readonly sourceClient: DatabaseSync;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly authorizationPath: string;
  readonly profile: LocalSqliteProfile;
  readonly timezone: string | null;
  readonly expectedDecisionId: string;
  readonly expectedPlanDigest: string;
  readonly expectedInventoryDigest: string;
  readonly projectId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly keyProvider: LocalSecretKeyProvider;
  readonly observedAtMs: number;
  readonly confirmSourceIdentity: () => void;
  readonly confirmReviewerAuthority?: (
    reviewer: Readonly<SecurityPrincipal>,
  ) => void | Promise<void>;
}

export class LegacyCrontabPublicationAuthorizationError extends Error {
  readonly code = 'LEGACY_CRONTAB_PUBLICATION_NOT_AUTHORIZED';
  constructor() {
    super('Legacy Crontab publication is not authorized');
    this.name = 'LegacyCrontabPublicationAuthorizationError';
  }
}

export class LegacyCrontabPublicationUnavailableError extends Error {
  readonly code = 'LEGACY_CRONTAB_PUBLICATION_UNAVAILABLE';
  constructor(message = 'Legacy Crontab publication is unavailable') {
    super(message);
    this.name = 'LegacyCrontabPublicationUnavailableError';
  }
}

function auditRecord(
  options: PublishReviewedLegacyCrontabAdoptionOptions,
  scope: VerifiedLegacyCrontabDecisionAuthorizationFileScope,
  decision: Readonly<SecurityPolicyDecision> | null,
  outcome: SecurityAuditRecord['outcome'],
  reasons: readonly string[],
): SecurityAuditRecord {
  const reviewer = scope.result.receipt.reviewer;
  return Object.freeze({
    eventId: options.mutationId,
    requestId: options.requestId,
    operationId: 'task.adopt',
    projectId: options.projectId,
    subject: reviewer.subject,
    authenticationId: reviewer.authenticationId,
    outcome,
    reasons,
    fence: decision?.fence ?? null,
    occurredAtMs: options.observedAtMs,
  });
}

function* reviewedCandidates(
  sourceClient: DatabaseSync,
  timezone: string | null,
  decisions: Iterable<LegacyCrontabAdoptionDecision>,
): Iterable<LocalLegacyAdoptionCandidate> {
  const iterator = decisions[Symbol.iterator]();
  for (const inspection of iterateLegacyCrontabAdoptionInspections(
    sourceClient,
    timezone,
  )) {
    const next = iterator.next();
    if (
      next.done ||
      next.value.rowOrdinal !== inspection.diagnostic.rowOrdinal ||
      next.value.sourceDigest !== inspection.diagnostic.sourceDigest
    ) {
      throw new LegacyCrontabPublicationUnavailableError(
        'Reviewed decision stream does not match the fenced source',
      );
    }
    if (next.value.disposition === 'skip') continue;
    if (
      !inspection.candidate ||
      (next.value.disposition === 'adopt' &&
        inspection.diagnostic.classification !== 'lossless') ||
      (next.value.disposition === 'adopt_shell_compatibility' &&
        inspection.diagnostic.classification !== 'requires_shell_compatibility')
    ) {
      throw new LegacyCrontabPublicationUnavailableError(
        'Reviewed disposition cannot publish this source row',
      );
    }
    yield inspection.candidate;
  }
  if (!iterator.next().done) {
    throw new LegacyCrontabPublicationUnavailableError(
      'Reviewed decision stream contains excess rows',
    );
  }
}

export async function publishReviewedLegacyCrontabAdoption(
  options: PublishReviewedLegacyCrontabAdoptionOptions,
): Promise<PublishLocalLegacyAdoptionResult> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.confirmSourceIdentity !== 'function'
  ) {
    throw new LegacyCrontabPublicationUnavailableError(
      'Legacy publication options are invalid',
    );
  }
  return withVerifiedLegacyCrontabDecisionAuthorizationFile(
    {
      filePath: options.authorizationPath,
      expectedDecisionId: options.expectedDecisionId,
      expectedProfile: options.profile,
      expectedPlanDigest: options.expectedPlanDigest,
      expectedInventoryDigest: options.expectedInventoryDigest,
      keyProvider: options.keyProvider,
      verifyReceipt: (receipt, decisions) =>
        verifyLegacyCrontabAdoptionDecisionReceipt(
          options.sourceClient,
          options.timezone,
          receipt,
          decisions,
          options.observedAtMs,
        ),
    },
    async (scope) => {
      options.confirmSourceIdentity();
      await options.confirmReviewerAuthority?.(scope.result.receipt.reviewer);
      const target = await openLocalSqliteAdoptionDatabase({
        databasePath: options.targetPath,
        profile: options.profile,
      });
      try {
        const policy = new ProjectPolicyEngine(target.projectPolicy);
        let decision: Readonly<SecurityPolicyDecision>;
        try {
          decision = await policy.authorize(
            scope.result.receipt.reviewer,
            options.projectId,
            'project.manage',
          );
        } catch (error) {
          if (!(error instanceof ProjectPolicyUnavailableError)) {
            throw new LegacyCrontabPublicationUnavailableError();
          }
          try {
            await target.securityAudit.record(
              auditRecord(options, scope, null, 'authorization_unavailable', [
                'policy_unavailable',
              ]),
            );
          } catch {
            throw new LegacyCrontabPublicationUnavailableError();
          }
          throw new LegacyCrontabPublicationUnavailableError();
        }
        if (decision.effect !== 'allow') {
          try {
            await target.securityAudit.record(
              auditRecord(
                options,
                scope,
                decision,
                decision.effect === 'require_approval'
                  ? 'approval_required'
                  : 'denied',
                decision.reasons,
              ),
            );
          } catch {
            throw new LegacyCrontabPublicationUnavailableError();
          }
          throw new LegacyCrontabPublicationAuthorizationError();
        }
        if (!decision.fence || decision.fence.bindingVersion === null) {
          throw new LegacyCrontabPublicationUnavailableError();
        }
        return await target.publisher.publish({
          mutationId: options.mutationId,
          decisionId: scope.result.receipt.decisionId,
          projectId: options.projectId,
          profile: options.profile,
          planDigest: scope.result.receipt.planDigest,
          inventoryDigest: scope.result.receipt.inventoryDigest,
          decisionDigest: scope.result.receipt.decisions.decisionDigest,
          receiptDigest: scope.result.receipt.receiptDigest,
          authorizationFileDigest: scope.result.file.fileDigest,
          rowCount: scope.result.receipt.decisions.rowCount,
          skippedCount: scope.result.receipt.decisions.dispositions.skip,
          subject: scope.result.receipt.reviewer.subject,
          fence: decision.fence,
          audit: auditRecord(
            options,
            scope,
            decision,
            'allowed',
            decision.reasons,
          ),
          candidates: reviewedCandidates(
            options.sourceClient,
            options.timezone,
            scope.decisions,
          ),
          async confirmExternalAuthority() {
            options.confirmSourceIdentity();
            scope.confirmIdentity();
            await options.confirmReviewerAuthority?.(
              scope.result.receipt.reviewer,
            );
          },
          createdAtMs: options.observedAtMs,
        });
      } finally {
        await target.close();
      }
    },
  );
}
