import type { Sequelize } from 'sequelize';
import { performance } from 'perf_hooks';

// Per database and day: concurrent viewers share one computation. Rejections
// are never cached; a new day cannot reuse yesterday's summary. Runtime/task
// control endpoints remain live and never read this display-only snapshot.
const snapshots = new WeakMap<
  Sequelize,
  { key: string; until: number; value: Promise<unknown> }
>();
export function dashboardSnapshot<T>(
  db: Sequelize,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const existing = snapshots.get(db);
  if (existing?.key === key && performance.now() < existing.until)
    return existing.value as Promise<T>;
  const entry = {
    key,
    until: Infinity,
    value: Promise.resolve().then(compute),
  };
  snapshots.set(db, entry);
  entry.value.then(
    () => {
      // Wall-clock corrections must not stretch a one-second cache for minutes.
      entry.until = performance.now() + 1000;
    },
    () => {
      if (snapshots.get(db) === entry) snapshots.delete(db);
    },
  );
  return entry.value;
}
