import {
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENT_INTENT_SCHEMA,
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENT_RECEIPT_SCHEMA,
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
  LocalPluginPackagePublisherTrustConfigurationError,
  LocalPluginPackagePublisherTrustConflictError,
  MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENTS,
  type PublishedLocalPluginPackagePublisherTrust,
  type RetireLocalPluginPackagePublisherKeyOptions,
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
  normalizeRetirementIntent,
  normalizeRetirementReceipt,
  retirementIdentityDigest,
  retirementIntentMaterial,
  retirementReceiptMaterial,
} from '../codec';
import {
  revalidateDirectory,
  loadState,
  publishSnapshot,
  publishImmutableDocument,
  promoteCurrent,
} from '../privateFilesystemStore';

export async function retireLocalPluginPackagePublisherKey(
  value: RetireLocalPluginPackagePublisherKeyOptions,
): Promise<Readonly<PublishedLocalPluginPackagePublisherTrust>> {
  const options = dataRecord(value, 'retirement options');
  const optional = [
    ...(Object.hasOwn(options, 'beforePublish') ? ['beforePublish'] : []),
    ...(Object.hasOwn(options, 'afterIntentPublished')
      ? ['afterIntentPublished']
      : []),
    ...(Object.hasOwn(options, 'afterReceiptPublished')
      ? ['afterReceiptPublished']
      : []),
    ...(Object.hasOwn(options, 'afterSnapshotPublished')
      ? ['afterSnapshotPublished']
      : []),
  ];
  exactKeys(
    options,
    [
      'expectedGeneration',
      'keyId',
      'mutationId',
      'occurredAtMs',
      'proveRetirement',
      'publisher',
      'trustRoot',
      ...optional,
    ],
    'retirement options',
  );
  const expectedGeneration = integer(
    value.expectedGeneration,
    1,
    'expectedGeneration',
  );
  const occurredAtMs = integer(value.occurredAtMs, 0, 'occurredAtMs');
  const publisher = boundedIdentity(value.publisher, 'publisher');
  const keyId = boundedIdentity(value.keyId, 'keyId');
  if (
    typeof value.mutationId !== 'string' ||
    !MUTATION_ID_PATTERN.test(value.mutationId) ||
    typeof value.proveRetirement !== 'function' ||
    [
      value.beforePublish,
      value.afterIntentPublished,
      value.afterReceiptPublished,
      value.afterSnapshotPublished,
    ].some(
      (callback) => callback !== undefined && typeof callback !== 'function',
    )
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'retirement identity is invalid',
    );
  }
  let state = loadState(value.trustRoot);
  const previous = state.snapshots[expectedGeneration - 1];
  if (!previous) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'expected generation is stale',
    );
  }
  const intentMaterial = Object.freeze({
    schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENT_INTENT_SCHEMA,
    publisher,
    keyId,
    expectedGeneration,
    previousTrustDigest: previous.trustDigest,
    mutationId: value.mutationId,
    occurredAtMs,
  });
  const requestedIntent = Object.freeze({
    ...intentMaterial,
    intentDigest: digest(retirementIntentMaterial(intentMaterial)),
  });
  const identityDigest = retirementIdentityDigest(publisher, keyId);
  let existingIntent = state.retirementIntents.find(
    (intent) =>
      retirementIdentityDigest(intent.publisher, intent.keyId) ===
      identityDigest,
  );
  if (
    existingIntent &&
    existingIntent.intentDigest !== requestedIntent.intentDigest
  ) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'publisher key retirement identity was reused',
    );
  }
  let completed = state.snapshots.find(
    (snapshot) =>
      snapshot.mode === 'retire' &&
      snapshot.mutationId === requestedIntent.mutationId,
  );
  await value.beforePublish?.();
  state = loadState(value.trustRoot);
  existingIntent = state.retirementIntents.find(
    (intent) =>
      retirementIdentityDigest(intent.publisher, intent.keyId) ===
      identityDigest,
  );
  if (
    existingIntent &&
    existingIntent.intentDigest !== requestedIntent.intentDigest
  ) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'publisher key retirement identity was reused',
    );
  }
  completed = state.snapshots.find(
    (snapshot) =>
      snapshot.mode === 'retire' &&
      snapshot.mutationId === requestedIntent.mutationId,
  );
  if (completed) {
    if (state.pending?.snapshotDigest === completed.snapshotDigest) {
      promoteCurrent(state.root, completed);
      return Object.freeze({
        status: 'recovered',
        generation: completed.generation,
        keyCount: completed.trust.keys.length,
        trustDigest: completed.trustDigest,
      });
    }
    return Object.freeze({
      status: 'existing',
      generation: completed.generation,
      keyCount: completed.trust.keys.length,
      trustDigest: completed.trustDigest,
    });
  }
  const current = state.current?.trust;
  const target = `${publisher}\0${keyId}`;
  if (
    state.pending ||
    state.pendingRevocation ||
    (state.pendingRetirement &&
      state.pendingRetirement.intentDigest !== requestedIntent.intentDigest) ||
    (state.committed?.generation ?? 0) !== expectedGeneration ||
    !current ||
    !keyMap(current).has(target)
  ) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'retirement does not match the current trust head',
    );
  }
  const remainingTrust = normalizeLocalPluginPackagePublisherTrustDocument({
    schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
    keys: current.keys.filter(
      (key) => `${key.publisher}\0${key.keyId}` !== target,
    ),
  });
  if (activeKeyCount(remainingTrust, occurredAtMs) < 1) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'retirement must retain a currently active publisher key',
    );
  }
  if (!existingIntent) {
    if (
      state.retirementIntents.length >=
      MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENTS
    ) {
      throw new LocalPluginPackagePublisherTrustConflictError(
        'publisher key retirement capacity is exhausted',
      );
    }
    revalidateDirectory(state.root);
    publishImmutableDocument(
      state.root,
      `retirement-${identityDigest}.json`,
      `${JSON.stringify(requestedIntent)}\n`,
      normalizeRetirementIntent,
    );
    await value.afterIntentPublished?.();
  }
  state = loadState(value.trustRoot);
  if (
    state.pending ||
    state.pendingRevocation ||
    state.pendingRetirement?.intentDigest !== requestedIntent.intentDigest ||
    (state.committed?.generation ?? 0) !== expectedGeneration ||
    state.current?.digest !== previous.trustDigest
  ) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'trust state changed after retirement intent publication',
    );
  }
  let receipt = state.retirementReceipts.find(
    (candidate) => candidate.mutationId === requestedIntent.mutationId,
  );
  if (!receipt) {
    const proofValue = await value.proveRetirement();
    const proof = dataRecord(proofValue, 'retirement proof');
    exactKeys(
      proof,
      [
        'bundleCount',
        'catalogEntryCount',
        'matchingEntryCount',
        'unresolvedTransactions',
      ],
      'retirement proof',
    );
    const catalogEntryCount = integer(
      proof.catalogEntryCount,
      0,
      'retirement catalogEntryCount',
    );
    const bundleCount = integer(proof.bundleCount, 0, 'retirement bundleCount');
    const matchingEntryCount = integer(
      proof.matchingEntryCount,
      0,
      'retirement matchingEntryCount',
    );
    const unresolvedTransactions = integer(
      proof.unresolvedTransactions,
      0,
      'retirement unresolvedTransactions',
    );
    if (matchingEntryCount !== 0 || unresolvedTransactions !== 0) {
      throw new LocalPluginPackagePublisherTrustConflictError(
        'catalog signer coverage or transactions still block retirement',
      );
    }
    const receiptMaterial = Object.freeze({
      schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENT_RECEIPT_SCHEMA,
      publisher,
      keyId,
      expectedGeneration,
      mutationId: value.mutationId,
      intentDigest: requestedIntent.intentDigest,
      catalogEntryCount,
      bundleCount,
      matchingEntryCount: 0 as const,
      unresolvedTransactions: 0 as const,
      occurredAtMs,
    });
    receipt = Object.freeze({
      ...receiptMaterial,
      receiptDigest: digest(retirementReceiptMaterial(receiptMaterial)),
    });
    publishImmutableDocument(
      state.root,
      `retirement-receipt-${identityDigest}.json`,
      `${JSON.stringify(receipt)}\n`,
      normalizeRetirementReceipt,
    );
    await value.afterReceiptPublished?.();
  }
  const requestedSnapshot = createSnapshot(
    'retire',
    expectedGeneration,
    value.mutationId,
    occurredAtMs,
    remainingTrust,
    previous,
  );
  state = loadState(value.trustRoot);
  if (
    state.pending ||
    state.pendingRevocation ||
    state.pendingRetirement?.intentDigest !== requestedIntent.intentDigest ||
    !state.retirementReceipts.some(
      (candidate) => candidate.receiptDigest === receipt.receiptDigest,
    ) ||
    (state.committed?.generation ?? 0) !== expectedGeneration ||
    state.current?.digest !== previous.trustDigest
  ) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'trust state changed before retirement publication',
    );
  }
  revalidateDirectory(state.root);
  publishSnapshot(state.root, requestedSnapshot);
  await value.afterSnapshotPublished?.();
  promoteCurrent(state.root, requestedSnapshot);
  return Object.freeze({
    status: existingIntent ? 'recovered' : 'published',
    generation: requestedSnapshot.generation,
    keyCount: requestedSnapshot.trust.keys.length,
    trustDigest: requestedSnapshot.trustDigest,
  });
}
