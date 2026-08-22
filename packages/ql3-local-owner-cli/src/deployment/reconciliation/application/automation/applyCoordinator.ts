import fs from 'node:fs';

import { applyReconciliationAutomationDecision } from '@qinglong/local-admin/reconciliation-automation-decision';
import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';
import {
  establishAuthenticatedLocalCommand,
  type AuthenticatedLocalCommand,
} from '@qinglong/local-owner-console/authenticated-command';
import { openLocalSqliteAuthenticationReadDatabase } from '@qinglong/local-sqlite/authentication-read';
import {
  createLocalSqliteRolloutBackup,
  inspectLocalSqliteSnapshot,
  restoreLocalSqliteSnapshot,
} from '@qinglong/local-sqlite/rollout-safety';
import type { SecurityPrincipal } from '@qinglong/runtime-core/security';

import { currentIdentity } from '../../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../../foundation/error';
import {
  preflightPublishedFile,
  publishExactFile,
  validatePrivateDirectory,
} from '../../../foundation/files';
import {
  advanceLocalCutoverInstanceHead,
  readLocalCutoverInstanceHead,
  type LocalCutoverInstanceHead,
} from '../../../cutover/instanceLineage';
import {
  inspectLocalReconciliationSealedBundle,
  withLocalReconciliationSealedDatabaseAsync,
} from '../../sealed-bundle/reader';
import { readLocalReconciliationCaptureIntent } from '../../preparation';
import { proveLocalReconciliationStoppedState } from '../../stoppedProof';
import { LocalReconciliationReviewIssuerKeyringFileProvider } from '../../review/issuerKeyring';
import {
  normalizeLocalReconciliationAutomationApplyCommand,
  normalizeLocalReconciliationAutomationApplyRollbackCommand,
  normalizeLocalReconciliationAutomationApplyVerifyCommand,
  type LocalReconciliationAutomationApplyCommand,
  type LocalReconciliationAutomationApplyOptions,
  type LocalReconciliationAutomationApplyResult,
} from './applyContract';
import {
  buildLocalReconciliationAutomationApplyIntent,
  buildLocalReconciliationAutomationApplyReceipt,
  buildLocalReconciliationAutomationRollbackReceipt,
  localReconciliationAutomationApplyEvidenceContents,
  type LocalReconciliationAutomationApplyIntent,
  type LocalReconciliationAutomationApplyReceipt,
} from './applyEvidence';
import { readLocalReconciliationAutomationDecisionTerminal } from './decisionCoordinator';
import { createLocalReconciliationAutomationRequirementFactory } from './planReader';
import {
  ensureLocalReconciliationAutomationApplyLayout,
  localReconciliationAutomationApplyPaths,
  prepareLocalReconciliationAutomationRollbackSource,
  readLocalReconciliationAutomationApplyIntent,
  readLocalReconciliationAutomationApplyReceipt,
  readLocalReconciliationAutomationRollbackReceipt,
  sealLocalReconciliationAutomationAppliedStorage,
  sealLocalReconciliationAutomationRolledBackStorage,
  validateLocalReconciliationAutomationAppliedStorage,
  validateLocalReconciliationAutomationApplyCatalog,
  validateLocalReconciliationAutomationApplyLayout,
  validateLocalReconciliationAutomationRolledBackStorage,
} from './applyStorage';

const MAX_AUTHENTICATION_AGE_MS = 5 * 60 * 1_000;

type AuthenticationDatabase = Awaited<
  ReturnType<typeof openLocalSqliteAuthenticationReadDatabase>
>;

export interface LocalReconciliationAutomationApplyDependencies {
  readonly openAuthenticationDatabase?: typeof openLocalSqliteAuthenticationReadDatabase;
  readonly authenticate?: typeof establishAuthenticatedLocalCommand;
  readonly createBackup?: typeof createLocalSqliteRolloutBackup;
  readonly inspectSnapshot?: typeof inspectLocalSqliteSnapshot;
  readonly restoreSnapshot?: typeof restoreLocalSqliteSnapshot;
  readonly afterBackupPublished?: () => void;
  readonly afterPreparedHead?: () => void;
  readonly afterDatabaseCommit?: () => void;
  readonly afterReceiptPublished?: () => void;
  readonly afterAppliedHead?: () => void;
  readonly afterAppliedSeal?: () => void;
  readonly afterRestore?: () => void;
  readonly afterRollbackReceipt?: () => void;
  readonly afterRollbackHead?: () => void;
  readonly afterRollbackSeal?: () => void;
}

function fail(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation automation apply ${message}`,
    { cause },
  );
}

function decisionOptions(
  options: Readonly<LocalReconciliationAutomationApplyOptions>,
) {
  return Object.freeze({
    deploymentRoot: options.deploymentRoot,
    applicationRoot: options.applicationRoot,
    automationRoot: options.automationRoot,
    automationDecisionRoot: options.automationDecisionRoot,
    allowRootService: options.allowRootService,
  });
}

function advance(
  intent: Readonly<LocalReconciliationAutomationApplyIntent>,
  uid: number,
  state:
    | 'reconciliation_automation_apply_prepared'
    | 'reconciliation_automation_applied'
    | 'reconciliation_automation_rolled_back',
  digest: string,
  atMs: number,
): Readonly<LocalCutoverInstanceHead> {
  return advanceLocalCutoverInstanceHead(
    {
      options: { deploymentRoot: intent.command.options.deploymentRoot },
      request: {
        cutoverId: intent.cutoverId,
        profile: intent.profile,
        instanceId: intent.instanceId,
        expectedActivationDigest: intent.activationDigest,
        requestedAtMs: atMs,
      },
    },
    uid,
    state,
    intent.generation,
    digest,
  );
}

function result(
  operation: LocalReconciliationAutomationApplyResult['operation'],
  status: LocalReconciliationAutomationApplyResult['status'],
  receipt: Readonly<LocalReconciliationAutomationApplyReceipt>,
  intent: Readonly<LocalReconciliationAutomationApplyIntent>,
  head: Readonly<LocalCutoverInstanceHead>,
): Readonly<LocalReconciliationAutomationApplyResult> {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    status,
    state: head.state as
      | 'reconciliation_automation_applied'
      | 'reconciliation_automation_rolled_back',
    decisionId: receipt.decisionId,
    automationId: receipt.automationId,
    applyDigest: receipt.applyDigest,
    publicationDigest: receipt.publicationDigest,
    adoptedTaskCount: receipt.adoptedTaskCount,
    adoptedTriggerCount: receipt.adoptedTriggerCount,
    backupSha256: intent.backup.sha256,
    instanceHeadDigest: head.headDigest,
  });
}

function assertReviewer(
  authenticated: Readonly<AuthenticatedLocalCommand>,
  reviewer: Readonly<SecurityPrincipal>,
  atMs: number,
): void {
  const principal = authenticated.principal;
  if (
    reviewer.subject.type !== 'user' ||
    principal.subject.type !== 'user' ||
    reviewer.subject.id !== principal.subject.id ||
    principal.assurance !== 'local_console' ||
    principal.authenticatedAtMs > atMs ||
    atMs - principal.authenticatedAtMs > MAX_AUTHENTICATION_AGE_MS ||
    principal.expiresAtMs <= atMs
  )
    fail('current reviewer authentication is not strong or identical');
}

async function authenticate(
  options: Readonly<LocalReconciliationAutomationApplyOptions>,
  atMs: number,
  profile: 'edge' | 'standalone',
  reviewer: Readonly<SecurityPrincipal>,
  dependencies: LocalReconciliationAutomationApplyDependencies,
): Promise<
  Readonly<{
    authenticated: Readonly<AuthenticatedLocalCommand>;
    database: AuthenticationDatabase;
  }>
> {
  const open =
    dependencies.openAuthenticationDatabase ??
    openLocalSqliteAuthenticationReadDatabase;
  const database = await open({
    databasePath: options.targetDatabasePath,
    profile,
    ...(options.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: options.busyTimeoutMs }),
  });
  try {
    const selected = await (
      dependencies.authenticate ?? establishAuthenticatedLocalCommand
    )(database, {
      deploymentRoot: options.deploymentRoot,
      databasePath: options.targetDatabasePath,
      ownerPepperKeyringDirectory: options.ownerPepperKeyringDirectory,
      credentialFilePath: options.credentialFilePath,
      authenticationNamespace: 'local_reconciliation_automation_apply',
      now: () => atMs,
    });
    assertReviewer(selected, reviewer, atMs);
    return Object.freeze({ authenticated: selected, database });
  } catch (error) {
    await database.close();
    throw error;
  }
}

function exactBundle(
  intent: Readonly<LocalReconciliationAutomationApplyIntent>,
  captureRoot: string,
  captureId: string,
  expectedBundleDigest: string,
  expectedFingerprintDigest: string,
  uid: number,
): void {
  const current = inspectLocalReconciliationSealedBundle(
    captureRoot,
    captureId,
    uid,
  );
  if (
    current.receipt.bundleDigest !== expectedBundleDigest ||
    current.fingerprintDigest !== expectedFingerprintDigest ||
    intent.command.request.expectedDecisionDigest.length !== 64
  )
    fail('sealed source authority drifted');
}

function verifyIntentCommand(
  intent: Readonly<LocalReconciliationAutomationApplyIntent>,
  command: Readonly<LocalReconciliationAutomationApplyCommand>,
): void {
  if (
    intent.command.request.automationId !== command.request.automationId ||
    intent.command.request.decisionId !== command.request.decisionId ||
    intent.command.request.expectedDecisionDigest !==
      command.request.expectedDecisionDigest ||
    intent.command.request.mutationId !== command.request.mutationId ||
    intent.command.request.requestId !== command.request.requestId ||
    intent.command.request.appliedAtMs !== command.request.appliedAtMs ||
    intent.command.request.expectedHeadDigest !==
      command.request.expectedHeadDigest ||
    JSON.stringify(intent.command.options) !== JSON.stringify(command.options)
  )
    fail('apply command is not an exact replay');
}

export async function applyLocalReconciliationAutomation(
  value: unknown,
  dependencies: LocalReconciliationAutomationApplyDependencies = {},
): Promise<Readonly<LocalReconciliationAutomationApplyResult>> {
  const command = normalizeLocalReconciliationAutomationApplyCommand(value);
  const uid = currentIdentity().uid;
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
    [command.options.automationRoot, 'automationRoot'],
    [command.options.automationDecisionRoot, 'automationDecisionRoot'],
    [command.options.automationApplyRoot, 'automationApplyRoot'],
  ] as const)
    validatePrivateDirectory(directory, uid, label);
  const selected = localReconciliationAutomationApplyPaths(
    command.options.automationApplyRoot,
    command.request.automationId,
  );
  ensureLocalReconciliationAutomationApplyLayout(selected, uid);
  validateLocalReconciliationAutomationApplyCatalog(selected);

  const terminal = await readLocalReconciliationAutomationDecisionTerminal(
    decisionOptions(command.options),
    command.request.automationId,
    uid,
  );
  if (
    terminal.receipt.decisionId !== command.request.decisionId ||
    terminal.receipt.decisionDigest !== command.request.expectedDecisionDigest
  )
    fail('apply command is detached from signed decision');
  const capture = readLocalReconciliationCaptureIntent(
    terminal.plan.intent.command.options.captureRoot,
    terminal.plan.intent.command.request.captureId,
  );
  if (
    capture.command.request.targetDatabasePath !==
    command.options.targetDatabasePath
  ) {
    fail('target database is detached from stopped capture');
  }

  let intent: Readonly<LocalReconciliationAutomationApplyIntent>;
  const recoveringPreparedIntent = fs.existsSync(selected.intent);
  let head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    terminal.intent.instanceId,
    uid,
  );
  if (fs.existsSync(selected.intent)) {
    intent = readLocalReconciliationAutomationApplyIntent(selected, uid);
    verifyIntentCommand(intent, command);
  } else {
    if (
      head.state !== 'reconciliation_automation_reviewed' ||
      head.headDigest !== command.request.expectedHeadDigest ||
      head.sourceRecordDigest !== terminal.receipt.decisionDigest
    )
      fail('apply lost reviewed head compare-and-swap');
    const before = proveLocalReconciliationStoppedState(capture.command, uid);
    const backup = await (
      dependencies.createBackup ?? createLocalSqliteRolloutBackup
    )({
      databasePath: command.options.targetDatabasePath,
      backupPath: selected.backup,
      profile: terminal.intent.profile,
      ...(command.options.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: command.options.busyTimeoutMs }),
    });
    const after = proveLocalReconciliationStoppedState(capture.command, uid);
    if (after.proofDigest !== before.proofDigest)
      fail('stopped target drifted across backup');
    dependencies.afterBackupPublished?.();
    intent = buildLocalReconciliationAutomationApplyIntent({
      command,
      instanceId: terminal.intent.instanceId,
      cutoverId: terminal.intent.cutoverId,
      activationDigest: terminal.intent.activationDigest,
      profile: terminal.intent.profile,
      projectId: terminal.intent.projectId,
      generation: terminal.intent.generation,
      stoppedProofDigest: before.proofDigest,
      backup,
    });
    publishExactFile(
      selected.intent,
      localReconciliationAutomationApplyEvidenceContents(intent),
      0o600,
      uid,
      'automation apply intent',
    );
    head = advance(
      intent,
      uid,
      'reconciliation_automation_apply_prepared',
      intent.preparationDigest,
      command.request.appliedAtMs,
    );
    dependencies.afterPreparedHead?.();
  }

  if (fs.existsSync(selected.receipt)) {
    const receipt = readLocalReconciliationAutomationApplyReceipt(
      selected,
      uid,
    );
    const current = await (
      dependencies.inspectSnapshot ?? inspectLocalSqliteSnapshot
    )({
      databasePath: command.options.targetDatabasePath,
      profile: intent.profile,
    });
    if (current.sha256 !== receipt.targetAfter.sha256)
      fail('terminal apply target drifted');
    if (
      head.state === 'reconciliation_automation_apply_prepared' &&
      head.sourceRecordDigest === intent.preparationDigest
    ) {
      head = advance(
        intent,
        uid,
        'reconciliation_automation_applied',
        receipt.applyDigest,
        receipt.appliedAtMs,
      );
      dependencies.afterAppliedHead?.();
    } else if (
      head.state !== 'reconciliation_automation_applied' ||
      receipt.applyDigest !== head.sourceRecordDigest
    )
      fail('terminal apply receipt drifted');
    sealLocalReconciliationAutomationAppliedStorage(
      selected,
      intent,
      receipt,
      uid,
    );
    dependencies.afterAppliedSeal?.();
    return result(command.operation, 'existing', receipt, intent, head);
  }
  if (
    head.state !== 'reconciliation_automation_apply_prepared' ||
    head.sourceRecordDigest !== intent.preparationDigest
  )
    fail('apply lost prepared head compare-and-swap');
  if (!recoveringPreparedIntent) {
    const stopped = proveLocalReconciliationStoppedState(capture.command, uid);
    if (stopped.proofDigest !== intent.stoppedProofDigest)
      fail('stopped proof drifted before write');
  }

  const authenticatedScope = await authenticate(
    command.options,
    command.request.appliedAtMs,
    intent.profile,
    terminal.reviewer,
    dependencies,
  );
  let publication;
  try {
    const openRequirements =
      createLocalReconciliationAutomationRequirementFactory(
        terminal.context.automation.planPath,
        terminal.context.automation.receipt,
        uid,
      );
    const keyProvider = new LocalReconciliationReviewIssuerKeyringFileProvider(
      terminal.context.application.intent.command.options.issuerKeyringPath,
    );
    const applied = await withLocalReconciliationSealedDatabaseAsync(
      terminal.plan.bundle,
      'legacy',
      uid,
      {},
      async (sourceClient) =>
        applyReconciliationAutomationDecision({
          authorizationPath: terminal.authorizationPath,
          decisionId: command.request.decisionId,
          profile: intent.profile,
          automationPlanDigest: terminal.receipt.automationPlanDigest,
          inventoryDigest: terminal.receipt.legacyInventoryDigest,
          sourceClient,
          timezone: terminal.intent.legacyTimezone,
          keyProvider,
          observedAtMs: command.request.appliedAtMs,
          openRequirements,
          allowedModes: [0o400],
          allowedParentModes: [0o500],
          targetPath: command.options.targetDatabasePath,
          projectId: intent.projectId,
          mutationId: command.request.mutationId,
          requestId: command.request.requestId,
          confirmSourceIdentity() {
            exactBundle(
              intent,
              terminal.plan.bundle.captureRoot,
              terminal.plan.receipt.captureId,
              terminal.plan.bundle.receipt.bundleDigest,
              terminal.plan.bundle.fingerprintDigest,
              uid,
            );
            const currentHead = readLocalCutoverInstanceHead(
              command.options.deploymentRoot,
              intent.instanceId,
              uid,
            );
            if (
              currentHead.state !==
                'reconciliation_automation_apply_prepared' ||
              currentHead.sourceRecordDigest !== intent.preparationDigest
            )
              fail('apply lost write head authority');
          },
          async confirmReviewerAuthority(reviewer) {
            assertReviewer(
              authenticatedScope.authenticated,
              reviewer,
              command.request.appliedAtMs,
            );
            await authenticatedScope.authenticated.confirm();
          },
        }),
    );
    if (applied === null) fail('sealed Legacy source requires manual handling');
    publication = applied;
  } finally {
    await authenticatedScope.database.close();
  }
  dependencies.afterDatabaseCommit?.();
  const targetAfter = await (
    dependencies.inspectSnapshot ?? inspectLocalSqliteSnapshot
  )({
    databasePath: command.options.targetDatabasePath,
    profile: intent.profile,
  });
  const receipt = buildLocalReconciliationAutomationApplyReceipt({
    decisionId: command.request.decisionId,
    automationId: command.request.automationId,
    mutationId: command.request.mutationId,
    preparationDigest: intent.preparationDigest,
    preparedHeadDigest: head.headDigest,
    publicationDigest: publication.adoption.publicationDigest,
    adoptedTaskCount: publication.adoption.adoptedTaskCount,
    adoptedTriggerCount: publication.adoption.adoptedTriggerCount,
    skippedCount: publication.adoption.skippedCount,
    targetAfter,
    appliedAtMs: command.request.appliedAtMs,
  });
  preflightPublishedFile(
    selected.receipt,
    localReconciliationAutomationApplyEvidenceContents(receipt),
    0o600,
    uid,
    'automation apply receipt',
  );
  publishExactFile(
    selected.receipt,
    localReconciliationAutomationApplyEvidenceContents(receipt),
    0o600,
    uid,
    'automation apply receipt',
  );
  dependencies.afterReceiptPublished?.();
  head = advance(
    intent,
    uid,
    'reconciliation_automation_applied',
    receipt.applyDigest,
    command.request.appliedAtMs,
  );
  dependencies.afterAppliedHead?.();
  sealLocalReconciliationAutomationAppliedStorage(
    selected,
    intent,
    receipt,
    uid,
  );
  dependencies.afterAppliedSeal?.();
  return result(
    command.operation,
    publication.status === 'existing' ? 'existing' : 'applied',
    receipt,
    intent,
    head,
  );
}

export async function verifyLocalReconciliationAutomationApply(
  value: unknown,
): Promise<Readonly<LocalReconciliationAutomationApplyResult>> {
  const command =
    normalizeLocalReconciliationAutomationApplyVerifyCommand(value);
  const uid = currentIdentity().uid;
  const selected = localReconciliationAutomationApplyPaths(
    command.options.automationApplyRoot,
    command.request.automationId,
  );
  validatePrivateDirectory(
    command.options.automationApplyRoot,
    uid,
    'automationApplyRoot',
  );
  validateLocalReconciliationAutomationApplyLayout(selected, uid);
  validateLocalReconciliationAutomationApplyCatalog(selected);
  const intent = readLocalReconciliationAutomationApplyIntent(selected, uid);
  const receipt = readLocalReconciliationAutomationApplyReceipt(selected, uid);
  if (
    intent.command.request.decisionId !== command.request.decisionId ||
    receipt.decisionId !== command.request.decisionId ||
    receipt.automationId !== command.request.automationId ||
    receipt.applyDigest !== command.request.expectedApplyDigest
  )
    fail('verify command is detached from apply receipt');
  await readLocalReconciliationAutomationDecisionTerminal(
    decisionOptions(command.options),
    command.request.automationId,
    uid,
  );
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    uid,
  );
  if (head.state === 'reconciliation_automation_applied') {
    validateLocalReconciliationAutomationAppliedStorage(selected, intent, uid);
    if (head.sourceRecordDigest !== receipt.applyDigest)
      fail('applied head drifted');
    const current = await inspectLocalSqliteSnapshot({
      databasePath: command.options.targetDatabasePath,
      profile: intent.profile,
    });
    if (current.sha256 !== receipt.targetAfter.sha256)
      fail('applied target drifted');
    return result(command.operation, 'verified', receipt, intent, head);
  }
  if (
    head.state === 'reconciliation_automation_rolled_back' &&
    fs.existsSync(selected.rollbackReceipt)
  ) {
    validateLocalReconciliationAutomationRolledBackStorage(selected, uid);
    const rollback = readLocalReconciliationAutomationRollbackReceipt(
      selected,
      uid,
    );
    if (
      rollback.applyDigest !== receipt.applyDigest ||
      head.sourceRecordDigest !== rollback.rollbackDigest
    )
      fail('rollback head drifted');
    const current = await inspectLocalSqliteSnapshot({
      databasePath: command.options.targetDatabasePath,
      profile: intent.profile,
    });
    if (
      current.sha256 !== intent.backup.sha256 ||
      current.sha256 !== rollback.restored.sha256
    )
      fail('rolled-back target drifted');
    return result(command.operation, 'verified', receipt, intent, head);
  }
  return fail('apply head is not terminal');
}

export async function rollbackLocalReconciliationAutomationApply(
  value: unknown,
  dependencies: LocalReconciliationAutomationApplyDependencies = {},
): Promise<Readonly<LocalReconciliationAutomationApplyResult>> {
  const command =
    normalizeLocalReconciliationAutomationApplyRollbackCommand(value);
  const uid = currentIdentity().uid;
  const selected = localReconciliationAutomationApplyPaths(
    command.options.automationApplyRoot,
    command.request.automationId,
  );
  validatePrivateDirectory(
    command.options.automationApplyRoot,
    uid,
    'automationApplyRoot',
  );
  validateLocalReconciliationAutomationApplyLayout(selected, uid);
  validateLocalReconciliationAutomationApplyCatalog(selected);
  const intent = readLocalReconciliationAutomationApplyIntent(selected, uid);
  const receipt = readLocalReconciliationAutomationApplyReceipt(selected, uid);
  if (
    receipt.decisionId !== command.request.decisionId ||
    receipt.automationId !== command.request.automationId ||
    receipt.applyDigest !== command.request.expectedApplyDigest
  )
    fail('rollback command is detached from apply receipt');
  const terminal = await readLocalReconciliationAutomationDecisionTerminal(
    decisionOptions(command.options),
    command.request.automationId,
    uid,
  );
  let head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    uid,
  );
  if (fs.existsSync(selected.rollbackReceipt)) {
    const rollback = readLocalReconciliationAutomationRollbackReceipt(
      selected,
      uid,
    );
    const current = await (
      dependencies.inspectSnapshot ?? inspectLocalSqliteSnapshot
    )({
      databasePath: command.options.targetDatabasePath,
      profile: intent.profile,
    });
    if (current.sha256 !== rollback.restored.sha256)
      fail('rollback replay target drifted');
    if (
      head.state === 'reconciliation_automation_applied' &&
      head.sourceRecordDigest === receipt.applyDigest
    ) {
      head = advance(
        intent,
        uid,
        'reconciliation_automation_rolled_back',
        rollback.rollbackDigest,
        rollback.rolledBackAtMs,
      );
      dependencies.afterRollbackHead?.();
    } else if (
      head.state !== 'reconciliation_automation_rolled_back' ||
      head.sourceRecordDigest !== rollback.rollbackDigest
    )
      fail('rollback replay drifted');
    sealLocalReconciliationAutomationRolledBackStorage(
      selected,
      intent,
      receipt,
      rollback,
      uid,
    );
    dependencies.afterRollbackSeal?.();
    return result(command.operation, 'existing', receipt, intent, head);
  }
  if (
    head.state !== 'reconciliation_automation_applied' ||
    head.headDigest !== command.request.expectedHeadDigest ||
    head.sourceRecordDigest !== receipt.applyDigest
  )
    fail('rollback lost applied head compare-and-swap');
  const current = await (
    dependencies.inspectSnapshot ?? inspectLocalSqliteSnapshot
  )({
    databasePath: command.options.targetDatabasePath,
    profile: intent.profile,
  });
  if (current.sha256 === intent.backup.sha256) {
    const rollback = buildLocalReconciliationAutomationRollbackReceipt({
      decisionId: receipt.decisionId,
      automationId: receipt.automationId,
      applyDigest: receipt.applyDigest,
      restored: current,
      rolledBackAtMs: command.request.rolledBackAtMs,
    });
    publishExactFile(
      selected.rollbackReceipt,
      localReconciliationAutomationApplyEvidenceContents(rollback),
      0o600,
      uid,
      'automation rollback receipt',
    );
    dependencies.afterRollbackReceipt?.();
    head = advance(
      intent,
      uid,
      'reconciliation_automation_rolled_back',
      rollback.rollbackDigest,
      command.request.rolledBackAtMs,
    );
    dependencies.afterRollbackHead?.();
    sealLocalReconciliationAutomationRolledBackStorage(
      selected,
      intent,
      receipt,
      rollback,
      uid,
    );
    dependencies.afterRollbackSeal?.();
    return result(command.operation, 'existing', receipt, intent, head);
  }
  if (current.sha256 !== receipt.targetAfter.sha256)
    fail('rollback current target drifted');
  sealLocalReconciliationAutomationAppliedStorage(
    selected,
    intent,
    receipt,
    uid,
  );

  const authenticatedScope = await authenticate(
    command.options,
    command.request.rolledBackAtMs,
    intent.profile,
    terminal.reviewer,
    dependencies,
  );
  try {
    const openRequirements =
      createLocalReconciliationAutomationRequirementFactory(
        terminal.context.automation.planPath,
        terminal.context.automation.receipt,
        uid,
      );
    const keyProvider = new LocalReconciliationReviewIssuerKeyringFileProvider(
      terminal.context.application.intent.command.options.issuerKeyringPath,
    );
    const replay = await withLocalReconciliationSealedDatabaseAsync(
      terminal.plan.bundle,
      'legacy',
      uid,
      {},
      async (sourceClient) =>
        applyReconciliationAutomationDecision({
          authorizationPath: terminal.authorizationPath,
          decisionId: receipt.decisionId,
          profile: intent.profile,
          automationPlanDigest: terminal.receipt.automationPlanDigest,
          inventoryDigest: terminal.receipt.legacyInventoryDigest,
          sourceClient,
          timezone: terminal.intent.legacyTimezone,
          keyProvider,
          observedAtMs: intent.command.request.appliedAtMs,
          openRequirements,
          allowedModes: [0o400],
          allowedParentModes: [0o500],
          targetPath: command.options.targetDatabasePath,
          projectId: intent.projectId,
          mutationId: intent.command.request.mutationId,
          requestId: intent.command.request.requestId,
          confirmSourceIdentity() {
            const currentHead = readLocalCutoverInstanceHead(
              command.options.deploymentRoot,
              intent.instanceId,
              uid,
            );
            if (
              currentHead.state !== 'reconciliation_automation_applied' ||
              currentHead.sourceRecordDigest !== receipt.applyDigest
            )
              fail('rollback lost current policy fence');
          },
          async confirmReviewerAuthority(reviewer) {
            assertReviewer(
              authenticatedScope.authenticated,
              reviewer,
              command.request.rolledBackAtMs,
            );
            await authenticatedScope.authenticated.confirm();
          },
        }),
    );
    if (
      replay === null ||
      replay.status !== 'existing' ||
      replay.adoption.publicationDigest !== receipt.publicationDigest
    )
      fail('rollback could not verify current publication');
  } finally {
    await authenticatedScope.database.close();
  }
  prepareLocalReconciliationAutomationRollbackSource(selected, intent, uid);
  const restored = await (
    dependencies.restoreSnapshot ?? restoreLocalSqliteSnapshot
  )({
    databasePath: command.options.targetDatabasePath,
    sourceSnapshotPath: selected.rollbackSource,
    restoreStagePath: selected.restoreStage,
    replacedDatabasePath: selected.replaced,
    expectedCurrentSha256: receipt.targetAfter.sha256,
    expectedSourceSha256: intent.backup.sha256,
    preserveDatabaseIdentity: true,
    profile: intent.profile,
    ...(command.options.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: command.options.busyTimeoutMs }),
  });
  dependencies.afterRestore?.();
  const rollback = buildLocalReconciliationAutomationRollbackReceipt({
    decisionId: receipt.decisionId,
    automationId: receipt.automationId,
    applyDigest: receipt.applyDigest,
    restored: Object.freeze({
      contractVersion: restored.contractVersion,
      sha256: restored.sha256,
      bytes: restored.bytes,
      pageCount: restored.pageCount,
      pageSize: restored.pageSize,
    }),
    rolledBackAtMs: command.request.rolledBackAtMs,
  });
  publishExactFile(
    selected.rollbackReceipt,
    localReconciliationAutomationApplyEvidenceContents(rollback),
    0o600,
    uid,
    'automation rollback receipt',
  );
  dependencies.afterRollbackReceipt?.();
  head = advance(
    intent,
    uid,
    'reconciliation_automation_rolled_back',
    rollback.rollbackDigest,
    command.request.rolledBackAtMs,
  );
  dependencies.afterRollbackHead?.();
  sealLocalReconciliationAutomationRolledBackStorage(
    selected,
    intent,
    receipt,
    rollback,
    uid,
  );
  dependencies.afterRollbackSeal?.();
  return result(command.operation, 'rolled_back', receipt, intent, head);
}

export async function applyLocalReconciliationAutomationCommandFile(
  filePath: string,
): Promise<Readonly<LocalReconciliationAutomationApplyResult>> {
  return applyLocalReconciliationAutomation(
    readPrivateLocalCommandFile(filePath),
  );
}

export async function verifyLocalReconciliationAutomationApplyCommandFile(
  filePath: string,
): Promise<Readonly<LocalReconciliationAutomationApplyResult>> {
  return verifyLocalReconciliationAutomationApply(
    readPrivateLocalCommandFile(filePath),
  );
}

export async function rollbackLocalReconciliationAutomationApplyCommandFile(
  filePath: string,
): Promise<Readonly<LocalReconciliationAutomationApplyResult>> {
  return rollbackLocalReconciliationAutomationApply(
    readPrivateLocalCommandFile(filePath),
  );
}
