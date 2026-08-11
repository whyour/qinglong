import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LocalDeploymentConfigurationError } from '../foundation/contract';
import { publishExactFile } from '../foundation/files';
import type { LocalDeploymentPaths } from '../foundation/render';

const TOMBSTONE_SCHEMA = 'qinglong/local-compose-collected-evidence@v1';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TOMBSTONE_BYTES = 16 * 1024;
const COMPOSE_EVIDENCE_SQLITE_CONTRACT_MIN_VERSION = 40;

export type ComposeEvidenceKind = 'rollout-backup' | 'restore-safeguard';

export interface ComposeSnapshotEvidence {
  readonly contractVersion: number;
  readonly sha256: string;
  readonly bytes: number;
  readonly pageCount: number;
  readonly pageSize: number;
}

export interface ComposeCollectedEvidence {
  readonly schema: typeof TOMBSTONE_SCHEMA;
  readonly kind: ComposeEvidenceKind;
  readonly artifactId: string;
  readonly collectionId: string;
  readonly generation: number;
  readonly profile: 'edge' | 'standalone';
  readonly sourceReceiptDigest: string;
  readonly snapshot: Readonly<ComposeSnapshotEvidence>;
  readonly collectedAtMs: number;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

export function evidenceDigest(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function collectedEvidencePath(
  paths: Readonly<LocalDeploymentPaths>,
  kind: ComposeEvidenceKind,
  artifactId: string,
): string {
  return path.join(
    kind === 'rollout-backup'
      ? paths.composeCollectedRolloutBackups
      : paths.composeCollectedRestoreSafeguards,
    `${artifactId}.json`,
  );
}

export function evidenceStagePath(artifactPath: string): string {
  return path.join(
    path.dirname(artifactPath),
    `.${path.basename(artifactPath)}.ql3-collection-stage`,
  );
}

function canonicalContents(
  evidence: Readonly<ComposeCollectedEvidence>,
): string {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

function validSnapshot(
  value: unknown,
  maximumContractVersion: number,
): value is ComposeSnapshotEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ComposeSnapshotEvidence>;
  return (
    Object.keys(value).sort().join(',') ===
      ['bytes', 'contractVersion', 'pageCount', 'pageSize', 'sha256']
        .sort()
        .join(',') &&
    Number.isSafeInteger(candidate.contractVersion) &&
    (candidate.contractVersion as number) >=
      COMPOSE_EVIDENCE_SQLITE_CONTRACT_MIN_VERSION &&
    (candidate.contractVersion as number) <= maximumContractVersion &&
    typeof candidate.sha256 === 'string' &&
    SHA256_PATTERN.test(candidate.sha256) &&
    Number.isSafeInteger(candidate.bytes) &&
    (candidate.bytes as number) > 0 &&
    Number.isSafeInteger(candidate.pageCount) &&
    (candidate.pageCount as number) > 0 &&
    Number.isSafeInteger(candidate.pageSize) &&
    (candidate.pageSize as number) >= 512 &&
    (candidate.pageSize as number) <= 65_536
  );
}

function exactSnapshot(
  expected: Readonly<ComposeSnapshotEvidence>,
  actual: Readonly<ComposeSnapshotEvidence>,
): boolean {
  return (
    expected.contractVersion === actual.contractVersion &&
    expected.sha256 === actual.sha256 &&
    expected.bytes === actual.bytes &&
    expected.pageCount === actual.pageCount &&
    expected.pageSize === actual.pageSize
  );
}

export function inspectCollectedEvidence(
  paths: Readonly<LocalDeploymentPaths>,
  uid: number,
  maximumContractVersion: number,
  expected: Readonly<{
    kind: ComposeEvidenceKind;
    artifactId: string;
    sourceReceiptDigest: string;
    snapshot: Readonly<ComposeSnapshotEvidence>;
  }>,
): Readonly<ComposeCollectedEvidence> | null {
  if (
    !Number.isSafeInteger(maximumContractVersion) ||
    maximumContractVersion < COMPOSE_EVIDENCE_SQLITE_CONTRACT_MIN_VERSION
  ) {
    configurationError('compose evidence contract boundary is invalid');
  }
  const filePath = collectedEvidencePath(
    paths,
    expected.kind,
    expected.artifactId,
  );
  if (!fs.existsSync(filePath)) return null;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    configurationError('compose collected evidence is unavailable', error);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.nlink !== 1 ||
    stat.size < 2 ||
    stat.size > MAX_TOMBSTONE_BYTES
  ) {
    configurationError('compose collected evidence identity is invalid');
  }
  const contents = fs.readFileSync(filePath, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    configurationError('compose collected evidence is invalid', error);
  }
  const evidence = value as ComposeCollectedEvidence;
  if (
    !evidence ||
    typeof evidence !== 'object' ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(',') !==
      [
        'artifactId',
        'collectedAtMs',
        'collectionId',
        'generation',
        'kind',
        'profile',
        'schema',
        'snapshot',
        'sourceReceiptDigest',
      ]
        .sort()
        .join(',') ||
    evidence.schema !== TOMBSTONE_SCHEMA ||
    evidence.kind !== expected.kind ||
    evidence.artifactId !== expected.artifactId ||
    !UUID_V4_PATTERN.test(evidence.artifactId) ||
    !UUID_V4_PATTERN.test(evidence.collectionId) ||
    !Number.isSafeInteger(evidence.generation) ||
    evidence.generation < 1 ||
    (evidence.profile !== 'edge' && evidence.profile !== 'standalone') ||
    evidence.sourceReceiptDigest !== expected.sourceReceiptDigest ||
    !SHA256_PATTERN.test(evidence.sourceReceiptDigest) ||
    !validSnapshot(evidence.snapshot, maximumContractVersion) ||
    !exactSnapshot(expected.snapshot, evidence.snapshot) ||
    !Number.isSafeInteger(evidence.collectedAtMs) ||
    evidence.collectedAtMs < 0 ||
    contents !== canonicalContents(evidence)
  ) {
    configurationError('compose collected evidence drifted');
  }
  return Object.freeze({
    ...evidence,
    snapshot: Object.freeze({ ...evidence.snapshot }),
  });
}

export function publishCollectedEvidence(
  paths: Readonly<LocalDeploymentPaths>,
  uid: number,
  evidence: Readonly<ComposeCollectedEvidence>,
): void {
  publishExactFile(
    collectedEvidencePath(paths, evidence.kind, evidence.artifactId),
    canonicalContents(evidence),
    0o600,
    uid,
    'compose collected evidence',
  );
}
