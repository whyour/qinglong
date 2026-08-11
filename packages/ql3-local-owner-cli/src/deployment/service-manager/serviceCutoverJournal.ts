import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { LocalDeploymentConfigurationError } from '../foundation/contract';
import { preflightPublishedFile, publishExactFile } from '../foundation/files';
import { cutoverDigest } from '../cutover/targetEvidence';
import type {
  LocalServiceManagerAction,
  LocalServiceManagerIntent,
} from './serviceBridgeContract';
import type { LocalServiceManagerOutcome } from './serviceOutcomeContract';

const SCHEMA = 'qinglong3-local-service-manager-cutover-record';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type LocalServiceManagerCutoverState =
  | 'target_active'
  | 'target_stopped'
  | 'manual_required';

export interface LocalServiceManagerCutoverEvidence {
  readonly managerOutcomeDigest: string;
  readonly managerObservationDigest: string;
  readonly applicationConfigDigest: string;
  readonly activationDigest: string;
  readonly commitmentDigest: string;
  readonly targetDataIdentityDigest: string;
  readonly startupReceiptDigest: string | null;
  readonly shutdownReceiptDigest: string | null;
  readonly processIdentityDigest: string | null;
  readonly manualReason: string | null;
}

export interface LocalServiceManagerCutoverRecord {
  readonly schema: typeof SCHEMA;
  readonly schemaVersion: 1;
  readonly actionId: string;
  readonly action: LocalServiceManagerAction;
  readonly state: LocalServiceManagerCutoverState;
  readonly cutoverId: string;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly activationDigest: string;
  readonly generation: number;
  readonly previousRecordDigest: string;
  readonly intentDigest: string;
  readonly requestedAtMs: number;
  readonly completedAtMs: number;
  readonly evidence: Readonly<LocalServiceManagerCutoverEvidence>;
  readonly recordDigest: string;
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(message);
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

function generationName(generation: number): string {
  return String(generation).padStart(2, '0');
}

export function localServiceManagerActiveRecordPath(
  deploymentRoot: string,
  cutoverId: string,
  generation: number,
): string {
  return path.join(
    deploymentRoot,
    'service',
    'cutovers',
    cutoverId,
    `service-manager-g${generationName(generation)}-active.json`,
  );
}

export function localServiceManagerCutoverRecordPath(
  intent: Readonly<LocalServiceManagerIntent>,
  state: LocalServiceManagerCutoverState,
): string {
  if (intent.lineage.mode !== 'adopted') {
    configurationError('fresh service intent has no cutover journal');
  }
  const suffix =
    state === 'target_active'
      ? 'active'
      : state === 'target_stopped'
      ? 'stopped'
      : `manual-${intent.actionId}`;
  return path.join(
    intent.deployment.root,
    'service',
    'cutovers',
    intent.lineage.cutoverId,
    `service-manager-g${generationName(
      intent.lineage.generation,
    )}-${suffix}.json`,
  );
}

export function localServiceManagerCutoverRecord(
  intent: Readonly<LocalServiceManagerIntent>,
  outcome: Readonly<LocalServiceManagerOutcome>,
  state: LocalServiceManagerCutoverState,
  evidence: Readonly<LocalServiceManagerCutoverEvidence>,
): Readonly<LocalServiceManagerCutoverRecord> {
  if (intent.lineage.mode !== 'adopted') {
    configurationError('fresh service intent has no cutover lineage');
  }
  const payload = Object.freeze({
    schema: SCHEMA,
    schemaVersion: 1 as const,
    actionId: intent.actionId,
    action: intent.action,
    state,
    cutoverId: intent.lineage.cutoverId,
    profile: intent.profile,
    instanceId: intent.instanceId,
    activationDigest: intent.lineage.expectedActivationDigest,
    generation: intent.lineage.generation,
    previousRecordDigest: intent.lineage.previousRecordDigest,
    intentDigest: intent.intentDigest,
    requestedAtMs: intent.requestedAtMs,
    completedAtMs: outcome.completedAtMs,
    evidence,
  });
  return Object.freeze({ ...payload, recordDigest: cutoverDigest(payload) });
}

export function normalizeLocalServiceManagerCutoverRecord(
  value: unknown,
): Readonly<LocalServiceManagerCutoverRecord> {
  const record = object(value, 'service manager cutover record');
  exact(
    record,
    [
      'action',
      'actionId',
      'activationDigest',
      'completedAtMs',
      'cutoverId',
      'evidence',
      'generation',
      'instanceId',
      'intentDigest',
      'previousRecordDigest',
      'profile',
      'recordDigest',
      'requestedAtMs',
      'schema',
      'schemaVersion',
      'state',
    ],
    'service manager cutover record',
  );
  const evidence = object(record.evidence, 'service manager cutover evidence');
  exact(
    evidence,
    [
      'activationDigest',
      'applicationConfigDigest',
      'commitmentDigest',
      'managerObservationDigest',
      'managerOutcomeDigest',
      'manualReason',
      'processIdentityDigest',
      'shutdownReceiptDigest',
      'startupReceiptDigest',
      'targetDataIdentityDigest',
    ],
    'service manager cutover evidence',
  );
  const nullableDigest = (candidate: unknown): boolean =>
    candidate === null ||
    (typeof candidate === 'string' && DIGEST_PATTERN.test(candidate));
  const { recordDigest, ...payload } = record;
  if (
    record.schema !== SCHEMA ||
    record.schemaVersion !== 1 ||
    typeof record.actionId !== 'string' ||
    (record.action !== 'install-enable-start' &&
      record.action !== 'start' &&
      record.action !== 'restart' &&
      record.action !== 'stop') ||
    (record.state !== 'target_active' &&
      record.state !== 'target_stopped' &&
      record.state !== 'manual_required') ||
    typeof record.cutoverId !== 'string' ||
    (record.profile !== 'edge' && record.profile !== 'standalone') ||
    typeof record.instanceId !== 'string' ||
    typeof record.activationDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.activationDigest) ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1 ||
    typeof record.previousRecordDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.previousRecordDigest) ||
    typeof record.intentDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.intentDigest) ||
    !Number.isSafeInteger(record.requestedAtMs) ||
    (record.requestedAtMs as number) < 0 ||
    !Number.isSafeInteger(record.completedAtMs) ||
    (record.completedAtMs as number) < (record.requestedAtMs as number) ||
    typeof evidence.managerOutcomeDigest !== 'string' ||
    !DIGEST_PATTERN.test(evidence.managerOutcomeDigest) ||
    typeof evidence.managerObservationDigest !== 'string' ||
    !DIGEST_PATTERN.test(evidence.managerObservationDigest) ||
    typeof evidence.applicationConfigDigest !== 'string' ||
    !DIGEST_PATTERN.test(evidence.applicationConfigDigest) ||
    typeof evidence.activationDigest !== 'string' ||
    !DIGEST_PATTERN.test(evidence.activationDigest) ||
    typeof evidence.commitmentDigest !== 'string' ||
    !DIGEST_PATTERN.test(evidence.commitmentDigest) ||
    typeof evidence.targetDataIdentityDigest !== 'string' ||
    !DIGEST_PATTERN.test(evidence.targetDataIdentityDigest) ||
    !nullableDigest(evidence.startupReceiptDigest) ||
    !nullableDigest(evidence.shutdownReceiptDigest) ||
    !nullableDigest(evidence.processIdentityDigest) ||
    (evidence.manualReason !== null &&
      (typeof evidence.manualReason !== 'string' ||
        Buffer.byteLength(evidence.manualReason, 'utf8') > 128)) ||
    typeof recordDigest !== 'string' ||
    !DIGEST_PATTERN.test(recordDigest) ||
    cutoverDigest(payload) !== recordDigest
  ) {
    configurationError('service manager cutover record drifted');
  }
  return record as unknown as Readonly<LocalServiceManagerCutoverRecord>;
}

export function publishLocalServiceManagerCutoverRecord(
  intent: Readonly<LocalServiceManagerIntent>,
  record: Readonly<LocalServiceManagerCutoverRecord>,
  uid: number,
): 'prepared' | 'existing' {
  const filePath = localServiceManagerCutoverRecordPath(intent, record.state);
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  preflightPublishedFile(
    filePath,
    contents,
    0o600,
    uid,
    'service manager cutover record',
  );
  return publishExactFile(
    filePath,
    contents,
    0o600,
    uid,
    'service manager cutover record',
  );
}

export function readLocalServiceManagerActiveRecord(
  deploymentRoot: string,
  cutoverId: string,
  generation: number,
): Readonly<LocalServiceManagerCutoverRecord> {
  const filePath = localServiceManagerActiveRecordPath(
    deploymentRoot,
    cutoverId,
    generation,
  );
  if (!fs.existsSync(filePath)) {
    configurationError('previous service manager active record is unavailable');
  }
  const record = normalizeLocalServiceManagerCutoverRecord(
    readPrivateLocalCommandFile(filePath),
  );
  if (
    record.state !== 'target_active' ||
    record.cutoverId !== cutoverId ||
    record.generation !== generation
  ) {
    configurationError('previous service manager active record drifted');
  }
  return record;
}
