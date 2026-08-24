import fs from 'node:fs';
import path from 'node:path';

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
  ensureLocalReconciliationReviewIssuerKeyring,
  LocalReconciliationReviewIssuerKeyringFileProvider,
} from '../../review/issuerKeyring';
import {
  readLocalReconciliationApplicationTerminal,
  type LocalReconciliationApplicationTerminal,
} from '../coordinator';
import {
  buildLocalReconciliationSecretConfigAuthorizationHeader,
  publishLocalReconciliationSecretConfigAuthorization,
  verifyLocalReconciliationSecretConfigAuthorization,
  type LocalReconciliationSecretConfigAuthorizationScope,
} from './decisionAuthorization';
import {
  normalizeLocalReconciliationSecretConfigDecisionCommitCommand,
  normalizeLocalReconciliationSecretConfigDecisionPrepareCommand,
  normalizeLocalReconciliationSecretConfigDecisionVerifyCommand,
  type LocalReconciliationSecretConfigDecisionCommitCommand,
  type LocalReconciliationSecretConfigDecisionPrepareCommand,
  type LocalReconciliationSecretConfigDecisionPrepareResult,
  type LocalReconciliationSecretConfigDecisionTerminalResult,
} from './decisionContract';
import {
  buildLocalReconciliationSecretConfigDecisionIntent,
  buildLocalReconciliationSecretConfigDecisionReceipt,
  localReconciliationSecretConfigDecisionEvidenceContents,
  normalizeLocalReconciliationSecretConfigDecisionIntent,
  normalizeLocalReconciliationSecretConfigDecisionReceipt,
  type LocalReconciliationSecretConfigDecisionIntent,
  type LocalReconciliationSecretConfigDecisionReceipt,
} from './decisionEvidence';
import {
  assertLocalReconciliationSecretConfigDecisionMatchesRequirement,
  MAX_EDGE_LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_BYTES,
  MAX_STANDALONE_LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_BYTES,
  withLocalReconciliationSecretConfigDecisionFile,
  type LocalReconciliationSecretConfigDecision,
} from './decisionFile';
import {
  createLocalReconciliationSecretConfigDecisionRequirementFactory,
  readLocalReconciliationSecretConfigPlanHeader,
  type LocalReconciliationSecretConfigDecisionRequirement,
} from './planReader';
import type { LocalReconciliationSecretConfigPlanHeader } from './rowPlan';
import {
  readLocalReconciliationSecretConfigTerminal,
  type LocalReconciliationSecretConfigTerminal,
} from './coordinator';

const MAX_AUTHENTICATION_AGE_MS = 5 * 60 * 1_000;
const COMMIT_CLOCK_SKEW_MS = 60_000;
const MAX_TERMINAL_JSON_BYTES = 64 * 1024;

interface DecisionPaths {
  readonly root: string;
  readonly staging: string;
  readonly intent: string;
  readonly authorization: string;
  readonly authorizationStage: string;
  readonly receipt: string;
}

interface DecisionContext {
  readonly secretConfig: Readonly<LocalReconciliationSecretConfigTerminal>;
  readonly planHeader: Readonly<LocalReconciliationSecretConfigPlanHeader>;
  readonly application: Readonly<LocalReconciliationApplicationTerminal>;
  readonly planTerminal: ReturnType<typeof readLocalReconciliationPlanTerminal>;
}

type AuthenticationDatabase = Awaited<
  ReturnType<typeof openLocalSqliteAuthenticationReadDatabase>
>;

export interface LocalReconciliationSecretConfigDecisionDependencies {
  readonly openAuthenticationDatabase?: typeof openLocalSqliteAuthenticationReadDatabase;
  readonly authenticate?: typeof establishAuthenticatedLocalCommand;
  readonly now?: () => number;
  readonly afterHeadPrepared?: () => void;
  readonly afterAuthorizationPublished?: () => void;
  readonly afterReceiptPublished?: () => void;
  readonly afterTerminalSealed?: () => void;
  readonly afterHeadAdvanced?: () => void;
}

export interface LocalReconciliationSecretConfigDecisionTerminal {
  readonly intent: Readonly<LocalReconciliationSecretConfigDecisionIntent>;
  readonly receipt: Readonly<LocalReconciliationSecretConfigDecisionReceipt>;
  readonly authorization: Readonly<LocalReconciliationSecretConfigAuthorizationScope>;
  readonly context: Readonly<DecisionContext>;
  readonly reviewer: Readonly<SecurityPrincipal>;
  readonly head: Readonly<LocalCutoverInstanceHead>;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation secret config decision ${message}`,
    { cause },
  );
}

function paths(
  decisionRoot: string,
  secretConfigId: string,
): Readonly<DecisionPaths> {
  const root = path.join(decisionRoot, secretConfigId);
  const staging = path.join(root, 'staging');
  return Object.freeze({
    root,
    staging,
    intent: path.join(root, 'intent.json'),
    authorization: path.join(root, 'authorization.ndjson'),
    authorizationStage: path.join(staging, 'authorization.ndjson.stage'),
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
  const stagingEntries = fs.readdirSync(selected.staging);
  if (
    terminal
      ? stagingEntries.length !== 0
      : stagingEntries.some((entry) => entry !== 'authorization.ndjson.stage')
  ) {
    configurationError('decision staging contains unknown material');
  }
}

function terminalJson(
  filePath: string,
  uid: number,
  allowedModes: readonly number[],
): unknown {
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
      before.size > BigInt(MAX_TERMINAL_JSON_BYTES)
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
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      configurationError('terminal JSON changed while reading');
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('terminal JSON cannot be read', error);
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readIntent(
  selected: Readonly<DecisionPaths>,
  uid: number,
  allowedModes: readonly number[],
): Readonly<LocalReconciliationSecretConfigDecisionIntent> {
  return normalizeLocalReconciliationSecretConfigDecisionIntent(
    terminalJson(selected.intent, uid, allowedModes),
  );
}

function readReceipt(
  selected: Readonly<DecisionPaths>,
  uid: number,
  allowedModes: readonly number[],
): Readonly<LocalReconciliationSecretConfigDecisionReceipt> {
  return normalizeLocalReconciliationSecretConfigDecisionReceipt(
    terminalJson(selected.receipt, uid, allowedModes),
  );
}

async function context(
  options: Readonly<
    LocalReconciliationSecretConfigDecisionPrepareCommand['options']
  >,
  secretConfigId: string,
  uid: number,
): Promise<Readonly<DecisionContext>> {
  const secretConfig = readLocalReconciliationSecretConfigTerminal(
    options.secretConfigRoot,
    secretConfigId,
    uid,
  );
  const application = await readLocalReconciliationApplicationTerminal(
    options.applicationRoot,
    secretConfig.receipt.applicationId,
    uid,
  );
  const planTerminal = readLocalReconciliationPlanTerminal(
    application.intent.command.options.planRoot,
    application.review.intent.command.request.planId,
    uid,
  );
  const planHeader = readLocalReconciliationSecretConfigPlanHeader(
    secretConfig.planPath,
    secretConfig.receipt,
    uid,
  );
  if (
    application.intent.command.options.deploymentRoot !==
      options.deploymentRoot ||
    application.intent.command.options.applicationRoot !==
      options.applicationRoot ||
    secretConfig.receipt.applicationPlanDigest !==
      application.plan.applicationPlanDigest ||
    planTerminal.plan.planDigest !==
      application.review.intent.command.request.expectedPlanDigest
  ) {
    configurationError('plan is detached from application authority');
  }
  return Object.freeze({ secretConfig, planHeader, application, planTerminal });
}

function intentBinding(
  intent: Readonly<LocalReconciliationSecretConfigDecisionIntent>,
  selected: Readonly<DecisionContext>,
): void {
  const plan = selected.secretConfig.receipt;
  if (
    intent.command.request.secretConfigId !== plan.secretConfigId ||
    intent.command.request.expectedSecretConfigPlanDigest !==
      plan.secretConfigPlanDigest ||
    intent.applicationId !== selected.application.plan.applicationId ||
    intent.applicationPlanDigest !==
      selected.application.plan.applicationPlanDigest ||
    intent.profile !== selected.application.intent.profile ||
    intent.projectId !== selected.planHeader.projectId ||
    intent.secretConfigPlanDigest !== plan.secretConfigPlanDigest ||
    intent.candidateSetDigest !== plan.candidateSetDigest ||
    intent.bundleDigest !== selected.planTerminal.bundle.receipt.bundleDigest ||
    intent.bundleFingerprintDigest !==
      selected.planTerminal.bundle.fingerprintDigest ||
    intent.instanceId !== selected.application.intent.instanceId ||
    intent.cutoverId !== selected.application.intent.cutoverId ||
    intent.activationDigest !== selected.application.intent.activationDigest ||
    intent.generation !== selected.application.intent.generation
  ) {
    configurationError('decision intent binding drifted');
  }
}

function prepareResult(
  status: 'prepared' | 'existing',
  intent: Readonly<LocalReconciliationSecretConfigDecisionIntent>,
  head: Readonly<LocalCutoverInstanceHead>,
): Readonly<LocalReconciliationSecretConfigDecisionPrepareResult> {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.decision.prepare',
    status,
    state: 'reconciliation_secret_config_decision_prepared',
    decisionId: intent.command.request.decisionId,
    secretConfigId: intent.command.request.secretConfigId,
    preparationDigest: intent.preparationDigest,
    instanceHeadDigest: head.headDigest,
  });
}

function terminalResult(
  operation: LocalReconciliationSecretConfigDecisionTerminalResult['operation'],
  status: LocalReconciliationSecretConfigDecisionTerminalResult['status'],
  receipt: Readonly<LocalReconciliationSecretConfigDecisionReceipt>,
  head: Readonly<LocalCutoverInstanceHead>,
): Readonly<LocalReconciliationSecretConfigDecisionTerminalResult> {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    status,
    state: 'reconciliation_secret_config_reviewed',
    decisionId: receipt.decisionId,
    secretConfigId: receipt.secretConfigId,
    decisionDigest: receipt.decisionDigest,
    signedDecisionSetDigest: receipt.signedDecisionSetDigest,
    candidateCount: receipt.candidateCount,
    applyBindingCount: receipt.applyBindingCount,
    preserveDisabledCount: receipt.preserveDisabledCount,
    skippedCount: receipt.skippedCount,
    outcome: receipt.outcome,
    instanceHeadDigest: head.headDigest,
  });
}

function advanceHead(
  intent: Readonly<LocalReconciliationSecretConfigDecisionIntent>,
  state:
    | 'reconciliation_secret_config_decision_prepared'
    | 'reconciliation_secret_config_reviewed',
  sourceRecordDigest: string,
  requestedAtMs: number,
  uid: number,
): Readonly<LocalCutoverInstanceHead> {
  return advanceLocalCutoverInstanceHead(
    {
      options: { deploymentRoot: intent.command.options.deploymentRoot },
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

export async function prepareLocalReconciliationSecretConfigDecision(
  value: unknown,
  dependencies: LocalReconciliationSecretConfigDecisionDependencies = {},
): Promise<Readonly<LocalReconciliationSecretConfigDecisionPrepareResult>> {
  const command =
    normalizeLocalReconciliationSecretConfigDecisionPrepareCommand(value);
  const uid = currentIdentity().uid;
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
    [command.options.secretConfigRoot, 'secretConfigRoot'],
    [command.options.secretConfigDecisionRoot, 'secretConfigDecisionRoot'],
  ] as const) {
    validatePrivateDirectory(directory, uid, label);
  }
  const selectedContext = await context(
    command.options,
    command.request.secretConfigId,
    uid,
  );
  const plan = selectedContext.secretConfig.receipt;
  if (
    plan.secretConfigPlanDigest !==
      command.request.expectedSecretConfigPlanDigest ||
    plan.outcome !== 'ready' ||
    plan.eligibleBindingCount + plan.eligiblePreservationCount < 1 ||
    plan.targetConflictCount !== 0 ||
    plan.manualRowCount !== 0 ||
    plan.manualGroupCount !== 0 ||
    plan.unadaptedLegacyConfigCount !== 0
  ) {
    configurationError('only a ready non-empty plan can be reviewed');
  }
  const intent = buildLocalReconciliationSecretConfigDecisionIntent({
    command,
    applicationId: selectedContext.application.plan.applicationId,
    applicationPlanDigest:
      selectedContext.application.plan.applicationPlanDigest,
    profile: selectedContext.application.intent.profile,
    projectId: selectedContext.planHeader.projectId,
    secretConfigPlanDigest: plan.secretConfigPlanDigest,
    candidateSetDigest: plan.candidateSetDigest,
    bundleDigest: selectedContext.planTerminal.bundle.receipt.bundleDigest,
    bundleFingerprintDigest:
      selectedContext.planTerminal.bundle.fingerprintDigest,
    instanceId: selectedContext.application.intent.instanceId,
    cutoverId: selectedContext.application.intent.cutoverId,
    activationDigest: selectedContext.application.intent.activationDigest,
    generation: selectedContext.application.intent.generation,
  });
  intentBinding(intent, selectedContext);
  let head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    uid,
  );
  if (
    (head.state === 'reconciliation_secret_config_planned' &&
      (head.headDigest !== command.request.expectedHeadDigest ||
        head.sourceRecordDigest !== plan.secretConfigPlanDigest)) ||
    (head.state === 'reconciliation_secret_config_decision_prepared' &&
      head.sourceRecordDigest !== intent.preparationDigest) ||
    (head.state !== 'reconciliation_secret_config_planned' &&
      head.state !== 'reconciliation_secret_config_decision_prepared')
  ) {
    configurationError('decision prepare lost instance head compare-and-swap');
  }
  const selectedPaths = paths(
    command.options.secretConfigDecisionRoot,
    command.request.secretConfigId,
  );
  ensurePrivateDirectory(
    selectedPaths.root,
    uid,
    'secretConfigDecisionDirectory',
  );
  ensurePrivateDirectory(
    selectedPaths.staging,
    uid,
    'secretConfigDecisionStaging',
  );
  validateCatalog(selectedPaths, false);
  const contents =
    localReconciliationSecretConfigDecisionEvidenceContents(intent);
  preflightPublishedFile(
    selectedPaths.intent,
    contents,
    0o600,
    uid,
    'Secret/Config decision intent',
  );
  head =
    head.state === 'reconciliation_secret_config_decision_prepared'
      ? head
      : advanceHead(
          intent,
          'reconciliation_secret_config_decision_prepared',
          intent.preparationDigest,
          command.request.preparedAtMs,
          uid,
        );
  dependencies.afterHeadPrepared?.();
  const status = publishExactFile(
    selectedPaths.intent,
    contents,
    0o600,
    uid,
    'Secret/Config decision intent',
  );
  validateCatalog(selectedPaths, false);
  return prepareResult(status, intent, head);
}

function validateCommitBinding(
  command: Readonly<LocalReconciliationSecretConfigDecisionCommitCommand>,
  intent: Readonly<LocalReconciliationSecretConfigDecisionIntent>,
): void {
  const prepared = intent.command;
  if (
    prepared.options.deploymentRoot !== command.options.deploymentRoot ||
    prepared.options.applicationRoot !== command.options.applicationRoot ||
    prepared.options.secretConfigRoot !== command.options.secretConfigRoot ||
    prepared.options.secretConfigDecisionRoot !==
      command.options.secretConfigDecisionRoot ||
    prepared.options.allowRootService !== command.options.allowRootService ||
    prepared.request.decisionId !== command.request.decisionId ||
    prepared.request.secretConfigId !== command.request.secretConfigId ||
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
): Readonly<SecurityPrincipal> {
  const principal = authenticated.principal;
  if (
    principal.subject.type !== 'user' ||
    original.subject.type !== 'user' ||
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

function requirementFactory(
  selected: Readonly<DecisionContext>,
  uid: number,
): () => Iterable<LocalReconciliationSecretConfigDecisionRequirement> {
  return createLocalReconciliationSecretConfigDecisionRequirementFactory(
    selected.secretConfig.planPath,
    selected.secretConfig.receipt,
    uid,
  );
}

function bindDecisions(
  decisions: readonly Readonly<LocalReconciliationSecretConfigDecision>[],
  openRequirements: () => Iterable<LocalReconciliationSecretConfigDecisionRequirement>,
): void {
  const requirements = openRequirements()[Symbol.iterator]();
  let index = 0;
  try {
    for (; index < decisions.length; index += 1) {
      const next = requirements.next();
      if (next.done)
        configurationError('decision set contains an extra candidate');
      assertLocalReconciliationSecretConfigDecisionMatchesRequirement(
        decisions[index]!,
        next.value,
      );
    }
    if (!requirements.next().done) {
      configurationError('decision set is missing a candidate');
    }
  } finally {
    requirements.return?.();
  }
}

function authorizationMaxBytes(profile: 'edge' | 'standalone'): number {
  return profile === 'edge'
    ? MAX_EDGE_LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_BYTES
    : MAX_STANDALONE_LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_BYTES;
}

function expectedAuthorization(
  intent: Readonly<LocalReconciliationSecretConfigDecisionIntent>,
  decisionFileDigest: string,
  preparedHeadDigest: string,
) {
  return Object.freeze({
    decisionId: intent.command.request.decisionId,
    secretConfigId: intent.command.request.secretConfigId,
    profile: intent.profile,
    secretConfigPlanDigest: intent.secretConfigPlanDigest,
    candidateSetDigest: intent.candidateSetDigest,
    applicationPlanDigest: intent.applicationPlanDigest,
    preparationDigest: intent.preparationDigest,
    preparedHeadDigest,
    bundleDigest: intent.bundleDigest,
    bundleFingerprintDigest: intent.bundleFingerprintDigest,
    decisionFileDigest,
  });
}

async function verifyAuthorization(
  selectedPaths: Readonly<DecisionPaths>,
  intent: Readonly<LocalReconciliationSecretConfigDecisionIntent>,
  selected: Readonly<DecisionContext>,
  decisionFileDigest: string,
  preparedHeadDigest: string,
  uid: number,
  allowedModes: readonly number[],
): Promise<Readonly<LocalReconciliationSecretConfigAuthorizationScope>> {
  const keyProvider = new LocalReconciliationReviewIssuerKeyringFileProvider(
    selected.application.intent.command.options.issuerKeyringPath,
  );
  const scope = await verifyLocalReconciliationSecretConfigAuthorization(
    selectedPaths.authorization,
    {
      maxBytes: authorizationMaxBytes(intent.profile),
      allowedModes,
      keyProvider,
      expected: expectedAuthorization(
        intent,
        decisionFileDigest,
        preparedHeadDigest,
      ),
    },
  );
  bindDecisions(scope.decisions, requirementFactory(selected, uid));
  return scope;
}

async function authorization(
  command: Readonly<LocalReconciliationSecretConfigDecisionCommitCommand>,
  intent: Readonly<LocalReconciliationSecretConfigDecisionIntent>,
  selectedPaths: Readonly<DecisionPaths>,
  selected: Readonly<DecisionContext>,
  dependencies: LocalReconciliationSecretConfigDecisionDependencies,
  uid: number,
): Promise<Readonly<LocalReconciliationSecretConfigAuthorizationScope>> {
  const capture = readLocalReconciliationCaptureIntent(
    selected.application.intent.command.options.captureRoot,
    selected.planTerminal.plan.captureId,
  );
  if (
    capture.command.request.targetDatabasePath !==
    command.options.targetDatabasePath
  ) {
    configurationError('authentication database is detached from capture');
  }
  const openRequirements = requirementFactory(selected, uid);
  const decisionFile = withLocalReconciliationSecretConfigDecisionFile(
    command.request.decisionFilePath,
    {
      decisionId: command.request.decisionId,
      profile: intent.profile,
      secretConfigPlanDigest: intent.secretConfigPlanDigest,
      preparationDigest: intent.preparationDigest,
    },
    (cursor) => {
      const requirements = openRequirements()[Symbol.iterator]();
      const decisions: Readonly<LocalReconciliationSecretConfigDecision>[] = [];
      try {
        for (;;) {
          const selectedDecision = cursor.next();
          const selectedRequirement = requirements.next();
          if (!selectedDecision || selectedRequirement.done) {
            if ((selectedDecision === null) !== selectedRequirement.done) {
              configurationError('decision and candidate counts differ');
            }
            return Object.freeze(decisions);
          }
          assertLocalReconciliationSecretConfigDecisionMatchesRequirement(
            selectedDecision,
            selectedRequirement.value,
          );
          decisions.push(selectedDecision);
        }
      } finally {
        requirements.return?.();
      }
    },
  );
  if (decisionFile.result.length < 1) {
    configurationError('decision file must contain at least one candidate');
  }
  const keyringPath =
    selected.application.intent.command.options.issuerKeyringPath;
  ensureLocalReconciliationReviewIssuerKeyring(keyringPath);
  const keyProvider = new LocalReconciliationReviewIssuerKeyringFileProvider(
    keyringPath,
  );
  if (fs.existsSync(selectedPaths.authorization)) {
    const recovered = await verifyAuthorization(
      selectedPaths,
      intent,
      selected,
      decisionFile.evidence.fileDigest,
      command.request.expectedHeadDigest,
      uid,
      [0o600, 0o400],
    );
    if (
      recovered.decisions.length !== decisionFile.result.length ||
      recovered.decisions.some(
        (value, index) =>
          JSON.stringify(value) !== JSON.stringify(decisionFile.result[index]),
      )
    ) {
      configurationError('review decision differs from signed authorization');
    }
    decisionFile.confirmIdentity();
    return recovered;
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
      ownerPepperKeyringDirectory: command.options.ownerPepperKeyringDirectory,
      credentialFilePath: command.options.credentialFilePath,
      authenticationNamespace: 'local_reconciliation_secret_config',
      now: () => command.request.committedAtMs,
    });
    const reviewer = strongReviewer(
      authenticated,
      selected.application.review.authorization.header.reviewer,
      command.request.committedAtMs,
    );
    const header = buildLocalReconciliationSecretConfigAuthorizationHeader({
      decisionId: command.request.decisionId,
      secretConfigId: command.request.secretConfigId,
      profile: intent.profile,
      secretConfigPlanDigest: intent.secretConfigPlanDigest,
      candidateSetDigest: intent.candidateSetDigest,
      applicationPlanDigest: intent.applicationPlanDigest,
      preparationDigest: intent.preparationDigest,
      preparedHeadDigest: command.request.expectedHeadDigest,
      bundleDigest: intent.bundleDigest,
      bundleFingerprintDigest: intent.bundleFingerprintDigest,
      reviewer,
      issuedAtMs: command.request.committedAtMs,
      expiresAtMs:
        command.request.committedAtMs + command.request.authorizationLifetimeMs,
    });
    await publishLocalReconciliationSecretConfigAuthorization({
      targetPath: selectedPaths.authorization,
      stagePath: selectedPaths.authorizationStage,
      maxBytes: authorizationMaxBytes(intent.profile),
      header,
      keyProvider,
      writeDecisions(append) {
        for (const selectedDecision of decisionFile.result) {
          append(selectedDecision);
        }
        return Object.freeze({
          decisionFileDigest: decisionFile.evidence.fileDigest,
          confirmDecisionFileAuthority: decisionFile.confirmIdentity,
        });
      },
      async confirmAuthority() {
        const head = readLocalCutoverInstanceHead(
          command.options.deploymentRoot,
          intent.instanceId,
          uid,
        );
        if (
          head.state !== 'reconciliation_secret_config_decision_prepared' ||
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
  return verifyAuthorization(
    selectedPaths,
    intent,
    selected,
    decisionFile.evidence.fileDigest,
    command.request.expectedHeadDigest,
    uid,
    [0o600],
  );
}

function buildReceipt(
  intent: Readonly<LocalReconciliationSecretConfigDecisionIntent>,
  authorizationScope: Readonly<LocalReconciliationSecretConfigAuthorizationScope>,
): Readonly<LocalReconciliationSecretConfigDecisionReceipt> {
  const evidence = authorizationScope.evidence;
  return buildLocalReconciliationSecretConfigDecisionReceipt({
    decisionId: intent.command.request.decisionId,
    secretConfigId: intent.command.request.secretConfigId,
    secretConfigPlanDigest: intent.secretConfigPlanDigest,
    candidateSetDigest: intent.candidateSetDigest,
    applicationPlanDigest: intent.applicationPlanDigest,
    preparedHeadDigest: evidence.header.preparedHeadDigest,
    authorizationDigest: evidence.authorizationDigest,
    signedDecisionSetDigest: evidence.decisionSetDigest,
    decisionFileDigest: evidence.decisionFileDigest,
    reviewerDigest: cutoverDigest({
      subject: evidence.header.reviewer.subject,
      authenticationId: evidence.header.reviewer.authenticationId,
      authenticatedAtMs: evidence.header.reviewer.authenticatedAtMs,
      assurance: evidence.header.reviewer.assurance,
    }),
    candidateCount: evidence.decisionCount,
    applyBindingCount: evidence.dispositionCounts.apply_active_binding,
    preserveDisabledCount: evidence.dispositionCounts.preserve_disabled,
    skippedCount: evidence.dispositionCounts.skip,
    outcome:
      evidence.dispositionCounts.skip === 0 ? 'ready' : 'manual_required',
    issuedAtMs: evidence.header.issuedAtMs,
    expiresAtMs: evidence.header.expiresAtMs,
  });
}

function validateReceiptBinding(
  receipt: Readonly<LocalReconciliationSecretConfigDecisionReceipt>,
  intent: Readonly<LocalReconciliationSecretConfigDecisionIntent>,
  authorizationScope: Readonly<LocalReconciliationSecretConfigAuthorizationScope>,
): void {
  const expected = buildReceipt(intent, authorizationScope);
  if (expected.decisionDigest !== receipt.decisionDigest) {
    configurationError('terminal receipt is detached from authorization');
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

export async function commitLocalReconciliationSecretConfigDecision(
  value: unknown,
  dependencies: LocalReconciliationSecretConfigDecisionDependencies = {},
): Promise<Readonly<LocalReconciliationSecretConfigDecisionTerminalResult>> {
  const command =
    normalizeLocalReconciliationSecretConfigDecisionCommitCommand(value);
  const uid = currentIdentity().uid;
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
    [command.options.secretConfigRoot, 'secretConfigRoot'],
    [command.options.secretConfigDecisionRoot, 'secretConfigDecisionRoot'],
  ] as const) {
    validatePrivateDirectory(directory, uid, label);
  }
  const selectedPaths = paths(
    command.options.secretConfigDecisionRoot,
    command.request.secretConfigId,
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
  const selectedContext = await context(
    intent.command.options,
    intent.command.request.secretConfigId,
    uid,
  );
  intentBinding(intent, selectedContext);
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
      receipt.secretConfigId !== command.request.secretConfigId ||
      receipt.preparedHeadDigest !== command.request.expectedHeadDigest ||
      receipt.issuedAtMs !== command.request.committedAtMs ||
      receipt.expiresAtMs !==
        command.request.committedAtMs + command.request.authorizationLifetimeMs
    ) {
      configurationError('terminal receipt is not an exact command replay');
    }
    const authorizationScope = await verifyAuthorization(
      selectedPaths,
      intent,
      selectedContext,
      receipt.decisionFileDigest,
      receipt.preparedHeadDigest,
      uid,
      [0o600, 0o400],
    );
    validateReceiptBinding(receipt, intent, authorizationScope);
    const existing = head.state === 'reconciliation_secret_config_reviewed';
    if (
      (!existing &&
        (head.state !== 'reconciliation_secret_config_decision_prepared' ||
          head.sourceRecordDigest !== intent.preparationDigest)) ||
      (existing &&
        (head.previousHeadDigest !== receipt.preparedHeadDigest ||
          head.sourceRecordDigest !== receipt.decisionDigest))
    ) {
      configurationError('terminal receipt lost instance head binding');
    }
    sealTerminal(selectedPaths, uid);
    dependencies.afterTerminalSealed?.();
    head = existing
      ? head
      : advanceHead(
          intent,
          'reconciliation_secret_config_reviewed',
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
    head.state !== 'reconciliation_secret_config_decision_prepared' ||
    head.headDigest !== command.request.expectedHeadDigest ||
    head.sourceRecordDigest !== intent.preparationDigest
  ) {
    configurationError('decision commit lost prepared head compare-and-swap');
  }
  validateCatalog(selectedPaths, false);
  const authorizationScope = await authorization(
    command,
    intent,
    selectedPaths,
    selectedContext,
    dependencies,
    uid,
  );
  dependencies.afterAuthorizationPublished?.();
  const receipt = buildReceipt(intent, authorizationScope);
  publishExactFile(
    selectedPaths.receipt,
    localReconciliationSecretConfigDecisionEvidenceContents(receipt),
    0o600,
    uid,
    'Secret/Config decision receipt',
  );
  dependencies.afterReceiptPublished?.();
  validateReceiptBinding(receipt, intent, authorizationScope);
  sealTerminal(selectedPaths, uid);
  dependencies.afterTerminalSealed?.();
  head = advanceHead(
    intent,
    'reconciliation_secret_config_reviewed',
    receipt.decisionDigest,
    receipt.issuedAtMs,
    uid,
  );
  dependencies.afterHeadAdvanced?.();
  return terminalResult(command.operation, 'prepared', receipt, head);
}

export async function verifyLocalReconciliationSecretConfigDecision(
  value: unknown,
): Promise<Readonly<LocalReconciliationSecretConfigDecisionTerminalResult>> {
  const command =
    normalizeLocalReconciliationSecretConfigDecisionVerifyCommand(value);
  const uid = currentIdentity().uid;
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
    [command.options.secretConfigRoot, 'secretConfigRoot'],
    [command.options.secretConfigDecisionRoot, 'secretConfigDecisionRoot'],
  ] as const) {
    validatePrivateDirectory(directory, uid, label);
  }
  const selectedPaths = paths(
    command.options.secretConfigDecisionRoot,
    command.request.secretConfigId,
  );
  validateDirectory(selectedPaths.root, uid, [0o500], 'decision root');
  validateDirectory(selectedPaths.staging, uid, [0o500], 'decision staging');
  validateCatalog(selectedPaths, true);
  const intent = readIntent(selectedPaths, uid, [0o400]);
  const receipt = readReceipt(selectedPaths, uid, [0o400]);
  if (
    intent.command.request.decisionId !== command.request.decisionId ||
    receipt.decisionId !== command.request.decisionId ||
    receipt.secretConfigId !== command.request.secretConfigId ||
    receipt.decisionDigest !== command.request.expectedDecisionDigest
  ) {
    configurationError('verify command is detached from terminal decision');
  }
  const selectedContext = await context(
    intent.command.options,
    intent.command.request.secretConfigId,
    uid,
  );
  intentBinding(intent, selectedContext);
  const authorizationScope = await verifyAuthorization(
    selectedPaths,
    intent,
    selectedContext,
    receipt.decisionFileDigest,
    receipt.preparedHeadDigest,
    uid,
    [0o400],
  );
  validateReceiptBinding(receipt, intent, authorizationScope);
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    uid,
  );
  if (
    head.state !== 'reconciliation_secret_config_reviewed' ||
    head.previousHeadDigest !== receipt.preparedHeadDigest ||
    head.sourceRecordDigest !== receipt.decisionDigest
  ) {
    configurationError('terminal decision is detached from instance head');
  }
  return terminalResult(command.operation, 'verified', receipt, head);
}

export async function readLocalReconciliationSecretConfigDecisionTerminal(
  options: Readonly<
    LocalReconciliationSecretConfigDecisionPrepareCommand['options']
  >,
  secretConfigId: string,
  uid: number,
  acceptedSuccessorStates: readonly LocalCutoverInstanceHead['state'][] = [],
): Promise<Readonly<LocalReconciliationSecretConfigDecisionTerminal>> {
  for (const [directory, label] of [
    [options.deploymentRoot, 'deploymentRoot'],
    [options.applicationRoot, 'applicationRoot'],
    [options.secretConfigRoot, 'secretConfigRoot'],
    [options.secretConfigDecisionRoot, 'secretConfigDecisionRoot'],
  ] as const) {
    validatePrivateDirectory(directory, uid, label);
  }
  const selectedPaths = paths(options.secretConfigDecisionRoot, secretConfigId);
  validateDirectory(selectedPaths.root, uid, [0o500], 'decision root');
  validateDirectory(selectedPaths.staging, uid, [0o500], 'decision staging');
  validateCatalog(selectedPaths, true);
  const intent = readIntent(selectedPaths, uid, [0o400]);
  const receipt = readReceipt(selectedPaths, uid, [0o400]);
  if (
    intent.command.request.secretConfigId !== secretConfigId ||
    receipt.secretConfigId !== secretConfigId ||
    receipt.decisionId !== intent.command.request.decisionId
  ) {
    configurationError('terminal decision identity drifted');
  }
  const selectedContext = await context(options, secretConfigId, uid);
  intentBinding(intent, selectedContext);
  const authorizationScope = await verifyAuthorization(
    selectedPaths,
    intent,
    selectedContext,
    receipt.decisionFileDigest,
    receipt.preparedHeadDigest,
    uid,
    [0o400],
  );
  validateReceiptBinding(receipt, intent, authorizationScope);
  const head = readLocalCutoverInstanceHead(
    options.deploymentRoot,
    intent.instanceId,
    uid,
  );
  const reviewed =
    head.state === 'reconciliation_secret_config_reviewed' &&
    head.previousHeadDigest === receipt.preparedHeadDigest &&
    head.sourceRecordDigest === receipt.decisionDigest;
  const successor =
    acceptedSuccessorStates.includes(head.state) &&
    head.generation === intent.generation &&
    head.updatedAtMs >= receipt.issuedAtMs;
  if (!reviewed && !successor) {
    configurationError('terminal decision is detached from instance head');
  }
  return Object.freeze({
    intent,
    receipt,
    authorization: authorizationScope,
    context: selectedContext,
    reviewer: authorizationScope.evidence.header.reviewer,
    head,
  });
}

export function prepareLocalReconciliationSecretConfigDecisionCommandFile(
  filePath: string,
  dependencies: LocalReconciliationSecretConfigDecisionDependencies = {},
) {
  return prepareLocalReconciliationSecretConfigDecision(
    readPrivateLocalCommandFile(filePath),
    dependencies,
  );
}

export function commitLocalReconciliationSecretConfigDecisionCommandFile(
  filePath: string,
  dependencies: LocalReconciliationSecretConfigDecisionDependencies = {},
) {
  return commitLocalReconciliationSecretConfigDecision(
    readPrivateLocalCommandFile(filePath),
    dependencies,
  );
}

export function verifyLocalReconciliationSecretConfigDecisionCommandFile(
  filePath: string,
) {
  return verifyLocalReconciliationSecretConfigDecision(
    readPrivateLocalCommandFile(filePath),
  );
}
