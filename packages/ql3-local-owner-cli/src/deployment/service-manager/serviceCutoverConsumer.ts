import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
  readPrivateLocalCommandFile,
  readPrivateLocalJsonFile,
} from '@qinglong/local-command-file';
import { normalizeLocalDataDirectoryApplicationCommit } from '@qinglong/local-sqlite/data-directory-application-commit';

import { currentIdentity } from '../foundation/contract';
import { LocalDeploymentConfigurationError } from '../foundation/error';
import {
  advanceLocalCutoverInstanceHead,
  readLocalCutoverInstanceHead,
} from '../cutover/instanceLineage';
import {
  cutoverDigest,
  readTargetStartupReceipt,
  type TargetStartupReceiptEvidence,
} from '../cutover/targetEvidence';
import {
  localServiceManagerIntentPath,
  localServiceManagerOutcomePath,
  normalizeLocalServiceManagerIntent,
  type LocalServiceManagerIntent,
} from './serviceBridgeContract';
import {
  consumeLocalServiceManagerOutcome,
  type LocalServiceManagerOutcomeConsumeCommand,
} from './serviceManagerIntent';
import {
  normalizeLocalServiceManagerOutcome,
  type LocalServiceManagerOutcome,
} from './serviceOutcomeContract';
import {
  localServiceManagerCutoverRecord,
  localServiceManagerCutoverRecordPath,
  normalizeLocalServiceManagerCutoverRecord,
  publishLocalServiceManagerCutoverRecord,
  readLocalServiceManagerActiveRecord,
  type LocalServiceManagerCutoverEvidence,
  type LocalServiceManagerCutoverRecord,
  type LocalServiceManagerCutoverState,
} from './serviceCutoverJournal';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BOOT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const START_TICKS_PATTERN = /^[1-9][0-9]{0,19}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const MAX_PATH_BYTES = 4_096;

export interface LocalServiceManagerCutoverConsumeCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.cutover.consume';
  readonly options: Readonly<{
    deploymentRoot: string;
    allowRootService: boolean;
    startupTimeoutMs: number;
    startupPollMs: number;
  }>;
  readonly request: Readonly<{
    actionId: string;
    expectedIntentDigest: string;
  }>;
}

export interface LocalServiceManagerCutoverConsumeResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.cutover.consume';
  readonly status: 'prepared' | 'existing';
  readonly state: LocalServiceManagerCutoverState;
  readonly cutoverId: string;
  readonly generation: number;
  readonly recordDigest: string;
  readonly instanceHeadDigest: string;
}

export interface LocalServiceManagerCutoverDependencies {
  readonly procRoot?: string;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

interface AdoptedBinding {
  readonly cutoverId: string;
  readonly activationDigest: string;
  readonly commitmentDigest: string;
  readonly commitmentPath: string;
  readonly activationPath: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly recoveryPath: string;
  readonly manifestPath: string;
  readonly applicationConfigDigest: string;
  readonly legacyDataApplication?: Readonly<{
    commitPath: string;
    commitDigest: string;
    receiptDigest: string;
  }>;
}

interface VerifiedAdoptedEvidence {
  readonly targetDataIdentityDigest: string;
  readonly legacyDataApplicationCommitDigest: string | null;
  readonly legacyDataApplicationReceiptDigest: string | null;
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

function safeAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value ||
    value.includes('\0') ||
    value.includes('//') ||
    !SAFE_PATH_PATTERN.test(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    configurationError(`${label} must be a supervisor-safe absolute path`);
  }
  return value;
}

function normalizeCommand(
  value: unknown,
): Readonly<LocalServiceManagerCutoverConsumeCommand> {
  const command = object(value, 'service manager cutover command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  const options = object(command.options, 'options');
  exact(
    options,
    ['allowRootService', 'deploymentRoot', 'startupPollMs', 'startupTimeoutMs'],
    'options',
  );
  const request = object(command.request, 'request');
  exact(request, ['actionId', 'expectedIntentDigest'], 'request');
  const identity = currentIdentity();
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.deployment.service-manager.cutover.consume' ||
    typeof options.allowRootService !== 'boolean' ||
    (identity.uid === 0) !== options.allowRootService ||
    !Number.isSafeInteger(options.startupTimeoutMs) ||
    (options.startupTimeoutMs as number) < 100 ||
    (options.startupTimeoutMs as number) > 120_000 ||
    !Number.isSafeInteger(options.startupPollMs) ||
    (options.startupPollMs as number) < 10 ||
    (options.startupPollMs as number) > 1_000 ||
    (options.startupPollMs as number) > (options.startupTimeoutMs as number) ||
    typeof request.actionId !== 'string' ||
    !UUID_V4_PATTERN.test(request.actionId) ||
    typeof request.expectedIntentDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedIntentDigest)
  ) {
    configurationError('service manager cutover command is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.service-manager.cutover.consume' as const,
    options: Object.freeze({
      deploymentRoot: safeAbsolutePath(
        options.deploymentRoot,
        'deploymentRoot',
      ),
      allowRootService: options.allowRootService,
      startupTimeoutMs: options.startupTimeoutMs as number,
      startupPollMs: options.startupPollMs as number,
    }),
    request: Object.freeze({
      actionId: request.actionId,
      expectedIntentDigest: request.expectedIntentDigest,
    }),
  });
}

function readIntentAndOutcome(
  command: Readonly<LocalServiceManagerCutoverConsumeCommand>,
): Readonly<{
  intent: Readonly<LocalServiceManagerIntent>;
  outcome: Readonly<LocalServiceManagerOutcome>;
}> {
  const intent = normalizeLocalServiceManagerIntent(
    readPrivateLocalJsonFile(
      localServiceManagerIntentPath(
        command.options.deploymentRoot,
        command.request.actionId,
      ),
      { maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES },
    ),
  );
  const outcome = normalizeLocalServiceManagerOutcome(
    readPrivateLocalJsonFile(
      localServiceManagerOutcomePath(
        command.options.deploymentRoot,
        command.request.actionId,
      ),
      { maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES },
    ),
  );
  if (
    intent.intentDigest !== command.request.expectedIntentDigest ||
    outcome.actionId !== intent.actionId ||
    outcome.action !== intent.action ||
    outcome.intentDigest !== intent.intentDigest
  ) {
    configurationError('service manager cutover outcome binding drifted');
  }
  return Object.freeze({ intent, outcome });
}

function adoptedBinding(
  intent: Readonly<LocalServiceManagerIntent>,
): Readonly<AdoptedBinding> {
  if (intent.lineage.mode !== 'adopted') {
    configurationError('fresh service outcome has no cutover lineage');
  }
  const config = object(
    readPrivateLocalCommandFile(intent.deployment.applicationConfigPath),
    'adopted application configuration',
  );
  const storage = object(config.storage, 'adopted storage');
  const cutover = object(config.cutover, 'adopted cutover');
  const legacyDataApplication =
    config.schema === 'qinglong/local-application-process@v4'
      ? object(config.legacyDataApplication, 'legacy data application binding')
      : undefined;
  if (legacyDataApplication !== undefined) {
    exact(
      legacyDataApplication,
      ['commitPath', 'expectedCommitDigest', 'expectedReceiptDigest'],
      'legacy data application binding',
    );
  }
  const expectedCommitmentPath = path.join(
    intent.deployment.root,
    'service',
    'cutovers',
    intent.lineage.cutoverId,
    '0002-legacy-stopped.json',
  );
  if (
    (config.schema !== 'qinglong/local-application-process@v3' &&
      config.schema !== 'qinglong/local-application-process@v4') ||
    config.profile !== intent.profile ||
    config.instanceId !== intent.instanceId ||
    storage.mode !== 'adopted' ||
    storage.expectedActivationDigest !==
      intent.lineage.expectedActivationDigest ||
    cutover.cutoverId !== intent.lineage.cutoverId ||
    typeof cutover.expectedCommitmentDigest !== 'string' ||
    !DIGEST_PATTERN.test(cutover.expectedCommitmentDigest) ||
    (legacyDataApplication !== undefined &&
      (typeof legacyDataApplication.expectedCommitDigest !== 'string' ||
        !DIGEST_PATTERN.test(legacyDataApplication.expectedCommitDigest) ||
        typeof legacyDataApplication.expectedReceiptDigest !== 'string' ||
        !DIGEST_PATTERN.test(legacyDataApplication.expectedReceiptDigest)))
  ) {
    configurationError('adopted application configuration drifted');
  }
  const binding = Object.freeze({
    cutoverId: cutover.cutoverId,
    activationDigest: storage.expectedActivationDigest,
    commitmentDigest: cutover.expectedCommitmentDigest,
    commitmentPath: safeAbsolutePath(cutover.commitmentPath, 'commitmentPath'),
    activationPath: safeAbsolutePath(storage.activationPath, 'activationPath'),
    sourcePath: safeAbsolutePath(storage.sourcePath, 'sourcePath'),
    targetPath: safeAbsolutePath(storage.targetPath, 'targetPath'),
    recoveryPath: safeAbsolutePath(storage.recoveryPath, 'recoveryPath'),
    manifestPath: safeAbsolutePath(storage.manifestPath, 'manifestPath'),
    applicationConfigDigest: intent.deployment.applicationConfigSha256,
    ...(legacyDataApplication === undefined
      ? {}
      : {
          legacyDataApplication: Object.freeze({
            commitPath: safeAbsolutePath(
              legacyDataApplication.commitPath,
              'legacyDataApplication.commitPath',
            ),
            commitDigest: legacyDataApplication.expectedCommitDigest as string,
            receiptDigest:
              legacyDataApplication.expectedReceiptDigest as string,
          }),
        }),
  });
  if (binding.commitmentPath !== expectedCommitmentPath) {
    configurationError('adopted application material binding drifted');
  }
  return binding;
}

function textDigest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function privateFileIdentity(
  filePath: string,
  uid: number,
  label: string,
): Readonly<{ device: string; inode: string; digest: string }> {
  try {
    const stat = fs.lstatSync(filePath, { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      Number(stat.uid) !== uid ||
      (Number(stat.mode) & 0o077) !== 0 ||
      stat.nlink !== 1n ||
      fs.realpathSync(filePath) !== filePath
    ) {
      configurationError(`${label} identity is invalid`);
    }
    return Object.freeze({
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      digest: cutoverDigest({
        pathDigest: textDigest(filePath),
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
        uid: Number(stat.uid),
        mode: Number(stat.mode) & 0o777,
      }),
    });
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError(`${label} cannot be inspected`, error);
  }
}

function privateFileSha256(
  filePath: string,
  uid: number,
  label: string,
): string {
  let descriptor: number | undefined;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      Number(opened.uid) !== uid ||
      (Number(opened.mode) & 0o077) !== 0 ||
      opened.nlink !== 1n
    ) {
      configurationError(`${label} identity changed while opening`);
    }
    const hash = crypto.createHash('sha256');
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      after.nlink !== 1n
    ) {
      configurationError(`${label} changed while hashing`);
    }
    return hash.digest('hex');
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError(`${label} cannot be hashed`, error);
  } finally {
    buffer.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function verifyAdoptedEvidence(
  intent: Readonly<LocalServiceManagerIntent>,
  binding: Readonly<AdoptedBinding>,
  uid: number,
): Readonly<VerifiedAdoptedEvidence> {
  const activation = object(
    readPrivateLocalCommandFile(binding.activationPath),
    'activation',
  );
  const { activationDigest, ...activationPayload } = activation;
  const commitment = object(
    readPrivateLocalCommandFile(binding.commitmentPath),
    'legacy silence commitment',
  );
  const { commitmentDigest, ...commitmentPayload } = commitment;
  const manifestDocument = object(
    readPrivateLocalCommandFile(binding.manifestPath),
    'adoption manifest',
  );
  const { manifestDigest, ...manifestPayload } = manifestDocument;
  if (
    activation.schemaVersion !== 1 ||
    activation.kind !== 'qinglong3-local-sqlite-activation' ||
    activation.state !== 'prepared' ||
    activation.profile !== intent.profile ||
    activation.sourcePathDigest !== textDigest(binding.sourcePath) ||
    activation.targetPathDigest !== textDigest(binding.targetPath) ||
    typeof activation.sourceSha256 !== 'string' ||
    !DIGEST_PATTERN.test(activation.sourceSha256) ||
    typeof activation.recoverySha256 !== 'string' ||
    !DIGEST_PATTERN.test(activation.recoverySha256) ||
    typeof activation.adoptionManifestDigest !== 'string' ||
    !DIGEST_PATTERN.test(activation.adoptionManifestDigest) ||
    activationDigest !== binding.activationDigest ||
    cutoverDigest(activationPayload) !== activationDigest ||
    commitment.schemaVersion !== 1 ||
    commitment.kind !== 'qinglong3-local-legacy-silence-commitment' ||
    commitment.state !== 'legacy_stopped' ||
    commitment.cutoverId !== binding.cutoverId ||
    commitment.profile !== intent.profile ||
    commitment.instanceId !== intent.instanceId ||
    commitment.activationDigest !== binding.activationDigest ||
    commitmentDigest !== binding.commitmentDigest ||
    cutoverDigest(commitmentPayload) !== commitmentDigest ||
    typeof manifestDigest !== 'string' ||
    !DIGEST_PATTERN.test(manifestDigest) ||
    cutoverDigest(manifestPayload) !== manifestDigest ||
    activation.adoptionManifestDigest !== manifestDigest
  ) {
    configurationError('adopted activation or commitment drifted');
  }
  let legacyDataApplicationCommitDigest: string | null = null;
  let legacyDataApplicationReceiptDigest: string | null = null;
  if (binding.legacyDataApplication !== undefined) {
    try {
      const dataCommit = normalizeLocalDataDirectoryApplicationCommit(
        readPrivateLocalCommandFile(binding.legacyDataApplication.commitPath),
      );
      if (
        dataCommit.profile !== intent.profile ||
        dataCommit.commitDigest !==
          binding.legacyDataApplication.commitDigest ||
        dataCommit.receiptDigest !== binding.legacyDataApplication.receiptDigest
      ) {
        configurationError('legacy data application commitment drifted');
      }
      legacyDataApplicationCommitDigest = dataCommit.commitDigest;
      legacyDataApplicationReceiptDigest = dataCommit.receiptDigest;
    } catch (error) {
      if (error instanceof LocalDeploymentConfigurationError) throw error;
      configurationError(
        'legacy data application commitment is invalid',
        error,
      );
    }
  }
  const target = privateFileIdentity(
    binding.targetPath,
    uid,
    'target database',
  );
  const source = privateFileIdentity(binding.sourcePath, uid, 'legacy source');
  const recovery = privateFileIdentity(binding.recoveryPath, uid, 'recovery');
  const manifestIdentity = privateFileIdentity(
    binding.manifestPath,
    uid,
    'manifest',
  );
  const sourceSha256 = privateFileSha256(
    binding.sourcePath,
    uid,
    'legacy source',
  );
  const recoverySha256 = privateFileSha256(
    binding.recoveryPath,
    uid,
    'recovery',
  );
  if (
    activation.targetDevice !== target.device ||
    activation.targetInode !== target.inode ||
    sourceSha256 !== activation.sourceSha256 ||
    recoverySha256 !== activation.recoverySha256
  ) {
    configurationError('adopted data evidence drifted');
  }
  return Object.freeze({
    targetDataIdentityDigest: cutoverDigest({
      target: target.digest,
      source: source.digest,
      recovery: recovery.digest,
      recoverySha256,
      manifest: manifestIdentity.digest,
      manifestDigest,
      sourceSha256,
    }),
    legacyDataApplicationCommitDigest,
    legacyDataApplicationReceiptDigest,
  });
}

function parseProcessStartTicks(contents: string): string {
  const commandEnd = contents.lastIndexOf(') ');
  const fields =
    commandEnd < 2
      ? []
      : contents
          .slice(commandEnd + 2)
          .trim()
          .split(/\s+/u);
  const startTicks = fields[19];
  if (!startTicks || !/^[1-9][0-9]{0,19}$/.test(startTicks)) {
    configurationError('service process stat is invalid');
  }
  return startTicks;
}

function readShutdownReceipt(
  intent: Readonly<LocalServiceManagerIntent>,
  startup: Readonly<TargetStartupReceiptEvidence>,
): string | null {
  const receiptPath = `${intent.deployment.applicationConfigPath}.stopped.json`;
  if (!fs.existsSync(receiptPath)) return null;
  const receipt = object(
    readPrivateLocalJsonFile(receiptPath, {
      maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
    }),
    'application shutdown receipt',
  );
  exact(
    receipt,
    [
      'bootId',
      'instanceId',
      'nodeExecutable',
      'nodeVersion',
      'processId',
      'processStartTicks',
      'profile',
      'schema',
      'schemaVersion',
      'sha256',
      'signal',
      'stoppedBootAgeMs',
      'stopResult',
      'startupReceiptDigest',
    ],
    'application shutdown receipt',
  );
  const { sha256, ...payload } = receipt;
  const digest = crypto
    .createHash('sha256')
    .update('qinglong.local-application-shutdown-receipt.v1\0', 'utf8')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
  if (
    receipt.schemaVersion !== 1 ||
    receipt.schema !== 'qinglong/local-application-shutdown-receipt@v1' ||
    receipt.instanceId !== intent.instanceId ||
    receipt.profile !== intent.profile ||
    receipt.signal !== 'SIGTERM' ||
    receipt.stopResult !== 'stopped' ||
    receipt.startupReceiptDigest !== startup.digest ||
    receipt.bootId !== startup.bootId ||
    !BOOT_ID_PATTERN.test(receipt.bootId as string) ||
    !Number.isSafeInteger(receipt.stoppedBootAgeMs) ||
    (receipt.stoppedBootAgeMs as number) < startup.activeBootAgeMs ||
    receipt.processId !== startup.processId ||
    receipt.processStartTicks !== startup.processStartTicks ||
    !START_TICKS_PATTERN.test(receipt.processStartTicks as string) ||
    receipt.nodeExecutable !== startup.nodeExecutable ||
    typeof receipt.nodeVersion !== 'string' ||
    !/^v24\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(
      receipt.nodeVersion,
    ) ||
    typeof sha256 !== 'string' ||
    !DIGEST_PATTERN.test(sha256) ||
    digest !== sha256
  ) {
    configurationError('application shutdown receipt is invalid');
  }
  return digest;
}

function processIdentity(
  receipt: Readonly<TargetStartupReceiptEvidence>,
  intent: Readonly<LocalServiceManagerIntent>,
  outcome: Readonly<LocalServiceManagerOutcome>,
  procRoot: string,
): string {
  if (
    outcome.observation.mainPid !== 0 &&
    outcome.observation.mainPid !== receipt.processId
  ) {
    configurationError('manager PID does not match the startup receipt');
  }
  try {
    const processRoot = path.join(procRoot, String(receipt.processId));
    const before = fs.lstatSync(processRoot, { bigint: true });
    const firstTicks = parseProcessStartTicks(
      fs.readFileSync(path.join(processRoot, 'stat'), 'utf8'),
    );
    const executable = fs.realpathSync(path.join(processRoot, 'exe'));
    const secondTicks = parseProcessStartTicks(
      fs.readFileSync(path.join(processRoot, 'stat'), 'utf8'),
    );
    const after = fs.lstatSync(processRoot, { bigint: true });
    if (
      Number(before.uid) !== intent.service.uid ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      firstTicks !== receipt.processStartTicks ||
      secondTicks !== firstTicks ||
      executable !== receipt.nodeExecutable
    ) {
      configurationError('startup receipt process identity drifted');
    }
    return cutoverDigest({
      bootId: receipt.bootId,
      processId: receipt.processId,
      processStartTicks: receipt.processStartTicks,
      nodeExecutable: receipt.nodeExecutable,
      uid: intent.service.uid,
    });
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('startup receipt process is unavailable', error);
  }
}

async function awaitActiveReceipt(
  command: Readonly<LocalServiceManagerCutoverConsumeCommand>,
  intent: Readonly<LocalServiceManagerIntent>,
  outcome: Readonly<LocalServiceManagerOutcome>,
  previousReceiptDigest: string | null,
  dependencies: LocalServiceManagerCutoverDependencies,
): Promise<Readonly<{
  receiptDigest: string;
  processIdentityDigest: string;
}> | null> {
  const now = dependencies.now ?? Date.now;
  const wait =
    dependencies.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const procRoot = dependencies.procRoot ?? '/proc';
  const deadline = now() + command.options.startupTimeoutMs;
  for (;;) {
    try {
      const receipt = readTargetStartupReceipt({
        request: {
          applicationConfigPath: intent.deployment.applicationConfigPath,
          instanceId: intent.instanceId,
          profile: intent.profile,
        },
      });
      if (receipt !== null && receipt.digest !== previousReceiptDigest) {
        return Object.freeze({
          receiptDigest: receipt.digest,
          processIdentityDigest: processIdentity(
            receipt,
            intent,
            outcome,
            procRoot,
          ),
        });
      }
    } catch {
      // A service manager may report active just before the application
      // atomically replaces its receipt. Retry only this Owner-side read.
    }
    if (now() >= deadline) return null;
    await wait(command.options.startupPollMs);
  }
}

function desiredState(
  intent: Readonly<LocalServiceManagerIntent>,
  outcome: Readonly<LocalServiceManagerOutcome>,
): LocalServiceManagerCutoverState {
  if (outcome.state === 'manual_required') return 'manual_required';
  if (intent.action === 'stop' && outcome.state === 'stopped') {
    return 'target_stopped';
  }
  if (intent.action !== 'stop' && outcome.state === 'active') {
    return 'target_active';
  }
  return configurationError('manager outcome state does not match its action');
}

function replayResult(
  command: Readonly<LocalServiceManagerCutoverConsumeCommand>,
  intent: Readonly<LocalServiceManagerIntent>,
  outcome: Readonly<LocalServiceManagerOutcome>,
): Readonly<LocalServiceManagerCutoverConsumeResult> | undefined {
  if (intent.lineage.mode !== 'adopted') return undefined;
  const state = desiredState(intent, outcome);
  const recordPath = localServiceManagerCutoverRecordPath(intent, state);
  if (!fs.existsSync(recordPath)) return undefined;
  const record = normalizeLocalServiceManagerCutoverRecord(
    readPrivateLocalCommandFile(recordPath),
  );
  const head = readLocalCutoverInstanceHead(
    intent.deployment.root,
    intent.instanceId,
    currentIdentity().uid,
  );
  const stoppedCaptureProgress =
    record.state === 'target_stopped' &&
    (head.state === 'reconciliation_capture_prepared' ||
      head.state === 'reconciliation_captured' ||
      head.state === 'reconciliation_plan_prepared' ||
      head.state === 'reconciliation_planned' ||
      head.state === 'reconciliation_review_prepared' ||
      head.state === 'reconciliation_reviewed');
  if (
    record.actionId !== intent.actionId ||
    record.intentDigest !== intent.intentDigest ||
    record.evidence.managerOutcomeDigest !== outcome.outcomeDigest ||
    head.cutoverId !== intent.lineage.cutoverId ||
    head.generation !== intent.lineage.generation ||
    (!stoppedCaptureProgress && head.state !== record.state) ||
    (!stoppedCaptureProgress && head.sourceRecordDigest !== record.recordDigest)
  ) {
    configurationError('service manager cutover replay drifted');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status: 'existing' as const,
    state: record.state,
    cutoverId: record.cutoverId,
    generation: record.generation,
    recordDigest: record.recordDigest,
    instanceHeadDigest: head.headDigest,
  });
}

export async function consumeLocalServiceManagerCutoverOutcome(
  input: unknown,
  dependencies: LocalServiceManagerCutoverDependencies = {},
): Promise<Readonly<LocalServiceManagerCutoverConsumeResult>> {
  const command = normalizeCommand(input);
  const identity = currentIdentity();
  const { intent, outcome } = readIntentAndOutcome(command);
  const replay = replayResult(command, intent, outcome);
  if (replay !== undefined) return replay;
  consumeLocalServiceManagerOutcome({
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.outcome.consume',
    options: {
      deploymentRoot: command.options.deploymentRoot,
      allowRootService: command.options.allowRootService,
    },
    request: command.request,
  } satisfies LocalServiceManagerOutcomeConsumeCommand);
  if (intent.lineage.mode !== 'adopted') {
    configurationError('fresh service outcome cannot advance cutover lineage');
  }
  const state = desiredState(intent, outcome);
  const binding = adoptedBinding(intent);
  const adoptedEvidence = verifyAdoptedEvidence(intent, binding, identity.uid);
  let startupReceiptDigest: string | null = null;
  let shutdownReceiptDigest: string | null = null;
  let processIdentityDigest: string | null = null;
  let manualReason: string | null = outcome.manualReason;
  let finalState = state;
  if (state === 'target_active') {
    let previousReceiptDigest: string | null = null;
    if (intent.lineage.generation > 1) {
      const previous = readLocalServiceManagerActiveRecord(
        intent.deployment.root,
        intent.lineage.cutoverId,
        intent.lineage.generation - 1,
      );
      if (previous.recordDigest !== intent.lineage.previousRecordDigest) {
        configurationError('previous active record lost the lineage CAS');
      }
      previousReceiptDigest = previous.evidence.startupReceiptDigest;
    }
    const active = await awaitActiveReceipt(
      command,
      intent,
      outcome,
      previousReceiptDigest,
      dependencies,
    );
    if (active === null) {
      finalState = 'manual_required';
      manualReason = 'application_startup_receipt_unproved';
    } else {
      startupReceiptDigest = active.receiptDigest;
      processIdentityDigest = active.processIdentityDigest;
    }
  } else if (state === 'target_stopped') {
    const previous = readLocalServiceManagerActiveRecord(
      intent.deployment.root,
      intent.lineage.cutoverId,
      intent.lineage.generation,
    );
    if (previous.recordDigest !== intent.lineage.previousRecordDigest) {
      configurationError('stopped service lost the active lineage CAS');
    }
    startupReceiptDigest = previous.evidence.startupReceiptDigest;
    processIdentityDigest = previous.evidence.processIdentityDigest;
    const staleReceipt = readTargetStartupReceipt({
      request: {
        applicationConfigPath: intent.deployment.applicationConfigPath,
        instanceId: intent.instanceId,
        profile: intent.profile,
      },
    });
    if (staleReceipt === null || staleReceipt.digest !== startupReceiptDigest) {
      finalState = 'manual_required';
      manualReason = 'stopped_process_identity_unproved';
    } else {
      shutdownReceiptDigest = readShutdownReceipt(intent, staleReceipt);
      if (shutdownReceiptDigest === null) {
        finalState = 'manual_required';
        manualReason = 'application_shutdown_receipt_unproved';
      } else {
        try {
          processIdentity(
            staleReceipt,
            intent,
            outcome,
            dependencies.procRoot ?? '/proc',
          );
          finalState = 'manual_required';
          manualReason = 'stopped_process_still_active';
        } catch {
          // The exact receipted PID/start identity no longer exists, as required.
        }
      }
    }
  }
  const evidence: Readonly<LocalServiceManagerCutoverEvidence> = Object.freeze({
    managerOutcomeDigest: outcome.outcomeDigest,
    managerObservationDigest: outcome.observation.observationDigest,
    applicationConfigDigest: binding.applicationConfigDigest,
    activationDigest: binding.activationDigest,
    commitmentDigest: binding.commitmentDigest,
    targetDataIdentityDigest: adoptedEvidence.targetDataIdentityDigest,
    legacyDataApplicationCommitDigest:
      adoptedEvidence.legacyDataApplicationCommitDigest,
    legacyDataApplicationReceiptDigest:
      adoptedEvidence.legacyDataApplicationReceiptDigest,
    startupReceiptDigest,
    shutdownReceiptDigest,
    processIdentityDigest,
    manualReason,
  });
  const record = localServiceManagerCutoverRecord(
    intent,
    outcome,
    finalState,
    evidence,
  );
  const status = publishLocalServiceManagerCutoverRecord(
    intent,
    record,
    identity.uid,
  );
  const head = advanceLocalCutoverInstanceHead(
    {
      options: { deploymentRoot: intent.deployment.root },
      request: {
        cutoverId: intent.lineage.cutoverId,
        profile: intent.profile,
        instanceId: intent.instanceId,
        expectedActivationDigest: intent.lineage.expectedActivationDigest,
        requestedAtMs: outcome.completedAtMs,
      },
    },
    identity.uid,
    finalState,
    intent.lineage.generation,
    record.recordDigest,
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status,
    state: finalState,
    cutoverId: intent.lineage.cutoverId,
    generation: intent.lineage.generation,
    recordDigest: record.recordDigest,
    instanceHeadDigest: head.headDigest,
  });
}

export function consumeLocalServiceManagerCutoverOutcomeCommandFile(
  filePath: string,
): Promise<Readonly<LocalServiceManagerCutoverConsumeResult>> {
  return consumeLocalServiceManagerCutoverOutcome(
    readPrivateLocalJsonFile(filePath, {
      maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
    }),
  );
}
