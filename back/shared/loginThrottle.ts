const RETRY_TTL = 15 * 60 * 1000;
const MAX_SOURCES = 10000;
const MAX_RETRY_SECONDS = 5 * 60;

/** Source-specific, bounded backoff; persisted account history is not a lock. */
export class LoginThrottle {
  private sources = new Map<
    string,
    { failures: number; lastFailure: number }
  >();

  private get(source: string, now: number) {
    const state = this.sources.get(source);
    if (state && now - state.lastFailure >= RETRY_TTL) {
      this.sources.delete(source);
      return undefined;
    }
    return state;
  }

  retryAfter(source: string, now: number): number {
    const state = this.get(source, now);
    if (!state || state.failures < 3) return 0;
    const seconds = Math.min(3 ** state.failures, MAX_RETRY_SECONDS);
    return Math.max(
      0,
      Math.ceil((seconds * 1000 - (now - state.lastFailure)) / 1000),
    );
  }

  fail(source: string, now: number): number {
    const failures = Math.min((this.get(source, now)?.failures || 0) + 1, 6);
    this.sources.delete(source);
    if (this.sources.size >= MAX_SOURCES) {
      this.sources.delete(this.sources.keys().next().value!);
    }
    this.sources.set(source, { failures, lastFailure: now });
    return failures;
  }

  reset(source: string) {
    this.sources.delete(source);
  }
  clear() {
    this.sources.clear();
  }
}
