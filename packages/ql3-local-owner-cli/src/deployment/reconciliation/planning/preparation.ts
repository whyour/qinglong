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
import {
  inspectLocalReconciliationSealedBundle,
  type LocalReconciliationSealedBundle,
  type LocalReconciliationSealedBundleReaderDependencies,
} from '../sealed-bundle/reader';
import { readLocalReconciliationCaptureIntent } from '../preparation';
import {
  normalizeLocalReconciliationPlanCommitCommand,
  normalizeLocalReconciliationPlanPrepareCommand,
  normalizeLocalReconciliationPlanVerifyCommand,
  type LocalReconciliationPlanCommitCommand,
  type LocalReconciliationPlanPrepareCommand,
  type LocalReconciliationPlanPrepareResult,
  type LocalReconciliationPlanTerminalResult,
} from './contract';
import { inventoryLocalReconciliationSealedBundle } from './inventory';
import {
  buildLocalReconciliationPlan,
  localReconciliationPlanReceipt,
  normalizeLocalReconciliationPlan,
  normalizeLocalReconciliationPlanReceipt,
  type LocalReconciliationPlan,
  type LocalReconciliationPlanReceipt,
} from './plan';

const INTENT_SCHEMA = 'qinglong3-local-reconciliation-plan-intent';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PLANS = 64;

export interface LocalReconciliationPlanIntent {
  readonly schema: typeof INTENT_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_plan_prepared';
  readonly command: Readonly<LocalReconciliationPlanPrepareCommand>;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly cutoverId: string;
  readonly generation: number;
  readonly activationDigest: string;
  readonly captureManifestDigest: string;
  readonly captureFingerprintDigest: string;
  readonly capturedHeadDigest: string;
  readonly preparationDigest: string;
}

export interface LocalReconciliationPlanDependencies
  extends LocalReconciliationSealedBundleReaderDependencies {
  readonly afterHeadPrepared?: () => void;
  readonly afterPlanPublished?: () => void;
  readonly afterReceiptPublished?: () => void;
  readonly afterHeadAdvanced?: () => void;
}

interface LocalReconciliationPlanPaths {
  readonly root: string;
  readonly staging: string;
  readonly intent: string;
  readonly plan: string;
  readonly receipt: string;
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

export function localReconciliationPlanDirectory(
  planRoot: string,
  planId: string,
): string {
  return path.join(planRoot, planId);
}

function planPaths(planRoot: string, planId: string): LocalReconciliationPlanPaths {
  const root = localReconciliationPlanDirectory(planRoot, planId);
  return Object.freeze({
    root,
    staging: path.join(root, 'staging'),
    intent: path.join(root, 'intent.json'),
    plan: path.join(root, 'plan.json'),
    receipt: path.join(root, 'receipt.json'),
  });
}

function ensurePlanDirectory(
  planRoot: string,
  planId: string,
  uid: number,
): Readonly<LocalReconciliationPlanPaths> {
  const paths = planPaths(planRoot, planId);
  const entries = fs.readdirSync(planRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      configurationError('reconciliation plan catalog contains drift');
    }
  }
  if (entries.length >= MAX_PLANS && !fs.existsSync(paths.root)) {
    configurationError('reconciliation plan retention limit is reached');
  }
  ensurePrivateDirectory(paths.root, uid, 'reconciliationPlanDirectory');
  ensurePrivateDirectory(paths.staging, uid, 'reconciliationPlanStaging');
  return paths;
}

function validateCatalog(
  paths: Readonly<LocalReconciliationPlanPaths>,
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
  for (const entry of fs.readdirSync(paths.root, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || entry.isSymbolicLink()) {
      configurationError('reconciliation plan root contains unknown material');
    }
  }
  if (fs.readdirSync(paths.staging).length !== 0) {
    configurationError('reconciliation plan staging contains unknown material');
  }
}

function contents(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function normalizeLocalReconciliationPlanIntent(
  value: unknown,
): Readonly<LocalReconciliationPlanIntent> {
  const intent = object(value, 'reconciliation plan intent');
  exact(
    intent,
    [
      'activationDigest',
      'captureFingerprintDigest',
      'captureManifestDigest',
      'capturedHeadDigest',
      'command',
      'cutoverId',
      'generation',
      'instanceId',
      'preparationDigest',
      'profile',
      'schema',
      'schemaVersion',
      'state',
    ],
    'reconciliation plan intent',
  );
  const command = normalizeLocalReconciliationPlanPrepareCommand(intent.command);
  const { preparationDigest, ...payload } = intent;
  if (
    intent.schema !== INTENT_SCHEMA ||
    intent.schemaVersion !== 1 ||
    intent.state !== 'reconciliation_plan_prepared' ||
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
      intent.captureManifestDigest,
      intent.captureFingerprintDigest,
      intent.capturedHeadDigest,
      preparationDigest,
    ].some(
      (candidate) =>
        typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate),
    ) ||
    cutoverDigest(payload) !== preparationDigest
  ) {
    configurationError('reconciliation plan intent drifted');
  }
  return Object.freeze({
    ...(intent as unknown as LocalReconciliationPlanIntent),
    command,
  });
}

export function readLocalReconciliationPlanIntent(
  planRoot: string,
  planId: string,
): Readonly<LocalReconciliationPlanIntent> {
  return normalizeLocalReconciliationPlanIntent(
    readPrivateLocalCommandFile(planPaths(planRoot, planId).intent),
  );
}

function buildIntent(
  command: Readonly<LocalReconciliationPlanPrepareCommand>,
  bundle: Readonly<LocalReconciliationSealedBundle>,
): Readonly<LocalReconciliationPlanIntent> {
  const captureIntent = readLocalReconciliationCaptureIntent(
    command.options.captureRoot,
    command.request.captureId,
  );
  if (
    captureIntent.command.options.deploymentRoot !==
      command.options.deploymentRoot ||
    captureIntent.command.options.captureRoot !== command.options.captureRoot ||
    captureIntent.command.options.allowRootService !==
      command.options.allowRootService ||
    bundle.receipt.captureId !== command.request.captureId ||
    bundle.receipt.bundleDigest !== command.request.expectedBundleDigest ||
    command.request.preparedAtMs < bundle.manifest.committedAtMs
  ) {
    configurationError('reconciliation plan is detached from its capture');
  }
  const payload = Object.freeze({
    schema: INTENT_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_plan_prepared' as const,
    command,
    profile: captureIntent.command.request.profile,
    instanceId: captureIntent.command.request.instanceId,
    cutoverId: captureIntent.command.request.cutoverId,
    generation: captureIntent.command.request.generation,
    activationDigest: captureIntent.command.request.expectedActivationDigest,
    captureManifestDigest: bundle.manifest.manifestDigest,
    captureFingerprintDigest: bundle.fingerprintDigest,
    capturedHeadDigest: command.request.expectedHeadDigest,
  });
  return Object.freeze({ ...payload, preparationDigest: cutoverDigest(payload) });
}

function validateHeadIdentity(
  head: Readonly<LocalCutoverInstanceHead>,
  intent: Readonly<LocalReconciliationPlanIntent>,
): void {
  if (
    head.profile !== intent.profile ||
    head.cutoverId !== intent.cutoverId ||
    head.activationDigest !== intent.activationDigest ||
    head.generation !== intent.generation
  ) {
    configurationError('reconciliation plan instance head identity drifted');
  }
}

function advancePlanHead(
  intent: Readonly<LocalReconciliationPlanIntent>,
  uid: number,
  state: 'reconciliation_plan_prepared' | 'reconciliation_planned',
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

export function prepareLocalReconciliationPlan(
  input: unknown,
  dependencies: LocalReconciliationPlanDependencies = {},
): Readonly<LocalReconciliationPlanPrepareResult> {
  const command = normalizeLocalReconciliationPlanPrepareCommand(input);
  const identity = currentIdentity();
  validatePrivateDirectory(command.options.deploymentRoot, identity.uid, 'deploymentRoot');
  validatePrivateDirectory(command.options.captureRoot, identity.uid, 'captureRoot');
  validatePrivateDirectory(command.options.planRoot, identity.uid, 'planRoot');
  const bundle = inspectLocalReconciliationSealedBundle(
    command.options.captureRoot,
    command.request.captureId,
    identity.uid,
  );
  const intent = buildIntent(command, bundle);
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    identity.uid,
  );
  validateHeadIdentity(head, intent);
  if (
    (head.state === 'reconciliation_captured' &&
      (head.headDigest !== command.request.expectedHeadDigest ||
        head.sourceRecordDigest !== command.request.expectedBundleDigest)) ||
    (head.state === 'reconciliation_plan_prepared' &&
      head.sourceRecordDigest !== intent.preparationDigest) ||
    (head.state !== 'reconciliation_captured' &&
      head.state !== 'reconciliation_plan_prepared')
  ) {
    configurationError('plan prepare lost the captured instance head compare-and-swap');
  }
  const paths = ensurePlanDirectory(
    command.options.planRoot,
    command.request.planId,
    identity.uid,
  );
  const serialized = contents(intent);
  preflightPublishedFile(
    paths.intent,
    serialized,
    0o600,
    identity.uid,
    'reconciliation plan intent',
  );
  const nextHead =
    head.state === 'reconciliation_plan_prepared'
      ? head
      : advancePlanHead(
          intent,
          identity.uid,
          'reconciliation_plan_prepared',
          command.request.preparedAtMs,
          intent.preparationDigest,
        );
  dependencies.afterHeadPrepared?.();
  const status = publishExactFile(
    paths.intent,
    serialized,
    0o600,
    identity.uid,
    'reconciliation plan intent',
  );
  validateCatalog(paths, false);
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status,
    state: 'reconciliation_plan_prepared' as const,
    planId: command.request.planId,
    preparationDigest: intent.preparationDigest,
    instanceHeadDigest: nextHead.headDigest,
  });
}

function validateTerminalBinding(
  intent: Readonly<LocalReconciliationPlanIntent>,
  plan: Readonly<LocalReconciliationPlan>,
  receipt: Readonly<LocalReconciliationPlanReceipt>,
  bundle: Readonly<LocalReconciliationSealedBundle>,
): void {
  if (
    plan.planId !== intent.command.request.planId ||
    plan.captureId !== intent.command.request.captureId ||
    plan.profile !== intent.profile ||
    plan.preparationDigest !== intent.preparationDigest ||
    plan.bundleDigest !== intent.command.request.expectedBundleDigest ||
    plan.legacyTimezone !== intent.command.request.legacyTimezone ||
    plan.committedAtMs < intent.command.request.preparedAtMs ||
    receipt.planId !== plan.planId ||
    receipt.captureId !== plan.captureId ||
    receipt.preparationDigest !== plan.preparationDigest ||
    receipt.bundleDigest !== plan.bundleDigest ||
    receipt.planDigest !== plan.planDigest ||
    receipt.outcome !== plan.outcome ||
    receipt.committedAtMs !== plan.committedAtMs ||
    bundle.receipt.bundleDigest !== plan.bundleDigest ||
    bundle.manifest.manifestDigest !== intent.captureManifestDigest ||
    bundle.fingerprintDigest !== intent.captureFingerprintDigest
  ) {
    configurationError('terminal reconciliation plan binding drifted');
  }
}

function readTerminal(
  paths: Readonly<LocalReconciliationPlanPaths>,
  intent: Readonly<LocalReconciliationPlanIntent>,
  bundle: Readonly<LocalReconciliationSealedBundle>,
  uid: number,
): Readonly<{
  plan: Readonly<LocalReconciliationPlan>;
  receipt: Readonly<LocalReconciliationPlanReceipt>;
}> {
  validatePrivateDirectory(paths.root, uid, 'reconciliationPlanDirectory');
  validatePrivateDirectory(paths.staging, uid, 'reconciliationPlanStaging');
  const plan = normalizeLocalReconciliationPlan(
    readPrivateLocalCommandFile(paths.plan),
  );
  const receipt = normalizeLocalReconciliationPlanReceipt(
    readPrivateLocalCommandFile(paths.receipt),
  );
  validateTerminalBinding(intent, plan, receipt, bundle);
  validateCatalog(paths, true);
  return Object.freeze({ plan, receipt });
}

export interface LocalReconciliationPlanTerminal {
  readonly intent: Readonly<LocalReconciliationPlanIntent>;
  readonly bundle: Readonly<LocalReconciliationSealedBundle>;
  readonly plan: Readonly<LocalReconciliationPlan>;
  readonly receipt: Readonly<LocalReconciliationPlanReceipt>;
}

export function readLocalReconciliationPlanTerminal(
  planRoot: string,
  planId: string,
  uid: number,
): Readonly<LocalReconciliationPlanTerminal> {
  const paths = planPaths(planRoot, planId);
  const intent = readLocalReconciliationPlanIntent(planRoot, planId);
  if (
    intent.command.options.planRoot !== planRoot ||
    intent.command.request.planId !== planId
  ) {
    configurationError('terminal reconciliation plan path binding drifted');
  }
  const bundle = inspectLocalReconciliationSealedBundle(
    intent.command.options.captureRoot,
    intent.command.request.captureId,
    uid,
  );
  const terminal = readTerminal(paths, intent, bundle, uid);
  return Object.freeze({ intent, bundle, ...terminal });
}

function result(
  operation: LocalReconciliationPlanTerminalResult['operation'],
  status: LocalReconciliationPlanTerminalResult['status'],
  terminal: Readonly<{
    plan: Readonly<LocalReconciliationPlan>;
    receipt: Readonly<LocalReconciliationPlanReceipt>;
  }>,
  head: Readonly<LocalCutoverInstanceHead>,
): Readonly<LocalReconciliationPlanTerminalResult> {
  return Object.freeze({
    schemaVersion: 1 as const,
    operation,
    status,
    state: 'reconciliation_planned' as const,
    planId: terminal.plan.planId,
    planDigest: terminal.plan.planDigest,
    outcome: terminal.plan.outcome,
    domainCount: 8 as const,
    instanceHeadDigest: head.headDigest,
  });
}

function validateCommitBinding(
  command: Readonly<LocalReconciliationPlanCommitCommand>,
  intent: Readonly<LocalReconciliationPlanIntent>,
): void {
  if (
    intent.command.options.deploymentRoot !== command.options.deploymentRoot ||
    intent.command.options.captureRoot !== command.options.captureRoot ||
    intent.command.options.planRoot !== command.options.planRoot ||
    intent.command.options.allowRootService !== command.options.allowRootService ||
    intent.command.request.planId !== command.request.planId ||
    intent.preparationDigest !== command.request.expectedPreparationDigest ||
    command.request.committedAtMs < intent.command.request.preparedAtMs
  ) {
    configurationError('plan commit is not bound to its exact preparation');
  }
}

export function commitLocalReconciliationPlan(
  input: unknown,
  dependencies: LocalReconciliationPlanDependencies = {},
): Readonly<LocalReconciliationPlanTerminalResult> {
  const command = normalizeLocalReconciliationPlanCommitCommand(input);
  const identity = currentIdentity();
  validatePrivateDirectory(command.options.deploymentRoot, identity.uid, 'deploymentRoot');
  validatePrivateDirectory(command.options.captureRoot, identity.uid, 'captureRoot');
  validatePrivateDirectory(command.options.planRoot, identity.uid, 'planRoot');
  const paths = planPaths(command.options.planRoot, command.request.planId);
  validatePrivateDirectory(paths.root, identity.uid, 'reconciliationPlanDirectory');
  validatePrivateDirectory(paths.staging, identity.uid, 'reconciliationPlanStaging');
  const intent = readLocalReconciliationPlanIntent(
    command.options.planRoot,
    command.request.planId,
  );
  validateCommitBinding(command, intent);
  const bundle = inspectLocalReconciliationSealedBundle(
    command.options.captureRoot,
    intent.command.request.captureId,
    identity.uid,
  );
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    identity.uid,
  );
  validateHeadIdentity(head, intent);
  if (fs.existsSync(paths.receipt)) {
    const terminal = readTerminal(paths, intent, bundle, identity.uid);
    if (
      terminal.plan.committedAtMs !== command.request.committedAtMs ||
      (head.state !== 'reconciliation_plan_prepared' &&
        head.state !== 'reconciliation_planned') ||
      (head.state === 'reconciliation_plan_prepared' &&
        head.sourceRecordDigest !== intent.preparationDigest) ||
      (head.state === 'reconciliation_planned' &&
        head.sourceRecordDigest !== terminal.plan.planDigest)
    ) {
      configurationError('terminal plan lost its instance head binding');
    }
    const terminalHead =
      head.state === 'reconciliation_planned'
        ? head
        : advancePlanHead(
            intent,
            identity.uid,
            'reconciliation_planned',
            terminal.plan.committedAtMs,
            terminal.plan.planDigest,
          );
    dependencies.afterHeadAdvanced?.();
    return result(
      command.operation,
      head.state === 'reconciliation_planned' ? 'existing' : 'prepared',
      terminal,
      terminalHead,
    );
  }
  if (
    head.state !== 'reconciliation_plan_prepared' ||
    head.sourceRecordDigest !== intent.preparationDigest
  ) {
    configurationError('plan commit lost the prepared instance head fence');
  }
  let plan: Readonly<LocalReconciliationPlan>;
  if (fs.existsSync(paths.plan)) {
    plan = normalizeLocalReconciliationPlan(
      readPrivateLocalCommandFile(paths.plan),
    );
    if (
      plan.planId !== intent.command.request.planId ||
      plan.captureId !== intent.command.request.captureId ||
      plan.preparationDigest !== intent.preparationDigest ||
      plan.bundleDigest !== intent.command.request.expectedBundleDigest ||
      plan.committedAtMs !== command.request.committedAtMs
    ) {
      configurationError('published reconciliation plan lost its preparation');
    }
  } else {
    const inventory = inventoryLocalReconciliationSealedBundle(
      bundle,
      identity.uid,
      dependencies,
    );
    plan = buildLocalReconciliationPlan(
      intent,
      inventory,
      command.request.committedAtMs,
    );
    publishExactFile(
      paths.plan,
      contents(plan),
      0o600,
      identity.uid,
      'reconciliation plan',
    );
    dependencies.afterPlanPublished?.();
  }
  const receipt = localReconciliationPlanReceipt(plan);
  publishExactFile(
    paths.receipt,
    contents(receipt),
    0o600,
    identity.uid,
    'reconciliation plan receipt',
  );
  dependencies.afterReceiptPublished?.();
  const terminal = readTerminal(paths, intent, bundle, identity.uid);
  const terminalHead = advancePlanHead(
    intent,
    identity.uid,
    'reconciliation_planned',
    plan.committedAtMs,
    plan.planDigest,
  );
  dependencies.afterHeadAdvanced?.();
  return result(command.operation, 'prepared', terminal, terminalHead);
}

export function verifyLocalReconciliationPlan(
  input: unknown,
  dependencies: LocalReconciliationSealedBundleReaderDependencies = {},
): Readonly<LocalReconciliationPlanTerminalResult> {
  void dependencies;
  const command = normalizeLocalReconciliationPlanVerifyCommand(input);
  const identity = currentIdentity();
  validatePrivateDirectory(command.options.deploymentRoot, identity.uid, 'deploymentRoot');
  validatePrivateDirectory(command.options.captureRoot, identity.uid, 'captureRoot');
  validatePrivateDirectory(command.options.planRoot, identity.uid, 'planRoot');
  const paths = planPaths(command.options.planRoot, command.request.planId);
  const intent = readLocalReconciliationPlanIntent(
    command.options.planRoot,
    command.request.planId,
  );
  if (
    intent.command.options.deploymentRoot !== command.options.deploymentRoot ||
    intent.command.options.captureRoot !== command.options.captureRoot ||
    intent.command.options.planRoot !== command.options.planRoot ||
    intent.command.options.allowRootService !== command.options.allowRootService
  ) {
    configurationError('plan verify is detached from preparation');
  }
  const bundle = inspectLocalReconciliationSealedBundle(
    command.options.captureRoot,
    intent.command.request.captureId,
    identity.uid,
  );
  const terminal = readTerminal(paths, intent, bundle, identity.uid);
  if (terminal.plan.planDigest !== command.request.expectedPlanDigest) {
    configurationError('plan verify expected digest drifted');
  }
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    intent.instanceId,
    identity.uid,
  );
  validateHeadIdentity(head, intent);
  if (
    head.state !== 'reconciliation_planned' ||
    head.sourceRecordDigest !== terminal.plan.planDigest
  ) {
    configurationError('plan verify lost the terminal instance head');
  }
  return result(command.operation, 'verified', terminal, head);
}

export function prepareLocalReconciliationPlanCommandFile(
  filePath: string,
): Readonly<LocalReconciliationPlanPrepareResult> {
  return prepareLocalReconciliationPlan(readPrivateLocalCommandFile(filePath));
}

export function commitLocalReconciliationPlanCommandFile(
  filePath: string,
): Readonly<LocalReconciliationPlanTerminalResult> {
  return commitLocalReconciliationPlan(readPrivateLocalCommandFile(filePath));
}

export function verifyLocalReconciliationPlanCommandFile(
  filePath: string,
): Readonly<LocalReconciliationPlanTerminalResult> {
  return verifyLocalReconciliationPlan(readPrivateLocalCommandFile(filePath));
}
