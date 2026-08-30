import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { LocalDeploymentConfigurationError } from '../foundation/contract';
import { cutoverDigest } from './targetEvidence';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface AdoptedTargetBaseline {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-local-adopted-target-baseline';
  readonly state: 'prepared';
  readonly preparedAtMs: number;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly cutoverId: string;
  readonly activationDigest: string;
  readonly commitmentDigest: string;
  readonly applicationConfigDigest: string;
  readonly legacyDataApplicationCommitDigest: string;
  readonly legacyDataApplicationReceiptDigest: string;
  readonly targetPathDigest: string;
  readonly targetDevice: string;
  readonly targetInode: string;
  readonly targetSha256: string;
  readonly targetSidecarsClear: true;
  readonly baselineDigest: string;
}

export interface AdoptedTargetBaselineInput {
  readonly preparedAtMs: number;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly cutoverId: string;
  readonly activationDigest: string;
  readonly commitmentDigest: string;
  readonly applicationConfigDigest: string;
  readonly legacyDataApplicationCommitDigest: string;
  readonly legacyDataApplicationReceiptDigest: string;
  readonly targetPathDigest: string;
  readonly targetDevice: string;
  readonly targetInode: string;
  readonly targetSha256: string;
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(message);
}

function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    configurationError('adopted target baseline must be an object');
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    configurationError('adopted target baseline shape is invalid');
  }
}

export function adoptedTargetBaselinePath(deploymentRoot: string): string {
  return path.join(deploymentRoot, 'service', 'adopted-target-baseline.json');
}

export function createAdoptedTargetBaseline(
  input: Readonly<AdoptedTargetBaselineInput>,
): Readonly<AdoptedTargetBaseline> {
  const payload = {
    schemaVersion: 1 as const,
    kind: 'qinglong3-local-adopted-target-baseline' as const,
    state: 'prepared' as const,
    preparedAtMs: input.preparedAtMs,
    profile: input.profile,
    instanceId: input.instanceId,
    cutoverId: input.cutoverId,
    activationDigest: input.activationDigest,
    commitmentDigest: input.commitmentDigest,
    applicationConfigDigest: input.applicationConfigDigest,
    legacyDataApplicationCommitDigest: input.legacyDataApplicationCommitDigest,
    legacyDataApplicationReceiptDigest:
      input.legacyDataApplicationReceiptDigest,
    targetPathDigest: input.targetPathDigest,
    targetDevice: input.targetDevice,
    targetInode: input.targetInode,
    targetSha256: input.targetSha256,
    targetSidecarsClear: true as const,
  };
  return Object.freeze({
    ...payload,
    baselineDigest: cutoverDigest(payload),
  });
}

export function readAdoptedTargetBaseline(
  filePath: string,
): Readonly<AdoptedTargetBaseline> {
  let baseline: Record<string, unknown>;
  try {
    const stat = fs.lstatSync(filePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(filePath) !== filePath
    ) {
      configurationError('adopted target baseline identity is invalid');
    }
    baseline = object(readPrivateLocalCommandFile(filePath));
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    throw new LocalDeploymentConfigurationError(
      'adopted target baseline cannot be read',
      { cause: error },
    );
  }
  exact(baseline, [
    'activationDigest',
    'applicationConfigDigest',
    'baselineDigest',
    'commitmentDigest',
    'cutoverId',
    'instanceId',
    'kind',
    'legacyDataApplicationCommitDigest',
    'legacyDataApplicationReceiptDigest',
    'preparedAtMs',
    'profile',
    'schemaVersion',
    'state',
    'targetDevice',
    'targetInode',
    'targetPathDigest',
    'targetSha256',
    'targetSidecarsClear',
  ]);
  const { baselineDigest, ...payload } = baseline;
  if (
    baseline.schemaVersion !== 1 ||
    baseline.kind !== 'qinglong3-local-adopted-target-baseline' ||
    baseline.state !== 'prepared' ||
    !Number.isSafeInteger(baseline.preparedAtMs) ||
    (baseline.preparedAtMs as number) < 0 ||
    (baseline.profile !== 'edge' && baseline.profile !== 'standalone') ||
    typeof baseline.instanceId !== 'string' ||
    typeof baseline.cutoverId !== 'string' ||
    typeof baseline.targetDevice !== 'string' ||
    typeof baseline.targetInode !== 'string' ||
    baseline.targetSidecarsClear !== true ||
    [
      baseline.activationDigest,
      baseline.commitmentDigest,
      baseline.applicationConfigDigest,
      baseline.legacyDataApplicationCommitDigest,
      baseline.legacyDataApplicationReceiptDigest,
      baseline.targetPathDigest,
      baseline.targetSha256,
      baselineDigest,
    ].some(
      (value) => typeof value !== 'string' || !DIGEST_PATTERN.test(value),
    ) ||
    cutoverDigest(payload) !== baselineDigest
  ) {
    configurationError('adopted target baseline identity drifted');
  }
  return baseline as unknown as Readonly<AdoptedTargetBaseline>;
}
