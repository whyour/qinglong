#!/usr/bin/env node

import {
  ClusterAdministrationKubernetesInputStageError,
  stageClusterAdministrationKubernetesInputs,
} from './clusterAdministrationKubernetesInputStage';

const USAGE =
  'Usage: ql3-security-admin-kubernetes-stage --source=/absolute/projected-input --target=/absolute/private-input [--delivery-directory=/absolute/private-delivery]';

function argumentsFrom(argv: readonly string[]) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return Object.freeze({ kind: 'help' as const });
  }
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--(source|target|delivery-directory)=(\/.+)$/.exec(
      argument,
    );
    if (!match || values.has(match[1]!)) {
      throw new ClusterAdministrationKubernetesInputStageError(
        'CLI arguments are invalid',
      );
    }
    values.set(match[1]!, match[2]!);
  }
  if (!values.has('source') || !values.has('target')) {
    throw new ClusterAdministrationKubernetesInputStageError(
      'CLI arguments are invalid',
    );
  }
  return Object.freeze({
    kind: 'run' as const,
    paths: Object.freeze({
      sourceDirectory: values.get('source')!,
      targetDirectory: values.get('target')!,
      ...(values.has('delivery-directory')
        ? { deliveryDirectory: values.get('delivery-directory')! }
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
    component: 'qinglong3-security-administration-kubernetes-input-stage',
    event: 'stage_failed',
    name:
      typeof candidate?.name === 'string' && candidate.name.length <= 128
        ? candidate.name
        : 'Error',
    ...(typeof candidate?.code === 'string' && candidate.code.length <= 128
      ? { code: candidate.code }
      : {}),
  });
}

function main(argv: readonly string[]): void {
  try {
    const parsed = argumentsFrom(argv);
    if (parsed.kind === 'help') {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    process.stdout.write(
      `${JSON.stringify(
        stageClusterAdministrationKubernetesInputs(parsed.paths),
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(`${JSON.stringify(failure(error))}\n`);
    process.exitCode =
      error instanceof ClusterAdministrationKubernetesInputStageError ? 64 : 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}
