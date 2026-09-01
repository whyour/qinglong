import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';
import {
  establishAuthenticatedLocalCommand,
  type AuthenticatedLocalCommand,
} from '@qinglong/local-owner-console/authenticated-command';
import { openLocalSqliteAuthenticationReadDatabase } from '@qinglong/local-sqlite/authentication-read';

import { currentIdentity } from '../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../foundation/error';
import {
  publishExactFile,
  validatePrivateDirectory,
} from '../../foundation/files';
import { cutoverDigest } from '../../cutover/targetEvidence';
import {
  advanceLocalCutoverInstanceHead,
  readLocalCutoverInstanceHead,
  type LocalCutoverInstanceHead,
} from '../../cutover/instanceLineage';
import { readLocalReconciliationCaptureIntent } from '../preparation';
import { readLocalReconciliationPlanTerminal } from '../planning/preparation';
import { withLocalReconciliationSealedDatabase } from '../sealed-bundle/reader';
import {
  publishLocalReconciliationReviewAuthorization,
  verifyLocalReconciliationReviewAuthorization,
  type LocalReconciliationReviewAuthorizationEvidence,
  type LocalReconciliationReviewAuthorizationHeader,
} from './authorization';
import {
  normalizeLocalReconciliationReviewCommitCommand,
  normalizeLocalReconciliationReviewVerifyCommand,
  type LocalReconciliationReviewCommitCommand,
  type LocalReconciliationReviewTerminalResult,
  type LocalReconciliationReviewVerifyCommand,
} from './completionContract';
import {
  assertLocalReconciliationReviewDecisionMatchesFact,
  MAX_EDGE_LOCAL_RECONCILIATION_REVIEW_DECISION_BYTES,
  MAX_STANDALONE_LOCAL_RECONCILIATION_REVIEW_DECISION_BYTES,
  withLocalReconciliationReviewDecisionFile,
} from './decisionFile';
import { visitLocalReconciliationDiagnosticFacts } from './diagnostics';
import {
  ensureLocalReconciliationReviewIssuerKeyring,
  LocalReconciliationReviewIssuerKeyringFileProvider,
} from './issuerKeyring';
import {
  normalizeLocalReconciliationReviewIntent,
  type LocalReconciliationReviewDependencies,
  type LocalReconciliationReviewIntent,
} from './preparation';
import {
  buildLocalReconciliationReview,
  buildLocalReconciliationReviewReceipt,
  normalizeLocalReconciliationReview,
  normalizeLocalReconciliationReviewReceipt,
  readLocalReconciliationReviewTerminalJson,
  terminalEvidenceContents,
  type LocalReconciliationReview,
  type LocalReconciliationReviewReceipt,
} from './terminalEvidence';

const MAX_AUTHENTICATION_AGE_MS = 5 * 60 * 1_000;
const COMMIT_CLOCK_SKEW_MS = 60_000;

interface ReviewPaths {
  readonly root: string;
  readonly staging: string;
  readonly intent: string;
  readonly authorization: string;
  readonly authorizationStage: string;
  readonly review: string;
  readonly receipt: string;
}

type AuthenticationDatabase = Awaited<
  ReturnType<typeof openLocalSqliteAuthenticationReadDatabase>
>;

export interface LocalReconciliationReviewCompletionDependencies
  extends LocalReconciliationReviewDependencies {
  readonly openAuthenticationDatabase?: typeof openLocalSqliteAuthenticationReadDatabase;
  readonly authenticate?: typeof establishAuthenticatedLocalCommand;
  readonly now?: () => number;
  readonly afterAuthorizationPublished?: () => void;
  readonly afterReviewPublished?: () => void;
  readonly afterReceiptPublished?: () => void;
  readonly afterTerminalSealed?: () => void;
  readonly afterHeadAdvanced?: () => void;
}

interface TerminalReview {
  readonly intent: Readonly<LocalReconciliationReviewIntent>;
  readonly authorization: Readonly<LocalReconciliationReviewAuthorizationEvidence>;
  readonly review: Readonly<LocalReconciliationReview>;
  readonly receipt: Readonly<LocalReconciliationReviewReceipt>;
  readonly head: Readonly<LocalCutoverInstanceHead>;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function paths(reviewRoot: string, reviewId: string): Readonly<ReviewPaths> {
  const root = path.join(reviewRoot, reviewId);
  const staging = path.join(root, 'staging');
  return Object.freeze({
    root,
    staging,
    intent: path.join(root, 'intent.json'),
    authorization: path.join(root, 'authorization.ndjson'),
    authorizationStage: path.join(staging, 'authorization.ndjson.stage'),
    review: path.join(root, 'review.json'),
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
    configurationError(`${label} is unavailable`, error);
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
  selected: Readonly<ReviewPaths>,
  terminal: boolean,
): void {
  const allowed = new Set([
    'authorization.ndjson',
    'intent.json',
    'receipt.json',
    'review.json',
    'staging',
    ...(!terminal
      ? [
          '.intent.json.ql3-deploy-stage',
          '.receipt.json.ql3-deploy-stage',
          '.review.json.ql3-deploy-stage',
        ]
      : []),
  ]);
  for (const entry of fs.readdirSync(selected.root, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || entry.isSymbolicLink()) {
      configurationError(
        'reconciliation review root contains unknown material',
      );
    }
  }
  const stagingEntries = fs.readdirSync(selected.staging);
  if (
    terminal
      ? stagingEntries.length !== 0
      : stagingEntries.some((entry) => entry !== 'authorization.ndjson.stage')
  ) {
    configurationError(
      'reconciliation review staging contains unknown material',
    );
  }
}

function readIntent(
  selected: Readonly<ReviewPaths>,
  uid: number,
): Readonly<LocalReconciliationReviewIntent> {
  return normalizeLocalReconciliationReviewIntent(
    readLocalReconciliationReviewTerminalJson(
      selected.intent,
      uid,
      [0o600, 0o400],
    ),
  );
}

function validateIntentBinding(
  command: Readonly<LocalReconciliationReviewCommitCommand>,
  intent: Readonly<LocalReconciliationReviewIntent>,
): void {
  if (
    intent.command.options.deploymentRoot !== command.options.deploymentRoot ||
    intent.command.options.captureRoot !== command.options.captureRoot ||
    intent.command.options.planRoot !== command.options.planRoot ||
    intent.command.options.reviewRoot !== command.options.reviewRoot ||
    intent.command.options.allowRootService !==
      command.options.allowRootService ||
    intent.command.request.reviewId !== command.request.reviewId ||
    intent.preparationDigest !== command.request.expectedPreparationDigest
  ) {
    configurationError('review commit is detached from its preparation');
  }
}

function validateHeadIdentity(
  head: Readonly<LocalCutoverInstanceHead>,
  intent: Readonly<LocalReconciliationReviewIntent>,
): void {
  if (
    head.profile !== intent.profile ||
    head.cutoverId !== intent.cutoverId ||
    head.activationDigest !== intent.activationDigest ||
    head.generation !== intent.generation
  ) {
    configurationError('reconciliation review instance head identity drifted');
  }
}

function expectedAuthorization(
  intent: Readonly<LocalReconciliationReviewIntent>,
  preparedHeadDigest: string,
): Readonly<{
  reviewId: string;
  profile: 'edge' | 'standalone';
  planDigest: string;
  preparationDigest: string;
  bundleDigest: string;
  bundleFingerprintDigest: string;
  preparedHeadDigest: string;
}> {
  return Object.freeze({
    reviewId: intent.command.request.reviewId,
    profile: intent.profile,
    planDigest: intent.command.request.expectedPlanDigest,
    preparationDigest: intent.preparationDigest,
    bundleDigest: intent.bundleDigest,
    bundleFingerprintDigest: intent.bundleFingerprintDigest,
    preparedHeadDigest,
  });
}

function maxAuthorizationBytes(profile: 'edge' | 'standalone'): number {
  return profile === 'edge'
    ? MAX_EDGE_LOCAL_RECONCILIATION_REVIEW_DECISION_BYTES
    : MAX_STANDALONE_LOCAL_RECONCILIATION_REVIEW_DECISION_BYTES;
}

function strongPrincipal(
  authenticated: Readonly<AuthenticatedLocalCommand>,
  committedAtMs: number,
  authorizationExpiresAtMs: number,
): Readonly<LocalReconciliationReviewAuthorizationHeader['reviewer']> {
  const principal = authenticated.principal;
  if (
    principal.subject.type !== 'user' ||
    !['hardware', 'local_console', 'multi_factor'].includes(
      principal.assurance,
    ) ||
    principal.authenticatedAtMs > committedAtMs ||
    committedAtMs - principal.authenticatedAtMs > MAX_AUTHENTICATION_AGE_MS ||
    principal.expiresAtMs <= committedAtMs ||
    !Number.isSafeInteger(authorizationExpiresAtMs) ||
    principal.expiresAtMs < authorizationExpiresAtMs
  ) {
    configurationError(
      'review commit requires a recent strongly authenticated User',
    );
  }
  return principal;
}

function advanceReviewedHead(
  intent: Readonly<LocalReconciliationReviewIntent>,
  committedAtMs: number,
  reviewDigest: string,
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
        requestedAtMs: committedAtMs,
      },
    },
    uid,
    'reconciliation_reviewed',
    intent.generation,
    reviewDigest,
  );
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
      configurationError('review terminal file cannot be sealed');
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
      configurationError('review terminal file changed while sealing');
    }
    if ((Number(opened.mode) & 0o777) !== 0o400)
      fs.fchmodSync(descriptor, 0o400);
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
    'review terminal directory',
  );
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    if (mode !== 0o500) fs.fchmodSync(descriptor, 0o500);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sealTerminal(selected: Readonly<ReviewPaths>, uid: number): void {
  if (fs.readdirSync(selected.staging).length !== 0) {
    configurationError('review staging must be empty before terminal seal');
  }
  for (const filePath of [
    selected.intent,
    selected.authorization,
    selected.review,
    selected.receipt,
  ]) {
    sealFile(filePath, uid);
  }
  sealDirectory(selected.staging, uid);
  sealDirectory(selected.root, uid);
  validateCatalog(selected, true);
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

async function recoverAuthorizationStage(
  selected: Readonly<ReviewPaths>,
  intent: Readonly<LocalReconciliationReviewIntent>,
  issuerKeyringPath: string,
  preparedHeadDigest: string,
): Promise<void> {
  if (!fs.existsSync(selected.authorizationStage)) return;
  if (fs.existsSync(selected.authorization)) {
    const stage = fs.statSync(selected.authorizationStage, { bigint: true });
    const target = fs.statSync(selected.authorization, { bigint: true });
    if (stage.dev !== target.dev || stage.ino !== target.ino) {
      configurationError('authorization stage conflicts with published target');
    }
    fs.unlinkSync(selected.authorizationStage);
    syncDirectory(selected.staging);
    await verifyLocalReconciliationReviewAuthorization(selected.authorization, {
      maxBytes: maxAuthorizationBytes(intent.profile),
      allowedModes: [0o600],
      keyProvider: new LocalReconciliationReviewIssuerKeyringFileProvider(
        issuerKeyringPath,
      ),
      expected: expectedAuthorization(intent, preparedHeadDigest),
    });
    return;
  }
  await verifyLocalReconciliationReviewAuthorization(
    selected.authorizationStage,
    {
      maxBytes: maxAuthorizationBytes(intent.profile),
      allowedModes: [0o600],
      keyProvider: new LocalReconciliationReviewIssuerKeyringFileProvider(
        issuerKeyringPath,
      ),
      expected: expectedAuthorization(intent, preparedHeadDigest),
    },
  );
  fs.linkSync(selected.authorizationStage, selected.authorization);
  syncDirectory(selected.root);
  fs.unlinkSync(selected.authorizationStage);
  syncDirectory(selected.staging);
}

function validateReviewBinding(
  intent: Readonly<LocalReconciliationReviewIntent>,
  authorization: Readonly<LocalReconciliationReviewAuthorizationEvidence>,
  review: Readonly<LocalReconciliationReview>,
  receipt: Readonly<LocalReconciliationReviewReceipt>,
): void {
  const reviewerDigest = cutoverDigest({
    subject: authorization.header.reviewer.subject,
    authenticationId: authorization.header.reviewer.authenticationId,
    authenticatedAtMs: authorization.header.reviewer.authenticatedAtMs,
    assurance: authorization.header.reviewer.assurance,
  });
  if (
    review.reviewId !== intent.command.request.reviewId ||
    review.profile !== intent.profile ||
    review.planDigest !== intent.command.request.expectedPlanDigest ||
    review.preparationDigest !== intent.preparationDigest ||
    review.bundleDigest !== intent.bundleDigest ||
    review.bundleFingerprintDigest !== intent.bundleFingerprintDigest ||
    review.authorizationDigest !== authorization.authorizationDigest ||
    review.decisionFileDigest !== authorization.decisionFileDigest ||
    review.decisionSetDigest !== authorization.decisionSetDigest ||
    review.decisionCount !== authorization.decisionCount ||
    review.preparedHeadDigest !== authorization.header.preparedHeadDigest ||
    review.issuedAtMs !== authorization.header.issuedAtMs ||
    review.expiresAtMs !== authorization.header.expiresAtMs ||
    review.committedAtMs !== authorization.header.issuedAtMs ||
    review.reviewerDigest !== reviewerDigest ||
    JSON.stringify(review.dispositionCounts) !==
      JSON.stringify(authorization.dispositionCounts) ||
    JSON.stringify(review.reasonCounts) !==
      JSON.stringify(authorization.reasonCounts) ||
    receipt.reviewId !== review.reviewId ||
    receipt.planDigest !== review.planDigest ||
    receipt.preparationDigest !== review.preparationDigest ||
    receipt.authorizationDigest !== review.authorizationDigest ||
    receipt.decisionSetDigest !== review.decisionSetDigest ||
    receipt.decisionCount !== review.decisionCount ||
    receipt.keyId !== authorization.keyId ||
    receipt.reviewDigest !== review.reviewDigest ||
    receipt.committedAtMs !== review.committedAtMs
  ) {
    configurationError('terminal reconciliation review binding drifted');
  }
}

async function readTerminal(
  selected: Readonly<ReviewPaths>,
  intent: Readonly<LocalReconciliationReviewIntent>,
  issuerKeyringPath: string,
  uid: number,
  allowedModes: readonly number[],
): Promise<
  Readonly<{
    authorization: Readonly<LocalReconciliationReviewAuthorizationEvidence>;
    review: Readonly<LocalReconciliationReview>;
    receipt: Readonly<LocalReconciliationReviewReceipt>;
  }>
> {
  const review = normalizeLocalReconciliationReview(
    readLocalReconciliationReviewTerminalJson(
      selected.review,
      uid,
      allowedModes,
    ),
  );
  const receipt = normalizeLocalReconciliationReviewReceipt(
    readLocalReconciliationReviewTerminalJson(
      selected.receipt,
      uid,
      allowedModes,
    ),
  );
  const authorization = await verifyLocalReconciliationReviewAuthorization(
    selected.authorization,
    {
      maxBytes: maxAuthorizationBytes(intent.profile),
      allowedModes,
      keyProvider: new LocalReconciliationReviewIssuerKeyringFileProvider(
        issuerKeyringPath,
      ),
      expected: expectedAuthorization(intent, review.preparedHeadDigest),
    },
  );
  validateReviewBinding(intent, authorization, review, receipt);
  return Object.freeze({ authorization, review, receipt });
}

export interface LocalReconciliationReviewTerminal {
  readonly intent: Readonly<LocalReconciliationReviewIntent>;
  readonly authorization: Readonly<LocalReconciliationReviewAuthorizationEvidence>;
  readonly review: Readonly<LocalReconciliationReview>;
  readonly receipt: Readonly<LocalReconciliationReviewReceipt>;
}

export async function readLocalReconciliationReviewTerminal(
  reviewRoot: string,
  reviewId: string,
  issuerKeyringPath: string,
  uid: number,
): Promise<Readonly<LocalReconciliationReviewTerminal>> {
  const selected = paths(reviewRoot, reviewId);
  validateDirectory(
    selected.root,
    uid,
    [0o500],
    'reconciliationReviewDirectory',
  );
  validateDirectory(
    selected.staging,
    uid,
    [0o500],
    'reconciliationReviewStaging',
  );
  validateCatalog(selected, true);
  const intent = readIntent(selected, uid);
  if (
    intent.command.options.reviewRoot !== reviewRoot ||
    intent.command.request.reviewId !== reviewId
  ) {
    configurationError('terminal reconciliation review path binding drifted');
  }
  const terminal = await readTerminal(
    selected,
    intent,
    issuerKeyringPath,
    uid,
    [0o400],
  );
  return Object.freeze({ intent, ...terminal });
}

function result(
  operation: LocalReconciliationReviewTerminalResult['operation'],
  status: LocalReconciliationReviewTerminalResult['status'],
  terminal: Readonly<{
    authorization: Readonly<LocalReconciliationReviewAuthorizationEvidence>;
    review: Readonly<LocalReconciliationReview>;
  }>,
  head: Readonly<LocalCutoverInstanceHead>,
): Readonly<LocalReconciliationReviewTerminalResult> {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    status,
    state: 'reconciliation_reviewed',
    reviewId: terminal.review.reviewId,
    reviewDigest: terminal.review.reviewDigest,
    authorizationDigest: terminal.authorization.authorizationDigest,
    decisionSetDigest: terminal.authorization.decisionSetDigest,
    decisionCount: terminal.authorization.decisionCount,
    instanceHeadDigest: head.headDigest,
  });
}

async function confirmCurrentAuthority(
  authenticated: Readonly<AuthenticatedLocalCommand>,
  command: Readonly<LocalReconciliationReviewCommitCommand>,
  intent: Readonly<LocalReconciliationReviewIntent>,
  uid: number,
): Promise<void> {
  await authenticated.confirm();
  const terminal = readLocalReconciliationPlanTerminal(
    command.options.planRoot,
    intent.command.request.planId,
    uid,
  );
  if (
    terminal.plan.planDigest !== intent.command.request.expectedPlanDigest ||
    terminal.plan.bundleDigest !== intent.bundleDigest ||
    terminal.bundle.fingerprintDigest !== intent.bundleFingerprintDigest
  ) {
    configurationError('review authority lost exact plan or bundle binding');
  }
  const currentHead = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    uid,
  );
  validateHeadIdentity(currentHead, intent);
  if (
    currentHead.state !== 'reconciliation_review_prepared' ||
    currentHead.headDigest !== command.request.expectedHeadDigest ||
    currentHead.sourceRecordDigest !== intent.preparationDigest
  ) {
    configurationError('review authority lost prepared head binding');
  }
}

async function publishAuthorization(
  command: Readonly<LocalReconciliationReviewCommitCommand>,
  intent: Readonly<LocalReconciliationReviewIntent>,
  selected: Readonly<ReviewPaths>,
  head: Readonly<LocalCutoverInstanceHead>,
  terminal: ReturnType<typeof readLocalReconciliationPlanTerminal>,
  authenticated: Readonly<AuthenticatedLocalCommand>,
  dependencies: LocalReconciliationReviewCompletionDependencies,
  uid: number,
): Promise<Readonly<LocalReconciliationReviewAuthorizationEvidence>> {
  const authorizationExpiresAtMs =
    command.request.committedAtMs + command.request.authorizationLifetimeMs;
  const reviewer = strongPrincipal(
    authenticated,
    command.request.committedAtMs,
    authorizationExpiresAtMs,
  );
  ensureLocalReconciliationReviewIssuerKeyring(
    command.options.issuerKeyringPath,
  );
  const keyProvider = new LocalReconciliationReviewIssuerKeyringFileProvider(
    command.options.issuerKeyringPath,
  );
  const header: Readonly<LocalReconciliationReviewAuthorizationHeader> =
    Object.freeze({
      schemaVersion: 1,
      kind: 'qinglong3-local-reconciliation-review-authorization-header',
      reviewId: command.request.reviewId,
      profile: intent.profile,
      planDigest: terminal.plan.planDigest,
      preparationDigest: intent.preparationDigest,
      bundleDigest: terminal.bundle.receipt.bundleDigest,
      bundleFingerprintDigest: terminal.bundle.fingerprintDigest,
      preparedHeadDigest: head.headDigest,
      reviewer,
      issuedAtMs: command.request.committedAtMs,
      expiresAtMs: authorizationExpiresAtMs,
    });
  return publishLocalReconciliationReviewAuthorization({
    targetPath: selected.authorization,
    stagePath: selected.authorizationStage,
    maxBytes: maxAuthorizationBytes(intent.profile),
    header,
    keyProvider,
    confirmAuthority: () =>
      confirmCurrentAuthority(authenticated, command, intent, uid),
    writeDecisions: (append) => {
      const reviewed = withLocalReconciliationReviewDecisionFile(
        command.request.decisionFilePath,
        {
          reviewId: command.request.reviewId,
          profile: intent.profile,
          planDigest: terminal.plan.planDigest,
          preparationDigest: intent.preparationDigest,
        },
        (cursor) => {
          for (const database of ['legacy', 'target'] as const) {
            const opened = withLocalReconciliationSealedDatabase(
              terminal.bundle,
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
                      configurationError(
                        'review decision file omitted a canonical fact',
                      );
                    }
                    assertLocalReconciliationReviewDecisionMatchesFact(
                      decision,
                      fact,
                    );
                    append(decision);
                  },
                ),
            );
            if (opened === null) {
              configurationError(
                'manual-required SQLite topology cannot be reviewed',
              );
            }
          }
        },
      );
      return Object.freeze({
        decisionFileDigest: reviewed.evidence.fileDigest,
        confirmDecisionFileAuthority: reviewed.confirmIdentity,
      });
    },
  });
}

export async function commitLocalReconciliationReview(
  input: unknown,
  dependencies: LocalReconciliationReviewCompletionDependencies = {},
): Promise<Readonly<LocalReconciliationReviewTerminalResult>> {
  const command = normalizeLocalReconciliationReviewCommitCommand(input);
  const uid = currentIdentity().uid;
  validatePrivateDirectory(
    command.options.deploymentRoot,
    uid,
    'deploymentRoot',
  );
  validatePrivateDirectory(command.options.captureRoot, uid, 'captureRoot');
  validatePrivateDirectory(command.options.planRoot, uid, 'planRoot');
  validatePrivateDirectory(command.options.reviewRoot, uid, 'reviewRoot');
  const selected = paths(command.options.reviewRoot, command.request.reviewId);
  validateDirectory(
    selected.root,
    uid,
    [0o700, 0o500],
    'reconciliationReviewDirectory',
  );
  validateDirectory(
    selected.staging,
    uid,
    [0o700, 0o500],
    'reconciliationReviewStaging',
  );
  const intent = readIntent(selected, uid);
  validateIntentBinding(command, intent);
  const terminalPlan = readLocalReconciliationPlanTerminal(
    command.options.planRoot,
    intent.command.request.planId,
    uid,
  );
  if (
    terminalPlan.plan.planDigest !==
      intent.command.request.expectedPlanDigest ||
    terminalPlan.plan.bundleDigest !== intent.bundleDigest ||
    terminalPlan.bundle.fingerprintDigest !== intent.bundleFingerprintDigest
  ) {
    configurationError('review commit lost terminal plan binding');
  }
  const captureIntent = readLocalReconciliationCaptureIntent(
    command.options.captureRoot,
    terminalPlan.plan.captureId,
  );
  if (
    captureIntent.command.request.targetDatabasePath !==
    command.options.targetDatabasePath
  ) {
    configurationError(
      'authentication database is detached from sealed target',
    );
  }
  let head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    uid,
  );
  validateHeadIdentity(head, intent);
  if (fs.existsSync(selected.receipt)) {
    const terminal = await readTerminal(
      selected,
      intent,
      command.options.issuerKeyringPath,
      uid,
      [0o600, 0o400],
    );
    if (
      terminal.review.committedAtMs !== command.request.committedAtMs ||
      terminal.authorization.header.expiresAtMs !==
        command.request.committedAtMs +
          command.request.authorizationLifetimeMs ||
      terminal.review.preparedHeadDigest !==
        command.request.expectedHeadDigest ||
      (head.state !== 'reconciliation_review_prepared' &&
        head.state !== 'reconciliation_reviewed') ||
      (head.state === 'reconciliation_review_prepared' &&
        head.sourceRecordDigest !== intent.preparationDigest) ||
      (head.state === 'reconciliation_reviewed' &&
        head.sourceRecordDigest !== terminal.review.reviewDigest)
    ) {
      configurationError('terminal review lost instance head binding');
    }
    sealTerminal(selected, uid);
    const wasReviewed = head.state === 'reconciliation_reviewed';
    head =
      head.state === 'reconciliation_reviewed'
        ? head
        : advanceReviewedHead(
            intent,
            terminal.review.committedAtMs,
            terminal.review.reviewDigest,
            uid,
          );
    dependencies.afterHeadAdvanced?.();
    return result(
      command.operation,
      wasReviewed ? 'existing' : 'prepared',
      terminal,
      head,
    );
  }
  if (
    head.state !== 'reconciliation_review_prepared' ||
    head.headDigest !== command.request.expectedHeadDigest ||
    head.sourceRecordDigest !== intent.preparationDigest
  ) {
    configurationError(
      'review commit lost prepared instance head compare-and-swap',
    );
  }
  validateCatalog(selected, false);
  await recoverAuthorizationStage(
    selected,
    intent,
    command.options.issuerKeyringPath,
    command.request.expectedHeadDigest,
  );
  let authorization: Readonly<LocalReconciliationReviewAuthorizationEvidence>;
  if (fs.existsSync(selected.authorization)) {
    authorization = await verifyLocalReconciliationReviewAuthorization(
      selected.authorization,
      {
        maxBytes: maxAuthorizationBytes(intent.profile),
        allowedModes: [0o600, 0o400],
        keyProvider: new LocalReconciliationReviewIssuerKeyringFileProvider(
          command.options.issuerKeyringPath,
        ),
        expected: expectedAuthorization(
          intent,
          command.request.expectedHeadDigest,
        ),
      },
    );
  } else {
    const now = (dependencies.now ?? Date.now)();
    if (
      !Number.isSafeInteger(now) ||
      Math.abs(now - command.request.committedAtMs) > COMMIT_CLOCK_SKEW_MS
    ) {
      configurationError(
        'review commit timestamp is outside its bounded clock window',
      );
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
        authenticationNamespace: 'local_reconciliation_review',
        now: () => command.request.committedAtMs,
      });
      authorization = await publishAuthorization(
        command,
        intent,
        selected,
        head,
        terminalPlan,
        authenticated,
        dependencies,
        uid,
      );
      dependencies.afterAuthorizationPublished?.();
    } finally {
      await database.close();
    }
  }
  if (
    authorization.header.issuedAtMs !== command.request.committedAtMs ||
    authorization.header.expiresAtMs !==
      command.request.committedAtMs + command.request.authorizationLifetimeMs
  ) {
    configurationError(
      'review authorization lifetime is detached from command',
    );
  }
  const review = buildLocalReconciliationReview({
    authorization,
    decisionFileDigest: authorization.decisionFileDigest,
    committedAtMs: command.request.committedAtMs,
  });
  publishExactFile(
    selected.review,
    terminalEvidenceContents(review),
    0o600,
    uid,
    'reconciliation review',
  );
  dependencies.afterReviewPublished?.();
  const receipt = buildLocalReconciliationReviewReceipt(
    review,
    authorization.keyId,
  );
  publishExactFile(
    selected.receipt,
    terminalEvidenceContents(receipt),
    0o600,
    uid,
    'reconciliation review receipt',
  );
  dependencies.afterReceiptPublished?.();
  validateReviewBinding(intent, authorization, review, receipt);
  sealTerminal(selected, uid);
  dependencies.afterTerminalSealed?.();
  head = advanceReviewedHead(
    intent,
    review.committedAtMs,
    review.reviewDigest,
    uid,
  );
  dependencies.afterHeadAdvanced?.();
  return result(command.operation, 'prepared', { authorization, review }, head);
}

export async function verifyLocalReconciliationReview(
  input: unknown,
): Promise<Readonly<LocalReconciliationReviewTerminalResult>> {
  const command = normalizeLocalReconciliationReviewVerifyCommand(input);
  const uid = currentIdentity().uid;
  validatePrivateDirectory(
    command.options.deploymentRoot,
    uid,
    'deploymentRoot',
  );
  validatePrivateDirectory(command.options.captureRoot, uid, 'captureRoot');
  validatePrivateDirectory(command.options.planRoot, uid, 'planRoot');
  validatePrivateDirectory(command.options.reviewRoot, uid, 'reviewRoot');
  const selected = paths(command.options.reviewRoot, command.request.reviewId);
  validateDirectory(
    selected.root,
    uid,
    [0o500],
    'reconciliationReviewDirectory',
  );
  validateDirectory(
    selected.staging,
    uid,
    [0o500],
    'reconciliationReviewStaging',
  );
  validateCatalog(selected, true);
  const intent = readIntent(selected, uid);
  if (
    intent.command.options.deploymentRoot !== command.options.deploymentRoot ||
    intent.command.options.captureRoot !== command.options.captureRoot ||
    intent.command.options.planRoot !== command.options.planRoot ||
    intent.command.options.reviewRoot !== command.options.reviewRoot ||
    intent.command.options.allowRootService !==
      command.options.allowRootService ||
    intent.command.request.reviewId !== command.request.reviewId
  ) {
    configurationError('review verify is detached from preparation');
  }
  const terminalPlan = readLocalReconciliationPlanTerminal(
    command.options.planRoot,
    intent.command.request.planId,
    uid,
  );
  if (
    terminalPlan.plan.planDigest !==
      intent.command.request.expectedPlanDigest ||
    terminalPlan.plan.bundleDigest !== intent.bundleDigest ||
    terminalPlan.bundle.fingerprintDigest !== intent.bundleFingerprintDigest
  ) {
    configurationError('review verify lost terminal plan binding');
  }
  const terminal = await readTerminal(
    selected,
    intent,
    command.options.issuerKeyringPath,
    uid,
    [0o400],
  );
  if (terminal.review.reviewDigest !== command.request.expectedReviewDigest) {
    configurationError('review verify digest mismatch');
  }
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    uid,
  );
  validateHeadIdentity(head, intent);
  if (
    head.state !== 'reconciliation_reviewed' ||
    head.sourceRecordDigest !== terminal.review.reviewDigest
  ) {
    configurationError('review verify lost reviewed instance head');
  }
  return result(command.operation, 'verified', terminal, head);
}

export async function commitLocalReconciliationReviewCommandFile(
  filePath: string,
): Promise<Readonly<LocalReconciliationReviewTerminalResult>> {
  return commitLocalReconciliationReview(readPrivateLocalCommandFile(filePath));
}

export async function verifyLocalReconciliationReviewCommandFile(
  filePath: string,
): Promise<Readonly<LocalReconciliationReviewTerminalResult>> {
  return verifyLocalReconciliationReview(readPrivateLocalCommandFile(filePath));
}
