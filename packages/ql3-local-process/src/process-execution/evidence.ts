export type LocalPersistedExecutionInspection = Readonly<
  | { status: 'running'; identityPid: number }
  | { status: 'not_running'; identityPid: number }
  | {
      status: 'unknown';
      reason:
        | 'invalid_handle'
        | 'unsupported_platform'
        | 'provider_unavailable';
    }
>;

export interface LocalPersistedExecutionInspector {
  readonly executorType: 'local_process';
  inspect(durableHandle: string): Promise<LocalPersistedExecutionInspection>;
}
