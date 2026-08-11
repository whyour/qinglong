#!/usr/bin/env node

import { runLocalPluginPackagePublisherTrustCommandFile } from './pluginPackagePublisherTrustCommand';

const USAGE =
  'Usage: ql3-package-trust run --command-file /absolute/private-command.json';

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
        code: 'LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const result =
      await runLocalPluginPackagePublisherTrustCommandFile(commandFilePath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const candidate = error as {
      readonly code?: unknown;
      readonly name?: unknown;
    };
    process.stderr.write(
      `${JSON.stringify({
        code:
          typeof candidate.code === 'string'
            ? candidate.code
            : 'LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_CLI_FAILED',
        name:
          typeof candidate.name === 'string' ? candidate.name : 'Error',
      })}\n`,
    );
    process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
