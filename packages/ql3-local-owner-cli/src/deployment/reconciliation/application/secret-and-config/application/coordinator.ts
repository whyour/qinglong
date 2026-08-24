import fs from 'node:fs';

import {
  applyPreparedReconciliationSecretConfigApplication,
  prepareReconciliationSecretConfigApplication,
  type PreparedReconciliationSecretConfigMaterial,
} from '@qinglong/local-admin/reconciliation-secret-and-config-application';
import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';
import {
  establishAuthenticatedLocalCommand,
  type AuthenticatedLocalCommand,
} from '@qinglong/local-owner-console/authenticated-command';
import { LocalSecretKeyringFileProvider } from '@qinglong/local-secret';
import { openLocalSqliteAuthenticationReadDatabase } from '@qinglong/local-sqlite/authentication-read';
import {
  createLocalSqliteRolloutBackup,
  inspectLocalSqliteSnapshot,
  restoreLocalSqliteSnapshot,
} from '@qinglong/local-sqlite/rollout-safety';
import type { SecurityPrincipal } from '@qinglong/runtime-core/security';

import { currentIdentity } from '../../../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../../../foundation/error';
import {
  publishExactFile,
  validatePrivateDirectory,
} from '../../../../foundation/files';
import {
  advanceLocalCutoverInstanceHead,
  readLocalCutoverInstanceHead,
  type LocalCutoverInstanceHead,
} from '../../../../cutover/instanceLineage';
import { readLocalReconciliationCaptureIntent } from '../../../preparation';
import {
  inspectLocalReconciliationSealedBundle,
  withLocalReconciliationSealedDatabaseAsync,
} from '../../../sealed-bundle/reader';
import { proveLocalReconciliationStoppedState } from '../../../stoppedProof';
import {
  normalizeLocalReconciliationSecretConfigApplyCommand,
  normalizeLocalReconciliationSecretConfigApplyRollbackCommand,
  normalizeLocalReconciliationSecretConfigApplyVerifyCommand,
  type LocalReconciliationSecretConfigApplyCommand,
  type LocalReconciliationSecretConfigApplyOptions,
  type LocalReconciliationSecretConfigApplyResult,
} from './contract';
import {
  buildLocalReconciliationSecretConfigApplyIntent,
  buildLocalReconciliationSecretConfigApplyReceipt,
  buildLocalReconciliationSecretConfigRollbackReceipt,
  localReconciliationSecretConfigApplyEvidenceContents,
  type LocalReconciliationSecretConfigApplyIntent,
  type LocalReconciliationSecretConfigApplyReceipt,
} from './evidence';
import {
  discardUnpreparedLocalReconciliationSecretConfigMaterials,
  ensureLocalReconciliationSecretConfigApplyLayout,
  localReconciliationSecretConfigApplyPaths,
  prepareLocalReconciliationSecretConfigRollbackSource,
  publishLocalReconciliationSecretConfigMaterials,
  readLocalReconciliationSecretConfigApplyIntent,
  readLocalReconciliationSecretConfigApplyReceipt,
  readLocalReconciliationSecretConfigMaterials,
  readLocalReconciliationSecretConfigRollbackReceipt,
  sealLocalReconciliationSecretConfigAppliedStorage,
  sealLocalReconciliationSecretConfigRolledBackStorage,
  validateLocalReconciliationSecretConfigAppliedStorage,
  validateLocalReconciliationSecretConfigApplyCatalog,
  validateLocalReconciliationSecretConfigRolledBackStorage,
} from './storage';
import { readLocalReconciliationSecretConfigDecisionTerminal } from '../decisionCoordinator';
import { createLocalReconciliationSecretConfigDecisionRequirementFactory } from '../planReader';

const MAX_AUTHENTICATION_AGE_MS = 5 * 60 * 1_000;
const APPLY_HEAD_STATES = Object.freeze([
  'reconciliation_secret_config_apply_prepared',
  'reconciliation_secret_config_applied',
  'reconciliation_secret_config_rolled_back',
] as const);

type AuthenticationDatabase = Awaited<
  ReturnType<typeof openLocalSqliteAuthenticationReadDatabase>
>;

export interface LocalReconciliationSecretConfigApplyDependencies {
  readonly openAuthenticationDatabase?: typeof openLocalSqliteAuthenticationReadDatabase;
  readonly authenticate?: typeof establishAuthenticatedLocalCommand;
  readonly prepareApplication?: typeof prepareReconciliationSecretConfigApplication;
  readonly applyApplication?: typeof applyPreparedReconciliationSecretConfigApplication;
  readonly createBackup?: typeof createLocalSqliteRolloutBackup;
  readonly inspectSnapshot?: typeof inspectLocalSqliteSnapshot;
  readonly restoreSnapshot?: typeof restoreLocalSqliteSnapshot;
  readonly afterMaterialPublished?: () => void;
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
    `reconciliation secret config apply ${message}`,
    { cause },
  );
}

function decisionOptions(
  options: Readonly<LocalReconciliationSecretConfigApplyOptions>,
) {
  return Object.freeze({
    deploymentRoot: options.deploymentRoot,
    applicationRoot: options.applicationRoot,
    secretConfigRoot: options.secretConfigRoot,
    secretConfigDecisionRoot: options.secretConfigDecisionRoot,
    allowRootService: options.allowRootService,
  });
}

function advance(
  intent: Readonly<LocalReconciliationSecretConfigApplyIntent>,
  uid: number,
  state:
    | 'reconciliation_secret_config_apply_prepared'
    | 'reconciliation_secret_config_applied'
    | 'reconciliation_secret_config_rolled_back',
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
  operation: LocalReconciliationSecretConfigApplyResult['operation'],
  status: LocalReconciliationSecretConfigApplyResult['status'],
  receipt: Readonly<LocalReconciliationSecretConfigApplyReceipt>,
  intent: Readonly<LocalReconciliationSecretConfigApplyIntent>,
  head: Readonly<LocalCutoverInstanceHead>,
): Readonly<LocalReconciliationSecretConfigApplyResult> {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    status,
    state: head.state as
      | 'reconciliation_secret_config_applied'
      | 'reconciliation_secret_config_rolled_back',
    decisionId: receipt.decisionId,
    secretConfigId: receipt.secretConfigId,
    applyDigest: receipt.applyDigest,
    publicationDigest: receipt.publicationDigest,
    activeBindingCount: receipt.activeBindingCount,
    disabledPreservationCount: receipt.disabledPreservationCount,
    updatedTaskCount: receipt.updatedTaskCount,
    updatedTriggerCount: receipt.updatedTriggerCount,
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
  ) {
    fail('current reviewer authentication is not strong or identical');
  }
}

async function authenticate(
  options: Readonly<LocalReconciliationSecretConfigApplyOptions>,
  atMs: number,
  profile: 'edge' | 'standalone',
  reviewer: Readonly<SecurityPrincipal>,
  dependencies: LocalReconciliationSecretConfigApplyDependencies,
): Promise<
  Readonly<{
    authenticated: Readonly<AuthenticatedLocalCommand>;
    database: AuthenticationDatabase;
  }>
> {
  const database = await (
    dependencies.openAuthenticationDatabase ??
    openLocalSqliteAuthenticationReadDatabase
  )({
    databasePath: options.targetDatabasePath,
    profile,
    ...(options.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: options.busyTimeoutMs }),
  });
  try {
    const authenticated = await (
      dependencies.authenticate ?? establishAuthenticatedLocalCommand
    )(database, {
      deploymentRoot: options.deploymentRoot,
      databasePath: options.targetDatabasePath,
      ownerPepperKeyringDirectory: options.ownerPepperKeyringDirectory,
      credentialFilePath: options.credentialFilePath,
      authenticationNamespace: 'local_reconciliation_secret_config_apply',
      now: () => atMs,
    });
    assertReviewer(authenticated, reviewer, atMs);
    return Object.freeze({ authenticated, database });
  } catch (error) {
    await database.close();
    throw error;
  }
}

function exactBundle(
  intent: Readonly<LocalReconciliationSecretConfigApplyIntent>,
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
  ) {
    fail('sealed source authority drifted');
  }
}

function verifyIntentCommand(
  intent: Readonly<LocalReconciliationSecretConfigApplyIntent>,
  command: Readonly<LocalReconciliationSecretConfigApplyCommand>,
): void {
  if (
    intent.command.request.secretConfigId !== command.request.secretConfigId ||
    intent.command.request.decisionId !== command.request.decisionId ||
    intent.command.request.expectedDecisionDigest !==
      command.request.expectedDecisionDigest ||
    intent.command.request.mutationId !== command.request.mutationId ||
    intent.command.request.requestId !== command.request.requestId ||
    intent.command.request.appliedAtMs !== command.request.appliedAtMs ||
    intent.command.request.expectedHeadDigest !==
      command.request.expectedHeadDigest ||
    JSON.stringify(intent.command.options) !== JSON.stringify(command.options)
  ) {
    fail('apply command is not an exact replay');
  }
}

function assertPreparedAuthority(
  intent: Readonly<LocalReconciliationSecretConfigApplyIntent>,
  uid: number,
  allowedState:
    | 'reconciliation_secret_config_apply_prepared'
    | 'reconciliation_secret_config_applied',
  expectedDigest: string,
): void {
  const head = readLocalCutoverInstanceHead(
    intent.command.options.deploymentRoot,
    intent.instanceId,
    uid,
  );
  if (
    head.state !== allowedState ||
    head.sourceRecordDigest !== expectedDigest
  ) {
    fail('apply lost current head authority');
  }
}

export async function applyLocalReconciliationSecretConfig(
  value: unknown,
  dependencies: LocalReconciliationSecretConfigApplyDependencies = {},
): Promise<Readonly<LocalReconciliationSecretConfigApplyResult>> {
  const command = normalizeLocalReconciliationSecretConfigApplyCommand(value);
  const uid = currentIdentity().uid;
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
    [command.options.secretConfigRoot, 'secretConfigRoot'],
    [command.options.secretConfigDecisionRoot, 'secretConfigDecisionRoot'],
    [command.options.secretConfigApplyRoot, 'secretConfigApplyRoot'],
  ] as const) {
    validatePrivateDirectory(directory, uid, label);
  }
  const selected = localReconciliationSecretConfigApplyPaths(
    command.options.secretConfigApplyRoot,
    command.request.secretConfigId,
  );
  ensureLocalReconciliationSecretConfigApplyLayout(selected, uid);
  validateLocalReconciliationSecretConfigApplyCatalog(selected);

  const terminal = await readLocalReconciliationSecretConfigDecisionTerminal(
    decisionOptions(command.options),
    command.request.secretConfigId,
    uid,
    APPLY_HEAD_STATES,
  );
  if (
    terminal.receipt.decisionId !== command.request.decisionId ||
    terminal.receipt.decisionDigest !==
      command.request.expectedDecisionDigest ||
    terminal.receipt.outcome !== 'ready' ||
    terminal.receipt.skippedCount !== 0 ||
    terminal.receipt.candidateCount < 1
  ) {
    fail('apply command is detached from a ready signed decision');
  }
  const planTerminal = terminal.context.planTerminal;
  const capture = readLocalReconciliationCaptureIntent(
    planTerminal.intent.command.options.captureRoot,
    planTerminal.intent.command.request.captureId,
  );
  if (
    capture.command.request.targetDatabasePath !==
    command.options.targetDatabasePath
  ) {
    fail('target database is detached from stopped capture');
  }

  let intent: Readonly<LocalReconciliationSecretConfigApplyIntent>;
  const recoveringPreparedIntent = fs.existsSync(selected.intent);
  let head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    terminal.intent.instanceId,
    uid,
  );
  if (recoveringPreparedIntent) {
    intent = readLocalReconciliationSecretConfigApplyIntent(selected, uid);
    verifyIntentCommand(intent, command);
    readLocalReconciliationSecretConfigMaterials(
      selected,
      intent.profile,
      uid,
      intent.material,
    );
  } else {
    if (
      head.state !== 'reconciliation_secret_config_reviewed' ||
      head.headDigest !== command.request.expectedHeadDigest ||
      head.sourceRecordDigest !== terminal.receipt.decisionDigest
    ) {
      fail('apply lost reviewed head compare-and-swap');
    }
    discardUnpreparedLocalReconciliationSecretConfigMaterials(selected);
    const before = proveLocalReconciliationStoppedState(capture.command, uid);
    const materials: Readonly<PreparedReconciliationSecretConfigMaterial>[] =
      [];
    const openRequirements =
      createLocalReconciliationSecretConfigDecisionRequirementFactory(
        terminal.context.secretConfig.planPath,
        terminal.context.secretConfig.receipt,
        uid,
      );
    const prepared = await withLocalReconciliationSealedDatabaseAsync(
      planTerminal.bundle,
      'legacy',
      uid,
      {},
      async (sourceClient) =>
        (
          dependencies.prepareApplication ??
          prepareReconciliationSecretConfigApplication
        )({
          sourceClient,
          profile: terminal.intent.profile,
          projectId: terminal.intent.projectId,
          mutationId: command.request.mutationId,
          appliedAtMs: command.request.appliedAtMs,
          expectedLegacyInventoryDigest:
            terminal.context.secretConfig.receipt.legacyInventoryDigest,
          decisions: terminal.authorization.decisions,
          openRequirements,
          keyProvider: new LocalSecretKeyringFileProvider(
            command.options.secretKeyringPath,
          ),
          visitMaterial(entry) {
            materials.push(entry);
          },
        }),
    );
    if (!prepared) fail('sealed Legacy source requires manual handling');
    const materialEvidence = publishLocalReconciliationSecretConfigMaterials(
      selected,
      materials,
      terminal.intent.profile,
      uid,
    );
    if (
      materialEvidence.secretCount !== prepared.secretCount ||
      materialEvidence.activeBindingCount !== prepared.activeBindingCount ||
      materialEvidence.disabledPreservationCount !==
        prepared.disabledPreservationCount ||
      materialEvidence.materialSetDigest !== prepared.materialSetDigest ||
      prepared.activeBindingCount !== terminal.receipt.applyBindingCount ||
      prepared.disabledPreservationCount !==
        terminal.receipt.preserveDisabledCount
    ) {
      fail('prepared material evidence drifted');
    }
    dependencies.afterMaterialPublished?.();
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
    if (after.proofDigest !== before.proofDigest) {
      fail('stopped target drifted across preparation');
    }
    dependencies.afterBackupPublished?.();
    intent = buildLocalReconciliationSecretConfigApplyIntent({
      command,
      instanceId: terminal.intent.instanceId,
      cutoverId: terminal.intent.cutoverId,
      activationDigest: terminal.intent.activationDigest,
      profile: terminal.intent.profile,
      projectId: terminal.intent.projectId,
      generation: terminal.intent.generation,
      stoppedProofDigest: before.proofDigest,
      legacyInventoryDigest: prepared.legacyInventoryDigest,
      candidateSetDigest: terminal.intent.candidateSetDigest,
      automationAdoptionSetDigest:
        terminal.context.secretConfig.receipt.automationAdoptionSetDigest,
      material: materialEvidence,
      backup,
    });
    publishExactFile(
      selected.intent,
      localReconciliationSecretConfigApplyEvidenceContents(intent),
      0o600,
      uid,
      'secret config apply intent',
    );
    head = advance(
      intent,
      uid,
      'reconciliation_secret_config_apply_prepared',
      intent.preparationDigest,
      command.request.appliedAtMs,
    );
    dependencies.afterPreparedHead?.();
  }

  if (fs.existsSync(selected.receipt)) {
    const receipt = readLocalReconciliationSecretConfigApplyReceipt(
      selected,
      uid,
    );
    const current = await (
      dependencies.inspectSnapshot ?? inspectLocalSqliteSnapshot
    )({
      databasePath: command.options.targetDatabasePath,
      profile: intent.profile,
    });
    if (current.sha256 !== receipt.targetAfter.sha256) {
      fail('terminal apply target drifted');
    }
    if (
      head.state === 'reconciliation_secret_config_apply_prepared' &&
      head.sourceRecordDigest === intent.preparationDigest
    ) {
      head = advance(
        intent,
        uid,
        'reconciliation_secret_config_applied',
        receipt.applyDigest,
        receipt.appliedAtMs,
      );
      dependencies.afterAppliedHead?.();
    } else if (
      head.state !== 'reconciliation_secret_config_applied' ||
      head.sourceRecordDigest !== receipt.applyDigest
    ) {
      fail('terminal apply receipt drifted');
    }
    sealLocalReconciliationSecretConfigAppliedStorage(selected, intent, uid);
    dependencies.afterAppliedSeal?.();
    return result(command.operation, 'existing', receipt, intent, head);
  }
  if (
    head.state !== 'reconciliation_secret_config_apply_prepared' ||
    head.sourceRecordDigest !== intent.preparationDigest
  ) {
    fail('apply lost prepared head compare-and-swap');
  }
  if (!recoveringPreparedIntent) {
    const stopped = proveLocalReconciliationStoppedState(capture.command, uid);
    if (stopped.proofDigest !== intent.stoppedProofDigest) {
      fail('stopped proof drifted before write');
    }
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
    publication = await (
      dependencies.applyApplication ??
      applyPreparedReconciliationSecretConfigApplication
    )({
      databasePath: command.options.targetDatabasePath,
      profile: intent.profile,
      projectId: intent.projectId,
      mutationId: command.request.mutationId,
      requestId: command.request.requestId,
      secretConfigPlanDigest: terminal.receipt.secretConfigPlanDigest,
      decisionDigest: terminal.receipt.decisionDigest,
      candidateSetDigest: intent.candidateSetDigest,
      automationAdoptionSetDigest: intent.automationAdoptionSetDigest,
      materials: readLocalReconciliationSecretConfigMaterials(
        selected,
        intent.profile,
        uid,
        intent.material,
      ),
      principal: authenticatedScope.authenticated.principal,
      appliedAtMs: command.request.appliedAtMs,
      ...(command.options.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: command.options.busyTimeoutMs }),
      confirmAuthenticationAuthority: () =>
        authenticatedScope.authenticated.confirm(),
      confirmPreparedAuthority() {
        exactBundle(
          intent,
          planTerminal.bundle.captureRoot,
          planTerminal.bundle.receipt.captureId,
          planTerminal.bundle.receipt.bundleDigest,
          planTerminal.bundle.fingerprintDigest,
          uid,
        );
        assertPreparedAuthority(
          intent,
          uid,
          'reconciliation_secret_config_apply_prepared',
          intent.preparationDigest,
        );
      },
    });
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
  const publisher = publication.receipt;
  const receipt = buildLocalReconciliationSecretConfigApplyReceipt({
    decisionId: command.request.decisionId,
    secretConfigId: command.request.secretConfigId,
    mutationId: command.request.mutationId,
    preparationDigest: intent.preparationDigest,
    preparedHeadDigest: head.headDigest,
    publicationDigest: publisher.publicationDigest,
    publisherReceiptDigest: publisher.receiptDigest,
    activeBindingCount: publisher.activeBindingCount,
    disabledPreservationCount: publisher.disabledPreservationCount,
    updatedTaskCount: publisher.taskCount,
    updatedTriggerCount: publisher.triggerCount,
    targetAfter,
    appliedAtMs: command.request.appliedAtMs,
  });
  publishExactFile(
    selected.receipt,
    localReconciliationSecretConfigApplyEvidenceContents(receipt),
    0o600,
    uid,
    'secret config apply receipt',
  );
  dependencies.afterReceiptPublished?.();
  head = advance(
    intent,
    uid,
    'reconciliation_secret_config_applied',
    receipt.applyDigest,
    command.request.appliedAtMs,
  );
  dependencies.afterAppliedHead?.();
  sealLocalReconciliationSecretConfigAppliedStorage(selected, intent, uid);
  dependencies.afterAppliedSeal?.();
  return result(
    command.operation,
    publication.status === 'existing' ? 'existing' : 'applied',
    receipt,
    intent,
    head,
  );
}

export async function verifyLocalReconciliationSecretConfigApply(
  value: unknown,
): Promise<Readonly<LocalReconciliationSecretConfigApplyResult>> {
  const command =
    normalizeLocalReconciliationSecretConfigApplyVerifyCommand(value);
  const uid = currentIdentity().uid;
  const selected = localReconciliationSecretConfigApplyPaths(
    command.options.secretConfigApplyRoot,
    command.request.secretConfigId,
  );
  validatePrivateDirectory(
    command.options.secretConfigApplyRoot,
    uid,
    'secretConfigApplyRoot',
  );
  validateLocalReconciliationSecretConfigApplyCatalog(selected);
  const intent = readLocalReconciliationSecretConfigApplyIntent(selected, uid);
  const receipt = readLocalReconciliationSecretConfigApplyReceipt(
    selected,
    uid,
  );
  if (
    intent.command.request.decisionId !== command.request.decisionId ||
    receipt.decisionId !== command.request.decisionId ||
    receipt.secretConfigId !== command.request.secretConfigId ||
    receipt.applyDigest !== command.request.expectedApplyDigest
  ) {
    fail('verify command is detached from apply receipt');
  }
  await readLocalReconciliationSecretConfigDecisionTerminal(
    decisionOptions(command.options),
    command.request.secretConfigId,
    uid,
    APPLY_HEAD_STATES,
  );
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    uid,
  );
  if (head.state === 'reconciliation_secret_config_applied') {
    validateLocalReconciliationSecretConfigAppliedStorage(
      selected,
      intent,
      uid,
    );
    if (head.sourceRecordDigest !== receipt.applyDigest) {
      fail('applied head drifted');
    }
    const current = await inspectLocalSqliteSnapshot({
      databasePath: command.options.targetDatabasePath,
      profile: intent.profile,
    });
    if (current.sha256 !== receipt.targetAfter.sha256) {
      fail('applied target drifted');
    }
    return result(command.operation, 'verified', receipt, intent, head);
  }
  if (
    head.state === 'reconciliation_secret_config_rolled_back' &&
    fs.existsSync(selected.rollbackReceipt)
  ) {
    validateLocalReconciliationSecretConfigRolledBackStorage(
      selected,
      intent,
      uid,
    );
    const rollback = readLocalReconciliationSecretConfigRollbackReceipt(
      selected,
      uid,
    );
    if (
      rollback.applyDigest !== receipt.applyDigest ||
      head.sourceRecordDigest !== rollback.rollbackDigest
    ) {
      fail('rollback head drifted');
    }
    const current = await inspectLocalSqliteSnapshot({
      databasePath: command.options.targetDatabasePath,
      profile: intent.profile,
    });
    if (
      current.sha256 !== intent.backup.sha256 ||
      current.sha256 !== rollback.restored.sha256
    ) {
      fail('rolled-back target drifted');
    }
    return result(command.operation, 'verified', receipt, intent, head);
  }
  return fail('apply head is not terminal');
}

export async function rollbackLocalReconciliationSecretConfigApply(
  value: unknown,
  dependencies: LocalReconciliationSecretConfigApplyDependencies = {},
): Promise<Readonly<LocalReconciliationSecretConfigApplyResult>> {
  const command =
    normalizeLocalReconciliationSecretConfigApplyRollbackCommand(value);
  const uid = currentIdentity().uid;
  const selected = localReconciliationSecretConfigApplyPaths(
    command.options.secretConfigApplyRoot,
    command.request.secretConfigId,
  );
  validatePrivateDirectory(
    command.options.secretConfigApplyRoot,
    uid,
    'secretConfigApplyRoot',
  );
  validateLocalReconciliationSecretConfigApplyCatalog(selected);
  const intent = readLocalReconciliationSecretConfigApplyIntent(selected, uid);
  const receipt = readLocalReconciliationSecretConfigApplyReceipt(
    selected,
    uid,
  );
  if (
    receipt.decisionId !== command.request.decisionId ||
    receipt.secretConfigId !== command.request.secretConfigId ||
    receipt.applyDigest !== command.request.expectedApplyDigest
  ) {
    fail('rollback command is detached from apply receipt');
  }
  const terminal = await readLocalReconciliationSecretConfigDecisionTerminal(
    decisionOptions(command.options),
    command.request.secretConfigId,
    uid,
    APPLY_HEAD_STATES,
  );
  let head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    uid,
  );
  if (fs.existsSync(selected.rollbackReceipt)) {
    const rollback = readLocalReconciliationSecretConfigRollbackReceipt(
      selected,
      uid,
    );
    const current = await (
      dependencies.inspectSnapshot ?? inspectLocalSqliteSnapshot
    )({
      databasePath: command.options.targetDatabasePath,
      profile: intent.profile,
    });
    if (current.sha256 !== rollback.restored.sha256) {
      fail('rollback replay target drifted');
    }
    if (
      head.state === 'reconciliation_secret_config_applied' &&
      head.sourceRecordDigest === receipt.applyDigest
    ) {
      head = advance(
        intent,
        uid,
        'reconciliation_secret_config_rolled_back',
        rollback.rollbackDigest,
        rollback.rolledBackAtMs,
      );
      dependencies.afterRollbackHead?.();
    } else if (
      head.state !== 'reconciliation_secret_config_rolled_back' ||
      head.sourceRecordDigest !== rollback.rollbackDigest
    ) {
      fail('rollback replay drifted');
    }
    sealLocalReconciliationSecretConfigRolledBackStorage(selected, intent, uid);
    dependencies.afterRollbackSeal?.();
    return result(command.operation, 'existing', receipt, intent, head);
  }
  if (
    head.state !== 'reconciliation_secret_config_applied' ||
    head.headDigest !== command.request.expectedHeadDigest ||
    head.sourceRecordDigest !== receipt.applyDigest
  ) {
    fail('rollback lost applied head compare-and-swap');
  }
  const current = await (
    dependencies.inspectSnapshot ?? inspectLocalSqliteSnapshot
  )({
    databasePath: command.options.targetDatabasePath,
    profile: intent.profile,
  });
  if (current.sha256 === intent.backup.sha256) {
    const rollback = buildLocalReconciliationSecretConfigRollbackReceipt({
      decisionId: receipt.decisionId,
      secretConfigId: receipt.secretConfigId,
      applyDigest: receipt.applyDigest,
      restored: current,
      rolledBackAtMs: command.request.rolledBackAtMs,
    });
    publishExactFile(
      selected.rollbackReceipt,
      localReconciliationSecretConfigApplyEvidenceContents(rollback),
      0o600,
      uid,
      'secret config rollback receipt',
    );
    dependencies.afterRollbackReceipt?.();
    head = advance(
      intent,
      uid,
      'reconciliation_secret_config_rolled_back',
      rollback.rollbackDigest,
      command.request.rolledBackAtMs,
    );
    dependencies.afterRollbackHead?.();
    sealLocalReconciliationSecretConfigRolledBackStorage(selected, intent, uid);
    dependencies.afterRollbackSeal?.();
    return result(command.operation, 'existing', receipt, intent, head);
  }
  if (current.sha256 !== receipt.targetAfter.sha256) {
    fail('rollback current target drifted');
  }
  sealLocalReconciliationSecretConfigAppliedStorage(selected, intent, uid);

  const authenticatedScope = await authenticate(
    command.options,
    command.request.rolledBackAtMs,
    intent.profile,
    terminal.reviewer,
    dependencies,
  );
  try {
    const replay = await (
      dependencies.applyApplication ??
      applyPreparedReconciliationSecretConfigApplication
    )({
      databasePath: command.options.targetDatabasePath,
      profile: intent.profile,
      projectId: intent.projectId,
      mutationId: intent.command.request.mutationId,
      requestId: intent.command.request.requestId,
      secretConfigPlanDigest: terminal.receipt.secretConfigPlanDigest,
      decisionDigest: terminal.receipt.decisionDigest,
      candidateSetDigest: intent.candidateSetDigest,
      automationAdoptionSetDigest: intent.automationAdoptionSetDigest,
      materials: readLocalReconciliationSecretConfigMaterials(
        selected,
        intent.profile,
        uid,
        intent.material,
      ),
      principal: authenticatedScope.authenticated.principal,
      appliedAtMs: intent.command.request.appliedAtMs,
      authorizationAtMs: command.request.rolledBackAtMs,
      ...(command.options.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: command.options.busyTimeoutMs }),
      confirmAuthenticationAuthority: () =>
        authenticatedScope.authenticated.confirm(),
      confirmPreparedAuthority() {
        assertPreparedAuthority(
          intent,
          uid,
          'reconciliation_secret_config_applied',
          receipt.applyDigest,
        );
      },
    });
    if (
      replay.status !== 'existing' ||
      replay.receipt.publicationDigest !== receipt.publicationDigest ||
      replay.receipt.receiptDigest !== receipt.publisherReceiptDigest
    ) {
      fail('rollback could not verify current publication');
    }
  } finally {
    await authenticatedScope.database.close();
  }
  prepareLocalReconciliationSecretConfigRollbackSource(selected, intent, uid);
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
  const rollback = buildLocalReconciliationSecretConfigRollbackReceipt({
    decisionId: receipt.decisionId,
    secretConfigId: receipt.secretConfigId,
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
    localReconciliationSecretConfigApplyEvidenceContents(rollback),
    0o600,
    uid,
    'secret config rollback receipt',
  );
  dependencies.afterRollbackReceipt?.();
  head = advance(
    intent,
    uid,
    'reconciliation_secret_config_rolled_back',
    rollback.rollbackDigest,
    command.request.rolledBackAtMs,
  );
  dependencies.afterRollbackHead?.();
  sealLocalReconciliationSecretConfigRolledBackStorage(selected, intent, uid);
  dependencies.afterRollbackSeal?.();
  return result(command.operation, 'rolled_back', receipt, intent, head);
}

export async function applyLocalReconciliationSecretConfigCommandFile(
  filePath: string,
): Promise<Readonly<LocalReconciliationSecretConfigApplyResult>> {
  return applyLocalReconciliationSecretConfig(
    readPrivateLocalCommandFile(filePath),
  );
}

export async function verifyLocalReconciliationSecretConfigApplyCommandFile(
  filePath: string,
): Promise<Readonly<LocalReconciliationSecretConfigApplyResult>> {
  return verifyLocalReconciliationSecretConfigApply(
    readPrivateLocalCommandFile(filePath),
  );
}

export async function rollbackLocalReconciliationSecretConfigApplyCommandFile(
  filePath: string,
): Promise<Readonly<LocalReconciliationSecretConfigApplyResult>> {
  return rollbackLocalReconciliationSecretConfigApply(
    readPrivateLocalCommandFile(filePath),
  );
}
