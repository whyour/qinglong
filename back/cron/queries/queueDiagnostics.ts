import { Op, Sequelize, col, fn } from 'sequelize';
import {
  executionAssociation,
  executionModel,
} from '../../data/executionModels';

type Occupant = { id?: string; name: string };
type WaitingSample = { db: Sequelize; context?: string };
const LIVE_SAMPLE_INTERVAL_MS = 250;
export type Admission = {
  queue: 'manual' | 'scheduled' | 'global';
  limit: number;
  occupied: number;
  holders: Occupant[];
};

// Each object belongs to exactly one execution pool in its owning process.
export class QueueOccupants {
  private active = new Set<Occupant>();
  private waiting = new Map<string, WaitingSample>();
  private writing = false;
  private changed = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private queue: Admission['queue'],
    private limit: () => number,
    private warn: (error: Error) => void,
  ) {}

  watch(id: string, db: Sequelize) {
    this.waiting.set(id, { db });
    this.refresh();
  }

  forget(id?: string) {
    if (id) this.waiting.delete(id);
    if (!this.waiting.size) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.changed = false;
    }
  }

  refresh() {
    if (!this.waiting.size) return;
    this.changed = true;
    if (this.writing || this.timer) return;
    // Bound diagnostic write frequency across asynchronous admissions/handoffs.
    // Execution and its durable admission/dequeue records never wait for this timer.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, LIVE_SAMPLE_INTERVAL_MS);
    this.timer.unref();
  }

  private async flush() {
    this.writing = true;
    this.changed = false;
    try {
      const context = JSON.stringify(this.snapshot(this.limit()));
      const groups = new Map<Sequelize, Map<string, WaitingSample>>();
      for (const [id, sample] of this.waiting) {
        if (sample.context === context) continue;
        let group = groups.get(sample.db);
        if (!group) groups.set(sample.db, (group = new Map()));
        group.set(id, sample);
      }
      for (const [db, samples] of groups) {
        try {
          await executionModel(db, 'CronTriggers').update(
            { queue_live_context: context },
            {
              where: {
                state: 'queued',
                dequeued_at: null,
                [Op.or]: [
                  { queue_live_context: null },
                  { queue_live_context: { [Op.ne]: context } },
                ],
                id: { [Op.in]: [...samples.keys()] },
              },
              hooks: false,
              validate: false,
            },
          );
          for (const [id, sample] of samples) {
            // A removed/re-admitted ID belongs to a different observation.
            if (this.waiting.get(id) === sample) sample.context = context;
          }
        } catch (error) {
          this.warn(error as Error);
        }
      }
    } finally {
      this.writing = false;
      if (this.changed) this.refresh();
    }
  }

  admission(limit: number): Admission | undefined {
    return this.active.size >= limit ? this.snapshot(limit) : undefined;
  }

  private snapshot(limit: number): Admission {
    return {
      queue: this.queue,
      limit,
      occupied: this.active.size,
      holders: [...this.active].slice(0, 8),
    };
  }

  track<T>(job: () => Promise<T>, occupant: Occupant, db?: Sequelize) {
    return async () => {
      this.forget(occupant.id);
      this.active.add(occupant);
      this.refresh();
      if (occupant.id && db) {
        void db
          .query(
            'UPDATE CronTriggers SET dequeued_at=$at,queue_live_context=NULL WHERE id=$id AND queued_at <= $at AND dequeued_at IS NULL',
            { bind: { id: occupant.id, at: Date.now() } },
          )
          .catch(this.warn);
      }
      try {
        return await job();
      } finally {
        this.active.delete(occupant);
        this.refresh();
      }
    };
  }
}

export function recordQueueAdmission(
  db: Sequelize,
  id: string,
  admission: Admission,
) {
  return executionModel(db, 'CronTriggers').update(
    { queue_context: JSON.stringify(admission) },
    {
      where: { id, queued_at: { [Op.lte]: Date.now() }, queue_context: null },
      silent: true,
      hooks: false,
      validate: false,
    },
  );
}

export function oldestQueued(db: Sequelize) {
  return executionModel(db, 'CronTriggers').findAll({
    attributes: [
      'id',
      [
        fn(
          'COALESCE',
          fn('NULLIF', col('task.name'), ''),
          col('task.command'),
          fn('printf', '#%s', col('CronTriggers.cron_id')),
        ),
        'name',
      ],
      'source',
      'queued_at',
      'queue_context',
      'queue_live_context',
    ],
    where: {
      state: 'queued',
      dequeued_at: null,
      queued_at: { [Op.not]: null },
    },
    include: [
      {
        association: executionAssociation(db, 'triggerTask'),
        attributes: [],
        required: false,
      },
    ],
    order: [
      ['queued_at', 'ASC'],
      ['id', 'ASC'],
    ],
    limit: 25,
    raw: true,
  }) as unknown as Promise<
    Array<{
      id: string;
      name: string;
      source: string;
      queued_at: number;
      queue_context: string | null;
      queue_live_context: string | null;
    }>
  >;
}

// The shared budget supplies its existing occupancy snapshot, including foreign
// workers. Diagnostics never open a transaction on the admission critical path.
export class GlobalQueueDiagnostics {
  private pending = new Map<string, string>();
  private sampled = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private writing = false;

  constructor(private db: Sequelize) {}

  observe(ids: string[], admission?: Admission) {
    const context = admission && JSON.stringify(admission);
    this.pending = new Map(
      ids.map((id) => [id, context ?? this.pending.get(id) ?? '']),
    );
    for (const id of this.sampled.keys())
      if (!this.pending.has(id)) this.sampled.delete(id);
    if (!ids.length) {
      clearTimeout(this.timer);
      this.timer = undefined;
    } else this.schedule();
  }

  private schedule() {
    if (
      this.timer ||
      this.writing ||
      ![...this.pending].some(
        ([id, value]) => value && this.sampled.get(id) !== value,
      )
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, LIVE_SAMPLE_INTERVAL_MS);
    this.timer.unref();
  }

  private async flush() {
    this.writing = true;
    const groups = new Map<string, string[]>();
    for (const [id, context] of this.pending) {
      if (!context || this.sampled.get(id) === context) continue;
      const group = groups.get(context) ?? [];
      group.push(id);
      groups.set(context, group);
    }
    try {
      for (const [context, ids] of groups) {
        await executionModel(this.db, 'CronTriggers').update(
          {
            queue_context: fn('COALESCE', col('queue_context'), context),
            queue_live_context: context,
          },
          {
            where: {
              id: { [Op.in]: ids },
              state: 'queued',
              dequeued_at: null,
              [Op.or]: [
                { queue_live_context: null },
                { queue_live_context: { [Op.ne]: context } },
              ],
            },
            hooks: false,
            validate: false,
          },
        );
        for (const id of ids)
          if (this.pending.get(id) === context) this.sampled.set(id, context);
      }
    } catch (error) {
      console.warn('[queue] Could not save global occupancy:', error);
      // A later observation retries a failed sample, without a timer that can
      // outlive the budget/database after the last waiter has left.
      return;
    } finally {
      this.writing = false;
    }
    this.schedule();
  }
}
