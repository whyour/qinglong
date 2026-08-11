import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { LocalDeploymentConfigurationError } from '../../foundation/contract';
import {
  preflightPublishedFile,
  publishExactFile,
} from '../../foundation/files';
import { cutoverDigest } from '../targetEvidence';
import type { LocalDeploymentTargetRunCommand } from './targetRunContract';

const JOURNAL_SCHEMA = 'qinglong3-local-cutover-journal-record';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type TargetRunJournalState =
  | 'legacy_recheck_requested'
  | 'legacy_reverified'
  | 'target_start_requested'
  | 'target_restart_requested'
  | 'target_stop_requested'
  | 'target_active'
  | 'target_stopped'
  | 'legacy_restart_requested'
  | 'legacy_running'
  | 'manual_required';

export type TargetRunManualReason =
  | 'legacy_silence_unproved'
  | 'target_preflight_unproved'
  | 'target_start_result_unproved'
  | 'target_restart_result_unproved'
  | 'target_stop_preflight_unproved'
  | 'target_stop_result_unproved'
  | 'legacy_restart_preflight_unproved'
  | 'legacy_restart_result_unproved';

export interface TargetRunJournalRecord {
  readonly schema: typeof JOURNAL_SCHEMA;
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly state: TargetRunJournalState;
  readonly cutoverId: string;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly activationDigest: string;
  readonly generation: number;
  readonly previousRecordDigest: string;
  readonly requestedAtMs: number;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly recordDigest: string;
}

export interface TargetRunJournalContext {
  readonly command: Readonly<LocalDeploymentTargetRunCommand>;
  readonly uid: number;
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

export function targetRunJournalRecord(
  command: Readonly<LocalDeploymentTargetRunCommand>,
  sequence: number,
  state: TargetRunJournalState,
  previousRecordDigest: string,
  evidence: Readonly<Record<string, unknown>>,
): Readonly<TargetRunJournalRecord> {
  const payload = Object.freeze({
    schema: JOURNAL_SCHEMA,
    schemaVersion: 1 as const,
    sequence,
    state,
    cutoverId: command.request.cutoverId,
    profile: command.request.profile,
    instanceId: command.request.instanceId,
    activationDigest: command.request.expectedActivationDigest,
    generation: command.request.generation,
    previousRecordDigest,
    requestedAtMs: command.request.requestedAtMs,
    evidence,
  });
  return Object.freeze({ ...payload, recordDigest: cutoverDigest(payload) });
}

function parseTargetRunJournalRecord(
  value: unknown,
  command: Readonly<LocalDeploymentTargetRunCommand>,
  expected: Readonly<{
    sequence: number;
    generation: number;
    states: readonly TargetRunJournalState[];
    previousRecordDigest?: string;
    requestedAtMs?: number;
  }>,
): Readonly<TargetRunJournalRecord> {
  const record = object(value, 'target run journal record');
  exact(
    record,
    [
      'activationDigest',
      'cutoverId',
      'evidence',
      'generation',
      'instanceId',
      'previousRecordDigest',
      'profile',
      'recordDigest',
      'requestedAtMs',
      'schema',
      'schemaVersion',
      'sequence',
      'state',
    ],
    'target run journal record',
  );
  const { recordDigest, ...payload } = record;
  if (
    record.schema !== JOURNAL_SCHEMA ||
    record.schemaVersion !== 1 ||
    record.sequence !== expected.sequence ||
    !expected.states.includes(record.state as TargetRunJournalState) ||
    record.cutoverId !== command.request.cutoverId ||
    record.profile !== command.request.profile ||
    record.instanceId !== command.request.instanceId ||
    record.activationDigest !== command.request.expectedActivationDigest ||
    record.generation !== expected.generation ||
    (expected.previousRecordDigest !== undefined &&
      record.previousRecordDigest !== expected.previousRecordDigest) ||
    (expected.requestedAtMs !== undefined &&
      record.requestedAtMs !== expected.requestedAtMs) ||
    typeof record.previousRecordDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.previousRecordDigest) ||
    !Number.isSafeInteger(record.requestedAtMs) ||
    (record.requestedAtMs as number) < 0 ||
    typeof recordDigest !== 'string' ||
    !DIGEST_PATTERN.test(recordDigest) ||
    cutoverDigest(payload) !== recordDigest
  ) {
    configurationError('target run journal record drifted');
  }
  object(record.evidence, 'target run journal evidence');
  return record as unknown as Readonly<TargetRunJournalRecord>;
}

export function publishTargetRunJournalRecord(
  context: Readonly<TargetRunJournalContext>,
  filePath: string,
  record: Readonly<TargetRunJournalRecord>,
  label: string,
): 'prepared' | 'existing' {
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  preflightPublishedFile(filePath, contents, 0o600, context.uid, label);
  return publishExactFile(filePath, contents, 0o600, context.uid, label);
}

export function readTargetRunJournalRecord(
  filePath: string,
  context: Readonly<TargetRunJournalContext>,
  expected: Parameters<typeof parseTargetRunJournalRecord>[2],
): Readonly<TargetRunJournalRecord> {
  return parseTargetRunJournalRecord(
    readPrivateLocalCommandFile(filePath),
    context.command,
    expected,
  );
}

export function targetRunSequence(
  generation: number,
  phase: 'recheck' | 'verified' | 'request' | 'outcome',
): number {
  if (generation === 1) return phase === 'request' ? 3 : 4;
  const base = generation * 4;
  if (phase === 'recheck') return base - 3;
  if (phase === 'verified') return base - 2;
  if (phase === 'request') return base - 1;
  return base;
}

export function targetRunPhasePath(
  journal: string,
  generation: number,
  phase: 'recheck' | 'verified' | 'request' | 'outcome',
): string {
  const number = String(targetRunSequence(generation, phase)).padStart(4, '0');
  const label =
    generation === 1
      ? phase === 'request'
        ? 'target-start-decision'
        : 'target-start-outcome'
      : phase === 'recheck'
      ? 'legacy-recheck-decision'
      : phase === 'verified'
      ? 'legacy-recheck-outcome'
      : phase === 'request'
      ? 'target-restart-decision'
      : 'target-restart-outcome';
  return path.join(journal, `${number}-${label}.json`);
}

export function targetStopSequence(
  generation: number,
  phase: 'request' | 'outcome',
): number {
  return generation * 4 + (phase === 'request' ? 1 : 2);
}

export function targetStopPhasePath(
  journal: string,
  generation: number,
  phase: 'request' | 'outcome',
): string {
  const number = String(targetStopSequence(generation, phase)).padStart(4, '0');
  return path.join(
    journal,
    `${number}-${
      phase === 'request' ? 'target-stop-decision' : 'target-stop-outcome'
    }.json`,
  );
}

export function legacyRollbackSequence(
  generation: number,
  phase: 'request' | 'outcome',
): number {
  return generation * 4 + (phase === 'request' ? 3 : 4);
}

export function legacyRollbackPhasePath(
  journal: string,
  generation: number,
  phase: 'request' | 'outcome',
): string {
  const number = String(legacyRollbackSequence(generation, phase)).padStart(
    4,
    '0',
  );
  return path.join(
    journal,
    `${number}-${
      phase === 'request'
        ? 'legacy-rollback-start-decision'
        : 'legacy-rollback-start-outcome'
    }.json`,
  );
}

export function targetRunManualEvidence(
  reason: TargetRunManualReason,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    reason,
    uncertainState:
      reason === 'legacy_silence_unproved'
        ? 'legacy_silence'
        : reason === 'legacy_restart_preflight_unproved' ||
          reason === 'legacy_restart_result_unproved'
        ? 'legacy_activity'
        : 'target_activity',
    errorDigest: crypto
      .createHash('sha256')
      .update(`qinglong3.local-cutover.${reason}`, 'utf8')
      .digest('hex'),
  });
}

export function verifyTargetRunManualEvidence(
  record: Readonly<TargetRunJournalRecord>,
): void {
  const evidence = object(record.evidence, 'manual-required evidence');
  exact(
    evidence,
    ['errorDigest', 'reason', 'uncertainState'],
    'manual-required evidence',
  );
  if (
    (evidence.reason !== 'legacy_silence_unproved' &&
      evidence.reason !== 'target_preflight_unproved' &&
      evidence.reason !== 'target_start_result_unproved' &&
      evidence.reason !== 'target_restart_result_unproved' &&
      evidence.reason !== 'target_stop_preflight_unproved' &&
      evidence.reason !== 'target_stop_result_unproved' &&
      evidence.reason !== 'legacy_restart_preflight_unproved' &&
      evidence.reason !== 'legacy_restart_result_unproved') ||
    (evidence.uncertainState !== 'legacy_silence' &&
      evidence.uncertainState !== 'legacy_activity' &&
      evidence.uncertainState !== 'target_activity') ||
    typeof evidence.errorDigest !== 'string' ||
    !DIGEST_PATTERN.test(evidence.errorDigest)
  ) {
    configurationError('manual-required evidence drifted');
  }
}
