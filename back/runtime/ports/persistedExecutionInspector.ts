import type { ExecutorType } from '../domain/execution';

export type PersistedExecutionInspectionStatus =
  | 'running'
  | 'exited'
  | 'identity_mismatch'
  | 'unsupported'
  | 'invalid';

export interface PersistedExecutionInspection {
  status: PersistedExecutionInspectionStatus;
  identityPid?: number;
}

export interface PersistedExecutionInspector {
  readonly executorType: ExecutorType;
  inspect(durableHandle: string): Promise<PersistedExecutionInspection>;
}
