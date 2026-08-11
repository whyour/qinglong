export interface PrimaryRunIdempotencyLookup {
  findRunId(projectId: string, idempotencyKey: string): Promise<string | null>;
}
