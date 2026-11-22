import { CliError, type ExitCode } from './errors';

// Opt-in structured context for commands that have already identified an operation.
export class CliResultError extends CliError {
  constructor(
    message: string,
    readonly data: Record<string, unknown>,
    exitCode: ExitCode = 1,
  ) {
    super(message, exitCode);
  }
}
