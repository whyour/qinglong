import { createHash, createHmac } from 'node:crypto';

export const TOOL_RESULT_KEY_CATALOG_SCHEMA =
  'qinglong/tool-result-key-catalog@v1' as const;
export const TOOL_RESULT_KEY_CATALOG_COMMAND_SCHEMA =
  'qinglong/tool-result-key-catalog-command@v1' as const;
export const MAX_TOOL_RESULT_DECRYPTABLE_KEYS = 16;
export const MAX_TOOL_RESULT_CATALOG_KEYS = 64;

export type ToolResultKeyState = 'active' | 'decrypt_only' | 'retired' | 'lost';

export type ToolResultKeyCatalogMutationKind =
  | 'bootstrap'
  | 'rotate'
  | 'retire'
  | 'mark_lost'
  | 'restore';

export interface ToolResultKeyCatalogEntry {
  readonly keyId: string;
  readonly state: ToolResultKeyState;
  readonly materialProof: string;
  readonly introducedGeneration: number;
  readonly stateChangedGeneration: number;
  readonly retirementReceiptDigest: string | null;
}

export interface ToolResultKeyCatalogSnapshot {
  readonly schema: typeof TOOL_RESULT_KEY_CATALOG_SCHEMA;
  readonly generation: number;
  readonly previousCatalogDigest: string | null;
  readonly activeKeyId: string | null;
  readonly keys: readonly Readonly<ToolResultKeyCatalogEntry>[];
  readonly mutationKind: ToolResultKeyCatalogMutationKind;
  readonly mutationId: string;
  readonly catalogDigest: string;
}

export interface ToolResultKeyCatalogRecord
  extends ToolResultKeyCatalogSnapshot {
  readonly committedAtMs: number;
}

export interface ToolResultKeyCatalogFence {
  readonly generation: number;
  readonly catalogDigest: string;
  readonly keyId: string;
  readonly materialProof: string;
}

export interface ToolResultKeyCatalogCommand {
  readonly schema: typeof TOOL_RESULT_KEY_CATALOG_COMMAND_SCHEMA;
  readonly expectedGeneration: number;
  readonly expectedCatalogDigest: string | null;
  readonly next: Readonly<ToolResultKeyCatalogSnapshot>;
  readonly commandDigest: string;
}

export interface CommitToolResultKeyCatalogResult {
  readonly status: 'created' | 'existing';
  readonly catalog: Readonly<ToolResultKeyCatalogRecord>;
}

export interface ToolResultKeyCatalogReader {
  findCurrent(): Promise<Readonly<ToolResultKeyCatalogRecord> | null>;
}

export interface ToolResultKeyCatalogRepository
  extends ToolResultKeyCatalogReader {
  append(
    command: Readonly<ToolResultKeyCatalogCommand>,
  ): Promise<Readonly<CommitToolResultKeyCatalogResult>>;
}

export class InvalidToolResultKeyCatalogError extends TypeError {
  readonly code = 'TOOL_RESULT_KEY_CATALOG_INVALID';

  constructor(message: string) {
    super(`Tool result key catalog is invalid: ${message}`);
    this.name = 'InvalidToolResultKeyCatalogError';
  }
}

export class ToolResultKeyCatalogConflictError extends Error {
  readonly code = 'TOOL_RESULT_KEY_CATALOG_CONFLICT';

  constructor() {
    super('Tool result key catalog conflicts with durable state');
    this.name = 'ToolResultKeyCatalogConflictError';
  }
}

export class ToolResultKeyCatalogUnavailableError extends Error {
  readonly code = 'TOOL_RESULT_KEY_CATALOG_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Tool result key catalog is unavailable', options);
    this.name = 'ToolResultKeyCatalogUnavailableError';
  }
}

export class ToolResultKeyLostError extends Error {
  readonly code = 'TOOL_RESULT_KEY_LOST';
  readonly keyId: string;

  constructor(keyId: string) {
    super('Tool result key material is lost');
    this.name = 'ToolResultKeyLostError';
    this.keyId = keyId;
  }
}

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CATALOG_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-result-key-catalog-digest@v1\0',
  'utf8',
);
const COMMAND_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-result-key-catalog-command-digest@v1\0',
  'utf8',
);
const MATERIAL_PROOF_DOMAIN = Buffer.from(
  'qinglong/tool-result-key-material-proof@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidToolResultKeyCatalogError(message);
}

function hash(domain: Uint8Array, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalid(`${label} is not a plain object`);
  }
  return value as Record<string, unknown>;
}

function keyId(value: unknown): string {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) {
    return invalid('key id is invalid');
  }
  return value;
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function nullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : digest(value, label);
}

function generation(value: unknown, minimum = 1): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > 2_147_483_647
  ) {
    return invalid('generation is invalid');
  }
  return value as number;
}

function state(value: unknown): ToolResultKeyState {
  if (
    value !== 'active' &&
    value !== 'decrypt_only' &&
    value !== 'retired' &&
    value !== 'lost'
  ) {
    return invalid('key state is invalid');
  }
  return value;
}

function mutationKind(value: unknown): ToolResultKeyCatalogMutationKind {
  if (
    value !== 'bootstrap' &&
    value !== 'rotate' &&
    value !== 'retire' &&
    value !== 'mark_lost' &&
    value !== 'restore'
  ) {
    return invalid('mutation kind is invalid');
  }
  return value;
}

function normalizedEntry(
  value: ToolResultKeyCatalogEntry,
  catalogGeneration: number,
): Readonly<ToolResultKeyCatalogEntry> {
  const candidate = record(value, 'catalog key');
  exactKeys(
    candidate,
    [
      'introducedGeneration',
      'keyId',
      'materialProof',
      'retirementReceiptDigest',
      'state',
      'stateChangedGeneration',
    ],
    'catalog key',
  );
  const normalizedState = state(value.state);
  const introducedGeneration = generation(value.introducedGeneration);
  const stateChangedGeneration = generation(value.stateChangedGeneration);
  if (
    introducedGeneration > stateChangedGeneration ||
    stateChangedGeneration > catalogGeneration
  ) {
    return invalid('key generation fence is invalid');
  }
  const retirementReceiptDigest = nullableDigest(
    value.retirementReceiptDigest,
    'retirement receipt digest',
  );
  if ((normalizedState === 'retired') !== (retirementReceiptDigest !== null)) {
    return invalid('retired key receipt is invalid');
  }
  return Object.freeze({
    keyId: keyId(value.keyId),
    state: normalizedState,
    materialProof: digest(value.materialProof, 'material proof'),
    introducedGeneration,
    stateChangedGeneration,
    retirementReceiptDigest,
  });
}

function unsignedSnapshot(
  value: Omit<ToolResultKeyCatalogSnapshot, 'catalogDigest'>,
): Omit<ToolResultKeyCatalogSnapshot, 'catalogDigest'> {
  return Object.freeze(value);
}

export function normalizeToolResultKeyCatalogSnapshot(
  value: ToolResultKeyCatalogSnapshot,
): Readonly<ToolResultKeyCatalogSnapshot> {
  const candidate = record(value, 'catalog snapshot');
  exactKeys(
    candidate,
    [
      'activeKeyId',
      'catalogDigest',
      'generation',
      'keys',
      'mutationId',
      'mutationKind',
      'previousCatalogDigest',
      'schema',
    ],
    'catalog snapshot',
  );
  if (
    value.schema !== TOOL_RESULT_KEY_CATALOG_SCHEMA ||
    !Array.isArray(value.keys) ||
    value.keys.length < 1 ||
    value.keys.length > MAX_TOOL_RESULT_CATALOG_KEYS
  ) {
    return invalid('catalog snapshot header is invalid');
  }
  const normalizedGeneration = generation(value.generation);
  const keys = value.keys
    .map((entry) => normalizedEntry(entry, normalizedGeneration))
    .sort((left, right) => left.keyId.localeCompare(right.keyId));
  if (
    keys.some(
      (entry, index) => index > 0 && entry.keyId === keys[index - 1]!.keyId,
    )
  ) {
    return invalid('catalog key id is duplicated');
  }
  const decryptable = keys.filter(
    (entry) => entry.state === 'active' || entry.state === 'decrypt_only',
  );
  if (decryptable.length > MAX_TOOL_RESULT_DECRYPTABLE_KEYS) {
    return invalid('decryptable key budget is exceeded');
  }
  const active = keys.filter((entry) => entry.state === 'active');
  const activeKeyId =
    value.activeKeyId === null ? null : keyId(value.activeKeyId);
  if (
    active.length > 1 ||
    (activeKeyId === null && active.length !== 0) ||
    (activeKeyId !== null &&
      (active.length !== 1 || active[0]!.keyId !== activeKeyId))
  ) {
    return invalid('active key projection is invalid');
  }
  const previousCatalogDigest = nullableDigest(
    value.previousCatalogDigest,
    'previous catalog digest',
  );
  if ((normalizedGeneration === 1) !== (previousCatalogDigest === null)) {
    return invalid('previous catalog digest fence is invalid');
  }
  const unsigned = unsignedSnapshot({
    schema: TOOL_RESULT_KEY_CATALOG_SCHEMA,
    generation: normalizedGeneration,
    previousCatalogDigest,
    activeKeyId,
    keys: Object.freeze(keys),
    mutationKind: mutationKind(value.mutationKind),
    mutationId: identity(value.mutationId, 'mutation id'),
  });
  const catalogDigest = digest(value.catalogDigest, 'catalog digest');
  if (hash(CATALOG_DIGEST_DOMAIN, unsigned) !== catalogDigest) {
    return invalid('catalog digest does not match');
  }
  return Object.freeze({ ...unsigned, catalogDigest });
}

export function normalizeToolResultKeyCatalogRecord(
  value: ToolResultKeyCatalogRecord,
): Readonly<ToolResultKeyCatalogRecord> {
  const candidate = record(value, 'catalog record');
  exactKeys(
    candidate,
    [
      'activeKeyId',
      'catalogDigest',
      'committedAtMs',
      'generation',
      'keys',
      'mutationId',
      'mutationKind',
      'previousCatalogDigest',
      'schema',
    ],
    'catalog record',
  );
  if (!Number.isSafeInteger(value.committedAtMs) || value.committedAtMs < 0) {
    return invalid('commit time is invalid');
  }
  const snapshot = normalizeToolResultKeyCatalogSnapshot({
    schema: value.schema,
    generation: value.generation,
    previousCatalogDigest: value.previousCatalogDigest,
    activeKeyId: value.activeKeyId,
    keys: value.keys,
    mutationKind: value.mutationKind,
    mutationId: value.mutationId,
    catalogDigest: value.catalogDigest,
  });
  return Object.freeze({ ...snapshot, committedAtMs: value.committedAtMs });
}

export function normalizeToolResultKeyCatalogFence(
  value: ToolResultKeyCatalogFence,
): Readonly<ToolResultKeyCatalogFence> {
  const candidate = record(value, 'catalog fence');
  exactKeys(
    candidate,
    ['catalogDigest', 'generation', 'keyId', 'materialProof'],
    'catalog fence',
  );
  return Object.freeze({
    generation: generation(value.generation),
    catalogDigest: digest(value.catalogDigest, 'catalog digest'),
    keyId: keyId(value.keyId),
    materialProof: digest(value.materialProof, 'material proof'),
  });
}

function snapshot(
  input: Omit<ToolResultKeyCatalogSnapshot, 'catalogDigest' | 'schema'>,
): Readonly<ToolResultKeyCatalogSnapshot> {
  const unsigned = unsignedSnapshot({
    schema: TOOL_RESULT_KEY_CATALOG_SCHEMA,
    ...input,
    keys: Object.freeze(
      [...input.keys].sort((left, right) =>
        left.keyId.localeCompare(right.keyId),
      ),
    ),
  });
  return normalizeToolResultKeyCatalogSnapshot({
    ...unsigned,
    catalogDigest: hash(CATALOG_DIGEST_DOMAIN, unsigned),
  });
}

function command(
  expectedGeneration: number,
  expectedCatalogDigest: string | null,
  next: Readonly<ToolResultKeyCatalogSnapshot>,
): Readonly<ToolResultKeyCatalogCommand> {
  const unsigned = Object.freeze({
    schema: TOOL_RESULT_KEY_CATALOG_COMMAND_SCHEMA,
    expectedGeneration,
    expectedCatalogDigest,
    next,
  });
  return normalizeToolResultKeyCatalogCommand({
    ...unsigned,
    commandDigest: hash(COMMAND_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeToolResultKeyCatalogCommand(
  value: ToolResultKeyCatalogCommand,
): Readonly<ToolResultKeyCatalogCommand> {
  const candidate = record(value, 'catalog command');
  exactKeys(
    candidate,
    [
      'commandDigest',
      'expectedCatalogDigest',
      'expectedGeneration',
      'next',
      'schema',
    ],
    'catalog command',
  );
  if (
    value.schema !== TOOL_RESULT_KEY_CATALOG_COMMAND_SCHEMA ||
    !Number.isSafeInteger(value.expectedGeneration) ||
    value.expectedGeneration < 0
  ) {
    return invalid('catalog command header is invalid');
  }
  const expectedCatalogDigest = nullableDigest(
    value.expectedCatalogDigest,
    'expected catalog digest',
  );
  const next = normalizeToolResultKeyCatalogSnapshot(value.next);
  if (
    next.generation !== value.expectedGeneration + 1 ||
    next.previousCatalogDigest !== expectedCatalogDigest ||
    (value.expectedGeneration === 0) !==
      (expectedCatalogDigest === null && next.mutationKind === 'bootstrap')
  ) {
    return invalid('catalog command fence is invalid');
  }
  const unsigned = Object.freeze({
    schema: TOOL_RESULT_KEY_CATALOG_COMMAND_SCHEMA,
    expectedGeneration: value.expectedGeneration,
    expectedCatalogDigest,
    next,
  });
  const commandDigest = digest(value.commandDigest, 'command digest');
  if (hash(COMMAND_DIGEST_DOMAIN, unsigned) !== commandDigest) {
    return invalid('command digest does not match');
  }
  return Object.freeze({ ...unsigned, commandDigest });
}

export function toolResultKeyMaterialProof(
  candidateKeyId: string,
  value: Uint8Array,
): string {
  const normalizedKeyId = keyId(candidateKeyId);
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    return invalid('key material is invalid');
  }
  const key = Buffer.from(value);
  try {
    return createHmac('sha256', key)
      .update(MATERIAL_PROOF_DOMAIN)
      .update(normalizedKeyId)
      .digest('hex');
  } finally {
    key.fill(0);
  }
}

export function createToolResultKeyCatalogBootstrapCommand(input: {
  readonly keyId: string;
  readonly materialProof: string;
  readonly mutationId: string;
}): Readonly<ToolResultKeyCatalogCommand> {
  const next = snapshot({
    generation: 1,
    previousCatalogDigest: null,
    activeKeyId: keyId(input.keyId),
    keys: Object.freeze([
      Object.freeze({
        keyId: keyId(input.keyId),
        state: 'active' as const,
        materialProof: digest(input.materialProof, 'material proof'),
        introducedGeneration: 1,
        stateChangedGeneration: 1,
        retirementReceiptDigest: null,
      }),
    ]),
    mutationKind: 'bootstrap',
    mutationId: identity(input.mutationId, 'mutation id'),
  });
  return command(0, null, next);
}

function currentRecord(
  value: ToolResultKeyCatalogRecord,
): Readonly<ToolResultKeyCatalogRecord> {
  return normalizeToolResultKeyCatalogRecord(value);
}

function nextKeys(
  current: Readonly<ToolResultKeyCatalogRecord>,
): ToolResultKeyCatalogEntry[] {
  return current.keys
    .filter((entry) => entry.state !== 'retired')
    .map((entry) => ({ ...entry }));
}

export function createToolResultKeyRotationCommand(
  value: ToolResultKeyCatalogRecord,
  input: {
    readonly keyId: string;
    readonly materialProof: string;
    readonly mutationId: string;
  },
): Readonly<ToolResultKeyCatalogCommand> {
  const current = currentRecord(value);
  const candidateKeyId = keyId(input.keyId);
  if (current.keys.some((entry) => entry.keyId === candidateKeyId)) {
    return invalid('rotation key id already exists');
  }
  const nextGeneration = current.generation + 1;
  const keys = nextKeys(current).map((entry) =>
    entry.state === 'active'
      ? {
          ...entry,
          state: 'decrypt_only' as const,
          stateChangedGeneration: nextGeneration,
        }
      : entry,
  );
  keys.push({
    keyId: candidateKeyId,
    state: 'active',
    materialProof: digest(input.materialProof, 'material proof'),
    introducedGeneration: nextGeneration,
    stateChangedGeneration: nextGeneration,
    retirementReceiptDigest: null,
  });
  const next = snapshot({
    generation: nextGeneration,
    previousCatalogDigest: current.catalogDigest,
    activeKeyId: candidateKeyId,
    keys: Object.freeze(keys),
    mutationKind: 'rotate',
    mutationId: identity(input.mutationId, 'mutation id'),
  });
  return command(current.generation, current.catalogDigest, next);
}

export function createToolResultKeyRetirementCommand(
  value: ToolResultKeyCatalogRecord,
  input: {
    readonly keyId: string;
    readonly retirementReceiptDigest: string;
    readonly mutationId: string;
  },
): Readonly<ToolResultKeyCatalogCommand> {
  const current = currentRecord(value);
  const candidateKeyId = keyId(input.keyId);
  const receipt = digest(
    input.retirementReceiptDigest,
    'retirement receipt digest',
  );
  const target = current.keys.find((entry) => entry.keyId === candidateKeyId);
  if (!target || target.state !== 'decrypt_only') {
    return invalid('only a decrypt-only key can be retired');
  }
  const nextGeneration = current.generation + 1;
  const keys = nextKeys(current).map((entry) =>
    entry.keyId === candidateKeyId
      ? {
          ...entry,
          state: 'retired' as const,
          stateChangedGeneration: nextGeneration,
          retirementReceiptDigest: receipt,
        }
      : entry,
  );
  const next = snapshot({
    generation: nextGeneration,
    previousCatalogDigest: current.catalogDigest,
    activeKeyId: current.activeKeyId,
    keys: Object.freeze(keys),
    mutationKind: 'retire',
    mutationId: identity(input.mutationId, 'mutation id'),
  });
  return command(current.generation, current.catalogDigest, next);
}

export function createToolResultKeyLostCommand(
  value: ToolResultKeyCatalogRecord,
  input: {
    readonly keyId: string;
    readonly mutationId: string;
  },
): Readonly<ToolResultKeyCatalogCommand> {
  const current = currentRecord(value);
  const candidateKeyId = keyId(input.keyId);
  const target = current.keys.find((entry) => entry.keyId === candidateKeyId);
  if (
    !target ||
    (target.state !== 'active' && target.state !== 'decrypt_only')
  ) {
    return invalid('only a decryptable key can be marked lost');
  }
  const nextGeneration = current.generation + 1;
  const keys = nextKeys(current).map((entry) =>
    entry.keyId === candidateKeyId
      ? {
          ...entry,
          state: 'lost' as const,
          stateChangedGeneration: nextGeneration,
        }
      : entry,
  );
  const next = snapshot({
    generation: nextGeneration,
    previousCatalogDigest: current.catalogDigest,
    activeKeyId:
      current.activeKeyId === candidateKeyId ? null : current.activeKeyId,
    keys: Object.freeze(keys),
    mutationKind: 'mark_lost',
    mutationId: identity(input.mutationId, 'mutation id'),
  });
  return command(current.generation, current.catalogDigest, next);
}

export function createToolResultKeyRestoreCommand(
  value: ToolResultKeyCatalogRecord,
  input: {
    readonly keyId: string;
    readonly materialProof: string;
    readonly mutationId: string;
  },
): Readonly<ToolResultKeyCatalogCommand> {
  const current = currentRecord(value);
  const candidateKeyId = keyId(input.keyId);
  const target = current.keys.find((entry) => entry.keyId === candidateKeyId);
  if (
    !target ||
    target.state !== 'lost' ||
    target.materialProof !== digest(input.materialProof, 'material proof')
  ) {
    return invalid('lost key restore proof does not match');
  }
  const nextGeneration = current.generation + 1;
  const restoredState = 'decrypt_only' as const;
  const keys = nextKeys(current).map((entry) =>
    entry.keyId === candidateKeyId
      ? {
          ...entry,
          state: restoredState,
          stateChangedGeneration: nextGeneration,
        }
      : entry,
  );
  const next = snapshot({
    generation: nextGeneration,
    previousCatalogDigest: current.catalogDigest,
    activeKeyId: current.activeKeyId,
    keys: Object.freeze(keys),
    mutationKind: 'restore',
    mutationId: identity(input.mutationId, 'mutation id'),
  });
  return command(current.generation, current.catalogDigest, next);
}

export function findToolResultKeyCatalogEntry(
  value: ToolResultKeyCatalogRecord,
  candidateKeyId: string,
): Readonly<ToolResultKeyCatalogEntry> | null {
  const catalog = currentRecord(value);
  const normalizedKeyId = keyId(candidateKeyId);
  return catalog.keys.find((entry) => entry.keyId === normalizedKeyId) ?? null;
}

export function requireActiveToolResultKey(
  value: ToolResultKeyCatalogRecord,
): Readonly<ToolResultKeyCatalogEntry> {
  const catalog = currentRecord(value);
  if (catalog.activeKeyId === null) {
    throw new ToolResultKeyCatalogUnavailableError();
  }
  const entry = catalog.keys.find(
    (candidate) => candidate.keyId === catalog.activeKeyId,
  );
  if (!entry || entry.state !== 'active') {
    throw new ToolResultKeyCatalogUnavailableError();
  }
  return entry;
}

export function requireDecryptableToolResultKey(
  value: ToolResultKeyCatalogRecord,
  candidateKeyId: string,
): Readonly<ToolResultKeyCatalogEntry> {
  const entry = findToolResultKeyCatalogEntry(value, candidateKeyId);
  if (!entry) throw new ToolResultKeyCatalogUnavailableError();
  if (entry.state === 'lost') throw new ToolResultKeyLostError(entry.keyId);
  if (entry.state !== 'active' && entry.state !== 'decrypt_only') {
    throw new ToolResultKeyCatalogUnavailableError();
  }
  return entry;
}

export function toolResultKeyCatalogFence(
  value: ToolResultKeyCatalogRecord,
  entryValue: ToolResultKeyCatalogEntry,
): Readonly<ToolResultKeyCatalogFence> {
  const catalog = currentRecord(value);
  const entry = normalizedEntry(entryValue, catalog.generation);
  const stored = catalog.keys.find(
    (candidate) => candidate.keyId === entry.keyId,
  );
  if (
    !stored ||
    JSON.stringify(stored) !== JSON.stringify(entry) ||
    entry.state !== 'active' ||
    catalog.activeKeyId !== entry.keyId
  ) {
    return invalid('catalog fence key is not active');
  }
  return normalizeToolResultKeyCatalogFence({
    generation: catalog.generation,
    catalogDigest: catalog.catalogDigest,
    keyId: entry.keyId,
    materialProof: entry.materialProof,
  });
}

export function assertToolResultKeyCatalogTransition(
  currentValue: ToolResultKeyCatalogRecord | null,
  commandValue: ToolResultKeyCatalogCommand,
): void {
  const candidate = normalizeToolResultKeyCatalogCommand(commandValue);
  let expected: Readonly<ToolResultKeyCatalogCommand>;
  if (currentValue === null) {
    if (
      candidate.next.mutationKind !== 'bootstrap' ||
      candidate.next.keys.length !== 1
    ) {
      throw new ToolResultKeyCatalogConflictError();
    }
    const entry = candidate.next.keys[0]!;
    expected = createToolResultKeyCatalogBootstrapCommand({
      keyId: entry.keyId,
      materialProof: entry.materialProof,
      mutationId: candidate.next.mutationId,
    });
  } else {
    const current = currentRecord(currentValue);
    if (
      candidate.expectedGeneration !== current.generation ||
      candidate.expectedCatalogDigest !== current.catalogDigest
    ) {
      throw new ToolResultKeyCatalogConflictError();
    }
    const changed = candidate.next.keys.filter((entry) => {
      const previous = current.keys.find(
        (candidateEntry) => candidateEntry.keyId === entry.keyId,
      );
      return !previous || JSON.stringify(previous) !== JSON.stringify(entry);
    });
    switch (candidate.next.mutationKind) {
      case 'rotate': {
        const added = changed.find(
          (entry) =>
            !current.keys.some(
              (currentEntry) => currentEntry.keyId === entry.keyId,
            ),
        );
        if (!added) throw new ToolResultKeyCatalogConflictError();
        expected = createToolResultKeyRotationCommand(current, {
          keyId: added.keyId,
          materialProof: added.materialProof,
          mutationId: candidate.next.mutationId,
        });
        break;
      }
      case 'retire': {
        const retired = changed.find((entry) => entry.state === 'retired');
        if (!retired || retired.retirementReceiptDigest === null) {
          throw new ToolResultKeyCatalogConflictError();
        }
        expected = createToolResultKeyRetirementCommand(current, {
          keyId: retired.keyId,
          retirementReceiptDigest: retired.retirementReceiptDigest,
          mutationId: candidate.next.mutationId,
        });
        break;
      }
      case 'mark_lost': {
        const lost = changed.find((entry) => entry.state === 'lost');
        if (!lost) throw new ToolResultKeyCatalogConflictError();
        expected = createToolResultKeyLostCommand(current, {
          keyId: lost.keyId,
          mutationId: candidate.next.mutationId,
        });
        break;
      }
      case 'restore': {
        const restored = changed.find((entry) => {
          const previous = current.keys.find(
            (currentEntry) => currentEntry.keyId === entry.keyId,
          );
          return (
            previous?.state === 'lost' &&
            (entry.state === 'active' || entry.state === 'decrypt_only')
          );
        });
        if (!restored) throw new ToolResultKeyCatalogConflictError();
        expected = createToolResultKeyRestoreCommand(current, {
          keyId: restored.keyId,
          materialProof: restored.materialProof,
          mutationId: candidate.next.mutationId,
        });
        break;
      }
      default:
        throw new ToolResultKeyCatalogConflictError();
    }
  }
  if (JSON.stringify(expected) !== JSON.stringify(candidate)) {
    throw new ToolResultKeyCatalogConflictError();
  }
}
