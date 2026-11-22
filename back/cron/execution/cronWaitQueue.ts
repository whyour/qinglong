import { EventEmitter } from 'events';
import { QueueAddOptions } from 'p-queue-cjs';

type Job = () => Promise<unknown>;
export interface CronQueueOptions extends QueueAddOptions {
  waitingSignal?: EventEmitter;
  onRemoved?: () => void;
}

// p-queue checks its signal only after dequeue. Remove expired waits while the
// execution slots are still occupied, without aborting a running child.
export class CronWaitQueue {
  private entries: { run: Job; priority: number; detach: () => void }[] = [];

  get size() {
    return this.entries.length;
  }

  enqueue(run: Job, options: Partial<CronQueueOptions> = {}) {
    const { priority = 0, waitingSignal, onRemoved } = options;
    const remove = () => {
      const index = this.entries.indexOf(entry);
      if (index < 0) return;
      this.entries.splice(index, 1);
      onRemoved?.();
    };
    const entry = {
      run,
      priority,
      detach: () => waitingSignal?.off('expired', remove),
    };
    const last = this.entries[this.size - 1];
    if (!last || last.priority >= priority) this.entries.push(entry);
    else
      this.entries.splice(
        this.entries.findIndex((job) => job.priority < priority),
        0,
        entry,
      );
    waitingSignal?.once('expired', remove);
  }

  dequeue() {
    const next = this.entries.shift();
    next?.detach();
    return next?.run;
  }

  filter(options: Partial<CronQueueOptions>) {
    return this.entries
      .filter((entry) => entry.priority === options.priority)
      .map((entry) => entry.run);
  }
}
