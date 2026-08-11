// Remote execution owns fenced Worker lease renewal, release, and timeout authority.
import { randomUUID } from 'node:crypto';
import {
  RemoteWorkerLeaseControlUnavailableError,
  assertRemoteWorkerLeaseControlDuration,
  normalizeRemoteWorkerLeaseControlCommand,
  normalizeRemoteWorkerLeaseControlResult,
  type RemoteWorkerLeaseControlCommand,
  type RemoteWorkerLeaseControlRepository,
  type RemoteWorkerLeaseControlResult,
} from '@qinglong/runtime-core/remote-worker-lease-control';

export interface ClusterRemoteWorkerLeaseControlServiceOptions {
  readonly leaseDurationMs?: number;
  readonly createEventId?: () => string;
}

function eventId(factory: () => string): string {
  const value = factory();
  if (
    typeof value !== 'string' || value.length < 1 || value.length > 36 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) throw new RemoteWorkerLeaseControlUnavailableError();
  return value;
}

export class ClusterRemoteWorkerLeaseControlService {
  private readonly leaseDurationMs: number;
  private readonly createEventId: () => string;

  constructor(
    private readonly repository: RemoteWorkerLeaseControlRepository,
    options: ClusterRemoteWorkerLeaseControlServiceOptions = {},
  ) {
    if (
      typeof repository?.control !== 'function' ||
      (options.createEventId !== undefined &&
        typeof options.createEventId !== 'function')
    ) throw new TypeError('Remote Worker lease control service is invalid');
    const leaseDurationMs = options.leaseDurationMs ?? 30_000;
    assertRemoteWorkerLeaseControlDuration(leaseDurationMs);
    this.leaseDurationMs = leaseDurationMs;
    this.createEventId = options.createEventId ?? randomUUID;
  }

  async control(
    value: RemoteWorkerLeaseControlCommand,
  ): Promise<Readonly<RemoteWorkerLeaseControlResult>> {
    const command = normalizeRemoteWorkerLeaseControlCommand(value);
    return normalizeRemoteWorkerLeaseControlResult(
      await this.repository.control(Object.freeze({
        ...command,
        leaseDurationMs: this.leaseDurationMs,
        timeoutEventId: eventId(this.createEventId),
      })),
    );
  }
}
