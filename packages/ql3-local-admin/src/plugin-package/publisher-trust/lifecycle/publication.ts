import {
  LocalPluginPackagePublisherTrustConfigurationError,
  LocalPluginPackagePublisherTrustConflictError,
  MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_GENERATIONS,
  type LocalPluginPackagePublisherTrustDocument,
  type PublishedLocalPluginPackagePublisherTrust,
  type PublishLocalPluginPackagePublisherTrustOptions,
} from '../contracts';
import {
  MUTATION_ID_PATTERN,
  activeKeyCount,
  createSnapshot,
  dataRecord,
  exactKeys,
  integer,
  keyMap,
  digest,
  boundedIdentity,
  normalizeLocalPluginPackagePublisherTrustDocument,
  sameSnapshot,
} from '../codec';
import {
  revalidateDirectory,
  loadState,
  publishSnapshot,
  promoteCurrent,
} from '../privateFilesystemStore';

function assertTransition(
  mode: 'provision' | 'rotate',
  current: Readonly<LocalPluginPackagePublisherTrustDocument> | undefined,
  candidate: Readonly<LocalPluginPackagePublisherTrustDocument>,
  occurredAtMs: number,
): void {
  if (mode === 'provision') {
    if (current !== undefined) {
      throw new LocalPluginPackagePublisherTrustConflictError(
        'provision requires an empty trust root',
      );
    }
    if (activeKeyCount(candidate, occurredAtMs) < 1) {
      throw new LocalPluginPackagePublisherTrustConfigurationError(
        'provision requires a currently active publisher key',
      );
    }
    return;
  }
  if (current === undefined) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'rotation requires an existing trust generation',
    );
  }
  const existing = keyMap(current);
  const next = keyMap(candidate);
  for (const [identifier, definition] of existing) {
    if (
      !next.has(identifier) ||
      JSON.stringify(next.get(identifier)) !== JSON.stringify(definition)
    ) {
      throw new LocalPluginPackagePublisherTrustConfigurationError(
        'overlap rotation cannot remove or rewrite an existing key',
      );
    }
  }
  const added = [...next.entries()]
    .filter(([identifier]) => !existing.has(identifier))
    .map(([, definition]) => definition);
  if (
    added.length === 0 ||
    !added.some(
      (key) => key.notBeforeMs <= occurredAtMs && occurredAtMs < key.notAfterMs,
    )
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'overlap rotation requires a new currently active key',
    );
  }
}

export async function publishLocalPluginPackagePublisherTrust(
  value: PublishLocalPluginPackagePublisherTrustOptions,
): Promise<Readonly<PublishedLocalPluginPackagePublisherTrust>> {
  const options = dataRecord(value, 'publication options');
  const optional = [
    ...(Object.hasOwn(options, 'beforePublish') ? ['beforePublish'] : []),
    ...(Object.hasOwn(options, 'afterSnapshotPublished')
      ? ['afterSnapshotPublished']
      : []),
  ];
  exactKeys(
    options,
    [
      'expectedGeneration',
      'mode',
      'mutationId',
      'occurredAtMs',
      'trust',
      'trustRoot',
      ...optional,
    ],
    'publication options',
  );
  const expectedGeneration = integer(
    value.expectedGeneration,
    0,
    'expectedGeneration',
  );
  const occurredAtMs = integer(value.occurredAtMs, 0, 'occurredAtMs');
  if (
    (value.mode !== 'provision' && value.mode !== 'rotate') ||
    typeof value.mutationId !== 'string' ||
    !MUTATION_ID_PATTERN.test(value.mutationId) ||
    (value.beforePublish !== undefined &&
      typeof value.beforePublish !== 'function') ||
    (value.afterSnapshotPublished !== undefined &&
      typeof value.afterSnapshotPublished !== 'function')
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publication identity is invalid',
    );
  }
  const trust = normalizeLocalPluginPackagePublisherTrustDocument(value.trust);
  let state = loadState(value.trustRoot);
  const previous = state.snapshots[expectedGeneration - 1];
  const requested = createSnapshot(
    value.mode,
    expectedGeneration,
    value.mutationId,
    occurredAtMs,
    trust,
    previous,
  );
  const replay = state.snapshots.find(
    (snapshot) => snapshot.mutationId === value.mutationId,
  );
  if (replay) {
    if (!sameSnapshot(replay, requested)) {
      throw new LocalPluginPackagePublisherTrustConflictError(
        'mutation identity was reused with different trust',
      );
    }
    await value.beforePublish?.();
    if (state.pending?.snapshotDigest === replay.snapshotDigest) {
      promoteCurrent(state.root, replay);
      return Object.freeze({
        status: 'recovered',
        generation: replay.generation,
        keyCount: replay.trust.keys.length,
        trustDigest: replay.trustDigest,
      });
    }
    return Object.freeze({
      status: 'existing',
      generation: replay.generation,
      keyCount: replay.trust.keys.length,
      trustDigest: replay.trustDigest,
    });
  }
  if (state.pending) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'a trust generation requires exact command replay',
    );
  }
  if (state.pendingRetirement) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'a publisher key retirement requires exact command replay',
    );
  }
  if (state.pendingRevocation) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'a publisher key revocation requires exact command replay',
    );
  }
  if (
    state.snapshots.length >=
      MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_GENERATIONS ||
    (state.committed?.generation ?? 0) !== expectedGeneration
  ) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'expected generation is stale or capacity is exhausted',
    );
  }
  assertTransition(value.mode, state.current?.trust, trust, occurredAtMs);
  await value.beforePublish?.();
  state = loadState(value.trustRoot);
  if (
    state.pending ||
    state.pendingRetirement ||
    state.pendingRevocation ||
    (state.committed?.generation ?? 0) !== expectedGeneration ||
    state.current?.digest !==
      (expectedGeneration === 0 ? undefined : requested.previousTrustDigest)
  ) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'trust state changed before publication',
    );
  }
  revalidateDirectory(state.root);
  publishSnapshot(state.root, requested);
  await value.afterSnapshotPublished?.();
  promoteCurrent(state.root, requested);
  return Object.freeze({
    status: 'published',
    generation: requested.generation,
    keyCount: requested.trust.keys.length,
    trustDigest: requested.trustDigest,
  });
}

export function assertLocalPluginPackagePublisherKeyPublicationAllowed(
  value: Readonly<{
    trustRoot: string;
    publisher: string;
    keyId: string;
  }>,
): void {
  const options = dataRecord(value, 'publication guard options');
  exactKeys(
    options,
    ['keyId', 'publisher', 'trustRoot'],
    'publication guard options',
  );
  const publisher = boundedIdentity(value.publisher, 'publisher');
  const keyId = boundedIdentity(value.keyId, 'keyId');
  const state = loadState(value.trustRoot);
  if (
    state.retirementIntents.some(
      (intent) => intent.publisher === publisher && intent.keyId === keyId,
    ) ||
    state.revocationProposals.some(
      (proposal) =>
        proposal.publisher === publisher && proposal.keyId === keyId,
    )
  ) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'publisher key is blocked by a durable lifecycle mutation',
    );
  }
}
