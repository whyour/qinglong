import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { LocalDeploymentConfigurationError } from './contract';

const MAX_DOCKER_OUTPUT_BYTES = 256 * 1024;

export interface LocalDeploymentDockerRequest {
  readonly executable: string;
  readonly socketPath: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}

export type LocalDeploymentDockerRunner = (
  request: Readonly<LocalDeploymentDockerRequest>,
) => string;

export function runLocalDeploymentDockerCommand(
  request: Readonly<LocalDeploymentDockerRequest>,
): string {
  const configRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-docker-command-')),
  );
  fs.chmodSync(configRoot, 0o700);
  try {
    const executableDirectory = path.dirname(request.executable);
    const result = spawnSync(
      request.executable,
      [
        '--host',
        `unix://${request.socketPath}`,
        '--config',
        configRoot,
        ...request.args,
      ],
      {
        encoding: 'utf8',
        maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
        timeout: request.timeoutMs ?? 30_000,
        killSignal: 'SIGKILL',
        env: {
          PATH: `${executableDirectory}:/usr/local/bin:/usr/bin:/bin`,
          HOME: configRoot,
          DOCKER_CONFIG: configRoot,
          NO_PROXY: '*',
          no_proxy: '*',
        },
      },
    );
    if (
      result.error ||
      result.status !== 0 ||
      typeof result.stdout !== 'string' ||
      Buffer.byteLength(result.stdout, 'utf8') > MAX_DOCKER_OUTPUT_BYTES
    ) {
      throw new LocalDeploymentConfigurationError(
        'Docker command failed closed',
        { cause: result.error },
      );
    }
    return result.stdout;
  } finally {
    fs.rmSync(configRoot, { recursive: true, force: true });
  }
}

export function validateLocalDeploymentDockerSocket(
  socketPath: string,
  uid: number,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
  } catch (error) {
    throw new LocalDeploymentConfigurationError(
      'dockerSocketPath is unavailable',
      { cause: error },
    );
  }
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(socketPath) !== socketPath ||
    (stat.uid !== 0 && stat.uid !== uid) ||
    (stat.mode & 0o002) !== 0
  ) {
    throw new LocalDeploymentConfigurationError(
      'dockerSocketPath must be a canonical trusted Unix socket',
    );
  }
}
