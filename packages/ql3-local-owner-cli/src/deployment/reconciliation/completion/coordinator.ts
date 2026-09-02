import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';
import { inspectLocalSqliteSnapshot } from '@qinglong/local-sqlite/rollout-safety';

import { currentIdentity } from '../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../foundation/error';
import {
  preflightPublishedFile,
  publishExactFile,
  validatePrivateDirectory,
} from '../../foundation/files';
import {
  advanceLocalCutoverInstanceHead,
  readLocalCutoverInstanceHead,
  type LocalCutoverInstanceHead,
} from '../../cutover/instanceLineage';
import { readLocalReconciliationApplicationTerminal } from '../application/coordinator';
import type { LocalReconciliationApplicationTerminal } from '../application/coordinator';
import {
  collectLocalReconciliationAutomationCompletedStorage,
  localReconciliationAutomationApplyPaths,
  readLocalReconciliationAutomationApplyIntent,
  readLocalReconciliationAutomationApplyReceipt,
  validateLocalReconciliationAutomationAppliedStorage,
  validateLocalReconciliationAutomationApplyCatalog,
  validateLocalReconciliationAutomationApplyLayout,
  validateLocalReconciliationAutomationCompletedStorage,
} from '../application/automation/applyStorage';
import type {
  LocalReconciliationAutomationApplyIntent,
  LocalReconciliationAutomationApplyReceipt,
} from '../application/automation/applyEvidence';
import { readLocalReconciliationAutomationDecisionTerminal } from '../application/automation/decisionCoordinator';
import { readLocalReconciliationSecretConfigDecisionTerminal } from '../application/secret-and-config/decisionCoordinator';
import type {
  LocalReconciliationSecretConfigApplyIntent,
  LocalReconciliationSecretConfigApplyReceipt,
} from '../application/secret-and-config/application/evidence';
import {
  collectLocalReconciliationSecretConfigCompletedStorage,
  localReconciliationSecretConfigApplyPaths,
  readLocalReconciliationSecretConfigApplyIntent,
  readLocalReconciliationSecretConfigApplyReceipt,
  validateLocalReconciliationSecretConfigAppliedStorage,
  validateLocalReconciliationSecretConfigApplyCatalog,
  validateLocalReconciliationSecretConfigCompletedStorage,
} from '../application/secret-and-config/application/storage';
import {
  readLocalReconciliationRunHistoryTerminal,
  type LocalReconciliationRunHistoryDependencies,
} from '../application/run-history/coordinator';
import type { LocalReconciliationRunHistoryPreservationReceipt } from '../application/run-history/evidence';
import type { LocalReconciliationCompletionDomainEvidence } from './evidence';
import {
  buildLocalReconciliationCompletionReceipt,
  localReconciliationCompletionReceiptContents,
  normalizeLocalReconciliationCompletionReceipt,
  type LocalReconciliationCompletionReceipt,
} from './evidence';
import {
  normalizeLocalReconciliationCompleteCommand,
  normalizeLocalReconciliationCompletionVerifyCommand,
  type LocalReconciliationCompleteCommand,
  type LocalReconciliationCompletionOptions,
  type LocalReconciliationCompletionResult,
  type LocalReconciliationCompletionVerifyCommand,
} from './contract';

const MAX_COMPLETIONS = 64;
const MAX_RECEIPT_BYTES = 64 * 1024;

interface CompletionPaths {
  readonly root: string;
  readonly receipt: string;
}

interface AutomationProof {
  readonly intent: Readonly<LocalReconciliationAutomationApplyIntent>;
  readonly receipt: Readonly<LocalReconciliationAutomationApplyReceipt>;
  readonly paths: ReturnType<typeof localReconciliationAutomationApplyPaths>;
  readonly storageState: 'applied' | 'completed';
}

interface SecretConfigProof {
  readonly intent: Readonly<LocalReconciliationSecretConfigApplyIntent>;
  readonly receipt: Readonly<LocalReconciliationSecretConfigApplyReceipt>;
  readonly preparedHeadDigest: string;
  readonly paths: ReturnType<typeof localReconciliationSecretConfigApplyPaths>;
  readonly storageState: 'applied' | 'completed';
}

interface RunHistoryProof {
  readonly receipt: Readonly<LocalReconciliationRunHistoryPreservationReceipt>;
}

export interface LocalReconciliationCompletionDependencies
  extends LocalReconciliationRunHistoryDependencies {
  readonly inspectSnapshot?: typeof inspectLocalSqliteSnapshot;
  readonly afterReceiptPublished?: () => void;
  readonly afterTerminalSealed?: () => void;
  readonly afterHeadAdvanced?: () => void;
  readonly afterBackupCollected?: () => void;
  readonly afterSecretConfigBackupCollected?: () => void;
}

async function runHistoryProof(
  command: Readonly<LocalReconciliationCompleteCommand>,
  terminal: Readonly<LocalReconciliationApplicationTerminal>,
  secretConfig: Readonly<SecretConfigProof> | null,
  uid: number,
  dependencies: LocalReconciliationCompletionDependencies,
): Promise<Readonly<RunHistoryProof> | null> {
  const domain = terminal.plan.domains.find(
    (selected) => selected.domain === 'run_history',
  );
  if (!domain) fail('run history domain is absent');
  if (domain.action === 'no_effect') {
    if (
      command.options.runHistory !== null ||
      command.request.runHistory !== null
    ) {
      fail('no-effect completion must not carry run history authority');
    }
    return null;
  }
  if (
    domain.action !== 'adapter_required' ||
    command.options.runHistory === null ||
    command.request.runHistory === null
  ) {
    fail('run history domain is not terminally provable');
  }
  validatePrivateDirectory(
    command.options.runHistory.runHistoryRoot,
    uid,
    'runHistoryRoot',
  );
  const history = await readLocalReconciliationRunHistoryTerminal(
    {
      deploymentRoot: command.options.deploymentRoot,
      applicationRoot: command.options.applicationRoot,
      runHistoryRoot: command.options.runHistory.runHistoryRoot,
      allowRootService: command.options.allowRootService,
    },
    command.request.runHistory.preservationId,
    command.request.applicationId,
    command.options.runHistory.decisionFilePath,
    uid,
    dependencies,
  );
  if (
    history.receipt.preservationDigest !==
      command.request.runHistory.expectedPreservationDigest ||
    history.receipt.applicationPlanDigest !==
      terminal.plan.applicationPlanDigest ||
    history.receipt.sourceHeadDigest !==
      (secretConfig?.preparedHeadDigest ?? command.request.expectedHeadDigest)
  ) {
    fail('run history preservation evidence is detached');
  }
  return Object.freeze({ receipt: history.receipt });
}

function fail(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation completion ${message}`,
    { cause },
  );
}

function completionPaths(
  completionRoot: string,
  completionId: string,
): Readonly<CompletionPaths> {
  const root = path.join(completionRoot, completionId);
  return Object.freeze({ root, receipt: path.join(root, 'receipt.json') });
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
    return fail(`${label} is unavailable`, error);
  }
  const mode = stat.mode & 0o777;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    !modes.includes(mode) ||
    fs.realpathSync(directory) !== directory
  ) {
    fail(`${label} identity is invalid`);
  }
  return mode;
}

function validateCatalog(selected: Readonly<CompletionPaths>, sealed: boolean) {
  const allowed = new Set([
    'receipt.json',
    ...(!sealed ? ['.receipt.json.ql3-deploy-stage'] : []),
  ]);
  for (const entry of fs.readdirSync(selected.root, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || entry.isSymbolicLink()) {
      fail('receipt catalog contains unknown material');
    }
  }
}

function ensureCompletionDirectory(
  completionRoot: string,
  completionId: string,
  uid: number,
): Readonly<CompletionPaths> {
  const selected = completionPaths(completionRoot, completionId);
  const entries = fs.readdirSync(completionRoot, { withFileTypes: true });
  if (entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) {
    fail('completion catalog contains drift');
  }
  if (entries.length >= MAX_COMPLETIONS && !fs.existsSync(selected.root)) {
    fail('completion retention limit is reached');
  }
  try {
    fs.mkdirSync(selected.root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      fail('receipt directory cannot be created', error);
    }
  }
  validateDirectory(selected.root, uid, [0o700, 0o500], 'receipt directory');
  validateCatalog(
    selected,
    (fs.statSync(selected.root).mode & 0o777) === 0o500,
  );
  return selected;
}

function stableReceipt(
  selected: Readonly<CompletionPaths>,
  uid: number,
  modes: readonly number[],
): Readonly<LocalReconciliationCompletionReceipt> {
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    const before = fs.lstatSync(selected.receipt, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      !modes.includes(Number(before.mode) & 0o777) ||
      before.nlink !== 1n ||
      before.size < 2n ||
      before.size > BigInt(MAX_RECEIPT_BYTES)
    ) {
      fail('receipt identity is invalid');
    }
    descriptor = fs.openSync(
      selected.receipt,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs ||
      opened.mode !== before.mode ||
      opened.uid !== before.uid ||
      opened.nlink !== before.nlink
    ) {
      fail('receipt changed while opening');
    }
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count < 1) fail('receipt read stalled');
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(selected.receipt, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      after.mode !== opened.mode ||
      after.uid !== opened.uid ||
      after.nlink !== opened.nlink ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino ||
      pathAfter.size !== before.size ||
      pathAfter.mtimeNs !== before.mtimeNs ||
      pathAfter.ctimeNs !== before.ctimeNs ||
      pathAfter.mode !== before.mode ||
      pathAfter.uid !== before.uid ||
      pathAfter.nlink !== before.nlink
    ) {
      fail('receipt drifted while reading');
    }
    return normalizeLocalReconciliationCompletionReceipt(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return fail('receipt cannot be read', error);
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sealCompletion(
  selected: Readonly<CompletionPaths>,
  uid: number,
): void {
  validateDirectory(selected.root, uid, [0o700, 0o500], 'receipt directory');
  stableReceipt(selected, uid, [0o600, 0o400]);
  let descriptor = fs.openSync(
    selected.receipt,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.uid !== uid ||
      opened.nlink !== 1 ||
      ![0o600, 0o400].includes(opened.mode & 0o777)
    ) {
      fail('receipt cannot be sealed');
    }
    if ((opened.mode & 0o777) !== 0o400) {
      fs.fchmodSync(descriptor, 0o400);
      fs.fsyncSync(descriptor);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const rootMode = validateDirectory(
    selected.root,
    uid,
    [0o700, 0o500],
    'receipt directory',
  );
  descriptor = fs.openSync(selected.root, fs.constants.O_RDONLY);
  try {
    if (rootMode !== 0o500) fs.fchmodSync(descriptor, 0o500);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  validateCatalog(selected, true);
  stableReceipt(selected, uid, [0o400]);
}

function validateApplication(
  terminal: Readonly<LocalReconciliationApplicationTerminal>,
  applicationId: string,
  applicationPlanDigest: string,
  deploymentRoot: string,
  applicationRoot: string,
): void {
  if (
    terminal.intent.command.request.applicationId !== applicationId ||
    terminal.plan.applicationId !== applicationId ||
    terminal.plan.applicationPlanDigest !== applicationPlanDigest ||
    terminal.intent.command.options.deploymentRoot !== deploymentRoot ||
    terminal.intent.command.options.applicationRoot !== applicationRoot
  ) {
    fail('application authority is detached');
  }
}

async function automationProof(
  command: Readonly<LocalReconciliationCompleteCommand>,
  terminal: Readonly<LocalReconciliationApplicationTerminal>,
  uid: number,
  dependencies: LocalReconciliationCompletionDependencies,
): Promise<Readonly<AutomationProof> | null> {
  const automationDomain = terminal.plan.domains.find(
    (domain) => domain.domain === 'automation',
  );
  if (!automationDomain) fail('automation domain is absent');
  if (automationDomain.action === 'no_effect') {
    if (
      command.options.automation !== null ||
      command.request.automation !== null
    ) {
      fail('no-effect completion must not carry automation authority');
    }
    return null;
  }
  if (
    automationDomain.action !== 'adapter_required' ||
    command.options.automation === null ||
    command.request.automation === null
  ) {
    fail('automation domain is not terminally provable');
  }
  const options = command.options.automation;
  const binding = command.request.automation;
  for (const [directory, label] of [
    [options.automationRoot, 'automationRoot'],
    [options.automationDecisionRoot, 'automationDecisionRoot'],
    [options.automationApplyRoot, 'automationApplyRoot'],
  ] as const) {
    validatePrivateDirectory(directory, uid, label);
  }
  const decision = await readLocalReconciliationAutomationDecisionTerminal(
    {
      deploymentRoot: command.options.deploymentRoot,
      applicationRoot: command.options.applicationRoot,
      automationRoot: options.automationRoot,
      automationDecisionRoot: options.automationDecisionRoot,
      allowRootService: command.options.allowRootService,
    },
    binding.automationId,
    uid,
  );
  if (
    decision.receipt.decisionId !== binding.decisionId ||
    decision.context.application.plan.applicationPlanDigest !==
      terminal.plan.applicationPlanDigest
  ) {
    fail('automation decision is detached from application authority');
  }
  const selected = localReconciliationAutomationApplyPaths(
    options.automationApplyRoot,
    binding.automationId,
  );
  validateLocalReconciliationAutomationApplyLayout(selected, uid);
  validateLocalReconciliationAutomationApplyCatalog(selected);
  const intent = readLocalReconciliationAutomationApplyIntent(selected, uid);
  const receipt = readLocalReconciliationAutomationApplyReceipt(selected, uid);
  if (
    intent.command.options.deploymentRoot !== command.options.deploymentRoot ||
    intent.command.options.applicationRoot !==
      command.options.applicationRoot ||
    intent.command.options.automationRoot !== options.automationRoot ||
    intent.command.options.automationDecisionRoot !==
      options.automationDecisionRoot ||
    intent.command.options.automationApplyRoot !==
      options.automationApplyRoot ||
    intent.command.options.targetDatabasePath !== options.targetDatabasePath ||
    intent.command.request.automationId !== binding.automationId ||
    intent.command.request.decisionId !== binding.decisionId ||
    receipt.automationId !== binding.automationId ||
    receipt.decisionId !== binding.decisionId ||
    receipt.applyDigest !== binding.expectedApplyDigest ||
    receipt.preparationDigest !== intent.preparationDigest
  ) {
    fail('automation apply evidence is detached');
  }
  if (command.request.secretConfig === null) {
    const current = await (
      dependencies.inspectSnapshot ?? inspectLocalSqliteSnapshot
    )({
      databasePath: options.targetDatabasePath,
      profile: intent.profile,
    });
    if (current.sha256 !== receipt.targetAfter.sha256) {
      fail('automation target drifted after apply');
    }
  }
  const storageState = fs.existsSync(selected.backup)
    ? ('applied' as const)
    : ('completed' as const);
  if (storageState === 'applied') {
    validateLocalReconciliationAutomationAppliedStorage(selected, intent, uid);
  } else {
    validateLocalReconciliationAutomationCompletedStorage(selected, uid);
  }
  return Object.freeze({
    intent,
    receipt,
    paths: selected,
    storageState,
  });
}

async function secretConfigProof(
  command: Readonly<LocalReconciliationCompleteCommand>,
  terminal: Readonly<LocalReconciliationApplicationTerminal>,
  automation: Readonly<AutomationProof> | null,
  uid: number,
  dependencies: LocalReconciliationCompletionDependencies,
): Promise<Readonly<SecretConfigProof> | null> {
  const secretConfigDomain = terminal.plan.domains.find(
    (domain) => domain.domain === 'secret_and_config',
  );
  if (!secretConfigDomain) fail('secret and config domain is absent');
  if (secretConfigDomain.action === 'no_effect') {
    if (
      command.options.secretConfig !== null ||
      command.request.secretConfig !== null
    ) {
      fail('no-effect completion must not carry secret config authority');
    }
    return null;
  }
  if (
    secretConfigDomain.action === 'manual_external' &&
    command.options.secretConfig === null &&
    command.request.secretConfig === null
  ) {
    return null;
  }
  if (
    secretConfigDomain.action !== 'manual_external' ||
    command.options.secretConfig === null ||
    command.request.secretConfig === null
  ) {
    fail('secret and config domain is not terminally provable');
  }
  const options = command.options.secretConfig;
  const binding = command.request.secretConfig;
  for (const [directory, label] of [
    [options.secretConfigRoot, 'secretConfigRoot'],
    [options.secretConfigDecisionRoot, 'secretConfigDecisionRoot'],
    [options.secretConfigApplyRoot, 'secretConfigApplyRoot'],
  ] as const) {
    validatePrivateDirectory(directory, uid, label);
  }
  const decision = await readLocalReconciliationSecretConfigDecisionTerminal(
    {
      deploymentRoot: command.options.deploymentRoot,
      applicationRoot: command.options.applicationRoot,
      secretConfigRoot: options.secretConfigRoot,
      secretConfigDecisionRoot: options.secretConfigDecisionRoot,
      allowRootService: command.options.allowRootService,
    },
    binding.secretConfigId,
    uid,
    [
      'reconciliation_secret_config_applied',
      'reconciliation_secret_config_rolled_back',
      'reconciliation_completed',
    ],
  );
  if (
    decision.receipt.decisionId !== binding.decisionId ||
    decision.receipt.outcome !== 'ready' ||
    decision.context.application.plan.applicationPlanDigest !==
      terminal.plan.applicationPlanDigest
  ) {
    fail('secret config decision is detached from application authority');
  }
  const selected = localReconciliationSecretConfigApplyPaths(
    options.secretConfigApplyRoot,
    binding.secretConfigId,
  );
  validateLocalReconciliationSecretConfigApplyCatalog(selected);
  const intent = readLocalReconciliationSecretConfigApplyIntent(selected, uid);
  const receipt = readLocalReconciliationSecretConfigApplyReceipt(
    selected,
    uid,
  );
  const targetSnapshotSha256 = decision.context.planHeader.targetSnapshotSha256;
  if (
    intent.command.options.deploymentRoot !== command.options.deploymentRoot ||
    intent.command.options.applicationRoot !==
      command.options.applicationRoot ||
    intent.command.options.secretConfigRoot !== options.secretConfigRoot ||
    intent.command.options.secretConfigDecisionRoot !==
      options.secretConfigDecisionRoot ||
    intent.command.options.secretConfigApplyRoot !==
      options.secretConfigApplyRoot ||
    intent.command.options.targetDatabasePath !== options.targetDatabasePath ||
    intent.command.request.secretConfigId !== binding.secretConfigId ||
    intent.command.request.decisionId !== binding.decisionId ||
    intent.command.request.expectedDecisionDigest !==
      decision.receipt.decisionDigest ||
    receipt.secretConfigId !== binding.secretConfigId ||
    receipt.decisionId !== binding.decisionId ||
    receipt.applyDigest !== binding.expectedApplyDigest ||
    receipt.preparationDigest !== intent.preparationDigest ||
    (automation === null
      ? targetSnapshotSha256 !== null
      : targetSnapshotSha256 !== automation.receipt.targetAfter.sha256) ||
    fs.existsSync(selected.rollbackReceipt)
  ) {
    fail('secret config apply evidence is detached');
  }
  const current = await (
    dependencies.inspectSnapshot ?? inspectLocalSqliteSnapshot
  )({
    databasePath: options.targetDatabasePath,
    profile: intent.profile,
  });
  if (current.sha256 !== receipt.targetAfter.sha256) {
    fail('secret config target drifted after apply');
  }
  const storageState = fs.existsSync(selected.backup)
    ? ('applied' as const)
    : ('completed' as const);
  if (storageState === 'applied') {
    validateLocalReconciliationSecretConfigAppliedStorage(
      selected,
      intent,
      uid,
    );
  } else {
    validateLocalReconciliationSecretConfigCompletedStorage(
      selected,
      intent,
      uid,
    );
  }
  return Object.freeze({
    intent,
    receipt,
    preparedHeadDigest: decision.context.planHeader.preparedHeadDigest,
    paths: selected,
    storageState,
  });
}

function domainEvidence(
  terminal: Readonly<LocalReconciliationApplicationTerminal>,
  automation: Readonly<AutomationProof> | null,
  secretConfig: Readonly<SecretConfigProof> | null,
  runHistory: Readonly<RunHistoryProof> | null,
): readonly Readonly<LocalReconciliationCompletionDomainEvidence>[] {
  return Object.freeze(
    terminal.plan.domains.map((domain) => {
      if (domain.action === 'no_effect') {
        return Object.freeze({
          domain: domain.domain,
          action: 'no_effect' as const,
          evidenceKind: 'application_summary' as const,
          evidenceDigest: domain.summaryDigest,
        });
      }
      if (
        domain.domain === 'automation' &&
        domain.action === 'adapter_required' &&
        automation !== null
      ) {
        return Object.freeze({
          domain: domain.domain,
          action: 'adapter_required' as const,
          evidenceKind: 'automation_apply' as const,
          evidenceDigest: automation.receipt.applyDigest,
        });
      }
      if (
        domain.domain === 'secret_and_config' &&
        domain.action === 'manual_external' &&
        secretConfig !== null
      ) {
        return Object.freeze({
          domain: domain.domain,
          action: 'adapter_required' as const,
          evidenceKind: 'secret_config_application' as const,
          evidenceDigest: secretConfig.receipt.applyDigest,
        });
      }
      if (
        domain.domain === 'run_history' &&
        domain.action === 'adapter_required' &&
        runHistory !== null
      ) {
        return Object.freeze({
          domain: domain.domain,
          action: 'adapter_required' as const,
          evidenceKind: 'run_history_preservation' as const,
          evidenceDigest: runHistory.receipt.preservationDigest,
        });
      }
      return fail(`${domain.domain} is not terminally reconciled`);
    }),
  );
}

function validateReceiptBinding(
  receipt: Readonly<LocalReconciliationCompletionReceipt>,
  terminal: Readonly<LocalReconciliationApplicationTerminal>,
  expectedDomains: readonly Readonly<LocalReconciliationCompletionDomainEvidence>[],
  completionId: string,
  applicationId: string,
): void {
  if (
    receipt.completionId !== completionId ||
    receipt.applicationId !== applicationId ||
    receipt.profile !== terminal.intent.profile ||
    receipt.instanceId !== terminal.intent.instanceId ||
    receipt.cutoverId !== terminal.intent.cutoverId ||
    receipt.generation !== terminal.intent.generation ||
    receipt.activationDigest !== terminal.intent.activationDigest ||
    receipt.applicationPlanDigest !== terminal.plan.applicationPlanDigest ||
    JSON.stringify(receipt.domains) !== JSON.stringify(expectedDomains)
  ) {
    fail('receipt is detached from terminal domain evidence');
  }
}

function advanceCompletedHead(
  terminal: Readonly<LocalReconciliationApplicationTerminal>,
  receipt: Readonly<LocalReconciliationCompletionReceipt>,
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
        requestedAtMs: receipt.completedAtMs,
      },
    },
    uid,
    'reconciliation_completed',
    terminal.intent.generation,
    receipt.completionDigest,
  );
}

function result(
  operation: LocalReconciliationCompletionResult['operation'],
  status: LocalReconciliationCompletionResult['status'],
  receipt: Readonly<LocalReconciliationCompletionReceipt>,
  head: Readonly<LocalCutoverInstanceHead>,
): Readonly<LocalReconciliationCompletionResult> {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    status,
    state: 'reconciliation_completed',
    completionId: receipt.completionId,
    applicationId: receipt.applicationId,
    completionDigest: receipt.completionDigest,
    domainCount: 8,
    adapterCount: receipt.adapterCount,
    instanceHeadDigest: head.headDigest,
  });
}

function assertSourceHead(
  head: Readonly<LocalCutoverInstanceHead>,
  expectedHeadDigest: string,
  automation: Readonly<AutomationProof> | null,
  secretConfig: Readonly<SecretConfigProof> | null,
): void {
  const expectedState =
    secretConfig !== null
      ? 'reconciliation_secret_config_applied'
      : automation === null
      ? 'reconciliation_application_planned'
      : 'reconciliation_automation_applied';
  const expectedSource =
    secretConfig !== null
      ? secretConfig.receipt.applyDigest
      : automation === null
      ? undefined
      : automation.receipt.applyDigest;
  if (
    head.headDigest !== expectedHeadDigest ||
    head.state !== expectedState ||
    (expectedSource !== undefined && head.sourceRecordDigest !== expectedSource)
  ) {
    fail('completion lost source head compare-and-swap');
  }
}

export async function completeLocalReconciliation(
  value: unknown,
  dependencies: LocalReconciliationCompletionDependencies = {},
): Promise<Readonly<LocalReconciliationCompletionResult>> {
  const command = normalizeLocalReconciliationCompleteCommand(value);
  const uid = currentIdentity().uid;
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
    [command.options.completionRoot, 'completionRoot'],
  ] as const) {
    validatePrivateDirectory(directory, uid, label);
  }
  const terminal = await readLocalReconciliationApplicationTerminal(
    command.options.applicationRoot,
    command.request.applicationId,
    uid,
  );
  validateApplication(
    terminal,
    command.request.applicationId,
    command.request.expectedApplicationPlanDigest,
    command.options.deploymentRoot,
    command.options.applicationRoot,
  );
  const automation = await automationProof(
    command,
    terminal,
    uid,
    dependencies,
  );
  const secretConfig = await secretConfigProof(
    command,
    terminal,
    automation,
    uid,
    dependencies,
  );
  const runHistory = await runHistoryProof(
    command,
    terminal,
    secretConfig,
    uid,
    dependencies,
  );
  const domains = domainEvidence(
    terminal,
    automation,
    secretConfig,
    runHistory,
  );
  const selected = ensureCompletionDirectory(
    command.options.completionRoot,
    command.request.completionId,
    uid,
  );
  let receipt: Readonly<LocalReconciliationCompletionReceipt>;
  let status: 'completed' | 'existing' = 'completed';
  let head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    terminal.intent.instanceId,
    uid,
  );
  if (fs.existsSync(selected.receipt)) {
    status = 'existing';
    receipt = stableReceipt(selected, uid, [0o600, 0o400]);
    validateReceiptBinding(
      receipt,
      terminal,
      domains,
      command.request.completionId,
      command.request.applicationId,
    );
    if (
      receipt.sourceHeadDigest !== command.request.expectedHeadDigest ||
      receipt.completedAtMs !== command.request.completedAtMs
    ) {
      fail('completion command is not an exact replay');
    }
  } else {
    assertSourceHead(
      head,
      command.request.expectedHeadDigest,
      automation,
      secretConfig,
    );
    const adapterCount = domains.filter(
      (domain) => domain.action === 'adapter_required',
    ).length as 0 | 1 | 2 | 3;
    const latestEvidenceAtMs = Math.max(
      terminal.plan.committedAtMs,
      automation?.receipt.appliedAtMs ?? 0,
      secretConfig?.receipt.appliedAtMs ?? 0,
      runHistory?.receipt.preservedAtMs ?? 0,
    );
    if (command.request.completedAtMs < latestEvidenceAtMs) {
      fail('completion timestamp precedes terminal evidence');
    }
    receipt = buildLocalReconciliationCompletionReceipt({
      completionId: command.request.completionId,
      applicationId: command.request.applicationId,
      profile: terminal.intent.profile,
      instanceId: terminal.intent.instanceId,
      cutoverId: terminal.intent.cutoverId,
      generation: terminal.intent.generation,
      activationDigest: terminal.intent.activationDigest,
      applicationPlanDigest: terminal.plan.applicationPlanDigest,
      sourceHeadDigest: head.headDigest,
      domains,
      adapterCount,
      completedAtMs: command.request.completedAtMs,
    });
    const serialized = localReconciliationCompletionReceiptContents(receipt);
    preflightPublishedFile(
      selected.receipt,
      serialized,
      0o600,
      uid,
      'reconciliation completion receipt',
    );
    publishExactFile(
      selected.receipt,
      serialized,
      0o600,
      uid,
      'reconciliation completion receipt',
    );
    dependencies.afterReceiptPublished?.();
  }
  sealCompletion(selected, uid);
  dependencies.afterTerminalSealed?.();
  head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    terminal.intent.instanceId,
    uid,
  );
  if (head.state !== 'reconciliation_completed') {
    assertSourceHead(head, receipt.sourceHeadDigest, automation, secretConfig);
    if (automation?.storageState === 'completed') {
      fail('automation rollback backup was collected before completion');
    }
    if (secretConfig?.storageState === 'completed') {
      fail('secret config rollback backup was collected before completion');
    }
    head = advanceCompletedHead(terminal, receipt, uid);
  } else if (head.sourceRecordDigest !== receipt.completionDigest) {
    fail('completed head is detached from receipt');
  }
  dependencies.afterHeadAdvanced?.();
  if (automation !== null) {
    collectLocalReconciliationAutomationCompletedStorage(
      automation.paths,
      automation.intent,
      uid,
    );
    dependencies.afterBackupCollected?.();
  }
  if (secretConfig !== null) {
    collectLocalReconciliationSecretConfigCompletedStorage(
      secretConfig.paths,
      secretConfig.intent,
      uid,
    );
    dependencies.afterSecretConfigBackupCollected?.();
  }
  return result(command.operation, status, receipt, head);
}

export async function verifyLocalReconciliationCompletion(
  value: unknown,
  dependencies: LocalReconciliationCompletionDependencies = {},
): Promise<Readonly<LocalReconciliationCompletionResult>> {
  const command = normalizeLocalReconciliationCompletionVerifyCommand(value);
  const uid = currentIdentity().uid;
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
    [command.options.completionRoot, 'completionRoot'],
  ] as const) {
    validatePrivateDirectory(directory, uid, label);
  }
  const selected = completionPaths(
    command.options.completionRoot,
    command.request.completionId,
  );
  validateDirectory(selected.root, uid, [0o500], 'receipt directory');
  validateCatalog(selected, true);
  const receipt = stableReceipt(selected, uid, [0o400]);
  if (
    receipt.applicationId !== command.request.applicationId ||
    receipt.completionDigest !== command.request.expectedCompletionDigest
  ) {
    fail('verify command is detached from receipt');
  }
  const terminal = await readLocalReconciliationApplicationTerminal(
    command.options.applicationRoot,
    command.request.applicationId,
    uid,
  );
  validateApplication(
    terminal,
    command.request.applicationId,
    receipt.applicationPlanDigest,
    command.options.deploymentRoot,
    command.options.applicationRoot,
  );
  const syntheticCompleteCommand = Object.freeze({
    schemaVersion: receipt.schemaVersion,
    operation: 'local.deployment.reconciliation.complete' as const,
    options: command.options,
    request: Object.freeze({
      completionId: receipt.completionId,
      applicationId: receipt.applicationId,
      expectedApplicationPlanDigest: receipt.applicationPlanDigest,
      expectedHeadDigest: receipt.sourceHeadDigest,
      automation: command.request.automation,
      secretConfig: command.request.secretConfig,
      runHistory: command.request.runHistory,
      completedAtMs: receipt.completedAtMs,
    }),
  });
  const automation = await automationProof(
    syntheticCompleteCommand,
    terminal,
    uid,
    dependencies,
  );
  const secretConfig = await secretConfigProof(
    syntheticCompleteCommand,
    terminal,
    automation,
    uid,
    dependencies,
  );
  const runHistory = await runHistoryProof(
    syntheticCompleteCommand,
    terminal,
    secretConfig,
    uid,
    dependencies,
  );
  const domains = domainEvidence(
    terminal,
    automation,
    secretConfig,
    runHistory,
  );
  validateReceiptBinding(
    receipt,
    terminal,
    domains,
    command.request.completionId,
    command.request.applicationId,
  );
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    terminal.intent.instanceId,
    uid,
  );
  if (
    head.state !== 'reconciliation_completed' ||
    head.sourceRecordDigest !== receipt.completionDigest
  ) {
    fail('completion receipt is detached from instance head');
  }
  if (automation !== null) {
    validateLocalReconciliationAutomationCompletedStorage(
      automation.paths,
      uid,
    );
  }
  if (secretConfig !== null) {
    validateLocalReconciliationSecretConfigCompletedStorage(
      secretConfig.paths,
      secretConfig.intent,
      uid,
    );
  }
  return result(command.operation, 'verified', receipt, head);
}

export function completeLocalReconciliationCommandFile(
  filePath: string,
  dependencies: LocalReconciliationCompletionDependencies = {},
) {
  return completeLocalReconciliation(
    readPrivateLocalCommandFile(filePath),
    dependencies,
  );
}

export function verifyLocalReconciliationCompletionCommandFile(
  filePath: string,
  dependencies: LocalReconciliationCompletionDependencies = {},
) {
  return verifyLocalReconciliationCompletion(
    readPrivateLocalCommandFile(filePath),
    dependencies,
  );
}

export type {
  LocalReconciliationCompletionOptions,
  LocalReconciliationCompletionVerifyCommand,
};
