import { createHash } from 'node:crypto';

import {
  normalizePluginPackageMaterializedRevision,
  pluginPackageTaskDefinitionDrafts,
  type PluginPackageMaterializedRevision,
  type PluginPackageTaskDefinitionDraft,
} from './pluginPackageResourceMaterialization';
import type { PluginPackageResourceGenerationSource } from './pluginPackageResourceGeneration';
import {
  createTaskDefinitionRecord,
  normalizeTaskDefinitionRecord,
  taskDefinitionContentDigest,
  type AppendTaskDefinitionRevisionCommand,
  type TaskDefinitionRecord,
} from '../task-definition/taskDefinition';
import { TaskSpecSemanticRegistry } from '../task-definition/taskSpecSemantic';

export const PLUGIN_PACKAGE_TASK_RECONCILIATION_SCHEMA =
  'qinglong/plugin-package-task-reconciliation@v1' as const;
export const MAX_PLUGIN_PACKAGE_TASK_RECONCILIATION_ITEMS = 512;

export type PluginPackageTaskReconciliationDisposition =
  | 'already_disabled'
  | 'created'
  | 'disabled'
  | 'retained'
  | 'updated';

export interface PluginPackageTaskOwnershipFact {
  readonly taskId: string;
  readonly packageName: string | null;
  readonly current: Readonly<TaskDefinitionRecord> | null;
}

export interface PluginPackageTaskReconciliationItem {
  readonly taskId: string;
  readonly revision: number;
  readonly disposition: PluginPackageTaskReconciliationDisposition;
  readonly contentDigest: string;
}

export interface PluginPackageTaskReconciliationReceipt {
  readonly schema: typeof PLUGIN_PACKAGE_TASK_RECONCILIATION_SCHEMA;
  readonly projectId: string;
  readonly packageName: string;
  readonly generation: number;
  readonly generationDigest: string;
  readonly materializedRevisionDigest: string;
  readonly lockDigest: string;
  readonly previousLockDigest: string | null;
  readonly committedAtMs: number;
  readonly items: readonly Readonly<PluginPackageTaskReconciliationItem>[];
  readonly receiptDigest: string;
}

export interface PluginPackageTaskReconciliationWrite {
  readonly command: Readonly<AppendTaskDefinitionRevisionCommand>;
  readonly definition: Readonly<TaskDefinitionRecord>;
}

export interface PluginPackageTaskReconciliationPlan {
  readonly receipt: Readonly<PluginPackageTaskReconciliationReceipt>;
  readonly writes: readonly Readonly<PluginPackageTaskReconciliationWrite>[];
}

export interface PlanPluginPackageTaskReconciliationInput {
  readonly revision: Readonly<PluginPackageMaterializedRevision>;
  readonly previousReceipt: Readonly<PluginPackageTaskReconciliationReceipt> | null;
  readonly facts: readonly Readonly<PluginPackageTaskOwnershipFact>[];
  readonly committedAtMs: number;
  readonly taskSpecSemanticRegistry: TaskSpecSemanticRegistry;
}

export interface PluginPackageTaskReconciliationRepository {
  find(
    generationDigest: string,
  ): Promise<Readonly<PluginPackageTaskReconciliationReceipt> | null>;
  reconcile(
    revision: Readonly<PluginPackageMaterializedRevision>,
    activeGenerationSource: PluginPackageResourceGenerationSource,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackageTaskReconciliationReceipt>;
    }>
  >;
}

export class InvalidPluginPackageTaskReconciliationError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_TASK_RECONCILIATION_INVALID';

  constructor(message: string) {
    super(`Plugin Package Task reconciliation is invalid: ${message}`);
    this.name = 'InvalidPluginPackageTaskReconciliationError';
  }
}

export class PluginPackageTaskReconciliationConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_TASK_RECONCILIATION_CONFLICT';

  constructor(message: string) {
    super(`Plugin Package Task reconciliation conflicts with state: ${message}`);
    this.name = 'PluginPackageTaskReconciliationConflictError';
  }
}

export class PluginPackageTaskReconciliationUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_TASK_RECONCILIATION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package Task reconciliation is unavailable', options);
    this.name = 'PluginPackageTaskReconciliationUnavailableError';
  }
}

const DIGEST = /^[0-9a-f]{64}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ITEM_DISPOSITIONS = Object.freeze([
  'already_disabled',
  'created',
  'disabled',
  'retained',
  'updated',
] as const);
const RECEIPT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-task-reconciliation-receipt@v1\0',
  'utf8',
);
const MUTATION_ID_DOMAIN = Buffer.from(
  'qinglong/plugin-package-task-reconciliation-mutation@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidPluginPackageTaskReconciliationError(message);
}

function conflict(message: string): never {
  throw new PluginPackageTaskReconciliationConflictError(message);
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 128
  ) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function exactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.some((key) => typeof key !== 'string') ||
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key === 'string' && !allowed.has(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function denseItems(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_PLUGIN_PACKAGE_TASK_RECONCILIATION_ITEMS ||
    Object.keys(value).some((key, index) => key !== String(index))
  ) {
    return invalid('items are invalid');
  }
  return value;
}

function unsignedReceipt(
  value: Omit<PluginPackageTaskReconciliationReceipt, 'receiptDigest'>,
): object {
  return {
    schema: value.schema,
    projectId: value.projectId,
    packageName: value.packageName,
    generation: value.generation,
    generationDigest: value.generationDigest,
    materializedRevisionDigest: value.materializedRevisionDigest,
    lockDigest: value.lockDigest,
    previousLockDigest: value.previousLockDigest,
    committedAtMs: value.committedAtMs,
    items: value.items,
  };
}

export function pluginPackageTaskReconciliationReceiptDigest(
  value: Omit<PluginPackageTaskReconciliationReceipt, 'receiptDigest'>,
): string {
  return createHash('sha256')
    .update(RECEIPT_DIGEST_DOMAIN)
    .update(JSON.stringify(unsignedReceipt(value)))
    .digest('hex');
}

function mutationId(
  generationDigest: string,
  taskId: string,
  disposition: 'created' | 'disabled' | 'updated',
): string {
  const value = createHash('sha256')
    .update(MUTATION_ID_DOMAIN)
    .update(generationDigest)
    .update('\0')
    .update(taskId)
    .update('\0')
    .update(disposition)
    .digest('hex')
    .slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20)}`;
}

function normalizeItem(
  value: PluginPackageTaskReconciliationItem,
): Readonly<PluginPackageTaskReconciliationItem> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('item must be an object');
  }
  exactKeys(
    value,
    ['contentDigest', 'disposition', 'revision', 'taskId'],
    [],
    'item',
  );
  if (!ITEM_DISPOSITIONS.includes(value.disposition)) {
    return invalid('item disposition is invalid');
  }
  return Object.freeze({
    taskId: identifier(value.taskId, 'item.taskId'),
    revision: integer(value.revision, 'item.revision', 1),
    disposition: value.disposition,
    contentDigest: digest(value.contentDigest, 'item.contentDigest'),
  });
}

export function normalizePluginPackageTaskReconciliationReceipt(
  value: PluginPackageTaskReconciliationReceipt,
): Readonly<PluginPackageTaskReconciliationReceipt> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('receipt must be an object');
  }
  exactKeys(
    value,
    [
      'committedAtMs',
      'generation',
      'generationDigest',
      'items',
      'lockDigest',
      'materializedRevisionDigest',
      'packageName',
      'previousLockDigest',
      'projectId',
      'receiptDigest',
      'schema',
    ],
    [],
    'receipt',
  );
  if (value.schema !== PLUGIN_PACKAGE_TASK_RECONCILIATION_SCHEMA) {
    return invalid('receipt schema is invalid');
  }
  if (typeof value.packageName !== 'string' || !PACKAGE_NAME.test(value.packageName)) {
    return invalid('packageName is invalid');
  }
  const items = denseItems(value.items).map((item) =>
    normalizeItem(item as PluginPackageTaskReconciliationItem),
  );
  if (
    items.some(
      (item, index) =>
        index > 0 && items[index - 1]!.taskId.localeCompare(item.taskId) >= 0,
    )
  ) {
    return invalid('items must be uniquely sorted by taskId');
  }
  const normalized = Object.freeze({
    schema: PLUGIN_PACKAGE_TASK_RECONCILIATION_SCHEMA,
    projectId: identifier(value.projectId, 'projectId'),
    packageName: value.packageName,
    generation: integer(value.generation, 'generation', 1),
    generationDigest: digest(value.generationDigest, 'generationDigest'),
    materializedRevisionDigest: digest(
      value.materializedRevisionDigest,
      'materializedRevisionDigest',
    ),
    lockDigest: digest(value.lockDigest, 'lockDigest'),
    previousLockDigest:
      value.previousLockDigest === null
        ? null
        : digest(value.previousLockDigest, 'previousLockDigest'),
    committedAtMs: integer(value.committedAtMs, 'committedAtMs', 0),
    items: Object.freeze(items),
    receiptDigest: digest(value.receiptDigest, 'receiptDigest'),
  });
  if (
    normalized.receiptDigest !==
    pluginPackageTaskReconciliationReceiptDigest(normalized)
  ) {
    return invalid('receipt digest did not match');
  }
  return normalized;
}

function semanticDigest(
  draft: Readonly<PluginPackageTaskDefinitionDraft>,
  revision: number,
): string {
  return taskDefinitionContentDigest({
    projectId: draft.projectId,
    taskId: draft.taskId,
    revision,
    name: draft.name,
    ...(draft.description === undefined
      ? {}
      : { description: draft.description }),
    kind: draft.kind,
    spec: draft.spec,
    labels: draft.labels,
    enabled: draft.enabled,
  });
}

function writeForDraft(
  draft: Readonly<PluginPackageTaskDefinitionDraft>,
  current: Readonly<TaskDefinitionRecord> | null,
  generationDigest: string,
  committedAtMs: number,
  disposition: 'created' | 'updated',
): Readonly<PluginPackageTaskReconciliationWrite> {
  const command = Object.freeze({
    projectId: draft.projectId,
    taskId: draft.taskId,
    expectedRevision: current?.revision ?? null,
    mutationId: mutationId(generationDigest, draft.taskId, disposition),
    name: draft.name,
    ...(draft.description === undefined
      ? {}
      : { description: draft.description }),
    kind: draft.kind,
    spec: draft.spec,
    labels: draft.labels,
    enabled: draft.enabled,
    occurredAtMs: committedAtMs,
  });
  return Object.freeze({
    command,
    definition: createTaskDefinitionRecord(command, current?.createdAtMs ?? committedAtMs),
  });
}

function disableWrite(
  current: Readonly<TaskDefinitionRecord>,
  generationDigest: string,
  committedAtMs: number,
): Readonly<PluginPackageTaskReconciliationWrite> {
  const command = Object.freeze({
    projectId: current.projectId,
    taskId: current.taskId,
    expectedRevision: current.revision,
    mutationId: mutationId(generationDigest, current.taskId, 'disabled'),
    name: current.name,
    ...(current.description === undefined
      ? {}
      : { description: current.description }),
    kind: current.kind,
    spec: current.spec,
    labels: current.labels,
    enabled: false,
    occurredAtMs: committedAtMs,
  });
  return Object.freeze({
    command,
    definition: createTaskDefinitionRecord(command, current.createdAtMs),
  });
}

export function pluginPackageTaskReconciliationTaskIds(
  revisionValue: Readonly<PluginPackageMaterializedRevision>,
  previousReceipt: Readonly<PluginPackageTaskReconciliationReceipt> | null,
  registry: TaskSpecSemanticRegistry,
): readonly string[] {
  const revision = normalizePluginPackageMaterializedRevision(revisionValue, registry);
  const previous =
    previousReceipt === null
      ? null
      : normalizePluginPackageTaskReconciliationReceipt(previousReceipt);
  return Object.freeze(
    [...new Set([
      ...pluginPackageTaskDefinitionDrafts(revision, registry).map(
        (draft) => draft.taskId,
      ),
      ...(previous?.items.map((item) => item.taskId) ?? []),
    ])].sort(),
  );
}

export function planPluginPackageTaskReconciliation(
  input: PlanPluginPackageTaskReconciliationInput,
): Readonly<PluginPackageTaskReconciliationPlan> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !(input.taskSpecSemanticRegistry instanceof TaskSpecSemanticRegistry)
  ) {
    return invalid('plan input is invalid');
  }
  const revision = normalizePluginPackageMaterializedRevision(
    input.revision,
    input.taskSpecSemanticRegistry,
  );
  const generation = revision.generation;
  const previous =
    input.previousReceipt === null
      ? null
      : normalizePluginPackageTaskReconciliationReceipt(input.previousReceipt);
  const committedAtMs = integer(input.committedAtMs, 'committedAtMs', 0);
  if (
    (generation.generation === 1 && previous !== null) ||
    (generation.generation > 1 &&
      (previous === null ||
        previous.projectId !== generation.projectId ||
        previous.packageName !== generation.packageName ||
        previous.generation !== generation.generation - 1 ||
        previous.lockDigest !== generation.previousActiveLockDigest))
  ) {
    return conflict('previous generation receipt chain is incomplete');
  }
  if (!Array.isArray(input.facts)) return invalid('facts are invalid');
  const drafts = pluginPackageTaskDefinitionDrafts(
    revision,
    input.taskSpecSemanticRegistry,
  );
  const taskIds = pluginPackageTaskReconciliationTaskIds(
    revision,
    previous,
    input.taskSpecSemanticRegistry,
  );
  if (taskIds.length > MAX_PLUGIN_PACKAGE_TASK_RECONCILIATION_ITEMS) {
    return invalid('task set exceeds its item budget');
  }
  const facts = new Map<string, Readonly<PluginPackageTaskOwnershipFact>>();
  for (const value of input.facts) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return invalid('fact is invalid');
    }
    exactKeys(value, ['current', 'packageName', 'taskId'], [], 'fact');
    const taskId = identifier(value.taskId, 'fact.taskId');
    if (facts.has(taskId) || !taskIds.includes(taskId)) {
      return invalid('facts must exactly and uniquely cover the task set');
    }
    if (
      value.packageName !== null &&
      (typeof value.packageName !== 'string' ||
        !PACKAGE_NAME.test(value.packageName))
    ) {
      return invalid('fact packageName is invalid');
    }
    const current =
      value.current === null ? null : normalizeTaskDefinitionRecord(value.current);
    if (
      current !== null &&
      (current.projectId !== generation.projectId || current.taskId !== taskId)
    ) {
      return invalid('fact current definition identity is invalid');
    }
    facts.set(taskId, Object.freeze({ taskId, packageName: value.packageName, current }));
  }
  if (facts.size !== taskIds.length) {
    return invalid('facts do not exactly cover the task set');
  }

  const draftById = new Map(drafts.map((draft) => [draft.taskId, draft]));
  const previousById = new Map(previous?.items.map((item) => [item.taskId, item]) ?? []);
  const items: PluginPackageTaskReconciliationItem[] = [];
  const writes: PluginPackageTaskReconciliationWrite[] = [];
  for (const taskId of taskIds) {
    const fact = facts.get(taskId)!;
    const draft = draftById.get(taskId);
    const previousItem = previousById.get(taskId);
    if (fact.packageName !== null && fact.packageName !== generation.packageName) {
      return conflict(`TaskDefinition ${taskId} belongs to another Package`);
    }
    if (fact.current !== null && fact.packageName === null) {
      return conflict(`TaskDefinition ${taskId} exists without Package ownership`);
    }
    if (
      previousItem &&
      (fact.current === null ||
        fact.packageName !== generation.packageName ||
        fact.current.revision !== previousItem.revision ||
        fact.current.contentDigest !== previousItem.contentDigest)
    ) {
      return conflict(`TaskDefinition ${taskId} changed outside reconciliation`);
    }
    if (draft) {
      if (fact.current === null) {
        const write = writeForDraft(
          draft,
          null,
          generation.generationDigest,
          committedAtMs,
          'created',
        );
        writes.push(write);
        items.push({
          taskId,
          revision: write.definition.revision,
          disposition: 'created',
          contentDigest: write.definition.contentDigest,
        });
      } else if (
        semanticDigest(draft, fact.current.revision) === fact.current.contentDigest
      ) {
        items.push({
          taskId,
          revision: fact.current.revision,
          disposition: 'retained',
          contentDigest: fact.current.contentDigest,
        });
      } else {
        const write = writeForDraft(
          draft,
          fact.current,
          generation.generationDigest,
          committedAtMs,
          'updated',
        );
        writes.push(write);
        items.push({
          taskId,
          revision: write.definition.revision,
          disposition: 'updated',
          contentDigest: write.definition.contentDigest,
        });
      }
    } else if (fact.current === null || !fact.current.enabled) {
      if (fact.current !== null) {
        items.push({
          taskId,
          revision: fact.current.revision,
          disposition: 'already_disabled',
          contentDigest: fact.current.contentDigest,
        });
      }
    } else {
      const write = disableWrite(
        fact.current,
        generation.generationDigest,
        committedAtMs,
      );
      writes.push(write);
      items.push({
        taskId,
        revision: write.definition.revision,
        disposition: 'disabled',
        contentDigest: write.definition.contentDigest,
      });
    }
  }
  items.sort((left, right) => left.taskId.localeCompare(right.taskId));
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_TASK_RECONCILIATION_SCHEMA,
    projectId: generation.projectId,
    packageName: generation.packageName,
    generation: generation.generation,
    generationDigest: generation.generationDigest,
    materializedRevisionDigest: revision.revisionDigest,
    lockDigest: generation.lockDigest,
    previousLockDigest: generation.previousActiveLockDigest,
    committedAtMs,
    items: Object.freeze(items.map((item) => Object.freeze(item))),
  });
  return Object.freeze({
    receipt: normalizePluginPackageTaskReconciliationReceipt(
      Object.freeze({
        ...unsigned,
        receiptDigest: pluginPackageTaskReconciliationReceiptDigest(unsigned),
      }),
    ),
    writes: Object.freeze(writes),
  });
}
