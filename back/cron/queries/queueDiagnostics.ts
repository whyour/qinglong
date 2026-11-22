import { QueryTypes, Sequelize } from 'sequelize';

type Occupant = { id?: string; name: string };
export type Admission = {
  queue: 'manual' | 'scheduled';
  limit: number;
  occupied: number;
  holders: Occupant[];
};

// Each object belongs to exactly one execution pool in its owning process.
export class QueueOccupants {
  private active = new Set<Occupant>();
  private waiting = new Map<string, Sequelize>();
  private writing = false;
  private changed = false;

  constructor(
    private queue: Admission['queue'],
    private limit: () => number,
    private warn: (error: Error) => void,
  ) {}

  watch(id: string, db: Sequelize) {
    this.waiting.set(id, db);
    this.refresh();
  }

  forget(id?: string) {
    if (id) this.waiting.delete(id);
  }

  refresh() {
    if (!this.waiting.size) return;
    this.changed = true;
    if (this.writing) return;
    this.writing = true;
    // Coalesce synchronous PQueue handoffs and keep SQLite writes in observation order.
    void Promise.resolve().then(async () => {
      try {
        while (this.changed) {
          this.changed = false;
          const context = JSON.stringify(this.snapshot(this.limit()));
          const groups = new Map<Sequelize, string[]>();
          for (const [id, db] of this.waiting) {
            const ids = groups.get(db);
            if (ids) ids.push(id);
            else groups.set(db, [id]);
          }
          for (const [db, ids] of groups) {
            await db
              .query(
                `UPDATE CronTriggers SET queue_live_context=$context
              WHERE state='queued' AND dequeued_at IS NULL AND id IN (SELECT value FROM json_each($ids))`,
                { bind: { context, ids: JSON.stringify(ids) } },
              )
              .catch(this.warn);
          }
        }
      } finally {
        this.writing = false;
      }
    });
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
  return db.query(
    'UPDATE CronTriggers SET queue_context=$context WHERE id=$id AND queued_at <= $at AND queue_context IS NULL',
    { bind: { id, at: Date.now(), context: JSON.stringify(admission) } },
  );
}

export function oldestQueued(db: Sequelize) {
  return db.query<{
    id: string;
    name: string;
    source: string;
    queued_at: number;
    queue_context: string | null;
    queue_live_context: string | null;
  }>(
    `SELECT t.id, COALESCE(NULLIF(c.name,''), c.command, '#' || t.cron_id) AS name, t.source,t.queued_at,t.queue_context,t.queue_live_context
     FROM CronTriggers t LEFT JOIN Crontabs c ON c.id=t.cron_id
     WHERE t.state='queued' AND t.dequeued_at IS NULL AND t.queued_at IS NOT NULL ORDER BY t.queued_at,t.id LIMIT 25`,
    { type: QueryTypes.SELECT },
  );
}
