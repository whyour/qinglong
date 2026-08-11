import { createHash } from 'node:crypto';

export const BUILT_IN_CRON_TRIGGER_SPEC_SCHEMA = 'qinglong/cron@v1';
export const MAX_TRIGGER_PAGE_SIZE = 256;
export const MAX_TRIGGER_SPEC_BYTES = 16 * 1024;
export const MAX_TRIGGER_SPEC_SEMANTIC_SCHEMAS = 32;

const TRIGGER_SPEC_SCHEMA_PATTERN =
  /^[a-z][a-z0-9.-]{0,63}\/[a-z][a-z0-9.-]{0,63}@v[1-9][0-9]{0,5}$/;
const MUTATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CRON_FIELD_PATTERN = /^[0-9A-Za-z*?,/#LW-]+$/;

export type TriggerSpecJson =
  | null
  | boolean
  | number
  | string
  | readonly TriggerSpecJson[]
  | Readonly<{ [key: string]: TriggerSpecJson }>;

export interface TriggerSpec {
  readonly schema: string;
  readonly config: Readonly<{ [key: string]: TriggerSpecJson }>;
}

export interface TriggerRecord {
  readonly projectId: string;
  readonly triggerId: string;
  readonly revision: number;
  readonly mutationId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskContentDigest: string;
  readonly spec: TriggerSpec;
  readonly enabled: boolean;
  readonly contentDigest: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface AppendTriggerRevisionCommand {
  readonly projectId: string;
  readonly triggerId: string;
  readonly expectedRevision: number | null;
  readonly mutationId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskContentDigest: string;
  readonly spec: TriggerSpec;
  readonly enabled: boolean;
  readonly occurredAtMs: number;
}

export interface TriggerCursor {
  readonly triggerId: string;
}

export interface TriggerPage {
  readonly triggers: readonly TriggerRecord[];
  readonly truncated: boolean;
  readonly next?: TriggerCursor;
}

export interface TriggerSource {
  findCurrentTrigger(
    projectId: string,
    triggerId: string,
  ): Promise<TriggerRecord | null>;
  findTriggerRevision(
    projectId: string,
    triggerId: string,
    revision: number,
  ): Promise<TriggerRecord | null>;
  listTriggers(options: {
    readonly projectId: string;
    readonly limit: number;
    readonly after?: TriggerCursor;
  }): Promise<TriggerPage>;
}

export interface TriggerRepository extends TriggerSource {
  appendTriggerRevision(command: AppendTriggerRevisionCommand): Promise<
    Readonly<{
      status: 'created' | 'updated' | 'existing';
      trigger: TriggerRecord;
    }>
  >;
}

export interface TriggerSpecSemanticDescriptor {
  readonly schema: string;
  normalizeConfig(
    config: Readonly<Record<string, TriggerSpecJson>>,
    context: Readonly<{
      projectId: string;
      triggerId: string;
      taskId: string;
      taskRevision: number;
    }>,
  ): Readonly<Record<string, TriggerSpecJson>>;
}

export interface TriggerSpecSemanticMetadata {
  readonly schema: string;
}

export class InvalidTriggerError extends TypeError {
  readonly code = 'TRIGGER_INVALID';

  constructor(message: string) {
    super(`Trigger is invalid: ${message}`);
    this.name = 'InvalidTriggerError';
  }
}

export class UnsupportedTriggerSpecError extends Error {
  readonly code = 'TRIGGER_SPEC_UNSUPPORTED';

  constructor() {
    super('Trigger spec schema is unsupported');
    this.name = 'UnsupportedTriggerSpecError';
  }
}

export class InvalidTriggerSpecSemanticError extends TypeError {
  readonly code = 'TRIGGER_SPEC_SEMANTIC_INVALID';

  constructor(message: string) {
    super(`Trigger spec semantics are invalid: ${message}`);
    this.name = 'InvalidTriggerSpecSemanticError';
  }
}

export class TriggerConflictError extends Error {
  readonly code = 'TRIGGER_CONFLICT';

  constructor() {
    super('Trigger mutation conflicts with durable state');
    this.name = 'TriggerConflictError';
  }
}

export class TriggerUnavailableError extends Error {
  readonly code = 'TRIGGER_UNAVAILABLE';

  constructor() {
    super('Trigger storage is unavailable');
    this.name = 'TriggerUnavailableError';
  }
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
  ErrorType: typeof InvalidTriggerError | typeof InvalidTriggerSpecSemanticError =
    InvalidTriggerError,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ErrorType(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new ErrorType(`${label} has an invalid shape`);
  }
}

function boundedText(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.includes('\0') ||
    /[\u0001-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new InvalidTriggerError(`${label} is invalid`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  return boundedText(value, label, 128);
}

function revision(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 2_147_483_647
  ) {
    throw new InvalidTriggerError(`${label} is invalid`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidTriggerError(`${label} is invalid`);
  }
  return value as number;
}

function normalizeJson(
  value: unknown,
  budget: { nodes: number },
  depth: number,
): TriggerSpecJson {
  budget.nodes += 1;
  if (budget.nodes > 512 || depth > 8) {
    throw new InvalidTriggerError('spec exceeds its structure budget');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidTriggerError('spec contains an invalid number');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'string') {
    if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > 4096) {
      throw new InvalidTriggerError('spec contains invalid text');
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) {
      throw new InvalidTriggerError('spec array is too large');
    }
    return Object.freeze(
      value.map((entry) => normalizeJson(entry, budget, depth + 1)),
    );
  }
  if (!value || typeof value !== 'object') {
    throw new InvalidTriggerError('spec contains a non-JSON value');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidTriggerError('spec object prototype is invalid');
  }
  const keys = Object.keys(value).sort();
  if (keys.length > 128) {
    throw new InvalidTriggerError('spec object is too large');
  }
  const normalized = Object.create(null) as Record<string, TriggerSpecJson>;
  for (const key of keys) {
    boundedText(key, 'spec key', 128);
    normalized[key] = normalizeJson(
      (value as Record<string, unknown>)[key],
      budget,
      depth + 1,
    );
  }
  return Object.freeze(normalized);
}

export function assertTriggerIdentifier(
  value: unknown,
  label = 'identifier',
): asserts value is string {
  identifier(value, label);
}

export function assertTriggerRevision(
  value: unknown,
  label = 'revision',
): asserts value is number {
  revision(value, label);
}

export function normalizeTriggerSpec(value: TriggerSpec): TriggerSpec {
  exactKeys(value, ['config', 'schema'], [], 'spec');
  if (
    typeof value.schema !== 'string' ||
    !TRIGGER_SPEC_SCHEMA_PATTERN.test(value.schema)
  ) {
    throw new InvalidTriggerError('spec schema is invalid');
  }
  const config = normalizeJson(value.config, { nodes: 0 }, 0);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new InvalidTriggerError('spec config must be an object');
  }
  const normalized = Object.freeze({
    schema: value.schema,
    config: config as Readonly<Record<string, TriggerSpecJson>>,
  });
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
    MAX_TRIGGER_SPEC_BYTES
  ) {
    throw new InvalidTriggerError('spec exceeds its byte budget');
  }
  return normalized;
}

function normalizeCronConfig(
  value: Readonly<Record<string, TriggerSpecJson>>,
): Readonly<Record<string, TriggerSpecJson>> {
  exactKeys(
    value,
    ['expression', 'misfirePolicy', 'timezone'],
    [],
    'cron config',
    InvalidTriggerSpecSemanticError,
  );
  if (typeof value.expression !== 'string') {
    throw new InvalidTriggerSpecSemanticError('cron expression is invalid');
  }
  const fields = value.expression.trim().split(/\s+/u);
  if (
    (fields.length !== 5 && fields.length !== 6) ||
    fields.some(
      (field) =>
        field.length < 1 ||
        Buffer.byteLength(field, 'utf8') > 128 ||
        !CRON_FIELD_PATTERN.test(field),
    )
  ) {
    throw new InvalidTriggerSpecSemanticError(
      'cron expression must contain five or six bounded fields',
    );
  }
  if (
    typeof value.timezone !== 'string' ||
    value.timezone.length < 1 ||
    Buffer.byteLength(value.timezone, 'utf8') > 128
  ) {
    throw new InvalidTriggerSpecSemanticError('timezone is invalid');
  }
  let timezone: string;
  try {
    timezone = new Intl.DateTimeFormat('en-US', {
      timeZone: value.timezone,
    }).resolvedOptions().timeZone;
  } catch {
    throw new InvalidTriggerSpecSemanticError('timezone is unsupported');
  }
  if (value.misfirePolicy !== 'skip' && value.misfirePolicy !== 'fire_once') {
    throw new InvalidTriggerSpecSemanticError('misfirePolicy is invalid');
  }
  return Object.freeze({
    expression: fields.join(' '),
    timezone,
    misfirePolicy: value.misfirePolicy,
  });
}

const BUILT_IN_DESCRIPTORS: readonly TriggerSpecSemanticDescriptor[] =
  Object.freeze([
    Object.freeze({
      schema: BUILT_IN_CRON_TRIGGER_SPEC_SCHEMA,
      normalizeConfig: normalizeCronConfig,
    }),
  ]);

export class TriggerSpecSemanticRegistry {
  readonly #descriptors: ReadonlyMap<string, TriggerSpecSemanticDescriptor>;
  readonly #metadata: readonly TriggerSpecSemanticMetadata[];

  constructor(descriptors: readonly TriggerSpecSemanticDescriptor[]) {
    if (
      !Array.isArray(descriptors) ||
      descriptors.length < 1 ||
      descriptors.length > MAX_TRIGGER_SPEC_SEMANTIC_SCHEMAS
    ) {
      throw new InvalidTriggerSpecSemanticError(
        'registry descriptor count is invalid',
      );
    }
    const bySchema = new Map<string, TriggerSpecSemanticDescriptor>();
    for (const descriptor of descriptors) {
      const descriptorSchema = descriptor?.schema;
      const normalizeConfig = descriptor?.normalizeConfig;
      exactKeys(
        descriptor,
        ['normalizeConfig', 'schema'],
        [],
        'registry descriptor',
        InvalidTriggerSpecSemanticError,
      );
      let schema: string;
      try {
        schema = normalizeTriggerSpec({
          schema: descriptorSchema,
          config: {},
        }).schema;
      } catch {
        throw new InvalidTriggerSpecSemanticError(
          'registry descriptor schema is invalid',
        );
      }
      if (typeof normalizeConfig !== 'function' || bySchema.has(schema)) {
        throw new InvalidTriggerSpecSemanticError(
          'registry descriptor is invalid or duplicated',
        );
      }
      bySchema.set(
        schema,
        Object.freeze({
          schema,
          normalizeConfig,
        }),
      );
    }
    this.#descriptors = bySchema;
    this.#metadata = Object.freeze(
      [...bySchema.keys()]
        .sort()
        .map((schema) => Object.freeze({ schema })),
    );
    Object.freeze(this);
  }

  list(): readonly TriggerSpecSemanticMetadata[] {
    return this.#metadata;
  }

  supports(schema: string): boolean {
    return this.#descriptors.has(schema);
  }

  normalize(context: {
    readonly projectId: string;
    readonly triggerId: string;
    readonly taskId: string;
    readonly taskRevision: number;
    readonly spec: TriggerSpec;
  }): TriggerSpec {
    exactKeys(
      context,
      ['projectId', 'spec', 'taskId', 'taskRevision', 'triggerId'],
      [],
      'semantic context',
      InvalidTriggerSpecSemanticError,
    );
    const projectId = identifier(context.projectId, 'projectId');
    const triggerId = identifier(context.triggerId, 'triggerId');
    const taskId = identifier(context.taskId, 'taskId');
    const taskRevision = revision(context.taskRevision, 'taskRevision');
    const spec = normalizeTriggerSpec(context.spec);
    const descriptor = this.#descriptors.get(spec.schema);
    if (!descriptor) throw new UnsupportedTriggerSpecError();
    let config: Readonly<Record<string, TriggerSpecJson>>;
    try {
      config = descriptor.normalizeConfig(
        spec.config,
        Object.freeze({ projectId, triggerId, taskId, taskRevision }),
      );
    } catch (error) {
      if (error instanceof InvalidTriggerSpecSemanticError) throw error;
      throw new InvalidTriggerSpecSemanticError('validator rejected the config');
    }
    return normalizeTriggerSpec({ schema: spec.schema, config });
  }
}

export function createBuiltInTriggerSpecSemanticRegistry(): TriggerSpecSemanticRegistry {
  return new TriggerSpecSemanticRegistry(BUILT_IN_DESCRIPTORS);
}

export function createTriggerSpecSemanticRegistry(
  extensions: readonly TriggerSpecSemanticDescriptor[] = [],
): TriggerSpecSemanticRegistry {
  if (
    !Array.isArray(extensions) ||
    extensions.some(
      (descriptor) =>
        !descriptor ||
        typeof descriptor !== 'object' ||
        typeof descriptor.schema !== 'string' ||
        descriptor.schema.startsWith('qinglong/'),
    )
  ) {
    throw new InvalidTriggerSpecSemanticError(
      'extension descriptor uses the reserved qinglong namespace',
    );
  }
  return new TriggerSpecSemanticRegistry([
    ...BUILT_IN_DESCRIPTORS,
    ...extensions,
  ]);
}

function semanticTrigger(value: {
  readonly projectId: string;
  readonly triggerId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly taskContentDigest: string;
  readonly spec: TriggerSpec;
  readonly enabled: boolean;
}): object {
  return {
    projectId: value.projectId,
    triggerId: value.triggerId,
    revision: value.revision,
    taskId: value.taskId,
    taskRevision: value.taskRevision,
    taskContentDigest: value.taskContentDigest,
    spec: value.spec,
    enabled: value.enabled,
  };
}

export function triggerContentDigest(
  value: Parameters<typeof semanticTrigger>[0],
): string {
  return createHash('sha256')
    .update('qinglong.trigger-definition.v1\0')
    .update(JSON.stringify(semanticTrigger(value)))
    .digest('hex');
}

function normalizeTriggerFields(value: {
  readonly projectId: unknown;
  readonly triggerId: unknown;
  readonly revision: unknown;
  readonly taskId: unknown;
  readonly taskRevision: unknown;
  readonly taskContentDigest: unknown;
  readonly spec: TriggerSpec;
  readonly enabled: unknown;
}): Omit<
  TriggerRecord,
  'mutationId' | 'contentDigest' | 'createdAtMs' | 'updatedAtMs'
> {
  if (
    typeof value.taskContentDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.taskContentDigest)
  ) {
    throw new InvalidTriggerError('taskContentDigest is invalid');
  }
  if (typeof value.enabled !== 'boolean') {
    throw new InvalidTriggerError('enabled is invalid');
  }
  return Object.freeze({
    projectId: identifier(value.projectId, 'projectId'),
    triggerId: identifier(value.triggerId, 'triggerId'),
    revision: revision(value.revision, 'revision'),
    taskId: identifier(value.taskId, 'taskId'),
    taskRevision: revision(value.taskRevision, 'taskRevision'),
    taskContentDigest: value.taskContentDigest,
    spec: normalizeTriggerSpec(value.spec),
    enabled: value.enabled,
  });
}

export function normalizeAppendTriggerRevisionCommand(
  value: AppendTriggerRevisionCommand,
): Readonly<AppendTriggerRevisionCommand> {
  exactKeys(
    value,
    [
      'enabled',
      'expectedRevision',
      'mutationId',
      'occurredAtMs',
      'projectId',
      'spec',
      'taskContentDigest',
      'taskId',
      'taskRevision',
      'triggerId',
    ],
    [],
    'command',
  );
  const expectedRevision =
    value.expectedRevision === null
      ? null
      : revision(value.expectedRevision, 'expectedRevision');
  if (
    typeof value.mutationId !== 'string' ||
    !MUTATION_ID_PATTERN.test(value.mutationId)
  ) {
    throw new InvalidTriggerError('mutationId is invalid');
  }
  const fields = normalizeTriggerFields({
    ...value,
    revision: expectedRevision === null ? 1 : expectedRevision + 1,
  });
  return Object.freeze({
    projectId: fields.projectId,
    triggerId: fields.triggerId,
    expectedRevision,
    mutationId: value.mutationId,
    taskId: fields.taskId,
    taskRevision: fields.taskRevision,
    taskContentDigest: fields.taskContentDigest,
    spec: fields.spec,
    enabled: fields.enabled,
    occurredAtMs: timestamp(value.occurredAtMs, 'occurredAtMs'),
  });
}

export function normalizeTriggerRecord(value: TriggerRecord): TriggerRecord {
  exactKeys(
    value,
    [
      'contentDigest',
      'createdAtMs',
      'enabled',
      'mutationId',
      'projectId',
      'revision',
      'spec',
      'taskContentDigest',
      'taskId',
      'taskRevision',
      'triggerId',
      'updatedAtMs',
    ],
    [],
    'record',
  );
  const fields = normalizeTriggerFields(value);
  if (
    typeof value.mutationId !== 'string' ||
    !MUTATION_ID_PATTERN.test(value.mutationId) ||
    typeof value.contentDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.contentDigest)
  ) {
    throw new InvalidTriggerError('record identity is invalid');
  }
  const createdAtMs = timestamp(value.createdAtMs, 'createdAtMs');
  const updatedAtMs = timestamp(value.updatedAtMs, 'updatedAtMs');
  if (updatedAtMs < createdAtMs) {
    throw new InvalidTriggerError('record time order is invalid');
  }
  if (value.contentDigest !== triggerContentDigest(fields)) {
    throw new InvalidTriggerError('content digest did not match');
  }
  return Object.freeze({
    ...fields,
    mutationId: value.mutationId,
    contentDigest: value.contentDigest,
    createdAtMs,
    updatedAtMs,
  });
}

export function createTriggerRecord(
  command: AppendTriggerRevisionCommand,
  createdAtMs: number,
): TriggerRecord {
  const normalized = normalizeAppendTriggerRevisionCommand(command);
  const fields = normalizeTriggerFields({
    ...normalized,
    revision:
      normalized.expectedRevision === null
        ? 1
        : normalized.expectedRevision + 1,
  });
  return normalizeTriggerRecord({
    ...fields,
    mutationId: normalized.mutationId,
    contentDigest: triggerContentDigest(fields),
    createdAtMs: timestamp(createdAtMs, 'createdAtMs'),
    updatedAtMs: normalized.occurredAtMs,
  });
}

export function assertTriggerPageSize(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_TRIGGER_PAGE_SIZE
  ) {
    throw new RangeError(
      `Trigger page size must be between 1 and ${MAX_TRIGGER_PAGE_SIZE}`,
    );
  }
}

export function normalizeTriggerCursor(cursor: TriggerCursor): TriggerCursor {
  exactKeys(cursor, ['triggerId'], [], 'cursor');
  return Object.freeze({
    triggerId: identifier(cursor.triggerId, 'cursor.triggerId'),
  });
}
