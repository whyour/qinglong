import { createHash } from 'crypto';

export const MANUAL_PRIMARY_RUNTIME_RECEIPT_SCHEMA =
  'qinglong/manual-primary-runtime-receipt@v1';
export const MANUAL_PRIMARY_RUNTIME_RECEIPT_FILE =
  'qinglong3-manual-primary-runtime.json';
export const MAX_MANUAL_PRIMARY_RUNTIME_RECEIPT_BYTES = 8 * 1024;

export type ManualPrimaryRuntimeReceiptState =
  | 'active'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type ManualPrimaryRuntimeProcessIdentity =
  | {
      kind: 'linux-proc';
      platform: 'linux';
      pid: number;
      processGroupId: number;
      bootId: string;
      startTimeTicks: string;
    }
  | {
      kind: 'portable';
      platform: string;
      pid: number;
    };

export interface ManualPrimaryRuntimeReceipt {
  schema: typeof MANUAL_PRIMARY_RUNTIME_RECEIPT_SCHEMA;
  schemaVersion: 1;
  activationId: string;
  profile: 'edge' | 'standalone';
  revision: string;
  rolloutSourceSha256: string;
  activatedAtMs: number;
  updatedAtMs: number;
  state: ManualPrimaryRuntimeReceiptState;
  process: ManualPrimaryRuntimeProcessIdentity;
  receiptSha256: string;
}

type ReceiptProjection = Omit<ManualPrimaryRuntimeReceipt, 'receiptSha256'>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ACTIVATION_ID_PATTERN = /^[a-f0-9]{32}$/u;
const BOOT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/u;
const START_TICKS_PATTERN = /^\d{1,32}$/u;
const PLATFORM_PATTERN = /^[a-z0-9_-]{1,32}$/u;

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${name} has an invalid shape`);
  }
}

function safePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function safeTimestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseProcessIdentity(
  value: unknown,
): ManualPrimaryRuntimeProcessIdentity {
  const identity = record(value, 'receipt.process');
  if (identity.kind === 'linux-proc') {
    exactKeys(
      identity,
      ['kind', 'platform', 'pid', 'processGroupId', 'bootId', 'startTimeTicks'],
      'receipt.process',
    );
    if (
      identity.platform !== 'linux' ||
      typeof identity.bootId !== 'string' ||
      !BOOT_ID_PATTERN.test(identity.bootId) ||
      typeof identity.startTimeTicks !== 'string' ||
      !START_TICKS_PATTERN.test(identity.startTimeTicks) ||
      BigInt(identity.startTimeTicks) < BigInt(1)
    ) {
      throw new TypeError('receipt.process Linux identity is invalid');
    }
    return {
      kind: 'linux-proc',
      platform: 'linux',
      pid: safePositiveInteger(identity.pid, 'receipt.process.pid'),
      processGroupId: safePositiveInteger(
        identity.processGroupId,
        'receipt.process.processGroupId',
      ),
      bootId: identity.bootId,
      startTimeTicks: identity.startTimeTicks,
    };
  }
  exactKeys(identity, ['kind', 'platform', 'pid'], 'receipt.process');
  if (
    identity.kind !== 'portable' ||
    typeof identity.platform !== 'string' ||
    !PLATFORM_PATTERN.test(identity.platform)
  ) {
    throw new TypeError('receipt.process portable identity is invalid');
  }
  return {
    kind: 'portable',
    platform: identity.platform,
    pid: safePositiveInteger(identity.pid, 'receipt.process.pid'),
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

function digest(projection: ReceiptProjection): string {
  return createHash('sha256')
    .update('qinglong.manual-primary-runtime-receipt.v1\0', 'utf8')
    .update(JSON.stringify(canonical(projection)), 'utf8')
    .digest('hex');
}

export function createManualPrimaryRuntimeReceipt(input: {
  activationId: string;
  profile: 'edge' | 'standalone';
  revision: string;
  rolloutSourceSha256: string;
  activatedAtMs: number;
  process: ManualPrimaryRuntimeProcessIdentity;
}): ManualPrimaryRuntimeReceipt {
  const projection: ReceiptProjection = {
    schema: MANUAL_PRIMARY_RUNTIME_RECEIPT_SCHEMA,
    schemaVersion: 1,
    activationId: input.activationId,
    profile: input.profile,
    revision: input.revision,
    rolloutSourceSha256: input.rolloutSourceSha256,
    activatedAtMs: input.activatedAtMs,
    updatedAtMs: input.activatedAtMs,
    state: 'active',
    process: input.process,
  };
  return parseManualPrimaryRuntimeReceipt({
    ...projection,
    receiptSha256: digest(projection),
  });
}

export function transitionManualPrimaryRuntimeReceipt(
  receipt: ManualPrimaryRuntimeReceipt,
  state: Exclude<ManualPrimaryRuntimeReceiptState, 'active'>,
  updatedAtMs: number,
): ManualPrimaryRuntimeReceipt {
  const current = parseManualPrimaryRuntimeReceipt(receipt);
  const projection: ReceiptProjection = {
    schema: current.schema,
    schemaVersion: 1,
    activationId: current.activationId,
    profile: current.profile,
    revision: current.revision,
    rolloutSourceSha256: current.rolloutSourceSha256,
    activatedAtMs: current.activatedAtMs,
    updatedAtMs,
    state,
    process: current.process,
  };
  return parseManualPrimaryRuntimeReceipt({
    ...projection,
    receiptSha256: digest(projection),
  });
}

export function parseManualPrimaryRuntimeReceipt(
  value: unknown,
): ManualPrimaryRuntimeReceipt {
  const receipt = record(value, 'receipt');
  exactKeys(
    receipt,
    [
      'schema',
      'schemaVersion',
      'activationId',
      'profile',
      'revision',
      'rolloutSourceSha256',
      'activatedAtMs',
      'updatedAtMs',
      'state',
      'process',
      'receiptSha256',
    ],
    'receipt',
  );
  const activatedAtMs = safeTimestamp(
    receipt.activatedAtMs,
    'receipt.activatedAtMs',
  );
  const updatedAtMs = safeTimestamp(receipt.updatedAtMs, 'receipt.updatedAtMs');
  if (
    receipt.schema !== MANUAL_PRIMARY_RUNTIME_RECEIPT_SCHEMA ||
    receipt.schemaVersion !== 1 ||
    typeof receipt.activationId !== 'string' ||
    !ACTIVATION_ID_PATTERN.test(receipt.activationId) ||
    (receipt.profile !== 'edge' && receipt.profile !== 'standalone') ||
    typeof receipt.revision !== 'string' ||
    receipt.revision.length < 1 ||
    receipt.revision.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(receipt.revision) ||
    typeof receipt.rolloutSourceSha256 !== 'string' ||
    !SHA256_PATTERN.test(receipt.rolloutSourceSha256) ||
    !['active', 'stopping', 'stopped', 'failed'].includes(
      receipt.state as string,
    ) ||
    typeof receipt.receiptSha256 !== 'string' ||
    !SHA256_PATTERN.test(receipt.receiptSha256) ||
    updatedAtMs < activatedAtMs ||
    (receipt.state === 'active' && updatedAtMs !== activatedAtMs)
  ) {
    throw new TypeError('Manual Primary runtime receipt is invalid');
  }
  const projection: ReceiptProjection = {
    schema: MANUAL_PRIMARY_RUNTIME_RECEIPT_SCHEMA,
    schemaVersion: 1,
    activationId: receipt.activationId,
    profile: receipt.profile,
    revision: receipt.revision,
    rolloutSourceSha256: receipt.rolloutSourceSha256,
    activatedAtMs,
    updatedAtMs,
    state: receipt.state as ManualPrimaryRuntimeReceiptState,
    process: parseProcessIdentity(receipt.process),
  };
  if (digest(projection) !== receipt.receiptSha256) {
    throw new TypeError('Manual Primary runtime receipt digest is invalid');
  }
  return { ...projection, receiptSha256: receipt.receiptSha256 };
}
