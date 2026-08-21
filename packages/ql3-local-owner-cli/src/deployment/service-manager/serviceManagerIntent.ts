import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
  readPrivateLocalJsonFile,
} from '@qinglong/local-command-file';
import { normalizeLocalDataDirectoryApplicationCommit } from '@qinglong/local-sqlite/data-directory-application-commit';

import { currentIdentity } from '../foundation/contract';
import { LocalDeploymentConfigurationError } from '../foundation/error';
import {
  assertLocalCutoverTargetHead,
  localCutoverInstanceHeadPath,
} from '../cutover/instanceLineage';
import {
  ensurePrivateDirectory,
  preflightPublishedFile,
  publishExactFile,
  validatePrivateDirectory,
} from '../foundation/files';
import {
  localServiceManagerIntentDigest,
  localServiceManagerIntentPath,
  localServiceManagerOutcomePath,
  normalizeLocalServiceManagerIntent,
  type LocalServiceManagerAction,
  type LocalServiceManagerIntent,
  type LocalServiceManagerIntentLineage,
  type LocalServiceManagerKind,
} from './serviceBridgeContract';
import {
  normalizeLocalServiceManagerOutcome,
  type LocalServiceManagerOutcome,
} from './serviceOutcomeContract';

const MAX_PATH_BYTES = 4_096;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface LocalServiceManagerIntentPrepareCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.intent.prepare';
  readonly options: Readonly<{
    deploymentRoot: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<{
    actionId: string;
    action: LocalServiceManagerAction;
    serviceKind: LocalServiceManagerKind;
    lineage: LocalServiceManagerIntentLineage;
    requestedAtMs: number;
  }>;
}

export interface LocalServiceManagerIntentPrepareResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.intent.prepare';
  readonly status: 'prepared' | 'existing';
  readonly actionId: string;
  readonly intentPath: string;
  readonly intentDigest: string;
  readonly outcomePath: string;
}

export interface LocalServiceManagerOutcomeConsumeCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.outcome.consume';
  readonly options: Readonly<{
    deploymentRoot: string;
    allowRootService: boolean;
  }>;
  readonly request: Readonly<{
    actionId: string;
    expectedIntentDigest: string;
  }>;
}

export interface LocalServiceManagerOutcomeConsumeResult {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.outcome.consume';
  readonly status: 'verified';
  readonly actionId: string;
  readonly state: LocalServiceManagerOutcome['state'];
  readonly outcomeDigest: string;
  readonly observationDigest: string;
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

function validateIdentity(allowRootService: unknown): Readonly<{
  uid: number;
  gid: number;
}> {
  const identity = currentIdentity();
  if (
    typeof allowRootService !== 'boolean' ||
    (identity.uid === 0) !== allowRootService
  ) {
    configurationError('allowRootService does not match the current identity');
  }
  return identity;
}

function privateFileBytes(
  filePath: string,
  expectedMode: number,
  uid: number,
  gid: number,
  maximumBytes: number,
  label: string,
): Buffer {
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      Number(before.gid) !== gid ||
      (Number(before.mode) & 0o777) !== expectedMode ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes) ||
      fs.realpathSync(filePath) !== filePath
    ) {
      configurationError(`${label} identity is invalid`);
    }
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
      Number(opened.gid) !== gid ||
      (Number(opened.mode) & 0o777) !== expectedMode ||
      opened.nlink !== 1n
    ) {
      configurationError(`${label} identity changed while opening`);
    }
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (read === 0) break;
      offset += read;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      offset !== bytes.byteLength ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      Number(after.uid) !== uid ||
      Number(after.gid) !== gid ||
      (Number(after.mode) & 0o777) !== expectedMode ||
      after.nlink !== 1n
    ) {
      bytes.fill(0);
      configurationError(`${label} identity changed while reading`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError(`${label} cannot be read`, error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parseApplicationIdentity(bytes: Buffer): Readonly<{
  profile: 'edge' | 'standalone';
  instanceId: string;
  deployment:
    | Readonly<{ mode: 'fresh' }>
    | Readonly<{
        mode: 'adopted';
        cutoverId: string;
        expectedActivationDigest: string;
        expectedCommitmentDigest: string;
        commitmentPath: string;
        activationPath: string;
        legacySourcePath: string;
        targetDatabasePath: string;
        recoveryPath: string;
        manifestPath: string;
        legacyDataApplication?: Readonly<{
          commitPath: string;
          expectedCommitDigest: string;
          expectedReceiptDigest: string;
        }>;
      }>;
}> {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    configurationError('application configuration is invalid', error);
  }
  const application = object(value, 'application configuration');
  if (
    (application.schema !== 'qinglong/local-application-process@v2' &&
      application.schema !== 'qinglong/local-application-process@v3' &&
      application.schema !== 'qinglong/local-application-process@v4') ||
    (application.profile !== 'edge' && application.profile !== 'standalone') ||
    typeof application.instanceId !== 'string'
  ) {
    configurationError('application identity is invalid');
  }
  const storage = object(application.storage, 'application storage');
  if (application.schema === 'qinglong/local-application-process@v2') {
    if (storage.mode !== 'fresh') {
      configurationError('v2 service application must use fresh storage');
    }
    return Object.freeze({
      profile: application.profile,
      instanceId: application.instanceId,
      deployment: Object.freeze({ mode: 'fresh' as const }),
    });
  }
  const cutover = object(application.cutover, 'application cutover');
  const legacyDataApplication =
    application.schema === 'qinglong/local-application-process@v4'
      ? object(
          application.legacyDataApplication,
          'legacy data application binding',
        )
      : undefined;
  if (legacyDataApplication !== undefined) {
    exact(
      legacyDataApplication,
      ['commitPath', 'expectedCommitDigest', 'expectedReceiptDigest'],
      'legacy data application binding',
    );
  }
  if (
    storage.mode !== 'adopted' ||
    typeof cutover.cutoverId !== 'string' ||
    typeof storage.expectedActivationDigest !== 'string' ||
    !DIGEST_PATTERN.test(storage.expectedActivationDigest) ||
    typeof cutover.expectedCommitmentDigest !== 'string' ||
    !DIGEST_PATTERN.test(cutover.expectedCommitmentDigest) ||
    (legacyDataApplication !== undefined &&
      (typeof legacyDataApplication.expectedCommitDigest !== 'string' ||
        !DIGEST_PATTERN.test(legacyDataApplication.expectedCommitDigest) ||
        typeof legacyDataApplication.expectedReceiptDigest !== 'string' ||
        !DIGEST_PATTERN.test(legacyDataApplication.expectedReceiptDigest)))
  ) {
    configurationError('adopted application binding is invalid');
  }
  return Object.freeze({
    profile: application.profile,
    instanceId: application.instanceId,
    deployment: Object.freeze({
      mode: 'adopted' as const,
      cutoverId: cutover.cutoverId,
      expectedActivationDigest: storage.expectedActivationDigest,
      expectedCommitmentDigest: cutover.expectedCommitmentDigest,
      commitmentPath: safeAbsolutePath(
        cutover.commitmentPath,
        'commitmentPath',
      ),
      activationPath: safeAbsolutePath(
        storage.activationPath,
        'activationPath',
      ),
      legacySourcePath: safeAbsolutePath(
        storage.sourcePath,
        'legacySourcePath',
      ),
      targetDatabasePath: safeAbsolutePath(
        storage.targetPath,
        'targetDatabasePath',
      ),
      recoveryPath: safeAbsolutePath(storage.recoveryPath, 'recoveryPath'),
      manifestPath: safeAbsolutePath(storage.manifestPath, 'manifestPath'),
      ...(legacyDataApplication === undefined
        ? {}
        : {
            legacyDataApplication: Object.freeze({
              commitPath: safeAbsolutePath(
                legacyDataApplication.commitPath,
                'legacyDataApplication.commitPath',
              ),
              expectedCommitDigest:
                legacyDataApplication.expectedCommitDigest as string,
              expectedReceiptDigest:
                legacyDataApplication.expectedReceiptDigest as string,
            }),
          }),
    }),
  });
}

function verifyApplicationDataCommitment(
  application: ReturnType<typeof parseApplicationIdentity>,
): void {
  if (
    application.deployment.mode !== 'adopted' ||
    application.deployment.legacyDataApplication === undefined
  ) {
    return;
  }
  try {
    const binding = application.deployment.legacyDataApplication;
    const commit = normalizeLocalDataDirectoryApplicationCommit(
      readPrivateLocalJsonFile(binding.commitPath, {
        maxBytes: 64 * 1024,
      }),
    );
    if (
      commit.profile !== application.profile ||
      commit.commitDigest !== binding.expectedCommitDigest ||
      commit.receiptDigest !== binding.expectedReceiptDigest
    ) {
      configurationError(
        'legacy data application commit does not match the application binding',
      );
    }
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    configurationError('legacy data application commitment is invalid', error);
  }
}

function assertApplicationLineageBinding(
  application: ReturnType<typeof parseApplicationIdentity>,
  intent: Readonly<LocalServiceManagerIntent>,
): void {
  if (intent.lineage.mode === 'fresh') {
    if (application.deployment.mode !== 'fresh') {
      configurationError('fresh service intent cannot start adopted storage');
    }
    return;
  }
  if (
    application.deployment.mode !== 'adopted' ||
    application.deployment.cutoverId !== intent.lineage.cutoverId ||
    application.deployment.expectedActivationDigest !==
      intent.lineage.expectedActivationDigest ||
    ((intent.action === 'install-enable-start' || intent.action === 'start') &&
      intent.lineage.generation === 1 &&
      application.deployment.expectedCommitmentDigest !==
        intent.lineage.previousRecordDigest)
  ) {
    configurationError(
      'service intent does not match adopted application binding',
    );
  }
}

function intentDirectory(deploymentRoot: string): string {
  return path.join(deploymentRoot, 'service', 'service-manager-intents');
}

function outcomeDirectory(deploymentRoot: string): string {
  return path.join(deploymentRoot, 'service', 'service-manager-outcomes');
}

function assertIntentLineageHead(
  intent: Readonly<LocalServiceManagerIntent>,
  uid: number,
): void {
  const headPath = localCutoverInstanceHeadPath(
    intent.deployment.root,
    intent.instanceId,
  );
  if (intent.lineage.mode === 'fresh') {
    if (fs.existsSync(headPath)) {
      configurationError(
        'fresh service intent cannot bypass an instance lineage head',
      );
    }
    return;
  }
  const head = assertLocalCutoverTargetHead(
    Object.freeze({
      options: Object.freeze({ deploymentRoot: intent.deployment.root }),
      request: Object.freeze({
        cutoverId: intent.lineage.cutoverId,
        profile: intent.profile,
        instanceId: intent.instanceId,
        expectedActivationDigest: intent.lineage.expectedActivationDigest,
        requestedAtMs: intent.requestedAtMs,
      }),
    }),
    uid,
  );
  const expected =
    intent.action === 'restart'
      ? Object.freeze({
          state: 'target_active' as const,
          generation: intent.lineage.generation - 1,
        })
      : intent.action === 'stop'
      ? Object.freeze({
          state: 'target_active' as const,
          generation: intent.lineage.generation,
        })
      : Object.freeze({ state: 'legacy_stopped' as const, generation: 0 });
  if (
    head.state !== expected.state ||
    head.generation !== expected.generation ||
    head.sourceRecordDigest !== intent.lineage.previousRecordDigest
  ) {
    configurationError(
      'service intent lost the instance lineage compare-and-swap',
    );
  }
}

function normalizePrepareCommand(
  value: unknown,
): Readonly<LocalServiceManagerIntentPrepareCommand> {
  const command = object(value, 'service manager intent command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  const options = object(command.options, 'options');
  exact(options, ['allowRootService', 'deploymentRoot'], 'options');
  const request = object(command.request, 'request');
  exact(
    request,
    ['action', 'actionId', 'lineage', 'requestedAtMs', 'serviceKind'],
    'request',
  );
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.deployment.service-manager.intent.prepare' ||
    typeof request.actionId !== 'string' ||
    !UUID_V4_PATTERN.test(request.actionId) ||
    (request.action !== 'install-enable-start' &&
      request.action !== 'start' &&
      request.action !== 'restart' &&
      request.action !== 'stop') ||
    (request.serviceKind !== 'systemd' && request.serviceKind !== 'openrc') ||
    !Number.isSafeInteger(request.requestedAtMs) ||
    (request.requestedAtMs as number) < 0
  ) {
    configurationError('service manager intent command is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.service-manager.intent.prepare' as const,
    options: Object.freeze({
      deploymentRoot: safeAbsolutePath(
        options.deploymentRoot,
        'deploymentRoot',
      ),
      allowRootService: options.allowRootService as boolean,
    }),
    request: Object.freeze({
      actionId: request.actionId,
      action: request.action,
      serviceKind: request.serviceKind,
      lineage: request.lineage as LocalServiceManagerIntentLineage,
      requestedAtMs: request.requestedAtMs as number,
    }),
  });
}

export function prepareLocalServiceManagerIntent(
  input: unknown,
): Readonly<LocalServiceManagerIntentPrepareResult> {
  const command = normalizePrepareCommand(input);
  const identity = validateIdentity(command.options.allowRootService);
  const root = command.options.deploymentRoot;
  const serviceRoot = path.join(root, 'service');
  validatePrivateDirectory(root, identity.uid, 'deploymentRoot');
  validatePrivateDirectory(serviceRoot, identity.uid, 'serviceDescriptorRoot');
  ensurePrivateDirectory(
    intentDirectory(root),
    identity.uid,
    'serviceManagerIntentRoot',
  );
  ensurePrivateDirectory(
    outcomeDirectory(root),
    identity.uid,
    'serviceManagerOutcomeRoot',
  );
  const applicationConfigPath = path.join(root, 'local-application.json');
  const applicationBytes = privateFileBytes(
    applicationConfigPath,
    0o600,
    identity.uid,
    identity.gid,
    MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
    'application configuration',
  );
  const descriptorPath = path.join(
    serviceRoot,
    command.request.serviceKind === 'systemd'
      ? 'qinglong3.service'
      : 'qinglong3.openrc',
  );
  const sourceMode = command.request.serviceKind === 'systemd' ? 0o600 : 0o700;
  const descriptorBytes = privateFileBytes(
    descriptorPath,
    sourceMode,
    identity.uid,
    identity.gid,
    MAX_DESCRIPTOR_BYTES,
    'service descriptor',
  );
  try {
    const application = parseApplicationIdentity(applicationBytes);
    const payload: Omit<LocalServiceManagerIntent, 'intentDigest'> =
      Object.freeze({
        schemaVersion: 1 as const,
        kind: 'qinglong3-local-service-manager-intent' as const,
        actionId: command.request.actionId,
        action: command.request.action,
        profile: application.profile,
        instanceId: application.instanceId,
        service: Object.freeze({
          kind: command.request.serviceKind,
          name: 'qinglong3' as const,
          uid: identity.uid,
          gid: identity.gid,
          allowRootService: command.options.allowRootService,
        }),
        deployment: Object.freeze({
          root,
          applicationConfigPath,
          applicationConfigSha256: sha256(applicationBytes),
        }),
        descriptor: Object.freeze({
          sourcePath: descriptorPath,
          destinationPath:
            command.request.serviceKind === 'systemd'
              ? '/etc/systemd/system/qinglong3.service'
              : '/etc/init.d/qinglong3',
          sha256: sha256(descriptorBytes),
          sourceMode,
          destinationMode:
            command.request.serviceKind === 'systemd' ? 0o644 : 0o755,
        }),
        lineage: command.request.lineage,
        outcomePath: localServiceManagerOutcomePath(
          root,
          command.request.actionId,
        ),
        requestedAtMs: command.request.requestedAtMs,
      });
    const intent = normalizeLocalServiceManagerIntent({
      ...payload,
      intentDigest: localServiceManagerIntentDigest(payload),
    });
    assertApplicationLineageBinding(application, intent);
    verifyApplicationDataCommitment(application);
    assertIntentLineageHead(intent, identity.uid);
    const intentPath = localServiceManagerIntentPath(root, intent.actionId);
    const contents = `${JSON.stringify(intent, null, 2)}\n`;
    preflightPublishedFile(
      intentPath,
      contents,
      0o600,
      identity.uid,
      'service manager intent',
    );
    const status = publishExactFile(
      intentPath,
      contents,
      0o600,
      identity.uid,
      'service manager intent',
    );
    return Object.freeze({
      schemaVersion: 1 as const,
      operation: 'local.deployment.service-manager.intent.prepare' as const,
      status,
      actionId: intent.actionId,
      intentPath,
      intentDigest: intent.intentDigest,
      outcomePath: intent.outcomePath,
    });
  } finally {
    applicationBytes.fill(0);
    descriptorBytes.fill(0);
  }
}

function normalizeConsumeCommand(
  value: unknown,
): Readonly<LocalServiceManagerOutcomeConsumeCommand> {
  const command = object(value, 'service manager outcome command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  const options = object(command.options, 'options');
  exact(options, ['allowRootService', 'deploymentRoot'], 'options');
  const request = object(command.request, 'request');
  exact(request, ['actionId', 'expectedIntentDigest'], 'request');
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.deployment.service-manager.outcome.consume' ||
    typeof request.actionId !== 'string' ||
    !UUID_V4_PATTERN.test(request.actionId) ||
    typeof request.expectedIntentDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedIntentDigest)
  ) {
    configurationError('service manager outcome command is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.service-manager.outcome.consume' as const,
    options: Object.freeze({
      deploymentRoot: safeAbsolutePath(
        options.deploymentRoot,
        'deploymentRoot',
      ),
      allowRootService: options.allowRootService as boolean,
    }),
    request: Object.freeze({
      actionId: request.actionId,
      expectedIntentDigest: request.expectedIntentDigest,
    }),
  });
}

function privateJsonGid(filePath: string, gid: number, label: string): unknown {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    configurationError(`${label} is unavailable`, error);
  }
  if (stat.gid !== gid) configurationError(`${label} group identity drifted`);
  return readPrivateLocalJsonFile(filePath, {
    maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
  });
}

export function consumeLocalServiceManagerOutcome(
  input: unknown,
): Readonly<LocalServiceManagerOutcomeConsumeResult> {
  const command = normalizeConsumeCommand(input);
  const identity = validateIdentity(command.options.allowRootService);
  validatePrivateDirectory(
    command.options.deploymentRoot,
    identity.uid,
    'deploymentRoot',
  );
  const intent = normalizeLocalServiceManagerIntent(
    privateJsonGid(
      localServiceManagerIntentPath(
        command.options.deploymentRoot,
        command.request.actionId,
      ),
      identity.gid,
      'service manager intent',
    ),
  );
  const outcome = normalizeLocalServiceManagerOutcome(
    privateJsonGid(
      localServiceManagerOutcomePath(
        command.options.deploymentRoot,
        command.request.actionId,
      ),
      identity.gid,
      'service manager outcome',
    ),
  );
  if (
    intent.actionId !== command.request.actionId ||
    intent.intentDigest !== command.request.expectedIntentDigest ||
    intent.service.uid !== identity.uid ||
    intent.service.gid !== identity.gid ||
    intent.service.allowRootService !== command.options.allowRootService ||
    intent.deployment.root !== command.options.deploymentRoot ||
    intent.outcomePath !==
      localServiceManagerOutcomePath(
        command.options.deploymentRoot,
        command.request.actionId,
      ) ||
    outcome.actionId !== intent.actionId ||
    outcome.action !== intent.action ||
    outcome.intentDigest !== intent.intentDigest ||
    outcome.descriptorDigest !== intent.descriptor.sha256 ||
    outcome.observation.managerKind !== intent.service.kind ||
    outcome.observation.fragmentPath !== intent.descriptor.destinationPath
  ) {
    configurationError('service manager outcome binding drifted');
  }
  assertIntentLineageHead(intent, identity.uid);
  const applicationBytes = privateFileBytes(
    intent.deployment.applicationConfigPath,
    0o600,
    identity.uid,
    identity.gid,
    MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
    'application configuration',
  );
  const descriptorBytes = privateFileBytes(
    intent.descriptor.sourcePath,
    intent.descriptor.sourceMode,
    identity.uid,
    identity.gid,
    MAX_DESCRIPTOR_BYTES,
    'service descriptor',
  );
  try {
    const application = parseApplicationIdentity(applicationBytes);
    if (
      sha256(applicationBytes) !== intent.deployment.applicationConfigSha256 ||
      sha256(descriptorBytes) !== intent.descriptor.sha256
    ) {
      configurationError('service manager source material drifted');
    }
    assertApplicationLineageBinding(application, intent);
    verifyApplicationDataCommitment(application);
  } finally {
    applicationBytes.fill(0);
    descriptorBytes.fill(0);
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.service-manager.outcome.consume' as const,
    status: 'verified' as const,
    actionId: outcome.actionId,
    state: outcome.state,
    outcomeDigest: outcome.outcomeDigest,
    observationDigest: outcome.observation.observationDigest,
  });
}

export function prepareLocalServiceManagerIntentCommandFile(
  filePath: string,
): Readonly<LocalServiceManagerIntentPrepareResult> {
  return prepareLocalServiceManagerIntent(
    readPrivateLocalJsonFile(filePath, {
      maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
    }),
  );
}

export function consumeLocalServiceManagerOutcomeCommandFile(
  filePath: string,
): Readonly<LocalServiceManagerOutcomeConsumeResult> {
  return consumeLocalServiceManagerOutcome(
    readPrivateLocalJsonFile(filePath, {
      maxBytes: MAX_PRIVATE_LOCAL_JSON_FILE_BYTES,
    }),
  );
}
