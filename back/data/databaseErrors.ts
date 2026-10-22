// Error details (SQL, bindings, credentials) stay inside the database worker.
export class DatabaseError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export function databaseStartupFailure(value: unknown) {
  const error = (value && typeof value === 'object' ? value : {}) as Error & { code?: string };
  const missing = /Cannot find (?:module|package) ['"]([^'"]+)['"]/.exec(
    error.message || '',
  )?.[1];
  const importer = /Require stack:\r?\n-\s+([^\r\n]+)/.exec(
    error.message || '',
  )?.[1];
  const dependency =
    /MODULE_NOT_FOUND/.test(error.code || '') &&
    Boolean(
      missing &&
        ((!missing.startsWith('.') &&
          !missing.startsWith('/') &&
          !missing.startsWith('node:')) ||
          /node_modules[/\\]/.test(missing) ||
          /node_modules[/\\]/.test(importer || '')),
    );
  return dependency
    ? {
        code: 'MODULE_NOT_FOUND',
        message: "Cannot find module '@mikro-orm/sql'",
      }
    : {
        code: 'DATABASE_WORKER_EXIT',
        message: 'Database process failed to start',
      };
}
