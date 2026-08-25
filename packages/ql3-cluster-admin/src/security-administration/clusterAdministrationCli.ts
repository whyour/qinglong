#!/usr/bin/env node

import {
  ClusterAdministrationCommandError,
  createClusterAdministrationCommandRunner,
} from './clusterAdministrationCommand';

const USAGE =
  'Usage: ql3-security-admin --command=/absolute/command.json --assertion=/absolute/assertion.jwt --keyset=/absolute/keyset.json (--pepper=/absolute/pepper | --pepper-keyring=/absolute/keyring.json) [--delivery=/absolute/token.json]';

function argumentsFrom(argv: readonly string[]) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return Object.freeze({ kind: 'help' as const });
  }
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match =
      /^--(command|assertion|keyset|pepper|pepper-keyring|delivery)=(\/.+)$/.exec(
        argument,
      );
    if (!match || values.has(match[1]!)) {
      throw new ClusterAdministrationCommandError('CLI arguments are invalid');
    }
    values.set(match[1]!, match[2]!);
  }
  if (
    !values.has('command') ||
    !values.has('assertion') ||
    !values.has('keyset') ||
    values.has('pepper') === values.has('pepper-keyring')
  ) {
    throw new ClusterAdministrationCommandError('CLI arguments are invalid');
  }
  return Object.freeze({
    kind: 'run' as const,
    paths: Object.freeze({
      commandFile: values.get('command')!,
      assertionFile: values.get('assertion')!,
      keysetFile: values.get('keyset')!,
      ...(values.has('pepper')
        ? { pepperFile: values.get('pepper')! }
        : { pepperKeyringFile: values.get('pepper-keyring')! }),
      ...(values.has('delivery')
        ? { deliveryFile: values.get('delivery')! }
        : {}),
    }),
  });
}

function failure(error: unknown): Readonly<Record<string, unknown>> {
  const candidate = error as {
    readonly name?: unknown;
    readonly code?: unknown;
  };
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-security-administration',
    event: 'command_failed',
    name:
      typeof candidate?.name === 'string' && candidate.name.length <= 128
        ? candidate.name
        : 'Error',
    ...(typeof candidate?.code === 'string' && candidate.code.length <= 128
      ? { code: candidate.code }
      : {}),
  });
}

async function main(argv: readonly string[]): Promise<void> {
  try {
    const parsed = argumentsFrom(argv);
    if (parsed.kind === 'help') {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    const result = await createClusterAdministrationCommandRunner().run(
      parsed.paths,
      process.env,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(failure(error))}\n`);
    process.exitCode =
      error instanceof ClusterAdministrationCommandError ? 64 : 1;
  }
}

if (require.main === module) {
  void main(process.argv.slice(2));
}
