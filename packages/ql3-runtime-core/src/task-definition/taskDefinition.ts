import { createHash } from 'node:crypto';

export const TASK_DEFINITION_KINDS = Object.freeze([
  'script',
  'command',
  'workflow',
  'agent',
  'tool',
] as const);
export const MAX_TASK_DEFINITION_PAGE_SIZE = 256;
export const MAX_TASK_DEFINITION_SPEC_BYTES = 64 * 1024;
export const MAX_TASK_DEFINITION_LABELS = 32;

const TASK_SPEC_SCHEMA_PATTERN =
  /^[a-z][a-z0-9.-]{0,63}\/[a-z][a-z0-9.-]{0,63}@v[1-9][0-9]{0,5}$/;
const LABEL_KEY_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?)?$/;
const MUTATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type TaskDefinitionKind = (typeof TASK_DEFINITION_KINDS)[number];
export type TaskDefinitionJson =
  | null
  | boolean
  | number
  | string
  | readonly TaskDefinitionJson[]
  | Readonly<{ [key: string]: TaskDefinitionJson }>;

export interface TaskDefinitionSpec {
  readonly schema: string;
  readonly config: Readonly<{ [key: string]: TaskDefinitionJson }>;
}

export interface TaskDefinitionRecord {
  readonly projectId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly mutationId: string;
  readonly name: string;
  readonly description?: string;
  readonly kind: TaskDefinitionKind;
  readonly spec: TaskDefinitionSpec;
  readonly labels: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  readonly contentDigest: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface AppendTaskDefinitionRevisionCommand {
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedRevision: number | null;
  readonly mutationId: string;
  readonly name: string;
  readonly description?: string;
  readonly kind: TaskDefinitionKind;
  readonly spec: TaskDefinitionSpec;
  readonly labels: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  readonly occurredAtMs: number;
}

export interface TaskDefinitionCursor {
  readonly taskId: string;
}

export interface TaskDefinitionPage {
  readonly definitions: readonly TaskDefinitionRecord[];
  readonly truncated: boolean;
  readonly next?: TaskDefinitionCursor;
}

export interface TaskDefinitionSource {
  findCurrentTaskDefinition(
    projectId: string,
    taskId: string,
  ): Promise<TaskDefinitionRecord | null>;
  findTaskDefinitionRevision(
    projectId: string,
    taskId: string,
    revision: number,
  ): Promise<TaskDefinitionRecord | null>;
  listTaskDefinitions(options: {
    readonly projectId: string;
    readonly limit: number;
    readonly after?: TaskDefinitionCursor;
  }): Promise<TaskDefinitionPage>;
}

export interface TaskDefinitionRepository extends TaskDefinitionSource {
  appendTaskDefinitionRevision(
    command: AppendTaskDefinitionRevisionCommand,
  ): Promise<
    Readonly<{
      status: 'created' | 'updated' | 'existing';
      definition: TaskDefinitionRecord;
    }>
  >;
}

export class InvalidTaskDefinitionError extends TypeError {
  readonly code = 'TASK_DEFINITION_INVALID';

  constructor(message: string) {
    super(`TaskDefinition is invalid: ${message}`);
    this.name = 'InvalidTaskDefinitionError';
  }
}

export class TaskDefinitionConflictError extends Error {
  readonly code = 'TASK_DEFINITION_CONFLICT';

  constructor() {
    super('TaskDefinition mutation conflicts with durable state');
    this.name = 'TaskDefinitionConflictError';
  }
}

export class TaskDefinitionUnavailableError extends Error {
  readonly code = 'TASK_DEFINITION_UNAVAILABLE';

  constructor() {
    super('TaskDefinition storage is unavailable');
    this.name = 'TaskDefinitionUnavailableError';
  }
}

function exactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new InvalidTaskDefinitionError(`${label} has an invalid shape`);
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
    /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new InvalidTaskDefinitionError(`${label} is invalid`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  return boundedText(value, label, 128);
}

export function assertTaskDefinitionIdentifier(
  value: unknown,
  label = 'identifier',
): asserts value is string {
  identifier(value, label);
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidTaskDefinitionError(`${label} is invalid`);
  }
  return value as number;
}

function revision(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 2_147_483_647
  ) {
    throw new InvalidTaskDefinitionError(`${label} is invalid`);
  }
  return value as number;
}

export function assertTaskDefinitionRevision(
  value: unknown,
  label = 'revision',
): asserts value is number {
  revision(value, label);
}

function normalizeJson(
  value: unknown,
  budget: { nodes: number },
  depth: number,
): TaskDefinitionJson {
  budget.nodes += 1;
  if (budget.nodes > 1024 || depth > 12) {
    throw new InvalidTaskDefinitionError('spec exceeds its structure budget');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidTaskDefinitionError('spec contains an invalid number');
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'string') {
    if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > 16 * 1024) {
      throw new InvalidTaskDefinitionError('spec contains invalid text');
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) {
      throw new InvalidTaskDefinitionError('spec array is too large');
    }
    return Object.freeze(
      value.map((entry) => normalizeJson(entry, budget, depth + 1)),
    );
  }
  if (!value || typeof value !== 'object') {
    throw new InvalidTaskDefinitionError('spec contains a non-JSON value');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidTaskDefinitionError('spec object prototype is invalid');
  }
  const keys = Object.keys(value).sort();
  if (keys.length > 256) {
    throw new InvalidTaskDefinitionError('spec object is too large');
  }
  const normalized = Object.create(null) as Record<string, TaskDefinitionJson>;
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

export function normalizeTaskDefinitionSpec(
  value: TaskDefinitionSpec,
): TaskDefinitionSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskDefinitionError('spec must be an object');
  }
  exactKeys(value, ['config', 'schema'], [], 'spec');
  if (
    typeof value.schema !== 'string' ||
    !TASK_SPEC_SCHEMA_PATTERN.test(value.schema)
  ) {
    throw new InvalidTaskDefinitionError('spec schema is invalid');
  }
  const config = normalizeJson(value.config, { nodes: 0 }, 0);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new InvalidTaskDefinitionError('spec config must be an object');
  }
  const normalized: TaskDefinitionSpec = Object.freeze({
    schema: value.schema,
    config: config as Readonly<Record<string, TaskDefinitionJson>>,
  });
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
    MAX_TASK_DEFINITION_SPEC_BYTES
  ) {
    throw new InvalidTaskDefinitionError('spec exceeds its byte budget');
  }
  return normalized;
}

export function normalizeTaskDefinitionLabels(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskDefinitionError('labels must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidTaskDefinitionError('labels prototype is invalid');
  }
  const keys = Object.keys(value).sort();
  if (keys.length > MAX_TASK_DEFINITION_LABELS) {
    throw new InvalidTaskDefinitionError('labels exceed their count budget');
  }
  const normalized = Object.create(null) as Record<string, string>;
  for (const key of keys) {
    if (!LABEL_KEY_PATTERN.test(key)) {
      throw new InvalidTaskDefinitionError('label key is invalid');
    }
    normalized[key] = boundedText(value[key], 'label value', 256);
  }
  return Object.freeze(normalized);
}

function semanticDefinition(value: {
  readonly projectId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly name: string;
  readonly description?: string;
  readonly kind: TaskDefinitionKind;
  readonly spec: TaskDefinitionSpec;
  readonly labels: Readonly<Record<string, string>>;
  readonly enabled: boolean;
}): object {
  return {
    projectId: value.projectId,
    taskId: value.taskId,
    revision: value.revision,
    name: value.name,
    ...(value.description === undefined
      ? {}
      : { description: value.description }),
    kind: value.kind,
    spec: value.spec,
    labels: value.labels,
    enabled: value.enabled,
  };
}

export function taskDefinitionContentDigest(
  value: Parameters<typeof semanticDefinition>[0],
): string {
  return createHash('sha256')
    .update(JSON.stringify(semanticDefinition(value)))
    .digest('hex');
}

function normalizeDefinitionFields(value: {
  readonly projectId: unknown;
  readonly taskId: unknown;
  readonly revision: unknown;
  readonly name: unknown;
  readonly description?: unknown;
  readonly kind: unknown;
  readonly spec: TaskDefinitionSpec;
  readonly labels: Readonly<Record<string, string>>;
  readonly enabled: unknown;
}): Omit<
  TaskDefinitionRecord,
  'mutationId' | 'contentDigest' | 'createdAtMs' | 'updatedAtMs'
> {
  const projectId = identifier(value.projectId, 'projectId');
  const taskId = identifier(value.taskId, 'taskId');
  const normalizedRevision = revision(value.revision, 'revision');
  const name = boundedText(value.name, 'name', 255);
  const description =
    value.description === undefined
      ? undefined
      : boundedText(value.description, 'description', 4096);
  if (!TASK_DEFINITION_KINDS.includes(value.kind as TaskDefinitionKind)) {
    throw new InvalidTaskDefinitionError('kind is invalid');
  }
  if (typeof value.enabled !== 'boolean') {
    throw new InvalidTaskDefinitionError('enabled is invalid');
  }
  return Object.freeze({
    projectId,
    taskId,
    revision: normalizedRevision,
    name,
    ...(description === undefined ? {} : { description }),
    kind: value.kind as TaskDefinitionKind,
    spec: normalizeTaskDefinitionSpec(value.spec),
    labels: normalizeTaskDefinitionLabels(value.labels),
    enabled: value.enabled,
  });
}

export function normalizeAppendTaskDefinitionRevisionCommand(
  value: AppendTaskDefinitionRevisionCommand,
): Readonly<AppendTaskDefinitionRevisionCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskDefinitionError('command must be an object');
  }
  exactKeys(
    value,
    [
      'enabled',
      'expectedRevision',
      'kind',
      'labels',
      'mutationId',
      'name',
      'occurredAtMs',
      'projectId',
      'spec',
      'taskId',
    ],
    ['description'],
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
    throw new InvalidTaskDefinitionError('mutationId is invalid');
  }
  const fields = normalizeDefinitionFields({
    ...value,
    revision: expectedRevision === null ? 1 : expectedRevision + 1,
  });
  return Object.freeze({
    projectId: fields.projectId,
    taskId: fields.taskId,
    expectedRevision,
    mutationId: value.mutationId,
    name: fields.name,
    ...('description' in fields
      ? { description: fields.description as string }
      : {}),
    kind: fields.kind,
    spec: fields.spec,
    labels: fields.labels,
    enabled: fields.enabled,
    occurredAtMs: timestamp(value.occurredAtMs, 'occurredAtMs'),
  });
}

export function normalizeTaskDefinitionRecord(
  value: TaskDefinitionRecord,
): TaskDefinitionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidTaskDefinitionError('record must be an object');
  }
  exactKeys(
    value,
    [
      'contentDigest',
      'createdAtMs',
      'enabled',
      'kind',
      'labels',
      'mutationId',
      'name',
      'projectId',
      'revision',
      'spec',
      'taskId',
      'updatedAtMs',
    ],
    ['description'],
    'record',
  );
  const fields = normalizeDefinitionFields(value);
  if (
    typeof value.mutationId !== 'string' ||
    !MUTATION_ID_PATTERN.test(value.mutationId) ||
    typeof value.contentDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.contentDigest)
  ) {
    throw new InvalidTaskDefinitionError('record identity is invalid');
  }
  const createdAtMs = timestamp(value.createdAtMs, 'createdAtMs');
  const updatedAtMs = timestamp(value.updatedAtMs, 'updatedAtMs');
  if (updatedAtMs < createdAtMs) {
    throw new InvalidTaskDefinitionError('record time order is invalid');
  }
  const expectedDigest = taskDefinitionContentDigest(fields);
  if (value.contentDigest !== expectedDigest) {
    throw new InvalidTaskDefinitionError('content digest did not match');
  }
  return Object.freeze({
    ...fields,
    mutationId: value.mutationId,
    contentDigest: value.contentDigest,
    createdAtMs,
    updatedAtMs,
  });
}

export function createTaskDefinitionRecord(
  command: AppendTaskDefinitionRevisionCommand,
  createdAtMs: number,
): TaskDefinitionRecord {
  const normalized = normalizeAppendTaskDefinitionRevisionCommand(command);
  const fields = normalizeDefinitionFields({
    ...normalized,
    revision:
      normalized.expectedRevision === null
        ? 1
        : normalized.expectedRevision + 1,
  });
  const record = {
    ...fields,
    mutationId: normalized.mutationId,
    contentDigest: taskDefinitionContentDigest(fields),
    createdAtMs: timestamp(createdAtMs, 'createdAtMs'),
    updatedAtMs: normalized.occurredAtMs,
  };
  return normalizeTaskDefinitionRecord(record);
}

export function assertTaskDefinitionPageSize(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_TASK_DEFINITION_PAGE_SIZE
  ) {
    throw new RangeError(
      `TaskDefinition page size must be between 1 and ${MAX_TASK_DEFINITION_PAGE_SIZE}`,
    );
  }
}

export function normalizeTaskDefinitionCursor(
  cursor: TaskDefinitionCursor,
): TaskDefinitionCursor {
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    Array.isArray(cursor) ||
    Object.keys(cursor).length !== 1
  ) {
    throw new InvalidTaskDefinitionError('cursor is invalid');
  }
  return Object.freeze({ taskId: identifier(cursor.taskId, 'cursor.taskId') });
}
