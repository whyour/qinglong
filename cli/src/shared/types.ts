export interface ApiResponse<T> {
  code: 200;
  data: T;
}

export interface LogResponse extends ApiResponse<string> {
  logStatus?: string;
  truncated: boolean;
}
