import {
  type LocalPluginPackagePublisherTrustInspection,
} from '../contracts';
import {
  activeKeyCount,
  dataRecord,
  exactKeys,
  integer,
  digest,
} from '../codec';
import {
  TEMPORARY_PATTERN,
  loadState,
} from '../privateFilesystemStore';

export function inspectLocalPluginPackagePublisherTrust(
  value: Readonly<{ trustRoot: string; observedAtMs: number }>,
): Readonly<LocalPluginPackagePublisherTrustInspection> {
  const options = dataRecord(value, 'inspection options');
  exactKeys(options, ['observedAtMs', 'trustRoot'], 'inspection options');
  const observedAtMs = integer(
    value.observedAtMs,
    0,
    'inspection observedAtMs',
  );
  const state = loadState(value.trustRoot);
  return Object.freeze({
    generation: state.committed?.generation ?? 0,
    keyCount: state.current?.trust.keys.length ?? 0,
    activeKeyCount: activeKeyCount(state.current?.trust, observedAtMs),
    snapshotCount: state.snapshots.length,
    retirementCount: state.snapshots.filter(
      (snapshot) => snapshot.mode === 'retire',
    ).length,
    pendingRetirementCount: state.pendingRetirement ? 1 : 0,
    revocationCount: state.snapshots.filter(
      (snapshot) => snapshot.mode === 'revoke',
    ).length,
    pendingRevocationCount: state.pendingRevocation ? 1 : 0,
    quarantinedLockCount: new Set(
      state.revocationProposals.flatMap(
        (proposal) => proposal.impactedLockDigests,
      ),
    ).size,
    recoveryRequired:
      state.pending !== undefined ||
      state.pendingRetirement !== undefined ||
      state.pendingRevocation !== undefined,
    pendingGeneration:
      state.pending?.generation ??
      (state.pendingRetirement
        ? state.pendingRetirement.expectedGeneration + 1
        : state.pendingRevocation
        ? state.pendingRevocation.expectedGeneration + 1
        : null),
    pendingMutationId:
      state.pending?.mutationId ??
      state.pendingRetirement?.mutationId ??
      state.pendingRevocation?.mutationId ??
      null,
    unresolvedTransactions: state.root.entries.filter((entry) =>
      TEMPORARY_PATTERN.test(entry),
    ).length,
    trustDigest: state.current?.digest ?? null,
  });
}
