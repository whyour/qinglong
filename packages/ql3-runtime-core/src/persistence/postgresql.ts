export interface PostgresQueryResult<
  TRow extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly TRow[];
  readonly rowCount?: number | null;
}

export interface PostgresQueryable {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<TRow>>;
}

export interface PostgresClient extends PostgresQueryable {
  release(): void;
}

export interface PostgresPool extends PostgresQueryable {
  connect(): Promise<PostgresClient>;
}

export interface PostgresDatabaseResource {
  readonly pool: PostgresPool;
  close(): Promise<void>;
}

export type OpenPostgresDatabase = () => Promise<PostgresDatabaseResource>;
