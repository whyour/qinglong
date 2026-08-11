import type {
  CreateLegacyCrontabAdoptionDecisionReceiptContext,
  LegacyCrontabAdoptionDecisionReceipt,
} from '../legacyCrontabDecisionReceipt';
import type {
  LegacyCrontabDecisionAuthorizationFileResult,
  PublishLegacyCrontabDecisionAuthorizationFileOptions,
} from '../legacyCrontabDecisionAuthorizationFile';
import type { PublishReviewedLegacyCrontabAdoptionResult } from '../legacyCrontabPublisher';
import {
  DIGEST_PATTERN,
  LocalSqliteAdoptionError,
  type CommitReviewedLegacyCrontabAdoptionOptions,
  type CreateReviewedLegacyCrontabAdoptionDecisionReceiptOptions,
  type IssueReviewedLegacyCrontabAdoptionDecisionAuthorizationFileOptions,
  type PublishReviewedLegacyCrontabAdoptionDecisionAuthorizationFileOptions,
  type VerifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFileOptions,
  type VerifyReviewedLegacyCrontabAdoptionDecisionReceiptOptions,
} from './contracts';
import {
  assertAbsolutePath,
  assertDistinctPaths,
  fileIdentity,
  sameFileIdentity,
} from './filesystem';
import { inspectLegacySqlitePath, openLegacySource } from './inspection';
import {
  acquireSourceWriteFence,
  releaseSourceWriteFence,
} from './sourceFence';

type LegacyCrontabDecisionReceiptModule =
  typeof import('../legacyCrontabDecisionReceipt');
type LegacyCrontabDecisionAuthorizationFileModule =
  typeof import('../legacyCrontabDecisionAuthorizationFile');
type LegacyCrontabPublisherModule = typeof import('../legacyCrontabPublisher');
type LegacyCrontabDecisionIssuerKeyringModule =
  typeof import('../legacyCrontabDecisionIssuerKeyring');

function legacyCrontabDecisionReceiptModule(): LegacyCrontabDecisionReceiptModule {
  return require('../legacyCrontabDecisionReceipt') as LegacyCrontabDecisionReceiptModule;
}

function legacyCrontabDecisionAuthorizationFileModule(): LegacyCrontabDecisionAuthorizationFileModule {
  return require('../legacyCrontabDecisionAuthorizationFile') as LegacyCrontabDecisionAuthorizationFileModule;
}

function legacyCrontabPublisherModule(): LegacyCrontabPublisherModule {
  return require('../legacyCrontabPublisher') as LegacyCrontabPublisherModule;
}

function legacyCrontabDecisionIssuerKeyringModule(): LegacyCrontabDecisionIssuerKeyringModule {
  return require('../legacyCrontabDecisionIssuerKeyring') as LegacyCrontabDecisionIssuerKeyringModule;
}

export function createReviewedLegacyCrontabAdoptionDecisionReceipt(
  options: CreateReviewedLegacyCrontabAdoptionDecisionReceiptOptions,
): LegacyCrontabAdoptionDecisionReceipt {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new LocalSqliteAdoptionError('decision receipt options are invalid');
  }
  if (!DIGEST_PATTERN.test(options.expectedPlanDigest)) {
    throw new LocalSqliteAdoptionError('expectedPlanDigest is invalid');
  }
  const plan = inspectLegacySqlitePath(options);
  if (plan.planDigest !== options.expectedPlanDigest) {
    throw new LocalSqliteAdoptionError(
      'source no longer matches the reviewed plan',
    );
  }
  const client = openLegacySource(options.sourcePath);
  try {
    const sourceBefore = fileIdentity(options.sourcePath);
    const receipt =
      legacyCrontabDecisionReceiptModule().createLegacyCrontabAdoptionDecisionReceipt(
        client,
        plan.tasks.timezone,
        {
          decisionId: options.decisionId,
          profile: plan.profile,
          planDigest: plan.planDigest,
          inventoryDigest: plan.tasks.inventoryDigest,
          reviewer: options.reviewer,
          issuedAtMs: options.issuedAtMs,
          expiresAtMs: options.expiresAtMs,
        },
        options.decisions,
      );
    const sourceAfter = fileIdentity(options.sourcePath);
    if (!sameFileIdentity(sourceBefore, sourceAfter)) {
      throw new LocalSqliteAdoptionError(
        'source changed during decision receipt creation',
      );
    }
    return receipt;
  } catch (error) {
    if (error instanceof LocalSqliteAdoptionError) throw error;
    throw new LocalSqliteAdoptionError(
      'decision receipt creation failed',
      error,
    );
  } finally {
    client.close();
  }
}

export function verifyReviewedLegacyCrontabAdoptionDecisionReceipt(
  options: VerifyReviewedLegacyCrontabAdoptionDecisionReceiptOptions,
): LegacyCrontabAdoptionDecisionReceipt {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new LocalSqliteAdoptionError(
      'decision receipt verification options are invalid',
    );
  }
  if (!DIGEST_PATTERN.test(options.expectedPlanDigest)) {
    throw new LocalSqliteAdoptionError('expectedPlanDigest is invalid');
  }
  const plan = inspectLegacySqlitePath(options);
  if (plan.planDigest !== options.expectedPlanDigest) {
    throw new LocalSqliteAdoptionError(
      'source no longer matches the reviewed plan',
    );
  }
  const client = openLegacySource(options.sourcePath);
  try {
    const sourceBefore = fileIdentity(options.sourcePath);
    const receipt =
      legacyCrontabDecisionReceiptModule().verifyLegacyCrontabAdoptionDecisionReceipt(
        client,
        plan.tasks.timezone,
        options.receipt,
        options.decisions,
        options.observedAtMs,
      );
    const sourceAfter = fileIdentity(options.sourcePath);
    if (
      !sameFileIdentity(sourceBefore, sourceAfter) ||
      receipt.profile !== plan.profile ||
      receipt.planDigest !== plan.planDigest ||
      receipt.inventoryDigest !== plan.tasks.inventoryDigest
    ) {
      throw new LocalSqliteAdoptionError(
        'decision receipt does not match the reviewed source',
      );
    }
    return receipt;
  } catch (error) {
    if (error instanceof LocalSqliteAdoptionError) throw error;
    throw new LocalSqliteAdoptionError(
      'decision receipt verification failed',
      error,
    );
  } finally {
    client.close();
  }
}

export async function publishReviewedLegacyCrontabAdoptionDecisionAuthorizationFile(
  options: PublishReviewedLegacyCrontabAdoptionDecisionAuthorizationFileOptions,
): Promise<LegacyCrontabDecisionAuthorizationFileResult> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new LocalSqliteAdoptionError(
      'decision authorization publication options are invalid',
    );
  }
  if (!DIGEST_PATTERN.test(options.expectedPlanDigest)) {
    throw new LocalSqliteAdoptionError('expectedPlanDigest is invalid');
  }
  const plan = inspectLegacySqlitePath(options);
  if (plan.planDigest !== options.expectedPlanDigest) {
    throw new LocalSqliteAdoptionError(
      'source no longer matches the reviewed plan',
    );
  }
  try {
    return await legacyCrontabDecisionAuthorizationFileModule().publishLegacyCrontabDecisionAuthorizationFile(
      {
        filePath: options.authorizationPath,
        decisionId: options.decisionId,
        profile: plan.profile,
        planDigest: plan.planDigest,
        inventoryDigest: plan.tasks.inventoryDigest,
        decisions: options.decisions,
        keyProvider: options.keyProvider,
        ...(options.confirmExternalAuthority === undefined
          ? {}
          : { confirmExternalAuthority: options.confirmExternalAuthority }),
        createReceipt: (decisions) =>
          createReviewedLegacyCrontabAdoptionDecisionReceipt({
            sourcePath: options.sourcePath,
            profile: options.profile,
            ...(options.legacyTimezone === undefined
              ? {}
              : { legacyTimezone: options.legacyTimezone }),
            expectedPlanDigest: options.expectedPlanDigest,
            decisionId: options.decisionId,
            reviewer: options.reviewer,
            issuedAtMs: options.issuedAtMs,
            expiresAtMs: options.expiresAtMs,
            decisions,
          }),
      },
    );
  } catch (error) {
    if (error instanceof LocalSqliteAdoptionError) throw error;
    throw new LocalSqliteAdoptionError(
      'decision authorization publication failed',
      error,
    );
  }
}

export async function issueReviewedLegacyCrontabAdoptionDecisionAuthorizationFile(
  options: IssueReviewedLegacyCrontabAdoptionDecisionAuthorizationFileOptions,
): Promise<LegacyCrontabDecisionAuthorizationFileResult> {
  const optionalKeys = [
    ...(options?.legacyTimezone === undefined ? [] : ['legacyTimezone']),
    ...(options?.lifetimeMs === undefined ? [] : ['lifetimeMs']),
    ...(options?.clock === undefined ? [] : ['clock']),
    ...(options?.confirmDecisionStreamAuthority === undefined
      ? []
      : ['confirmDecisionStreamAuthority']),
  ];
  const expectedKeys = [
    'authenticateReviewer',
    'authorizationPath',
    'confirmIssuerAuthority',
    'decisionId',
    'decisions',
    'expectedPlanDigest',
    'issuerKeyringPath',
    'profile',
    'sourcePath',
    ...optionalKeys,
  ].sort();
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options)
      .sort()
      .some((key, index) => key !== expectedKeys[index]) ||
    Object.keys(options).length !== expectedKeys.length ||
    typeof options.authenticateReviewer !== 'function' ||
    typeof options.confirmIssuerAuthority !== 'function' ||
    (options.confirmDecisionStreamAuthority !== undefined &&
      typeof options.confirmDecisionStreamAuthority !== 'function') ||
    (options.clock !== undefined && typeof options.clock !== 'function')
  ) {
    throw new LocalSqliteAdoptionError('decision issuer options are invalid');
  }
  const lifetimeMs = options.lifetimeMs ?? 5 * 60 * 1_000;
  if (
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 1_000 ||
    lifetimeMs > 30 * 60 * 1_000
  ) {
    throw new LocalSqliteAdoptionError('decision issuer lifetime is invalid');
  }
  const clock = options.clock ?? Date.now;
  try {
    await options.confirmIssuerAuthority();
    const reviewer = await options.authenticateReviewer();
    const issuedAtMs = clock();
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) {
      throw new LocalSqliteAdoptionError('decision issuer clock is invalid');
    }
    if (
      !reviewer ||
      typeof reviewer !== 'object' ||
      Array.isArray(reviewer) ||
      !Number.isSafeInteger(reviewer.expiresAtMs) ||
      reviewer.expiresAtMs <= issuedAtMs
    ) {
      throw new LocalSqliteAdoptionError(
        'decision issuer authentication failed',
      );
    }
    const expiresAtMs = Math.min(reviewer.expiresAtMs, issuedAtMs + lifetimeMs);
    await options.confirmIssuerAuthority();
    const keyring =
      new (legacyCrontabDecisionIssuerKeyringModule().LegacyCrontabDecisionIssuerKeyringFileProvider)(
        options.issuerKeyringPath,
      );
    const guardedKeyProvider: PublishLegacyCrontabDecisionAuthorizationFileOptions['keyProvider'] =
      Object.freeze({
        async active() {
          await options.confirmIssuerAuthority();
          return keyring.active();
        },
        async resolve(keyId: string) {
          await options.confirmIssuerAuthority();
          return keyring.resolve(keyId);
        },
      });
    return await publishReviewedLegacyCrontabAdoptionDecisionAuthorizationFile({
      sourcePath: options.sourcePath,
      profile: options.profile,
      ...(options.legacyTimezone === undefined
        ? {}
        : { legacyTimezone: options.legacyTimezone }),
      expectedPlanDigest: options.expectedPlanDigest,
      decisionId: options.decisionId,
      reviewer,
      issuedAtMs,
      expiresAtMs,
      decisions: options.decisions,
      authorizationPath: options.authorizationPath,
      keyProvider: guardedKeyProvider,
      confirmExternalAuthority: async () => {
        await options.confirmIssuerAuthority();
        await options.confirmDecisionStreamAuthority?.();
      },
    });
  } catch (error) {
    if (error instanceof LocalSqliteAdoptionError) throw error;
    throw new LocalSqliteAdoptionError('decision issuer failed', error);
  }
}

export async function verifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFile(
  options: VerifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFileOptions,
): Promise<LegacyCrontabDecisionAuthorizationFileResult> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new LocalSqliteAdoptionError(
      'decision authorization verification options are invalid',
    );
  }
  if (!DIGEST_PATTERN.test(options.expectedPlanDigest)) {
    throw new LocalSqliteAdoptionError('expectedPlanDigest is invalid');
  }
  const plan = inspectLegacySqlitePath(options);
  if (plan.planDigest !== options.expectedPlanDigest) {
    throw new LocalSqliteAdoptionError(
      'source no longer matches the reviewed plan',
    );
  }
  try {
    return await legacyCrontabDecisionAuthorizationFileModule().verifyLegacyCrontabDecisionAuthorizationFile(
      {
        filePath: options.authorizationPath,
        expectedDecisionId: options.expectedDecisionId,
        expectedProfile: plan.profile,
        expectedPlanDigest: plan.planDigest,
        expectedInventoryDigest: plan.tasks.inventoryDigest,
        keyProvider: options.keyProvider,
        verifyReceipt: (receipt, decisions) =>
          verifyReviewedLegacyCrontabAdoptionDecisionReceipt({
            sourcePath: options.sourcePath,
            profile: options.profile,
            ...(options.legacyTimezone === undefined
              ? {}
              : { legacyTimezone: options.legacyTimezone }),
            expectedPlanDigest: options.expectedPlanDigest,
            receipt,
            decisions,
            observedAtMs: options.observedAtMs,
          }),
      },
    );
  } catch (error) {
    if (error instanceof LocalSqliteAdoptionError) throw error;
    throw new LocalSqliteAdoptionError(
      'decision authorization verification failed',
      error,
    );
  }
}

export async function publishReviewedLegacyCrontabAdoption(
  options: CommitReviewedLegacyCrontabAdoptionOptions,
): Promise<PublishReviewedLegacyCrontabAdoptionResult> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new LocalSqliteAdoptionError(
      'reviewed task publication options are invalid',
    );
  }
  assertAbsolutePath(options.sourcePath, 'sourcePath');
  assertAbsolutePath(options.targetPath, 'targetPath');
  assertAbsolutePath(options.authorizationPath, 'authorizationPath');
  assertDistinctPaths([
    options.sourcePath,
    options.targetPath,
    options.authorizationPath,
  ]);
  const source = acquireSourceWriteFence(
    options.sourcePath,
    options.busyTimeoutMs,
  );
  try {
    const sourceIdentity = fileIdentity(options.sourcePath);
    const plan = inspectLegacySqlitePath({
      sourcePath: options.sourcePath,
      profile: options.profile,
      ...(options.legacyTimezone === undefined
        ? {}
        : { legacyTimezone: options.legacyTimezone }),
    });
    if (
      plan.planDigest !== options.expectedPlanDigest ||
      plan.tasks.inventoryDigest.length !== 64
    ) {
      throw new LocalSqliteAdoptionError(
        'fenced source no longer matches the reviewed plan',
      );
    }
    return await legacyCrontabPublisherModule().publishReviewedLegacyCrontabAdoption(
      {
        sourceClient: source,
        sourcePath: options.sourcePath,
        targetPath: options.targetPath,
        authorizationPath: options.authorizationPath,
        profile: plan.profile,
        timezone: plan.tasks.timezone,
        expectedDecisionId: options.expectedDecisionId,
        expectedPlanDigest: plan.planDigest,
        expectedInventoryDigest: plan.tasks.inventoryDigest,
        projectId: options.projectId,
        mutationId: options.mutationId,
        requestId: options.requestId,
        keyProvider: options.keyProvider,
        observedAtMs: options.observedAtMs,
        ...(options.confirmReviewerAuthority === undefined
          ? {}
          : { confirmReviewerAuthority: options.confirmReviewerAuthority }),
        confirmSourceIdentity() {
          if (
            !sameFileIdentity(sourceIdentity, fileIdentity(options.sourcePath))
          ) {
            throw new LocalSqliteAdoptionError(
              'legacy source identity changed during task publication',
            );
          }
        },
      },
    );
  } catch (error) {
    if (error instanceof LocalSqliteAdoptionError) throw error;
    throw new LocalSqliteAdoptionError(
      'reviewed task publication failed',
      error,
    );
  } finally {
    releaseSourceWriteFence(source);
  }
}
