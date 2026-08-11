export interface LocalApiResponse {
  readonly statusCode: number;
  readonly body: Readonly<Record<string, unknown>>;
}
