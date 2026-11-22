export type TriggerSource =
  | 'node'
  | 'manual'
  | 'boot'
  | 'system'
  | 'recovery'
  | 'legacy'
  | 'client';
export type TriggerState =
  | 'queued'
  | 'running'
  | 'finished'
  | 'failed'
  | 'skipped'
  | 'stopped'
  | 'unknown';

export type Trigger = {
  id: string;
  cron_id: number;
  source: TriggerSource;
  state: TriggerState;
  scheduled_at: number | null;
  queued_at: number | null;
  dequeued_at?: number | null;
  started_at: number | null;
  script_started_at: number | null;
  command_started_at: number | null;
  finished_at: number | null;
  reason: string | null;
  exit_code: number | null;
  log_path: string | null;
};

export type VerifiedSupervisorExit = {
  code: number | null;
  signal: string | null;
  time: number;
  version: 1;
};
