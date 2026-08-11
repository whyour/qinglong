import { LocalDeploymentConfigurationError } from '../../foundation/contract';
import {
  cutoverDigest,
  type LegacySilenceEvidence,
  type TargetApplicationBinding,
  type TargetContainerEvidence,
} from '../targetEvidence';
import type { LocalDeploymentTargetRunCommand } from './targetRunContract';
import type { TargetRunJournalRecord } from './targetRunJournal';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface TargetRunRecordEvidenceContext {
  readonly command: Readonly<LocalDeploymentTargetRunCommand>;
  readonly commitment: Readonly<LegacySilenceEvidence>;
  readonly application: Readonly<TargetApplicationBinding>;
}

export interface VerifiedTargetRequestEvidence {
  readonly targetContainerIdentityDigest: string;
  readonly targetApplicationBindingDigest: string;
  readonly previousStartupReceiptDigest: string | null;
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

export function targetRequestEvidence(
  context: Readonly<TargetRunRecordEvidenceContext>,
  target: Readonly<TargetContainerEvidence>,
  previousStartupReceiptDigest: string | null,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    kind:
      context.command.request.generation === 1
        ? 'target_start'
        : 'target_restart',
    legacyCommitmentDigest: context.commitment.commitmentDigest,
    targetContainerId: context.command.request.expectedTargetContainerId,
    targetContainerIdentityDigest: target.identityDigest,
    targetApplicationBindingDigest: target.applicationBindingDigest,
    targetImageDigest: cutoverDigest(
      context.command.request.expectedTargetImage,
    ),
    applicationConfigDigest: context.application.configDigest,
    previousStartupReceiptDigest,
  });
}

export function verifyTargetRequestEvidence(
  context: Readonly<TargetRunRecordEvidenceContext>,
  record: Readonly<TargetRunJournalRecord>,
): Readonly<VerifiedTargetRequestEvidence> {
  const evidence = object(record.evidence, 'target request evidence');
  exact(
    evidence,
    [
      'applicationConfigDigest',
      'kind',
      'legacyCommitmentDigest',
      'previousStartupReceiptDigest',
      'targetApplicationBindingDigest',
      'targetContainerId',
      'targetContainerIdentityDigest',
      'targetImageDigest',
    ],
    'target request evidence',
  );
  if (
    evidence.kind !==
      (context.command.request.generation === 1
        ? 'target_start'
        : 'target_restart') ||
    evidence.legacyCommitmentDigest !== context.commitment.commitmentDigest ||
    evidence.targetContainerId !==
      context.command.request.expectedTargetContainerId ||
    evidence.targetImageDigest !==
      cutoverDigest(context.command.request.expectedTargetImage) ||
    evidence.applicationConfigDigest !== context.application.configDigest ||
    typeof evidence.targetContainerIdentityDigest !== 'string' ||
    !DIGEST_PATTERN.test(evidence.targetContainerIdentityDigest) ||
    typeof evidence.targetApplicationBindingDigest !== 'string' ||
    !DIGEST_PATTERN.test(evidence.targetApplicationBindingDigest) ||
    (evidence.previousStartupReceiptDigest !== null &&
      (typeof evidence.previousStartupReceiptDigest !== 'string' ||
        !DIGEST_PATTERN.test(evidence.previousStartupReceiptDigest)))
  ) {
    configurationError('target request evidence drifted');
  }
  return Object.freeze({
    targetContainerIdentityDigest:
      evidence.targetContainerIdentityDigest as string,
    targetApplicationBindingDigest:
      evidence.targetApplicationBindingDigest as string,
    previousStartupReceiptDigest: evidence.previousStartupReceiptDigest as
      | string
      | null,
  });
}

export function targetActiveEvidence(
  context: Readonly<TargetRunRecordEvidenceContext>,
  target: Readonly<TargetContainerEvidence>,
  startupReceiptDigest: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    legacyCommitmentDigest: context.commitment.commitmentDigest,
    targetContainerIdentityDigest: target.identityDigest,
    targetApplicationBindingDigest: target.applicationBindingDigest,
    startupReceiptDigest,
  });
}

export function verifyTargetActiveEvidence(
  context: Readonly<TargetRunRecordEvidenceContext>,
  record: Readonly<TargetRunJournalRecord>,
  request: Readonly<VerifiedTargetRequestEvidence>,
): string {
  const evidence = object(record.evidence, 'target active evidence');
  exact(
    evidence,
    [
      'legacyCommitmentDigest',
      'startupReceiptDigest',
      'targetApplicationBindingDigest',
      'targetContainerIdentityDigest',
    ],
    'target active evidence',
  );
  if (
    evidence.legacyCommitmentDigest !== context.commitment.commitmentDigest ||
    evidence.targetContainerIdentityDigest !==
      request.targetContainerIdentityDigest ||
    evidence.targetApplicationBindingDigest !==
      request.targetApplicationBindingDigest ||
    typeof evidence.startupReceiptDigest !== 'string' ||
    !DIGEST_PATTERN.test(evidence.startupReceiptDigest) ||
    evidence.startupReceiptDigest === request.previousStartupReceiptDigest
  ) {
    configurationError('target active evidence drifted');
  }
  return evidence.startupReceiptDigest;
}
