import crypto from 'node:crypto';
import path from 'node:path';

import type { LocalSetupCommand } from '../../lifecycle/localSetup';
import type {
  LocalDeploymentPrepareCommand,
  LocalDeploymentProcessService,
} from './contract';

const CONTAINER_ROOT = '/var/lib/qinglong3';

export function composeProjectName(instanceId: string): string {
  const slug = instanceId.replaceAll('.', '-').slice(0, 32);
  const suffix = crypto
    .createHash('sha256')
    .update('qinglong:local-compose-project:v1\0', 'utf8')
    .update(instanceId, 'utf8')
    .digest('hex')
    .slice(0, 12);
  return `ql3-${slug}-${suffix}`;
}

export interface LocalDeploymentPaths {
  readonly database: string;
  readonly ownerPepperKeyring: string;
  readonly ownerPepperBackup: string;
  readonly localSecretKeyring: string;
  readonly receipts: string;
  readonly artifacts: string;
  readonly pluginStaging: string;
  readonly pluginActivation: string;
  readonly service: string;
  readonly applicationConfig: string;
  readonly composeSelection: string;
  readonly composeRevisions: string;
  readonly composeRevisionLock: string;
  readonly composeRollouts: string;
  readonly composeRolloutLock: string;
  readonly composeRolloutBackups: string;
  readonly composeRestores: string;
  readonly composeRestoreLock: string;
  readonly composeRestoreSafeguards: string;
  readonly composeEvidenceCollections: string;
  readonly composeEvidenceCollectionLock: string;
  readonly composeCollectedEvidence: string;
  readonly composeCollectedRolloutBackups: string;
  readonly composeCollectedRestoreSafeguards: string;
}

export function deploymentPaths(root: string): Readonly<LocalDeploymentPaths> {
  return Object.freeze({
    database: path.join(root, 'qinglong3.sqlite'),
    ownerPepperKeyring: path.join(root, 'owner-peppers'),
    ownerPepperBackup: path.join(root, 'owner-pepper-backup'),
    localSecretKeyring: path.join(root, 'local-secret-keyring.json'),
    receipts: path.join(root, 'receipts'),
    artifacts: path.join(root, 'artifacts'),
    pluginStaging: path.join(root, 'plugin-staging'),
    pluginActivation: path.join(root, 'plugin-activation'),
    service: path.join(root, 'service'),
    applicationConfig: path.join(root, 'local-application.json'),
    composeSelection: path.join(root, 'service', 'compose.image.yaml'),
    composeRevisions: path.join(root, 'service', 'revisions'),
    composeRevisionLock: path.join(root, 'service', '.compose-revision.lock'),
    composeRollouts: path.join(root, 'service', 'rollouts'),
    composeRolloutLock: path.join(root, 'service', '.compose-rollout.lock'),
    composeRolloutBackups: path.join(root, 'service', 'rollout-backups'),
    composeRestores: path.join(root, 'service', 'restores'),
    composeRestoreLock: path.join(root, 'service', '.compose-restore.lock'),
    composeRestoreSafeguards: path.join(root, 'service', 'restore-safeguards'),
    composeEvidenceCollections: path.join(
      root,
      'service',
      'evidence-collections',
    ),
    composeEvidenceCollectionLock: path.join(
      root,
      'service',
      '.compose-evidence-collection.lock',
    ),
    composeCollectedEvidence: path.join(root, 'service', 'collected-evidence'),
    composeCollectedRolloutBackups: path.join(
      root,
      'service',
      'collected-evidence',
      'rollout-backups',
    ),
    composeCollectedRestoreSafeguards: path.join(
      root,
      'service',
      'collected-evidence',
      'restore-safeguards',
    ),
  });
}

export function applicationConfiguration(
  command: Readonly<LocalDeploymentPrepareCommand>,
  paths: Readonly<LocalDeploymentPaths>,
): string {
  const runtimeRoot =
    command.options.service.kind === 'compose'
      ? CONTAINER_ROOT
      : command.options.deploymentRoot;
  const pageSize = command.options.profile === 'edge' ? 4 : 16;
  return `${JSON.stringify(
    {
      schema: 'qinglong/local-application-process@v2',
      instanceId: command.options.instanceId,
      profile: command.options.profile,
      storage: {
        mode: 'fresh',
        databasePath: path.join(runtimeRoot, path.basename(paths.database)),
        ...(command.options.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: command.options.busyTimeoutMs }),
      },
      runtime: {
        receiptRoot: path.join(runtimeRoot, path.basename(paths.receipts)),
        artifactRoot: path.join(runtimeRoot, path.basename(paths.artifacts)),
        secretKeyringPath: path.join(
          runtimeRoot,
          path.basename(paths.localSecretKeyring),
        ),
      },
      pluginPackages: {
        stagingRoot: path.join(runtimeRoot, path.basename(paths.pluginStaging)),
        activationRoot: path.join(
          runtimeRoot,
          path.basename(paths.pluginActivation),
        ),
        recoverySource: {
          mode: 'disabled',
        },
        pageSize,
        maxPages: pageSize,
        taskPublicationPageSize: pageSize,
        taskPublicationMaxPages: pageSize,
      },
      ai: {
        deployment: 'excluded',
      },
    },
    null,
    2,
  )}\n`;
}

function systemdDescriptor(
  command: Readonly<LocalDeploymentPrepareCommand>,
  configPath: string,
  uid: number,
  gid: number,
): string {
  const service = command.options.service as LocalDeploymentProcessService;
  const edge = command.options.profile === 'edge';
  return [
    '[Unit]',
    'Description=QingLong 3.0 local automation runtime',
    'After=local-fs.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${uid}`,
    `Group=${gid}`,
    `WorkingDirectory=${command.options.deploymentRoot}`,
    `ExecStart=${service.nodeExecutable} ${service.applicationEntrypoint} --config ${configPath}`,
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
  command: Readonly<LocalDeploymentPrepareCommand>,
  configPath: string,
  uid: number,
  gid: number,
): string {
  const service = command.options.service as LocalDeploymentProcessService;
  const edge = command.options.profile === 'edge';
  return [
    '#!/sbin/openrc-run',
    '',
    'name="qinglong3"',
    'description="QingLong 3.0 local automation runtime"',
    `command="${service.nodeExecutable}"`,
    `command_args="${service.applicationEntrypoint} --config ${configPath}"`,
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
  command: Readonly<LocalDeploymentPrepareCommand>,
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
    `      - ${CONTAINER_ROOT}/local-application.json`,
    '    volumes:',
    '      - type: bind',
    `        source: ${command.options.deploymentRoot}`,
    `        target: ${CONTAINER_ROOT}`,
    '    tmpfs:',
    '      - /tmp:rw,noexec,nosuid,nodev,size=16m',
    '    cap_drop:',
    '      - ALL',
    '    security_opt:',
    '      - no-new-privileges:true',
    '    restart: unless-stopped',
    '    stop_grace_period: 30s',
    `    mem_limit: ${edge ? '128m' : '256m'}`,
    `    pids_limit: ${edge ? 64 : 256}`,
    '',
  ].join('\n');
}

export function descriptor(
  command: Readonly<LocalDeploymentPrepareCommand>,
  configPath: string,
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
    contents: composeDescriptor(command, uid, gid),
    mode: 0o600,
  });
}

export function setupCommand(
  command: Readonly<LocalDeploymentPrepareCommand>,
  paths: Readonly<LocalDeploymentPaths>,
): Readonly<LocalSetupCommand> {
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.setup.prepare' as const,
    options: Object.freeze({
      deploymentRoot: command.options.deploymentRoot,
      databasePath: paths.database,
      profile: command.options.profile,
      ownerPepperKeyringDirectory: paths.ownerPepperKeyring,
      ownerPepperBackupDirectory: paths.ownerPepperBackup,
      ownerPepperKeyId: command.request.ownerPepperKeyId,
      localSecretKeyringPath: paths.localSecretKeyring,
      ...(command.options.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: command.options.busyTimeoutMs }),
    }),
    request: Object.freeze({
      registerMutationId: command.request.registerMutationId,
      activateMutationId: command.request.activateMutationId,
      registeredAtMs: command.request.registeredAtMs,
      activatedAtMs: command.request.activatedAtMs,
    }),
  });
}
