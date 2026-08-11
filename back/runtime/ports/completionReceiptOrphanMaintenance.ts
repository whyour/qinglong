import type { RunAttemptStatus } from '../domain/run';

export type CompletionReceiptDirectoryEntryKind =
  | 'receipt'
  | 'temporary'
  | 'unknown'
  | 'unsafe';

export interface CompletionReceiptDirectoryEntry {
  shard: string;
  name: string;
  kind: CompletionReceiptDirectoryEntryKind;
  attemptId?: string;
  modifiedAtMs: number;
  sizeBytes: number;
  filesystemIdentity: string;
}

export interface CompletionReceiptShardSnapshot {
  shard: string;
  entries: readonly CompletionReceiptDirectoryEntry[];
  overflow: boolean;
}

export type CompletionReceiptOrphanQuarantineResult =
  | { status: 'quarantined'; reference: string }
  | { status: 'changed' };

export interface CompletionReceiptOrphanDirectory {
  inspectShard(
    shard: string,
    maxEntries: number,
  ): Promise<CompletionReceiptShardSnapshot>;
  quarantine(
    entry: CompletionReceiptDirectoryEntry,
  ): Promise<CompletionReceiptOrphanQuarantineResult>;
}

export interface CompletionReceiptOwnership {
  attemptId: string;
  attemptStatus?: RunAttemptStatus;
  journalState?: 'pending' | 'quarantined';
}

export interface CompletionReceiptOwnershipSource {
  lookup(
    attemptIds: readonly string[],
  ): Promise<ReadonlyMap<string, CompletionReceiptOwnership>>;
}
