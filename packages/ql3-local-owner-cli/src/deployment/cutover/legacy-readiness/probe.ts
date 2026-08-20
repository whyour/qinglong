import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import {
  currentIdentity,
  LocalDeploymentConfigurationError,
} from '../../foundation/contract';
import {
  preflightPublishedFile,
  publishExactFile,
} from '../../foundation/files';
import {
  advanceLocalCutoverInstanceHead,
  localCutoverInstanceDirectory,
  readLocalCutoverInstanceHead,
  type LocalCutoverInstanceHead,
} from '../instanceLineage';
import { cutoverDigest } from '../targetEvidence';
import {
  normalizeLocalDeploymentLegacyReadinessCommand,
  type LocalDeploymentLegacyReadinessCommand,
} from './contract';

const RECEIPT_SCHEMA = 'qinglong3-local-legacy-readiness-receipt';
const LOOPBACK_HOST = '127.0.0.1';
const SYSTEM_PATH = '/api/system';
const MAX_RESPONSE_BYTES = 32 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type LocalLegacyReadinessReason =
  | 'unavailable'
  | 'http_rejected'
  | 'response_too_large'
  | 'response_invalid'
  | 'not_initialized'
  | 'version_mismatch';

export type LocalLegacyReadinessObservation =
  | Readonly<{
      ready: true;
      initialized: true;
      version: string;
    }>
  | Readonly<{
      ready: false;
      reason: LocalLegacyReadinessReason;
    }>;

export interface LocalLegacyReadinessProbeInput {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly path: typeof SYSTEM_PATH;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface LocalDeploymentLegacyReadinessDependencies {
  readonly probe?: (
    input: Readonly<LocalLegacyReadinessProbeInput>,
  ) => Promise<Readonly<LocalLegacyReadinessObservation>>;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

interface LocalLegacyReadinessReceipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'legacy_ready';
  readonly cutoverId: string;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly generation: number;
  readonly activationDigest: string;
  readonly previousHeadDigest: string;
  readonly legacyRunningRecordDigest: string;
  readonly endpoint: Readonly<{
    host: typeof LOOPBACK_HOST;
    port: number;
    path: typeof SYSTEM_PATH;
  }>;
  readonly expectedVersion: string;
  readonly observedVersion: string;
  readonly initialized: true;
  readonly attempts: number;
  readonly observedAtMs: number;
  readonly receiptDigest: string;
}

export type LocalDeploymentLegacyReadinessResult =
  | Readonly<{
      schemaVersion: 1;
      operation: LocalDeploymentLegacyReadinessCommand['operation'];
      status: 'prepared' | 'existing';
      state: 'legacy_ready';
      cutoverId: string;
      generation: number;
      attempts: number;
      receiptDigest: string;
      instanceHeadDigest: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: LocalDeploymentLegacyReadinessCommand['operation'];
      status: 'not_ready';
      state: 'legacy_running';
      reason: LocalLegacyReadinessReason;
      cutoverId: string;
      generation: number;
      attempts: number;
      instanceHeadDigest: string;
    }>;

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    configurationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    configurationError(`${label} shape is invalid`);
  }
}

function rejected(reason: LocalLegacyReadinessReason) {
  return Object.freeze({ ready: false as const, reason });
}

export function probeLegacySystemEndpoint(
  input: Readonly<LocalLegacyReadinessProbeInput>,
): Promise<Readonly<LocalLegacyReadinessObservation>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (observation: Readonly<LocalLegacyReadinessObservation>) => {
      if (settled) return;
      settled = true;
      resolve(observation);
    };
    const request = http.request(
      {
        agent: false,
        host: input.host,
        port: input.port,
        path: input.path,
        method: 'GET',
        headers: Object.freeze({
          accept: 'application/json',
          connection: 'close',
        }),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(rejected('http_rejected'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > input.maxResponseBytes) {
            finish(rejected('response_too_large'));
            response.destroy();
            return;
          }
          chunks.push(bytes);
        });
        response.on('end', () => {
          if (settled) return;
          try {
            const envelope = object(
              JSON.parse(Buffer.concat(chunks).toString('utf8')),
              'legacy system response',
            );
            const data = object(envelope.data, 'legacy system response data');
            if (envelope.code !== 200 || typeof data.version !== 'string') {
              finish(rejected('response_invalid'));
              return;
            }
            if (data.isInitialized !== true) {
              finish(rejected('not_initialized'));
              return;
            }
            finish(
              Object.freeze({
                ready: true as const,
                initialized: true as const,
                version: data.version,
              }),
            );
          } catch {
            finish(rejected('response_invalid'));
          }
        });
        response.on('error', () => finish(rejected('unavailable')));
      },
    );
    request.setTimeout(input.timeoutMs, () => request.destroy());
    request.on('error', () => finish(rejected('unavailable')));
    request.end();
  });
}

function receiptPath(
  command: Readonly<LocalDeploymentLegacyReadinessCommand>,
): string {
  return path.join(
    localCutoverInstanceDirectory(
      command.options.deploymentRoot,
      command.request.instanceId,
    ),
    `legacy-readiness-g${command.request.generation}.json`,
  );
}

function receiptContents(
  receipt: Readonly<LocalLegacyReadinessReceipt>,
): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function parseReceipt(value: unknown): Readonly<LocalLegacyReadinessReceipt> {
  const receipt = object(value, 'legacy readiness receipt');
  exact(
    receipt,
    [
      'activationDigest',
      'attempts',
      'cutoverId',
      'endpoint',
      'expectedVersion',
      'generation',
      'initialized',
      'instanceId',
      'legacyRunningRecordDigest',
      'observedAtMs',
      'observedVersion',
      'previousHeadDigest',
      'profile',
      'receiptDigest',
      'schema',
      'schemaVersion',
      'state',
    ],
    'legacy readiness receipt',
  );
  const endpoint = object(receipt.endpoint, 'legacy readiness endpoint');
  exact(endpoint, ['host', 'path', 'port'], 'legacy readiness endpoint');
  const { receiptDigest, ...payload } = receipt;
  if (
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.schemaVersion !== 1 ||
    receipt.state !== 'legacy_ready' ||
    typeof receipt.cutoverId !== 'string' ||
    (receipt.profile !== 'edge' && receipt.profile !== 'standalone') ||
    typeof receipt.instanceId !== 'string' ||
    !Number.isSafeInteger(receipt.generation) ||
    (receipt.generation as number) < 1 ||
    typeof receipt.activationDigest !== 'string' ||
    !DIGEST_PATTERN.test(receipt.activationDigest) ||
    typeof receipt.previousHeadDigest !== 'string' ||
    !DIGEST_PATTERN.test(receipt.previousHeadDigest) ||
    typeof receipt.legacyRunningRecordDigest !== 'string' ||
    !DIGEST_PATTERN.test(receipt.legacyRunningRecordDigest) ||
    endpoint.host !== LOOPBACK_HOST ||
    endpoint.path !== SYSTEM_PATH ||
    !Number.isSafeInteger(endpoint.port) ||
    (endpoint.port as number) < 1 ||
    (endpoint.port as number) > 65_535 ||
    typeof receipt.expectedVersion !== 'string' ||
    typeof receipt.observedVersion !== 'string' ||
    receipt.initialized !== true ||
    !Number.isSafeInteger(receipt.attempts) ||
    (receipt.attempts as number) < 1 ||
    !Number.isSafeInteger(receipt.observedAtMs) ||
    (receipt.observedAtMs as number) < 0 ||
    typeof receiptDigest !== 'string' ||
    !DIGEST_PATTERN.test(receiptDigest) ||
    cutoverDigest(payload) !== receiptDigest
  ) {
    configurationError('legacy readiness receipt drifted');
  }
  return receipt as unknown as Readonly<LocalLegacyReadinessReceipt>;
}

function verifyReceipt(
  command: Readonly<LocalDeploymentLegacyReadinessCommand>,
  receipt: Readonly<LocalLegacyReadinessReceipt>,
): void {
  if (
    receipt.cutoverId !== command.request.cutoverId ||
    receipt.profile !== command.request.profile ||
    receipt.instanceId !== command.request.instanceId ||
    receipt.generation !== command.request.generation ||
    receipt.activationDigest !== command.request.expectedActivationDigest ||
    receipt.previousHeadDigest !== command.request.expectedInstanceHeadDigest ||
    receipt.legacyRunningRecordDigest !==
      command.request.expectedLegacyRunningRecordDigest ||
    receipt.endpoint.port !== command.request.legacyHttpPort ||
    receipt.expectedVersion !== command.request.expectedLegacyVersion ||
    receipt.observedVersion !== command.request.expectedLegacyVersion
  ) {
    configurationError('legacy readiness receipt does not match the command');
  }
}

function verifyHead(
  command: Readonly<LocalDeploymentLegacyReadinessCommand>,
  head: Readonly<LocalCutoverInstanceHead>,
): void {
  const replay = head.state === 'legacy_ready';
  if (
    head.profile !== command.request.profile ||
    head.cutoverId !== command.request.cutoverId ||
    head.instanceId !== command.request.instanceId ||
    head.generation !== command.request.generation ||
    head.activationDigest !== command.request.expectedActivationDigest ||
    (replay
      ? head.previousHeadDigest !== command.request.expectedInstanceHeadDigest
      : head.headDigest !== command.request.expectedInstanceHeadDigest) ||
    (!replay &&
      head.sourceRecordDigest !==
        command.request.expectedLegacyRunningRecordDigest) ||
    (head.state !== 'legacy_running' && head.state !== 'legacy_ready')
  ) {
    configurationError(
      'legacy readiness command lost the instance head compare-and-swap',
    );
  }
}

function successfulResult(
  command: Readonly<LocalDeploymentLegacyReadinessCommand>,
  status: 'prepared' | 'existing',
  receipt: Readonly<LocalLegacyReadinessReceipt>,
  head: Readonly<LocalCutoverInstanceHead>,
): Readonly<LocalDeploymentLegacyReadinessResult> {
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status,
    state: 'legacy_ready' as const,
    cutoverId: command.request.cutoverId,
    generation: command.request.generation,
    attempts: receipt.attempts,
    receiptDigest: receipt.receiptDigest,
    instanceHeadDigest: head.headDigest,
  });
}

function completeExistingReceipt(
  command: Readonly<LocalDeploymentLegacyReadinessCommand>,
  uid: number,
  current: Readonly<LocalCutoverInstanceHead>,
): Readonly<LocalDeploymentLegacyReadinessResult> | undefined {
  const filePath = receiptPath(command);
  if (!fs.existsSync(filePath)) return undefined;
  const receipt = parseReceipt(readPrivateLocalCommandFile(filePath));
  verifyReceipt(command, receipt);
  const head =
    current.state === 'legacy_ready'
      ? current
      : advanceLocalCutoverInstanceHead(
          command,
          uid,
          'legacy_ready',
          command.request.generation,
          receipt.receiptDigest,
        );
  if (head.sourceRecordDigest !== receipt.receiptDigest) {
    configurationError('legacy-ready instance head is not receipt-bound');
  }
  return successfulResult(command, 'existing', receipt, head);
}

function policy(profile: 'edge' | 'standalone') {
  return profile === 'edge'
    ? Object.freeze({
        totalTimeoutMs: 30_000,
        requestTimeoutMs: 2_000,
        pollIntervalMs: 500,
        maximumAttempts: 60,
      })
    : Object.freeze({
        totalTimeoutMs: 60_000,
        requestTimeoutMs: 2_000,
        pollIntervalMs: 500,
        maximumAttempts: 120,
      });
}

export async function proveLocalDeploymentLegacyReadiness(
  input: unknown,
  dependencies: Readonly<LocalDeploymentLegacyReadinessDependencies> = {},
): Promise<Readonly<LocalDeploymentLegacyReadinessResult>> {
  const command = normalizeLocalDeploymentLegacyReadinessCommand(input);
  const identity = currentIdentity();
  const current = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    command.request.instanceId,
    identity.uid,
  );
  verifyHead(command, current);
  const existing = completeExistingReceipt(command, identity.uid, current);
  if (existing) return existing;
  if (current.state !== 'legacy_running') {
    configurationError('legacy-ready instance is missing its receipt');
  }

  const observe = dependencies.probe ?? probeLegacySystemEndpoint;
  const now = dependencies.now ?? Date.now;
  const wait =
    dependencies.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const limits = policy(command.request.profile);
  const deadline = now() + limits.totalTimeoutMs;
  let attempts = 0;
  let lastReason: LocalLegacyReadinessReason = 'unavailable';
  while (attempts < limits.maximumAttempts && now() <= deadline) {
    attempts += 1;
    const remaining = Math.max(1, deadline - now());
    const observation = await observe(
      Object.freeze({
        host: LOOPBACK_HOST,
        port: command.request.legacyHttpPort,
        path: SYSTEM_PATH,
        timeoutMs: Math.min(limits.requestTimeoutMs, remaining),
        maxResponseBytes: MAX_RESPONSE_BYTES,
      }),
    );
    if (observation.ready === true) {
      if (observation.version !== command.request.expectedLegacyVersion) {
        lastReason = 'version_mismatch';
        break;
      }
      const payload = Object.freeze({
        schema: RECEIPT_SCHEMA,
        schemaVersion: 1 as const,
        state: 'legacy_ready' as const,
        cutoverId: command.request.cutoverId,
        profile: command.request.profile,
        instanceId: command.request.instanceId,
        generation: command.request.generation,
        activationDigest: command.request.expectedActivationDigest,
        previousHeadDigest: command.request.expectedInstanceHeadDigest,
        legacyRunningRecordDigest:
          command.request.expectedLegacyRunningRecordDigest,
        endpoint: Object.freeze({
          host: LOOPBACK_HOST,
          port: command.request.legacyHttpPort,
          path: SYSTEM_PATH,
        }),
        expectedVersion: command.request.expectedLegacyVersion,
        observedVersion: observation.version,
        initialized: true as const,
        attempts,
        observedAtMs: now(),
      });
      const receipt = Object.freeze({
        ...payload,
        receiptDigest: cutoverDigest(payload),
      });
      const filePath = receiptPath(command);
      const contents = receiptContents(receipt);
      preflightPublishedFile(
        filePath,
        contents,
        0o600,
        identity.uid,
        'legacy readiness receipt',
      );
      const status = publishExactFile(
        filePath,
        contents,
        0o600,
        identity.uid,
        'legacy readiness receipt',
      );
      const head = advanceLocalCutoverInstanceHead(
        command,
        identity.uid,
        'legacy_ready',
        command.request.generation,
        receipt.receiptDigest,
      );
      return successfulResult(command, status, receipt, head);
    }
    lastReason = observation.reason;
    if (attempts >= limits.maximumAttempts || now() >= deadline) break;
    await wait(Math.min(limits.pollIntervalMs, deadline - now()));
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status: 'not_ready' as const,
    state: 'legacy_running' as const,
    reason: lastReason,
    cutoverId: command.request.cutoverId,
    generation: command.request.generation,
    attempts,
    instanceHeadDigest: current.headDigest,
  });
}

export function proveLocalDeploymentLegacyReadinessCommandFile(
  filePath: string,
  dependencies: Readonly<LocalDeploymentLegacyReadinessDependencies> = {},
): Promise<Readonly<LocalDeploymentLegacyReadinessResult>> {
  return proveLocalDeploymentLegacyReadiness(
    readPrivateLocalCommandFile(filePath),
    dependencies,
  );
}
