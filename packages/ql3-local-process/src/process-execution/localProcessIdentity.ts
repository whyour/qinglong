import { readFile } from 'fs/promises';
import type {
  LocalPersistedExecutionInspection,
  LocalPersistedExecutionInspector,
} from './evidence';

export const LOCAL_PROCESS_DURABLE_HANDLE_PREFIX = 'ql3lp1.';
export const MAX_LOCAL_PROCESS_DURABLE_HANDLE_BYTES = 512;

const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';

export interface LinuxProcessIdentity {
  platform: 'linux';
  bootId: string;
  pid: number;
  processGroupId: number;
  startTimeTicks: string;
}

interface LinuxProcessSnapshot extends LinuxProcessIdentity {
  state: string;
}

export interface LocalProcessIdentityProvider {
  capture(pid: number): Promise<LinuxProcessIdentity | null>;
  inspect(
    identity: LinuxProcessIdentity,
  ): Promise<LocalPersistedExecutionInspection>;
}

export interface LinuxProcProcessIdentityProviderOptions {
  platform?: NodeJS.Platform;
  readTextFile?: (path: string) => Promise<string>;
}

interface DurableHandlePayload {
  v: 1;
  h: string;
  b: string;
  p: number;
  g: number;
  s: string;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')
  );
}

function normalizeBootId(value: string): string {
  const bootId = value.trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(bootId)) {
    throw new Error('Linux boot id has an invalid format');
  }
  return bootId;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function assertPositiveStartTimeTicks(value: string): void {
  if (!/^\d{1,32}$/.test(value) || BigInt(value) < BigInt(1)) {
    throw new Error('Linux process start time has an invalid format');
  }
}

function parseLinuxProcStat(pid: number, value: string): LinuxProcessSnapshot {
  assertPositiveSafeInteger(pid, 'pid');
  const open = value.indexOf('(');
  const close = value.lastIndexOf(')');
  if (open < 1 || close <= open) {
    throw new Error('Linux process stat has an invalid command field');
  }
  const observedPid = Number(value.slice(0, open).trim());
  if (observedPid !== pid) {
    throw new Error('Linux process stat PID does not match the requested PID');
  }

  // Values after comm begin at field 3 (state); starttime is field 22.
  const fields = value
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  if (fields.length < 20) {
    throw new Error('Linux process stat is missing identity fields');
  }
  const state = fields[0];
  const processGroupIdValue = fields[2];
  const startTimeTicks = fields[19];
  if (
    state === undefined ||
    processGroupIdValue === undefined ||
    startTimeTicks === undefined
  ) {
    throw new Error('Linux process stat is missing identity values');
  }
  const processGroupId = Number(processGroupIdValue);
  assertPositiveSafeInteger(processGroupId, 'processGroupId');
  assertPositiveStartTimeTicks(startTimeTicks);
  return {
    platform: 'linux',
    bootId: '',
    pid,
    processGroupId,
    startTimeTicks,
    state,
  };
}

function validateIdentity(identity: LinuxProcessIdentity): void {
  if (identity.platform !== 'linux') {
    throw new Error('Local process identity has an unsupported platform');
  }
  normalizeBootId(identity.bootId);
  assertPositiveSafeInteger(identity.pid, 'pid');
  assertPositiveSafeInteger(identity.processGroupId, 'processGroupId');
  assertPositiveStartTimeTicks(identity.startTimeTicks);
}

export function createLocalProcessDurableHandle(
  handleId: string,
  identity: LinuxProcessIdentity,
): string {
  if (!handleId || handleId.length > 255 || handleId.includes('\0')) {
    throw new Error('Local process handle id has an invalid format');
  }
  validateIdentity(identity);
  const payload: DurableHandlePayload = {
    v: 1,
    h: handleId,
    b: identity.bootId,
    p: identity.pid,
    g: identity.processGroupId,
    s: identity.startTimeTicks,
  };
  const durableHandle = `${LOCAL_PROCESS_DURABLE_HANDLE_PREFIX}${Buffer.from(
    JSON.stringify(payload),
    'utf8',
  ).toString('base64url')}`;
  if (
    Buffer.byteLength(durableHandle, 'utf8') >
    MAX_LOCAL_PROCESS_DURABLE_HANDLE_BYTES
  ) {
    throw new Error('Local process durable handle exceeds its size limit');
  }
  return durableHandle;
}

export function parseLocalProcessDurableHandle(
  durableHandle: string,
): { handleId: string; identity: LinuxProcessIdentity } | null {
  if (
    !durableHandle.startsWith(LOCAL_PROCESS_DURABLE_HANDLE_PREFIX) ||
    Buffer.byteLength(durableHandle, 'utf8') >
      MAX_LOCAL_PROCESS_DURABLE_HANDLE_BYTES
  ) {
    return null;
  }
  const encoded = durableHandle.slice(
    LOCAL_PROCESS_DURABLE_HANDLE_PREFIX.length,
  );
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<DurableHandlePayload>;
    if (
      payload.v !== 1 ||
      typeof payload.h !== 'string' ||
      typeof payload.b !== 'string' ||
      typeof payload.p !== 'number' ||
      typeof payload.g !== 'number' ||
      typeof payload.s !== 'string'
    ) {
      return null;
    }
    const identity: LinuxProcessIdentity = {
      platform: 'linux',
      bootId: payload.b,
      pid: payload.p,
      processGroupId: payload.g,
      startTimeTicks: payload.s,
    };
    if (!payload.h || payload.h.length > 255 || payload.h.includes('\0')) {
      return null;
    }
    validateIdentity(identity);
    return { handleId: payload.h, identity };
  } catch {
    return null;
  }
}

export class LinuxProcProcessIdentityProvider
  implements LocalProcessIdentityProvider
{
  private readonly platform: NodeJS.Platform;
  private readonly readTextFile: (path: string) => Promise<string>;

  constructor(options: LinuxProcProcessIdentityProviderOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.readTextFile =
      options.readTextFile ?? ((path) => readFile(path, { encoding: 'utf8' }));
  }

  async capture(pid: number): Promise<LinuxProcessIdentity | null> {
    if (this.platform !== 'linux') return null;
    try {
      const [bootIdValue, statValue] = await Promise.all([
        this.readTextFile(LINUX_BOOT_ID_PATH),
        this.readTextFile(`/proc/${pid}/stat`),
      ]);
      const snapshot = parseLinuxProcStat(pid, statValue);
      return {
        platform: 'linux',
        bootId: normalizeBootId(bootIdValue),
        pid,
        processGroupId: snapshot.processGroupId,
        startTimeTicks: snapshot.startTimeTicks,
      };
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  async inspect(
    identity: LinuxProcessIdentity,
  ): Promise<LocalPersistedExecutionInspection> {
    if (this.platform !== 'linux')
      return { status: 'unknown', reason: 'unsupported_platform' };
    validateIdentity(identity);

    let bootId: string;
    try {
      bootId = normalizeBootId(await this.readTextFile(LINUX_BOOT_ID_PATH));
    } catch (error) {
      if (isMissingFileError(error))
        return { status: 'unknown', reason: 'provider_unavailable' };
      throw error;
    }
    if (bootId !== identity.bootId)
      return { status: 'not_running', identityPid: identity.pid };

    let snapshot: LinuxProcessSnapshot;
    try {
      snapshot = parseLinuxProcStat(
        identity.pid,
        await this.readTextFile(`/proc/${identity.pid}/stat`),
      );
    } catch (error) {
      if (isMissingFileError(error))
        return { status: 'not_running', identityPid: identity.pid };
      throw error;
    }
    if (
      snapshot.processGroupId !== identity.processGroupId ||
      snapshot.startTimeTicks !== identity.startTimeTicks
    ) {
      return { status: 'not_running', identityPid: identity.pid };
    }
    if (['Z', 'X', 'x'].includes(snapshot.state))
      return { status: 'not_running', identityPid: identity.pid };
    return { status: 'running', identityPid: identity.pid };
  }
}

export class LocalProcessPersistedExecutionInspector
  implements LocalPersistedExecutionInspector
{
  readonly executorType = 'local_process' as const;

  constructor(
    private readonly identityProvider: LocalProcessIdentityProvider = new LinuxProcProcessIdentityProvider(),
  ) {}

  async inspect(
    durableHandle: string,
  ): Promise<LocalPersistedExecutionInspection> {
    const parsed = parseLocalProcessDurableHandle(durableHandle);
    if (!parsed) return { status: 'unknown', reason: 'invalid_handle' };
    return this.identityProvider.inspect(parsed.identity);
  }
}
