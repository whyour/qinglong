import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  probeClusterCopilotClientReadiness,
  validateClusterCopilotClientConfiguration,
} from '../copilot-client/client';
import { validateClusterAuthenticatedManagementClientConfiguration } from '../management-support/pluginPackageManagementClient';
import type { ClusterAuthenticatedManagementClientKind } from '../management-support/pluginPackageManagementClient';
import { probeClusterAuthenticatedManagementClientReadiness } from '../management-support/managementReadinessProbe';
import {
  probeClusterPluginPackageManagementKubernetesReadiness,
  validateClusterPluginPackageManagementKubernetesConfiguration,
} from '../plugin-package/management/pluginPackageManagementKubernetesClient';

const MAXIMUM_CONTEXT_BYTES = 64 * 1024;
const MAXIMUM_PATH_BYTES = 4_096;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const CONTEXT_COMMANDS = Object.freeze([
  'copilot',
  'package',
  'package-kubernetes',
  'worker',
  'worker-credential',
  'approval',
  'run',
  'automation',
  'model-credential',
] as const);

type ContextCommandName = (typeof CONTEXT_COMMANDS)[number];
type JsonObject = Record<string, unknown>;

export interface QingLong3ClusterProductContextCommand {
  readonly configFile: string;
  readonly kubernetesFile?: string;
}

export interface QingLong3ClusterProductContext {
  readonly schemaVersion: 1;
  readonly commands: Readonly<
    Partial<Record<ContextCommandName, QingLong3ClusterProductContextCommand>>
  >;
}

export interface QingLong3ClusterProductContextValidation {
  readonly schemaVersion: 1;
  readonly component: 'qinglong3-cluster-product-cli';
  readonly event: 'context_valid';
  readonly commandCount: number;
  readonly commands: readonly Readonly<{
    name: ContextCommandName;
    transport: 'https' | 'kubernetes-port-forward';
    clientCertificate: 'forbidden' | 'required';
    kubernetesAuthentication?: 'token' | 'client-certificate';
  }>[];
  readonly networkAccess: false;
  readonly mutation: false;
}

export interface QingLong3ClusterProductContextProbe {
  readonly schemaVersion: 1;
  readonly component: 'qinglong3-cluster-product-cli';
  readonly event: 'context_probed';
  readonly commandCount: number;
  readonly commands: readonly Readonly<{
    name: ContextCommandName;
    transport: 'https' | 'kubernetes-port-forward';
    status: 'ready' | 'not_ready';
  }>[];
  readonly allReady: boolean;
  readonly requestMethod: 'GET';
  readonly requestPath: '/readyz';
  readonly mutation: false;
}

const CONTEXT_COMMAND_CLIENT_KINDS: Readonly<
  Record<
    Exclude<ContextCommandName, 'copilot'>,
    ClusterAuthenticatedManagementClientKind
  >
> = Object.freeze({
  package: 'package',
  'package-kubernetes': 'package',
  worker: 'worker',
  'worker-credential': 'worker-credential',
  approval: 'approval',
  run: 'run',
  automation: 'automation',
  'model-credential': 'model-credential',
});

export class QingLong3ClusterProductContextError extends TypeError {
  readonly code = 'QL3_CLUSTER_PRODUCT_CONTEXT_INVALID';

  constructor() {
    super('QingLong 3.0 Cluster operator context is invalid');
    this.name = 'QingLong3ClusterProductContextError';
  }
}

export class QingLong3ClusterProductContextProbeError extends Error {
  readonly code = 'QL3_CLUSTER_PRODUCT_CONTEXT_PROBE_FAILED';

  constructor() {
    super('QingLong 3.0 Cluster operator context probe failed');
    this.name = 'QingLong3ClusterProductContextProbeError';
  }
}

function invalid(): never {
  throw new QingLong3ClusterProductContextError();
}

function exactObject(value: unknown, keys: readonly string[]): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
  return value as JsonObject;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as JsonObject;
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') invalid();
  const uid = process.getuid();
  if (!Number.isSafeInteger(uid) || uid < 0) invalid();
  return uid;
}

function validatePrivatePath(filePath: unknown, uid: number): string {
  if (
    typeof filePath !== 'string' ||
    !isAbsolute(filePath) ||
    Buffer.byteLength(filePath, 'utf8') > MAXIMUM_PATH_BYTES ||
    CONTROL_PATTERN.test(filePath)
  ) {
    invalid();
  }
  try {
    const status = lstatSync(filePath);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.uid !== uid ||
      (status.mode & 0o777) !== 0o600 ||
      realpathSync(filePath) !== filePath
    ) {
      invalid();
    }
  } catch (error) {
    if (error instanceof QingLong3ClusterProductContextError) throw error;
    invalid();
  }
  return filePath;
}

function readPrivateContext(filePath: string): Buffer {
  const uid = currentUid();
  validatePrivatePath(filePath, uid);
  let descriptor = -1;
  let bytes: Buffer | undefined;
  try {
    const before = lstatSync(filePath);
    if (before.size < 2 || before.size > MAXIMUM_CONTEXT_BYTES) invalid();
    descriptor = openSync(
      filePath,
      constants.O_RDONLY |
        ((constants as unknown as Readonly<Record<string, number>>).O_CLOEXEC ??
          0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.uid !== before.uid ||
      opened.mode !== before.mode ||
      opened.size !== before.size
    ) {
      invalid();
    }
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count < 1) invalid();
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.uid !== opened.uid ||
      after.mode !== opened.mode ||
      after.size !== opened.size
    ) {
      invalid();
    }
    return bytes;
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof QingLong3ClusterProductContextError) throw error;
    throw new QingLong3ClusterProductContextError();
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

export function loadQingLong3ClusterProductContext(
  contextFile: string,
): Readonly<QingLong3ClusterProductContext> {
  let bytes: Buffer | undefined;
  try {
    bytes = readPrivateContext(contextFile);
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      invalid();
    }
    const root = exactObject(parsed, ['schemaVersion', 'commands']);
    const commands = object(root.commands);
    const names = Object.keys(commands);
    if (
      root.schemaVersion !== 1 ||
      names.length < 1 ||
      names.length > CONTEXT_COMMANDS.length ||
      names.some(
        (name) => !CONTEXT_COMMANDS.includes(name as ContextCommandName),
      )
    ) {
      invalid();
    }
    const uid = currentUid();
    const normalized: Partial<
      Record<ContextCommandName, QingLong3ClusterProductContextCommand>
    > = {};
    for (const name of names as ContextCommandName[]) {
      const tunnel = name === 'package-kubernetes';
      const entry = exactObject(
        commands[name],
        tunnel ? ['configFile', 'kubernetesFile'] : ['configFile'],
      );
      normalized[name] = Object.freeze({
        configFile: validatePrivatePath(entry.configFile, uid),
        ...(tunnel
          ? { kubernetesFile: validatePrivatePath(entry.kubernetesFile, uid) }
          : {}),
      });
    }
    return Object.freeze({
      schemaVersion: 1,
      commands: Object.freeze(normalized),
    });
  } finally {
    bytes?.fill(0);
  }
}

export function resolveQingLong3ClusterProductContextArguments(
  contextFile: string,
  commandName: string,
  argv: readonly string[],
): readonly string[] {
  if (
    argv.some(
      (argument) =>
        argument === '--context' ||
        argument.startsWith('--context=') ||
        argument === '--config' ||
        argument.startsWith('--config=') ||
        argument === '--kubernetes' ||
        argument.startsWith('--kubernetes='),
    )
  ) {
    invalid();
  }
  const context = loadQingLong3ClusterProductContext(contextFile);
  const command = context.commands[commandName as ContextCommandName];
  if (command === undefined) invalid();
  return Object.freeze([
    `--config=${command.configFile}`,
    ...(command.kubernetesFile === undefined
      ? []
      : [`--kubernetes=${command.kubernetesFile}`]),
    ...argv,
  ]);
}

export async function validateQingLong3ClusterProductContext(
  contextFile: string,
): Promise<Readonly<QingLong3ClusterProductContextValidation>> {
  try {
    const context = loadQingLong3ClusterProductContext(contextFile);
    const commands: Array<
      QingLong3ClusterProductContextValidation['commands'][number]
    > = [];
    for (const name of CONTEXT_COMMANDS) {
      const command = context.commands[name];
      if (command === undefined) continue;
      if (name === 'copilot') {
        const https = validateClusterCopilotClientConfiguration(
          command.configFile,
        );
        commands.push(
          Object.freeze({
            name,
            transport: https.transport,
            clientCertificate: https.clientCertificate,
          }),
        );
      } else if (name === 'package-kubernetes') {
        const https = validateClusterAuthenticatedManagementClientConfiguration(
          command.configFile,
          CONTEXT_COMMAND_CLIENT_KINDS[name],
        );
        const kubernetes =
          await validateClusterPluginPackageManagementKubernetesConfiguration(
            command.kubernetesFile!,
          );
        commands.push(
          Object.freeze({
            name,
            transport: kubernetes.transport,
            clientCertificate: https.clientCertificate,
            kubernetesAuthentication: kubernetes.authentication,
          }),
        );
      } else {
        const https = validateClusterAuthenticatedManagementClientConfiguration(
          command.configFile,
          CONTEXT_COMMAND_CLIENT_KINDS[name],
        );
        commands.push(
          Object.freeze({
            name,
            transport: https.transport,
            clientCertificate: https.clientCertificate,
          }),
        );
      }
    }
    return Object.freeze({
      schemaVersion: 1,
      component: 'qinglong3-cluster-product-cli',
      event: 'context_valid',
      commandCount: commands.length,
      commands: Object.freeze(commands),
      networkAccess: false,
      mutation: false,
    });
  } catch (error) {
    if (error instanceof QingLong3ClusterProductContextError) throw error;
    throw new QingLong3ClusterProductContextError();
  }
}

export async function probeQingLong3ClusterProductContext(
  contextFile: string,
): Promise<Readonly<QingLong3ClusterProductContextProbe>> {
  try {
    await validateQingLong3ClusterProductContext(contextFile);
    const context = loadQingLong3ClusterProductContext(contextFile);
    const commands: Array<
      QingLong3ClusterProductContextProbe['commands'][number]
    > = [];
    for (const name of CONTEXT_COMMANDS) {
      const command = context.commands[name];
      if (command === undefined) continue;
      const result =
        name === 'package-kubernetes'
          ? await probeClusterPluginPackageManagementKubernetesReadiness(
              command.configFile,
              command.kubernetesFile!,
            )
          : name === 'copilot'
          ? await probeClusterCopilotClientReadiness(command.configFile)
          : await probeClusterAuthenticatedManagementClientReadiness(
              command.configFile,
              CONTEXT_COMMAND_CLIENT_KINDS[name],
            );
      commands.push(
        Object.freeze({
          name,
          transport:
            name === 'package-kubernetes'
              ? 'kubernetes-port-forward'
              : result.transport,
          status: result.ready ? 'ready' : 'not_ready',
        }),
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      component: 'qinglong3-cluster-product-cli',
      event: 'context_probed',
      commandCount: commands.length,
      commands: Object.freeze(commands),
      allReady: commands.every(({ status }) => status === 'ready'),
      requestMethod: 'GET',
      requestPath: '/readyz',
      mutation: false,
    });
  } catch (error) {
    if (error instanceof QingLong3ClusterProductContextError) throw error;
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code.endsWith('CONFIG_INVALID')
    ) {
      throw new QingLong3ClusterProductContextError();
    }
    throw new QingLong3ClusterProductContextProbeError();
  }
}
