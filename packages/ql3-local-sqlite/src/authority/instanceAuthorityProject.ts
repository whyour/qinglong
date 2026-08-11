import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;

function projectId(row: Row): string {
  const value = row.projectId;
  if (typeof value !== 'string') {
    throw new TypeError('Local instance authority Project is invalid');
  }
  return value;
}

export function resolveLocalInstanceAuthorityProjectId(
  client: DatabaseSync,
): string | null {
  const claimed = client
    .prepare(
      `SELECT "project_id" AS "projectId"
       FROM "QingLong3LocalOwnerBootstrapChallenges"
       WHERE "consumed_at_ms" IS NOT NULL
       ORDER BY "consumed_at_ms" ASC, "project_id" ASC, "version" ASC
       LIMIT 1`,
    )
    .get() as Row | undefined;
  if (claimed) return projectId(claimed);
  const fallback = client
    .prepare(
      `SELECT "id" AS "projectId"
       FROM "QingLong3Projects"
       WHERE "id" = 'default'
       LIMIT 1`,
    )
    .get() as Row | undefined;
  return fallback ? projectId(fallback) : null;
}
