import type { LegacyExecutionAcceptedFact } from '../ports/legacyExecutionObserver';
import { selectOneLegacyExecution } from '../domain/legacyExecutionSelection';
import type {
  LegacyExecutionCancellationFact,
  LegacyExecutionCallbackFact,
  LegacyExecutionSelector,
} from '../ports/legacyExecutionCorrelation';
import type { LegacyExecutionObservation } from '../ports/legacyExecutionObserver';

export const DEFAULT_MAX_LOCAL_LEGACY_EXECUTIONS = 256;

interface RegistryEntry {
  accepted: LegacyExecutionAcceptedFact;
  observation: LegacyExecutionObservation;
  pid?: number;
  logArtifactId?: string;
}

export interface LegacyExecutionRegistryOptions {
  maxEntries?: number;
  onOverflow?: () => void;
  onDispatchFailure?: () => void;
}

export class LegacyExecutionRegistry {
  private readonly entries = new Map<number, Set<RegistryEntry>>();
  private readonly maxEntries: number;
  private readonly onOverflow: () => void;
  private readonly onDispatchFailure: () => void;
  private entryCount = 0;

  constructor(options: LegacyExecutionRegistryOptions = {}) {
    const maxEntries =
      options.maxEntries ?? DEFAULT_MAX_LOCAL_LEGACY_EXECUTIONS;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('maxEntries must be a positive safe integer');
    }
    this.maxEntries = maxEntries;
    this.onOverflow = options.onOverflow ?? (() => {});
    this.onDispatchFailure = options.onDispatchFailure ?? (() => {});
  }

  register(
    accepted: LegacyExecutionAcceptedFact,
    observation: LegacyExecutionObservation,
  ): LegacyExecutionObservation {
    if (accepted.legacyCronId === undefined) return observation;
    if (this.entryCount >= this.maxEntries) {
      try {
        this.onOverflow();
      } catch {
        // Registry diagnostics must not affect the legacy execution path.
      }
      return observation;
    }

    const entry: RegistryEntry = { accepted, observation };
    const entries = this.entries.get(accepted.legacyCronId) ?? new Set();
    entries.add(entry);
    this.entries.set(accepted.legacyCronId, entries);
    this.entryCount += 1;

    const remove = () => this.remove(accepted.legacyCronId!, entry);
    return {
      spawned: (fact) => {
        if (fact.pid !== undefined) entry.pid = fact.pid;
        if (fact.logArtifactId !== undefined) {
          entry.logArtifactId = fact.logArtifactId;
        }
        this.invoke(() => observation.spawned(fact));
      },
      running: (fact) => this.invoke(() => observation.running(fact)),
      startFailed: (fact) => {
        this.invoke(() => observation.startFailed(fact));
        remove();
      },
      exited: (fact) => {
        this.invoke(() => observation.exited(fact));
        remove();
      },
      cancelled: (fact) => {
        this.invoke(() => observation.cancelled(fact));
        remove();
      },
    };
  }

  cancel(fact: LegacyExecutionCancellationFact): number {
    const matches =
      fact.scope === 'all'
        ? [...(this.entries.get(fact.legacyCronId) ?? [])]
        : this.selectOne(fact);
    for (const entry of matches) {
      this.invoke(() =>
        entry.observation.cancelled({
          atMs: fact.atMs,
          reason: fact.reason,
        }),
      );
      this.remove(fact.legacyCronId, entry);
    }
    return matches.length;
  }

  callback(fact: LegacyExecutionCallbackFact): number {
    const matches = this.selectOne(fact);
    if (matches.length !== 1) return 0;
    const [entry] = matches;
    if (fact.phase === 'running') {
      this.invoke(() =>
        entry.observation.spawned({
          atMs: fact.atMs,
          ...(fact.pid === undefined ? {} : { pid: fact.pid }),
          ...(fact.logArtifactId === undefined
            ? {}
            : { logArtifactId: fact.logArtifactId }),
        }),
      );
      this.invoke(() => entry.observation.running({ atMs: fact.atMs }));
    } else {
      this.invoke(() =>
        entry.observation.exited({
          atMs: fact.atMs,
          exitCode: fact.exitCode ?? 0,
        }),
      );
      this.remove(fact.legacyCronId, entry);
    }
    return 1;
  }

  size(): number {
    return this.entryCount;
  }

  private selectOne(selector: LegacyExecutionSelector): RegistryEntry[] {
    const candidates = [...(this.entries.get(selector.legacyCronId) ?? [])];
    return selectOneLegacyExecution(candidates, selector);
  }

  private remove(legacyCronId: number, entry: RegistryEntry): void {
    const entries = this.entries.get(legacyCronId);
    if (!entries?.delete(entry)) return;
    this.entryCount -= 1;
    if (entries.size === 0) this.entries.delete(legacyCronId);
  }

  private invoke(operation: () => void): void {
    try {
      operation();
    } catch {
      try {
        this.onDispatchFailure();
      } catch {
        // Registry diagnostics must not affect the legacy execution path.
      }
    }
  }
}
