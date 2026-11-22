import { createHash } from 'crypto';

export type AnomalyKind = 'missing' | 'skipped' | 'unconfirmed';
export interface ScheduleAnomaly {
  task: number;
  name?: string;
  rule: string | null;
  time: number | null;
  source: 'node' | 'recovery' | 'system';
  trigger: string | null;
  observed: number | null;
  reason: string | null;
  logPath: string | null;
  ruleIndex?: number;
}

// Keep only the requested page and the first page. If late evidence changes
// the result between requests, return the new first page instead of mixing scans.
export class AnomalyPage {
  private hash = createHash('sha256');
  private total = 0;
  private first: ScheduleAnomaly[] = [];
  private selected: ScheduleAnomaly[] = [];
  static readonly size = 25;

  constructor(
    readonly kind: AnomalyKind,
    private page: number,
    private previous?: string,
  ) {}

  add(row: ScheduleAnomaly) {
    this.hash.update(JSON.stringify(row)).update('\n');
    const page = Math.floor(this.total++ / AnomalyPage.size) + 1;
    if (page === 1) this.first.push(row);
    if (page === this.page) this.selected.push(row);
  }

  result() {
    const revision = this.hash.digest('hex');
    const changed = !!this.previous && revision !== this.previous;
    const reset = changed || (this.page > 1 && !this.selected.length);
    return {
      rows: reset ? this.first : this.selected,
      total: this.total,
      page: reset ? 1 : this.page,
      pageSize: AnomalyPage.size,
      revision,
      changed,
    };
  }
}
