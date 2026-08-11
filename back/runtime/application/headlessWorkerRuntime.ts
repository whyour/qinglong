import type { DeploymentProfile } from '../domain/deploymentProfile';
import type { WorkerRecord } from '../domain/worker';
import type { WorkerExecutionDrainer } from '../ports/workerExecutionDrainer';
import type {
  WorkerHeartbeatLifecycle,
  WorkerHeartbeatStopResult,
} from './workerHeartbeatLifecycle';

export type HeadlessWorkerStopResult =
  | 'stopped'
  | 'not_started'
  | 'executions_timed_out'
  | 'heartbeat_timed_out'
  | 'heartbeat_disconnect_failed';

export interface HeadlessWorkerBootstrapOptions {
  enabled?: boolean;
  profile: DeploymentProfile;
  heartbeat: WorkerHeartbeatLifecycle;
  executions: WorkerExecutionDrainer;
}

/**
 * Independent Worker boot topology. It owns no HTTP panel, Scheduler, SQLite
 * control-plane repository, or local Primary router. Shutdown first advertises
 * zero capacity, then waits for the execution plane, and only then marks the
 * Worker session offline.
 */
export class HeadlessWorkerRuntime {
  private started = false;

  constructor(
    private readonly heartbeat: WorkerHeartbeatLifecycle,
    private readonly executions: WorkerExecutionDrainer,
  ) {}

  currentSession(): WorkerRecord | undefined {
    return this.heartbeat.currentSession();
  }

  async start(): Promise<boolean> {
    if (this.started) return false;
    const started = await this.heartbeat.start();
    this.started = started;
    return started;
  }

  async drainAndStop(): Promise<HeadlessWorkerStopResult> {
    if (!this.started) return 'not_started';
    await this.heartbeat.drain();
    if ((await this.executions.drain()) === 'timed_out') {
      return 'executions_timed_out';
    }
    const heartbeatResult: WorkerHeartbeatStopResult =
      await this.heartbeat.stop();
    if (heartbeatResult === 'timed_out') return 'heartbeat_timed_out';
    if (heartbeatResult === 'disconnect_failed') {
      return 'heartbeat_disconnect_failed';
    }
    this.started = false;
    return 'stopped';
  }
}

export type HeadlessWorkerBootstrapResult =
  | { status: 'disabled' }
  | { status: 'active'; runtime: HeadlessWorkerRuntime };

export async function bootstrapHeadlessWorkerRuntime({
  enabled = false,
  profile,
  heartbeat,
  executions,
}: HeadlessWorkerBootstrapOptions): Promise<HeadlessWorkerBootstrapResult> {
  if (!enabled) return { status: 'disabled' };
  if (profile !== 'worker') {
    throw new TypeError(
      `Deployment profile ${profile} cannot activate the headless Worker runtime`,
    );
  }
  const runtime = new HeadlessWorkerRuntime(heartbeat, executions);
  if (!(await runtime.start())) {
    throw new Error('Headless Worker runtime did not start');
  }
  return { status: 'active', runtime };
}
