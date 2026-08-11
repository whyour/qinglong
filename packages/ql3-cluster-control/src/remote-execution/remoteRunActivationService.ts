// Remote execution owns Worker-bound activation acknowledgements and start failure fencing.
import { randomUUID } from 'node:crypto';
import type {
  AcknowledgeRemoteRunRunningCommand,
  AcknowledgeRemoteRunStartingCommand,
  FailRemoteRunStartCommand,
  RemoteRunActivationRepository,
  RemoteRunActivationResult,
} from '@qinglong/runtime-core/remote-activation';

export interface ClusterRemoteRunActivationPrincipal {
  readonly workerId: string;
}

type ServerOwnedStartingFields = 'workerId' | 'eventId';
type ServerOwnedRunningFields = 'workerId' | 'attemptEventId' | 'runEventId';

export type AcknowledgeClusterRemoteRunStartingCommand = Omit<
  AcknowledgeRemoteRunStartingCommand,
  ServerOwnedStartingFields
>;

export type AcknowledgeClusterRemoteRunRunningCommand = Omit<
  AcknowledgeRemoteRunRunningCommand,
  ServerOwnedRunningFields
>;

export type FailClusterRemoteRunStartCommand = Omit<
  FailRemoteRunStartCommand,
  ServerOwnedRunningFields
>;

export interface ClusterRemoteRunActivationServiceOptions {
  readonly createEventId?: () => string;
}

export class ClusterRemoteRunActivationService {
  private readonly createEventId: () => string;

  constructor(
    private readonly repository: RemoteRunActivationRepository,
    options: ClusterRemoteRunActivationServiceOptions = {},
  ) {
    if (
      !repository ||
      typeof repository.acknowledgeStarting !== 'function' ||
      typeof repository.acknowledgeRunning !== 'function' ||
      typeof repository.failStart !== 'function'
    ) {
      throw new TypeError('Remote Run activation repository is invalid');
    }
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'createEventId')
    ) {
      throw new TypeError('Remote Run activation service options are invalid');
    }
    this.createEventId = options.createEventId ?? randomUUID;
    if (typeof this.createEventId !== 'function') {
      throw new TypeError('Remote Run activation event ID factory is invalid');
    }
  }

  acknowledgeStarting(
    principal: ClusterRemoteRunActivationPrincipal,
    command: AcknowledgeClusterRemoteRunStartingCommand,
  ): Promise<Readonly<RemoteRunActivationResult>> {
    this.assertPrincipal(principal);
    return this.repository.acknowledgeStarting({
      ...command,
      workerId: principal.workerId,
      eventId: this.createEventId(),
    });
  }

  acknowledgeRunning(
    principal: ClusterRemoteRunActivationPrincipal,
    command: AcknowledgeClusterRemoteRunRunningCommand,
  ): Promise<Readonly<RemoteRunActivationResult>> {
    this.assertPrincipal(principal);
    return this.repository.acknowledgeRunning({
      ...command,
      workerId: principal.workerId,
      attemptEventId: this.createEventId(),
      runEventId: this.createEventId(),
    });
  }

  failStart(
    principal: ClusterRemoteRunActivationPrincipal,
    command: FailClusterRemoteRunStartCommand,
  ): Promise<Readonly<RemoteRunActivationResult>> {
    this.assertPrincipal(principal);
    return this.repository.failStart({
      ...command,
      workerId: principal.workerId,
      attemptEventId: this.createEventId(),
      runEventId: this.createEventId(),
    });
  }

  private assertPrincipal(principal: ClusterRemoteRunActivationPrincipal): void {
    if (
      !principal ||
      typeof principal !== 'object' ||
      Array.isArray(principal) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(principal.workerId)
    ) {
      throw new TypeError('Remote Run activation principal is invalid');
    }
  }
}
