// Database owns the one-way Pool failure to admission-withdrawal fence.
export type ClusterControlAvailabilityStatus =
  | 'available'
  | 'unavailable'
  | 'disposed';

export type ClusterControlUnavailableListener = (
  error: Error,
) => void | Promise<void>;

export interface ClusterControlAvailabilitySource {
  subscribe(listener: ClusterControlUnavailableListener): () => void;
}

export type ClusterControlAvailabilitySignalResult =
  | 'signaled'
  | 'already_unavailable'
  | 'disposed';

/**
 * A bounded one-way bridge from pg.Pool availability errors to the application
 * admission owner. It deliberately has one listener and no timer, retry loop,
 * error history or path back to available.
 */
export class ClusterControlAvailabilityFence
  implements ClusterControlAvailabilitySource
{
  private currentStatus: ClusterControlAvailabilityStatus = 'available';
  private listener: ClusterControlUnavailableListener | undefined;
  private reason: Error | undefined;
  private notification: Promise<void> | undefined;

  get status(): ClusterControlAvailabilityStatus {
    return this.currentStatus;
  }

  subscribe(listener: ClusterControlUnavailableListener): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('Cluster-control availability listener is invalid');
    }
    if (this.currentStatus === 'disposed') {
      throw new Error('Cluster-control availability fence is disposed');
    }
    if (this.listener) {
      throw new Error('Cluster-control availability listener is already bound');
    }
    this.listener = listener;
    if (this.currentStatus === 'unavailable') {
      // An early signal has already returned to its producer. The subscriber
      // owns the delayed notification, so contain its rejection here.
      void this.notify().catch(() => undefined);
    }
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      if (this.listener === listener) this.listener = undefined;
    };
  }

  signal(error: Error): Promise<ClusterControlAvailabilitySignalResult> {
    if (!(error instanceof Error)) {
      return Promise.reject(
        new TypeError('Cluster-control availability error is invalid'),
      );
    }
    if (this.currentStatus === 'disposed') return Promise.resolve('disposed');
    if (this.currentStatus === 'unavailable') {
      return (this.notification ?? Promise.resolve()).then(
        () => 'already_unavailable' as const,
      );
    }
    this.currentStatus = 'unavailable';
    this.reason = error;
    return this.notify().then(() => 'signaled' as const);
  }

  dispose(): void {
    if (this.currentStatus === 'disposed') return;
    this.currentStatus = 'disposed';
    this.listener = undefined;
    this.reason = undefined;
  }

  private notify(): Promise<void> {
    if (this.notification) return this.notification;
    if (!this.listener || !this.reason) return Promise.resolve();
    const listener = this.listener;
    const reason = this.reason;
    this.notification = Promise.resolve().then(() => listener(reason));
    return this.notification;
  }
}
