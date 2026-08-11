import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { inspectActiveComposeImageSelection } from './compose/composeRevision';
import {
  currentIdentity,
  LocalDeploymentConfigurationError,
  normalizeLocalDeploymentStatusCommand,
  type LocalDeploymentProfile,
  type LocalDeploymentServiceKind,
  type LocalDeploymentStatusResult,
} from './foundation/contract';
import { validatePrivateDirectory } from './foundation/files';
import {
  deploymentPaths,
  type LocalDeploymentPaths,
} from './foundation/render';

const MAX_OBSERVED_FILE_BYTES = 64 * 1024;

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function boundedPrivateFile(
  filePath: string,
  uid: number,
  mode: number,
  label: string,
): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    configurationError(`${label} is unavailable`, error);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== mode ||
    stat.nlink !== 1 ||
    stat.size < 2 ||
    stat.size > MAX_OBSERVED_FILE_BYTES
  ) {
    configurationError(`${label} identity is invalid`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function applicationProfile(
  paths: Readonly<LocalDeploymentPaths>,
  uid: number,
): LocalDeploymentProfile {
  const contents = boundedPrivateFile(
    paths.applicationConfig,
    uid,
    0o600,
    'application configuration',
  );
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    configurationError('application configuration is invalid', error);
  }
  const candidate = value as {
    readonly schema?: unknown;
    readonly profile?: unknown;
  };
  if (
    candidate?.schema !== 'qinglong/local-application-process@v2' ||
    (candidate.profile !== 'edge' && candidate.profile !== 'standalone')
  ) {
    configurationError('application configuration binding drifted');
  }
  return candidate.profile;
}

function serviceKind(
  paths: Readonly<LocalDeploymentPaths>,
  uid: number,
): LocalDeploymentServiceKind {
  const candidates = [
    {
      kind: 'systemd' as const,
      fileName: 'qinglong3.service',
      mode: 0o600,
      markers: [
        '[Unit]\n',
        'Description=QingLong 3.0 local automation runtime',
      ],
    },
    {
      kind: 'openrc' as const,
      fileName: 'qinglong3.openrc',
      mode: 0o700,
      markers: [
        '#!/sbin/openrc-run\n',
        'description="QingLong 3.0 local automation runtime"',
      ],
    },
    {
      kind: 'compose' as const,
      fileName: 'compose.yaml',
      mode: 0o600,
      markers: ['name: ql3-', '\nservices:\n  qinglong3:\n'],
    },
  ].filter((candidate) =>
    fs.existsSync(path.join(paths.service, candidate.fileName)),
  );
  if (candidates.length !== 1) {
    configurationError('service descriptor selection drifted');
  }
  const selected = candidates[0]!;
  const contents = boundedPrivateFile(
    path.join(paths.service, selected.fileName),
    uid,
    selected.mode,
    'service descriptor',
  );
  if (selected.markers.some((marker) => !contents.includes(marker))) {
    configurationError('service descriptor binding drifted');
  }
  return selected.kind;
}

function fence(
  filePath: string,
  uid: number,
  label: string,
): 'idle' | 'in_flight' {
  if (!fs.existsSync(filePath)) return 'idle';
  boundedPrivateFile(filePath, uid, 0o600, label);
  return 'in_flight';
}

export function inspectLocalDeploymentStatus(
  input: unknown,
): Readonly<LocalDeploymentStatusResult> {
  const command = normalizeLocalDeploymentStatusCommand(input);
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
  const profile = applicationProfile(paths, identity.uid);
  const kind = serviceKind(paths, identity.uid);
  const common = {
    schemaVersion: 1 as const,
    operation: 'local.deployment.status' as const,
    status: 'observed' as const,
    observation: 'durable' as const,
    profile,
    applicationConfiguration: Object.freeze({
      schema: 'qinglong/local-application-process@v2' as const,
      state: 'present' as const,
    }),
    runtime: Object.freeze({ health: 'unobserved' as const }),
  };
  if (kind !== 'compose') {
    return Object.freeze({
      ...common,
      service: Object.freeze({
        kind,
        descriptor: 'present' as const,
      }),
    });
  }

  validatePrivateDirectory(
    paths.composeRevisions,
    identity.uid,
    'composeRevisionRoot',
  );
  const selection = inspectActiveComposeImageSelection(
    paths.composeSelection,
    paths.composeRevisions,
    identity.uid,
  );
  const fences = Object.freeze({
    revision: fence(
      paths.composeRevisionLock,
      identity.uid,
      'compose revision lock',
    ),
    rollout: fence(
      paths.composeRolloutLock,
      identity.uid,
      'compose rollout lock',
    ),
    restore: fence(
      paths.composeRestoreLock,
      identity.uid,
      'compose restore lock',
    ),
    evidenceCollection: fence(
      paths.composeEvidenceCollectionLock,
      identity.uid,
      'compose evidence collection lock',
    ),
  });
  const recoveryRequired = Object.values(fences).some(
    (state) => state === 'in_flight',
  );
  return Object.freeze({
    ...common,
    service: Object.freeze({
      kind: 'compose' as const,
      descriptor: 'present' as const,
      generation: selection.generation,
      rollbackTargetGeneration:
        selection.rollbackTargetGeneration === 0
          ? null
          : selection.rollbackTargetGeneration,
      transition: recoveryRequired
        ? ('recovery_required' as const)
        : ('stable' as const),
      fences,
    }),
  });
}

export function inspectLocalDeploymentStatusCommandFile(
  filePath: string,
): Readonly<LocalDeploymentStatusResult> {
  return inspectLocalDeploymentStatus(readPrivateLocalCommandFile(filePath));
}
