import type { DatabaseSync } from 'node:sqlite';

export const MAX_LOCAL_SQLITE_PENDING_OPERATIONS = 256;

/**
 * Owns the one synchronous SQLite connection, its bounded async admission
 * queue, and its close fence. Narrow repositories share this authority rather
 * than growing one public god repository or opening sibling connections.
 */
export class LocalSqliteOperationAuthority {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private accepting = true;
  private closePromise?: Promise<void>;

  constructor(readonly client: DatabaseSync) {}

  enqueue<T>(
    work: () => Promise<T>,
    rejection: (reason: 'closed' | 'busy') => Error,
  ): Promise<T> {
    if (!this.accepting) return Promise.reject(rejection('closed'));
    if (this.pending >= MAX_LOCAL_SQLITE_PENDING_OPERATIONS) {
      return Promise.reject(rejection('busy'));
    }
    this.pending += 1;
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.pending -= 1;
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    this.closePromise = this.tail.then(() => {
      if (this.client.isOpen) this.client.close();
    });
    return this.closePromise;
  }
}
