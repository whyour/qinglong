// Legacy Adoption owns bounded inspection and semantic classification of legacy crontab rows.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
  createBuiltInTaskSpecSemanticRegistry,
} from '@qinglong/runtime-core/task-spec-semantic';
import type { TaskDefinitionSpec } from '@qinglong/runtime-core/task-definition';
import {
  BUILT_IN_CRON_TRIGGER_SPEC_SCHEMA,
  createBuiltInTriggerSpecSemanticRegistry,
  type TriggerSpec,
} from '@qinglong/runtime-core/trigger';

export const MAX_LEGACY_CRONTAB_ROWS = 100_000;
export const MAX_LEGACY_CRONTAB_DIAGNOSTIC_PAGE_SIZE = 128;

export const LEGACY_CRONTAB_ADOPTION_CLASSIFICATIONS = Object.freeze([
  'lossless',
  'requires_shell_compatibility',
  'requires_manual_action',
  'malformed',
] as const);

export const LEGACY_CRONTAB_ADOPTION_REASONS = Object.freeze([
  'legacy_id_invalid',
  'command_invalid',
  'legacy_field_invalid',
  'schedule_invalid',
  'extra_schedules_invalid',
  'timezone_required',
  'schedule_once_unsupported',
  'schedule_boot_unsupported',
  'schedule_macro_unsupported',
  'concurrency_policy_unmodeled',
  'system_task_requires_review',
  'labels_require_mapping',
  'subscription_binding_requires_mapping',
  'legacy_task_wrapper_required',
  'task_hooks_require_shell_compatibility',
  'work_directory_requires_shell_compatibility',
  'log_name_requires_shell_compatibility',
] as const);

export type LegacyCrontabAdoptionClassification =
  (typeof LEGACY_CRONTAB_ADOPTION_CLASSIFICATIONS)[number];
export type LegacyCrontabAdoptionReason =
  (typeof LEGACY_CRONTAB_ADOPTION_REASONS)[number];

export interface LegacyCrontabAdoptionClassificationCounts {
  readonly lossless: number;
  readonly requires_shell_compatibility: number;
  readonly requires_manual_action: number;
  readonly malformed: number;
}

export interface LegacyCrontabAdoptionInventory {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-legacy-crontab-adoption-inventory';
  readonly timezone: string | null;
  readonly rowCount: number;
  readonly classifications: LegacyCrontabAdoptionClassificationCounts;
  readonly inventoryDigest: string;
  readonly mutationReady: boolean;
}

export interface LegacyCrontabAdoptionDiagnostic {
  readonly rowOrdinal: number;
  readonly legacyId: number | null;
  readonly taskId: string | null;
  readonly classification: LegacyCrontabAdoptionClassification;
  readonly reasons: readonly LegacyCrontabAdoptionReason[];
  readonly enabled: boolean | null;
  readonly triggerCount: number;
  readonly sourceDigest: string;
  readonly taskSpecDigest?: string;
  readonly triggerSpecDigests?: readonly string[];
}

export interface LegacyCrontabAdoptionDiagnosticCursor {
  readonly rowOrdinal: number;
}

export interface LegacyCrontabAdoptionDiagnosticPage {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-legacy-crontab-adoption-diagnostics';
  readonly timezone: string | null;
  readonly diagnostics: readonly LegacyCrontabAdoptionDiagnostic[];
  readonly truncated: boolean;
  readonly next?: LegacyCrontabAdoptionDiagnosticCursor;
  readonly inventory: LegacyCrontabAdoptionInventory;
}

export interface LegacyCrontabAdoptionCandidate {
  readonly rowOrdinal: number;
  readonly sourceDigest: string;
  readonly task: Readonly<{
    taskId: string;
    name: string;
    kind: 'command';
    spec: TaskDefinitionSpec;
    labels: Readonly<Record<string, string>>;
    enabled: boolean;
  }>;
  readonly triggers: readonly Readonly<{
    triggerId: string;
    spec: TriggerSpec;
    enabled: boolean;
  }>[];
}

export interface LegacyCrontabAdoptionInspection {
  readonly diagnostic: LegacyCrontabAdoptionDiagnostic;
  readonly candidate?: LegacyCrontabAdoptionCandidate;
}

export class LegacyCrontabAdoptionClassificationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(`Legacy Crontab adoption classification failed: ${message}`);
    this.name = 'LegacyCrontabAdoptionClassificationError';
  }
}

const CONFIGURATION_COLUMNS = Object.freeze([
  'id',
  'name',
  'command',
  'schedule',
  'saved',
  'isSystem',
  'isDisabled',
  'isPinned',
  'labels',
  'sub_id',
  'extra_schedules',
  'task_before',
  'task_after',
  'log_name',
  'allow_multiple_instances',
  'work_dir',
] as const);
const CRON_FIELD_PATTERN = /^[0-9A-Za-z*,/#LW-]+$/;
const taskSpecRegistry = createBuiltInTaskSpecSemanticRegistry();
const triggerSpecRegistry = createBuiltInTriggerSpecSemanticRegistry();

type ConfigurationColumn = (typeof CONFIGURATION_COLUMNS)[number];
type LegacyRow = Record<ConfigurationColumn, unknown>;

function sha256Json(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(value))
    .digest('hex');
}

function scalarEvidence(value: unknown): readonly unknown[] {
  if (value === null) return Object.freeze(['null']);
  if (typeof value === 'string') {
    return Object.freeze([
      'text',
      Buffer.byteLength(value, 'utf8'),
      createHash('sha256').update(value).digest('hex'),
    ]);
  }
  if (typeof value === 'number') {
    return Object.freeze([
      'number',
      Number.isFinite(value)
        ? String(Object.is(value, -0) ? 0 : value)
        : 'invalid',
    ]);
  }
  if (typeof value === 'bigint') {
    return Object.freeze(['bigint', value.toString()]);
  }
  if (value instanceof Uint8Array) {
    return Object.freeze([
      'blob',
      value.byteLength,
      createHash('sha256').update(value).digest('hex'),
    ]);
  }
  return Object.freeze(['unsupported', typeof value]);
}

function sourceDigest(row: LegacyRow): string {
  return sha256Json(
    'qinglong3.legacy-crontab-source.v1',
    CONFIGURATION_COLUMNS.map((column) => [
      column,
      scalarEvidence(row[column]),
    ]),
  );
}

export function normalizeLegacyAdoptionTimezone(
  value: string | undefined,
): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    value.includes('\0')
  ) {
    throw new LegacyCrontabAdoptionClassificationError(
      'legacyTimezone is invalid',
    );
  }
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch (error) {
    throw new LegacyCrontabAdoptionClassificationError(
      'legacyTimezone is unsupported',
      error,
    );
  }
}

function selectSql(client: DatabaseSync): string {
  const columns = new Set(
    (
      client.prepare('PRAGMA table_info("Crontabs")').all() as {
        name?: unknown;
      }[]
    )
      .map(({ name }) => name)
      .filter((name): name is string => typeof name === 'string'),
  );
  for (const required of ['id', 'command', 'schedule']) {
    if (!columns.has(required)) {
      throw new LegacyCrontabAdoptionClassificationError(
        `legacy column Crontabs.${required} is missing`,
      );
    }
  }
  const projections = CONFIGURATION_COLUMNS.map((column) =>
    columns.has(column) ? `"${column}"` : `NULL AS "${column}"`,
  );
  return `SELECT ${projections.join(', ')} FROM "Crontabs" ORDER BY "id"`;
}

function validLegacyId(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

function optionalText(
  value: unknown,
  maximumBytes: number,
): string | null | undefined {
  if (value === null) return undefined;
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    return null;
  }
  return value;
}

function flag(value: unknown): boolean | null | undefined {
  if (value === null) return undefined;
  if (value === 0) return false;
  if (value === 1) return true;
  return null;
}

function parseJson(value: unknown): unknown | undefined {
  if (value === null) return undefined;
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 64 * 1024
  ) {
    return Symbol.for('invalid-legacy-json');
  }
  try {
    return JSON.parse(value);
  } catch {
    return Symbol.for('invalid-legacy-json');
  }
}

function scheduleReason(
  expression: string,
): LegacyCrontabAdoptionReason | null {
  if (expression === '@once') return 'schedule_once_unsupported';
  if (expression === '@boot') return 'schedule_boot_unsupported';
  if (expression.startsWith('@')) return 'schedule_macro_unsupported';
  const fields = expression.trim().split(/\s+/u);
  if (
    (fields.length !== 5 && fields.length !== 6) ||
    fields.some(
      (field) =>
        field.length < 1 ||
        Buffer.byteLength(field, 'utf8') > 128 ||
        field.includes('?') ||
        field.startsWith('/') ||
        !CRON_FIELD_PATTERN.test(field),
    )
  ) {
    return 'schedule_invalid';
  }
  return null;
}

function quoteShellValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellAssignment(
  name: string,
  value: string | number | boolean,
): string {
  return `${name}=${quoteShellValue(String(value))}`;
}

function normalizeHook(value: string): string {
  return value.replace(/;? *\r?\n/g, ';').trim();
}

function compatibilityCommand(
  id: number,
  command: string,
  values: Readonly<{
    taskBefore?: string;
    taskAfter?: string;
    logName?: string;
    workDirectory?: string;
  }>,
): string {
  const assignments = [
    shellAssignment('real_time', true),
    shellAssignment('no_tee', true),
    shellAssignment('ID', id),
  ];
  if (values.logName)
    assignments.push(shellAssignment('log_name', values.logName));
  if (values.taskBefore) {
    assignments.push(
      shellAssignment('task_before', normalizeHook(values.taskBefore)),
    );
  }
  if (values.taskAfter) {
    assignments.push(
      shellAssignment('task_after', normalizeHook(values.taskAfter)),
    );
  }
  if (values.workDirectory) {
    assignments.push(shellAssignment('work_dir', values.workDirectory));
  }
  const trimmed = command.trim();
  const executable =
    trimmed.startsWith('task ') || trimmed.startsWith('ql ')
      ? trimmed
      : `task ${trimmed}`;
  return `${assignments.join(' ')} ${executable}`;
}

function classificationFor(
  reasons: ReadonlySet<LegacyCrontabAdoptionReason>,
): LegacyCrontabAdoptionClassification {
  if (
    [...reasons].some((reason) =>
      [
        'legacy_id_invalid',
        'command_invalid',
        'legacy_field_invalid',
        'schedule_invalid',
        'extra_schedules_invalid',
      ].includes(reason),
    )
  ) {
    return 'malformed';
  }
  if (
    [...reasons].some((reason) =>
      [
        'timezone_required',
        'schedule_once_unsupported',
        'schedule_boot_unsupported',
        'schedule_macro_unsupported',
        'concurrency_policy_unmodeled',
        'system_task_requires_review',
        'labels_require_mapping',
        'subscription_binding_requires_mapping',
      ].includes(reason),
    )
  ) {
    return 'requires_manual_action';
  }
  return reasons.size > 0 ? 'requires_shell_compatibility' : 'lossless';
}

function classifyRow(
  row: LegacyRow,
  rowOrdinal: number,
  timezone: string | null,
): LegacyCrontabAdoptionInspection {
  const reasons = new Set<LegacyCrontabAdoptionReason>();
  const legacyId = validLegacyId(row.id);
  if (legacyId === null) reasons.add('legacy_id_invalid');

  const legacyName = optionalText(row.name, 255);
  if (
    legacyName === null ||
    (typeof legacyName === 'string' &&
      /[\u0000-\u001f\u007f-\u009f]/u.test(legacyName))
  ) {
    reasons.add('legacy_field_invalid');
  }

  const command = optionalText(row.command, 64 * 1024);
  if (command === null || command === undefined || command.trim().length < 1) {
    reasons.add('command_invalid');
  }
  const taskBefore = optionalText(row.task_before, 16 * 1024);
  const taskAfter = optionalText(row.task_after, 16 * 1024);
  const logName = optionalText(row.log_name, 4096);
  const workDirectory = optionalText(row.work_dir, 4096);
  if ([taskBefore, taskAfter, logName, workDirectory].includes(null)) {
    reasons.add('legacy_field_invalid');
  }
  if (taskBefore) reasons.add('task_hooks_require_shell_compatibility');
  if (taskAfter) reasons.add('task_hooks_require_shell_compatibility');
  if (logName) reasons.add('log_name_requires_shell_compatibility');
  if (workDirectory) reasons.add('work_directory_requires_shell_compatibility');
  if (
    typeof command === 'string' &&
    command.trim().length > 0 &&
    !command.trim().startsWith('task ') &&
    !command.trim().startsWith('ql ')
  ) {
    reasons.add('legacy_task_wrapper_required');
  }

  const booleanFields = [row.saved, row.isSystem, row.isDisabled, row.isPinned];
  if (booleanFields.some((value) => flag(value) === null)) {
    reasons.add('legacy_field_invalid');
  }
  if (flag(row.isSystem) === true) reasons.add('system_task_requires_review');
  const pinned = flag(row.isPinned);
  const enabledFlag = flag(row.isDisabled);
  const enabled = enabledFlag === null ? null : enabledFlag !== true;

  if (row.sub_id !== null) {
    if (!Number.isSafeInteger(row.sub_id) || (row.sub_id as number) < 1) {
      reasons.add('legacy_field_invalid');
    } else {
      reasons.add('subscription_binding_requires_mapping');
    }
  }

  const concurrency = flag(row.allow_multiple_instances);
  if (concurrency === null) reasons.add('legacy_field_invalid');
  if (concurrency !== undefined && concurrency !== null) {
    reasons.add('concurrency_policy_unmodeled');
  }

  const legacyLabels = parseJson(row.labels);
  if (
    typeof legacyLabels === 'symbol' ||
    (legacyLabels !== undefined &&
      (!Array.isArray(legacyLabels) ||
        legacyLabels.some((label) => typeof label !== 'string')))
  ) {
    reasons.add('legacy_field_invalid');
  } else if (Array.isArray(legacyLabels) && legacyLabels.length > 0) {
    reasons.add('labels_require_mapping');
  }

  const schedules: string[] = [];
  const primarySchedule = optionalText(row.schedule, 1024);
  if (
    primarySchedule === null ||
    primarySchedule === undefined ||
    primarySchedule.trim().length < 1
  ) {
    reasons.add('schedule_invalid');
  } else {
    schedules.push(primarySchedule.trim());
  }
  const extraSchedules = parseJson(row.extra_schedules);
  if (
    typeof extraSchedules === 'symbol' ||
    (extraSchedules !== undefined && !Array.isArray(extraSchedules))
  ) {
    reasons.add('extra_schedules_invalid');
  } else if (Array.isArray(extraSchedules)) {
    if (extraSchedules.length > 64) {
      reasons.add('extra_schedules_invalid');
    } else {
      for (const entry of extraSchedules) {
        if (
          !entry ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          Object.keys(entry).length !== 1 ||
          typeof (entry as { schedule?: unknown }).schedule !== 'string' ||
          Buffer.byteLength((entry as { schedule: string }).schedule, 'utf8') >
            1024
        ) {
          reasons.add('extra_schedules_invalid');
          continue;
        }
        schedules.push((entry as { schedule: string }).schedule.trim());
      }
    }
  }

  for (const expression of schedules) {
    const reason = scheduleReason(expression);
    if (reason) reasons.add(reason);
  }
  if (
    timezone === null &&
    schedules.some((value) => scheduleReason(value) === null)
  ) {
    reasons.add('timezone_required');
  }
  const validTriggerCount = schedules.filter(
    (value) => scheduleReason(value) === null,
  ).length;

  const taskId = legacyId === null ? null : `legacy-cron:${legacyId}`;
  let taskSpec: TaskDefinitionSpec | undefined;
  let taskSpecDigest: string | undefined;
  if (
    taskId &&
    legacyId !== null &&
    typeof command === 'string' &&
    command.trim().length > 0 &&
    !reasons.has('legacy_field_invalid')
  ) {
    try {
      taskSpec = taskSpecRegistry.normalize({
        projectId: 'legacy-adoption',
        taskId,
        kind: 'command',
        spec: {
          schema: BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
          config: {
            command: {
              kind: 'shell',
              command: compatibilityCommand(legacyId, command, {
                ...(taskBefore ? { taskBefore } : {}),
                ...(taskAfter ? { taskAfter } : {}),
                ...(logName ? { logName } : {}),
                ...(workDirectory ? { workDirectory } : {}),
              }),
              shell: '/bin/bash',
            },
          },
        },
      });
      taskSpecDigest = sha256Json('qinglong3.legacy-task-spec.v1', taskSpec);
    } catch {
      reasons.add('command_invalid');
    }
  }

  const triggerCandidates: {
    triggerId: string;
    spec: TriggerSpec;
    enabled: boolean;
  }[] = [];
  const triggerSpecDigests: string[] = [];
  if (taskId && timezone !== null) {
    for (const [index, expression] of schedules.entries()) {
      if (scheduleReason(expression) !== null) continue;
      try {
        const triggerId = `${taskId}:cron:${index + 1}`;
        const spec = triggerSpecRegistry.normalize({
          projectId: 'legacy-adoption',
          triggerId,
          taskId,
          taskRevision: 1,
          spec: {
            schema: BUILT_IN_CRON_TRIGGER_SPEC_SCHEMA,
            config: { expression, timezone, misfirePolicy: 'skip' },
          },
        });
        triggerSpecDigests.push(
          sha256Json('qinglong3.legacy-trigger-spec.v1', spec),
        );
        triggerCandidates.push({
          triggerId,
          spec,
          enabled: enabled === true,
        });
      } catch {
        reasons.add('schedule_invalid');
      }
    }
  }

  const orderedReasons = LEGACY_CRONTAB_ADOPTION_REASONS.filter((reason) =>
    reasons.has(reason),
  );
  const classification = classificationFor(reasons);
  const digest = sourceDigest(row);
  const diagnostic = Object.freeze({
    rowOrdinal,
    legacyId,
    taskId,
    classification,
    reasons: Object.freeze(orderedReasons),
    enabled,
    triggerCount: validTriggerCount,
    sourceDigest: digest,
    ...(taskSpecDigest === undefined ? {} : { taskSpecDigest }),
    ...(triggerSpecDigests.length === 0
      ? {}
      : { triggerSpecDigests: Object.freeze(triggerSpecDigests) }),
  });
  if (
    taskId === null ||
    taskSpec === undefined ||
    enabled === null ||
    validTriggerCount !== schedules.length ||
    triggerCandidates.length !== schedules.length ||
    (classification !== 'lossless' &&
      classification !== 'requires_shell_compatibility')
  ) {
    return Object.freeze({ diagnostic });
  }
  const candidateLabels = Object.freeze({
    ...(pinned === true ? { 'qinglong.io/legacy-pinned': 'true' } : {}),
  });
  return Object.freeze({
    diagnostic,
    candidate: Object.freeze({
      rowOrdinal,
      sourceDigest: digest,
      task: Object.freeze({
        taskId,
        name:
          typeof legacyName === 'string' && legacyName.trim().length > 0
            ? legacyName.trim()
            : `Legacy Crontab ${legacyId}`,
        kind: 'command' as const,
        spec: taskSpec,
        labels: candidateLabels,
        enabled,
      }),
      triggers: Object.freeze(
        triggerCandidates.map((trigger) => Object.freeze(trigger)),
      ),
    }),
  });
}

export function visitLegacyCrontabAdoptionInspections(
  client: DatabaseSync,
  timezone: string | null,
  visitor: (inspection: LegacyCrontabAdoptionInspection) => void,
): LegacyCrontabAdoptionInventory {
  if (typeof visitor !== 'function') {
    throw new LegacyCrontabAdoptionClassificationError(
      'diagnostic visitor is invalid',
    );
  }
  const counts: Record<LegacyCrontabAdoptionClassification, number> = {
    lossless: 0,
    requires_shell_compatibility: 0,
    requires_manual_action: 0,
    malformed: 0,
  };
  const hash = createHash('sha256')
    .update('qinglong3.legacy-crontab-inventory.v1\0')
    .update(JSON.stringify({ timezone }));
  let rowCount = 0;
  for (const inspection of iterateLegacyCrontabAdoptionInspections(
    client,
    timezone,
  )) {
    rowCount += 1;
    const { diagnostic } = inspection;
    counts[diagnostic.classification] += 1;
    hash.update('\0').update(
      JSON.stringify({
        rowOrdinal: diagnostic.rowOrdinal,
        sourceDigest: diagnostic.sourceDigest,
        classification: diagnostic.classification,
        reasons: diagnostic.reasons,
        enabled: diagnostic.enabled,
        triggerCount: diagnostic.triggerCount,
        taskSpecDigest: diagnostic.taskSpecDigest ?? null,
        triggerSpecDigests: diagnostic.triggerSpecDigests ?? [],
      }),
    );
    visitor(inspection);
  }
  const classifications = Object.freeze({ ...counts });
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'qinglong3-legacy-crontab-adoption-inventory' as const,
    timezone,
    rowCount,
    classifications,
    inventoryDigest: hash.digest('hex'),
    mutationReady:
      counts.requires_shell_compatibility === 0 &&
      counts.requires_manual_action === 0 &&
      counts.malformed === 0,
  });
}

export function* iterateLegacyCrontabAdoptionInspections(
  client: DatabaseSync,
  timezone: string | null,
): Iterable<LegacyCrontabAdoptionInspection> {
  let rowOrdinal = 0;
  for (const value of client
    .prepare(selectSql(client))
    .iterate() as Iterable<LegacyRow>) {
    rowOrdinal += 1;
    if (rowOrdinal > MAX_LEGACY_CRONTAB_ROWS) {
      throw new LegacyCrontabAdoptionClassificationError(
        `Crontabs row budget exceeds ${MAX_LEGACY_CRONTAB_ROWS}`,
      );
    }
    yield classifyRow(value, rowOrdinal, timezone);
  }
}

export function visitLegacyCrontabAdoptionDiagnostics(
  client: DatabaseSync,
  timezone: string | null,
  visitor: (diagnostic: LegacyCrontabAdoptionDiagnostic) => void,
): LegacyCrontabAdoptionInventory {
  return visitLegacyCrontabAdoptionInspections(
    client,
    timezone,
    ({ diagnostic }) => visitor(diagnostic),
  );
}

export function inspectLegacyCrontabInventory(
  client: DatabaseSync,
  timezone: string | null,
): LegacyCrontabAdoptionInventory {
  return visitLegacyCrontabAdoptionDiagnostics(client, timezone, () => {});
}

export function inspectLegacyCrontabDiagnosticPage(
  client: DatabaseSync,
  timezone: string | null,
  options: Readonly<{ afterRowOrdinal?: number; limit?: number }> = {},
): LegacyCrontabAdoptionDiagnosticPage {
  const afterRowOrdinal = options.afterRowOrdinal ?? 0;
  const limit = options.limit ?? MAX_LEGACY_CRONTAB_DIAGNOSTIC_PAGE_SIZE;
  if (
    !Number.isSafeInteger(afterRowOrdinal) ||
    afterRowOrdinal < 0 ||
    afterRowOrdinal > MAX_LEGACY_CRONTAB_ROWS ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LEGACY_CRONTAB_DIAGNOSTIC_PAGE_SIZE
  ) {
    throw new LegacyCrontabAdoptionClassificationError(
      'diagnostic cursor or page size is invalid',
    );
  }
  const diagnostics: LegacyCrontabAdoptionDiagnostic[] = [];
  const inventory = visitLegacyCrontabAdoptionDiagnostics(
    client,
    timezone,
    (diagnostic) => {
      if (
        diagnostic.rowOrdinal > afterRowOrdinal &&
        diagnostics.length < limit
      ) {
        diagnostics.push(diagnostic);
      }
    },
  );
  const last = diagnostics.at(-1);
  const truncated = inventory.rowCount > afterRowOrdinal + diagnostics.length;
  return Object.freeze({
    schemaVersion: 1,
    kind: 'qinglong3-legacy-crontab-adoption-diagnostics',
    timezone,
    diagnostics: Object.freeze(diagnostics),
    truncated,
    ...(truncated && last
      ? { next: Object.freeze({ rowOrdinal: last.rowOrdinal }) }
      : {}),
    inventory,
  });
}
