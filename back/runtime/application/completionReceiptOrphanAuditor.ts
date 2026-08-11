import { isTerminalRunAttemptStatus } from '../domain/runStateMachine';
import type {
  CompletionReceiptDirectoryEntry,
  CompletionReceiptOrphanDirectory,
  CompletionReceiptOwnership,
  CompletionReceiptOwnershipSource,
} from '../ports/completionReceiptOrphanMaintenance';

export const MAX_ORPHAN_AUDIT_SHARDS = 32;
export const MAX_ORPHAN_AUDIT_ENTRIES_PER_SHARD = 64;

export type CompletionReceiptOrphanAuditMode = 'audit' | 'quarantine';
export type CompletionReceiptOrphanCategory =
  | 'journaled'
  | 'active_attempt'
  | 'young_terminal_attempt'
  | 'terminal_orphan'
  | 'young_unknown_receipt'
  | 'unknown_receipt'
  | 'young_temporary'
  | 'stale_temporary'
  | 'young_unknown_entry'
  | 'unknown_entry'
  | 'unsafe_entry';
export type CompletionReceiptOrphanAction =
  | 'retained'
  | 'eligible'
  | 'blocked_overflow'
  | 'quarantined'
  | 'changed';

export interface CompletionReceiptOrphanAuditEntry {
  shard: string;
  name: string;
  category: CompletionReceiptOrphanCategory;
  action: CompletionReceiptOrphanAction;
  ageMs: number;
  attemptId?: string;
  attemptStatus?: string;
  quarantineRef?: string;
}

export interface CompletionReceiptOrphanAuditReport {
  schemaVersion: 1;
  mode: CompletionReceiptOrphanAuditMode;
  observedAtMs: number;
  minimumAgeMs: number;
  startShard: string;
  nextShard: string;
  wrapped: boolean;
  shardCount: number;
  maxEntriesPerShard: number;
  scannedEntries: number;
  overflowShards: readonly string[];
  entries: readonly CompletionReceiptOrphanAuditEntry[];
  counts: Readonly<Record<CompletionReceiptOrphanCategory, number>>;
}

export interface CompletionReceiptOrphanAuditorOptions {
  mode?: CompletionReceiptOrphanAuditMode;
  observedAtMs?: number;
  minimumAgeMs?: number;
  startShard?: number;
  shardCount?: number;
  maxEntriesPerShard?: number;
  clock?: { now(): number };
}

const CATEGORIES: readonly CompletionReceiptOrphanCategory[] = [
  'journaled',
  'active_attempt',
  'young_terminal_attempt',
  'terminal_orphan',
  'young_unknown_receipt',
  'unknown_receipt',
  'young_temporary',
  'stale_temporary',
  'young_unknown_entry',
  'unknown_entry',
  'unsafe_entry',
];

function assertIntegerBetween(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
}

function shardName(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function classify(
  entry: CompletionReceiptDirectoryEntry,
  ownership: CompletionReceiptOwnership | undefined,
  oldEnough: boolean,
): { category: CompletionReceiptOrphanCategory; eligible: boolean } {
  if (entry.kind === 'unsafe') {
    return { category: 'unsafe_entry', eligible: false };
  }
  if (entry.kind === 'temporary') {
    return oldEnough
      ? { category: 'stale_temporary', eligible: true }
      : { category: 'young_temporary', eligible: false };
  }
  if (entry.kind === 'unknown') {
    return oldEnough
      ? { category: 'unknown_entry', eligible: true }
      : { category: 'young_unknown_entry', eligible: false };
  }
  if (ownership?.journalState) {
    return { category: 'journaled', eligible: false };
  }
  if (ownership?.attemptStatus) {
    if (!isTerminalRunAttemptStatus(ownership.attemptStatus)) {
      return { category: 'active_attempt', eligible: false };
    }
    return oldEnough
      ? { category: 'terminal_orphan', eligible: true }
      : { category: 'young_terminal_attempt', eligible: false };
  }
  return oldEnough
    ? { category: 'unknown_receipt', eligible: true }
    : { category: 'young_unknown_receipt', eligible: false };
}

export class CompletionReceiptOrphanAuditor {
  constructor(
    private readonly directory: CompletionReceiptOrphanDirectory,
    private readonly ownership: CompletionReceiptOwnershipSource,
  ) {}

  async run(
    options: CompletionReceiptOrphanAuditorOptions = {},
  ): Promise<CompletionReceiptOrphanAuditReport> {
    const mode = options.mode ?? 'audit';
    if (mode !== 'audit' && mode !== 'quarantine') {
      throw new RangeError('mode must be audit or quarantine');
    }
    const observedAtMs =
      options.observedAtMs ?? options.clock?.now() ?? Date.now();
    const minimumAgeMs = options.minimumAgeMs ?? 5 * 60_000;
    const startShard = options.startShard ?? 0;
    const shardCount = options.shardCount ?? 8;
    const maxEntriesPerShard = options.maxEntriesPerShard ?? 32;
    assertIntegerBetween(
      'observedAtMs',
      observedAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    assertIntegerBetween(
      'minimumAgeMs',
      minimumAgeMs,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    assertIntegerBetween('startShard', startShard, 0, 255);
    assertIntegerBetween('shardCount', shardCount, 1, MAX_ORPHAN_AUDIT_SHARDS);
    assertIntegerBetween(
      'maxEntriesPerShard',
      maxEntriesPerShard,
      1,
      MAX_ORPHAN_AUDIT_ENTRIES_PER_SHARD,
    );

    const counts = Object.fromEntries(
      CATEGORIES.map((category) => [category, 0]),
    ) as Record<CompletionReceiptOrphanCategory, number>;
    const overflowShards: string[] = [];
    const entries: CompletionReceiptOrphanAuditEntry[] = [];

    for (let offset = 0; offset < shardCount; offset += 1) {
      const shard = shardName((startShard + offset) % 256);
      const snapshot = await this.directory.inspectShard(
        shard,
        maxEntriesPerShard,
      );
      if (snapshot.shard !== shard) {
        throw new Error('Completion receipt directory returned another shard');
      }
      if (snapshot.entries.length > maxEntriesPerShard) {
        throw new Error('Completion receipt directory exceeded its hard limit');
      }
      if (snapshot.overflow) overflowShards.push(shard);

      const attemptIds = snapshot.entries.flatMap((entry) =>
        entry.kind === 'receipt' && entry.attemptId ? [entry.attemptId] : [],
      );
      const ownership = await this.ownership.lookup(attemptIds);
      for (const entry of snapshot.entries) {
        const ageMs = Math.max(0, observedAtMs - entry.modifiedAtMs);
        const classification = classify(
          entry,
          entry.attemptId ? ownership.get(entry.attemptId) : undefined,
          ageMs >= minimumAgeMs,
        );
        counts[classification.category] += 1;
        let action: CompletionReceiptOrphanAction = classification.eligible
          ? 'eligible'
          : 'retained';
        let quarantineRef: string | undefined;
        if (classification.eligible && mode === 'quarantine') {
          if (snapshot.overflow) {
            action = 'blocked_overflow';
          } else {
            const result = await this.directory.quarantine(entry);
            action = result.status;
            if (result.status === 'quarantined') {
              quarantineRef = result.reference;
            }
          }
        }
        entries.push({
          shard,
          name: entry.name,
          category: classification.category,
          action,
          ageMs,
          ...(entry.attemptId ? { attemptId: entry.attemptId } : {}),
          ...(entry.attemptId && ownership.get(entry.attemptId)?.attemptStatus
            ? {
                attemptStatus: ownership.get(entry.attemptId)!.attemptStatus,
              }
            : {}),
          ...(quarantineRef ? { quarantineRef } : {}),
        });
      }
    }

    const absoluteNextShard = startShard + shardCount;
    return {
      schemaVersion: 1,
      mode,
      observedAtMs,
      minimumAgeMs,
      startShard: shardName(startShard),
      nextShard: shardName(absoluteNextShard % 256),
      wrapped: absoluteNextShard > 255,
      shardCount,
      maxEntriesPerShard,
      scannedEntries: entries.length,
      overflowShards,
      entries,
      counts,
    };
  }
}
