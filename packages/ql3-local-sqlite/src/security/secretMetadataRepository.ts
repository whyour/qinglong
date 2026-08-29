import {
  LocalSecretMetadataUnavailableError,
  MAX_LOCAL_SECRET_BATCH_SIZE,
  assertLocalSecretName,
  assertLocalSecretProjectId,
  assertLocalSecretVersion,
  type LocalSecretMetadata,
  type LocalSecretMetadataPage,
  type LocalSecretMetadataSource,
} from '@qinglong/runtime-core/local-secret';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) {
    throw new LocalSecretMetadataUnavailableError();
  }
  return value as number;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new LocalSecretMetadataUnavailableError();
  }
  return value;
}

function metadata(row: Row): Readonly<LocalSecretMetadata> {
  try {
    const projectId = text(row, 'projectId');
    const name = text(row, 'name');
    const currentVersion = integer(row, 'currentVersion');
    const createdAtMs = integer(row, 'createdAtMs');
    assertLocalSecretProjectId(projectId);
    assertLocalSecretName(name);
    assertLocalSecretVersion(currentVersion);
    if (createdAtMs < 0) throw new Error('invalid Secret timestamp');
    return Object.freeze({ projectId, name, currentVersion, createdAtMs });
  } catch (error) {
    if (error instanceof LocalSecretMetadataUnavailableError) throw error;
    throw new LocalSecretMetadataUnavailableError();
  }
}

export class LocalSqliteSecretMetadataRepository
  implements LocalSecretMetadataSource
{
  constructor(private readonly authority: LocalSqliteOperationAuthority) {
    if (!(authority instanceof LocalSqliteOperationAuthority)) {
      throw new TypeError('Local Secret metadata authority is invalid');
    }
  }

  listLocalSecretMetadata(options: {
    readonly projectId: string;
    readonly limit: number;
    readonly after?: Readonly<{ readonly name: string }>;
  }): Promise<Readonly<LocalSecretMetadataPage>> {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some(
        (key) => !['after', 'limit', 'projectId'].includes(key),
      ) ||
      !Object.hasOwn(options, 'limit') ||
      !Object.hasOwn(options, 'projectId') ||
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > MAX_LOCAL_SECRET_BATCH_SIZE ||
      (options.after !== undefined &&
        (!options.after ||
          typeof options.after !== 'object' ||
          Array.isArray(options.after) ||
          Object.keys(options.after).join('') !== 'name'))
    ) {
      throw new TypeError('Local Secret metadata list options are invalid');
    }
    assertLocalSecretProjectId(options.projectId);
    if (options.after) assertLocalSecretName(options.after.name);
    return this.authority.enqueue(
      async () => {
        try {
          const rows = this.authority.client
            .prepare(
              `SELECT secret."project_id" AS "projectId",
                      secret."secret_name" AS "name",
                      secret."version" AS "currentVersion",
                      secret."created_at_ms" AS "createdAtMs"
                 FROM "QingLong3LocalSecretEnvelopes" AS secret
                WHERE secret."project_id" = ?
                  AND secret."secret_name" > ?
                  AND secret."version" = (
                    SELECT MAX(current."version")
                      FROM "QingLong3LocalSecretEnvelopes" AS current
                     WHERE current."project_id" = secret."project_id"
                       AND current."secret_name" = secret."secret_name"
                  )
                ORDER BY secret."secret_name"
                LIMIT ?`,
            )
            .all(
              options.projectId,
              options.after?.name ?? '',
              options.limit + 1,
            ) as Row[] | undefined;
          if (!Array.isArray(rows)) {
            throw new LocalSecretMetadataUnavailableError();
          }
          const truncated = rows.length > options.limit;
          const secrets = Object.freeze(
            rows.slice(0, options.limit).map(metadata),
          );
          const last = secrets.at(-1);
          return Object.freeze({
            secrets,
            truncated,
            ...(truncated && last
              ? { next: Object.freeze({ name: last.name }) }
              : {}),
          });
        } catch {
          throw new LocalSecretMetadataUnavailableError();
        }
      },
      () => new LocalSecretMetadataUnavailableError(),
    );
  }
}
