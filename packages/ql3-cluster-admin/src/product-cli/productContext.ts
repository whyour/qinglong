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

const MAXIMUM_CONTEXT_BYTES = 64 * 1024;
const MAXIMUM_PATH_BYTES = 4_096;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const CONTEXT_COMMANDS = Object.freeze([
  'package',
  'package-kubernetes',
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

export class QingLong3ClusterProductContextError extends TypeError {
  readonly code = 'QL3_CLUSTER_PRODUCT_CONTEXT_INVALID';

  constructor() {
    super('QingLong 3.0 Cluster operator context is invalid');
    this.name = 'QingLong3ClusterProductContextError';
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
