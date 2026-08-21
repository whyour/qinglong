import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  LocalDataDirectoryApplicationCommitError,
  normalizeLocalDataDirectoryApplicationCommit,
} from '@qinglong/local-sqlite/data-directory-application-commit';

import { initialComposeImageSelectionFromAuthority } from '../compose/composeRevision';
import { cutoverDigest } from '../cutover/targetEvidence';
import { LocalDeploymentConfigurationError } from '../foundation/error';
import { composeProjectName } from '../foundation/render';
import type {
  NormalizedLocalDeploymentAdoptedBundleCommand,
  NormalizedLocalDeploymentAdoptedComposeService,
} from './contract';

const MAX_JSON_BYTES = 1024 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface LocalDeploymentAdoptedBundlePaths {
  readonly ownerPepperKeyring: string;
  readonly ownerPepperBackup: string;
  readonly secretKeyring: string;
  readonly receipts: string;
  readonly artifacts: string;
  readonly pluginStaging: string;
  readonly pluginActivation: string;
  readonly service: string;
  readonly applicationConfig: string;
  readonly descriptor: string;
  readonly bundleReceipt: string;
  readonly composeSelection: string;
  readonly composeRevisions: string;
  readonly composeRevision: string;
}

export interface LocalDeploymentAdoptedEvidence {
  readonly activationDigest: string;
  readonly commitmentDigest: string;
  readonly commitDigest: string;
  readonly receiptDigest: string;
  readonly manifestDigest: string;
  readonly sourceSha256: string;
  readonly recoverySha256: string;
  readonly targetDevice: string;
  readonly targetInode: string;
  readonly targetIdentityDigest: string;
}

export interface LocalDeploymentAdoptedBundleReceipt {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-local-adopted-deployment-bundle';
  readonly state: 'prepared';
  readonly bundleId: string;
  readonly preparedAtMs: number;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly cutoverId: string;
  readonly serviceKind: 'systemd' | 'openrc' | 'compose';
  readonly deploymentRootDigest: string;
  readonly sourcePathDigest: string;
  readonly applicationConfigDigest: string;
  readonly serviceDescriptorDigest: string;
  readonly composeSelectionDigest: string | null;
  readonly activationDigest: string;
  readonly commitmentDigest: string;
  readonly legacyDataApplicationCommitDigest: string;
  readonly legacyDataApplicationReceiptDigest: string;
  readonly manifestDigest: string;
  readonly sourceSha256: string;
  readonly recoverySha256: string;
  readonly targetIdentityDigest: string;
  readonly bundleDigest: string;
}

export interface LocalDeploymentAdoptedBundleMaterial {
  readonly paths: Readonly<LocalDeploymentAdoptedBundlePaths>;
  readonly applicationConfig: string;
  readonly descriptor: Readonly<{
    fileName: string;
    contents: string;
    mode: number;
  }>;
  readonly composeSelection: string | null;
  readonly receipt: Readonly<LocalDeploymentAdoptedBundleReceipt>;
  readonly receiptContents: string;
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

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readPrivateJson(
  filePath: string,
  uid: number,
  gid: number,
  label: string,
): unknown {
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      Number(opened.uid) !== uid ||
      Number(opened.gid) !== gid ||
      (Number(opened.mode) & 0o777) !== 0o600 ||
      opened.nlink !== 1n ||
      opened.size < 2n ||
      opened.size > BigInt(MAX_JSON_BYTES) ||
      fs.realpathSync(filePath) !== filePath
    ) {
      configurationError(`${label} identity is invalid`);
    }
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      offset !== bytes.byteLength ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      after.uid !== opened.uid ||
      after.gid !== opened.gid ||
      after.mode !== opened.mode ||
      after.nlink !== opened.nlink
    ) {
      configurationError(`${label} changed while reading`);
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError(`${label} cannot be read`, error);
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function privateFileIdentity(
  filePath: string,
  uid: number,
  gid: number,
  label: string,
): Readonly<{ device: string; inode: string; digest: string }> {
  try {
    const stat = fs.lstatSync(filePath, { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      Number(stat.uid) !== uid ||
      Number(stat.gid) !== gid ||
      (Number(stat.mode) & 0o777) !== 0o600 ||
      stat.nlink !== 1n ||
      fs.realpathSync(filePath) !== filePath
    ) {
      configurationError(`${label} identity is invalid`);
    }
    const device = stat.dev.toString();
    const inode = stat.ino.toString();
    return Object.freeze({
      device,
      inode,
      digest: cutoverDigest({
        pathDigest: sha256(filePath),
        device,
        inode,
        uid,
        gid,
        mode: 0o600,
      }),
    });
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError(`${label} cannot be inspected`, error);
  }
}

function stableFileSha256(
  filePath: string,
  uid: number,
  gid: number,
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
      Number(opened.uid) !== uid ||
      Number(opened.gid) !== gid ||
      (Number(opened.mode) & 0o777) !== 0o600 ||
      opened.nlink !== 1n ||
      fs.realpathSync(filePath) !== filePath
    ) {
      configurationError(`${label} identity is invalid`);
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
      after.uid !== opened.uid ||
      after.gid !== opened.gid ||
      after.mode !== opened.mode ||
      after.nlink !== opened.nlink
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

export function adoptedBundlePaths(
  command: Readonly<NormalizedLocalDeploymentAdoptedBundleCommand>,
): Readonly<LocalDeploymentAdoptedBundlePaths> {
  const root = command.options.deploymentRoot;
  const service = path.join(root, 'service');
  const descriptorName =
    command.options.service.kind === 'systemd'
      ? 'qinglong3.service'
      : command.options.service.kind === 'openrc'
      ? 'qinglong3.openrc'
      : 'compose.yaml';
  return Object.freeze({
    ownerPepperKeyring: path.join(root, 'owner-peppers'),
    ownerPepperBackup: path.join(root, 'owner-pepper-backup'),
    secretKeyring: path.join(root, 'local-secret-keyring.json'),
    receipts: path.join(root, 'receipts'),
    artifacts: path.join(root, 'artifacts'),
    pluginStaging: path.join(root, 'plugin-staging'),
    pluginActivation: path.join(root, 'plugin-activation'),
    service,
    applicationConfig: path.join(root, 'local-application.json'),
    descriptor: path.join(service, descriptorName),
    bundleReceipt: path.join(service, 'adopted-bundle.json'),
    composeSelection: path.join(service, 'compose.image.yaml'),
    composeRevisions: path.join(service, 'revisions'),
    composeRevision: path.join(service, 'revisions', '1.yaml'),
  });
}

export function verifyLocalDeploymentAdoptedEvidence(
  command: Readonly<NormalizedLocalDeploymentAdoptedBundleCommand>,
  uid: number,
  gid: number,
): Readonly<LocalDeploymentAdoptedEvidence> {
  const activation = object(
    readPrivateJson(
      command.request.storage.activationPath,
      uid,
      gid,
      'activation',
    ),
    'activation',
  );
  exact(
    activation,
    [
      'activationDigest',
      'adoptionManifestDigest',
      'createdAtMs',
      'kind',
      'planDigest',
      'profile',
      'recoverySha256',
      'schemaVersion',
      'sourcePathDigest',
      'sourceSha256',
      'state',
      'targetDevice',
      'targetInode',
      'targetPathDigest',
      'targetSha256',
    ],
    'activation',
  );
  const { activationDigest, ...activationPayload } = activation;
  const manifest = object(
    readPrivateJson(
      command.request.storage.manifestPath,
      uid,
      gid,
      'adoption manifest',
    ),
    'adoption manifest',
  );
  const { manifestDigest, ...manifestPayload } = manifest;
  const commitment = object(
    readPrivateJson(
      command.request.cutover.commitmentPath,
      uid,
      gid,
      'legacy silence commitment',
    ),
    'legacy silence commitment',
  );
  exact(
    commitment,
    [
      'activationDigest',
      'commitmentDigest',
      'controller',
      'cutoverId',
      'instanceId',
      'kind',
      'observedAtMs',
      'previousRecordDigest',
      'profile',
      'requestedAtMs',
      'schemaVersion',
      'state',
    ],
    'legacy silence commitment',
  );
  const controller = object(commitment.controller, 'commitment controller');
  exact(
    controller,
    [
      'endpointDigest',
      'kind',
      'legacyContainerId',
      'legacyContainerIdentityDigest',
      'legacySourceBindingDigest',
    ],
    'commitment controller',
  );
  const { commitmentDigest, ...commitmentPayload } = commitment;
  if (
    activation.schemaVersion !== 1 ||
    activation.kind !== 'qinglong3-local-sqlite-activation' ||
    activation.state !== 'prepared' ||
    activation.profile !== command.options.profile ||
    activation.sourcePathDigest !==
      sha256(command.request.storage.sourcePath) ||
    activation.targetPathDigest !==
      sha256(command.request.storage.targetPath) ||
    activationDigest !== command.request.storage.expectedActivationDigest ||
    typeof activationDigest !== 'string' ||
    !DIGEST_PATTERN.test(activationDigest) ||
    typeof activation.sourceSha256 !== 'string' ||
    !DIGEST_PATTERN.test(activation.sourceSha256) ||
    typeof activation.recoverySha256 !== 'string' ||
    !DIGEST_PATTERN.test(activation.recoverySha256) ||
    typeof activation.targetSha256 !== 'string' ||
    !DIGEST_PATTERN.test(activation.targetSha256) ||
    typeof activation.adoptionManifestDigest !== 'string' ||
    !DIGEST_PATTERN.test(activation.adoptionManifestDigest) ||
    cutoverDigest(activationPayload) !== activationDigest ||
    typeof manifestDigest !== 'string' ||
    !DIGEST_PATTERN.test(manifestDigest) ||
    cutoverDigest(manifestPayload) !== manifestDigest ||
    activation.adoptionManifestDigest !== manifestDigest ||
    commitment.schemaVersion !== 1 ||
    commitment.kind !== 'qinglong3-local-legacy-silence-commitment' ||
    commitment.state !== 'legacy_stopped' ||
    commitment.cutoverId !== command.request.cutoverId ||
    commitment.profile !== command.options.profile ||
    commitment.instanceId !== command.options.instanceId ||
    commitment.activationDigest !== activationDigest ||
    commitmentDigest !== command.request.cutover.expectedCommitmentDigest ||
    typeof commitmentDigest !== 'string' ||
    !DIGEST_PATTERN.test(commitmentDigest) ||
    controller.kind !== 'docker' ||
    typeof controller.endpointDigest !== 'string' ||
    !DIGEST_PATTERN.test(controller.endpointDigest) ||
    typeof controller.legacyContainerId !== 'string' ||
    !DIGEST_PATTERN.test(controller.legacyContainerId) ||
    typeof controller.legacyContainerIdentityDigest !== 'string' ||
    !DIGEST_PATTERN.test(controller.legacyContainerIdentityDigest) ||
    typeof controller.legacySourceBindingDigest !== 'string' ||
    !DIGEST_PATTERN.test(controller.legacySourceBindingDigest) ||
    cutoverDigest(commitmentPayload) !== commitmentDigest
  ) {
    configurationError('adopted activation or commitment drifted');
  }
  let dataCommit;
  try {
    dataCommit = normalizeLocalDataDirectoryApplicationCommit(
      readPrivateJson(
        command.request.legacyDataApplication.commitPath,
        uid,
        gid,
        'legacy data application commit',
      ),
    );
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    if (error instanceof LocalDataDirectoryApplicationCommitError) {
      return configurationError(
        'legacy data application commit is invalid',
        error,
      );
    }
    throw error;
  }
  if (
    dataCommit.profile !== command.options.profile ||
    dataCommit.commitDigest !==
      command.request.legacyDataApplication.expectedCommitDigest ||
    dataCommit.receiptDigest !==
      command.request.legacyDataApplication.expectedReceiptDigest
  ) {
    configurationError('legacy data application commit drifted');
  }
  const source = privateFileIdentity(
    command.request.storage.sourcePath,
    uid,
    gid,
    'legacy source',
  );
  const target = privateFileIdentity(
    command.request.storage.targetPath,
    uid,
    gid,
    'target database',
  );
  const recovery = privateFileIdentity(
    command.request.storage.recoveryPath,
    uid,
    gid,
    'recovery database',
  );
  const sourceSha256 = stableFileSha256(
    command.request.storage.sourcePath,
    uid,
    gid,
    'legacy source',
  );
  const recoverySha256 = stableFileSha256(
    command.request.storage.recoveryPath,
    uid,
    gid,
    'recovery database',
  );
  if (
    activation.targetDevice !== target.device ||
    activation.targetInode !== target.inode ||
    activation.sourceSha256 !== sourceSha256 ||
    activation.recoverySha256 !== recoverySha256
  ) {
    configurationError('adopted data identity drifted');
  }
  return Object.freeze({
    activationDigest,
    commitmentDigest,
    commitDigest: dataCommit.commitDigest,
    receiptDigest: dataCommit.receiptDigest,
    manifestDigest,
    sourceSha256,
    recoverySha256,
    targetDevice: target.device,
    targetInode: target.inode,
    targetIdentityDigest: cutoverDigest({
      source: source.digest,
      target: target.digest,
      recovery: recovery.digest,
      manifestDigest,
    }),
  });
}

function applicationConfig(
  command: Readonly<NormalizedLocalDeploymentAdoptedBundleCommand>,
  paths: Readonly<LocalDeploymentAdoptedBundlePaths>,
): string {
  const pageSize = command.options.profile === 'edge' ? 4 : 16;
  return `${JSON.stringify(
    {
      schema: 'qinglong/local-application-process@v4',
      instanceId: command.options.instanceId,
      profile: command.options.profile,
      storage: {
        mode: 'adopted',
        sourcePath: command.request.storage.sourcePath,
        targetPath: command.request.storage.targetPath,
        recoveryPath: command.request.storage.recoveryPath,
        manifestPath: command.request.storage.manifestPath,
        activationPath: command.request.storage.activationPath,
        expectedActivationDigest:
          command.request.storage.expectedActivationDigest,
        ...(command.options.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: command.options.busyTimeoutMs }),
      },
      runtime: {
        receiptRoot: paths.receipts,
        artifactRoot: paths.artifacts,
        secretKeyringPath: paths.secretKeyring,
      },
      pluginPackages: {
        stagingRoot: paths.pluginStaging,
        activationRoot: paths.pluginActivation,
        recoverySource: { mode: 'disabled' },
        pageSize,
        maxPages: pageSize,
        taskPublicationPageSize: pageSize,
        taskPublicationMaxPages: pageSize,
      },
      ai: { deployment: 'excluded' },
      cutover: {
        cutoverId: command.request.cutoverId,
        commitmentPath: command.request.cutover.commitmentPath,
        expectedCommitmentDigest:
          command.request.cutover.expectedCommitmentDigest,
      },
      legacyDataApplication: {
        commitPath: command.request.legacyDataApplication.commitPath,
        expectedCommitDigest:
          command.request.legacyDataApplication.expectedCommitDigest,
        expectedReceiptDigest:
          command.request.legacyDataApplication.expectedReceiptDigest,
      },
    },
    null,
    2,
  )}\n`;
}

function systemdDescriptor(
  command: Readonly<NormalizedLocalDeploymentAdoptedBundleCommand>,
  configPath: string,
  uid: number,
  gid: number,
): string {
  if (command.options.service.kind === 'compose') {
    configurationError('systemd descriptor requires a process service');
  }
  const edge = command.options.profile === 'edge';
  return [
    '[Unit]',
    'Description=QingLong 3.0 adopted local automation runtime',
    'After=local-fs.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${uid}`,
    `Group=${gid}`,
    `WorkingDirectory=${command.options.deploymentRoot}`,
    `ExecStart=${command.options.service.nodeExecutable} ${command.options.service.applicationEntrypoint} --config ${configPath}`,
    'Environment=NODE_ENV=production',
    'UMask=0077',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=30s',
    'Restart=on-failure',
    'RestartSec=5s',
    'RestartPreventExitStatus=64',
    'NoNewPrivileges=yes',
    'PrivateTmp=yes',
    'ProtectSystem=strict',
    `ReadWritePaths=${command.options.deploymentRoot}`,
    `ReadOnlyPaths=${command.request.storage.sourcePath}`,
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectControlGroups=yes',
    'RestrictSUIDSGID=yes',
    'LockPersonality=yes',
    `LimitNOFILE=${edge ? 1024 : 4096}`,
    `TasksMax=${edge ? 64 : 256}`,
    `MemoryMax=${edge ? '128M' : '256M'}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

function openrcDescriptor(
  command: Readonly<NormalizedLocalDeploymentAdoptedBundleCommand>,
  configPath: string,
  uid: number,
  gid: number,
): string {
  if (command.options.service.kind === 'compose') {
    configurationError('OpenRC descriptor requires a process service');
  }
  const edge = command.options.profile === 'edge';
  return [
    '#!/sbin/openrc-run',
    '',
    'name="qinglong3"',
    'description="QingLong 3.0 adopted local automation runtime"',
    `command="${command.options.service.nodeExecutable}"`,
    `command_args="${command.options.service.applicationEntrypoint} --config ${configPath}"`,
    `command_user="${uid}:${gid}"`,
    `directory="${command.options.deploymentRoot}"`,
    'supervisor="supervise-daemon"',
    'respawn_delay=5',
    'respawn_max=5',
    'respawn_period=60',
    'retry="TERM/30/KILL/5"',
    'umask=0077',
    `rc_ulimit="-n ${edge ? 1024 : 4096}"`,
    '',
    'depend() {',
    '  need localmount',
    '  after bootmisc',
    '}',
    '',
  ].join('\n');
}

function composeDescriptor(
  command: Readonly<NormalizedLocalDeploymentAdoptedBundleCommand>,
  configDigest: string,
  uid: number,
  gid: number,
): string {
  const edge = command.options.profile === 'edge';
  return [
    `name: ${composeProjectName(command.options.instanceId)}`,
    '',
    'services:',
    '  qinglong3:',
    `    user: "${uid}:${gid}"`,
    '    read_only: true',
    '    init: true',
    '    network_mode: none',
    '    command:',
    '      - --config',
    `      - ${command.options.deploymentRoot}/local-application.json`,
    '    volumes:',
    '      - type: bind',
    `        source: ${command.options.deploymentRoot}`,
    `        target: ${command.options.deploymentRoot}`,
    '      - type: bind',
    `        source: ${command.request.storage.sourcePath}`,
    `        target: ${command.request.storage.sourcePath}`,
    '        read_only: true',
    '    tmpfs:',
    '      - /tmp:rw,noexec,nosuid,nodev,size=16m',
    '    cap_drop:',
    '      - ALL',
    '    security_opt:',
    '      - no-new-privileges:true',
    '    restart: "no"',
    '    stop_grace_period: 30s',
    `    mem_limit: ${edge ? '128m' : '256m'}`,
    `    pids_limit: ${edge ? 64 : 256}`,
    '    labels:',
    '      io.qinglong.deployment.mode: adopted',
    `      io.qinglong.deployment.profile: ${command.options.profile}`,
    `      io.qinglong.deployment.instance: ${command.options.instanceId}`,
    `      io.qinglong.deployment.bundle: "${command.request.bundleId}"`,
    `      io.qinglong.application.config: "${configDigest}"`,
    `      io.qinglong.data.commit: "${command.request.legacyDataApplication.expectedCommitDigest}"`,
    `      io.qinglong.data.receipt: "${command.request.legacyDataApplication.expectedReceiptDigest}"`,
    '',
  ].join('\n');
}

function serviceDescriptor(
  command: Readonly<NormalizedLocalDeploymentAdoptedBundleCommand>,
  configPath: string,
  configDigest: string,
  uid: number,
  gid: number,
): Readonly<{ fileName: string; contents: string; mode: number }> {
  if (command.options.service.kind === 'systemd') {
    return Object.freeze({
      fileName: 'qinglong3.service',
      contents: systemdDescriptor(command, configPath, uid, gid),
      mode: 0o600,
    });
  }
  if (command.options.service.kind === 'openrc') {
    return Object.freeze({
      fileName: 'qinglong3.openrc',
      contents: openrcDescriptor(command, configPath, uid, gid),
      mode: 0o700,
    });
  }
  return Object.freeze({
    fileName: 'compose.yaml',
    contents: composeDescriptor(command, configDigest, uid, gid),
    mode: 0o600,
  });
}

export function renderLocalDeploymentAdoptedBundleMaterial(
  command: Readonly<NormalizedLocalDeploymentAdoptedBundleCommand>,
  evidence: Readonly<LocalDeploymentAdoptedEvidence>,
  uid: number,
  gid: number,
): Readonly<LocalDeploymentAdoptedBundleMaterial> {
  const paths = adoptedBundlePaths(command);
  const config = applicationConfig(command, paths);
  const configDigest = sha256(config);
  const descriptor = serviceDescriptor(
    command,
    paths.applicationConfig,
    configDigest,
    uid,
    gid,
  );
  const composeSelection =
    command.options.service.kind === 'compose'
      ? initialComposeImageSelectionFromAuthority({
          service: command.options
            .service as NormalizedLocalDeploymentAdoptedComposeService,
          mutationId: command.request.bundleId,
          changedAtMs: command.request.preparedAtMs,
        })
      : null;
  const receiptPayload = {
    schemaVersion: 1 as const,
    kind: 'qinglong3-local-adopted-deployment-bundle' as const,
    state: 'prepared' as const,
    bundleId: command.request.bundleId,
    preparedAtMs: command.request.preparedAtMs,
    profile: command.options.profile,
    instanceId: command.options.instanceId,
    cutoverId: command.request.cutoverId,
    serviceKind: command.options.service.kind,
    deploymentRootDigest: sha256(command.options.deploymentRoot),
    sourcePathDigest: sha256(command.request.storage.sourcePath),
    applicationConfigDigest: configDigest,
    serviceDescriptorDigest: sha256(descriptor.contents),
    composeSelectionDigest:
      composeSelection === null ? null : sha256(composeSelection),
    activationDigest: evidence.activationDigest,
    commitmentDigest: evidence.commitmentDigest,
    legacyDataApplicationCommitDigest: evidence.commitDigest,
    legacyDataApplicationReceiptDigest: evidence.receiptDigest,
    manifestDigest: evidence.manifestDigest,
    sourceSha256: evidence.sourceSha256,
    recoverySha256: evidence.recoverySha256,
    targetIdentityDigest: evidence.targetIdentityDigest,
  };
  const receipt = Object.freeze({
    ...receiptPayload,
    bundleDigest: cutoverDigest(receiptPayload),
  });
  return Object.freeze({
    paths,
    applicationConfig: config,
    descriptor,
    composeSelection,
    receipt,
    receiptContents: `${JSON.stringify(receipt, null, 2)}\n`,
  });
}
