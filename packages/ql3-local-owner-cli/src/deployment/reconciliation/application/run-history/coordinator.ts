import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { currentIdentity } from '../../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../../foundation/error';
import {
  preflightPublishedFile,
  publishExactFile,
  validatePrivateDirectory,
} from '../../../foundation/files';
import { readLocalCutoverInstanceHead } from '../../../cutover/instanceLineage';
import { readLocalReconciliationPlanTerminal } from '../../planning/preparation';
import {
  assertLocalReconciliationReviewDecisionMatchesFact,
  withLocalReconciliationReviewDecisionFile,
} from '../../review/decisionFile';
import { visitLocalReconciliationDiagnosticFacts } from '../../review/diagnostics';
import { readLocalReconciliationReviewTerminalJson } from '../../review/terminalEvidence';
import {
  withLocalReconciliationSealedDatabase,
  type LocalReconciliationSealedBundleReaderDependencies,
} from '../../sealed-bundle/reader';
import {
  readLocalReconciliationApplicationTerminal,
  type LocalReconciliationApplicationTerminal,
} from '../coordinator';
import {
  normalizeLocalReconciliationRunHistoryPreserveCommand,
  normalizeLocalReconciliationRunHistoryVerifyCommand,
  type LocalReconciliationRunHistoryOptions,
  type LocalReconciliationRunHistoryPreserveCommand,
  type LocalReconciliationRunHistoryResult,
  type LocalReconciliationRunHistoryVerifyCommand,
} from './contract';
import {
  buildLocalReconciliationRunHistoryPreservationReceipt,
  localReconciliationRunHistoryReceiptContents,
  normalizeLocalReconciliationRunHistoryPreservationReceipt,
  type LocalReconciliationRunHistoryPreservationReceipt,
} from './evidence';

const MAX_PRESERVATIONS = 64;
const MAX_RECEIPT_BYTES = 64 * 1024;

interface RunHistoryPaths {
  readonly root: string;
  readonly receipt: string;
}

interface RunHistoryAuthority {
  readonly application: Readonly<LocalReconciliationApplicationTerminal>;
  readonly runHistoryInventoryDigest: string;
  readonly bundleDigest: string;
  readonly bundleFingerprintDigest: string;
  readonly decisionFileDigest: string;
  readonly legacyFactCount: number;
  readonly targetFactCount: number;
  confirmDecisionFileIdentity(): void;
}

export interface LocalReconciliationRunHistoryDependencies
  extends LocalReconciliationSealedBundleReaderDependencies {
  readonly afterReceiptPublished?: () => void;
  readonly afterTerminalSealed?: () => void;
}

export interface LocalReconciliationRunHistoryTerminal {
  readonly receipt: Readonly<LocalReconciliationRunHistoryPreservationReceipt>;
  readonly application: Readonly<LocalReconciliationApplicationTerminal>;
}

function fail(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation run history ${message}`,
    { cause },
  );
}

function runHistoryPaths(
  runHistoryRoot: string,
  preservationId: string,
): Readonly<RunHistoryPaths> {
  const root = path.join(runHistoryRoot, preservationId);
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

function validateCatalog(selected: Readonly<RunHistoryPaths>, sealed: boolean) {
  const allowed = new Set([
    'receipt.json',
    ...(!sealed ? ['.receipt.json.ql3-deploy-stage'] : []),
  ]);
  for (const entry of fs.readdirSync(selected.root, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || entry.isSymbolicLink()) {
      fail('preservation catalog contains unknown material');
    }
  }
}

function ensurePreservationDirectory(
  runHistoryRoot: string,
  preservationId: string,
  uid: number,
): Readonly<RunHistoryPaths> {
  const selected = runHistoryPaths(runHistoryRoot, preservationId);
  const entries = fs.readdirSync(runHistoryRoot, { withFileTypes: true });
  if (entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) {
    fail('preservation root catalog contains drift');
  }
  if (entries.length >= MAX_PRESERVATIONS && !fs.existsSync(selected.root)) {
    fail('preservation retention limit is reached');
  }
  try {
    fs.mkdirSync(selected.root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      fail('preservation directory cannot be created', error);
    }
  }
  const mode = validateDirectory(
    selected.root,
    uid,
    [0o700, 0o500],
    'preservation directory',
  );
  validateCatalog(selected, mode === 0o500);
  return selected;
}

function readReceipt(
  selected: Readonly<RunHistoryPaths>,
  uid: number,
  modes: readonly number[],
): Readonly<LocalReconciliationRunHistoryPreservationReceipt> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(selected.receipt);
  } catch (error) {
    return fail('preservation receipt is unavailable', error);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    !modes.includes(stat.mode & 0o777) ||
    stat.nlink !== 1 ||
    stat.size < 2 ||
    stat.size > MAX_RECEIPT_BYTES
  ) {
    fail('preservation receipt identity is invalid');
  }
  try {
    return normalizeLocalReconciliationRunHistoryPreservationReceipt(
      readLocalReconciliationReviewTerminalJson(selected.receipt, uid, modes),
    );
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return fail('preservation receipt cannot be read', error);
  }
}

function sealPreservation(
  selected: Readonly<RunHistoryPaths>,
  uid: number,
): void {
  validateDirectory(
    selected.root,
    uid,
    [0o700, 0o500],
    'preservation directory',
  );
  readReceipt(selected, uid, [0o600, 0o400]);
  let descriptor = fs.openSync(
    selected.receipt,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1) {
      fail('preservation receipt cannot be sealed');
    }
    if ((stat.mode & 0o777) !== 0o400) {
      fs.fchmodSync(descriptor, 0o400);
      fs.fsyncSync(descriptor);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  descriptor = fs.openSync(selected.root, fs.constants.O_RDONLY);
  try {
    const stat = fs.fstatSync(descriptor);
    if ((stat.mode & 0o777) !== 0o500) fs.fchmodSync(descriptor, 0o500);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  validateCatalog(selected, true);
  readReceipt(selected, uid, [0o400]);
}

function validateApplication(
  application: Readonly<LocalReconciliationApplicationTerminal>,
  options: Readonly<LocalReconciliationRunHistoryOptions>,
  applicationId: string,
  applicationPlanDigest: string,
): void {
  const runHistory = application.plan.domains.find(
    (domain) => domain.domain === 'run_history',
  );
  if (
    application.intent.command.options.deploymentRoot !==
      options.deploymentRoot ||
    application.intent.command.options.applicationRoot !==
      options.applicationRoot ||
    application.plan.applicationId !== applicationId ||
    application.plan.applicationPlanDigest !== applicationPlanDigest ||
    !runHistory ||
    runHistory.action !== 'adapter_required'
  ) {
    fail('preservation authority is detached from the application plan');
  }
}

function assertSourceHead(
  application: Readonly<LocalReconciliationApplicationTerminal>,
  expectedHeadDigest: string,
  uid: number,
): void {
  const head = readLocalCutoverInstanceHead(
    application.intent.command.options.deploymentRoot,
    application.intent.instanceId,
    uid,
  );
  const automation = application.plan.domains.find(
    (domain) => domain.domain === 'automation',
  );
  const expectedState =
    automation?.action === 'no_effect'
      ? 'reconciliation_application_planned'
      : automation?.action === 'adapter_required'
      ? 'reconciliation_automation_applied'
      : null;
  if (
    expectedState === null ||
    head.headDigest !== expectedHeadDigest ||
    head.state !== expectedState ||
    head.instanceId !== application.intent.instanceId ||
    head.cutoverId !== application.intent.cutoverId ||
    head.generation !== application.intent.generation ||
    head.activationDigest !== application.intent.activationDigest
  ) {
    fail('preservation lost source head compare-and-swap');
  }
}

async function deriveAuthority(
  options: Readonly<LocalReconciliationRunHistoryOptions>,
  applicationId: string,
  applicationPlanDigest: string,
  decisionFilePath: string,
  uid: number,
  dependencies: LocalReconciliationRunHistoryDependencies,
): Promise<Readonly<RunHistoryAuthority>> {
  const application = await readLocalReconciliationApplicationTerminal(
    options.applicationRoot,
    applicationId,
    uid,
  );
  validateApplication(
    application,
    options,
    applicationId,
    applicationPlanDigest,
  );
  const planTerminal = readLocalReconciliationPlanTerminal(
    application.review.intent.command.options.planRoot,
    application.review.intent.command.request.planId,
    uid,
  );
  const runHistory = planTerminal.plan.domains.find(
    (domain) => domain.domain === 'run_history',
  );
  if (!runHistory) fail('run history inventory is absent');
  let legacyFactCount = 0;
  let targetFactCount = 0;
  const reviewed = withLocalReconciliationReviewDecisionFile(
    decisionFilePath,
    {
      reviewId: application.review.review.reviewId,
      profile: application.plan.profile,
      planDigest: planTerminal.plan.planDigest,
      preparationDigest: application.review.intent.preparationDigest,
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
                  fail('decision file omitted a canonical fact');
                }
                assertLocalReconciliationReviewDecisionMatchesFact(
                  decision,
                  fact,
                );
                if (fact.domain !== 'run_history') return;
                if (
                  fact.decisionRequirement !== 'required' ||
                  fact.reason !== 'historical_preservation_required' ||
                  (database === 'legacy' &&
                    decision.disposition !== 'retain_both') ||
                  (database === 'target' &&
                    decision.disposition !== 'retain_target')
                ) {
                  fail(
                    'signed review did not authorize append-only preservation',
                  );
                }
                if (database === 'legacy') legacyFactCount += 1;
                else targetFactCount += 1;
              },
            ),
        );
        if (opened === null) {
          fail('manual-required SQLite topology cannot be preserved');
        }
      }
    },
  );
  if (
    reviewed.evidence.fileDigest !==
      application.review.authorization.decisionFileDigest ||
    reviewed.evidence.decisionCount !==
      application.review.authorization.decisionCount ||
    legacyFactCount < 1 ||
    targetFactCount < 1
  ) {
    fail('signed review authority drifted');
  }
  return Object.freeze({
    application,
    runHistoryInventoryDigest: runHistory.inventoryDigest,
    bundleDigest: planTerminal.bundle.receipt.bundleDigest,
    bundleFingerprintDigest: planTerminal.bundle.fingerprintDigest,
    decisionFileDigest: reviewed.evidence.fileDigest,
    legacyFactCount,
    targetFactCount,
    confirmDecisionFileIdentity: reviewed.confirmIdentity,
  });
}

function validateReceiptBinding(
  receipt: Readonly<LocalReconciliationRunHistoryPreservationReceipt>,
  authority: Readonly<RunHistoryAuthority>,
  preservationId: string,
): void {
  const application = authority.application;
  if (
    receipt.preservationId !== preservationId ||
    receipt.applicationId !== application.plan.applicationId ||
    receipt.profile !== application.plan.profile ||
    receipt.instanceId !== application.intent.instanceId ||
    receipt.cutoverId !== application.intent.cutoverId ||
    receipt.generation !== application.intent.generation ||
    receipt.activationDigest !== application.intent.activationDigest ||
    receipt.applicationPlanDigest !== application.plan.applicationPlanDigest ||
    receipt.reviewDigest !== application.review.review.reviewDigest ||
    receipt.reviewAuthorizationDigest !==
      application.review.authorization.authorizationDigest ||
    receipt.reviewDecisionSetDigest !==
      application.review.authorization.decisionSetDigest ||
    receipt.reviewDecisionFileDigest !== authority.decisionFileDigest ||
    receipt.bundleDigest !== authority.bundleDigest ||
    receipt.bundleFingerprintDigest !== authority.bundleFingerprintDigest ||
    receipt.runHistoryInventoryDigest !== authority.runHistoryInventoryDigest ||
    receipt.legacyFactCount !== authority.legacyFactCount ||
    receipt.targetFactCount !== authority.targetFactCount
  ) {
    fail('preservation receipt is detached from terminal authority');
  }
}

function result(
  operation: LocalReconciliationRunHistoryResult['operation'],
  status: LocalReconciliationRunHistoryResult['status'],
  receipt: Readonly<LocalReconciliationRunHistoryPreservationReceipt>,
): Readonly<LocalReconciliationRunHistoryResult> {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    status,
    state: 'reconciliation_run_history_preserved',
    preservationId: receipt.preservationId,
    applicationId: receipt.applicationId,
    preservationDigest: receipt.preservationDigest,
    legacyFactCount: receipt.legacyFactCount,
    targetFactCount: receipt.targetFactCount,
  });
}

export async function readLocalReconciliationRunHistoryTerminal(
  options: Readonly<LocalReconciliationRunHistoryOptions>,
  preservationId: string,
  applicationId: string,
  decisionFilePath: string,
  uid: number,
  dependencies: LocalReconciliationRunHistoryDependencies = {},
): Promise<Readonly<LocalReconciliationRunHistoryTerminal>> {
  const selected = runHistoryPaths(options.runHistoryRoot, preservationId);
  validateDirectory(selected.root, uid, [0o500], 'preservation directory');
  validateCatalog(selected, true);
  const receipt = readReceipt(selected, uid, [0o400]);
  if (receipt.applicationId !== applicationId) {
    fail('preservation path binding drifted');
  }
  const authority = await deriveAuthority(
    options,
    applicationId,
    receipt.applicationPlanDigest,
    decisionFilePath,
    uid,
    dependencies,
  );
  validateReceiptBinding(receipt, authority, preservationId);
  authority.confirmDecisionFileIdentity();
  return Object.freeze({ receipt, application: authority.application });
}

export async function preserveLocalReconciliationRunHistory(
  value: unknown,
  dependencies: LocalReconciliationRunHistoryDependencies = {},
): Promise<Readonly<LocalReconciliationRunHistoryResult>> {
  const command = normalizeLocalReconciliationRunHistoryPreserveCommand(value);
  const uid = currentIdentity().uid;
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
    [command.options.runHistoryRoot, 'runHistoryRoot'],
  ] as const) {
    validatePrivateDirectory(directory, uid, label);
  }
  const selected = ensurePreservationDirectory(
    command.options.runHistoryRoot,
    command.request.preservationId,
    uid,
  );
  const authority = await deriveAuthority(
    command.options,
    command.request.applicationId,
    command.request.expectedApplicationPlanDigest,
    command.request.decisionFilePath,
    uid,
    dependencies,
  );
  let receipt: Readonly<LocalReconciliationRunHistoryPreservationReceipt>;
  let status: 'preserved' | 'existing' = 'preserved';
  if (fs.existsSync(selected.receipt)) {
    status = 'existing';
    receipt = readReceipt(selected, uid, [0o600, 0o400]);
    validateReceiptBinding(receipt, authority, command.request.preservationId);
    if (
      receipt.sourceHeadDigest !== command.request.expectedHeadDigest ||
      receipt.preservedAtMs !== command.request.preservedAtMs
    ) {
      fail('preservation command is not an exact replay');
    }
  } else {
    assertSourceHead(
      authority.application,
      command.request.expectedHeadDigest,
      uid,
    );
    if (
      command.request.preservedAtMs < authority.application.plan.committedAtMs
    ) {
      fail('preservation timestamp precedes application evidence');
    }
    receipt = buildLocalReconciliationRunHistoryPreservationReceipt({
      preservationId: command.request.preservationId,
      applicationId: command.request.applicationId,
      profile: authority.application.plan.profile,
      instanceId: authority.application.intent.instanceId,
      cutoverId: authority.application.intent.cutoverId,
      generation: authority.application.intent.generation,
      activationDigest: authority.application.intent.activationDigest,
      applicationPlanDigest: authority.application.plan.applicationPlanDigest,
      sourceHeadDigest: command.request.expectedHeadDigest,
      reviewDigest: authority.application.review.review.reviewDigest,
      reviewAuthorizationDigest:
        authority.application.review.authorization.authorizationDigest,
      reviewDecisionSetDigest:
        authority.application.review.authorization.decisionSetDigest,
      reviewDecisionFileDigest: authority.decisionFileDigest,
      bundleDigest: authority.bundleDigest,
      bundleFingerprintDigest: authority.bundleFingerprintDigest,
      runHistoryInventoryDigest: authority.runHistoryInventoryDigest,
      legacyFactCount: authority.legacyFactCount,
      targetFactCount: authority.targetFactCount,
      preservedAtMs: command.request.preservedAtMs,
    });
    const contents = localReconciliationRunHistoryReceiptContents(receipt);
    preflightPublishedFile(
      selected.receipt,
      contents,
      0o600,
      uid,
      'run history preservation receipt',
    );
    authority.confirmDecisionFileIdentity();
    assertSourceHead(
      authority.application,
      command.request.expectedHeadDigest,
      uid,
    );
    publishExactFile(
      selected.receipt,
      contents,
      0o600,
      uid,
      'run history preservation receipt',
    );
    dependencies.afterReceiptPublished?.();
  }
  sealPreservation(selected, uid);
  dependencies.afterTerminalSealed?.();
  authority.confirmDecisionFileIdentity();
  assertSourceHead(
    authority.application,
    command.request.expectedHeadDigest,
    uid,
  );
  return result(command.operation, status, receipt);
}

export async function verifyLocalReconciliationRunHistory(
  value: unknown,
  dependencies: LocalReconciliationRunHistoryDependencies = {},
): Promise<Readonly<LocalReconciliationRunHistoryResult>> {
  const command = normalizeLocalReconciliationRunHistoryVerifyCommand(value);
  const uid = currentIdentity().uid;
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
    [command.options.runHistoryRoot, 'runHistoryRoot'],
  ] as const) {
    validatePrivateDirectory(directory, uid, label);
  }
  const terminal = await readLocalReconciliationRunHistoryTerminal(
    command.options,
    command.request.preservationId,
    command.request.applicationId,
    command.request.decisionFilePath,
    uid,
    dependencies,
  );
  if (
    terminal.receipt.preservationDigest !==
    command.request.expectedPreservationDigest
  ) {
    fail('verify command is detached from preservation receipt');
  }
  return result(command.operation, 'verified', terminal.receipt);
}

export function preserveLocalReconciliationRunHistoryCommandFile(
  filePath: string,
  dependencies: LocalReconciliationRunHistoryDependencies = {},
) {
  return preserveLocalReconciliationRunHistory(
    readPrivateLocalCommandFile(filePath),
    dependencies,
  );
}

export function verifyLocalReconciliationRunHistoryCommandFile(
  filePath: string,
  dependencies: LocalReconciliationRunHistoryDependencies = {},
) {
  return verifyLocalReconciliationRunHistory(
    readPrivateLocalCommandFile(filePath),
    dependencies,
  );
}

export type {
  LocalReconciliationRunHistoryPreserveCommand,
  LocalReconciliationRunHistoryVerifyCommand,
};
