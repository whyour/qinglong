import crypto from 'node:crypto';
import path from 'node:path';

import type { LocalApplicationProfile } from '../application-runtime/contract';
import { publishLocalApplicationLifecycleReceiptFile } from './lifecycleReceiptFile';
import {
  observeLocalApplicationStartup,
  type LocalApplicationStartupObservation,
} from './startupReceipt';

export const LOCAL_APPLICATION_SHUTDOWN_RECEIPT_SCHEMA =
  'qinglong/local-application-shutdown-receipt@v1' as const;
export const MAX_LOCAL_APPLICATION_SHUTDOWN_RECEIPT_BYTES = 4096;

const MAX_PATH_BYTES = 4096;
const BOOT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const START_TICKS_PATTERN = /^[1-9][0-9]{0,19}$/;

export type LocalApplicationShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface LocalApplicationShutdownObservation
  extends Omit<LocalApplicationStartupObservation, 'activeBootAgeMs'> {
  readonly stoppedBootAgeMs: number;
}

export interface LocalApplicationShutdownReceipt
  extends LocalApplicationShutdownObservation {
  readonly schemaVersion: 1;
  readonly schema: typeof LOCAL_APPLICATION_SHUTDOWN_RECEIPT_SCHEMA;
  readonly instanceId: string;
  readonly profile: LocalApplicationProfile;
  readonly signal: LocalApplicationShutdownSignal;
  readonly stopResult: 'stopped';
  readonly startupReceiptDigest: string;
  readonly sha256: string;
}

export class LocalApplicationShutdownReceiptError extends Error {
  readonly code = 'QL3_LOCAL_APPLICATION_SHUTDOWN_RECEIPT_UNAVAILABLE';

  constructor(message: string, options?: ErrorOptions) {
    super(
      `Local application shutdown receipt is unavailable: ${message}`,
      options,
    );
    this.name = 'LocalApplicationShutdownReceiptError';
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
    throw new LocalApplicationShutdownReceiptError(
      `${label} must be a normalized bounded absolute path`,
    );
  }
  return value;
}

function canonicalDigest(
  value: Omit<LocalApplicationShutdownReceipt, 'sha256'>,
): string {
  return crypto
    .createHash('sha256')
    .update('qinglong.local-application-shutdown-receipt.v1\0', 'utf8')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function withoutDigest(
  receipt: Readonly<LocalApplicationShutdownReceipt>,
): Omit<LocalApplicationShutdownReceipt, 'sha256'> {
  return Object.freeze({
    schemaVersion: receipt.schemaVersion,
    schema: receipt.schema,
    instanceId: receipt.instanceId,
    profile: receipt.profile,
    signal: receipt.signal,
    stopResult: receipt.stopResult,
    startupReceiptDigest: receipt.startupReceiptDigest,
    bootId: receipt.bootId,
    stoppedBootAgeMs: receipt.stoppedBootAgeMs,
    processId: receipt.processId,
    processStartTicks: receipt.processStartTicks,
    nodeExecutable: receipt.nodeExecutable,
    nodeVersion: receipt.nodeVersion,
  });
}

export function observeLocalApplicationShutdown(
  procRoot = '/proc',
): Readonly<LocalApplicationShutdownObservation> | undefined {
  const observed = observeLocalApplicationStartup(procRoot);
  if (observed === undefined) return undefined;
  const { activeBootAgeMs, ...identity } = observed;
  return Object.freeze({ ...identity, stoppedBootAgeMs: activeBootAgeMs });
}

export function buildLocalApplicationShutdownReceipt(options: {
  readonly instanceId: string;
  readonly profile: LocalApplicationProfile;
  readonly signal: LocalApplicationShutdownSignal;
  readonly startupReceiptDigest: string;
  readonly observation: Readonly<LocalApplicationShutdownObservation>;
}): Readonly<LocalApplicationShutdownReceipt> {
  const body = Object.freeze({
    schemaVersion: 1 as const,
    schema: LOCAL_APPLICATION_SHUTDOWN_RECEIPT_SCHEMA,
    instanceId: options.instanceId,
    profile: options.profile,
    signal: options.signal,
    stopResult: 'stopped' as const,
    startupReceiptDigest: options.startupReceiptDigest,
    bootId: options.observation.bootId,
    stoppedBootAgeMs: options.observation.stoppedBootAgeMs,
    processId: options.observation.processId,
    processStartTicks: options.observation.processStartTicks,
    nodeExecutable: options.observation.nodeExecutable,
    nodeVersion: options.observation.nodeVersion,
  });
  return Object.freeze({ ...body, sha256: canonicalDigest(body) });
}

export function localApplicationShutdownReceiptPath(
  configFilePath: string,
): string {
  return `${boundedAbsolutePath(
    configFilePath,
    'application configuration path',
  )}.stopped.json`;
}

export function parseLocalApplicationShutdownReceipt(
  contents: string,
): Readonly<LocalApplicationShutdownReceipt> {
  if (
    typeof contents !== 'string' ||
    Buffer.byteLength(contents, 'utf8') < 1 ||
    Buffer.byteLength(contents, 'utf8') >
      MAX_LOCAL_APPLICATION_SHUTDOWN_RECEIPT_BYTES
  ) {
    throw new LocalApplicationShutdownReceiptError(
      'receipt is outside its byte limit',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new LocalApplicationShutdownReceiptError('receipt is not JSON', {
      cause: error,
    });
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
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
      'signal',
      'stoppedBootAgeMs',
      'stopResult',
      'startupReceiptDigest',
    ])
  ) {
    throw new LocalApplicationShutdownReceiptError('receipt shape is invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.schema !== LOCAL_APPLICATION_SHUTDOWN_RECEIPT_SCHEMA ||
    typeof candidate.instanceId !== 'string' ||
    candidate.instanceId.length < 1 ||
    Buffer.byteLength(candidate.instanceId, 'utf8') > 128 ||
    (candidate.profile !== 'edge' && candidate.profile !== 'standalone') ||
    (candidate.signal !== 'SIGINT' && candidate.signal !== 'SIGTERM') ||
    candidate.stopResult !== 'stopped' ||
    typeof candidate.startupReceiptDigest !== 'string' ||
    !SHA256_PATTERN.test(candidate.startupReceiptDigest) ||
    typeof candidate.bootId !== 'string' ||
    !BOOT_ID_PATTERN.test(candidate.bootId) ||
    !Number.isSafeInteger(candidate.stoppedBootAgeMs) ||
    (candidate.stoppedBootAgeMs as number) < 0 ||
    (candidate.stoppedBootAgeMs as number) > 31_536_000_000 ||
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
    throw new LocalApplicationShutdownReceiptError(
      'receipt values are invalid',
    );
  }
  boundedAbsolutePath(candidate.nodeExecutable, 'Node executable');
  const receipt = Object.freeze({
    schemaVersion: 1 as const,
    schema: LOCAL_APPLICATION_SHUTDOWN_RECEIPT_SCHEMA,
    instanceId: candidate.instanceId,
    profile: candidate.profile,
    signal: candidate.signal,
    stopResult: 'stopped' as const,
    startupReceiptDigest: candidate.startupReceiptDigest,
    bootId: candidate.bootId,
    stoppedBootAgeMs: candidate.stoppedBootAgeMs as number,
    processId: candidate.processId as number,
    processStartTicks: candidate.processStartTicks,
    nodeExecutable: candidate.nodeExecutable,
    nodeVersion: candidate.nodeVersion,
    sha256: candidate.sha256,
  });
  if (canonicalDigest(withoutDigest(receipt)) !== receipt.sha256) {
    throw new LocalApplicationShutdownReceiptError('receipt digest is invalid');
  }
  return receipt;
}

export function publishLocalApplicationShutdownReceipt(
  configFilePath: string,
  receipt: Readonly<LocalApplicationShutdownReceipt>,
): string {
  const targetPath = localApplicationShutdownReceiptPath(configFilePath);
  const normalized = parseLocalApplicationShutdownReceipt(
    `${JSON.stringify(receipt)}\n`,
  );
  return publishLocalApplicationLifecycleReceiptFile({
    targetPath,
    contents: `${JSON.stringify(normalized)}\n`,
    maximumBytes: MAX_LOCAL_APPLICATION_SHUTDOWN_RECEIPT_BYTES,
    isFailure: (error) => error instanceof LocalApplicationShutdownReceiptError,
    fail(message, cause) {
      throw new LocalApplicationShutdownReceiptError(
        message,
        cause === undefined ? undefined : { cause },
      );
    },
  });
}

export function recordLocalApplicationShutdownReceipt(options: {
  readonly configFilePath: string;
  readonly instanceId: string;
  readonly profile: LocalApplicationProfile;
  readonly signal: LocalApplicationShutdownSignal;
  readonly startupReceiptDigest: string;
}): Readonly<LocalApplicationShutdownReceipt> | undefined {
  const observation = observeLocalApplicationShutdown();
  if (observation === undefined) return undefined;
  const receipt = buildLocalApplicationShutdownReceipt({
    instanceId: options.instanceId,
    profile: options.profile,
    signal: options.signal,
    startupReceiptDigest: options.startupReceiptDigest,
    observation,
  });
  publishLocalApplicationShutdownReceipt(options.configFilePath, receipt);
  return receipt;
}
