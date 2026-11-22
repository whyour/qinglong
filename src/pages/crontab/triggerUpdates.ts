export type TriggerEntry = {
  observed_at: number;
  id: string;
  source: string;
  state: string;
  reason?: string;
  log_path?: string;
  scheduled_at?: number;
  queued_at?: number;
  dequeued_at?: number;
  queue_live_context?: string;
  queue_wait_ms?: number;
  queue_context?: string;
  started_at?: number;
  script_started_at?: number;
  command_started_at?: number;
  finished_at?: number;
  exit_code: number | null;
  legacy_exit_booking?: number;
};

export const pageSize = 25;

export function createTriggerPoll(
  head: TriggerEntry,
  read: (params: URLSearchParams) => Promise<TriggerEntry[]>,
  active: () => boolean,
  onHead: (newer: boolean) => void,
  onBatch: (ids: string[], entries: TriggerEntry[]) => void,
  onError: (failed: boolean) => void,
  openIds: ReadonlySet<string>,
) {
  const waiting = new Set<string>();
  const inFlight = new Set<string>();
  const failed = new Set<string>();
  const recheck = new Set<string>();
  let watched = new Set<string>();
  let workers = 0;
  let readingHead = false;
  let headFailed = false;

  function reportErrors() {
    onError(headFailed || failed.size > 0);
  }

  async function checkHead() {
    if (readingHead) return;
    readingHead = true;
    try {
      const [latest] = await read(new URLSearchParams({ limit: '1' }));
      if (!active()) return;
      onHead(
        !!latest &&
          (latest.observed_at > head.observed_at ||
            (latest.observed_at === head.observed_at && latest.id > head.id)),
      );
      headFailed = false;
    } catch {
      headFailed = true;
    } finally {
      readingHead = false;
      if (active()) reportErrors();
    }
  }

  async function refreshBatches() {
    workers++;
    try {
      while (active() && waiting.size) {
        const batch: string[] = [];
        const params = new URLSearchParams();
        for (const id of waiting) {
          waiting.delete(id);
          if (!watched.has(id)) continue;
          inFlight.add(id);
          batch.push(id);
          params.append('ids', id);
          if (batch.length === pageSize) break;
        }
        if (!batch.length) continue;
        try {
          const entries = await read(params);
          if (!active()) return;
          onBatch(batch, entries);
          for (const id of batch) failed.delete(id);
        } catch {
          for (const id of batch) if (watched.has(id)) failed.add(id);
        } finally {
          for (const id of batch) {
            inFlight.delete(id);
            if (recheck.delete(id) && watched.has(id)) waiting.add(id);
          }
          if (active()) reportErrors();
        }
      }
    } finally {
      workers--;
    }
  }

  return function poll(
    rows: TriggerEntry[],
    action: 'poll' | 'retry' | ReadonlySet<string> = 'poll',
  ) {
    if (!active()) return;
    const previousOpen = openIds;
    if (typeof action !== 'string') openIds = action;
    watched = new Set(
      rows
        .filter(
          (row) =>
            openIds.has(row.id) ||
            row.state === 'running' ||
            row.state === 'queued' ||
            row.reason === 'exit_pending' ||
            row.reason === 'exit_conflict' ||
            row.legacy_exit_booking === 1 ||
            (row.reason === 'restart' &&
              (row.state === 'skipped' || row.state === 'unknown')),
        )
        .map((row) => row.id),
    );

    const previousFailures = failed.size;
    for (const id of failed) if (!watched.has(id)) failed.delete(id);
    if (failed.size !== previousFailures) reportErrors();

    // A close and reopen before dispatch must retain the original FIFO position.
    // The worker checks current interest when it takes the ID off the queue.
    for (const id of watched) {
      if (action === 'retry' && !failed.has(id)) continue;
      if (typeof action !== 'string') {
        if (!openIds.has(id) || previousOpen.has(id)) continue;
        if (inFlight.has(id)) recheck.add(id);
      }
      if (!inFlight.has(id)) waiting.add(id);
    }
    if (action === 'poll' || (action === 'retry' && headFailed))
      void checkHead();
    while (active() && waiting.size && workers < 2) void refreshBatches();
  };
}
