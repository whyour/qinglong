import crypto from 'node:crypto';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import type { LocalApplicationProcessConfig } from './processConfig';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;

interface LegacySilenceCommitmentPayload {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-local-legacy-silence-commitment';
  readonly state: 'legacy_stopped';
  readonly cutoverId: string;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly activationDigest: string;
  readonly previousRecordDigest: string;
  readonly requestedAtMs: number;
  readonly observedAtMs: number;
  readonly controller: Readonly<{
    kind: 'docker';
    endpointDigest: string;
    legacyContainerId: string;
    legacyContainerIdentityDigest: string;
    legacySourceBindingDigest: string;
  }>;
}

interface LegacySilenceCommitment extends LegacySilenceCommitmentPayload {
  readonly commitmentDigest: string;
}

export class LocalApplicationCutoverCommitmentError extends TypeError {
  readonly code = 'QL3_LOCAL_APPLICATION_CUTOVER_COMMITMENT_INVALID';

  constructor(message: string) {
    super(`Local application cutover commitment is invalid: ${message}`);
    this.name = 'LocalApplicationCutoverCommitmentError';
  }
}

function invalid(message: string): never {
  throw new LocalApplicationCutoverCommitmentError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function digest(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function parseLegacySilenceCommitment(
  value: unknown,
): Readonly<LegacySilenceCommitment> {
  const commitment = object(value, 'commitment');
  exact(
    commitment,
    [
      'activationDigest',
      'commitmentDigest',
      'controller',
      'cutoverId',
      'instanceId',
      'kind',
      'observedAtMs',
      'previousRecordDigest',
      'profile',
      'requestedAtMs',
      'schemaVersion',
      'state',
    ],
    'commitment',
  );
  const controller = object(commitment.controller, 'controller');
  exact(
    controller,
    [
      'endpointDigest',
      'kind',
      'legacyContainerId',
      'legacyContainerIdentityDigest',
      'legacySourceBindingDigest',
    ],
    'controller',
  );
  if (
    commitment.schemaVersion !== 1 ||
    commitment.kind !== 'qinglong3-local-legacy-silence-commitment' ||
    commitment.state !== 'legacy_stopped' ||
    typeof commitment.cutoverId !== 'string' ||
    !ID_PATTERN.test(commitment.cutoverId) ||
    (commitment.profile !== 'edge' && commitment.profile !== 'standalone') ||
    typeof commitment.instanceId !== 'string' ||
    !ID_PATTERN.test(commitment.instanceId) ||
    typeof commitment.activationDigest !== 'string' ||
    !DIGEST_PATTERN.test(commitment.activationDigest) ||
    typeof commitment.previousRecordDigest !== 'string' ||
    !DIGEST_PATTERN.test(commitment.previousRecordDigest) ||
    !Number.isSafeInteger(commitment.requestedAtMs) ||
    (commitment.requestedAtMs as number) < 0 ||
    !Number.isSafeInteger(commitment.observedAtMs) ||
    (commitment.observedAtMs as number) <
      (commitment.requestedAtMs as number) ||
    controller.kind !== 'docker' ||
    typeof controller.endpointDigest !== 'string' ||
    !DIGEST_PATTERN.test(controller.endpointDigest) ||
    typeof controller.legacyContainerId !== 'string' ||
    !CONTAINER_ID_PATTERN.test(controller.legacyContainerId) ||
    typeof controller.legacyContainerIdentityDigest !== 'string' ||
    !DIGEST_PATTERN.test(controller.legacyContainerIdentityDigest) ||
    typeof controller.legacySourceBindingDigest !== 'string' ||
    !DIGEST_PATTERN.test(controller.legacySourceBindingDigest) ||
    typeof commitment.commitmentDigest !== 'string' ||
    !DIGEST_PATTERN.test(commitment.commitmentDigest)
  ) {
    invalid('commitment fields are invalid');
  }
  const { commitmentDigest, ...payload } = commitment;
  if (digest(payload) !== commitmentDigest) {
    invalid('commitment digest does not match');
  }
  return commitment as unknown as Readonly<LegacySilenceCommitment>;
}

export function verifyLocalApplicationCutoverCommitment(
  config: Readonly<LocalApplicationProcessConfig>,
): void {
  if (config.storage.mode === 'fresh') return;
  if (config.cutover === undefined) {
    invalid('adopted storage requires a v3 cutover commitment');
  }
  const commitment = parseLegacySilenceCommitment(
    readPrivateLocalCommandFile(config.cutover.commitmentPath),
  );
  if (
    commitment.commitmentDigest !==
      config.cutover.expectedCommitmentDigest ||
    commitment.cutoverId !== config.cutover.cutoverId ||
    commitment.profile !== config.profile ||
    commitment.instanceId !== config.instanceId ||
    commitment.activationDigest !== config.storage.expectedActivationDigest
  ) {
    invalid('commitment no longer matches the reviewed application identity');
  }
}
