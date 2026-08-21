import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { currentIdentity } from '../../foundation/contract';
import { LocalDeploymentConfigurationError } from '../../foundation/error';
import {
  ensurePrivateDirectory,
  preflightPublishedFile,
  publishExactFile,
  validatePrivateDirectory,
} from '../../foundation/files';
import {
  advanceLocalCutoverInstanceHead,
  readLocalCutoverInstanceHead,
  type LocalCutoverInstanceHead,
} from '../../cutover/instanceLineage';
import { cutoverDigest } from '../../cutover/targetEvidence';
import { readLocalReconciliationReviewTerminal } from '../review/completion';
import type { LocalReconciliationReviewTerminal } from '../review/completion';
import {
  normalizeLocalReconciliationApplicationCommitCommand,
  normalizeLocalReconciliationApplicationPrepareCommand,
  normalizeLocalReconciliationApplicationVerifyCommand,
  type LocalReconciliationApplicationCommitCommand,
  type LocalReconciliationApplicationPrepareCommand,
  type LocalReconciliationApplicationPrepareResult,
  type LocalReconciliationApplicationTerminalResult,
} from './contract';
import {
  buildLocalReconciliationApplicationPlan,
  buildLocalReconciliationApplicationPlanReceipt,
  normalizeLocalReconciliationApplicationPlan,
  normalizeLocalReconciliationApplicationPlanReceipt,
  type LocalReconciliationApplicationPlan,
  type LocalReconciliationApplicationPlanReceipt,
} from './plan';

const INTENT_SCHEMA = 'qinglong3-local-reconciliation-application-intent';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_APPLICATIONS = 64;
const MAX_TERMINAL_BYTES = 64 * 1024;

export interface LocalReconciliationApplicationIntent {
  readonly schema: typeof INTENT_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_application_prepared';
  readonly command: Readonly<LocalReconciliationApplicationPrepareCommand>;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly cutoverId: string;
  readonly generation: number;
  readonly activationDigest: string;
  readonly reviewDigest: string;
  readonly authorizationDigest: string;
  readonly decisionSetDigest: string;
  readonly decisionCount: number;
  readonly reviewedHeadDigest: string;
  readonly preparationDigest: string;
}

export interface LocalReconciliationApplicationDependencies {
  readonly afterHeadPrepared?: () => void;
  readonly afterPlanPublished?: () => void;
  readonly afterReceiptPublished?: () => void;
  readonly afterTerminalSealed?: () => void;
  readonly afterHeadAdvanced?: () => void;
}

interface ApplicationPaths {
  readonly root: string;
  readonly staging: string;
  readonly intent: string;
  readonly plan: string;
  readonly receipt: string;
}

interface TerminalApplication {
  readonly plan: Readonly<LocalReconciliationApplicationPlan>;
  readonly receipt: Readonly<LocalReconciliationApplicationPlanReceipt>;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    configurationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    configurationError(`${label} shape is invalid`);
  }
}

function contents(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function localReconciliationApplicationDirectory(
  applicationRoot: string,
  applicationId: string,
): string {
  return path.join(applicationRoot, applicationId);
}

function applicationPaths(
  applicationRoot: string,
  applicationId: string,
): Readonly<ApplicationPaths> {
  const root = localReconciliationApplicationDirectory(
    applicationRoot,
    applicationId,
  );
  return Object.freeze({
    root,
    staging: path.join(root, 'staging'),
    intent: path.join(root, 'intent.json'),
    plan: path.join(root, 'plan.json'),
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

function ensureApplicationDirectory(
  applicationRoot: string,
  applicationId: string,
  uid: number,
): Readonly<ApplicationPaths> {
  const selected = applicationPaths(applicationRoot, applicationId);
  const entries = fs.readdirSync(applicationRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      configurationError('reconciliation application catalog contains drift');
    }
  }
  if (entries.length >= MAX_APPLICATIONS && !fs.existsSync(selected.root)) {
    configurationError('reconciliation application retention limit is reached');
  }
  ensurePrivateDirectory(
    selected.root,
    uid,
    'reconciliationApplicationDirectory',
  );
  ensurePrivateDirectory(
    selected.staging,
    uid,
    'reconciliationApplicationStaging',
  );
  return selected;
}

function validateCatalog(
  selected: Readonly<ApplicationPaths>,
  terminal: boolean,
): void {
  const allowed = new Set([
    'intent.json',
    'plan.json',
    'receipt.json',
    'staging',
    ...(!terminal
      ? [
          '.intent.json.ql3-deploy-stage',
          '.plan.json.ql3-deploy-stage',
          '.receipt.json.ql3-deploy-stage',
        ]
      : []),
  ]);
  for (const entry of fs.readdirSync(selected.root, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || entry.isSymbolicLink()) {
      configurationError(
        'reconciliation application root contains unknown material',
      );
    }
  }
  if (fs.readdirSync(selected.staging).length !== 0) {
    configurationError(
      'reconciliation application staging contains unknown material',
    );
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
      before.size > BigInt(MAX_TERMINAL_BYTES)
    ) {
      configurationError(
        'reconciliation application terminal file identity is invalid',
      );
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
      configurationError('application terminal file changed while opening');
    }
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(filePath, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino ||
      pathAfter.size !== before.size ||
      pathAfter.mtimeNs !== before.mtimeNs ||
      pathAfter.ctimeNs !== before.ctimeNs ||
      pathAfter.mode !== before.mode ||
      pathAfter.nlink !== before.nlink
    ) {
      configurationError('application terminal file changed while reading');
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError(
      'application terminal file cannot be read',
      error,
    );
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function normalizeLocalReconciliationApplicationIntent(
  value: unknown,
): Readonly<LocalReconciliationApplicationIntent> {
  const intent = object(value, 'reconciliation application intent');
  exact(
    intent,
    [
      'activationDigest',
      'authorizationDigest',
      'command',
      'cutoverId',
      'decisionCount',
      'decisionSetDigest',
      'generation',
      'instanceId',
      'preparationDigest',
      'profile',
      'reviewDigest',
      'reviewedHeadDigest',
      'schema',
      'schemaVersion',
      'state',
    ],
    'reconciliation application intent',
  );
  const normalizedCommand =
    normalizeLocalReconciliationApplicationPrepareCommand(intent.command);
  const { preparationDigest, ...payload } = intent;
  if (
    intent.schema !== INTENT_SCHEMA ||
    intent.schemaVersion !== 1 ||
    intent.state !== 'reconciliation_application_prepared' ||
    (intent.profile !== 'edge' && intent.profile !== 'standalone') ||
    typeof intent.instanceId !== 'string' ||
    intent.instanceId.length < 1 ||
    intent.instanceId.length > 128 ||
    typeof intent.cutoverId !== 'string' ||
    intent.cutoverId.length < 1 ||
    intent.cutoverId.length > 128 ||
    !Number.isSafeInteger(intent.generation) ||
    (intent.generation as number) < 1 ||
    !Number.isSafeInteger(intent.decisionCount) ||
    (intent.decisionCount as number) < 0 ||
    [
      intent.activationDigest,
      intent.reviewDigest,
      intent.authorizationDigest,
      intent.decisionSetDigest,
      intent.reviewedHeadDigest,
      preparationDigest,
    ].some(
      (candidate) =>
        typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate),
    ) ||
    cutoverDigest(payload) !== preparationDigest
  ) {
    configurationError('reconciliation application intent drifted');
  }
  return Object.freeze({
    ...(intent as unknown as LocalReconciliationApplicationIntent),
    command: normalizedCommand,
  });
}

export function readLocalReconciliationApplicationIntent(
  applicationRoot: string,
  applicationId: string,
): Readonly<LocalReconciliationApplicationIntent> {
  const uid = currentIdentity().uid;
  return normalizeLocalReconciliationApplicationIntent(
    terminalJson(
      applicationPaths(applicationRoot, applicationId).intent,
      uid,
      [0o600, 0o400],
    ),
  );
}

async function readReview(
  command: Readonly<
    | LocalReconciliationApplicationPrepareCommand
    | LocalReconciliationApplicationCommitCommand
  >,
  reviewId: string,
  uid: number,
): Promise<Readonly<LocalReconciliationReviewTerminal>> {
  const terminal = await readLocalReconciliationReviewTerminal(
    command.options.reviewRoot,
    reviewId,
    command.options.issuerKeyringPath,
    uid,
  );
  if (
    terminal.intent.command.options.deploymentRoot !==
      command.options.deploymentRoot ||
    terminal.intent.command.options.captureRoot !==
      command.options.captureRoot ||
    terminal.intent.command.options.planRoot !== command.options.planRoot ||
    terminal.intent.command.options.reviewRoot !== command.options.reviewRoot ||
    terminal.intent.command.options.allowRootService !==
      command.options.allowRootService
  ) {
    configurationError(
      'reconciliation application is detached from review roots',
    );
  }
  return terminal;
}

function buildIntent(
  command: Readonly<LocalReconciliationApplicationPrepareCommand>,
  terminal: Readonly<LocalReconciliationReviewTerminal>,
): Readonly<LocalReconciliationApplicationIntent> {
  if (
    terminal.review.reviewId !== command.request.reviewId ||
    terminal.review.reviewDigest !== command.request.expectedReviewDigest ||
    terminal.authorization.authorizationDigest !==
      terminal.review.authorizationDigest ||
    command.request.preparedAtMs < terminal.review.committedAtMs
  ) {
    configurationError(
      'reconciliation application is detached from its review',
    );
  }
  const payload = Object.freeze({
    schema: INTENT_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_application_prepared' as const,
    command,
    profile: terminal.intent.profile,
    instanceId: terminal.intent.instanceId,
    cutoverId: terminal.intent.cutoverId,
    generation: terminal.intent.generation,
    activationDigest: terminal.intent.activationDigest,
    reviewDigest: terminal.review.reviewDigest,
    authorizationDigest: terminal.authorization.authorizationDigest,
    decisionSetDigest: terminal.authorization.decisionSetDigest,
    decisionCount: terminal.authorization.decisionCount,
    reviewedHeadDigest: command.request.expectedHeadDigest,
  });
  return Object.freeze({
    ...payload,
    preparationDigest: cutoverDigest(payload),
  });
}

function validateHeadIdentity(
  head: Readonly<LocalCutoverInstanceHead>,
  intent: Readonly<LocalReconciliationApplicationIntent>,
): void {
  if (
    head.profile !== intent.profile ||
    head.cutoverId !== intent.cutoverId ||
    head.activationDigest !== intent.activationDigest ||
    head.generation !== intent.generation
  ) {
    configurationError(
      'reconciliation application instance head identity drifted',
    );
  }
}

function advanceApplicationHead(
  intent: Readonly<LocalReconciliationApplicationIntent>,
  uid: number,
  state:
    | 'reconciliation_application_prepared'
    | 'reconciliation_application_planned',
  requestedAtMs: number,
  sourceRecordDigest: string,
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

export async function prepareLocalReconciliationApplication(
  input: unknown,
  dependencies: LocalReconciliationApplicationDependencies = {},
): Promise<Readonly<LocalReconciliationApplicationPrepareResult>> {
  const command = normalizeLocalReconciliationApplicationPrepareCommand(input);
  const identity = currentIdentity();
  validatePrivateDirectory(
    command.options.deploymentRoot,
    identity.uid,
    'deploymentRoot',
  );
  validatePrivateDirectory(
    command.options.captureRoot,
    identity.uid,
    'captureRoot',
  );
  validatePrivateDirectory(command.options.planRoot, identity.uid, 'planRoot');
  validatePrivateDirectory(
    command.options.reviewRoot,
    identity.uid,
    'reviewRoot',
  );
  validatePrivateDirectory(
    command.options.applicationRoot,
    identity.uid,
    'applicationRoot',
  );
  const review = await readReview(
    command,
    command.request.reviewId,
    identity.uid,
  );
  const intent = buildIntent(command, review);
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    identity.uid,
  );
  validateHeadIdentity(head, intent);
  if (
    (head.state === 'reconciliation_reviewed' &&
      (head.headDigest !== command.request.expectedHeadDigest ||
        head.sourceRecordDigest !== intent.reviewDigest)) ||
    (head.state === 'reconciliation_application_prepared' &&
      head.sourceRecordDigest !== intent.preparationDigest) ||
    (head.state !== 'reconciliation_reviewed' &&
      head.state !== 'reconciliation_application_prepared')
  ) {
    configurationError(
      'application prepare lost reviewed head compare-and-swap',
    );
  }
  const selected = ensureApplicationDirectory(
    command.options.applicationRoot,
    command.request.applicationId,
    identity.uid,
  );
  const serialized = contents(intent);
  preflightPublishedFile(
    selected.intent,
    serialized,
    0o600,
    identity.uid,
    'reconciliation application intent',
  );
  const nextHead =
    head.state === 'reconciliation_application_prepared'
      ? head
      : advanceApplicationHead(
          intent,
          identity.uid,
          'reconciliation_application_prepared',
          command.request.preparedAtMs,
          intent.preparationDigest,
        );
  dependencies.afterHeadPrepared?.();
  const status = publishExactFile(
    selected.intent,
    serialized,
    0o600,
    identity.uid,
    'reconciliation application intent',
  );
  validateCatalog(selected, false);
  return Object.freeze({
    schemaVersion: 1,
    operation: command.operation,
    status,
    state: 'reconciliation_application_prepared',
    applicationId: command.request.applicationId,
    preparationDigest: intent.preparationDigest,
    instanceHeadDigest: nextHead.headDigest,
  });
}

function validateCommitBinding(
  command: Readonly<LocalReconciliationApplicationCommitCommand>,
  intent: Readonly<LocalReconciliationApplicationIntent>,
): void {
  const prepared = intent.command;
  if (
    prepared.options.deploymentRoot !== command.options.deploymentRoot ||
    prepared.options.captureRoot !== command.options.captureRoot ||
    prepared.options.planRoot !== command.options.planRoot ||
    prepared.options.reviewRoot !== command.options.reviewRoot ||
    prepared.options.applicationRoot !== command.options.applicationRoot ||
    prepared.options.issuerKeyringPath !== command.options.issuerKeyringPath ||
    prepared.options.allowRootService !== command.options.allowRootService ||
    prepared.request.applicationId !== command.request.applicationId ||
    intent.preparationDigest !== command.request.expectedPreparationDigest ||
    command.request.committedAtMs < prepared.request.preparedAtMs
  ) {
    configurationError('application commit is detached from preparation');
  }
}

function validateReviewBinding(
  intent: Readonly<LocalReconciliationApplicationIntent>,
  terminal: Readonly<LocalReconciliationReviewTerminal>,
): void {
  if (
    terminal.review.reviewId !== intent.command.request.reviewId ||
    terminal.review.reviewDigest !== intent.reviewDigest ||
    terminal.authorization.authorizationDigest !== intent.authorizationDigest ||
    terminal.authorization.decisionSetDigest !== intent.decisionSetDigest ||
    terminal.authorization.decisionCount !== intent.decisionCount
  ) {
    configurationError('application lost its signed review binding');
  }
}

function validateTerminalBinding(
  intent: Readonly<LocalReconciliationApplicationIntent>,
  review: Readonly<LocalReconciliationReviewTerminal>,
  terminal: Readonly<TerminalApplication>,
): void {
  const { plan, receipt } = terminal;
  if (
    plan.applicationId !== intent.command.request.applicationId ||
    plan.reviewId !== intent.command.request.reviewId ||
    plan.profile !== intent.profile ||
    plan.preparationDigest !== intent.preparationDigest ||
    plan.reviewDigest !== intent.reviewDigest ||
    plan.authorizationDigest !== intent.authorizationDigest ||
    plan.decisionSetDigest !== intent.decisionSetDigest ||
    plan.decisionCount !== intent.decisionCount ||
    receipt.applicationId !== plan.applicationId ||
    receipt.reviewId !== plan.reviewId ||
    receipt.preparationDigest !== plan.preparationDigest ||
    receipt.preparedHeadDigest !== plan.preparedHeadDigest ||
    receipt.reviewDigest !== plan.reviewDigest ||
    receipt.authorizationDigest !== plan.authorizationDigest ||
    receipt.decisionSetDigest !== plan.decisionSetDigest ||
    receipt.decisionCount !== plan.decisionCount ||
    receipt.applicationPlanDigest !== plan.applicationPlanDigest ||
    receipt.outcome !== plan.outcome ||
    receipt.committedAtMs !== plan.committedAtMs ||
    review.review.reviewDigest !== plan.reviewDigest ||
    review.authorization.authorizationDigest !== plan.authorizationDigest ||
    review.authorization.decisionSetDigest !== plan.decisionSetDigest ||
    review.authorization.decisionCount !== plan.decisionCount
  ) {
    configurationError('terminal reconciliation application binding drifted');
  }
}

function readTerminalApplication(
  selected: Readonly<ApplicationPaths>,
  intent: Readonly<LocalReconciliationApplicationIntent>,
  review: Readonly<LocalReconciliationReviewTerminal>,
  uid: number,
  allowedModes: readonly number[],
): Readonly<TerminalApplication> {
  const plan = normalizeLocalReconciliationApplicationPlan(
    terminalJson(selected.plan, uid, allowedModes),
  );
  const receipt = normalizeLocalReconciliationApplicationPlanReceipt(
    terminalJson(selected.receipt, uid, allowedModes),
  );
  const terminal = Object.freeze({ plan, receipt });
  validateTerminalBinding(intent, review, terminal);
  return terminal;
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
      configurationError('application terminal file cannot be sealed');
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
      configurationError('application terminal file changed while sealing');
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
    'application terminal directory',
  );
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    if (mode !== 0o500) fs.fchmodSync(descriptor, 0o500);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sealTerminal(selected: Readonly<ApplicationPaths>, uid: number): void {
  if (fs.readdirSync(selected.staging).length !== 0) {
    configurationError(
      'application staging must be empty before terminal seal',
    );
  }
  for (const filePath of [selected.intent, selected.plan, selected.receipt]) {
    sealFile(filePath, uid);
  }
  sealDirectory(selected.staging, uid);
  sealDirectory(selected.root, uid);
  validateCatalog(selected, true);
}

function result(
  operation: LocalReconciliationApplicationTerminalResult['operation'],
  status: LocalReconciliationApplicationTerminalResult['status'],
  terminal: Readonly<TerminalApplication>,
  head: Readonly<LocalCutoverInstanceHead>,
): Readonly<LocalReconciliationApplicationTerminalResult> {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    status,
    state: 'reconciliation_application_planned',
    applicationId: terminal.plan.applicationId,
    applicationPlanDigest: terminal.plan.applicationPlanDigest,
    outcome: terminal.plan.outcome,
    domainCount: 8,
    instanceHeadDigest: head.headDigest,
  });
}

export async function commitLocalReconciliationApplication(
  input: unknown,
  dependencies: LocalReconciliationApplicationDependencies = {},
): Promise<Readonly<LocalReconciliationApplicationTerminalResult>> {
  const command = normalizeLocalReconciliationApplicationCommitCommand(input);
  const identity = currentIdentity();
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.captureRoot, 'captureRoot'],
    [command.options.planRoot, 'planRoot'],
    [command.options.reviewRoot, 'reviewRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
  ] as const) {
    validatePrivateDirectory(directory, identity.uid, label);
  }
  const selected = applicationPaths(
    command.options.applicationRoot,
    command.request.applicationId,
  );
  validateDirectory(
    selected.root,
    identity.uid,
    [0o700, 0o500],
    'reconciliationApplicationDirectory',
  );
  validateDirectory(
    selected.staging,
    identity.uid,
    [0o700, 0o500],
    'reconciliationApplicationStaging',
  );
  const intent = readLocalReconciliationApplicationIntent(
    command.options.applicationRoot,
    command.request.applicationId,
  );
  validateCommitBinding(command, intent);
  const review = await readReview(
    command,
    intent.command.request.reviewId,
    identity.uid,
  );
  validateReviewBinding(intent, review);
  let head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    identity.uid,
  );
  validateHeadIdentity(head, intent);
  if (fs.existsSync(selected.receipt)) {
    const terminal = readTerminalApplication(
      selected,
      intent,
      review,
      identity.uid,
      [0o600, 0o400],
    );
    if (
      terminal.plan.committedAtMs !== command.request.committedAtMs ||
      terminal.plan.preparedHeadDigest !== command.request.expectedHeadDigest ||
      (head.state !== 'reconciliation_application_prepared' &&
        head.state !== 'reconciliation_application_planned') ||
      (head.state === 'reconciliation_application_prepared' &&
        (head.headDigest !== terminal.plan.preparedHeadDigest ||
          head.sourceRecordDigest !== intent.preparationDigest)) ||
      (head.state === 'reconciliation_application_planned' &&
        head.sourceRecordDigest !== terminal.plan.applicationPlanDigest)
    ) {
      configurationError('terminal application lost instance head binding');
    }
    sealTerminal(selected, identity.uid);
    dependencies.afterTerminalSealed?.();
    const existing = head.state === 'reconciliation_application_planned';
    head = existing
      ? head
      : advanceApplicationHead(
          intent,
          identity.uid,
          'reconciliation_application_planned',
          terminal.plan.committedAtMs,
          terminal.plan.applicationPlanDigest,
        );
    dependencies.afterHeadAdvanced?.();
    return result(
      command.operation,
      existing ? 'existing' : 'prepared',
      terminal,
      head,
    );
  }
  if (
    head.state !== 'reconciliation_application_prepared' ||
    head.headDigest !== command.request.expectedHeadDigest ||
    head.sourceRecordDigest !== intent.preparationDigest
  ) {
    configurationError(
      'application commit lost prepared head compare-and-swap',
    );
  }
  validateCatalog(selected, false);
  let plan: Readonly<LocalReconciliationApplicationPlan>;
  if (fs.existsSync(selected.plan)) {
    plan = normalizeLocalReconciliationApplicationPlan(
      terminalJson(selected.plan, identity.uid, [0o600]),
    );
    if (
      plan.applicationId !== command.request.applicationId ||
      plan.preparationDigest !== intent.preparationDigest ||
      plan.preparedHeadDigest !== command.request.expectedHeadDigest ||
      plan.reviewDigest !== intent.reviewDigest ||
      plan.committedAtMs !== command.request.committedAtMs
    ) {
      configurationError('published application plan lost its preparation');
    }
  } else {
    plan = buildLocalReconciliationApplicationPlan(
      intent,
      review.authorization,
      command.request.committedAtMs,
      command.request.expectedHeadDigest,
    );
    publishExactFile(
      selected.plan,
      contents(plan),
      0o600,
      identity.uid,
      'reconciliation application plan',
    );
    dependencies.afterPlanPublished?.();
  }
  const receipt = buildLocalReconciliationApplicationPlanReceipt(plan);
  publishExactFile(
    selected.receipt,
    contents(receipt),
    0o600,
    identity.uid,
    'reconciliation application receipt',
  );
  dependencies.afterReceiptPublished?.();
  const terminal = readTerminalApplication(
    selected,
    intent,
    review,
    identity.uid,
    [0o600],
  );
  sealTerminal(selected, identity.uid);
  dependencies.afterTerminalSealed?.();
  head = advanceApplicationHead(
    intent,
    identity.uid,
    'reconciliation_application_planned',
    plan.committedAtMs,
    plan.applicationPlanDigest,
  );
  dependencies.afterHeadAdvanced?.();
  return result(command.operation, 'prepared', terminal, head);
}

export async function verifyLocalReconciliationApplication(
  input: unknown,
): Promise<Readonly<LocalReconciliationApplicationTerminalResult>> {
  const command = normalizeLocalReconciliationApplicationVerifyCommand(input);
  const identity = currentIdentity();
  for (const [directory, label] of [
    [command.options.deploymentRoot, 'deploymentRoot'],
    [command.options.captureRoot, 'captureRoot'],
    [command.options.planRoot, 'planRoot'],
    [command.options.reviewRoot, 'reviewRoot'],
    [command.options.applicationRoot, 'applicationRoot'],
  ] as const) {
    validatePrivateDirectory(directory, identity.uid, label);
  }
  const selected = applicationPaths(
    command.options.applicationRoot,
    command.request.applicationId,
  );
  validateDirectory(
    selected.root,
    identity.uid,
    [0o500],
    'reconciliationApplicationDirectory',
  );
  validateDirectory(
    selected.staging,
    identity.uid,
    [0o500],
    'reconciliationApplicationStaging',
  );
  validateCatalog(selected, true);
  const intent = readLocalReconciliationApplicationIntent(
    command.options.applicationRoot,
    command.request.applicationId,
  );
  const prepared = intent.command.options;
  if (
    prepared.deploymentRoot !== command.options.deploymentRoot ||
    prepared.captureRoot !== command.options.captureRoot ||
    prepared.planRoot !== command.options.planRoot ||
    prepared.reviewRoot !== command.options.reviewRoot ||
    prepared.applicationRoot !== command.options.applicationRoot ||
    prepared.issuerKeyringPath !== command.options.issuerKeyringPath ||
    prepared.allowRootService !== command.options.allowRootService
  ) {
    configurationError('application verify is detached from preparation');
  }
  const review = await readLocalReconciliationReviewTerminal(
    command.options.reviewRoot,
    intent.command.request.reviewId,
    command.options.issuerKeyringPath,
    identity.uid,
  );
  validateReviewBinding(intent, review);
  const terminal = readTerminalApplication(
    selected,
    intent,
    review,
    identity.uid,
    [0o400],
  );
  if (
    terminal.plan.applicationPlanDigest !==
    command.request.expectedApplicationPlanDigest
  ) {
    configurationError('application verify expected digest drifted');
  }
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    identity.uid,
  );
  validateHeadIdentity(head, intent);
  if (
    head.state !== 'reconciliation_application_planned' ||
    head.sourceRecordDigest !== terminal.plan.applicationPlanDigest
  ) {
    configurationError('application verify lost terminal instance head');
  }
  return result(command.operation, 'verified', terminal, head);
}

export async function prepareLocalReconciliationApplicationCommandFile(
  filePath: string,
): Promise<Readonly<LocalReconciliationApplicationPrepareResult>> {
  return prepareLocalReconciliationApplication(
    readPrivateLocalCommandFile(filePath),
  );
}

export async function commitLocalReconciliationApplicationCommandFile(
  filePath: string,
): Promise<Readonly<LocalReconciliationApplicationTerminalResult>> {
  return commitLocalReconciliationApplication(
    readPrivateLocalCommandFile(filePath),
  );
}

export async function verifyLocalReconciliationApplicationCommandFile(
  filePath: string,
): Promise<Readonly<LocalReconciliationApplicationTerminalResult>> {
  return verifyLocalReconciliationApplication(
    readPrivateLocalCommandFile(filePath),
  );
}
