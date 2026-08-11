export const EXECUTOR_TYPES = [
  'local_process',
  'docker',
  'kubernetes',
  'remote_worker',
] as const;

export type ExecutorType = (typeof EXECUTOR_TYPES)[number];

export type ExecutionCommand =
  | {
      kind: 'argv';
      file: string;
      args: readonly string[];
    }
  | {
      kind: 'shell';
      command: string;
      shell?: string;
    };

export type ExecutionLimitEnforcement = 'required' | 'best_effort';

export interface ExecutionNumericLimit {
  value: number;
  enforcement: ExecutionLimitEnforcement;
}

export interface ExecutionResourcePolicy {
  memoryBytes?: ExecutionNumericLimit;
  cpuMillisPerSecond?: ExecutionNumericLimit;
  filesystemIsolation?: ExecutionLimitEnforcement;
  networkIsolation?: ExecutionLimitEnforcement;
}

export interface ExecutionSpec {
  runId: string;
  attemptId: string;
  projectId: string;
  taskId: string;
  taskRevision: string;
  command: ExecutionCommand;
  workingDirectory?: string;
  environmentPolicy: 'inherit' | 'isolated';
  timeoutMs?: number;
  terminationGraceMs: number;
  resourcePolicy?: ExecutionResourcePolicy;
}

export type ExecutionOutputStream = 'stdout' | 'stderr';

export interface ExecutionOutputChunk {
  stream: ExecutionOutputStream;
  chunk: Uint8Array;
  observedAtMs: number;
}

export interface ExecutionOutputSink {
  write(output: ExecutionOutputChunk): Promise<void>;
}

export interface ExecutionAbortSignal {
  readonly aborted: boolean;
  addEventListener?: (
    type: 'abort',
    listener: () => void,
    options?: { once?: boolean },
  ) => void;
  removeEventListener?: (type: 'abort', listener: () => void) => void;
}

export interface ExecutionContext {
  environment: Readonly<Record<string, string>>;
  signal?: ExecutionAbortSignal;
  output: ExecutionOutputSink;
  /** Ephemeral capability for the durable completion launcher; never persist raw. */
  completionCallback?: {
    token: string;
    callbackSequence: number;
  };
}

export type ExecutionOutcome =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'lost';

export interface ExecutionDiagnostic {
  code: string;
  summary: string;
}

export interface ExecutionResult {
  outcome: ExecutionOutcome;
  startedAtMs: number;
  finishedAtMs: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  errorCode?: string;
  errorSummary?: string;
  diagnostics?: readonly ExecutionDiagnostic[];
}

export interface ExecutionHandle {
  id: string;
  /** Opaque, bounded identity used to verify ownership after a process restart. */
  durableHandle?: string;
  executorType: ExecutorType;
  runId: string;
  attemptId: string;
  startedAtMs: number;
  pid?: number;
  completion: Promise<ExecutionResult>;
}

export type ExecutionStopKind =
  | 'user'
  | 'policy'
  | 'shutdown'
  | 'reconcile'
  | 'timeout';

export interface ExecutionStopReason {
  kind: ExecutionStopKind;
  requestedAtMs: number;
}

export interface ExecutionStopResult {
  status: 'already_exited' | 'termination_requested';
  termSignalSent: boolean;
  killSignalSent: boolean;
}

export type ExecutionInspectionStatus = 'running' | 'stopping' | 'exited';

export interface ExecutionInspection {
  status: ExecutionInspectionStatus;
  result?: ExecutionResult;
}

export type ExecutorCapabilityLevel = 'none' | 'best_effort' | 'enforced';

export interface ExecutorCapabilities {
  timeout: boolean;
  processGroupTermination: boolean;
  workingDirectory: boolean;
  isolatedEnvironment: boolean;
  memoryLimit: ExecutorCapabilityLevel;
  cpuLimit: ExecutorCapabilityLevel;
  filesystemIsolation: ExecutorCapabilityLevel;
  networkIsolation: ExecutorCapabilityLevel;
}
