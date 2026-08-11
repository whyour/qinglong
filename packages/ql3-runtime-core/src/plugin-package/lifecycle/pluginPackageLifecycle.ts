import { createHash } from 'node:crypto';

import { SECURITY_SUBJECT_TYPES, type SecuritySubject } from '../../security/security';

export const PLUGIN_PACKAGE_LIFECYCLE_IMPACT_SCHEMA =
  'qinglong/plugin-package-lifecycle-impact@v1' as const;
export const PLUGIN_PACKAGE_LIFECYCLE_EVENT_SCHEMA =
  'qinglong/plugin-package-lifecycle-event@v1' as const;
export const PLUGIN_PACKAGE_LIFECYCLE_RECEIPT_SCHEMA =
  'qinglong/plugin-package-lifecycle-receipt@v1' as const;

export const MAX_PLUGIN_PACKAGE_LIFECYCLE_TASKS = 128;
export const MAX_PLUGIN_PACKAGE_LIFECYCLE_BLOCKING_REFERENCES = 128;
export const MAX_PLUGIN_PACKAGE_LIFECYCLE_RETAINED_SOURCES = 128;

export const PLUGIN_PACKAGE_LIFECYCLE_ACTIONS = [
  'disable',
  'enable',
  'uninstall',
] as const;
export const PLUGIN_PACKAGE_LIFECYCLE_DISPOSITIONS = [
  'active',
  'disabled',
  'uninstalled',
] as const;
export const PLUGIN_PACKAGE_LIFECYCLE_AUTHORIZATION_MODES = [
  'human_confirmation',
  'separation_of_duty',
] as const;
export const PLUGIN_PACKAGE_LIFECYCLE_REFERENCE_KINDS = [
  'execution_recovery',
  'prompt',
  'publication_recovery',
  'secret_binding',
  'tool',
  'workflow',
] as const;

export type PluginPackageLifecycleAction =
  typeof PLUGIN_PACKAGE_LIFECYCLE_ACTIONS[number];
export type PluginPackageLifecycleDisposition =
  typeof PLUGIN_PACKAGE_LIFECYCLE_DISPOSITIONS[number];
export type PluginPackageLifecycleAuthorizationMode =
  typeof PLUGIN_PACKAGE_LIFECYCLE_AUTHORIZATION_MODES[number];
export type PluginPackageLifecycleReferenceKind =
  typeof PLUGIN_PACKAGE_LIFECYCLE_REFERENCE_KINDS[number];

export interface PluginPackageLifecycleTarget {
  readonly projectId: string;
  readonly packageName: string;
  readonly installationId: string;
  readonly lockDigest: string;
  readonly installVersion: number;
  readonly installRecordDigest: string;
}

export interface PluginPackageLifecycleExpectation {
  readonly version: number;
  readonly disposition: PluginPackageLifecycleDisposition;
  readonly eventDigest: string | null;
}

export interface PluginPackageLifecycleResourceCounts {
  readonly tasks: number;
  readonly tools: number;
  readonly workflows: number;
  readonly prompts: number;
}

export interface PluginPackageLifecycleBlockingReference {
  readonly kind: PluginPackageLifecycleReferenceKind;
  readonly ownerId: string;
  readonly referenceDigest: string;
}

export interface PluginPackageLifecycleReferenceGraph {
  readonly target: Readonly<PluginPackageLifecycleTarget>;
  readonly generationDigest: string;
  readonly materializedRevisionDigest: string;
  readonly taskIds: readonly string[];
  readonly resourceCounts: Readonly<PluginPackageLifecycleResourceCounts>;
  readonly blockingReferences: readonly Readonly<PluginPackageLifecycleBlockingReference>[];
}

export interface PluginPackageLifecycleImpact {
  readonly schema: typeof PLUGIN_PACKAGE_LIFECYCLE_IMPACT_SCHEMA;
  readonly action: PluginPackageLifecycleAction;
  readonly target: Readonly<PluginPackageLifecycleTarget>;
  readonly expected: Readonly<PluginPackageLifecycleExpectation>;
  readonly generationDigest: string;
  readonly materializedRevisionDigest: string;
  readonly currentToolSnapshotDigest: string;
  readonly taskIds: readonly string[];
  readonly resourceCounts: Readonly<PluginPackageLifecycleResourceCounts>;
  readonly referenceGraphDigest: string;
  readonly blockingReferences: readonly Readonly<PluginPackageLifecycleBlockingReference>[];
  readonly impactDigest: string;
}

export type CreatePluginPackageLifecycleImpactInput = Omit<
  PluginPackageLifecycleImpact,
  'impactDigest' | 'schema'
>;

export interface PluginPackageLifecycleEvent {
  readonly schema: typeof PLUGIN_PACKAGE_LIFECYCLE_EVENT_SCHEMA;
  readonly mutationId: string;
  readonly dispatchId: string;
  readonly impact: Readonly<PluginPackageLifecycleImpact>;
  readonly actionDigest: string;
  readonly requestedBy: Readonly<SecuritySubject>;
  readonly approvedBy: Readonly<SecuritySubject>;
  readonly authorizationMode: PluginPackageLifecycleAuthorizationMode;
  readonly occurredAtMs: number;
  readonly eventDigest: string;
}

export interface CreatePluginPackageLifecycleEventInput {
  readonly dispatchId: string;
  readonly impact: PluginPackageLifecycleImpact;
  readonly requestedBy: SecuritySubject;
  readonly approvedBy: SecuritySubject;
  readonly authorizationMode: PluginPackageLifecycleAuthorizationMode;
  readonly occurredAtMs: number;
}

export interface PluginPackageLifecycleTaskTransition {
  readonly taskId: string;
  readonly previousRevision: number;
  readonly currentRevision: number;
  readonly previousContentDigest: string;
  readonly currentContentDigest: string;
  readonly previousEnabled: boolean;
  readonly currentEnabled: boolean;
}

export interface PluginPackageLifecycleCapabilityDisposition {
  readonly status: 'restored' | 'retired' | 'withdrawn';
  readonly taskTransitions: readonly Readonly<PluginPackageLifecycleTaskTransition>[];
  readonly previousActiveVectorDigest: string;
  readonly currentActiveVectorDigest: string;
  readonly currentToolSnapshotDigest: string;
  readonly retainedSourceCount: number;
}

export interface PluginPackageLifecycleHead {
  readonly projectId: string;
  readonly packageName: string;
  readonly installationId: string;
  readonly lockDigest: string;
  readonly installRecordDigest: string;
  readonly version: number;
  readonly disposition: PluginPackageLifecycleDisposition;
  readonly eventDigest: string;
  readonly updatedAtMs: number;
}

export interface PluginPackageLifecycleReceipt {
  readonly schema: typeof PLUGIN_PACKAGE_LIFECYCLE_RECEIPT_SCHEMA;
  readonly eventDigest: string;
  readonly action: PluginPackageLifecycleAction;
  readonly target: Readonly<PluginPackageLifecycleTarget>;
  readonly lifecycle: Readonly<PluginPackageLifecycleHead>;
  readonly capability: Readonly<PluginPackageLifecycleCapabilityDisposition>;
  readonly committedAtMs: number;
  readonly receiptDigest: string;
}

export type CreatePluginPackageLifecycleReceiptInput = Omit<
  PluginPackageLifecycleReceipt,
  'receiptDigest' | 'schema'
>;

export interface PluginPackageLifecycleRepository {
  plan(
    action: PluginPackageLifecycleAction,
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageLifecycleImpact>>;
  findHead(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageLifecycleHead> | null>;
  findByEventDigest(
    eventDigest: string,
  ): Promise<Readonly<PluginPackageLifecycleReceipt> | null>;
  transition(
    event: Readonly<PluginPackageLifecycleEvent>,
    confirmAuthorization: () => void | Promise<void>,
  ): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackageLifecycleReceipt>;
    }>
  >;
}

export class InvalidPluginPackageLifecycleError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_LIFECYCLE_INVALID';

  constructor(message: string) {
    super(`Plugin Package lifecycle is invalid: ${message}`);
    this.name = 'InvalidPluginPackageLifecycleError';
  }
}

export class PluginPackageLifecycleConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_LIFECYCLE_CONFLICT';

  constructor(message: string) {
    super(`Plugin Package lifecycle conflicts with durable state: ${message}`);
    this.name = 'PluginPackageLifecycleConflictError';
  }
}

export class PluginPackageLifecycleUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_LIFECYCLE_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package lifecycle is unavailable', options);
    this.name = 'PluginPackageLifecycleUnavailableError';
  }
}

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SUBJECT_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const IMPACT_DIGEST_DOMAIN =
  'qinglong/plugin-package-lifecycle-impact-digest@v1\0';
const REFERENCE_GRAPH_DIGEST_DOMAIN =
  'qinglong/plugin-package-lifecycle-reference-graph-digest@v1\0';
const ACTION_DIGEST_DOMAIN =
  'qinglong/plugin-package-lifecycle-action-digest@v1\0';
const EVENT_DIGEST_DOMAIN =
  'qinglong/plugin-package-lifecycle-event-digest@v1\0';
const RECEIPT_DIGEST_DOMAIN =
  'qinglong/plugin-package-lifecycle-receipt-digest@v1\0';
const MUTATION_ID_DOMAIN = 'qinglong/plugin-package-lifecycle-mutation-id@v1\0';
const TASK_MUTATION_ID_DOMAIN =
  'qinglong/plugin-package-lifecycle-task-mutation-id@v1\0';

function invalid(message: string): never {
  throw new InvalidPluginPackageLifecycleError(message);
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    )
  ) {
    return invalid(`${label} must contain enumerable data properties`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(value);
  const canonical = [...expected].sort();
  if (
    actual.some((key) => typeof key !== 'string') ||
    actual.length !== canonical.length ||
    actual
      .map(String)
      .sort()
      .some((key, index) => key !== canonical[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function projectId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    value.includes('\0')
  ) {
    return invalid('projectId is invalid');
  }
  return value;
}

function packageName(value: unknown): string {
  if (typeof value !== 'string' || !PACKAGE_NAME_PATTERN.test(value)) {
    return invalid('packageName is invalid');
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function subject(
  value: SecuritySubject,
  label: string,
): Readonly<SecuritySubject> {
  const record = dataRecord(value, label);
  exactKeys(record, ['id', 'type'], label);
  if (
    typeof value.type !== 'string' ||
    !SECURITY_SUBJECT_TYPES.includes(
      value.type as typeof SECURITY_SUBJECT_TYPES[number],
    ) ||
    value.type !== 'user' ||
    typeof value.id !== 'string' ||
    value.id.length < 1 ||
    Buffer.byteLength(value.id, 'utf8') > 255 ||
    SUBJECT_CONTROL_PATTERN.test(value.id)
  ) {
    return invalid(`${label} must be a User subject`);
  }
  return Object.freeze({ type: 'user', id: value.id });
}

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizeTarget(
  value: PluginPackageLifecycleTarget,
): Readonly<PluginPackageLifecycleTarget> {
  const target = dataRecord(value, 'target');
  exactKeys(
    target,
    [
      'installationId',
      'installRecordDigest',
      'installVersion',
      'lockDigest',
      'packageName',
      'projectId',
    ],
    'target',
  );
  return Object.freeze({
    projectId: projectId(value.projectId),
    packageName: packageName(value.packageName),
    installationId: identifier(value.installationId, 'installationId'),
    lockDigest: digest(value.lockDigest, 'lockDigest'),
    installVersion: boundedInteger(
      value.installVersion,
      'installVersion',
      1,
      2_147_483_647,
    ),
    installRecordDigest: digest(
      value.installRecordDigest,
      'installRecordDigest',
    ),
  });
}

function normalizeExpectation(
  value: PluginPackageLifecycleExpectation,
): Readonly<PluginPackageLifecycleExpectation> {
  const expected = dataRecord(value, 'expected lifecycle');
  exactKeys(
    expected,
    ['disposition', 'eventDigest', 'version'],
    'expected lifecycle',
  );
  if (
    typeof value.disposition !== 'string' ||
    !PLUGIN_PACKAGE_LIFECYCLE_DISPOSITIONS.includes(
      value.disposition as PluginPackageLifecycleDisposition,
    )
  ) {
    return invalid('expected lifecycle disposition is invalid');
  }
  const version = boundedInteger(
    value.version,
    'expected lifecycle version',
    0,
    2_147_483_646,
  );
  const eventDigest =
    value.eventDigest === null
      ? null
      : digest(value.eventDigest, 'expected lifecycle eventDigest');
  if (
    (version === 0 &&
      (value.disposition !== 'active' || eventDigest !== null)) ||
    (version > 0 && eventDigest === null)
  ) {
    return invalid('expected lifecycle origin is inconsistent');
  }
  return Object.freeze({
    version,
    disposition: value.disposition as PluginPackageLifecycleDisposition,
    eventDigest,
  });
}

export function pluginPackageLifecycleNextDisposition(
  actionValue: PluginPackageLifecycleAction,
  previousValue: PluginPackageLifecycleDisposition,
): PluginPackageLifecycleDisposition {
  if (actionValue === 'disable' && previousValue === 'active') {
    return 'disabled';
  }
  if (actionValue === 'enable' && previousValue === 'disabled') {
    return 'active';
  }
  if (actionValue === 'uninstall' && previousValue === 'disabled') {
    return 'uninstalled';
  }
  return invalid('lifecycle transition is not allowed');
}

function normalizeTaskIds(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_PLUGIN_PACKAGE_LIFECYCLE_TASKS ||
    Object.keys(value).some((key, index) => key !== String(index))
  ) {
    return invalid('taskIds are invalid');
  }
  const taskIds = value.map((entry) => identifier(entry, 'taskId'));
  taskIds.sort(bytewiseCompare);
  if (
    taskIds.some((taskId, index) => index > 0 && taskIds[index - 1] === taskId)
  ) {
    return invalid('taskIds are duplicated');
  }
  return Object.freeze(taskIds);
}

function normalizeResourceCounts(
  value: PluginPackageLifecycleResourceCounts,
): Readonly<PluginPackageLifecycleResourceCounts> {
  const counts = dataRecord(value, 'resource counts');
  exactKeys(
    counts,
    ['prompts', 'tasks', 'tools', 'workflows'],
    'resource counts',
  );
  return Object.freeze({
    tasks: boundedInteger(
      value.tasks,
      'task resource count',
      0,
      MAX_PLUGIN_PACKAGE_LIFECYCLE_TASKS,
    ),
    tools: boundedInteger(value.tools, 'Tool resource count', 0, 128),
    workflows: boundedInteger(
      value.workflows,
      'Workflow resource count',
      0,
      128,
    ),
    prompts: boundedInteger(value.prompts, 'Prompt resource count', 0, 128),
  });
}

function normalizeBlockingReference(
  value: PluginPackageLifecycleBlockingReference,
): Readonly<PluginPackageLifecycleBlockingReference> {
  const reference = dataRecord(value, 'blocking reference');
  exactKeys(
    reference,
    ['kind', 'ownerId', 'referenceDigest'],
    'blocking reference',
  );
  if (
    typeof value.kind !== 'string' ||
    !PLUGIN_PACKAGE_LIFECYCLE_REFERENCE_KINDS.includes(
      value.kind as PluginPackageLifecycleReferenceKind,
    )
  ) {
    return invalid('blocking reference kind is invalid');
  }
  return Object.freeze({
    kind: value.kind as PluginPackageLifecycleReferenceKind,
    ownerId: identifier(value.ownerId, 'blocking reference ownerId'),
    referenceDigest: digest(value.referenceDigest, 'blocking reference digest'),
  });
}

function blockingReferenceKey(
  value: Readonly<PluginPackageLifecycleBlockingReference>,
): string {
  return `${value.kind}\0${value.ownerId}\0${value.referenceDigest}`;
}

function normalizeBlockingReferences(
  value: unknown,
): readonly Readonly<PluginPackageLifecycleBlockingReference>[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_PLUGIN_PACKAGE_LIFECYCLE_BLOCKING_REFERENCES ||
    Object.keys(value).some((key, index) => key !== String(index))
  ) {
    return invalid('blocking references are invalid');
  }
  const references = value.map(normalizeBlockingReference);
  references.sort((left, right) =>
    bytewiseCompare(blockingReferenceKey(left), blockingReferenceKey(right)),
  );
  if (
    references.some(
      (reference, index) =>
        index > 0 &&
        blockingReferenceKey(references[index - 1]!) ===
          blockingReferenceKey(reference),
    )
  ) {
    return invalid('blocking references are duplicated');
  }
  return Object.freeze(references);
}

function normalizedReferenceGraph(
  value: PluginPackageLifecycleReferenceGraph,
): Readonly<PluginPackageLifecycleReferenceGraph> {
  const graph = dataRecord(value, 'lifecycle reference graph');
  exactKeys(
    graph,
    [
      'blockingReferences',
      'generationDigest',
      'materializedRevisionDigest',
      'resourceCounts',
      'target',
      'taskIds',
    ],
    'lifecycle reference graph',
  );
  const taskIds = normalizeTaskIds(value.taskIds);
  const resourceCounts = normalizeResourceCounts(value.resourceCounts);
  if (taskIds.length > resourceCounts.tasks) {
    return invalid('reference graph taskIds exceed task resource count');
  }
  return Object.freeze({
    target: normalizeTarget(value.target),
    generationDigest: digest(value.generationDigest, 'generationDigest'),
    materializedRevisionDigest: digest(
      value.materializedRevisionDigest,
      'materializedRevisionDigest',
    ),
    taskIds,
    resourceCounts,
    blockingReferences: normalizeBlockingReferences(
      value.blockingReferences,
    ),
  });
}

export function pluginPackageLifecycleReferenceGraphDigest(
  value: PluginPackageLifecycleReferenceGraph,
): string {
  const graph = normalizedReferenceGraph(value);
  return createHash('sha256')
    .update(REFERENCE_GRAPH_DIGEST_DOMAIN)
    .update(JSON.stringify(graph))
    .digest('hex');
}

function impactFields(
  value: Omit<PluginPackageLifecycleImpact, 'impactDigest'>,
): object {
  return {
    schema: value.schema,
    action: value.action,
    target: value.target,
    expected: value.expected,
    generationDigest: value.generationDigest,
    materializedRevisionDigest: value.materializedRevisionDigest,
    currentToolSnapshotDigest: value.currentToolSnapshotDigest,
    taskIds: value.taskIds,
    resourceCounts: value.resourceCounts,
    referenceGraphDigest: value.referenceGraphDigest,
    blockingReferences: value.blockingReferences,
  };
}

export function pluginPackageLifecycleImpactDigest(
  value: Omit<PluginPackageLifecycleImpact, 'impactDigest'>,
): string {
  return createHash('sha256')
    .update(IMPACT_DIGEST_DOMAIN)
    .update(JSON.stringify(impactFields(value)))
    .digest('hex');
}

function normalizedImpactWithoutDigest(
  value: Omit<PluginPackageLifecycleImpact, 'impactDigest'>,
): Omit<PluginPackageLifecycleImpact, 'impactDigest'> {
  if (
    typeof value.action !== 'string' ||
    !PLUGIN_PACKAGE_LIFECYCLE_ACTIONS.includes(
      value.action as PluginPackageLifecycleAction,
    )
  ) {
    return invalid('lifecycle action is invalid');
  }
  const expected = normalizeExpectation(value.expected);
  pluginPackageLifecycleNextDisposition(
    value.action as PluginPackageLifecycleAction,
    expected.disposition,
  );
  const taskIds = normalizeTaskIds(value.taskIds);
  const resourceCounts = normalizeResourceCounts(value.resourceCounts);
  if (taskIds.length > resourceCounts.tasks) {
    return invalid('taskIds exceed task resource count');
  }
  const blockingReferences = normalizeBlockingReferences(
    value.blockingReferences,
  );
  const referenceGraphDigest = pluginPackageLifecycleReferenceGraphDigest({
    target: value.target,
    generationDigest: value.generationDigest,
    materializedRevisionDigest: value.materializedRevisionDigest,
    taskIds,
    resourceCounts,
    blockingReferences,
  });
  if (value.referenceGraphDigest !== referenceGraphDigest) {
    return invalid('referenceGraphDigest does not match lifecycle references');
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_LIFECYCLE_IMPACT_SCHEMA,
    action: value.action as PluginPackageLifecycleAction,
    target: normalizeTarget(value.target),
    expected,
    generationDigest: digest(value.generationDigest, 'generationDigest'),
    materializedRevisionDigest: digest(
      value.materializedRevisionDigest,
      'materializedRevisionDigest',
    ),
    currentToolSnapshotDigest: digest(
      value.currentToolSnapshotDigest,
      'currentToolSnapshotDigest',
    ),
    taskIds,
    resourceCounts,
    referenceGraphDigest,
    blockingReferences,
  });
}

export function createPluginPackageLifecycleImpact(
  input: CreatePluginPackageLifecycleImpactInput,
): Readonly<PluginPackageLifecycleImpact> {
  const value = dataRecord(input, 'lifecycle impact input');
  exactKeys(
    value,
    [
      'action',
      'blockingReferences',
      'currentToolSnapshotDigest',
      'expected',
      'generationDigest',
      'materializedRevisionDigest',
      'referenceGraphDigest',
      'resourceCounts',
      'target',
      'taskIds',
    ],
    'lifecycle impact input',
  );
  const unsigned = normalizedImpactWithoutDigest({
    ...input,
    schema: PLUGIN_PACKAGE_LIFECYCLE_IMPACT_SCHEMA,
  });
  return Object.freeze({
    ...unsigned,
    impactDigest: pluginPackageLifecycleImpactDigest(unsigned),
  });
}

export function normalizePluginPackageLifecycleImpact(
  value: PluginPackageLifecycleImpact,
): Readonly<PluginPackageLifecycleImpact> {
  const impact = dataRecord(value, 'lifecycle impact');
  exactKeys(
    impact,
    [
      'action',
      'blockingReferences',
      'currentToolSnapshotDigest',
      'expected',
      'generationDigest',
      'impactDigest',
      'materializedRevisionDigest',
      'referenceGraphDigest',
      'resourceCounts',
      'schema',
      'target',
      'taskIds',
    ],
    'lifecycle impact',
  );
  if (value.schema !== PLUGIN_PACKAGE_LIFECYCLE_IMPACT_SCHEMA) {
    return invalid('lifecycle impact schema is invalid');
  }
  const unsigned = normalizedImpactWithoutDigest(value);
  const impactDigest = pluginPackageLifecycleImpactDigest(unsigned);
  if (value.impactDigest !== impactDigest) {
    return invalid('impactDigest does not match lifecycle impact');
  }
  return Object.freeze({ ...unsigned, impactDigest });
}

export function pluginPackageLifecycleActionDigest(
  impactValue: PluginPackageLifecycleImpact,
): string {
  const impact = normalizePluginPackageLifecycleImpact(impactValue);
  return createHash('sha256')
    .update(ACTION_DIGEST_DOMAIN)
    .update(impact.impactDigest)
    .digest('hex');
}

export function pluginPackageLifecycleMutationId(
  dispatchIdValue: string,
  impactDigestValue: string,
): string {
  const dispatchId = identifier(dispatchIdValue, 'dispatchId');
  const impactDigest = digest(impactDigestValue, 'impactDigest');
  const value = createHash('sha256')
    .update(MUTATION_ID_DOMAIN)
    .update(dispatchId)
    .update('\0')
    .update(impactDigest)
    .digest('hex');
  return `lifecycle:${value}`;
}

function eventFields(
  value: Omit<PluginPackageLifecycleEvent, 'eventDigest'>,
): object {
  return {
    schema: value.schema,
    mutationId: value.mutationId,
    dispatchId: value.dispatchId,
    impact: value.impact,
    actionDigest: value.actionDigest,
    requestedBy: value.requestedBy,
    approvedBy: value.approvedBy,
    authorizationMode: value.authorizationMode,
    occurredAtMs: value.occurredAtMs,
  };
}

export function pluginPackageLifecycleEventDigest(
  value: Omit<PluginPackageLifecycleEvent, 'eventDigest'>,
): string {
  return createHash('sha256')
    .update(EVENT_DIGEST_DOMAIN)
    .update(JSON.stringify(eventFields(value)))
    .digest('hex');
}

function normalizedEventWithoutDigest(
  value: Omit<PluginPackageLifecycleEvent, 'eventDigest'>,
): Omit<PluginPackageLifecycleEvent, 'eventDigest'> {
  if (
    typeof value.authorizationMode !== 'string' ||
    !PLUGIN_PACKAGE_LIFECYCLE_AUTHORIZATION_MODES.includes(
      value.authorizationMode as PluginPackageLifecycleAuthorizationMode,
    )
  ) {
    return invalid('lifecycle authorization mode is invalid');
  }
  const impact = normalizePluginPackageLifecycleImpact(value.impact);
  if (impact.action === 'uninstall' && impact.blockingReferences.length > 0) {
    return invalid('uninstall has blocking references');
  }
  const dispatchId = identifier(value.dispatchId, 'dispatchId');
  const requestedBy = subject(value.requestedBy, 'requestedBy');
  const approvedBy = subject(value.approvedBy, 'approvedBy');
  if (
    (value.authorizationMode === 'human_confirmation' &&
      !sameSubject(requestedBy, approvedBy)) ||
    (value.authorizationMode === 'separation_of_duty' &&
      sameSubject(requestedBy, approvedBy))
  ) {
    return invalid('lifecycle authorization subjects are inconsistent');
  }
  const actionDigest = pluginPackageLifecycleActionDigest(impact);
  if (value.actionDigest !== actionDigest) {
    return invalid('actionDigest does not match lifecycle impact');
  }
  const mutationId = pluginPackageLifecycleMutationId(
    dispatchId,
    impact.impactDigest,
  );
  if (value.mutationId !== mutationId) {
    return invalid('mutationId does not match lifecycle dispatch');
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_LIFECYCLE_EVENT_SCHEMA,
    mutationId,
    dispatchId,
    impact,
    actionDigest,
    requestedBy,
    approvedBy,
    authorizationMode:
      value.authorizationMode as PluginPackageLifecycleAuthorizationMode,
    occurredAtMs: timestamp(value.occurredAtMs, 'occurredAtMs'),
  });
}

export function createPluginPackageLifecycleEvent(
  input: CreatePluginPackageLifecycleEventInput,
): Readonly<PluginPackageLifecycleEvent> {
  const value = dataRecord(input, 'lifecycle event input');
  exactKeys(
    value,
    [
      'approvedBy',
      'authorizationMode',
      'dispatchId',
      'impact',
      'occurredAtMs',
      'requestedBy',
    ],
    'lifecycle event input',
  );
  const impact = normalizePluginPackageLifecycleImpact(input.impact);
  const dispatchId = identifier(input.dispatchId, 'dispatchId');
  const unsigned = normalizedEventWithoutDigest({
    schema: PLUGIN_PACKAGE_LIFECYCLE_EVENT_SCHEMA,
    mutationId: pluginPackageLifecycleMutationId(
      dispatchId,
      impact.impactDigest,
    ),
    dispatchId,
    impact,
    actionDigest: pluginPackageLifecycleActionDigest(impact),
    requestedBy: input.requestedBy,
    approvedBy: input.approvedBy,
    authorizationMode: input.authorizationMode,
    occurredAtMs: input.occurredAtMs,
  });
  return Object.freeze({
    ...unsigned,
    eventDigest: pluginPackageLifecycleEventDigest(unsigned),
  });
}

export function normalizePluginPackageLifecycleEvent(
  value: PluginPackageLifecycleEvent,
): Readonly<PluginPackageLifecycleEvent> {
  const event = dataRecord(value, 'lifecycle event');
  exactKeys(
    event,
    [
      'actionDigest',
      'approvedBy',
      'authorizationMode',
      'dispatchId',
      'eventDigest',
      'impact',
      'mutationId',
      'occurredAtMs',
      'requestedBy',
      'schema',
    ],
    'lifecycle event',
  );
  if (value.schema !== PLUGIN_PACKAGE_LIFECYCLE_EVENT_SCHEMA) {
    return invalid('lifecycle event schema is invalid');
  }
  const unsigned = normalizedEventWithoutDigest(value);
  const eventDigest = pluginPackageLifecycleEventDigest(unsigned);
  if (value.eventDigest !== eventDigest) {
    return invalid('eventDigest does not match lifecycle event');
  }
  return Object.freeze({ ...unsigned, eventDigest });
}

function normalizeTaskTransition(
  value: PluginPackageLifecycleTaskTransition,
  status: PluginPackageLifecycleCapabilityDisposition['status'],
): Readonly<PluginPackageLifecycleTaskTransition> {
  const transition = dataRecord(value, 'task transition');
  exactKeys(
    transition,
    [
      'currentContentDigest',
      'currentEnabled',
      'currentRevision',
      'previousContentDigest',
      'previousEnabled',
      'previousRevision',
      'taskId',
    ],
    'task transition',
  );
  const previousRevision = boundedInteger(
    value.previousRevision,
    'task previousRevision',
    1,
    2_147_483_646,
  );
  const currentRevision = boundedInteger(
    value.currentRevision,
    'task currentRevision',
    2,
    2_147_483_647,
  );
  if (
    currentRevision !== previousRevision + 1 ||
    typeof value.previousEnabled !== 'boolean' ||
    typeof value.currentEnabled !== 'boolean' ||
    (status === 'withdrawn' &&
      (!value.previousEnabled || value.currentEnabled)) ||
    (status === 'restored' &&
      (value.previousEnabled || !value.currentEnabled)) ||
    status === 'retired'
  ) {
    return invalid('task transition does not match capability disposition');
  }
  return Object.freeze({
    taskId: identifier(value.taskId, 'taskId'),
    previousRevision,
    currentRevision,
    previousContentDigest: digest(
      value.previousContentDigest,
      'task previousContentDigest',
    ),
    currentContentDigest: digest(
      value.currentContentDigest,
      'task currentContentDigest',
    ),
    previousEnabled: value.previousEnabled,
    currentEnabled: value.currentEnabled,
  });
}

function normalizeCapability(
  value: PluginPackageLifecycleCapabilityDisposition,
): Readonly<PluginPackageLifecycleCapabilityDisposition> {
  const capability = dataRecord(value, 'capability disposition');
  exactKeys(
    capability,
    [
      'currentActiveVectorDigest',
      'currentToolSnapshotDigest',
      'previousActiveVectorDigest',
      'retainedSourceCount',
      'status',
      'taskTransitions',
    ],
    'capability disposition',
  );
  if (
    value.status !== 'withdrawn' &&
    value.status !== 'restored' &&
    value.status !== 'retired'
  ) {
    return invalid('capability disposition status is invalid');
  }
  if (
    !Array.isArray(value.taskTransitions) ||
    value.taskTransitions.length > MAX_PLUGIN_PACKAGE_LIFECYCLE_TASKS ||
    Object.keys(value.taskTransitions).some(
      (key, index) => key !== String(index),
    )
  ) {
    return invalid('task transitions are invalid');
  }
  if (value.status === 'retired' && value.taskTransitions.length > 0) {
    return invalid('retired capability cannot transition tasks');
  }
  const taskTransitions = value.taskTransitions.map((entry) =>
    normalizeTaskTransition(entry, value.status),
  );
  taskTransitions.sort((left, right) =>
    bytewiseCompare(left.taskId, right.taskId),
  );
  if (
    taskTransitions.some(
      (entry, index) =>
        index > 0 && taskTransitions[index - 1]!.taskId === entry.taskId,
    )
  ) {
    return invalid('task transitions are duplicated');
  }
  const previousActiveVectorDigest = digest(
    value.previousActiveVectorDigest,
    'previousActiveVectorDigest',
  );
  const currentActiveVectorDigest = digest(
    value.currentActiveVectorDigest,
    'currentActiveVectorDigest',
  );
  if (
    (value.status === 'retired' &&
      previousActiveVectorDigest !== currentActiveVectorDigest) ||
    (value.status !== 'retired' &&
      previousActiveVectorDigest === currentActiveVectorDigest)
  ) {
    return invalid('active vector change does not match lifecycle action');
  }
  return Object.freeze({
    status: value.status,
    taskTransitions: Object.freeze(taskTransitions),
    previousActiveVectorDigest,
    currentActiveVectorDigest,
    currentToolSnapshotDigest: digest(
      value.currentToolSnapshotDigest,
      'currentToolSnapshotDigest',
    ),
    retainedSourceCount: boundedInteger(
      value.retainedSourceCount,
      'retainedSourceCount',
      0,
      MAX_PLUGIN_PACKAGE_LIFECYCLE_RETAINED_SOURCES,
    ),
  });
}

function normalizeHead(
  value: PluginPackageLifecycleHead,
): Readonly<PluginPackageLifecycleHead> {
  const head = dataRecord(value, 'lifecycle head');
  exactKeys(
    head,
    [
      'disposition',
      'eventDigest',
      'installationId',
      'installRecordDigest',
      'lockDigest',
      'packageName',
      'projectId',
      'updatedAtMs',
      'version',
    ],
    'lifecycle head',
  );
  if (
    typeof value.disposition !== 'string' ||
    !PLUGIN_PACKAGE_LIFECYCLE_DISPOSITIONS.includes(
      value.disposition as PluginPackageLifecycleDisposition,
    )
  ) {
    return invalid('lifecycle head disposition is invalid');
  }
  return Object.freeze({
    projectId: projectId(value.projectId),
    packageName: packageName(value.packageName),
    installationId: identifier(value.installationId, 'installationId'),
    lockDigest: digest(value.lockDigest, 'lockDigest'),
    installRecordDigest: digest(
      value.installRecordDigest,
      'installRecordDigest',
    ),
    version: boundedInteger(
      value.version,
      'lifecycle version',
      1,
      2_147_483_647,
    ),
    disposition: value.disposition as PluginPackageLifecycleDisposition,
    eventDigest: digest(value.eventDigest, 'lifecycle eventDigest'),
    updatedAtMs: timestamp(value.updatedAtMs, 'lifecycle updatedAtMs'),
  });
}

function receiptFields(
  value: Omit<PluginPackageLifecycleReceipt, 'receiptDigest'>,
): object {
  return {
    schema: value.schema,
    eventDigest: value.eventDigest,
    action: value.action,
    target: value.target,
    lifecycle: value.lifecycle,
    capability: value.capability,
    committedAtMs: value.committedAtMs,
  };
}

export function pluginPackageLifecycleReceiptDigest(
  value: Omit<PluginPackageLifecycleReceipt, 'receiptDigest'>,
): string {
  return createHash('sha256')
    .update(RECEIPT_DIGEST_DOMAIN)
    .update(JSON.stringify(receiptFields(value)))
    .digest('hex');
}

function normalizedReceiptWithoutDigest(
  value: Omit<PluginPackageLifecycleReceipt, 'receiptDigest'>,
): Omit<PluginPackageLifecycleReceipt, 'receiptDigest'> {
  if (
    typeof value.action !== 'string' ||
    !PLUGIN_PACKAGE_LIFECYCLE_ACTIONS.includes(
      value.action as PluginPackageLifecycleAction,
    )
  ) {
    return invalid('lifecycle receipt action is invalid');
  }
  const target = normalizeTarget(value.target);
  const lifecycle = normalizeHead(value.lifecycle);
  const capability = normalizeCapability(value.capability);
  const expectedDisposition =
    value.action === 'enable'
      ? 'active'
      : value.action === 'disable'
      ? 'disabled'
      : 'uninstalled';
  const expectedStatus =
    value.action === 'enable'
      ? 'restored'
      : value.action === 'disable'
      ? 'withdrawn'
      : 'retired';
  if (
    lifecycle.projectId !== target.projectId ||
    lifecycle.packageName !== target.packageName ||
    lifecycle.installationId !== target.installationId ||
    lifecycle.lockDigest !== target.lockDigest ||
    lifecycle.installRecordDigest !== target.installRecordDigest ||
    lifecycle.disposition !== expectedDisposition ||
    capability.status !== expectedStatus
  ) {
    return invalid('receipt lifecycle does not match action target');
  }
  const committedAtMs = timestamp(value.committedAtMs, 'committedAtMs');
  if (lifecycle.updatedAtMs !== committedAtMs) {
    return invalid('lifecycle head time does not match receipt commit');
  }
  const eventDigest = digest(value.eventDigest, 'eventDigest');
  if (lifecycle.eventDigest !== eventDigest) {
    return invalid('lifecycle head event does not match receipt');
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_LIFECYCLE_RECEIPT_SCHEMA,
    eventDigest,
    action: value.action as PluginPackageLifecycleAction,
    target,
    lifecycle,
    capability,
    committedAtMs,
  });
}

export function createPluginPackageLifecycleReceipt(
  input: CreatePluginPackageLifecycleReceiptInput,
): Readonly<PluginPackageLifecycleReceipt> {
  const value = dataRecord(input, 'lifecycle receipt input');
  exactKeys(
    value,
    [
      'action',
      'capability',
      'committedAtMs',
      'eventDigest',
      'lifecycle',
      'target',
    ],
    'lifecycle receipt input',
  );
  const unsigned = normalizedReceiptWithoutDigest({
    ...input,
    schema: PLUGIN_PACKAGE_LIFECYCLE_RECEIPT_SCHEMA,
  });
  return Object.freeze({
    ...unsigned,
    receiptDigest: pluginPackageLifecycleReceiptDigest(unsigned),
  });
}

export function normalizePluginPackageLifecycleReceipt(
  value: PluginPackageLifecycleReceipt,
): Readonly<PluginPackageLifecycleReceipt> {
  const receipt = dataRecord(value, 'lifecycle receipt');
  exactKeys(
    receipt,
    [
      'action',
      'capability',
      'committedAtMs',
      'eventDigest',
      'lifecycle',
      'receiptDigest',
      'schema',
      'target',
    ],
    'lifecycle receipt',
  );
  if (value.schema !== PLUGIN_PACKAGE_LIFECYCLE_RECEIPT_SCHEMA) {
    return invalid('lifecycle receipt schema is invalid');
  }
  const unsigned = normalizedReceiptWithoutDigest(value);
  const receiptDigest = pluginPackageLifecycleReceiptDigest(unsigned);
  if (value.receiptDigest !== receiptDigest) {
    return invalid('receiptDigest does not match lifecycle receipt');
  }
  return Object.freeze({ ...unsigned, receiptDigest });
}

export function assertPluginPackageLifecycleReceiptMatchesEvent(
  eventValue: PluginPackageLifecycleEvent,
  receiptValue: PluginPackageLifecycleReceipt,
): void {
  const event = normalizePluginPackageLifecycleEvent(eventValue);
  const receipt = normalizePluginPackageLifecycleReceipt(receiptValue);
  const nextDisposition = pluginPackageLifecycleNextDisposition(
    event.impact.action,
    event.impact.expected.disposition,
  );
  if (
    receipt.eventDigest !== event.eventDigest ||
    receipt.action !== event.impact.action ||
    JSON.stringify(receipt.target) !== JSON.stringify(event.impact.target) ||
    receipt.lifecycle.version !== event.impact.expected.version + 1 ||
    receipt.lifecycle.disposition !== nextDisposition ||
    receipt.committedAtMs < event.occurredAtMs
  ) {
    invalid('lifecycle receipt does not match event');
  }
}

export function pluginPackageLifecycleTaskMutationId(
  eventDigestValue: string,
  taskIdValue: string,
): string {
  const eventDigest = digest(eventDigestValue, 'eventDigest');
  const taskId = identifier(taskIdValue, 'taskId');
  const value = createHash('sha256')
    .update(TASK_MUTATION_ID_DOMAIN)
    .update(eventDigest)
    .update('\0')
    .update(taskId)
    .digest('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(
    13,
    16,
  )}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
