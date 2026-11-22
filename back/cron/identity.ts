import { createHash } from 'crypto';

// The original scheduled CLI wire format maps to its existing persisted trigger ID.
export const executionIdPattern =
  /^(?:client-|legacy-system:\d{1,12}:)[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function executionTriggerId(id: string) {
  return id.replace('legacy-system:', 'system-cli-').replace(':', '-');
}

// A header lets upgraded clients keep the same identified body on older panels.
export function receiptFinishTime(header?: string) {
  if (header && /^\d{1,13}$/.test(header)) {
    const time = Number(header);
    if (time > 0 && time <= Date.now()) return time;
  }
}

// A scheduled slot keeps the same identity across retries and diagnostics.
export function slotId(
  task: string,
  ruleIndex: number,
  rule: string,
  time: number,
) {
  return createHash('sha256')
    .update(JSON.stringify([task, ruleIndex, rule, time]))
    .digest('hex');
}
