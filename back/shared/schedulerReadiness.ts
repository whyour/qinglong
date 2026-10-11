// Recovery is single-flight and retried only while unavailable, never at idle.
export class SchedulerReadiness {
  private ready = false;
  private generation = 0;
  private restore?: () => Promise<void>;
  private pending?: Promise<boolean>;
  private retry?: NodeJS.Timeout;

  constructor(private probe: () => Promise<void>, private retryMs = 1000) {}

  configure(restore: () => Promise<void>) {
    this.restore = restore;
  }

  invalidate() {
    this.ready = false;
    this.generation++;
    void this.recover();
  }

  recover(): Promise<boolean> {
    if (this.pending) return this.pending;
    if (!this.restore) return Promise.resolve(false);
    clearTimeout(this.retry);
    const generation = this.generation;
    this.ready = false;
    this.pending = (async () => {
      try {
        await this.probe();
        await this.restore!();
        await this.probe();
        this.ready = generation === this.generation;
      } catch {
        this.ready = false;
      }
      return this.ready;
    })().finally(() => {
      this.pending = undefined;
      if (!this.ready) {
        this.retry = setTimeout(() => void this.recover(), this.retryMs);
        this.retry.unref();
      }
    });
    return this.pending;
  }

  async check(): Promise<boolean> {
    if (!this.ready) return false;
    const generation = this.generation;
    try {
      await this.probe();
      return this.ready && generation === this.generation;
    } catch {
      this.invalidate();
      return false;
    }
  }

  async ensureReady(timeoutMs = 2000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const available = await Promise.race([
        (async () => (await this.check()) || (await this.recover()))(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      if (!available) {
        throw Object.assign(new Error('Scheduler is recovering; try again later'), {
          status: 503,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
