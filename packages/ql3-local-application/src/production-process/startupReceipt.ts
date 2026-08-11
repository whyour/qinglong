import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { LocalApplicationProfile } from '../application-runtime/contract';
import { publishLocalApplicationLifecycleReceiptFile } from './lifecycleReceiptFile';

export const LOCAL_APPLICATION_STARTUP_RECEIPT_SCHEMA =
  'qinglong/local-application-startup-receipt@v1' as const;
export const MAX_LOCAL_APPLICATION_STARTUP_RECEIPT_BYTES = 4096;

const MAX_PATH_BYTES = 4096;
const BOOT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const START_TICKS_PATTERN = /^[1-9][0-9]{0,19}$/;

export type LocalApplicationStartupAiStatus =
  | 'deployment_excluded'
  | 'schema_absent'
  | 'inactive'
  | 'active';

export interface LocalApplicationStartupObservation {
  readonly bootId: string;
  readonly activeBootAgeMs: number;
  readonly processId: number;
  readonly processStartTicks: string;
  readonly nodeExecutable: string;
  readonly nodeVersion: string;
}

export interface LocalApplicationStartupReceipt
  extends LocalApplicationStartupObservation {
  readonly schemaVersion: 1;
  readonly schema: typeof LOCAL_APPLICATION_STARTUP_RECEIPT_SCHEMA;
  readonly instanceId: string;
  readonly profile: LocalApplicationProfile;
  readonly aiStatus: LocalApplicationStartupAiStatus;
  readonly sha256: string;
}

export class LocalApplicationStartupReceiptError extends Error {
  readonly code = 'QL3_LOCAL_APPLICATION_STARTUP_RECEIPT_UNAVAILABLE';

  constructor(message: string, options?: ErrorOptions) {
    super(
      `Local application startup receipt is unavailable: ${message}`,
      options,
    );
    this.name = 'LocalApplicationStartupReceiptError';
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function boundedAbsolutePath(value: string, label: string): string {
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') < 1 ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new LocalApplicationStartupReceiptError(
      `${label} must be a normalized bounded absolute path`,
    );
  }
  return value;
}

function canonicalDigest(
  value: Omit<LocalApplicationStartupReceipt, 'sha256'>,
): string {
  return crypto
    .createHash('sha256')
    .update('qinglong.local-application-startup-receipt.v1\0', 'utf8')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function receiptWithoutDigest(
  receipt: Readonly<LocalApplicationStartupReceipt>,
): Omit<LocalApplicationStartupReceipt, 'sha256'> {
  return Object.freeze({
    schemaVersion: receipt.schemaVersion,
    schema: receipt.schema,
    instanceId: receipt.instanceId,
    profile: receipt.profile,
    aiStatus: receipt.aiStatus,
    bootId: receipt.bootId,
    activeBootAgeMs: receipt.activeBootAgeMs,
    processId: receipt.processId,
    processStartTicks: receipt.processStartTicks,
    nodeExecutable: receipt.nodeExecutable,
    nodeVersion: receipt.nodeVersion,
  });
}

export function parseLinuxProcessStartTicks(contents: string): string {
  if (
    typeof contents !== 'string' ||
    contents.length < 8 ||
    Buffer.byteLength(contents, 'utf8') > 4096
  ) {
    throw new LocalApplicationStartupReceiptError(
      'Linux process stat is invalid',
    );
  }
  const commandEnd = contents.lastIndexOf(') ');
  if (commandEnd < 2) {
    throw new LocalApplicationStartupReceiptError(
      'Linux process stat is invalid',
    );
  }
  const fields = contents
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u);
  const startTicks = fields[19];
  if (!startTicks || !START_TICKS_PATTERN.test(startTicks)) {
    throw new LocalApplicationStartupReceiptError(
      'Linux process start ticks are invalid',
    );
  }
  return startTicks;
}

function readBoundedUtf8(filePath: string, maximumBytes: number): string {
  const material = fs.readFileSync(filePath);
  try {
    if (material.byteLength < 1 || material.byteLength > maximumBytes) {
      throw new LocalApplicationStartupReceiptError(
        'Linux startup observation is outside its byte limit',
      );
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(material).trim();
  } catch (error) {
    if (error instanceof LocalApplicationStartupReceiptError) throw error;
    throw new LocalApplicationStartupReceiptError(
      'Linux startup observation is not UTF-8',
      { cause: error },
    );
  } finally {
    material.fill(0);
  }
}

export function observeLocalApplicationStartup(
  procRoot = '/proc',
): Readonly<LocalApplicationStartupObservation> | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const bootId = readBoundedUtf8(
      path.join(procRoot, 'sys/kernel/random/boot_id'),
      128,
    ).toLowerCase();
    if (!BOOT_ID_PATTERN.test(bootId)) {
      throw new LocalApplicationStartupReceiptError(
        'Linux boot identity is invalid',
      );
    }
    const uptimeValue = readBoundedUtf8(
      path.join(procRoot, 'uptime'),
      256,
    ).split(/\s+/u)[0];
    const uptimeSeconds =
      uptimeValue === undefined ? Number.NaN : Number(uptimeValue);
    const activeBootAgeMs = Math.round(uptimeSeconds * 1000);
    if (
      !Number.isSafeInteger(activeBootAgeMs) ||
      activeBootAgeMs < 0 ||
      activeBootAgeMs > 31_536_000_000
    ) {
      throw new LocalApplicationStartupReceiptError(
        'Linux boot age is invalid',
      );
    }
    const processId = process.pid;
    const processStartTicks = parseLinuxProcessStartTicks(
      readBoundedUtf8(path.join(procRoot, String(processId), 'stat'), 4096),
    );
    const nodeExecutable = boundedAbsolutePath(
      fs.realpathSync(path.join(procRoot, String(processId), 'exe')),
      'Node executable',
    );
    return Object.freeze({
      bootId,
      activeBootAgeMs,
      processId,
      processStartTicks,
      nodeExecutable,
      nodeVersion: process.version,
    });
  } catch (error) {
    if (error instanceof LocalApplicationStartupReceiptError) throw error;
    throw new LocalApplicationStartupReceiptError(
      'Linux startup observation cannot be read',
      { cause: error },
    );
  }
}

export function buildLocalApplicationStartupReceipt(options: {
  readonly instanceId: string;
  readonly profile: LocalApplicationProfile;
  readonly aiStatus: LocalApplicationStartupAiStatus;
  readonly observation: Readonly<LocalApplicationStartupObservation>;
}): Readonly<LocalApplicationStartupReceipt> {
  const withoutDigest = Object.freeze({
    schemaVersion: 1 as const,
    schema: LOCAL_APPLICATION_STARTUP_RECEIPT_SCHEMA,
    instanceId: options.instanceId,
    profile: options.profile,
    aiStatus: options.aiStatus,
    ...options.observation,
  });
  return Object.freeze({
    ...withoutDigest,
    sha256: canonicalDigest(withoutDigest),
  });
}

export function localApplicationStartupReceiptPath(
  configFilePath: string,
): string {
  const configPath = boundedAbsolutePath(
    configFilePath,
    'application configuration path',
  );
  return `${configPath}.active.json`;
}

export function publishLocalApplicationStartupReceipt(
  configFilePath: string,
  receipt: Readonly<LocalApplicationStartupReceipt>,
): string {
  const targetPath = localApplicationStartupReceiptPath(configFilePath);
  const normalized = parseLocalApplicationStartupReceipt(
    `${JSON.stringify(receipt)}\n`,
  );
  return publishLocalApplicationLifecycleReceiptFile({
    targetPath,
    contents: `${JSON.stringify(normalized)}\n`,
    maximumBytes: MAX_LOCAL_APPLICATION_STARTUP_RECEIPT_BYTES,
    isFailure: (error) => error instanceof LocalApplicationStartupReceiptError,
    fail(message, cause) {
      throw new LocalApplicationStartupReceiptError(
        message,
        cause === undefined ? undefined : { cause },
      );
    },
  });
}

export function parseLocalApplicationStartupReceipt(
  contents: string,
): Readonly<LocalApplicationStartupReceipt> {
  if (
    typeof contents !== 'string' ||
    Buffer.byteLength(contents, 'utf8') < 1 ||
    Buffer.byteLength(contents, 'utf8') >
      MAX_LOCAL_APPLICATION_STARTUP_RECEIPT_BYTES
  ) {
    throw new LocalApplicationStartupReceiptError(
      'receipt is outside its byte limit',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new LocalApplicationStartupReceiptError('receipt is not JSON', {
      cause: error,
    });
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'activeBootAgeMs',
      'aiStatus',
      'bootId',
      'instanceId',
      'nodeExecutable',
      'nodeVersion',
      'processId',
      'processStartTicks',
      'profile',
      'schema',
      'schemaVersion',
      'sha256',
    ])
  ) {
    throw new LocalApplicationStartupReceiptError('receipt shape is invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.schema !== LOCAL_APPLICATION_STARTUP_RECEIPT_SCHEMA ||
    typeof candidate.instanceId !== 'string' ||
    candidate.instanceId.length < 1 ||
    Buffer.byteLength(candidate.instanceId, 'utf8') > 128 ||
    (candidate.profile !== 'edge' && candidate.profile !== 'standalone') ||
    (candidate.aiStatus !== 'deployment_excluded' &&
      candidate.aiStatus !== 'schema_absent' &&
      candidate.aiStatus !== 'inactive' &&
      candidate.aiStatus !== 'active') ||
    typeof candidate.bootId !== 'string' ||
    !BOOT_ID_PATTERN.test(candidate.bootId) ||
    !Number.isSafeInteger(candidate.activeBootAgeMs) ||
    (candidate.activeBootAgeMs as number) < 0 ||
    (candidate.activeBootAgeMs as number) > 31_536_000_000 ||
    !Number.isSafeInteger(candidate.processId) ||
    (candidate.processId as number) < 1 ||
    (candidate.processId as number) > 4_194_304 ||
    typeof candidate.processStartTicks !== 'string' ||
    !START_TICKS_PATTERN.test(candidate.processStartTicks) ||
    typeof candidate.nodeExecutable !== 'string' ||
    typeof candidate.nodeVersion !== 'string' ||
    !/^v24\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(
      candidate.nodeVersion,
    ) ||
    typeof candidate.sha256 !== 'string' ||
    !SHA256_PATTERN.test(candidate.sha256)
  ) {
    throw new LocalApplicationStartupReceiptError('receipt values are invalid');
  }
  boundedAbsolutePath(candidate.nodeExecutable, 'Node executable');
  const receipt = Object.freeze({
    schemaVersion: 1 as const,
    schema: LOCAL_APPLICATION_STARTUP_RECEIPT_SCHEMA,
    instanceId: candidate.instanceId,
    profile: candidate.profile,
    aiStatus: candidate.aiStatus,
    bootId: candidate.bootId,
    activeBootAgeMs: candidate.activeBootAgeMs as number,
    processId: candidate.processId as number,
    processStartTicks: candidate.processStartTicks,
    nodeExecutable: candidate.nodeExecutable,
    nodeVersion: candidate.nodeVersion,
    sha256: candidate.sha256,
  });
  if (canonicalDigest(receiptWithoutDigest(receipt)) !== receipt.sha256) {
    throw new LocalApplicationStartupReceiptError('receipt digest is invalid');
  }
  return receipt;
}

export function recordLocalApplicationStartupReceipt(options: {
  readonly configFilePath: string;
  readonly instanceId: string;
  readonly profile: LocalApplicationProfile;
  readonly aiStatus: LocalApplicationStartupAiStatus;
}): Readonly<LocalApplicationStartupReceipt> | undefined {
  const observation = observeLocalApplicationStartup();
  if (observation === undefined) return undefined;
  const receipt = buildLocalApplicationStartupReceipt({
    instanceId: options.instanceId,
    profile: options.profile,
    aiStatus: options.aiStatus,
    observation,
  });
  publishLocalApplicationStartupReceipt(options.configFilePath, receipt);
  return receipt;
}
