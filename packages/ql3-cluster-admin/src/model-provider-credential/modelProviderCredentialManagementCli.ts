#!/usr/bin/env node

import {
  startClusterModelProviderCredentialManagementProcess,
  type ClusterModelProviderCredentialManagementProcessRuntime,
} from './modelProviderCredentialManagementProcess';

const USAGE = 'Usage: ql3-provider-credential-manage';

function failureFact(error: unknown): Readonly<Record<string, unknown>> {
  const candidate = error as { readonly name?: unknown; readonly code?: unknown };
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-model-provider-credential-management',
    event: 'management_failed',
    name:
      typeof candidate?.name === 'string' && candidate.name.length <= 128
        ? candidate.name
        : 'Error',
    ...(typeof candidate?.code === 'string' && candidate.code.length <= 128
      ? { code: candidate.code }
      : {}),
  });
}

function emit(value: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function run(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (argv.length !== 0) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  let runtime: Readonly<ClusterModelProviderCredentialManagementProcessRuntime>;
  try {
    runtime = await startClusterModelProviderCredentialManagementProcess({
      environment: process.env,
      onError() {
        emit({
          schemaVersion: 1,
          component: 'qinglong3-model-provider-credential-management',
          event: 'management_unavailable',
        });
      },
    });
  } catch (error) {
    process.stderr.write(`${JSON.stringify(failureFact(error))}\n`);
    process.exitCode = 1;
    return;
  }
  if (runtime.status === 'disabled') {
    emit({
      schemaVersion: 1,
      component: 'qinglong3-model-provider-credential-management',
      event: 'management_disabled',
    });
    return;
  }
  emit({
    schemaVersion: 1,
    component: 'qinglong3-model-provider-credential-management',
    event: 'management_started',
    address: runtime.address,
    identityGeneration: runtime.identity.generation,
    databaseMigrationCount: runtime.database.migrationIds.length,
  });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= runtime.close().then(() => {
      emit({
        schemaVersion: 1,
        component: 'qinglong3-model-provider-credential-management',
        event: 'management_stopped',
      });
    });
    return stopping;
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void stop().then(
        () => {
          process.exitCode = 0;
        },
        (error) => {
          process.stderr.write(`${JSON.stringify(failureFact(error))}\n`);
          process.exitCode = 1;
        },
      );
    });
  }
}

void run(process.argv.slice(2));
