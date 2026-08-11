#!/usr/bin/env node

import { runLocalSecurityAuditQueryCommandFile } from './securityAuditQueryCommand';

const USAGE =
  'Usage: ql3-audit run --command-file /absolute/private-command.json';

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const commandFilePath = argv[2];
  if (
    argv.length !== 3 ||
    argv[0] !== 'run' ||
    argv[1] !== '--command-file' ||
    commandFilePath === undefined
  ) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'LOCAL_SECURITY_AUDIT_QUERY_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const result = await runLocalSecurityAuditQueryCommandFile(commandFilePath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const candidate = error as {
      readonly code?: unknown;
      readonly name?: unknown;
      readonly message?: unknown;
    };
    process.stderr.write(
      `${JSON.stringify({
        code:
          typeof candidate.code === 'string'
            ? candidate.code
            : 'LOCAL_SECURITY_AUDIT_QUERY_CLI_FAILED',
        name: typeof candidate.name === 'string' ? candidate.name : 'Error',
        message:
          typeof candidate.message === 'string'
            ? candidate.message
            : 'Local security audit query command failed',
      })}\n`,
    );
    process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
