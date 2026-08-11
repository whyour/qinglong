import {
  InvalidPluginPackagePromptExecutionPlanError,
  PluginPackagePromptAdmissionConflictError,
  PluginPackagePromptAdmissionNotAllowedError,
  PluginPackagePromptAdmissionUnavailableError,
  PluginPackagePromptExecutionInProgressError,
  PluginPackagePromptResolutionRequiredError,
} from '../pluginPackagePromptExecution';

export type Row = Record<string, unknown>;
export type AdmissionColumn = 'request_id' | 'invocation_id';

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function unavailable(
  cause?: unknown,
): PluginPackagePromptAdmissionUnavailableError {
  return new PluginPackagePromptAdmissionUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

export function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    throw new InvalidPluginPackagePromptExecutionPlanError(
      `${label} is invalid`,
    );
  }
  return value;
}

export function sqlState(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function mapStorageError(error: unknown): Error {
  if (
    error instanceof InvalidPluginPackagePromptExecutionPlanError ||
    error instanceof PluginPackagePromptAdmissionConflictError ||
    error instanceof PluginPackagePromptAdmissionNotAllowedError ||
    error instanceof PluginPackagePromptAdmissionUnavailableError ||
    error instanceof PluginPackagePromptExecutionInProgressError ||
    error instanceof PluginPackagePromptResolutionRequiredError
  ) {
    return error;
  }
  if (['23503', '23505', '23514'].includes(sqlState(error) ?? '')) {
    return new PluginPackagePromptAdmissionConflictError(
      'durable Run, Prompt plan, StepRun, event, or receipt identity changed',
    );
  }
  return unavailable(error);
}

export function json(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => json(entry ?? null)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${json(record[key])}`)
      .join(',')}}`;
  }
  throw unavailable();
}

export function jsonObject(value: unknown): Record<string, unknown> {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      throw unavailable();
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw unavailable();
  }
  return candidate as Record<string, unknown>;
}

export function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

export function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw unavailable();
}

export function boolean(row: Row, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw unavailable();
  return value;
}

export function nullableText(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : text(row, key);
}

export function nullableInteger(row: Row, key: string): number | null {
  return row[key] === null || row[key] === undefined ? null : integer(row, key);
}
