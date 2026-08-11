import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';
import {
  inspectLocalSqliteReadinessPath,
  LOCAL_SQLITE_CONTRACT_VERSION,
} from '@qinglong/local-sqlite/readiness-inspection';

import {
  currentIdentity,
  LocalDeploymentConfigurationError,
  normalizeLocalDeploymentComposePreflightCommand,
  normalizeLocalDeploymentPrepareCommand,
  type LocalDeploymentComposePreflightResult,
  type LocalDeploymentProfile,
} from '../foundation/contract';
import { inspectActiveComposeImageSelection } from './composeRevision';
import {
  runLocalDeploymentDockerCommand,
  validateLocalDeploymentDockerSocket,
  type LocalDeploymentDockerRunner,
} from '../foundation/docker';
import {
  preflightPublishedFile,
  validatePrivateDirectory,
} from '../foundation/files';
import {
  applicationConfiguration,
  composeProjectName,
  deploymentPaths,
  descriptor,
} from '../foundation/render';

const CONTAINER_ROOT = '/var/lib/qinglong3';
const MAX_DOCKER_OUTPUT_BYTES = 256 * 1024;
const SOURCE_REPOSITORY = 'https://github.com/whyour/qinglong';
const ENTRYPOINT = Object.freeze([
  'node',
  '/opt/qinglong/node_modules/@qinglong/local-application/dist/cli.js',
]);

export interface LocalDeploymentComposePreflightDependencies {
  readonly runDocker?: LocalDeploymentDockerRunner;
  readonly auditSqlite?: typeof inspectLocalSqliteReadinessPath;
  readonly validateSocket?: (socketPath: string, uid: number) => void;
}

interface ApplicationIdentity {
  readonly instanceId: string;
  readonly profile: LocalDeploymentProfile;
  readonly busyTimeoutMs?: number;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function readApplicationIdentity(
  filePath: string,
  uid: number,
): Readonly<ApplicationIdentity> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    configurationError('application configuration is unavailable', error);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.nlink !== 1 ||
    stat.size < 2 ||
    stat.size > 64 * 1024
  ) {
    configurationError('application configuration identity is invalid');
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    configurationError('application configuration is invalid', error);
  }
  const candidate = value as {
    readonly schema?: unknown;
    readonly instanceId?: unknown;
    readonly profile?: unknown;
    readonly storage?: {
      readonly mode?: unknown;
      readonly databasePath?: unknown;
      readonly busyTimeoutMs?: unknown;
    };
  };
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    candidate.schema !== 'qinglong/local-application-process@v2' ||
    typeof candidate.instanceId !== 'string' ||
    (candidate.profile !== 'edge' && candidate.profile !== 'standalone') ||
    !candidate.storage ||
    candidate.storage.mode !== 'fresh' ||
    candidate.storage.databasePath !== `${CONTAINER_ROOT}/qinglong3.sqlite`
  ) {
    configurationError('application configuration is not a fresh Compose v2');
  }
  const busyTimeoutMs =
    candidate.storage.busyTimeoutMs === undefined
      ? undefined
      : candidate.storage.busyTimeoutMs;
  if (
    busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(busyTimeoutMs) ||
      (busyTimeoutMs as number) < 100 ||
      (busyTimeoutMs as number) > 30_000)
  ) {
    configurationError('application busyTimeoutMs is invalid');
  }
  return Object.freeze({
    instanceId: candidate.instanceId,
    profile: candidate.profile,
    ...(busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: busyTimeoutMs as number }),
  });
}

function parseJson(value: string, label: string): unknown {
  if (
    Buffer.byteLength(value, 'utf8') < 2 ||
    Buffer.byteLength(value, 'utf8') > MAX_DOCKER_OUTPUT_BYTES
  ) {
    configurationError(`${label} output size is invalid`);
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    configurationError(`${label} output is not JSON`, error);
  }
}

function safeLabel(
  labels: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = labels[name];
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    configurationError(`image label ${name} is invalid`);
  }
  return value;
}

function inspectImage(
  output: string,
  image: string,
  profile: LocalDeploymentProfile,
  sqliteContractVersion: number,
): 'amd64' | 'arm64' {
  const parsed = parseJson(output, 'Docker image inspect') as unknown[];
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    configurationError('Docker image inspect result is invalid');
  }
  const record = parsed[0] as {
    readonly Id?: unknown;
    readonly RepoDigests?: unknown;
    readonly Architecture?: unknown;
    readonly Os?: unknown;
    readonly Config?: {
      readonly User?: unknown;
      readonly Entrypoint?: unknown;
      readonly Labels?: unknown;
    };
  };
  if (
    !record ||
    typeof record !== 'object' ||
    typeof record.Id !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(record.Id) ||
    !Array.isArray(record.RepoDigests) ||
    !record.RepoDigests.includes(image) ||
    (record.Architecture !== 'amd64' && record.Architecture !== 'arm64') ||
    record.Os !== 'linux' ||
    record.Config?.User !== '65532:65532' ||
    JSON.stringify(record.Config?.Entrypoint) !== JSON.stringify(ENTRYPOINT) ||
    !record.Config?.Labels ||
    typeof record.Config.Labels !== 'object' ||
    Array.isArray(record.Config.Labels)
  ) {
    configurationError('local image identity is incompatible');
  }
  const labels = record.Config.Labels as Readonly<Record<string, unknown>>;
  const minimum = safeLabel(labels, 'io.qinglong.local.sqlite-contract-min');
  const maximum = safeLabel(labels, 'io.qinglong.local.sqlite-contract-max');
  const profiles = safeLabel(labels, 'io.qinglong.profile').split(',');
  if (
    !/^[1-9][0-9]{0,3}$/.test(minimum) ||
    !/^[1-9][0-9]{0,3}$/.test(maximum) ||
    Number(minimum) > sqliteContractVersion ||
    Number(maximum) < sqliteContractVersion ||
    safeLabel(labels, 'io.qinglong.local.sqlite-write-contract') !==
      String(sqliteContractVersion) ||
    safeLabel(labels, 'io.qinglong.local.application-config') !== '2' ||
    safeLabel(labels, 'io.qinglong.local.compose-selection') !== '1' ||
    safeLabel(labels, 'io.qinglong.ai') !== 'excluded' ||
    !profiles.includes(profile) ||
    safeLabel(labels, 'org.opencontainers.image.source') !==
      SOURCE_REPOSITORY ||
    !/^[0-9a-f]{40}$/.test(
      safeLabel(labels, 'org.opencontainers.image.revision'),
    ) ||
    !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(
      safeLabel(labels, 'org.opencontainers.image.version'),
    )
  ) {
    configurationError('local image compatibility labels are invalid');
  }
  return record.Architecture;
}

function exactArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort())
  );
}

function inspectComposeConfig(
  output: string,
  expected: Readonly<{
    projectName: string;
    image: string;
    generation: number;
    mutationId: string;
    deploymentRoot: string;
    uid: number;
    gid: number;
    profile: LocalDeploymentProfile;
  }>,
): void {
  const config = parseJson(output, 'Docker Compose config') as {
    readonly name?: unknown;
    readonly services?: unknown;
  };
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    config.name !== expected.projectName ||
    !config.services ||
    typeof config.services !== 'object' ||
    Array.isArray(config.services) ||
    Object.keys(config.services).length !== 1
  ) {
    configurationError('Docker Compose project identity is invalid');
  }
  const service = (config.services as Readonly<Record<string, unknown>>)
    .qinglong3 as Readonly<Record<string, unknown>> | undefined;
  const expectedMemory =
    (expected.profile === 'edge' ? 128 : 256) * 1024 * 1024;
  const expectedPids = expected.profile === 'edge' ? 64 : 256;
  if (
    !service ||
    typeof service !== 'object' ||
    service.image !== expected.image ||
    service.user !== `${expected.uid}:${expected.gid}` ||
    service.read_only !== true ||
    service.network_mode !== 'none' ||
    service.restart !== 'unless-stopped' ||
    Number(service.mem_limit) !== expectedMemory ||
    Number(service.pids_limit) !== expectedPids ||
    service.privileged === true ||
    service.build !== undefined ||
    service.ports !== undefined ||
    service.devices !== undefined ||
    service.environment !== undefined ||
    !exactArray(service.cap_drop, ['ALL']) ||
    !exactArray(service.security_opt, ['no-new-privileges:true']) ||
    !exactArray(service.command, [
      '--config',
      `${CONTAINER_ROOT}/local-application.json`,
    ])
  ) {
    configurationError('Docker Compose service contract is invalid');
  }
  const labels = service.labels as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (
    !labels ||
    Object.keys(labels).length !== 2 ||
    labels['io.qinglong.deployment.generation'] !==
      String(expected.generation) ||
    labels['io.qinglong.deployment.mutation'] !== expected.mutationId
  ) {
    configurationError('Docker Compose deployment labels are invalid');
  }
  const volumes = service.volumes as readonly unknown[] | undefined;
  const volume = volumes?.[0] as Readonly<Record<string, unknown>> | undefined;
  const tmpfs = service.tmpfs as readonly unknown[] | undefined;
  if (
    !Array.isArray(volumes) ||
    volumes.length !== 1 ||
    !volume ||
    volume.type !== 'bind' ||
    volume.source !== expected.deploymentRoot ||
    volume.target !== CONTAINER_ROOT ||
    !Array.isArray(tmpfs) ||
    tmpfs.length !== 1 ||
    typeof tmpfs[0] !== 'string' ||
    !tmpfs[0].startsWith('/tmp:') ||
    !tmpfs[0].includes('noexec') ||
    !tmpfs[0].includes('nosuid') ||
    !tmpfs[0].includes('nodev')
  ) {
    configurationError('Docker Compose filesystem contract is invalid');
  }
}

export async function preflightLocalDeploymentCompose(
  input: unknown,
  dependencies: LocalDeploymentComposePreflightDependencies = {},
): Promise<Readonly<LocalDeploymentComposePreflightResult>> {
  const command = normalizeLocalDeploymentComposePreflightCommand(input);
  const identity = currentIdentity();
  const paths = deploymentPaths(command.options.deploymentRoot);
  validatePrivateDirectory(
    command.options.deploymentRoot,
    identity.uid,
    'deploymentRoot',
  );
  validatePrivateDirectory(
    paths.service,
    identity.uid,
    'serviceDescriptorRoot',
  );
  validatePrivateDirectory(
    paths.composeRevisions,
    identity.uid,
    'composeRevisionRoot',
  );
  const validateSocket =
    dependencies.validateSocket ?? validateLocalDeploymentDockerSocket;
  validateSocket(command.options.dockerSocketPath, identity.uid);
  const selection = inspectActiveComposeImageSelection(
    paths.composeSelection,
    paths.composeRevisions,
    identity.uid,
  );
  if (selection.generation !== command.request.expectedGeneration) {
    configurationError(
      'active compose generation does not match expectedGeneration',
    );
  }
  const application = readApplicationIdentity(
    paths.applicationConfig,
    identity.uid,
  );
  const syntheticPrepare = normalizeLocalDeploymentPrepareCommand({
    schemaVersion: 1,
    operation: 'local.deployment.prepare',
    options: {
      deploymentRoot: command.options.deploymentRoot,
      profile: application.profile,
      instanceId: application.instanceId,
      ...(application.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: application.busyTimeoutMs }),
      service: {
        kind: 'compose',
        image: selection.image,
        allowRootService: command.options.allowRootService,
      },
    },
    request: {
      ownerPepperKeyId: 'preflight',
      registerMutationId: '00000000-0000-4000-8000-000000000001',
      activateMutationId: '00000000-0000-4000-8000-000000000002',
      registeredAtMs: 0,
      activatedAtMs: 0,
    },
  });
  preflightPublishedFile(
    paths.applicationConfig,
    applicationConfiguration(syntheticPrepare, paths),
    0o600,
    identity.uid,
    'application configuration',
  );
  const expectedDescriptor = descriptor(
    syntheticPrepare,
    paths.applicationConfig,
    identity.uid,
    identity.gid,
  );
  preflightPublishedFile(
    path.join(paths.service, expectedDescriptor.fileName),
    expectedDescriptor.contents,
    expectedDescriptor.mode,
    identity.uid,
    'service descriptor',
  );

  const auditSqlite =
    dependencies.auditSqlite ?? inspectLocalSqliteReadinessPath;
  const sqlite = await auditSqlite({
    databasePath: paths.database,
    profile: application.profile,
    ...(application.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: application.busyTimeoutMs }),
  });
  if (sqlite.contractVersion !== LOCAL_SQLITE_CONTRACT_VERSION) {
    configurationError('SQLite contract version drifted');
  }

  const runDocker = dependencies.runDocker ?? runLocalDeploymentDockerCommand;
  const imageOutput = runDocker({
    executable: command.options.dockerExecutable,
    socketPath: command.options.dockerSocketPath,
    args: ['image', 'inspect', selection.image],
  });
  const architecture = inspectImage(
    imageOutput,
    selection.image,
    application.profile,
    sqlite.contractVersion,
  );
  const composeOutput = runDocker({
    executable: command.options.dockerExecutable,
    socketPath: command.options.dockerSocketPath,
    args: [
      'compose',
      '--project-directory',
      paths.service,
      '-f',
      path.join(paths.service, 'compose.yaml'),
      '-f',
      paths.composeSelection,
      'config',
      '--format',
      'json',
    ],
  });
  inspectComposeConfig(composeOutput, {
    projectName: composeProjectName(application.instanceId),
    image: selection.image,
    generation: selection.generation,
    mutationId: selection.mutationId,
    deploymentRoot: command.options.deploymentRoot,
    uid: identity.uid,
    gid: identity.gid,
    profile: application.profile,
  });

  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.compose.preflight' as const,
    status: 'ready' as const,
    generation: selection.generation,
    profile: application.profile,
    sqlite: Object.freeze({
      contractVersion: sqlite.contractVersion,
    }),
    image: Object.freeze({ architecture }),
    service: Object.freeze({ kind: 'compose' as const }),
  });
}

export function preflightLocalDeploymentComposeCommandFile(
  filePath: string,
): Promise<Readonly<LocalDeploymentComposePreflightResult>> {
  return preflightLocalDeploymentCompose(readPrivateLocalCommandFile(filePath));
}
