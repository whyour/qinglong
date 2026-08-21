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
import { readLocalReconciliationPlanTerminal } from '../planning/preparation';
import {
  withLocalReconciliationSealedDatabase,
  type LocalReconciliationSealedBundleReaderDependencies,
} from '../sealed-bundle/reader';
import {
  normalizeLocalReconciliationReviewDiagnosticsCommand,
  normalizeLocalReconciliationReviewPrepareCommand,
  type LocalReconciliationReviewDiagnosticsCommand,
  type LocalReconciliationReviewDiagnosticsResult,
  type LocalReconciliationReviewPrepareCommand,
  type LocalReconciliationReviewPrepareResult,
} from './contract';
import {
  buildLocalReconciliationDiagnosticPage,
  publishLocalReconciliationDiagnosticPage,
} from './diagnostics';

const INTENT_SCHEMA = 'qinglong3-local-reconciliation-review-intent';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_REVIEWS = 64;

export interface LocalReconciliationReviewIntent {
  readonly schema: typeof INTENT_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_review_prepared';
  readonly command: Readonly<LocalReconciliationReviewPrepareCommand>;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly cutoverId: string;
  readonly generation: number;
  readonly activationDigest: string;
  readonly bundleDigest: string;
  readonly bundleFingerprintDigest: string;
  readonly planReceiptDigest: string;
  readonly plannedHeadDigest: string;
  readonly preparationDigest: string;
}

export interface LocalReconciliationReviewDependencies
  extends LocalReconciliationSealedBundleReaderDependencies {
  readonly afterHeadPrepared?: () => void;
  readonly beforeDiagnosticPublish?: () => void;
  readonly afterDiagnosticPublish?: () => void;
}

interface LocalReconciliationReviewPaths {
  readonly root: string;
  readonly staging: string;
  readonly intent: string;
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(message);
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

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function localReconciliationReviewDirectory(
  reviewRoot: string,
  reviewId: string,
): string {
  return path.join(reviewRoot, reviewId);
}

function reviewPaths(
  reviewRoot: string,
  reviewId: string,
): Readonly<LocalReconciliationReviewPaths> {
  const root = localReconciliationReviewDirectory(reviewRoot, reviewId);
  return Object.freeze({
    root,
    staging: path.join(root, 'staging'),
    intent: path.join(root, 'intent.json'),
  });
}

function ensureReviewDirectory(
  reviewRoot: string,
  reviewId: string,
  uid: number,
): Readonly<LocalReconciliationReviewPaths> {
  const paths = reviewPaths(reviewRoot, reviewId);
  const entries = fs.readdirSync(reviewRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      configurationError('reconciliation review catalog contains drift');
    }
  }
  if (entries.length >= MAX_REVIEWS && !fs.existsSync(paths.root)) {
    configurationError('reconciliation review retention limit is reached');
  }
  ensurePrivateDirectory(paths.root, uid, 'reconciliationReviewDirectory');
  ensurePrivateDirectory(paths.staging, uid, 'reconciliationReviewStaging');
  return paths;
}

function validateCatalog(paths: Readonly<LocalReconciliationReviewPaths>): void {
  const allowed = new Set([
    'intent.json',
    'staging',
    '.intent.json.ql3-deploy-stage',
  ]);
  for (const entry of fs.readdirSync(paths.root, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || entry.isSymbolicLink()) {
      configurationError('reconciliation review root contains unknown material');
    }
  }
  if (fs.readdirSync(paths.staging).length !== 0) {
    configurationError('reconciliation review staging contains unknown material');
  }
}

function buildIntent(
  command: Readonly<LocalReconciliationReviewPrepareCommand>,
  terminal: ReturnType<typeof readLocalReconciliationPlanTerminal>,
): Readonly<LocalReconciliationReviewIntent> {
  if (
    terminal.intent.command.options.deploymentRoot !==
      command.options.deploymentRoot ||
    terminal.intent.command.options.captureRoot !== command.options.captureRoot ||
    terminal.intent.command.options.planRoot !== command.options.planRoot ||
    terminal.intent.command.options.allowRootService !==
      command.options.allowRootService ||
    terminal.plan.planId !== command.request.planId ||
    terminal.plan.planDigest !== command.request.expectedPlanDigest ||
    command.request.preparedAtMs < terminal.plan.committedAtMs
  ) {
    configurationError('reconciliation review is detached from its plan');
  }
  const payload = Object.freeze({
    schema: INTENT_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_review_prepared' as const,
    command,
    profile: terminal.plan.profile,
    instanceId: terminal.intent.instanceId,
    cutoverId: terminal.intent.cutoverId,
    generation: terminal.intent.generation,
    activationDigest: terminal.intent.activationDigest,
    bundleDigest: terminal.plan.bundleDigest,
    bundleFingerprintDigest: terminal.bundle.fingerprintDigest,
    planReceiptDigest: terminal.receipt.receiptDigest,
    plannedHeadDigest: command.request.expectedHeadDigest,
  });
  return Object.freeze({ ...payload, preparationDigest: cutoverDigest(payload) });
}

export function normalizeLocalReconciliationReviewIntent(
  value: unknown,
): Readonly<LocalReconciliationReviewIntent> {
  const intent = object(value, 'reconciliation review intent');
  exact(
    intent,
    [
      'activationDigest',
      'bundleDigest',
      'bundleFingerprintDigest',
      'command',
      'cutoverId',
      'generation',
      'instanceId',
      'planReceiptDigest',
      'plannedHeadDigest',
      'preparationDigest',
      'profile',
      'schema',
      'schemaVersion',
      'state',
    ],
    'reconciliation review intent',
  );
  const command = normalizeLocalReconciliationReviewPrepareCommand(intent.command);
  const { preparationDigest, ...payload } = intent;
  if (
    intent.schema !== INTENT_SCHEMA ||
    intent.schemaVersion !== 1 ||
    intent.state !== 'reconciliation_review_prepared' ||
    (intent.profile !== 'edge' && intent.profile !== 'standalone') ||
    typeof intent.instanceId !== 'string' ||
    intent.instanceId.length < 1 ||
    intent.instanceId.length > 128 ||
    typeof intent.cutoverId !== 'string' ||
    intent.cutoverId.length < 1 ||
    intent.cutoverId.length > 128 ||
    !Number.isSafeInteger(intent.generation) ||
    (intent.generation as number) < 1 ||
    [
      intent.activationDigest,
      intent.bundleDigest,
      intent.bundleFingerprintDigest,
      intent.planReceiptDigest,
      intent.plannedHeadDigest,
      preparationDigest,
    ].some(
      (candidate) =>
        typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate),
    ) ||
    cutoverDigest(payload) !== preparationDigest
  ) {
    configurationError('reconciliation review intent drifted');
  }
  return Object.freeze({
    ...(intent as unknown as LocalReconciliationReviewIntent),
    command,
  });
}

export function readLocalReconciliationReviewIntent(
  reviewRoot: string,
  reviewId: string,
): Readonly<LocalReconciliationReviewIntent> {
  return normalizeLocalReconciliationReviewIntent(
    readPrivateLocalCommandFile(reviewPaths(reviewRoot, reviewId).intent),
  );
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

function advancePreparedHead(
  intent: Readonly<LocalReconciliationReviewIntent>,
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
        requestedAtMs: intent.command.request.preparedAtMs,
      },
    },
    uid,
    'reconciliation_review_prepared',
    intent.generation,
    intent.preparationDigest,
  );
}

export function prepareLocalReconciliationReview(
  input: unknown,
  dependencies: LocalReconciliationReviewDependencies = {},
): Readonly<LocalReconciliationReviewPrepareResult> {
  const command = normalizeLocalReconciliationReviewPrepareCommand(input);
  const identity = currentIdentity();
  validatePrivateDirectory(command.options.deploymentRoot, identity.uid, 'deploymentRoot');
  validatePrivateDirectory(command.options.captureRoot, identity.uid, 'captureRoot');
  validatePrivateDirectory(command.options.planRoot, identity.uid, 'planRoot');
  validatePrivateDirectory(command.options.reviewRoot, identity.uid, 'reviewRoot');
  const terminal = readLocalReconciliationPlanTerminal(
    command.options.planRoot,
    command.request.planId,
    identity.uid,
  );
  const intent = buildIntent(command, terminal);
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    identity.uid,
  );
  validateHeadIdentity(head, intent);
  if (
    (head.state === 'reconciliation_planned' &&
      (head.headDigest !== command.request.expectedHeadDigest ||
        head.sourceRecordDigest !== command.request.expectedPlanDigest)) ||
    (head.state === 'reconciliation_review_prepared' &&
      head.sourceRecordDigest !== intent.preparationDigest) ||
    (head.state !== 'reconciliation_planned' &&
      head.state !== 'reconciliation_review_prepared')
  ) {
    configurationError('review prepare lost the planned instance head compare-and-swap');
  }
  const paths = ensureReviewDirectory(
    command.options.reviewRoot,
    command.request.reviewId,
    identity.uid,
  );
  const serialized = contents(intent);
  preflightPublishedFile(
    paths.intent,
    serialized,
    0o600,
    identity.uid,
    'reconciliation review intent',
  );
  const nextHead =
    head.state === 'reconciliation_review_prepared'
      ? head
      : advancePreparedHead(intent, identity.uid);
  dependencies.afterHeadPrepared?.();
  const status = publishExactFile(
    paths.intent,
    serialized,
    0o600,
    identity.uid,
    'reconciliation review intent',
  );
  validateCatalog(paths);
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status,
    state: 'reconciliation_review_prepared' as const,
    reviewId: command.request.reviewId,
    preparationDigest: intent.preparationDigest,
    instanceHeadDigest: nextHead.headDigest,
  });
}

function validateDiagnosticsBinding(
  command: Readonly<LocalReconciliationReviewDiagnosticsCommand>,
  intent: Readonly<LocalReconciliationReviewIntent>,
): void {
  if (
    intent.command.options.deploymentRoot !== command.options.deploymentRoot ||
    intent.command.options.captureRoot !== command.options.captureRoot ||
    intent.command.options.planRoot !== command.options.planRoot ||
    intent.command.options.reviewRoot !== command.options.reviewRoot ||
    intent.command.options.allowRootService !== command.options.allowRootService ||
    intent.command.request.reviewId !== command.request.reviewId ||
    intent.preparationDigest !== command.request.expectedPreparationDigest
  ) {
    configurationError('review diagnostics are detached from preparation');
  }
  const roots = [
    command.options.deploymentRoot,
    command.options.captureRoot,
    command.options.planRoot,
    command.options.reviewRoot,
  ];
  if (
    roots.some(
      (root) =>
        overlaps(root, command.request.outputPath) ||
        overlaps(command.request.outputPath, root),
    )
  ) {
    configurationError('diagnostic output must be outside authority roots');
  }
}

export function writeLocalReconciliationReviewDiagnostics(
  input: unknown,
  dependencies: LocalReconciliationReviewDependencies = {},
): Readonly<LocalReconciliationReviewDiagnosticsResult> {
  const command = normalizeLocalReconciliationReviewDiagnosticsCommand(input);
  const identity = currentIdentity();
  validatePrivateDirectory(command.options.deploymentRoot, identity.uid, 'deploymentRoot');
  validatePrivateDirectory(command.options.captureRoot, identity.uid, 'captureRoot');
  validatePrivateDirectory(command.options.planRoot, identity.uid, 'planRoot');
  validatePrivateDirectory(command.options.reviewRoot, identity.uid, 'reviewRoot');
  const paths = reviewPaths(command.options.reviewRoot, command.request.reviewId);
  validatePrivateDirectory(paths.root, identity.uid, 'reconciliationReviewDirectory');
  validatePrivateDirectory(paths.staging, identity.uid, 'reconciliationReviewStaging');
  const intent = readLocalReconciliationReviewIntent(
    command.options.reviewRoot,
    command.request.reviewId,
  );
  validateDiagnosticsBinding(command, intent);
  const terminal = readLocalReconciliationPlanTerminal(
    command.options.planRoot,
    intent.command.request.planId,
    identity.uid,
  );
  if (
    terminal.plan.planDigest !== intent.command.request.expectedPlanDigest ||
    terminal.plan.bundleDigest !== intent.bundleDigest ||
    terminal.receipt.receiptDigest !== intent.planReceiptDigest ||
    terminal.bundle.fingerprintDigest !== intent.bundleFingerprintDigest
  ) {
    configurationError('review diagnostics lost the terminal plan binding');
  }
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    identity.uid,
  );
  validateHeadIdentity(head, intent);
  if (
    head.state !== 'reconciliation_review_prepared' ||
    head.sourceRecordDigest !== intent.preparationDigest
  ) {
    configurationError('review diagnostics lost the prepared instance head');
  }
  const page = withLocalReconciliationSealedDatabase(
    terminal.bundle,
    command.request.database,
    identity.uid,
    dependencies,
    (client) =>
      buildLocalReconciliationDiagnosticPage(client, {
        reviewId: intent.command.request.reviewId,
        planId: intent.command.request.planId,
        planDigest: terminal.plan.planDigest,
        preparationDigest: intent.preparationDigest,
        bundle: terminal.bundle,
        command,
      }),
  );
  if (page === null) {
    configurationError('manual-required SQLite topology has no diagnostic page');
  }
  const currentHead = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    identity.uid,
  );
  if (
    currentHead.headDigest !== head.headDigest ||
    currentHead.state !== 'reconciliation_review_prepared' ||
    currentHead.sourceRecordDigest !== intent.preparationDigest
  ) {
    configurationError('review diagnostics instance head changed while reading');
  }
  dependencies.beforeDiagnosticPublish?.();
  const status = publishLocalReconciliationDiagnosticPage(
    command.request.outputPath,
    page,
    identity.uid,
  );
  dependencies.afterDiagnosticPublish?.();
  validateCatalog(paths);
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status,
    state: 'reconciliation_review_prepared' as const,
    reviewId: command.request.reviewId,
    pageDigest: page.pageDigest,
    recordCount: page.recordCount,
    complete: page.complete,
    nextOffset: page.nextOffset,
    instanceHeadDigest: currentHead.headDigest,
  });
}

export function prepareLocalReconciliationReviewCommandFile(
  filePath: string,
): Readonly<LocalReconciliationReviewPrepareResult> {
  return prepareLocalReconciliationReview(readPrivateLocalCommandFile(filePath));
}

export function writeLocalReconciliationReviewDiagnosticsCommandFile(
  filePath: string,
): Readonly<LocalReconciliationReviewDiagnosticsResult> {
  return writeLocalReconciliationReviewDiagnostics(
    readPrivateLocalCommandFile(filePath),
  );
}
