// Reconciliation Automation owns a plan-bound facade over legacy row decisions.
import type { DatabaseSync } from 'node:sqlite';
import type { LocalSecretKeyProvider } from '@qinglong/runtime-core/local-secret';
import type { SecurityPrincipal } from '@qinglong/runtime-core/security';
import {
  publishVerifiedLegacyCrontabAdoption,
  type PublishReviewedLegacyCrontabAdoptionResult,
  type PublishVerifiedLegacyCrontabAdoptionOptions,
} from './legacyCrontabPublisher';
import {
  publishLegacyCrontabDecisionAuthorizationFile,
  withVerifiedLegacyCrontabDecisionAuthorizationFile,
  type LegacyCrontabDecisionAuthorizationFileResult,
  type VerifiedLegacyCrontabDecisionAuthorizationFileScope,
} from './legacyCrontabDecisionAuthorizationFile';
import {
  createLegacyCrontabAdoptionDecisionReceipt,
  verifyLegacyCrontabAdoptionDecisionReceipt,
  type LegacyCrontabAdoptionDecision,
} from './legacyCrontabDecisionReceipt';
import type { LegacyCrontabAdoptionClassification } from './legacyCrontabAdoption';
import { withPrivateLegacyCrontabAdoptionDecisionReviewFile } from './legacyCrontabDecisionReviewFile';

export type ReconciliationAutomationDecisionRequirementKind =
  | 'review_adopt'
  | 'review_skip_conflict'
  | 'manual_required';

export interface ReconciliationAutomationDecisionRequirement {
  readonly rowOrdinal: number;
  readonly sourceDigest: string;
  readonly classification: LegacyCrontabAdoptionClassification;
  readonly requirement: ReconciliationAutomationDecisionRequirementKind;
}

export interface ReconciliationAutomationDecisionIdentity {
  readonly decisionId: string;
  readonly profile: 'edge' | 'standalone';
  readonly automationPlanDigest: string;
  readonly inventoryDigest: string;
}

export interface ReconciliationAutomationDecisionVerificationOptions
  extends ReconciliationAutomationDecisionIdentity {
  readonly authorizationPath: string;
  readonly sourceClient: DatabaseSync;
  readonly timezone: string | null;
  readonly keyProvider: LocalSecretKeyProvider;
  readonly observedAtMs: number;
  readonly openRequirements: () => Iterable<ReconciliationAutomationDecisionRequirement>;
  readonly allowedModes?: readonly (0o400 | 0o600)[];
  readonly allowedParentModes?: readonly (0o500 | 0o700)[];
}

export interface ApplyReconciliationAutomationDecisionOptions
  extends ReconciliationAutomationDecisionVerificationOptions,
    Omit<
      PublishVerifiedLegacyCrontabAdoptionOptions,
      'sourceClient' | 'profile' | 'timezone'
    > {}

export interface IssueReconciliationAutomationDecisionOptions
  extends ReconciliationAutomationDecisionVerificationOptions {
  readonly reviewFilePath: string;
  readonly reviewer: SecurityPrincipal;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly confirmExternalAuthority: () => void | Promise<void>;
}

export interface RecoverReconciliationAutomationDecisionOptions
  extends ReconciliationAutomationDecisionVerificationOptions {
  readonly reviewFilePath: string;
}

export interface ReconciliationAutomationDecisionPublication {
  readonly authorization: LegacyCrontabDecisionAuthorizationFileResult;
  readonly reviewFileDigest: string;
}

export interface VerifiedReconciliationAutomationDecisionScope
  extends VerifiedLegacyCrontabDecisionAuthorizationFileScope {
  readonly decisions: Iterable<LegacyCrontabAdoptionDecision>;
}

export class ReconciliationAutomationDecisionError extends Error {
  readonly code = 'RECONCILIATION_AUTOMATION_DECISION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Reconciliation Automation decision is invalid: ${message}`);
    this.name = 'ReconciliationAutomationDecisionError';
  }
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CLASSIFICATIONS = Object.freeze([
  'lossless',
  'requires_shell_compatibility',
  'requires_manual_action',
  'malformed',
] as const);
const REQUIREMENTS = Object.freeze([
  'review_adopt',
  'review_skip_conflict',
  'manual_required',
] as const);

function requirement(
  value: ReconciliationAutomationDecisionRequirement,
): Readonly<ReconciliationAutomationDecisionRequirement> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      ['classification', 'requirement', 'rowOrdinal', 'sourceDigest']
        .sort()
        .join('\0') ||
    !Number.isSafeInteger(value.rowOrdinal) ||
    value.rowOrdinal < 1 ||
    !DIGEST_PATTERN.test(value.sourceDigest) ||
    !CLASSIFICATIONS.includes(value.classification) ||
    !REQUIREMENTS.includes(value.requirement)
  ) {
    throw new ReconciliationAutomationDecisionError(
      'plan requirement is invalid',
    );
  }
  return Object.freeze({ ...value });
}

function iterator<T>(value: Iterable<T>, label: string): Iterator<T> {
  if (
    !value ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    typeof value[Symbol.iterator] !== 'function'
  ) {
    throw new ReconciliationAutomationDecisionError(`${label} is invalid`);
  }
  const selected = value[Symbol.iterator]();
  if (!selected || typeof selected.next !== 'function') {
    throw new ReconciliationAutomationDecisionError(`${label} is invalid`);
  }
  return selected;
}

function decisionsBoundToPlan(
  decisions: Iterable<LegacyCrontabAdoptionDecision>,
  openRequirements: () => Iterable<ReconciliationAutomationDecisionRequirement>,
): Iterable<LegacyCrontabAdoptionDecision> {
  if (typeof openRequirements !== 'function') {
    throw new ReconciliationAutomationDecisionError(
      'plan requirement factory is invalid',
    );
  }
  return (function* (): Iterable<LegacyCrontabAdoptionDecision> {
    const decisionIterator = iterator(decisions, 'decision stream');
    const requirementIterator = iterator(
      openRequirements(),
      'plan requirement stream',
    );
    let complete = false;
    try {
      for (;;) {
        const nextDecision = decisionIterator.next();
        const nextRequirement = requirementIterator.next();
        if (nextDecision.done || nextRequirement.done) {
          if (nextDecision.done !== nextRequirement.done) {
            throw new ReconciliationAutomationDecisionError(
              'decision and plan row counts differ',
            );
          }
          complete = true;
          return;
        }
        const expected = requirement(nextRequirement.value);
        const decision = nextDecision.value;
        if (
          decision.rowOrdinal !== expected.rowOrdinal ||
          decision.sourceDigest !== expected.sourceDigest
        ) {
          throw new ReconciliationAutomationDecisionError(
            'decision is detached from its plan row',
          );
        }
        if (
          expected.requirement !== 'review_adopt' &&
          decision.disposition !== 'skip'
        ) {
          throw new ReconciliationAutomationDecisionError(
            'conflict or manual row cannot be adopted',
          );
        }
        yield decision;
      }
    } finally {
      if (!complete) {
        try {
          decisionIterator.return?.();
        } catch {
          // Preserve the binding failure.
        }
        try {
          requirementIterator.return?.();
        } catch {
          // Preserve the binding failure.
        }
      }
    }
  })();
}

function sameDecision(
  left: LegacyCrontabAdoptionDecision,
  right: LegacyCrontabAdoptionDecision,
): boolean {
  return (
    left.rowOrdinal === right.rowOrdinal &&
    left.sourceDigest === right.sourceDigest &&
    left.disposition === right.disposition &&
    left.reason === right.reason
  );
}

function verifiedOptions(
  options: ReconciliationAutomationDecisionVerificationOptions,
  openRequirements: () => Iterable<ReconciliationAutomationDecisionRequirement>,
) {
  return {
    filePath: options.authorizationPath,
    expectedDecisionId: options.decisionId,
    expectedProfile: options.profile,
    expectedPlanDigest: options.automationPlanDigest,
    expectedInventoryDigest: options.inventoryDigest,
    keyProvider: options.keyProvider,
    ...(options.allowedModes === undefined
      ? {}
      : { allowedModes: options.allowedModes }),
    ...(options.allowedParentModes === undefined
      ? {}
      : { allowedParentModes: options.allowedParentModes }),
    verifyReceipt: (
      receipt: unknown,
      decisions: Iterable<LegacyCrontabAdoptionDecision>,
    ) =>
      verifyLegacyCrontabAdoptionDecisionReceipt(
        options.sourceClient,
        options.timezone,
        receipt,
        decisionsBoundToPlan(decisions, openRequirements),
        options.observedAtMs,
      ),
  } as const;
}

export async function issueReconciliationAutomationDecision(
  options: IssueReconciliationAutomationDecisionOptions,
): Promise<Readonly<ReconciliationAutomationDecisionPublication>> {
  try {
    return await withPrivateLegacyCrontabAdoptionDecisionReviewFile(
      {
        filePath: options.reviewFilePath,
        expectedDecisionId: options.decisionId,
        expectedProfile: options.profile,
        expectedPlanDigest: options.automationPlanDigest,
        expectedInventoryDigest: options.inventoryDigest,
      },
      async (review) => {
        const authorization =
          await publishLegacyCrontabDecisionAuthorizationFile({
            filePath: options.authorizationPath,
            decisionId: options.decisionId,
            profile: options.profile,
            planDigest: options.automationPlanDigest,
            inventoryDigest: options.inventoryDigest,
            decisions: decisionsBoundToPlan(
              review.decisions,
              options.openRequirements,
            ),
            keyProvider: options.keyProvider,
            createReceipt: (decisions) =>
              createLegacyCrontabAdoptionDecisionReceipt(
                options.sourceClient,
                options.timezone,
                {
                  decisionId: options.decisionId,
                  profile: options.profile,
                  planDigest: options.automationPlanDigest,
                  inventoryDigest: options.inventoryDigest,
                  reviewer: options.reviewer,
                  issuedAtMs: options.issuedAtMs,
                  expiresAtMs: options.expiresAtMs,
                },
                decisions,
              ),
            async confirmExternalAuthority() {
              review.confirmIdentity();
              await options.confirmExternalAuthority();
            },
          });
        review.confirmIdentity();
        return Object.freeze({
          authorization,
          reviewFileDigest: review.evidence.fileDigest,
        });
      },
    );
  } catch (error) {
    if (error instanceof ReconciliationAutomationDecisionError) throw error;
    throw new ReconciliationAutomationDecisionError(
      'authorization could not be issued',
      error,
    );
  }
}

export async function recoverReconciliationAutomationDecision(
  options: RecoverReconciliationAutomationDecisionOptions,
): Promise<Readonly<ReconciliationAutomationDecisionPublication>> {
  try {
    return await withPrivateLegacyCrontabAdoptionDecisionReviewFile(
      {
        filePath: options.reviewFilePath,
        expectedDecisionId: options.decisionId,
        expectedProfile: options.profile,
        expectedPlanDigest: options.automationPlanDigest,
        expectedInventoryDigest: options.inventoryDigest,
      },
      async (review) =>
        withVerifiedLegacyCrontabDecisionAuthorizationFile(
          verifiedOptions(options, options.openRequirements),
          async (authorization) => {
            const reviewed = iterator(
              decisionsBoundToPlan(
                review.decisions,
                options.openRequirements,
              ),
              'review decision stream',
            );
            const signed = iterator(
              authorization.decisions,
              'signed decision stream',
            );
            for (;;) {
              const left = reviewed.next();
              const right = signed.next();
              if (left.done || right.done) {
                if (left.done !== right.done) {
                  throw new ReconciliationAutomationDecisionError(
                    'review and signed decision counts differ',
                  );
                }
                break;
              }
              if (!sameDecision(left.value, right.value)) {
                throw new ReconciliationAutomationDecisionError(
                  'review decision differs from signed authorization',
                );
              }
            }
            review.confirmIdentity();
            authorization.confirmIdentity();
            return Object.freeze({
              authorization: authorization.result,
              reviewFileDigest: review.evidence.fileDigest,
            });
          },
        ),
    );
  } catch (error) {
    if (error instanceof ReconciliationAutomationDecisionError) throw error;
    throw new ReconciliationAutomationDecisionError(
      'authorization recovery failed',
      error,
    );
  }
}

export async function withVerifiedReconciliationAutomationDecision<T>(
  options: ReconciliationAutomationDecisionVerificationOptions,
  consumer: (
    scope: VerifiedReconciliationAutomationDecisionScope,
  ) => T | Promise<T>,
): Promise<T> {
  if (typeof consumer !== 'function') {
    throw new ReconciliationAutomationDecisionError(
      'verified decision consumer is invalid',
    );
  }
  try {
    return await withVerifiedLegacyCrontabDecisionAuthorizationFile(
      verifiedOptions(options, options.openRequirements),
      (scope) =>
        consumer(
          Object.freeze({
            ...scope,
            decisions: decisionsBoundToPlan(
              scope.decisions,
              options.openRequirements,
            ),
          }),
        ),
    );
  } catch (error) {
    if (error instanceof ReconciliationAutomationDecisionError) throw error;
    throw new ReconciliationAutomationDecisionError(
      'authorization verification failed',
      error,
    );
  }
}

export async function verifyReconciliationAutomationDecision(
  options: ReconciliationAutomationDecisionVerificationOptions,
): Promise<LegacyCrontabDecisionAuthorizationFileResult> {
  return withVerifiedReconciliationAutomationDecision(options, (scope) => {
    for (const _decision of scope.decisions) {
      // Full consumption proves the second plan-bound stream as well.
    }
    scope.confirmIdentity();
    return scope.result;
  });
}

export async function applyReconciliationAutomationDecision(
  options: ApplyReconciliationAutomationDecisionOptions,
): Promise<PublishReviewedLegacyCrontabAdoptionResult> {
  return withVerifiedReconciliationAutomationDecision(options, (scope) =>
    publishVerifiedLegacyCrontabAdoption(
      {
        sourceClient: options.sourceClient,
        targetPath: options.targetPath,
        profile: options.profile,
        timezone: options.timezone,
        projectId: options.projectId,
        mutationId: options.mutationId,
        requestId: options.requestId,
        observedAtMs: options.observedAtMs,
        confirmSourceIdentity: options.confirmSourceIdentity,
        ...(options.confirmReviewerAuthority === undefined
          ? {}
          : {
              confirmReviewerAuthority: options.confirmReviewerAuthority,
            }),
      },
      scope,
    ),
  );
}
