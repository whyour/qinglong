import { createHash, createPublicKey } from 'node:crypto';

import {
  MAX_PLUGIN_PACKAGE_PUBLISHER_KEYS,
  PluginPackagePublisherTrustRegistry,
  type PluginPackagePublisherKeyDefinition,
} from '../pluginPackageBundle';

export const PLUGIN_PACKAGE_PUBLISHER_TRUST_SNAPSHOT_SCHEMA =
  'qinglong/plugin-package-publisher-trust-snapshot@v1' as const;
export const PLUGIN_PACKAGE_PUBLISHER_TRUST_HEAD_SCHEMA =
  'qinglong/plugin-package-publisher-trust-head@v1' as const;

export interface PluginPackagePublisherTrustSnapshotKey {
  readonly publisher: string;
  readonly keyId: string;
  readonly publicKeyDigest: string;
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
}

export interface PluginPackagePublisherTrustSnapshot {
  readonly schema: typeof PLUGIN_PACKAGE_PUBLISHER_TRUST_SNAPSHOT_SCHEMA;
  readonly keys: readonly Readonly<PluginPackagePublisherTrustSnapshotKey>[];
  readonly snapshotDigest: string;
}

export interface PluginPackagePublisherTrustKeyRef {
  readonly publisher: string;
  readonly keyId: string;
}

export interface PluginPackagePublisherTrustHead {
  readonly schema: typeof PLUGIN_PACKAGE_PUBLISHER_TRUST_HEAD_SCHEMA;
  readonly authorityId: string;
  readonly generation: number;
  readonly baseSnapshotDigest: string;
  readonly effectiveTrustDigest: string;
  readonly updatedAtMs: number;
  readonly headDigest: string;
}

export interface PluginPackagePublisherTrustAuthorityState {
  readonly head: Readonly<PluginPackagePublisherTrustHead>;
  readonly effectiveSnapshot: Readonly<PluginPackagePublisherTrustSnapshot>;
}

export interface ObservePluginPackagePublisherTrustSnapshotInput {
  readonly authorityId: string;
  readonly snapshot: PluginPackagePublisherTrustSnapshot;
  readonly observedBy: string;
  readonly observedAtMs: number;
}

export interface ObservePluginPackagePublisherTrustSnapshotResult
  extends PluginPackagePublisherTrustAuthorityState {
  readonly status: 'created' | 'existing' | 'candidate';
}

export interface PluginPackagePublisherTrustAuthorityRepository {
  findAuthority(
    authorityId: string,
  ): Promise<Readonly<PluginPackagePublisherTrustAuthorityState> | null>;
  observeSnapshot(
    input: ObservePluginPackagePublisherTrustSnapshotInput,
  ): Promise<Readonly<ObservePluginPackagePublisherTrustSnapshotResult>>;
}

export class InvalidPluginPackagePublisherTrustSnapshotError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_PUBLISHER_TRUST_SNAPSHOT_INVALID';

  constructor(message: string) {
    super(`Plugin Package publisher trust snapshot is invalid: ${message}`);
    this.name = 'InvalidPluginPackagePublisherTrustSnapshotError';
  }
}

export class PluginPackagePublisherTrustAuthorityConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PUBLISHER_TRUST_AUTHORITY_CONFLICT';

  constructor() {
    super(
      'Plugin Package publisher trust snapshot conflicts with durable authority',
    );
    this.name = 'PluginPackagePublisherTrustAuthorityConflictError';
  }
}

export class PluginPackagePublisherTrustAuthorityUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PUBLISHER_TRUST_AUTHORITY_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package publisher trust authority is unavailable', options);
    this.name = 'PluginPackagePublisherTrustAuthorityUnavailableError';
  }
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PUBLISHER_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const TRUST_DIGEST_DOMAIN =
  'qinglong/plugin-package-publisher-trust-keyset-digest@v1\0';
const TRUST_HEAD_DIGEST_DOMAIN =
  'qinglong/plugin-package-publisher-trust-head-digest@v1\0';

function invalid(message: string): never {
  throw new InvalidPluginPackagePublisherTrustSnapshotError(message);
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
  }
  const actual = Reflect.ownKeys(value);
  const expected = [...keys].sort();
  if (
    actual.some((key) => typeof key !== 'string') ||
    actual.length !== expected.length ||
    actual
      .map(String)
      .sort()
      .some((key, index) => key !== expected[index])
  ) {
    return invalid(`${label} shape is invalid`);
  }
  return value as Record<string, unknown>;
}

function publisher(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 253 ||
    !PUBLISHER_PATTERN.test(value)
  ) {
    return invalid('publisher is invalid');
  }
  return value;
}

function keyId(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    return invalid('keyId is invalid');
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function compareKeys(
  left: Readonly<PluginPackagePublisherTrustSnapshotKey>,
  right: Readonly<PluginPackagePublisherTrustSnapshotKey>,
): number {
  return (
    Buffer.compare(
      Buffer.from(left.publisher, 'utf8'),
      Buffer.from(right.publisher, 'utf8'),
    ) ||
    Buffer.compare(
      Buffer.from(left.keyId, 'utf8'),
      Buffer.from(right.keyId, 'utf8'),
    )
  );
}

function normalizeKey(
  value: PluginPackagePublisherTrustSnapshotKey,
): Readonly<PluginPackagePublisherTrustSnapshotKey> {
  exactObject(
    value,
    [
      'publisher',
      'keyId',
      'publicKeyDigest',
      'notBeforeMs',
      'notAfterMs',
    ],
    'snapshot key',
  );
  const notBeforeMs = timestamp(value.notBeforeMs, 'notBeforeMs');
  const notAfterMs = timestamp(value.notAfterMs, 'notAfterMs');
  if (notAfterMs <= notBeforeMs) {
    return invalid('key lifetime is invalid');
  }
  return Object.freeze({
    publisher: publisher(value.publisher),
    keyId: keyId(value.keyId),
    publicKeyDigest: digest(value.publicKeyDigest, 'publicKeyDigest'),
    notBeforeMs,
    notAfterMs,
  });
}

export function pluginPackagePublisherTrustKeysetDigest(
  keysValue: readonly Readonly<PluginPackagePublisherTrustSnapshotKey>[],
): string {
  if (
    !Array.isArray(keysValue) ||
    Object.keys(keysValue).some((key, index) => key !== String(index))
  ) {
    return invalid('keyset is invalid');
  }
  const keys = keysValue.map(normalizeKey);
  if (
    keys.some(
      (key, index) => index > 0 && compareKeys(keys[index - 1]!, key) >= 0,
    )
  ) {
    return invalid('keyset must be unique and sorted');
  }
  return createHash('sha256')
    .update(TRUST_DIGEST_DOMAIN)
    .update(JSON.stringify(keys))
    .digest('hex');
}

export function normalizePluginPackagePublisherTrustSnapshot(
  value: PluginPackagePublisherTrustSnapshot,
): Readonly<PluginPackagePublisherTrustSnapshot> {
  exactObject(value, ['schema', 'keys', 'snapshotDigest'], 'snapshot');
  if (
    value.schema !== PLUGIN_PACKAGE_PUBLISHER_TRUST_SNAPSHOT_SCHEMA ||
    !Array.isArray(value.keys) ||
    value.keys.length > MAX_PLUGIN_PACKAGE_PUBLISHER_KEYS ||
    Object.keys(value.keys).some((key, index) => key !== String(index))
  ) {
    return invalid('snapshot schema or keys are invalid');
  }
  const keys = Object.freeze(value.keys.map(normalizeKey));
  const snapshotDigest = pluginPackagePublisherTrustKeysetDigest(keys);
  if (value.snapshotDigest !== snapshotDigest) {
    return invalid('snapshotDigest does not match keys');
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_PUBLISHER_TRUST_SNAPSHOT_SCHEMA,
    keys,
    snapshotDigest,
  });
}

export function createPluginPackagePublisherTrustSnapshot(
  definitions: readonly Readonly<PluginPackagePublisherKeyDefinition>[],
): Readonly<PluginPackagePublisherTrustSnapshot> {
  try {
    new PluginPackagePublisherTrustRegistry(definitions);
  } catch {
    return invalid('publisher key definitions are invalid');
  }
  const keys = Object.freeze(
    definitions
      .map((definition) => {
        let publicKeyDigest: string;
        try {
          publicKeyDigest = createHash('sha256')
            .update(
              createPublicKey(definition.publicKeyPem).export({
                type: 'spki',
                format: 'der',
              }),
            )
            .digest('hex');
        } catch {
          return invalid('publisher public key is invalid');
        }
        return normalizeKey({
          publisher: definition.publisher,
          keyId: definition.keyId,
          publicKeyDigest,
          notBeforeMs: definition.notBeforeMs,
          notAfterMs: definition.notAfterMs,
        });
      })
      .sort(compareKeys),
  );
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_PUBLISHER_TRUST_SNAPSHOT_SCHEMA,
    keys,
  });
  return normalizePluginPackagePublisherTrustSnapshot({
    ...unsigned,
    snapshotDigest: pluginPackagePublisherTrustKeysetDigest(keys),
  });
}

/**
 * Treats the mounted document as public-key material only and lets the durable
 * effective snapshot decide which identities are trusted. Extra candidate
 * keys in the document are deliberately excluded.
 */
export function createPluginPackagePublisherEffectiveTrustRegistry(
  definitions: readonly Readonly<PluginPackagePublisherKeyDefinition>[],
  effectiveSnapshotValue: PluginPackagePublisherTrustSnapshot,
): PluginPackagePublisherTrustRegistry {
  const materialSnapshot =
    createPluginPackagePublisherTrustSnapshot(definitions);
  const effectiveSnapshot =
    normalizePluginPackagePublisherTrustSnapshot(effectiveSnapshotValue);
  const definitionsByIdentity = new Map(
    definitions.map((definition) => [
      `${definition.publisher}\0${definition.keyId}`,
      definition,
    ]),
  );
  const materialKeys = new Map(
    materialSnapshot.keys.map((key) => [
      `${key.publisher}\0${key.keyId}`,
      Object.freeze({
        key,
        definition: definitionsByIdentity.get(
          `${key.publisher}\0${key.keyId}`,
        ),
      }),
    ]),
  );
  const selected: PluginPackagePublisherKeyDefinition[] = [];
  for (const effectiveKey of effectiveSnapshot.keys) {
    const material = materialKeys.get(
      `${effectiveKey.publisher}\0${effectiveKey.keyId}`,
    );
    if (
      !material ||
      JSON.stringify(material.key) !== JSON.stringify(effectiveKey) ||
      !material.definition
    ) {
      return invalid(
        'effective trust snapshot is not backed by mounted key material',
      );
    }
    selected.push({ ...material.definition });
  }
  if (selected.length < 1) {
    return invalid('effective trust snapshot must contain one key');
  }
  return new PluginPackagePublisherTrustRegistry(selected);
}

function trustSnapshotFromKeys(
  keys: readonly Readonly<PluginPackagePublisherTrustSnapshotKey>[],
): Readonly<PluginPackagePublisherTrustSnapshot> {
  const canonical = Object.freeze([...keys].sort(compareKeys));
  return normalizePluginPackagePublisherTrustSnapshot({
    schema: PLUGIN_PACKAGE_PUBLISHER_TRUST_SNAPSHOT_SCHEMA,
    keys: canonical,
    snapshotDigest: pluginPackagePublisherTrustKeysetDigest(canonical),
  });
}

export function createPluginPackagePublisherTrustOverlapAdditionSnapshot(
  currentValue: PluginPackagePublisherTrustSnapshot,
  candidateValue: PluginPackagePublisherTrustSnapshot,
  publisherValue: string,
  keyIdValue: string,
  observedAtMsValue: number,
): Readonly<PluginPackagePublisherTrustSnapshot> {
  const current =
    normalizePluginPackagePublisherTrustSnapshot(currentValue);
  const candidate =
    normalizePluginPackagePublisherTrustSnapshot(candidateValue);
  const targetPublisher = publisher(publisherValue);
  const targetKeyId = keyId(keyIdValue);
  const observedAtMs = timestamp(observedAtMsValue, 'observedAtMs');
  const currentKeys = new Map(
    current.keys.map((key) => [`${key.publisher}\0${key.keyId}`, key]),
  );
  const added = candidate.keys.filter(
    (key) => !currentKeys.has(`${key.publisher}\0${key.keyId}`),
  );
  if (
    candidate.keys.length !== current.keys.length + 1 ||
    current.keys.some((key) => {
      const next = candidate.keys.find(
        (candidateKey) =>
          candidateKey.publisher === key.publisher &&
          candidateKey.keyId === key.keyId,
      );
      return !next || JSON.stringify(next) !== JSON.stringify(key);
    }) ||
    added.length !== 1 ||
    added[0]!.publisher !== targetPublisher ||
    added[0]!.keyId !== targetKeyId ||
    added[0]!.notBeforeMs > observedAtMs ||
    observedAtMs >= added[0]!.notAfterMs
  ) {
    return invalid(
      'overlap addition must preserve every key and add one active target',
    );
  }
  return candidate;
}

export function createPluginPackagePublisherTrustRetirementSnapshot(
  currentValue: PluginPackagePublisherTrustSnapshot,
  publisherValue: string,
  keyIdValue: string,
  observedAtMsValue: number,
): Readonly<PluginPackagePublisherTrustSnapshot> {
  const current =
    normalizePluginPackagePublisherTrustSnapshot(currentValue);
  const targetPublisher = publisher(publisherValue);
  const targetKeyId = keyId(keyIdValue);
  const observedAtMs = timestamp(observedAtMsValue, 'observedAtMs');
  const remaining = current.keys.filter(
    (key) =>
      key.publisher !== targetPublisher || key.keyId !== targetKeyId,
  );
  if (
    remaining.length !== current.keys.length - 1 ||
    !remaining.some(
      (key) =>
        key.publisher === targetPublisher &&
        key.notBeforeMs <= observedAtMs &&
        observedAtMs < key.notAfterMs,
    )
  ) {
    return invalid(
      'retirement must remove one target and retain an active publisher key',
    );
  }
  return trustSnapshotFromKeys(remaining);
}

export function createPluginPackagePublisherEffectiveTrustSnapshot(
  snapshotValue: PluginPackagePublisherTrustSnapshot,
  revokedValue: readonly Readonly<PluginPackagePublisherTrustKeyRef>[],
): Readonly<PluginPackagePublisherTrustSnapshot> {
  const snapshot =
    normalizePluginPackagePublisherTrustSnapshot(snapshotValue);
  if (
    !Array.isArray(revokedValue) ||
    Object.keys(revokedValue).some((key, index) => key !== String(index))
  ) {
    return invalid('revoked key references are invalid');
  }
  const revoked = new Set<string>();
  for (const value of revokedValue) {
    exactObject(value, ['publisher', 'keyId'], 'revoked key reference');
    const identity = `${publisher(value.publisher)}\0${keyId(value.keyId)}`;
    if (revoked.has(identity)) {
      return invalid('revoked key references must be unique');
    }
    revoked.add(identity);
  }
  const keys = Object.freeze(
    snapshot.keys.filter(
      (key) => !revoked.has(`${key.publisher}\0${key.keyId}`),
    ),
  );
  return normalizePluginPackagePublisherTrustSnapshot({
    schema: PLUGIN_PACKAGE_PUBLISHER_TRUST_SNAPSHOT_SCHEMA,
    keys,
    snapshotDigest: pluginPackagePublisherTrustKeysetDigest(keys),
  });
}

function trustHeadDigest(
  value: Omit<PluginPackagePublisherTrustHead, 'headDigest'>,
): string {
  return createHash('sha256')
    .update(TRUST_HEAD_DIGEST_DOMAIN)
    .update(JSON.stringify(value))
    .digest('hex');
}

export function normalizePluginPackagePublisherTrustHead(
  value: PluginPackagePublisherTrustHead,
): Readonly<PluginPackagePublisherTrustHead> {
  exactObject(
    value,
    [
      'schema',
      'authorityId',
      'generation',
      'baseSnapshotDigest',
      'effectiveTrustDigest',
      'updatedAtMs',
      'headDigest',
    ],
    'trust head',
  );
  if (value.schema !== PLUGIN_PACKAGE_PUBLISHER_TRUST_HEAD_SCHEMA) {
    return invalid('trust head schema is invalid');
  }
  const normalized = Object.freeze({
    schema: PLUGIN_PACKAGE_PUBLISHER_TRUST_HEAD_SCHEMA,
    authorityId: keyId(value.authorityId),
    generation: positiveInteger(value.generation, 'generation'),
    baseSnapshotDigest: digest(
      value.baseSnapshotDigest,
      'baseSnapshotDigest',
    ),
    effectiveTrustDigest: digest(
      value.effectiveTrustDigest,
      'effectiveTrustDigest',
    ),
    updatedAtMs: timestamp(value.updatedAtMs, 'updatedAtMs'),
  });
  const headDigest = trustHeadDigest(normalized);
  if (value.headDigest !== headDigest) {
    return invalid('headDigest does not match trust head');
  }
  return Object.freeze({ ...normalized, headDigest });
}

export function createPluginPackagePublisherTrustHead(
  authorityIdValue: string,
  snapshotValue: PluginPackagePublisherTrustSnapshot,
  updatedAtMsValue: number,
): Readonly<PluginPackagePublisherTrustHead> {
  const snapshot =
    normalizePluginPackagePublisherTrustSnapshot(snapshotValue);
  if (snapshot.keys.length < 1) {
    return invalid('base trust snapshot must contain one key');
  }
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_PUBLISHER_TRUST_HEAD_SCHEMA,
    authorityId: keyId(authorityIdValue),
    generation: 1,
    baseSnapshotDigest: snapshot.snapshotDigest,
    effectiveTrustDigest: snapshot.snapshotDigest,
    updatedAtMs: timestamp(updatedAtMsValue, 'updatedAtMs'),
  });
  return normalizePluginPackagePublisherTrustHead({
    ...unsigned,
    headDigest: trustHeadDigest(unsigned),
  });
}

export function advancePluginPackagePublisherTrustHead(
  headValue: PluginPackagePublisherTrustHead,
  effectiveSnapshotValue: PluginPackagePublisherTrustSnapshot,
  updatedAtMsValue: number,
): Readonly<PluginPackagePublisherTrustHead> {
  const head = normalizePluginPackagePublisherTrustHead(headValue);
  const effectiveSnapshot =
    normalizePluginPackagePublisherTrustSnapshot(effectiveSnapshotValue);
  const updatedAtMs = timestamp(updatedAtMsValue, 'updatedAtMs');
  if (
    effectiveSnapshot.snapshotDigest === head.effectiveTrustDigest ||
    updatedAtMs < head.updatedAtMs ||
    head.generation >= 2_147_483_647
  ) {
    return invalid('trust head transition is invalid');
  }
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_PUBLISHER_TRUST_HEAD_SCHEMA,
    authorityId: head.authorityId,
    generation: head.generation + 1,
    baseSnapshotDigest: head.baseSnapshotDigest,
    effectiveTrustDigest: effectiveSnapshot.snapshotDigest,
    updatedAtMs,
  });
  return normalizePluginPackagePublisherTrustHead({
    ...unsigned,
    headDigest: trustHeadDigest(unsigned),
  });
}

export function pluginPackagePublisherTrustRevokedDigest(
  snapshotValue: PluginPackagePublisherTrustSnapshot,
  publisherValue: string,
  keyIdValue: string,
): string {
  const snapshot =
    normalizePluginPackagePublisherTrustSnapshot(snapshotValue);
  const targetPublisher = publisher(publisherValue);
  const targetKeyId = keyId(keyIdValue);
  const remaining = snapshot.keys.filter(
    (key) =>
      key.publisher !== targetPublisher || key.keyId !== targetKeyId,
  );
  if (remaining.length === snapshot.keys.length) {
    return invalid('revoked key is absent from the trust snapshot');
  }
  return pluginPackagePublisherTrustKeysetDigest(remaining);
}
