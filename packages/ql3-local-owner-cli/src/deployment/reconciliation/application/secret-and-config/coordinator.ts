import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { currentIdentity } from '../../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../../foundation/error';
import {
  ensurePrivateDirectory,
  publishExactFile,
  syncPublishedDirectory,
  validatePrivateDirectory,
} from '../../../foundation/files';
import {
  advanceLocalCutoverInstanceHead,
  readLocalCutoverInstanceHead,
  type LocalCutoverInstanceHead,
} from '../../../cutover/instanceLineage';
import { readLocalReconciliationPlanTerminal } from '../../planning/preparation';
import {
  assertLocalReconciliationReviewDecisionMatchesFact,
  withLocalReconciliationReviewDecisionFile,
} from '../../review/decisionFile';
import { visitLocalReconciliationDiagnosticFacts } from '../../review/diagnostics';
import { withLocalReconciliationSealedDatabase } from '../../sealed-bundle/reader';
import {
  readLocalReconciliationApplicationTerminal,
  type LocalReconciliationApplicationTerminal,
} from '../coordinator';
import {
  normalizeLocalReconciliationSecretConfigPlanCommand,
  normalizeLocalReconciliationSecretConfigVerifyCommand,
  type LocalReconciliationSecretConfigPlanCommand,
  type LocalReconciliationSecretConfigPlanResult,
} from './contract';
import {
  buildLocalReconciliationSecretConfigPlanReceipt,
  hashLocalReconciliationSecretConfigPlanFile,
  MAX_EDGE_LOCAL_RECONCILIATION_SECRET_CONFIG_PLAN_BYTES,
  MAX_STANDALONE_LOCAL_RECONCILIATION_SECRET_CONFIG_PLAN_BYTES,
  normalizeLocalReconciliationSecretConfigPlanReceipt,
  writeLocalReconciliationSecretConfigPlan,
  type LocalReconciliationSecretConfigPlanHeader,
  type LocalReconciliationSecretConfigPlanReceipt,
} from './rowPlan';

const MAX_RECEIPT_BYTES = 64 * 1024;

export interface LocalReconciliationSecretConfigPlanDependencies {
  readonly beforeDatabaseOpen?: (
    kind: 'legacy' | 'target',
    mode: 'main_only_immutable' | 'wal_shm_readonly',
    cacheKiB: 2_048 | 8_192,
  ) => void;
  readonly afterDatabaseClose?: (kind: 'legacy' | 'target') => void;
  readonly afterPlanPublished?: () => void;
  readonly afterReceiptPublished?: () => void;
  readonly afterTerminalSealed?: () => void;
  readonly afterHeadAdvanced?: () => void;
}

interface SecretConfigPaths {
  readonly root: string;
  readonly staging: string;
  readonly plan: string;
  readonly planStage: string;
  readonly receipt: string;
}

interface SecretConfigReviewAuthority {
  readonly tableDisposition: 'absent' | 'manual_external';
  readonly unadaptedLegacyConfigCount: number;
  readonly decisionFileDigest: string;
  readonly confirmDecisionFileIdentity: () => void;
  readonly planTerminal: ReturnType<typeof readLocalReconciliationPlanTerminal>;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation secret config ${message}`,
    { cause },
  );
}

function secretConfigPaths(
  secretConfigRoot: string,
  secretConfigId: string,
): Readonly<SecretConfigPaths> {
  const root = path.join(secretConfigRoot, secretConfigId);
  const staging = path.join(root, 'staging');
  return Object.freeze({
    root,
    staging,
    plan: path.join(root, 'plan.ndjson'),
    planStage: path.join(staging, 'plan.ndjson.stage'),
    receipt: path.join(root, 'receipt.json'),
  });
}

function validateCatalog(
  selected: Readonly<SecretConfigPaths>,
  terminal: boolean,
): void {
  const allowed = new Set([
    'plan.ndjson',
    'receipt.json',
    'staging',
    ...(!terminal ? ['.receipt.json.ql3-deploy-stage'] : []),
  ]);
  for (const entry of fs.readdirSync(selected.root, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || entry.isSymbolicLink()) {
      configurationError('plan root contains unknown material');
    }
  }
  const stagingEntries = fs.readdirSync(selected.staging);
  if (
    terminal
      ? stagingEntries.length !== 0
      : stagingEntries.some((entry) => entry !== 'plan.ndjson.stage')
  ) {
    configurationError('plan staging contains unknown material');
  }
}

function validateDirectory(
  directory: string,
  uid: number,
  modes: readonly number[],
  label: string,
): number {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    return configurationError(`${label} is unavailable`, error);
  }
  const mode = stat.mode & 0o777;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    !modes.includes(mode) ||
    fs.realpathSync(directory) !== directory
  ) {
    configurationError(`${label} identity is invalid`);
  }
  return mode;
}

function readReceipt(
  filePath: string,
  uid: number,
  allowedModes: readonly number[],
): Readonly<LocalReconciliationSecretConfigPlanReceipt> {
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      !allowedModes.includes(Number(before.mode) & 0o777) ||
      before.nlink !== 1n ||
      before.size < 2n ||
      before.size > BigInt(MAX_RECEIPT_BYTES)
    ) {
      configurationError('receipt identity is invalid');
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      configurationError('receipt changed while opening');
    }
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(filePath, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.mtimeNs !== before.mtimeNs ||
      current.ctimeNs !== before.ctimeNs ||
      current.mode !== before.mode ||
      current.nlink !== before.nlink
    ) {
      configurationError('receipt changed while reading');
    }
    return normalizeLocalReconciliationSecretConfigPlanReceipt(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('receipt cannot be read', error);
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validatePlanFile(
  filePath: string,
  receipt: Readonly<LocalReconciliationSecretConfigPlanReceipt>,
  uid: number,
  allowedModes: readonly number[],
): void {
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      !allowedModes.includes(Number(before.mode) & 0o777) ||
      before.nlink !== 1n ||
      before.size !== BigInt(receipt.planFileBytes)
    ) {
      configurationError('plan file identity is invalid');
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      hashLocalReconciliationSecretConfigPlanFile(
        descriptor,
        receipt.planFileBytes,
      ) !== receipt.planFileDigest
    ) {
      configurationError('plan file content drifted');
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(filePath, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.mtimeNs !== before.mtimeNs ||
      current.ctimeNs !== before.ctimeNs
    ) {
      configurationError('plan file changed while verifying');
    }
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    configurationError('plan file cannot be verified', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function receiptContents(
  receipt: Readonly<LocalReconciliationSecretConfigPlanReceipt>,
): string {
  const contents = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(contents, 'utf8') > MAX_RECEIPT_BYTES) {
    configurationError('receipt exceeds 64 KiB');
  }
  return contents;
}

function expectedPriorState(
  terminal: Readonly<LocalReconciliationApplicationTerminal>,
): 'reconciliation_application_planned' | 'reconciliation_automation_applied' {
  const automation = terminal.plan.domains.find(
    (selected) => selected.domain === 'automation',
  );
  if (!automation) configurationError('Automation domain summary is missing');
  return automation.action === 'adapter_required' ||
    automation.action === 'adapter_and_manual'
    ? 'reconciliation_automation_applied'
    : 'reconciliation_application_planned';
}

function validateApplicationBinding(
  command: Readonly<LocalReconciliationSecretConfigPlanCommand>,
  terminal: Readonly<LocalReconciliationApplicationTerminal>,
  head: Readonly<LocalCutoverInstanceHead>,
): void {
  const secretConfig = terminal.plan.domains.find(
    (selected) => selected.domain === 'secret_and_config',
  );
  const priorState = expectedPriorState(terminal);
  if (
    terminal.intent.command.options.deploymentRoot !==
      command.options.deploymentRoot ||
    terminal.intent.command.options.applicationRoot !==
      command.options.applicationRoot ||
    terminal.plan.applicationId !== command.request.applicationId ||
    terminal.plan.applicationPlanDigest !==
      command.request.expectedApplicationPlanDigest ||
    terminal.head.state !== 'reconciliation_application_planned' ||
    terminal.head.sourceRecordDigest !== terminal.plan.applicationPlanDigest ||
    !secretConfig ||
    secretConfig.action !== 'manual_external' ||
    head.state !== priorState ||
    head.headDigest !== command.request.expectedHeadDigest ||
    (priorState === 'reconciliation_application_planned' &&
      head.sourceRecordDigest !== terminal.plan.applicationPlanDigest) ||
    command.request.preparedAtMs < terminal.plan.committedAtMs ||
    command.request.preparedAtMs < head.updatedAtMs
  ) {
    configurationError('plan is detached from its ordered application head');
  }
}

function reviewAuthority(
  command: Readonly<LocalReconciliationSecretConfigPlanCommand>,
  terminal: Readonly<LocalReconciliationApplicationTerminal>,
  dependencies: LocalReconciliationSecretConfigPlanDependencies,
  uid: number,
): Readonly<SecretConfigReviewAuthority> {
  const planTerminal = readLocalReconciliationPlanTerminal(
    terminal.review.intent.command.options.planRoot,
    terminal.review.intent.command.request.planId,
    uid,
  );
  let envDisposition: 'absent' | 'manual_external' = 'absent';
  let envSeen = false;
  let unadaptedLegacyConfigCount = 0;
  const reviewed = withLocalReconciliationReviewDecisionFile(
    command.request.decisionFilePath,
    {
      reviewId: terminal.review.review.reviewId,
      profile: terminal.plan.profile,
      planDigest: planTerminal.plan.planDigest,
      preparationDigest: terminal.review.intent.preparationDigest,
    },
    (cursor) => {
      for (const database of ['legacy', 'target'] as const) {
        const opened = withLocalReconciliationSealedDatabase(
          planTerminal.bundle,
          database,
          uid,
          dependencies,
          (client) =>
            visitLocalReconciliationDiagnosticFacts(
              client,
              database,
              (fact) => {
                if (fact.decisionRequirement === 'informational') return;
                const decision = cursor.next();
                if (decision === null) {
                  configurationError('decision file omitted a canonical fact');
                }
                assertLocalReconciliationReviewDecisionMatchesFact(
                  decision,
                  fact,
                );
                if (fact.domain !== 'secret_and_config') return;
                if (decision.disposition !== 'manual_external') {
                  configurationError(
                    'Secret/Config facts require explicit external custody review',
                  );
                }
                if (
                  fact.database === 'legacy' &&
                  fact.factKind === 'table' &&
                  fact.tableName === 'Envs'
                ) {
                  if (envSeen) {
                    configurationError('legacy Envs authority is ambiguous');
                  }
                  envSeen = true;
                  envDisposition = 'manual_external';
                }
                if (
                  fact.database === 'legacy' &&
                  fact.factKind === 'table' &&
                  fact.tableName === 'Configs'
                ) {
                  unadaptedLegacyConfigCount += 1;
                }
              },
            ),
        );
        if (opened === null) {
          configurationError('manual-required SQLite topology cannot be adapted');
        }
      }
    },
  );
  if (
    reviewed.evidence.fileDigest !==
      terminal.review.authorization.decisionFileDigest ||
    reviewed.evidence.decisionCount !==
      terminal.review.authorization.decisionCount
  ) {
    configurationError('signed review authority drifted');
  }
  return Object.freeze({
    tableDisposition: envDisposition,
    unadaptedLegacyConfigCount,
    decisionFileDigest: reviewed.evidence.fileDigest,
    confirmDecisionFileIdentity: reviewed.confirmIdentity,
    planTerminal,
  });
}

function maxPlanBytes(profile: 'edge' | 'standalone'): number {
  return profile === 'edge'
    ? MAX_EDGE_LOCAL_RECONCILIATION_SECRET_CONFIG_PLAN_BYTES
    : MAX_STANDALONE_LOCAL_RECONCILIATION_SECRET_CONFIG_PLAN_BYTES;
}

function publishPlan(
  selected: Readonly<SecretConfigPaths>,
  command: Readonly<LocalReconciliationSecretConfigPlanCommand>,
  terminal: Readonly<LocalReconciliationApplicationTerminal>,
  head: Readonly<LocalCutoverInstanceHead>,
  authority: Readonly<SecretConfigReviewAuthority>,
  dependencies: LocalReconciliationSecretConfigPlanDependencies,
  uid: number,
): Readonly<LocalReconciliationSecretConfigPlanReceipt> {
  let descriptor: number | undefined;
  let createdStage = false;
  try {
    descriptor = fs.openSync(
      selected.planStage,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    createdStage = true;
    fs.fchmodSync(descriptor, 0o600);
    const header: Omit<
      LocalReconciliationSecretConfigPlanHeader,
      'headerDigest'
    > = Object.freeze({
      schemaVersion: 1,
      kind: 'qinglong3-local-reconciliation-secret-config-plan-header',
      secretConfigId: command.request.secretConfigId,
      applicationId: command.request.applicationId,
      applicationPlanDigest: terminal.plan.applicationPlanDigest,
      reviewDigest: terminal.review.review.reviewDigest,
      reviewAuthorizationDigest:
        terminal.review.authorization.authorizationDigest,
      reviewDecisionSetDigest: terminal.review.authorization.decisionSetDigest,
      reviewDecisionFileDigest: authority.decisionFileDigest,
      bundleDigest: authority.planTerminal.bundle.receipt.bundleDigest,
      bundleFingerprintDigest: authority.planTerminal.bundle.fingerprintDigest,
      profile: terminal.plan.profile,
      projectId: command.request.projectId,
      tableDisposition: authority.tableDisposition,
      unadaptedLegacyConfigCount: authority.unadaptedLegacyConfigCount,
      preparedHeadDigest: head.headDigest,
      preparedAtMs: command.request.preparedAtMs,
    });
    const generated = withLocalReconciliationSealedDatabase(
      authority.planTerminal.bundle,
      'target',
      uid,
      dependencies,
      (target) =>
        withLocalReconciliationSealedDatabase(
          authority.planTerminal.bundle,
          'legacy',
          uid,
          dependencies,
          (legacy) =>
            writeLocalReconciliationSecretConfigPlan({
              descriptor: descriptor!,
              maxBytes: maxPlanBytes(terminal.plan.profile),
              header,
              legacy,
              target,
            }),
        ),
    );
    if (generated === null || generated === undefined) {
      configurationError('manual-required SQLite topology cannot be planned');
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    authority.confirmDecisionFileIdentity();
    const receipt = buildLocalReconciliationSecretConfigPlanReceipt(
      generated.header,
      generated.footer,
      generated.fileBytes,
      generated.fileDigest,
    );
    if (fs.existsSync(selected.plan)) {
      validatePlanFile(selected.plan, receipt, uid, [0o600]);
    } else {
      try {
        fs.linkSync(selected.planStage, selected.plan);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        validatePlanFile(selected.plan, receipt, uid, [0o600]);
      }
      syncPublishedDirectory(selected.root);
    }
    fs.unlinkSync(selected.planStage);
    createdStage = false;
    syncPublishedDirectory(selected.staging);
    return receipt;
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('plan cannot be published', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (createdStage) {
      try {
        fs.unlinkSync(selected.planStage);
      } catch {
        // A complete stage remains recoverable; a partial stage fails closed.
      }
    }
  }
}

function sealFile(filePath: string, uid: number): void {
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      ![0o600, 0o400].includes(Number(before.mode) & 0o777) ||
      before.nlink !== 1n
    ) {
      configurationError('terminal file cannot be sealed');
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      configurationError('terminal file changed while sealing');
    }
    if ((Number(opened.mode) & 0o777) !== 0o400) {
      fs.fchmodSync(descriptor, 0o400);
    }
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sealDirectory(directory: string, uid: number): void {
  const mode = validateDirectory(
    directory,
    uid,
    [0o700, 0o500],
    'terminal directory',
  );
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    if (mode !== 0o500) fs.fchmodSync(descriptor, 0o500);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sealTerminal(selected: Readonly<SecretConfigPaths>, uid: number): void {
  if (fs.readdirSync(selected.staging).length !== 0) {
    configurationError('staging must be empty before terminal seal');
  }
  sealFile(selected.plan, uid);
  sealFile(selected.receipt, uid);
  sealDirectory(selected.staging, uid);
  sealDirectory(selected.root, uid);
  validateCatalog(selected, true);
}

function advanceHead(
  terminal: Readonly<LocalReconciliationApplicationTerminal>,
  receipt: Readonly<LocalReconciliationSecretConfigPlanReceipt>,
  uid: number,
): Readonly<LocalCutoverInstanceHead> {
  return advanceLocalCutoverInstanceHead(
    {
      options: {
        deploymentRoot: terminal.intent.command.options.deploymentRoot,
      },
      request: {
        cutoverId: terminal.intent.cutoverId,
        profile: terminal.intent.profile,
        instanceId: terminal.intent.instanceId,
        expectedActivationDigest: terminal.intent.activationDigest,
        requestedAtMs: receipt.preparedAtMs,
      },
    },
    uid,
    'reconciliation_secret_config_planned',
    terminal.intent.generation,
    receipt.secretConfigPlanDigest,
  );
}

function result(
  operation: LocalReconciliationSecretConfigPlanResult['operation'],
  status: LocalReconciliationSecretConfigPlanResult['status'],
  receipt: Readonly<LocalReconciliationSecretConfigPlanReceipt>,
  head: Readonly<LocalCutoverInstanceHead>,
): Readonly<LocalReconciliationSecretConfigPlanResult> {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    status,
    state: 'reconciliation_secret_config_planned',
    secretConfigId: receipt.secretConfigId,
    secretConfigPlanDigest: receipt.secretConfigPlanDigest,
    outcome: receipt.outcome,
    rowCount: receipt.rowCount,
    eligibleBindingCount: receipt.eligibleBindingCount,
    eligiblePreservationCount: receipt.eligiblePreservationCount,
    targetConflictCount: receipt.targetConflictCount,
    adoptedLegacyTaskCount: receipt.adoptedLegacyTaskCount,
    unadaptedLegacyConfigCount: receipt.unadaptedLegacyConfigCount,
    instanceHeadDigest: head.headDigest,
  });
}

function validateTerminalBinding(
  receipt: Readonly<LocalReconciliationSecretConfigPlanReceipt>,
  terminal: Readonly<LocalReconciliationApplicationTerminal>,
  secretConfigId: string,
): void {
  if (
    receipt.secretConfigId !== secretConfigId ||
    receipt.applicationId !== terminal.plan.applicationId ||
    receipt.applicationPlanDigest !== terminal.plan.applicationPlanDigest
  ) {
    configurationError('terminal plan binding drifted');
  }
}

export interface LocalReconciliationSecretConfigTerminal {
  readonly receipt: Readonly<LocalReconciliationSecretConfigPlanReceipt>;
  readonly planPath: string;
}

export function readLocalReconciliationSecretConfigTerminal(
  secretConfigRoot: string,
  secretConfigId: string,
  uid: number,
): Readonly<LocalReconciliationSecretConfigTerminal> {
  const selected = secretConfigPaths(secretConfigRoot, secretConfigId);
  validateDirectory(selected.root, uid, [0o500], 'Secret/Config plan root');
  validateDirectory(selected.staging, uid, [0o500], 'Secret/Config staging');
  validateCatalog(selected, true);
  const receipt = readReceipt(selected.receipt, uid, [0o400]);
  if (receipt.secretConfigId !== secretConfigId) {
    configurationError('Secret/Config terminal identity drifted');
  }
  validatePlanFile(selected.plan, receipt, uid, [0o400]);
  return Object.freeze({ receipt, planPath: selected.plan });
}

export async function planLocalReconciliationSecretConfig(
  value: unknown,
  dependencies: LocalReconciliationSecretConfigPlanDependencies = {},
): Promise<Readonly<LocalReconciliationSecretConfigPlanResult>> {
  const command = normalizeLocalReconciliationSecretConfigPlanCommand(value);
  const identity = currentIdentity();
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
    [command.options.secretConfigRoot, 'secretConfigRoot'],
  ] as const) {
    validatePrivateDirectory(directory, identity.uid, label);
  }
  const terminal = await readLocalReconciliationApplicationTerminal(
    command.options.applicationRoot,
    command.request.applicationId,
    identity.uid,
  );
  const selected = secretConfigPaths(
    command.options.secretConfigRoot,
    command.request.secretConfigId,
  );
  if (fs.existsSync(selected.receipt)) {
    validateDirectory(
      selected.root,
      identity.uid,
      [0o700, 0o500],
      'Secret/Config plan root',
    );
    validateDirectory(
      selected.staging,
      identity.uid,
      [0o700, 0o500],
      'Secret/Config staging',
    );
    validateCatalog(selected, false);
    const receipt = readReceipt(selected.receipt, identity.uid, [0o600, 0o400]);
    validateTerminalBinding(
      receipt,
      terminal,
      command.request.secretConfigId,
    );
    if (
      receipt.applicationPlanDigest !==
        command.request.expectedApplicationPlanDigest ||
      receipt.preparedHeadDigest !== command.request.expectedHeadDigest ||
      receipt.preparedAtMs !== command.request.preparedAtMs
    ) {
      configurationError('terminal plan is not an exact command replay');
    }
    validatePlanFile(selected.plan, receipt, identity.uid, [0o600, 0o400]);
    let head = readLocalCutoverInstanceHead(
      command.options.deploymentRoot,
      terminal.intent.instanceId,
      identity.uid,
    );
    const existing = head.state === 'reconciliation_secret_config_planned';
    if (!existing) validateApplicationBinding(command, terminal, head);
    if (
      existing &&
      head.sourceRecordDigest !== receipt.secretConfigPlanDigest
    ) {
      configurationError('terminal plan head digest drifted');
    }
    sealTerminal(selected, identity.uid);
    dependencies.afterTerminalSealed?.();
    head = existing ? head : advanceHead(terminal, receipt, identity.uid);
    dependencies.afterHeadAdvanced?.();
    return result(
      command.operation,
      existing ? 'existing' : 'prepared',
      receipt,
      head,
    );
  }
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    terminal.intent.instanceId,
    identity.uid,
  );
  validateApplicationBinding(command, terminal, head);
  const authority = reviewAuthority(
    command,
    terminal,
    dependencies,
    identity.uid,
  );
  ensurePrivateDirectory(
    selected.root,
    identity.uid,
    'secretConfigPlanDirectory',
  );
  ensurePrivateDirectory(
    selected.staging,
    identity.uid,
    'secretConfigPlanStaging',
  );
  validateCatalog(selected, false);
  const receipt = publishPlan(
    selected,
    command,
    terminal,
    head,
    authority,
    dependencies,
    identity.uid,
  );
  dependencies.afterPlanPublished?.();
  authority.confirmDecisionFileIdentity();
  publishExactFile(
    selected.receipt,
    receiptContents(receipt),
    0o600,
    identity.uid,
    'reconciliation secret config receipt',
  );
  dependencies.afterReceiptPublished?.();
  sealTerminal(selected, identity.uid);
  dependencies.afterTerminalSealed?.();
  const advanced = advanceHead(terminal, receipt, identity.uid);
  dependencies.afterHeadAdvanced?.();
  return result(command.operation, 'prepared', receipt, advanced);
}

export async function verifyLocalReconciliationSecretConfigPlan(
  value: unknown,
): Promise<Readonly<LocalReconciliationSecretConfigPlanResult>> {
  const command = normalizeLocalReconciliationSecretConfigVerifyCommand(value);
  const identity = currentIdentity();
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
    [command.options.secretConfigRoot, 'secretConfigRoot'],
  ] as const) {
    validatePrivateDirectory(directory, identity.uid, label);
  }
  const selected = secretConfigPaths(
    command.options.secretConfigRoot,
    command.request.secretConfigId,
  );
  validateDirectory(selected.root, identity.uid, [0o500], 'Secret/Config plan root');
  validateDirectory(selected.staging, identity.uid, [0o500], 'Secret/Config staging');
  validateCatalog(selected, true);
  const receipt = readReceipt(selected.receipt, identity.uid, [0o400]);
  if (
    receipt.secretConfigPlanDigest !==
    command.request.expectedSecretConfigPlanDigest
  ) {
    configurationError('expected Secret/Config plan digest drifted');
  }
  const terminal = await readLocalReconciliationApplicationTerminal(
    command.options.applicationRoot,
    receipt.applicationId,
    identity.uid,
  );
  validateTerminalBinding(receipt, terminal, command.request.secretConfigId);
  validatePlanFile(selected.plan, receipt, identity.uid, [0o400]);
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    terminal.intent.instanceId,
    identity.uid,
  );
  if (
    head.state !== 'reconciliation_secret_config_planned' ||
    head.sourceRecordDigest !== receipt.secretConfigPlanDigest
  ) {
    configurationError('Secret/Config plan is detached from the instance head');
  }
  return result(command.operation, 'verified', receipt, head);
}

export function planLocalReconciliationSecretConfigCommandFile(
  filePath: string,
  dependencies: LocalReconciliationSecretConfigPlanDependencies = {},
): Promise<Readonly<LocalReconciliationSecretConfigPlanResult>> {
  return planLocalReconciliationSecretConfig(
    readPrivateLocalCommandFile(filePath),
    dependencies,
  );
}

export function verifyLocalReconciliationSecretConfigPlanCommandFile(
  filePath: string,
): Promise<Readonly<LocalReconciliationSecretConfigPlanResult>> {
  return verifyLocalReconciliationSecretConfigPlan(
    readPrivateLocalCommandFile(filePath),
  );
}
