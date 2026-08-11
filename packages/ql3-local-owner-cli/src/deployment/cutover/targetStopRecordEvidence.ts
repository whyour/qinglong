import { LocalDeploymentConfigurationError } from '../foundation/contract';
import {
  verifyTargetDataReconciliationEvidence,
  type TargetDataReconciliationEvidence,
} from './targetDataEvidence';
import type { TargetRunJournalRecord } from './target-run/targetRunJournal';

export interface TargetStopActiveEvidence {
  readonly activeRecordDigest: string;
  readonly targetContainerIdentityDigest: string;
  readonly targetApplicationBindingDigest: string;
  readonly startupReceiptDigest: string;
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

export function targetStopRequestEvidence(
  active: Readonly<TargetStopActiveEvidence>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    activeRecordDigest: active.activeRecordDigest,
    startupReceiptDigest: active.startupReceiptDigest,
    targetApplicationBindingDigest: active.targetApplicationBindingDigest,
    targetContainerIdentityDigest: active.targetContainerIdentityDigest,
  });
}

export function verifyTargetStopRequestEvidence(
  record: Readonly<TargetRunJournalRecord>,
  active: Readonly<TargetStopActiveEvidence>,
): void {
  const evidence = object(record.evidence, 'target stop request evidence');
  exact(
    evidence,
    [
      'activeRecordDigest',
      'startupReceiptDigest',
      'targetApplicationBindingDigest',
      'targetContainerIdentityDigest',
    ],
    'target stop request evidence',
  );
  if (
    evidence.activeRecordDigest !== active.activeRecordDigest ||
    evidence.startupReceiptDigest !== active.startupReceiptDigest ||
    evidence.targetApplicationBindingDigest !==
      active.targetApplicationBindingDigest ||
    evidence.targetContainerIdentityDigest !==
      active.targetContainerIdentityDigest
  ) {
    configurationError('target stop request evidence drifted');
  }
}

export function targetStoppedEvidence(
  active: Readonly<TargetStopActiveEvidence>,
  reconciliation: Readonly<TargetDataReconciliationEvidence>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    activeRecordDigest: active.activeRecordDigest,
    startupReceiptDigest: active.startupReceiptDigest,
    targetApplicationBindingDigest: active.targetApplicationBindingDigest,
    targetContainerIdentityDigest: active.targetContainerIdentityDigest,
    reconciliation,
  });
}

export function verifyTargetStoppedEvidence(
  record: Readonly<TargetRunJournalRecord>,
  active: Readonly<TargetStopActiveEvidence>,
): Readonly<TargetDataReconciliationEvidence> {
  const evidence = object(record.evidence, 'target stopped evidence');
  exact(
    evidence,
    [
      'activeRecordDigest',
      'reconciliation',
      'startupReceiptDigest',
      'targetApplicationBindingDigest',
      'targetContainerIdentityDigest',
    ],
    'target stopped evidence',
  );
  if (
    evidence.activeRecordDigest !== active.activeRecordDigest ||
    evidence.startupReceiptDigest !== active.startupReceiptDigest ||
    evidence.targetApplicationBindingDigest !==
      active.targetApplicationBindingDigest ||
    evidence.targetContainerIdentityDigest !==
      active.targetContainerIdentityDigest
  ) {
    configurationError('target stopped evidence drifted');
  }
  return verifyTargetDataReconciliationEvidence(evidence.reconciliation);
}
