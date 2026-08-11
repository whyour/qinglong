import type { LocalPersistedExecutionInspection } from './evidence';
import {
  LinuxProcProcessIdentityProvider,
  parseLocalProcessDurableHandle,
  type LinuxProcessIdentity,
  type LocalProcessIdentityProvider,
} from './localProcessIdentity';

export const MAX_LOCAL_PROCESS_STOP_GRACE_MS = 30_000;

export type LocalProcessStopResult = Readonly<
  | { status: 'stopped'; signal: 'SIGTERM' | 'SIGKILL' }
  | { status: 'already_exited' }
  | {
      status: 'unknown';
      reason:
        | 'invalid_handle'
        | 'unsupported_platform'
        | 'provider_unavailable'
        | 'signal_failed';
    }
  | { status: 'timed_out' }
>;

export interface LocalProcessControllerOptions {
  readonly identityProvider?: Pick<LocalProcessIdentityProvider, 'inspect'>;
  readonly terminateGraceMs?: number;
  readonly killGraceMs?: number;
  readonly pollIntervalMs?: number;
  readonly clock?: { now(): number };
  readonly wait?: (delayMs: number) => Promise<void>;
  readonly signalProcessGroup?: (
    processGroupId: number,
    signal: 'SIGTERM' | 'SIGKILL',
  ) => void;
}

function assertDuration(value: number, field: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_LOCAL_PROCESS_STOP_GRACE_MS
  ) {
    throw new RangeError(
      `${field} must be between 1 and ${MAX_LOCAL_PROCESS_STOP_GRACE_MS}`,
    );
  }
}

function unknown(
  reason: Extract<LocalProcessStopResult, { status: 'unknown' }>['reason'],
): LocalProcessStopResult {
  return Object.freeze({ status: 'unknown' as const, reason });
}

function inspectionResult(
  inspection: LocalPersistedExecutionInspection,
): LocalProcessStopResult | undefined {
  if (inspection.status === 'not_running') {
    return Object.freeze({ status: 'already_exited' as const });
  }
  if (inspection.status === 'unknown') return unknown(inspection.reason);
  return undefined;
}

export class LocalProcessController {
  private readonly identityProvider: Pick<
    LocalProcessIdentityProvider,
    'inspect'
  >;
  private readonly terminateGraceMs: number;
  private readonly killGraceMs: number;
  private readonly pollIntervalMs: number;
  private readonly clock: { now(): number };
  private readonly wait: (delayMs: number) => Promise<void>;
  private readonly signalProcessGroup: (
    processGroupId: number,
    signal: 'SIGTERM' | 'SIGKILL',
  ) => void;

  constructor(options: LocalProcessControllerOptions = {}) {
    this.identityProvider =
      options.identityProvider ?? new LinuxProcProcessIdentityProvider();
    this.terminateGraceMs = options.terminateGraceMs ?? 1_000;
    this.killGraceMs = options.killGraceMs ?? 1_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    assertDuration(this.terminateGraceMs, 'terminateGraceMs');
    assertDuration(this.killGraceMs, 'killGraceMs');
    assertDuration(this.pollIntervalMs, 'pollIntervalMs');
    if (this.pollIntervalMs > this.terminateGraceMs) {
      throw new RangeError('pollIntervalMs cannot exceed terminateGraceMs');
    }
    if (this.pollIntervalMs > this.killGraceMs) {
      throw new RangeError('pollIntervalMs cannot exceed killGraceMs');
    }
    this.clock = options.clock ?? { now: Date.now };
    this.wait =
      options.wait ??
      ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.signalProcessGroup =
      options.signalProcessGroup ??
      ((processGroupId, signal) => process.kill(-processGroupId, signal));
  }

  async stop(durableHandle: string): Promise<LocalProcessStopResult> {
    const parsed = parseLocalProcessDurableHandle(durableHandle);
    if (!parsed) return unknown('invalid_handle');

    try {
      return await this.stopExact(parsed.identity);
    } catch {
      return unknown('provider_unavailable');
    }
  }

  private async stopExact(
    identity: LinuxProcessIdentity,
  ): Promise<LocalProcessStopResult> {
    const before = await this.identityProvider.inspect(identity);
    const conclusive = inspectionResult(before);
    if (conclusive) return conclusive;

    const terminated = await this.signalAndObserve(
      identity,
      'SIGTERM',
      this.terminateGraceMs,
    );
    if (terminated !== undefined) return terminated;

    // Revalidate the full boot/PID/start-time/process-group identity before
    // escalating. A recycled PID can never inherit stop authority.
    const beforeKill = await this.identityProvider.inspect(identity);
    const killConclusion = inspectionResult(beforeKill);
    if (killConclusion) {
      return killConclusion.status === 'already_exited'
        ? Object.freeze({
            status: 'stopped' as const,
            signal: 'SIGTERM' as const,
          })
        : killConclusion;
    }
    const killed = await this.signalAndObserve(
      identity,
      'SIGKILL',
      this.killGraceMs,
    );
    return killed ?? Object.freeze({ status: 'timed_out' as const });
  }

  private async signalAndObserve(
    identity: LinuxProcessIdentity,
    signal: 'SIGTERM' | 'SIGKILL',
    graceMs: number,
  ): Promise<LocalProcessStopResult | undefined> {
    try {
      this.signalProcessGroup(identity.processGroupId, signal);
    } catch (error) {
      if (!this.isNoSuchProcess(error)) return unknown('signal_failed');
    }
    const deadline = this.safeDeadline(this.clock.now(), graceMs);
    while (true) {
      const inspection = await this.identityProvider.inspect(identity);
      if (inspection.status === 'not_running') {
        return Object.freeze({ status: 'stopped' as const, signal });
      }
      if (inspection.status === 'unknown') return unknown(inspection.reason);
      const now = this.clock.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        return unknown('provider_unavailable');
      }
      if (now >= deadline) return undefined;
      await this.wait(Math.min(this.pollIntervalMs, deadline - now));
    }
  }

  private safeDeadline(now: number, graceMs: number): number {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError('Local process controller clock is invalid');
    }
    const deadline = now + graceMs;
    if (!Number.isSafeInteger(deadline)) {
      throw new RangeError('Local process controller deadline overflowed');
    }
    return deadline;
  }

  private isNoSuchProcess(error: unknown): boolean {
    return (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}
