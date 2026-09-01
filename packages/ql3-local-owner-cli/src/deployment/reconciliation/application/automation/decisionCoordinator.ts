import fs from 'node:fs';
import path from 'node:path';

import {
  issueReconciliationAutomationDecision,
  recoverReconciliationAutomationDecision,
  verifyReconciliationAutomationDecision,
  type ReconciliationAutomationDecisionPublication,
} from '@qinglong/local-admin/reconciliation-automation-decision';
import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';
import {
  establishAuthenticatedLocalCommand,
  type AuthenticatedLocalCommand,
} from '@qinglong/local-owner-console/authenticated-command';
import { openLocalSqliteAuthenticationReadDatabase } from '@qinglong/local-sqlite/authentication-read';
import type { SecurityPrincipal } from '@qinglong/runtime-core/security';

import { currentIdentity } from '../../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../../foundation/error';
import {
  ensurePrivateDirectory,
  preflightPublishedFile,
  publishExactFile,
  validatePrivateDirectory,
} from '../../../foundation/files';
import {
  advanceLocalCutoverInstanceHead,
  readLocalCutoverInstanceHead,
  type LocalCutoverInstanceHead,
} from '../../../cutover/instanceLineage';
import { cutoverDigest } from '../../../cutover/targetEvidence';
import { readLocalReconciliationCaptureIntent } from '../../preparation';
import { readLocalReconciliationPlanTerminal } from '../../planning/preparation';
import {
  withLocalReconciliationSealedDatabaseAsync,
  type LocalReconciliationSealedBundleReaderDependencies,
} from '../../sealed-bundle/reader';
import { readLocalReconciliationApplicationTerminal } from '../coordinator';
import {
  normalizeLocalReconciliationAutomationDecisionCommitCommand,
  normalizeLocalReconciliationAutomationDecisionPrepareCommand,
  normalizeLocalReconciliationAutomationDecisionVerifyCommand,
  type LocalReconciliationAutomationDecisionCommitCommand,
  type LocalReconciliationAutomationDecisionPrepareCommand,
  type LocalReconciliationAutomationDecisionPrepareResult,
  type LocalReconciliationAutomationDecisionTerminalResult,
} from './decisionContract';
import {
  buildLocalReconciliationAutomationDecisionIntent,
  buildLocalReconciliationAutomationDecisionReceipt,
  localReconciliationAutomationDecisionEvidenceContents,
  normalizeLocalReconciliationAutomationDecisionIntent,
  normalizeLocalReconciliationAutomationDecisionReceipt,
  type LocalReconciliationAutomationDecisionIntent,
  type LocalReconciliationAutomationDecisionReceipt,
} from './decisionEvidence';
import {
  readLocalReconciliationAutomationTerminal,
  type LocalReconciliationAutomationTerminal,
} from './coordinator';
import {
  createLocalReconciliationAutomationRequirementFactory,
  readLocalReconciliationAutomationPlanHeader,
} from './planReader';
import {
  ensureLocalReconciliationReviewIssuerKeyring,
  LocalReconciliationReviewIssuerKeyringFileProvider,
} from '../../review/issuerKeyring';

const MAX_AUTHENTICATION_AGE_MS = 5 * 60 * 1_000;
const COMMIT_CLOCK_SKEW_MS = 60_000;

interface DecisionPaths {
  readonly root: string;
  readonly staging: string;
  readonly intent: string;
  readonly authorization: string;
  readonly receipt: string;
}

interface DecisionContext {
  readonly automation: Readonly<LocalReconciliationAutomationTerminal>;
  readonly application: Awaited<
    ReturnType<typeof readLocalReconciliationApplicationTerminal>
  >;
  readonly header: ReturnType<
    typeof readLocalReconciliationAutomationPlanHeader
  >;
}

type AuthenticationDatabase = Awaited<
  ReturnType<typeof openLocalSqliteAuthenticationReadDatabase>
>;

export interface LocalReconciliationAutomationDecisionDependencies
  extends LocalReconciliationSealedBundleReaderDependencies {
  readonly openAuthenticationDatabase?: typeof openLocalSqliteAuthenticationReadDatabase;
  readonly authenticate?: typeof establishAuthenticatedLocalCommand;
  readonly now?: () => number;
  readonly afterHeadPrepared?: () => void;
  readonly afterAuthorizationPublished?: () => void;
  readonly afterReceiptPublished?: () => void;
  readonly afterTerminalSealed?: () => void;
  readonly afterHeadAdvanced?: () => void;
}

export interface LocalReconciliationAutomationDecisionTerminal {
  readonly intent: Readonly<LocalReconciliationAutomationDecisionIntent>;
  readonly receipt: Readonly<LocalReconciliationAutomationDecisionReceipt>;
  readonly authorizationPath: string;
  readonly context: Readonly<DecisionContext>;
  readonly plan: ReturnType<typeof readLocalReconciliationPlanTerminal>;
  readonly reviewer: Readonly<SecurityPrincipal>;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation automation decision ${message}`,
    { cause },
  );
}

function paths(
  decisionRoot: string,
  automationId: string,
): Readonly<DecisionPaths> {
  const root = path.join(decisionRoot, automationId);
  return Object.freeze({
    root,
    staging: path.join(root, 'staging'),
    intent: path.join(root, 'intent.json'),
    authorization: path.join(root, 'authorization.ndjson'),
    receipt: path.join(root, 'receipt.json'),
  });
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

function validateCatalog(
  selected: Readonly<DecisionPaths>,
  terminal: boolean,
): void {
  const allowed = new Set([
    'authorization.ndjson',
    'intent.json',
    'receipt.json',
    'staging',
    ...(!terminal
      ? ['.intent.json.ql3-deploy-stage', '.receipt.json.ql3-deploy-stage']
      : []),
  ]);
  for (const entry of fs.readdirSync(selected.root, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || entry.isSymbolicLink()) {
      configurationError('decision root contains unknown material');
    }
  }
  if (fs.readdirSync(selected.staging).length !== 0) {
    configurationError('decision staging must remain empty');
  }
}

function terminalJson(
  filePath: string,
  uid: number,
  allowedModes: readonly number[],
): unknown {
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      !allowedModes.includes(Number(before.mode) & 0o777) ||
      before.nlink !== 1n ||
      before.size < 2n ||
      before.size > 64n * 1024n
    ) {
      configurationError('terminal JSON identity is invalid');
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
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs
    ) {
      configurationError('terminal JSON changed while opening');
    }
    const bytes = Buffer.alloc(Number(opened.size));
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const read = fs.readSync(
          descriptor,
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (read < 1) configurationError('terminal JSON read stalled');
        offset += read;
      }
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs ||
        after.ctimeNs !== opened.ctimeNs
      ) {
        configurationError('terminal JSON drifted while reading');
      }
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('terminal JSON cannot be read', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

async function context(
  options: Readonly<
    LocalReconciliationAutomationDecisionPrepareCommand['options']
  >,
  automationId: string,
  uid: number,
): Promise<Readonly<DecisionContext>> {
  const automation = readLocalReconciliationAutomationTerminal(
    options.automationRoot,
    automationId,
    uid,
  );
  const application = await readLocalReconciliationApplicationTerminal(
    options.applicationRoot,
    automation.receipt.applicationId,
    uid,
  );
  const header = readLocalReconciliationAutomationPlanHeader(
    automation.planPath,
    automation.receipt,
    uid,
  );
  if (
    application.intent.command.options.deploymentRoot !==
      options.deploymentRoot ||
    application.intent.command.options.applicationRoot !==
      options.applicationRoot ||
    automation.receipt.applicationPlanDigest !==
      application.plan.applicationPlanDigest ||
    header.applicationPlanDigest !== application.plan.applicationPlanDigest ||
    header.profile !== application.intent.profile
  ) {
    configurationError('plan is detached from its application authority');
  }
  return Object.freeze({ automation, application, header });
}

function intentBinding(
  intent: Readonly<LocalReconciliationAutomationDecisionIntent>,
  selected: Readonly<DecisionContext>,
): void {
  if (
    intent.command.request.automationId !==
      selected.automation.receipt.automationId ||
    intent.command.request.expectedAutomationPlanDigest !==
      selected.automation.receipt.automationPlanDigest ||
    intent.applicationId !== selected.application.plan.applicationId ||
    intent.applicationPlanDigest !==
      selected.application.plan.applicationPlanDigest ||
    intent.legacyInventoryDigest !==
      selected.automation.receipt.legacyInventoryDigest ||
    intent.profile !== selected.header.profile ||
    intent.projectId !== selected.header.projectId ||
    intent.legacyTimezone !== selected.header.legacyTimezone ||
    intent.instanceId !== selected.application.intent.instanceId ||
    intent.cutoverId !== selected.application.intent.cutoverId ||
    intent.activationDigest !== selected.application.intent.activationDigest ||
    intent.generation !== selected.application.intent.generation
  ) {
    configurationError('decision intent binding drifted');
  }
}

function readIntent(
  selected: Readonly<DecisionPaths>,
  uid: number,
  allowedModes: readonly number[],
): Readonly<LocalReconciliationAutomationDecisionIntent> {
  return normalizeLocalReconciliationAutomationDecisionIntent(
    terminalJson(selected.intent, uid, allowedModes),
  );
}

function readReceipt(
  selected: Readonly<DecisionPaths>,
  uid: number,
  allowedModes: readonly number[],
): Readonly<LocalReconciliationAutomationDecisionReceipt> {
  return normalizeLocalReconciliationAutomationDecisionReceipt(
    terminalJson(selected.receipt, uid, allowedModes),
  );
}

function prepareResult(
  status: 'prepared' | 'existing',
  intent: Readonly<LocalReconciliationAutomationDecisionIntent>,
  head: Readonly<LocalCutoverInstanceHead>,
): Readonly<LocalReconciliationAutomationDecisionPrepareResult> {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.decision.prepare',
    status,
    state: 'reconciliation_automation_decision_prepared',
    decisionId: intent.command.request.decisionId,
    automationId: intent.command.request.automationId,
    preparationDigest: intent.preparationDigest,
    instanceHeadDigest: head.headDigest,
  });
}

function terminalResult(
  operation: LocalReconciliationAutomationDecisionTerminalResult['operation'],
  status: LocalReconciliationAutomationDecisionTerminalResult['status'],
  receipt: Readonly<LocalReconciliationAutomationDecisionReceipt>,
  head: Readonly<LocalCutoverInstanceHead>,
): Readonly<LocalReconciliationAutomationDecisionTerminalResult> {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    status,
    state: 'reconciliation_automation_reviewed',
    decisionId: receipt.decisionId,
    automationId: receipt.automationId,
    decisionDigest: receipt.decisionDigest,
    signedDecisionSetDigest: receipt.signedDecisionSetDigest,
    rowCount: receipt.rowCount,
    adoptedCount: receipt.adoptedCount,
    skippedCount: receipt.skippedCount,
    instanceHeadDigest: head.headDigest,
  });
}

function advanceHead(
  intent: Readonly<LocalReconciliationAutomationDecisionIntent>,
  state:
    | 'reconciliation_automation_decision_prepared'
    | 'reconciliation_automation_reviewed',
  sourceRecordDigest: string,
  requestedAtMs: number,
  uid: number,
): Readonly<LocalCutoverInstanceHead> {
  return advanceLocalCutoverInstanceHead(
    {
      options: {
        deploymentRoot: intent.command.options.deploymentRoot,
      },
      request: {
        cutoverId: intent.cutoverId,
        profile: intent.profile,
        instanceId: intent.instanceId,
        expectedActivationDigest: intent.activationDigest,
        requestedAtMs,
      },
    },
    uid,
    state,
    intent.generation,
    sourceRecordDigest,
  );
}

export async function prepareLocalReconciliationAutomationDecision(
  value: unknown,
  dependencies: LocalReconciliationAutomationDecisionDependencies = {},
): Promise<Readonly<LocalReconciliationAutomationDecisionPrepareResult>> {
  const command =
    normalizeLocalReconciliationAutomationDecisionPrepareCommand(value);
  const uid = currentIdentity().uid;
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
    [command.options.automationRoot, 'automationRoot'],
    [command.options.automationDecisionRoot, 'automationDecisionRoot'],
  ] as const) {
    validatePrivateDirectory(directory, uid, label);
  }
  const current = await context(
    command.options,
    command.request.automationId,
    uid,
  );
  if (
    current.automation.receipt.automationPlanDigest !==
    command.request.expectedAutomationPlanDigest
  ) {
    configurationError('expected automation plan digest drifted');
  }
  const intent = buildLocalReconciliationAutomationDecisionIntent({
    command,
    applicationId: current.application.plan.applicationId,
    applicationPlanDigest: current.application.plan.applicationPlanDigest,
    legacyInventoryDigest: current.automation.receipt.legacyInventoryDigest,
    profile: current.header.profile,
    projectId: current.header.projectId,
    legacyTimezone: current.header.legacyTimezone,
    instanceId: current.application.intent.instanceId,
    cutoverId: current.application.intent.cutoverId,
    activationDigest: current.application.intent.activationDigest,
    generation: current.application.intent.generation,
  });
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    uid,
  );
  intentBinding(intent, current);
  if (
    (head.state === 'reconciliation_automation_planned' &&
      (head.headDigest !== command.request.expectedHeadDigest ||
        head.sourceRecordDigest !==
          intent.command.request.expectedAutomationPlanDigest)) ||
    (head.state === 'reconciliation_automation_decision_prepared' &&
      head.sourceRecordDigest !== intent.preparationDigest) ||
    (head.state !== 'reconciliation_automation_planned' &&
      head.state !== 'reconciliation_automation_decision_prepared')
  ) {
    configurationError('decision prepare lost instance head compare-and-swap');
  }
  const selected = paths(
    command.options.automationDecisionRoot,
    command.request.automationId,
  );
  ensurePrivateDirectory(selected.root, uid, 'automationDecisionDirectory');
  ensurePrivateDirectory(selected.staging, uid, 'automationDecisionStaging');
  validateCatalog(selected, false);
  const contents =
    localReconciliationAutomationDecisionEvidenceContents(intent);
  preflightPublishedFile(
    selected.intent,
    contents,
    0o600,
    uid,
    'automation decision intent',
  );
  const next =
    head.state === 'reconciliation_automation_decision_prepared'
      ? head
      : advanceHead(
          intent,
          'reconciliation_automation_decision_prepared',
          intent.preparationDigest,
          command.request.preparedAtMs,
          uid,
        );
  dependencies.afterHeadPrepared?.();
  const status = publishExactFile(
    selected.intent,
    contents,
    0o600,
    uid,
    'automation decision intent',
  );
  validateCatalog(selected, false);
  return prepareResult(status, intent, next);
}

function validateCommitBinding(
  command: Readonly<LocalReconciliationAutomationDecisionCommitCommand>,
  intent: Readonly<LocalReconciliationAutomationDecisionIntent>,
): void {
  const prepared = intent.command;
  if (
    prepared.options.deploymentRoot !== command.options.deploymentRoot ||
    prepared.options.applicationRoot !== command.options.applicationRoot ||
    prepared.options.automationRoot !== command.options.automationRoot ||
    prepared.options.automationDecisionRoot !==
      command.options.automationDecisionRoot ||
    prepared.options.allowRootService !== command.options.allowRootService ||
    prepared.request.decisionId !== command.request.decisionId ||
    prepared.request.automationId !== command.request.automationId ||
    intent.preparationDigest !== command.request.expectedPreparationDigest
  ) {
    configurationError('commit command is detached from prepared intent');
  }
}

function strongReviewer(
  authenticated: Readonly<AuthenticatedLocalCommand>,
  original: Readonly<
    DecisionContext['application']['review']['authorization']['header']['reviewer']
  >,
  committedAtMs: number,
) {
  const principal = authenticated.principal;
  if (
    principal.subject.type !== 'user' ||
    principal.subject.type !== original.subject.type ||
    principal.subject.id !== original.subject.id ||
    !['hardware', 'local_console', 'multi_factor'].includes(
      principal.assurance,
    ) ||
    principal.authenticatedAtMs > committedAtMs ||
    committedAtMs - principal.authenticatedAtMs > MAX_AUTHENTICATION_AGE_MS ||
    principal.expiresAtMs <= committedAtMs
  ) {
    configurationError(
      'decision commit requires the same recently strong authenticated User',
    );
  }
  return principal;
}

function planTerminal(selected: Readonly<DecisionContext>) {
  return readLocalReconciliationPlanTerminal(
    selected.application.intent.command.options.planRoot,
    selected.application.review.intent.command.request.planId,
    currentIdentity().uid,
  );
}

function buildReceipt(
  intent: Readonly<LocalReconciliationAutomationDecisionIntent>,
  preparedHeadDigest: string,
  publication: Readonly<ReconciliationAutomationDecisionPublication>,
): Readonly<LocalReconciliationAutomationDecisionReceipt> {
  const signed = publication.authorization.receipt;
  const adoptedCount =
    signed.decisions.dispositions.adopt +
    signed.decisions.dispositions.adopt_shell_compatibility;
  return buildLocalReconciliationAutomationDecisionReceipt({
    decisionId: signed.decisionId,
    automationId: intent.command.request.automationId,
    automationPlanDigest: signed.planDigest,
    legacyInventoryDigest: signed.inventoryDigest,
    preparedHeadDigest,
    authorizationFileDigest: publication.authorization.file.fileDigest,
    signedReceiptDigest: signed.receiptDigest,
    signedDecisionSetDigest: signed.decisions.decisionDigest,
    reviewFileDigest: publication.reviewFileDigest,
    reviewerDigest: cutoverDigest({
      subject: signed.reviewer.subject,
      authenticationId: signed.reviewer.authenticationId,
      authenticatedAtMs: signed.reviewer.authenticatedAtMs,
      assurance: signed.reviewer.assurance,
    }),
    rowCount: signed.decisions.rowCount,
    adoptedCount,
    skippedCount: signed.decisions.dispositions.skip,
    issuedAtMs: signed.issuedAtMs,
    expiresAtMs: signed.expiresAtMs,
  });
}

function validateReceiptBinding(
  receipt: Readonly<LocalReconciliationAutomationDecisionReceipt>,
  intent: Readonly<LocalReconciliationAutomationDecisionIntent>,
  publication: Readonly<ReconciliationAutomationDecisionPublication>,
): void {
  const expected = buildReceipt(
    intent,
    receipt.preparedHeadDigest,
    publication,
  );
  if (expected.decisionDigest !== receipt.decisionDigest) {
    configurationError('terminal receipt is detached from authorization');
  }
}

async function authorization(
  command: Readonly<LocalReconciliationAutomationDecisionCommitCommand>,
  intent: Readonly<LocalReconciliationAutomationDecisionIntent>,
  selectedPaths: Readonly<DecisionPaths>,
  selected: Readonly<DecisionContext>,
  dependencies: LocalReconciliationAutomationDecisionDependencies,
  uid: number,
): Promise<Readonly<ReconciliationAutomationDecisionPublication>> {
  const terminal = planTerminal(selected);
  const capture = readLocalReconciliationCaptureIntent(
    selected.application.intent.command.options.captureRoot,
    terminal.plan.captureId,
  );
  if (
    capture.command.request.targetDatabasePath !==
    command.options.targetDatabasePath
  ) {
    configurationError('authentication database is detached from capture');
  }
  const openRequirements =
    createLocalReconciliationAutomationRequirementFactory(
      selected.automation.planPath,
      selected.automation.receipt,
      uid,
    );
  const keyringPath =
    selected.application.intent.command.options.issuerKeyringPath;
  ensureLocalReconciliationReviewIssuerKeyring(keyringPath);
  const keyProvider = new LocalReconciliationReviewIssuerKeyringFileProvider(
    keyringPath,
  );
  const publication = await withLocalReconciliationSealedDatabaseAsync(
    terminal.bundle,
    'legacy',
    uid,
    dependencies,
    async (sourceClient) => {
      const common = {
        authorizationPath: selectedPaths.authorization,
        decisionId: command.request.decisionId,
        profile: intent.profile,
        automationPlanDigest:
          intent.command.request.expectedAutomationPlanDigest,
        inventoryDigest: intent.legacyInventoryDigest,
        sourceClient,
        timezone: intent.legacyTimezone,
        keyProvider,
        observedAtMs: command.request.committedAtMs,
        openRequirements,
        allowedModes: [0o600, 0o400] as const,
        allowedParentModes: [0o700] as const,
      };
      if (fs.existsSync(selectedPaths.authorization)) {
        return recoverReconciliationAutomationDecision({
          ...common,
          reviewFilePath: command.request.decisionFilePath,
        });
      }
      const now = (dependencies.now ?? Date.now)();
      if (
        !Number.isSafeInteger(now) ||
        Math.abs(now - command.request.committedAtMs) > COMMIT_CLOCK_SKEW_MS
      ) {
        configurationError('commit timestamp is outside its clock window');
      }
      const openDatabase =
        dependencies.openAuthenticationDatabase ??
        openLocalSqliteAuthenticationReadDatabase;
      const database: AuthenticationDatabase = await openDatabase({
        databasePath: command.options.targetDatabasePath,
        profile: intent.profile,
        ...(command.options.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: command.options.busyTimeoutMs }),
      });
      try {
        const authenticate =
          dependencies.authenticate ?? establishAuthenticatedLocalCommand;
        const authenticated = await authenticate(database, {
          deploymentRoot: command.options.deploymentRoot,
          databasePath: command.options.targetDatabasePath,
          ownerPepperKeyringDirectory:
            command.options.ownerPepperKeyringDirectory,
          credentialFilePath: command.options.credentialFilePath,
          authenticationNamespace: 'local_reconciliation_automation',
          now: () => command.request.committedAtMs,
        });
        const reviewer = strongReviewer(
          authenticated,
          selected.application.review.authorization.header.reviewer,
          command.request.committedAtMs,
        );
        return await issueReconciliationAutomationDecision({
          ...common,
          reviewFilePath: command.request.decisionFilePath,
          reviewer,
          issuedAtMs: command.request.committedAtMs,
          expiresAtMs:
            command.request.committedAtMs +
            command.request.authorizationLifetimeMs,
          async confirmExternalAuthority() {
            const head = readLocalCutoverInstanceHead(
              command.options.deploymentRoot,
              intent.instanceId,
              uid,
            );
            if (
              head.state !== 'reconciliation_automation_decision_prepared' ||
              head.headDigest !== command.request.expectedHeadDigest ||
              head.sourceRecordDigest !== intent.preparationDigest
            ) {
              configurationError('decision authority lost prepared head');
            }
            await authenticated.confirm();
          },
        });
      } finally {
        await database.close();
      }
    },
  );
  if (publication === null) {
    return configurationError('legacy database requires manual handling');
  }
  return publication;
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
  const mode = validateDirectory(directory, uid, [0o700, 0o500], 'directory');
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    if (mode !== 0o500) fs.fchmodSync(descriptor, 0o500);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sealTerminal(selected: Readonly<DecisionPaths>, uid: number): void {
  sealFile(selected.intent, uid);
  sealFile(selected.authorization, uid);
  sealFile(selected.receipt, uid);
  sealDirectory(selected.staging, uid);
  sealDirectory(selected.root, uid);
  validateCatalog(selected, true);
}

async function verifyPublication(
  selectedPaths: Readonly<DecisionPaths>,
  intent: Readonly<LocalReconciliationAutomationDecisionIntent>,
  selected: Readonly<DecisionContext>,
  receipt: Readonly<LocalReconciliationAutomationDecisionReceipt>,
  dependencies: LocalReconciliationAutomationDecisionDependencies,
  uid: number,
  allowedModes: readonly (0o400 | 0o600)[],
  allowedParentModes: readonly (0o500 | 0o700)[],
): Promise<Readonly<ReconciliationAutomationDecisionPublication>> {
  const terminal = planTerminal(selected);
  const openRequirements =
    createLocalReconciliationAutomationRequirementFactory(
      selected.automation.planPath,
      selected.automation.receipt,
      uid,
    );
  const keyProvider = new LocalReconciliationReviewIssuerKeyringFileProvider(
    selected.application.intent.command.options.issuerKeyringPath,
  );
  const publication = await withLocalReconciliationSealedDatabaseAsync(
    terminal.bundle,
    'legacy',
    uid,
    dependencies,
    async (sourceClient) => {
      const authorization = await verifyReconciliationAutomationDecision({
        authorizationPath: selectedPaths.authorization,
        decisionId: receipt.decisionId,
        profile: intent.profile,
        automationPlanDigest: receipt.automationPlanDigest,
        inventoryDigest: receipt.legacyInventoryDigest,
        sourceClient,
        timezone: intent.legacyTimezone,
        keyProvider,
        observedAtMs: receipt.issuedAtMs,
        openRequirements,
        allowedModes,
        allowedParentModes,
      });
      return Object.freeze({
        authorization,
        reviewFileDigest: receipt.reviewFileDigest,
      });
    },
  );
  if (publication === null) {
    return configurationError('legacy database requires manual handling');
  }
  return publication;
}

export async function commitLocalReconciliationAutomationDecision(
  value: unknown,
  dependencies: LocalReconciliationAutomationDecisionDependencies = {},
): Promise<Readonly<LocalReconciliationAutomationDecisionTerminalResult>> {
  const command =
    normalizeLocalReconciliationAutomationDecisionCommitCommand(value);
  const uid = currentIdentity().uid;
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
    [command.options.automationRoot, 'automationRoot'],
    [command.options.automationDecisionRoot, 'automationDecisionRoot'],
  ] as const) {
    validatePrivateDirectory(directory, uid, label);
  }
  const selectedPaths = paths(
    command.options.automationDecisionRoot,
    command.request.automationId,
  );
  validateDirectory(selectedPaths.root, uid, [0o700, 0o500], 'decision root');
  validateDirectory(
    selectedPaths.staging,
    uid,
    [0o700, 0o500],
    'decision staging',
  );
  const intent = readIntent(selectedPaths, uid, [0o600, 0o400]);
  validateCommitBinding(command, intent);
  const selected = await context(
    intent.command.options,
    intent.command.request.automationId,
    uid,
  );
  intentBinding(intent, selected);
  let head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    uid,
  );
  if (fs.existsSync(selectedPaths.receipt)) {
    validateCatalog(selectedPaths, false);
    const receipt = readReceipt(selectedPaths, uid, [0o600, 0o400]);
    if (
      receipt.decisionId !== command.request.decisionId ||
      receipt.automationId !== command.request.automationId ||
      receipt.preparedHeadDigest !== command.request.expectedHeadDigest ||
      receipt.issuedAtMs !== command.request.committedAtMs ||
      receipt.expiresAtMs !==
        command.request.committedAtMs + command.request.authorizationLifetimeMs
    ) {
      configurationError('terminal receipt is not an exact command replay');
    }
    const publication = await verifyPublication(
      selectedPaths,
      intent,
      selected,
      receipt,
      dependencies,
      uid,
      [0o600, 0o400],
      [0o700, 0o500],
    );
    validateReceiptBinding(receipt, intent, publication);
    const existing = head.state === 'reconciliation_automation_reviewed';
    if (
      (!existing &&
        (head.state !== 'reconciliation_automation_decision_prepared' ||
          head.sourceRecordDigest !== intent.preparationDigest)) ||
      (existing && head.sourceRecordDigest !== receipt.decisionDigest)
    ) {
      configurationError('terminal receipt lost instance head binding');
    }
    sealTerminal(selectedPaths, uid);
    dependencies.afterTerminalSealed?.();
    head = existing
      ? head
      : advanceHead(
          intent,
          'reconciliation_automation_reviewed',
          receipt.decisionDigest,
          receipt.issuedAtMs,
          uid,
        );
    dependencies.afterHeadAdvanced?.();
    return terminalResult(
      command.operation,
      existing ? 'existing' : 'prepared',
      receipt,
      head,
    );
  }
  if (
    head.state !== 'reconciliation_automation_decision_prepared' ||
    head.headDigest !== command.request.expectedHeadDigest ||
    head.sourceRecordDigest !== intent.preparationDigest
  ) {
    configurationError('decision commit lost prepared head compare-and-swap');
  }
  validateCatalog(selectedPaths, false);
  const publication = await authorization(
    command,
    intent,
    selectedPaths,
    selected,
    dependencies,
    uid,
  );
  dependencies.afterAuthorizationPublished?.();
  const receipt = buildReceipt(
    intent,
    command.request.expectedHeadDigest,
    publication,
  );
  publishExactFile(
    selectedPaths.receipt,
    localReconciliationAutomationDecisionEvidenceContents(receipt),
    0o600,
    uid,
    'automation decision receipt',
  );
  dependencies.afterReceiptPublished?.();
  validateReceiptBinding(receipt, intent, publication);
  sealTerminal(selectedPaths, uid);
  dependencies.afterTerminalSealed?.();
  head = advanceHead(
    intent,
    'reconciliation_automation_reviewed',
    receipt.decisionDigest,
    receipt.issuedAtMs,
    uid,
  );
  dependencies.afterHeadAdvanced?.();
  return terminalResult(command.operation, 'prepared', receipt, head);
}

export async function verifyLocalReconciliationAutomationDecision(
  value: unknown,
  dependencies: LocalReconciliationAutomationDecisionDependencies = {},
): Promise<Readonly<LocalReconciliationAutomationDecisionTerminalResult>> {
  const command =
    normalizeLocalReconciliationAutomationDecisionVerifyCommand(value);
  const uid = currentIdentity().uid;
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
    [command.options.automationRoot, 'automationRoot'],
    [command.options.automationDecisionRoot, 'automationDecisionRoot'],
  ] as const) {
    validatePrivateDirectory(directory, uid, label);
  }
  const selectedPaths = paths(
    command.options.automationDecisionRoot,
    command.request.automationId,
  );
  validateDirectory(selectedPaths.root, uid, [0o500], 'decision root');
  validateDirectory(selectedPaths.staging, uid, [0o500], 'decision staging');
  validateCatalog(selectedPaths, true);
  const intent = readIntent(selectedPaths, uid, [0o400]);
  const receipt = readReceipt(selectedPaths, uid, [0o400]);
  if (
    intent.command.request.decisionId !== command.request.decisionId ||
    receipt.decisionId !== command.request.decisionId ||
    receipt.automationId !== command.request.automationId ||
    receipt.decisionDigest !== command.request.expectedDecisionDigest
  ) {
    configurationError('verify command is detached from terminal decision');
  }
  const selected = await context(
    intent.command.options,
    intent.command.request.automationId,
    uid,
  );
  intentBinding(intent, selected);
  const publication = await verifyPublication(
    selectedPaths,
    intent,
    selected,
    receipt,
    dependencies,
    uid,
    [0o400],
    [0o500],
  );
  validateReceiptBinding(receipt, intent, publication);
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    uid,
  );
  if (
    head.state !== 'reconciliation_automation_reviewed' ||
    head.sourceRecordDigest !== receipt.decisionDigest
  ) {
    configurationError('terminal decision is detached from instance head');
  }
  return terminalResult(command.operation, 'verified', receipt, head);
}

export async function readLocalReconciliationAutomationDecisionTerminal(
  options: Readonly<
    LocalReconciliationAutomationDecisionPrepareCommand['options']
  >,
  automationId: string,
  uid: number,
  dependencies: LocalReconciliationAutomationDecisionDependencies = {},
): Promise<Readonly<LocalReconciliationAutomationDecisionTerminal>> {
  for (const [directory, label] of [
    [options.deploymentRoot, 'deploymentRoot'],
    [options.applicationRoot, 'applicationRoot'],
    [options.automationRoot, 'automationRoot'],
    [options.automationDecisionRoot, 'automationDecisionRoot'],
  ] as const) {
    validatePrivateDirectory(directory, uid, label);
  }
  const selectedPaths = paths(options.automationDecisionRoot, automationId);
  validateDirectory(selectedPaths.root, uid, [0o500], 'decision root');
  validateDirectory(selectedPaths.staging, uid, [0o500], 'decision staging');
  validateCatalog(selectedPaths, true);
  const intent = readIntent(selectedPaths, uid, [0o400]);
  const receipt = readReceipt(selectedPaths, uid, [0o400]);
  if (
    intent.command.request.automationId !== automationId ||
    receipt.automationId !== automationId ||
    receipt.decisionId !== intent.command.request.decisionId
  ) {
    configurationError('terminal decision identity drifted');
  }
  const selected = await context(options, automationId, uid);
  intentBinding(intent, selected);
  const publication = await verifyPublication(
    selectedPaths,
    intent,
    selected,
    receipt,
    dependencies,
    uid,
    [0o400],
    [0o500],
  );
  validateReceiptBinding(receipt, intent, publication);
  return Object.freeze({
    intent,
    receipt,
    authorizationPath: selectedPaths.authorization,
    context: selected,
    plan: planTerminal(selected),
    reviewer: publication.authorization.receipt.reviewer,
  });
}

export function prepareLocalReconciliationAutomationDecisionCommandFile(
  filePath: string,
  dependencies: LocalReconciliationAutomationDecisionDependencies = {},
) {
  return prepareLocalReconciliationAutomationDecision(
    readPrivateLocalCommandFile(filePath),
    dependencies,
  );
}

export function commitLocalReconciliationAutomationDecisionCommandFile(
  filePath: string,
  dependencies: LocalReconciliationAutomationDecisionDependencies = {},
) {
  return commitLocalReconciliationAutomationDecision(
    readPrivateLocalCommandFile(filePath),
    dependencies,
  );
}

export function verifyLocalReconciliationAutomationDecisionCommandFile(
  filePath: string,
) {
  return verifyLocalReconciliationAutomationDecision(
    readPrivateLocalCommandFile(filePath),
  );
}
