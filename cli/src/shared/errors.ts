export type ExitCode = 1 | 2 | 3;

export class CliError extends Error {
  constructor(message: string, readonly exitCode: ExitCode = 1) {
    super(message);
    this.name = 'CliError';
  }
}

export function fail(message: string, exitCode: ExitCode = 1): never {
  throw new CliError(message, exitCode);
}
