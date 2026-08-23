import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const MAX_EDGE_LEGACY_ENVIRONMENT_ROWS = 10_000;
export const MAX_STANDALONE_LEGACY_ENVIRONMENT_ROWS = 100_000;
export const MAX_LEGACY_ENVIRONMENT_BINDINGS = 256;
export const MAX_LEGACY_ENVIRONMENT_VALUE_BYTES = 16 * 1024;
export const MAX_LEGACY_ENVIRONMENT_EFFECTIVE_BYTES = 64 * 1024;
export const MAX_EDGE_LEGACY_DISABLED_ENVIRONMENTS = 128;
export const MAX_STANDALONE_LEGACY_DISABLED_ENVIRONMENTS = 512;

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const COLUMNS = Object.freeze([
  'id',
  'name',
  'value',
  'status',
  'isPinned',
  'position',
  'createdAt',
] as const);

type Column = (typeof COLUMNS)[number];
type LegacyRow = Record<Column, unknown>;

export type LegacyEnvironmentTableState =
  | 'absent'
  | 'supported'
  | 'unsupported_schema'
  | 'budget_exceeded';

export type LegacyEnvironmentRowDisposition =
  | 'active_member'
  | 'preserve_disabled'
  | 'manual_required';

export type LegacyEnvironmentRowReason =
  | 'identifier_invalid'
  | 'name_invalid'
  | 'value_invalid'
  | 'status_invalid'
  | 'ordering_metadata_invalid';

export interface LegacyEnvironmentRowInspection {
  readonly rowOrdinal: number;
  readonly sourceDigest: string;
  readonly disposition: LegacyEnvironmentRowDisposition;
  readonly reasons: readonly LegacyEnvironmentRowReason[];
}

export interface LegacyEnvironmentActiveBindingCandidate {
  readonly kind: 'active_binding';
  readonly environmentName: string;
  readonly value: string;
  readonly sourceRowCount: number;
  readonly sourceSetDigest: string;
  readonly candidateDigest: string;
}

export interface LegacyEnvironmentDisabledPreservationCandidate {
  readonly kind: 'disabled_preservation';
  readonly environmentName: string;
  readonly value: string;
  readonly sourceRowOrdinal: number;
  readonly sourceDigest: string;
  readonly candidateDigest: string;
}

export type LegacyEnvironmentCandidate =
  | LegacyEnvironmentActiveBindingCandidate
  | LegacyEnvironmentDisabledPreservationCandidate;

export interface LegacyEnvironmentInventory {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-legacy-environment-inventory';
  readonly profile: 'edge' | 'standalone';
  readonly tableState: LegacyEnvironmentTableState;
  readonly rowCount: number;
  readonly activeRowCount: number;
  readonly disabledRowCount: number;
  readonly manualRowCount: number;
  readonly activeGroupCount: number;
  readonly bindingReadyCount: number;
  readonly preservationReadyCount: number;
  readonly manualGroupCount: number;
  readonly mutationReady: boolean;
  readonly inventoryDigest: string;
}

export interface VisitLegacyEnvironmentOptions {
  readonly profile: 'edge' | 'standalone';
  readonly visitRow?: (row: Readonly<LegacyEnvironmentRowInspection>) => void;
  readonly visitCandidate?: (
    candidate: Readonly<LegacyEnvironmentCandidate>,
  ) => void;
}

export class LegacyEnvironmentInspectionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(`Legacy environment inspection failed: ${message}`);
    this.name = 'LegacyEnvironmentInspectionError';
  }
}

interface ActiveGroup {
  readonly name: string;
  readonly rowDigests: string[];
  readonly values: string[];
  valueBytes: number;
  valid: boolean;
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(value))
    .digest('hex');
}

function scalarEvidence(value: unknown): readonly unknown[] {
  if (value === null) return Object.freeze(['null']);
  if (value === undefined) return Object.freeze(['missing']);
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

function tableNames(client: DatabaseSync): readonly string[] {
  return Object.freeze(
    (
      client
        .prepare(
          `SELECT "name" FROM "sqlite_schema"
           WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'
           ORDER BY "name"`,
        )
        .all() as { readonly name?: unknown }[]
    )
      .map(({ name }) => name)
      .filter((name): name is string => typeof name === 'string'),
  );
}

function columns(client: DatabaseSync): ReadonlySet<string> {
  return new Set(
    (
      client.prepare('PRAGMA table_info("Envs")').all() as {
        readonly name?: unknown;
      }[]
    )
      .map(({ name }) => name)
      .filter((name): name is string => typeof name === 'string'),
  );
}

function rowCount(client: DatabaseSync): number {
  const row = client.prepare('SELECT COUNT(*) AS "count" FROM "Envs"').get() as
    | { readonly count?: unknown }
    | undefined;
  if (!row || !Number.isSafeInteger(row.count) || (row.count as number) < 0) {
    throw new LegacyEnvironmentInspectionError('row count is invalid');
  }
  return row.count as number;
}

function emptyInventory(
  profile: 'edge' | 'standalone',
  tableState: Exclude<LegacyEnvironmentTableState, 'supported'>,
  count: number,
  schemaColumns: readonly string[],
): Readonly<LegacyEnvironmentInventory> {
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'qinglong3-legacy-environment-inventory' as const,
    profile,
    tableState,
    rowCount: count,
    activeRowCount: 0,
    disabledRowCount: 0,
    manualRowCount: count,
    activeGroupCount: 0,
    bindingReadyCount: 0,
    preservationReadyCount: 0,
    manualGroupCount: 0,
    mutationReady: tableState === 'absent',
  });
  return Object.freeze({
    ...payload,
    inventoryDigest: digest(
      'qinglong3.legacy-environment-inventory.v1',
      Object.freeze({ ...payload, schemaColumns }),
    ),
  });
}

function selectSql(schema: ReadonlySet<string>): string {
  const projection = COLUMNS.map((column) => {
    if (schema.has(column)) return `"${column}"`;
    if (column === 'status' || column === 'isPinned') {
      return `0 AS "${column}"`;
    }
    return `NULL AS "${column}"`;
  });
  const pinned = schema.has('isPinned') ? 'COALESCE("isPinned", 0)' : '0';
  const position = schema.has('position') ? '"position"' : 'NULL';
  const createdAt = schema.has('createdAt') ? '"createdAt"' : 'NULL';
  return `SELECT ${projection.join(', ')} FROM "Envs"
    ORDER BY ${pinned} DESC, ${position} DESC, ${createdAt} ASC, "id" ASC`;
}

function* iterateRows(
  client: DatabaseSync,
  schema: ReadonlySet<string>,
): Iterable<LegacyRow> {
  let iterator: Iterator<Record<string, unknown>>;
  try {
    iterator = client
      .prepare(selectSql(schema))
      .iterate()
      [Symbol.iterator]() as Iterator<Record<string, unknown>>;
  } catch (error) {
    throw new LegacyEnvironmentInspectionError('rows are unavailable', error);
  }
  for (;;) {
    let next: IteratorResult<Record<string, unknown>>;
    try {
      next = iterator.next();
    } catch (error) {
      throw new LegacyEnvironmentInspectionError('rows cannot be read', error);
    }
    if (next.done) return;
    yield next.value as LegacyRow;
  }
}

function reasons(row: LegacyRow): readonly LegacyEnvironmentRowReason[] {
  const selected: LegacyEnvironmentRowReason[] = [];
  if (!Number.isSafeInteger(row.id) || (row.id as number) < 1) {
    selected.push('identifier_invalid');
  }
  if (
    typeof row.name !== 'string' ||
    !ENVIRONMENT_NAME.test(row.name) ||
    row.name.startsWith('QL3_')
  ) {
    selected.push('name_invalid');
  }
  if (
    typeof row.value !== 'string' ||
    row.value.includes('\0') ||
    Buffer.byteLength(row.value, 'utf8') > MAX_LEGACY_ENVIRONMENT_VALUE_BYTES
  ) {
    selected.push('value_invalid');
  }
  if (row.status !== 0 && row.status !== 1) selected.push('status_invalid');
  if (
    (row.isPinned !== 0 && row.isPinned !== 1) ||
    (row.position !== null &&
      (typeof row.position !== 'number' || !Number.isFinite(row.position))) ||
    (row.createdAt !== null &&
      (typeof row.createdAt !== 'string' ||
        row.createdAt.includes('\0') ||
        Buffer.byteLength(row.createdAt, 'utf8') > 128))
  ) {
    selected.push('ordering_metadata_invalid');
  }
  return Object.freeze(selected);
}

function sourceDigest(row: LegacyRow): string {
  return digest(
    'qinglong3.legacy-environment-row.v1',
    COLUMNS.map((column) => [column, scalarEvidence(row[column])]),
  );
}

function candidateDigest(
  candidate: Omit<LegacyEnvironmentCandidate, 'value' | 'candidateDigest'>,
  value: string,
): string {
  return digest('qinglong3.legacy-environment-candidate.v1', {
    ...candidate,
    environmentNameDigest: digest(
      'qinglong3.legacy-environment-name.v1',
      candidate.environmentName,
    ),
    environmentName: undefined,
    valueBytes: Buffer.byteLength(value, 'utf8'),
    valueDigest: createHash('sha256').update(value).digest('hex'),
  });
}

export function visitLegacyEnvironmentAdoption(
  client: DatabaseSync,
  options: Readonly<VisitLegacyEnvironmentOptions>,
): Readonly<LegacyEnvironmentInventory> {
  if (
    !client ||
    typeof client !== 'object' ||
    !options ||
    typeof options !== 'object' ||
    (options.profile !== 'edge' && options.profile !== 'standalone') ||
    (options.visitRow !== undefined &&
      typeof options.visitRow !== 'function') ||
    (options.visitCandidate !== undefined &&
      typeof options.visitCandidate !== 'function')
  ) {
    throw new LegacyEnvironmentInspectionError('options are invalid');
  }
  const names = tableNames(client);
  if (!names.includes('Envs')) {
    return emptyInventory(options.profile, 'absent', 0, []);
  }
  const schema = columns(client);
  const orderedSchema = [...schema].sort();
  let count: number;
  try {
    count = rowCount(client);
  } catch (error) {
    if (error instanceof LegacyEnvironmentInspectionError) throw error;
    throw new LegacyEnvironmentInspectionError(
      'row count is unavailable',
      error,
    );
  }
  if (!['id', 'name', 'value'].every((column) => schema.has(column))) {
    return emptyInventory(
      options.profile,
      'unsupported_schema',
      count,
      orderedSchema,
    );
  }
  const maximumRows =
    options.profile === 'edge'
      ? MAX_EDGE_LEGACY_ENVIRONMENT_ROWS
      : MAX_STANDALONE_LEGACY_ENVIRONMENT_ROWS;
  if (count > maximumRows) {
    return emptyInventory(
      options.profile,
      'budget_exceeded',
      count,
      orderedSchema,
    );
  }

  const inventoryHash = createHash('sha256')
    .update('qinglong3.legacy-environment-inventory.v1\0')
    .update(
      JSON.stringify({ profile: options.profile, schema: orderedSchema }),
    );
  const groups = new Map<string, ActiveGroup>();
  const invalidActiveGroupDigests = new Set<string>();
  const disabledLimit =
    options.profile === 'edge'
      ? MAX_EDGE_LEGACY_DISABLED_ENVIRONMENTS
      : MAX_STANDALONE_LEGACY_DISABLED_ENVIRONMENTS;
  let rowOrdinal = 0;
  let activeRowCount = 0;
  let disabledRowCount = 0;
  let manualRowCount = 0;
  let preservationReadyCount = 0;
  let activeValueBytes = 0;

  for (const raw of iterateRows(client, schema)) {
    rowOrdinal += 1;
    const digestValue = sourceDigest(raw);
    const rowReasons = reasons(raw);
    let disposition: LegacyEnvironmentRowDisposition = 'manual_required';
    if (rowReasons.length === 0 && raw.status === 0) {
      disposition = 'active_member';
      activeRowCount += 1;
    } else if (rowReasons.length === 0 && raw.status === 1) {
      disposition = 'preserve_disabled';
      disabledRowCount += 1;
      preservationReadyCount += 1;
    } else {
      manualRowCount += 1;
      if (raw.status === 0) activeRowCount += 1;
      if (raw.status === 1) disabledRowCount += 1;
    }
    const inspection = Object.freeze({
      rowOrdinal,
      sourceDigest: digestValue,
      disposition,
      reasons: rowReasons,
    });
    options.visitRow?.(inspection);
    inventoryHash.update('\0row\0').update(JSON.stringify(inspection));

    if (raw.status !== 0) continue;
    if (
      typeof raw.name !== 'string' ||
      !ENVIRONMENT_NAME.test(raw.name) ||
      raw.name.startsWith('QL3_')
    ) {
      invalidActiveGroupDigests.add(
        digest(
          'qinglong3.legacy-environment-invalid-name.v1',
          scalarEvidence(raw.name),
        ),
      );
      continue;
    }
    let group = groups.get(raw.name);
    if (!group) {
      group = {
        name: raw.name,
        rowDigests: [],
        values: [],
        valueBytes: 0,
        valid: true,
      };
      groups.set(raw.name, group);
    }
    group.rowDigests.push(digestValue);
    if (rowReasons.length > 0 || typeof raw.value !== 'string') {
      group.valid = false;
      group.values.length = 0;
      continue;
    }
    const valueBytes = Buffer.byteLength(raw.value, 'utf8');
    const separatorBytes = group.values.length === 0 ? 0 : 1;
    group.valueBytes += valueBytes + separatorBytes;
    activeValueBytes += valueBytes + separatorBytes;
    if (
      group.valueBytes > MAX_LEGACY_ENVIRONMENT_VALUE_BYTES ||
      activeValueBytes > MAX_LEGACY_ENVIRONMENT_EFFECTIVE_BYTES
    ) {
      group.valid = false;
      group.values.length = 0;
    } else if (group.valid) {
      group.values.push(raw.value);
    }
  }
  if (rowOrdinal !== count) {
    throw new LegacyEnvironmentInspectionError('row count drifted');
  }

  const activeGroupCount = groups.size + invalidActiveGroupDigests.size;
  const globalBudgetExceeded =
    activeGroupCount > MAX_LEGACY_ENVIRONMENT_BINDINGS ||
    activeValueBytes > MAX_LEGACY_ENVIRONMENT_EFFECTIVE_BYTES ||
    preservationReadyCount > disabledLimit;
  let bindingReadyCount = 0;
  let manualGroupCount = invalidActiveGroupDigests.size;
  if (!globalBudgetExceeded) {
    for (const group of [...groups.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!group.valid || group.values.length !== group.rowDigests.length) {
        manualGroupCount += 1;
        continue;
      }
      const value = group.values.join('&');
      const base = Object.freeze({
        kind: 'active_binding' as const,
        environmentName: group.name,
        sourceRowCount: group.rowDigests.length,
        sourceSetDigest: digest(
          'qinglong3.legacy-environment-source-set.v1',
          group.rowDigests,
        ),
      });
      const candidate = Object.freeze({
        ...base,
        value,
        candidateDigest: candidateDigest(base, value),
      });
      bindingReadyCount += 1;
      options.visitCandidate?.(candidate);
      inventoryHash.update('\0candidate\0').update(candidate.candidateDigest);
    }
  } else {
    manualGroupCount = activeGroupCount;
    bindingReadyCount = 0;
    preservationReadyCount = 0;
  }

  if (!globalBudgetExceeded && preservationReadyCount > 0) {
    rowOrdinal = 0;
    for (const raw of iterateRows(client, schema)) {
      rowOrdinal += 1;
      if (raw.status !== 1 || reasons(raw).length !== 0) continue;
      const digestValue = sourceDigest(raw);
      const base = Object.freeze({
        kind: 'disabled_preservation' as const,
        environmentName: raw.name as string,
        sourceRowOrdinal: rowOrdinal,
        sourceDigest: digestValue,
      });
      const value = raw.value as string;
      const candidate = Object.freeze({
        ...base,
        value,
        candidateDigest: candidateDigest(base, value),
      });
      options.visitCandidate?.(candidate);
      inventoryHash.update('\0candidate\0').update(candidate.candidateDigest);
    }
  }

  const mutationReady =
    !globalBudgetExceeded && manualRowCount === 0 && manualGroupCount === 0;
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'qinglong3-legacy-environment-inventory' as const,
    profile: options.profile,
    tableState: 'supported' as const,
    rowCount: count,
    activeRowCount,
    disabledRowCount,
    manualRowCount,
    activeGroupCount,
    bindingReadyCount,
    preservationReadyCount,
    manualGroupCount,
    mutationReady,
  });
  inventoryHash.update('\0summary\0').update(JSON.stringify(payload));
  return Object.freeze({
    ...payload,
    inventoryDigest: inventoryHash.digest('hex'),
  });
}
