import { upcomingSlots } from './cronScheduler';

// Find only the latest eligible slot even for a second-level rule after hours
// offline. Search by time, so cost is logarithmic in the configured window.
export function latestMissedSlot(
  schedule: string,
  since: number,
  until: number,
): number | null {
  let low = Math.floor(since / 1000);
  let high = Math.floor(until / 1000);
  let latest: number | null = null;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const [next] = upcomingSlots(schedule, middle * 1000);
    if (next > until) high = middle;
    else {
      latest = next;
      low = next / 1000;
    }
  }
  return latest;
}
