import fs from 'fs/promises';
import { Dirent } from 'fs';
import path from 'path';

export const MAX_RETENTION_DAYS = 3650;
export const DEPENDENCE_CACHE_TYPES = ['node', 'python3'] as const;

export type DependenceCacheType = (typeof DEPENDENCE_CACHE_TYPES)[number];

export interface RetentionPolicy {
  runningInstanceRetentionDays: number;
  cronStatRetentionDays: number;
}

export function normalizeRetentionDays(value: unknown) {
  const days = Number(value);
  if (!Number.isFinite(days)) return 0;
  return Math.min(Math.max(Math.trunc(days), 0), MAX_RETENTION_DAYS);
}

export function normalizeRetentionPolicy(
  policy: Partial<RetentionPolicy>,
): RetentionPolicy {
  return {
    runningInstanceRetentionDays: normalizeRetentionDays(
      policy.runningInstanceRetentionDays,
    ),
    cronStatRetentionDays: normalizeRetentionDays(policy.cronStatRetentionDays),
  };
}

export function isDependenceCacheType(
  value: string,
): value is DependenceCacheType {
  return DEPENDENCE_CACHE_TYPES.includes(value as DependenceCacheType);
}

export async function getDirectorySize(rootPath: string): Promise<number> {
  const pending = [rootPath];
  let total = 0;

  while (pending.length > 0) {
    const currentPath = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        total += (await fs.stat(entryPath)).size;
      }
    }
  }

  return total;
}
