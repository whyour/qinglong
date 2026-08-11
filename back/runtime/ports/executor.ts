import type {
  ExecutionContext,
  ExecutionHandle,
  ExecutionInspection,
  ExecutionSpec,
  ExecutionStopReason,
  ExecutionStopResult,
  ExecutorCapabilities,
  ExecutorType,
} from '../domain/execution';

export interface Executor {
  readonly type: ExecutorType;
  capabilities(): ExecutorCapabilities;
  start(
    spec: ExecutionSpec,
    context: ExecutionContext,
  ): Promise<ExecutionHandle>;
  stop(
    handle: ExecutionHandle,
    reason: ExecutionStopReason,
  ): Promise<ExecutionStopResult>;
  inspect(handle: ExecutionHandle): Promise<ExecutionInspection>;
}
