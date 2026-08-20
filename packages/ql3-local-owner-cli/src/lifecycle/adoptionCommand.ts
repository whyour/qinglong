import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { runLegacyCrontabAdoptionCommandFile } from './adoption';
import { isLocalDataDirectoryAdoptionOperation } from './data-directory-adoption/contract';
import type { LocalDataDirectoryAdoptionInspectResult } from './data-directory-adoption/inventory';
import {
  isLocalSqliteAdoptionProductOperation,
  type LocalSqliteAdoptionProductOperation,
} from './sqlite-adoption/contract';
import type { LocalSqliteAdoptionProductCommandResult } from './sqlite-adoption/command';

export type LocalAdoptionProductCommandResult =
  | Awaited<ReturnType<typeof runLegacyCrontabAdoptionCommandFile>>
  | LocalSqliteAdoptionProductCommandResult
  | LocalDataDirectoryAdoptionInspectResult;

function operation(value: unknown): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { readonly operation?: unknown }).operation
    : undefined;
}

export async function runLocalAdoptionProductCommandFile(
  commandFilePath: string,
): Promise<Readonly<LocalAdoptionProductCommandResult>> {
  let candidate: unknown;
  try {
    candidate = readPrivateLocalCommandFile(commandFilePath);
  } catch {
    // Preserve the established legacy error mapping for unreadable files.
    return runLegacyCrontabAdoptionCommandFile(commandFilePath);
  }
  const selected = operation(candidate);
  if (isLocalDataDirectoryAdoptionOperation(selected)) {
    const { inspectLocalDataDirectoryAdoption } = await import(
      './data-directory-adoption/inventory.js'
    );
    return inspectLocalDataDirectoryAdoption(candidate);
  }
  if (!isLocalSqliteAdoptionProductOperation(selected)) {
    return runLegacyCrontabAdoptionCommandFile(commandFilePath);
  }
  const { runLocalSqliteAdoptionProductCommand } = await import(
    './sqlite-adoption/command.js'
  );
  return runLocalSqliteAdoptionProductCommand(
    candidate as {
      readonly operation: LocalSqliteAdoptionProductOperation;
    },
  );
}
