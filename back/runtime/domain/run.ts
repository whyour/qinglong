export const RUN_STATUSES = [
  'created',
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
  'retry_wait',
  'lost',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_ATTEMPT_STATUSES = [
  'claimed',
  'starting',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
] as const;

export type RunAttemptStatus = (typeof RUN_ATTEMPT_STATUSES)[number];

export const EXECUTION_ORIGINS = [
  'manual',
  'scheduled_system',
  'scheduled_node',
  'once',
  'boot',
  'grpc',
  'subscription',
  'system',
  'script',
  'legacy_import',
] as const;

export type ExecutionOrigin = (typeof EXECUTION_ORIGINS)[number];

export type ExecutionOwner = 'legacy' | 'runtime';

export const RUN_CANCELLATION_REASONS = [
  'user',
  'policy',
  'shutdown',
  'reconcile',
  'timeout',
] as const;

export type RunCancellationReason = (typeof RUN_CANCELLATION_REASONS)[number];

export const RUN_EVENT_ACTOR_TYPES = [
  'user',
  'api_app',
  'trigger',
  'agent',
  'mcp_client',
  'worker',
  'executor',
  'system',
  'legacy_shell',
  'scheduler',
  'reconciler',
  'compatibility',
] as const;

export type RunEventActorType = (typeof RUN_EVENT_ACTOR_TYPES)[number];

export interface RunRecord {
  id: string;
  projectId: string;
  taskId: string;
  taskRevision: string;
  taskName?: string;
  taskSnapshotRef?: string;
  legacyCronId?: number;
  parentRunId?: string;
  retryOfRunId?: string;
  triggerId?: string;
  triggerType: string;
  executionOrigin: ExecutionOrigin;
  executionOwner: ExecutionOwner;
  triggeredBy?: string;
  requestId?: string;
  scheduledForMs?: number;
  status: RunStatus;
  version: number;
  eventSequence: number;
  priority: number;
  idempotencyKey?: string;
  inputRef?: string;
  outputRef?: string;
  createdAtMs: number;
  queuedAtMs?: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  cancelRequestedAtMs?: number;
  cancelReason?: RunCancellationReason;
  errorCode?: string;
  errorSummary?: string;
}

export interface RunAttemptRecord {
  id: string;
  runId: string;
  stepRunId?: string;
  attempt: number;
  status: RunAttemptStatus;
  executorType: string;
  workerId?: string;
  executorHandle?: string;
  pid?: number;
  logArtifactId?: string;
  leaseToken?: string;
  leaseExpiresAtMs?: number;
  deadlineAtMs?: number;
  callbackTokenHash?: string;
  callbackSequence: number;
  createdAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  exitCode?: number;
  errorCode?: string;
  errorSummary?: string;
}

export interface RunEventRecord {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  dedupeKey?: string;
  actorType: RunEventActorType;
  actorId?: string;
  attemptId?: string;
  stepRunId?: string;
  payload: Readonly<Record<string, unknown>>;
  createdAtMs: number;
}
