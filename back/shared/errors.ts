// Keep error formatting independent of database, HTTP and gRPC dependencies.
export function errStack(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : String(error);
}
