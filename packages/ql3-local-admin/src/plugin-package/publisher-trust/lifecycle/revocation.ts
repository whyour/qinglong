import {
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATION_PROPOSAL_SCHEMA,
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATION_RECEIPT_SCHEMA,
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
  LocalPluginPackagePublisherTrustConfigurationError,
  LocalPluginPackagePublisherTrustConflictError,
  MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATIONS,
  type ConfirmLocalPluginPackagePublisherKeyRevocationOptions,
  type ConfirmedLocalPluginPackagePublisherKeyRevocation,
  type ProposedLocalPluginPackagePublisherKeyRevocation,
  type ProposeLocalPluginPackagePublisherKeyRevocationOptions,
} from '../contracts';
import {
  DIGEST_PATTERN,
  MUTATION_ID_PATTERN,
  createSnapshot,
  dataRecord,
  exactKeys,
  integer,
  keyMap,
  digest,
  boundedIdentity,
  localPluginPackagePublisherKeyRevocationImpactDigest,
  normalizeLocalPluginPackagePublisherTrustDocument,
  normalizeRevocationProposal,
  normalizeRevocationReceipt,
  retirementIdentityDigest,
  lockDigests,
  revocationProposalMaterial,
  revocationReceiptMaterial,
} from '../codec';
import {
  revalidateDirectory,
  loadState,
  publishSnapshot,
  publishImmutableDocument,
  promoteCurrent,
} from '../privateFilesystemStore';

export async function proposeLocalPluginPackagePublisherKeyRevocation(
  value: ProposeLocalPluginPackagePublisherKeyRevocationOptions,
): Promise<Readonly<ProposedLocalPluginPackagePublisherKeyRevocation>> {
  const options = dataRecord(value, 'revocation proposal options');
  const optional = Object.hasOwn(options, 'beforePublish')
    ? ['beforePublish']
    : [];
  exactKeys(
    options,
    [
      'expectedGeneration',
      'impact',
      'keyId',
      'mutationId',
      'occurredAtMs',
      'proposerSubjectId',
      'publisher',
      'trustRoot',
      ...optional,
    ],
    'revocation proposal options',
  );
  const expectedGeneration = integer(
    value.expectedGeneration,
    1,
    'expectedGeneration',
  );
  const occurredAtMs = integer(value.occurredAtMs, 0, 'occurredAtMs');
  const publisher = boundedIdentity(value.publisher, 'publisher');
  const keyId = boundedIdentity(value.keyId, 'keyId');
  const proposerSubjectId = boundedIdentity(
    value.proposerSubjectId,
    'proposerSubjectId',
  );
  if (
    typeof value.mutationId !== 'string' ||
    !MUTATION_ID_PATTERN.test(value.mutationId) ||
    (value.beforePublish !== undefined &&
      typeof value.beforePublish !== 'function')
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'revocation proposal identity is invalid',
    );
  }
  const impactValue = dataRecord(value.impact, 'revocation impact');
  exactKeys(
    impactValue,
    [
      'bundleCount',
      'catalogEntryCount',
      'impactDigest',
      'impactedLockDigests',
      'matchingEntryCount',
      'unresolvedTransactions',
    ],
    'revocation impact',
  );
  const impactedLockDigests = lockDigests(
    value.impact.impactedLockDigests,
    'revocation impacted lock digests',
  );
  const catalogEntryCount = integer(
    value.impact.catalogEntryCount,
    0,
    'revocation catalogEntryCount',
  );
  const bundleCount = integer(
    value.impact.bundleCount,
    0,
    'revocation bundleCount',
  );
  const matchingEntryCount = integer(
    value.impact.matchingEntryCount,
    0,
    'revocation matchingEntryCount',
  );
  const unresolvedTransactions = integer(
    value.impact.unresolvedTransactions,
    0,
    'revocation unresolvedTransactions',
  );
  const impactDigest = localPluginPackagePublisherKeyRevocationImpactDigest({
    publisher,
    keyId,
    catalogEntryCount,
    bundleCount,
    matchingEntryCount,
    unresolvedTransactions,
    impactedLockDigests,
  });
  if (value.impact.impactDigest !== impactDigest) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'revocation impact digest is invalid',
    );
  }
  let state = loadState(value.trustRoot);
  const previous = state.snapshots[expectedGeneration - 1];
  if (!previous) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'expected generation is stale',
    );
  }
  const material = Object.freeze({
    schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATION_PROPOSAL_SCHEMA,
    publisher,
    keyId,
    expectedGeneration,
    previousTrustDigest: previous.trustDigest,
    mutationId: value.mutationId,
    occurredAtMs,
    proposerSubjectId,
    catalogEntryCount,
    bundleCount,
    matchingEntryCount,
    unresolvedTransactions,
    impactedLockDigests,
    impactDigest,
  });
  const requested = Object.freeze({
    ...material,
    proposalDigest: digest(revocationProposalMaterial(material)),
  });
  const identityDigest = retirementIdentityDigest(publisher, keyId);
  let existing = state.revocationProposals.find(
    (proposal) =>
      retirementIdentityDigest(proposal.publisher, proposal.keyId) ===
      identityDigest,
  );
  if (existing && existing.proposalDigest !== requested.proposalDigest) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'publisher key revocation identity was reused',
    );
  }
  await value.beforePublish?.();
  state = loadState(value.trustRoot);
  existing = state.revocationProposals.find(
    (proposal) =>
      retirementIdentityDigest(proposal.publisher, proposal.keyId) ===
      identityDigest,
  );
  if (existing) {
    if (existing.proposalDigest !== requested.proposalDigest) {
      throw new LocalPluginPackagePublisherTrustConflictError(
        'publisher key revocation identity was reused',
      );
    }
    return Object.freeze({
      status: 'existing',
      generation: existing.expectedGeneration,
      proposalDigest: existing.proposalDigest,
      impactDigest: existing.impactDigest,
      matchingEntryCount: existing.matchingEntryCount,
      runtimeAction: 'stop_required',
    });
  }
  const current = state.current?.trust;
  const target = `${publisher}\0${keyId}`;
  if (
    state.pending ||
    state.pendingRetirement ||
    state.pendingRevocation ||
    (state.committed?.generation ?? 0) !== expectedGeneration ||
    state.current?.digest !== previous.trustDigest ||
    !current ||
    !keyMap(current).has(target)
  ) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'revocation proposal does not match the current trust head',
    );
  }
  const remainingTrust = normalizeLocalPluginPackagePublisherTrustDocument({
    schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
    keys: current.keys.filter(
      (key) => `${key.publisher}\0${key.keyId}` !== target,
    ),
  });
  if (
    state.revocationProposals.length >=
    MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATIONS
  ) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'publisher key revocation capacity is exhausted',
    );
  }
  revalidateDirectory(state.root);
  publishImmutableDocument(
    state.root,
    `revocation-${identityDigest}.json`,
    `${JSON.stringify(requested)}\n`,
    normalizeRevocationProposal,
  );
  return Object.freeze({
    status: 'proposed',
    generation: expectedGeneration,
    proposalDigest: requested.proposalDigest,
    impactDigest,
    matchingEntryCount,
    runtimeAction: 'stop_required',
  });
}

export async function confirmLocalPluginPackagePublisherKeyRevocation(
  value: ConfirmLocalPluginPackagePublisherKeyRevocationOptions,
): Promise<Readonly<ConfirmedLocalPluginPackagePublisherKeyRevocation>> {
  const options = dataRecord(value, 'revocation confirmation options');
  const optional = [
    ...(Object.hasOwn(options, 'beforePublish') ? ['beforePublish'] : []),
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
      'authorizationMode',
      'confirmedAtMs',
      'confirmerSubjectId',
      'confirmAuthorization',
      'expectedGeneration',
      'expectedImpactDigest',
      'keyId',
      'mutationId',
      'proposerSubjectId',
      'publisher',
      'reasonCode',
      'trustRoot',
      ...optional,
    ],
    'revocation confirmation options',
  );
  const expectedGeneration = integer(
    value.expectedGeneration,
    1,
    'expectedGeneration',
  );
  const confirmedAtMs = integer(value.confirmedAtMs, 0, 'confirmedAtMs');
  const publisher = boundedIdentity(value.publisher, 'publisher');
  const keyId = boundedIdentity(value.keyId, 'keyId');
  const proposerSubjectId = boundedIdentity(
    value.proposerSubjectId,
    'proposerSubjectId',
  );
  const confirmerSubjectId = boundedIdentity(
    value.confirmerSubjectId,
    'confirmerSubjectId',
  );
  if (
    typeof value.mutationId !== 'string' ||
    !MUTATION_ID_PATTERN.test(value.mutationId) ||
    typeof value.expectedImpactDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.expectedImpactDigest) ||
    (value.authorizationMode !== 'dual_control' &&
      value.authorizationMode !== 'break_glass') ||
    (value.reasonCode !== 'suspected_key_compromise' &&
      value.reasonCode !== 'confirmed_key_compromise') ||
    typeof value.confirmAuthorization !== 'function' ||
    [
      value.beforePublish,
      value.afterReceiptPublished,
      value.afterSnapshotPublished,
    ].some(
      (callback) => callback !== undefined && typeof callback !== 'function',
    )
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'revocation confirmation identity is invalid',
    );
  }
  if (
    value.authorizationMode === 'dual_control' &&
    proposerSubjectId === confirmerSubjectId
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'dual-control revocation requires a distinct Owner',
    );
  }
  let state = loadState(value.trustRoot);
  const identityDigest = retirementIdentityDigest(publisher, keyId);
  const proposal = state.revocationProposals.find(
    (candidate) =>
      retirementIdentityDigest(candidate.publisher, candidate.keyId) ===
      identityDigest,
  );
  if (
    !proposal ||
    proposal.expectedGeneration !== expectedGeneration ||
    proposal.mutationId !== value.mutationId ||
    proposal.proposerSubjectId !== proposerSubjectId ||
    proposal.impactDigest !== value.expectedImpactDigest
  ) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'revocation confirmation does not match its proposal',
    );
  }
  let completed = state.snapshots.find(
    (snapshot) =>
      snapshot.mode === 'revoke' && snapshot.mutationId === proposal.mutationId,
  );
  await value.confirmAuthorization();
  await value.beforePublish?.();
  state = loadState(value.trustRoot);
  completed = state.snapshots.find(
    (snapshot) =>
      snapshot.mode === 'revoke' && snapshot.mutationId === proposal.mutationId,
  );
  if (completed) {
    const receipt = state.revocationReceipts.find(
      (candidate) => candidate.mutationId === proposal.mutationId,
    )!;
    if (
      receipt.confirmerSubjectId !== confirmerSubjectId ||
      receipt.authorizationMode !== value.authorizationMode ||
      receipt.reasonCode !== value.reasonCode ||
      receipt.confirmedAtMs !== confirmedAtMs
    ) {
      throw new LocalPluginPackagePublisherTrustConflictError(
        'revocation confirmation identity was reused',
      );
    }
    await value.afterReceiptPublished?.(receipt);
    if (state.pending?.snapshotDigest === completed.snapshotDigest) {
      promoteCurrent(state.root, completed);
      return Object.freeze({
        status: 'recovered',
        generation: completed.generation,
        keyCount: completed.trust.keys.length,
        trustDigest: completed.trustDigest,
        authorizationMode: receipt.authorizationMode,
        quarantinedLockCount: receipt.impactedLockDigests.length,
        runtimeAction: 'restart_required',
      });
    }
    return Object.freeze({
      status: 'existing',
      generation: completed.generation,
      keyCount: completed.trust.keys.length,
      trustDigest: completed.trustDigest,
      authorizationMode: receipt.authorizationMode,
      quarantinedLockCount: receipt.impactedLockDigests.length,
      runtimeAction: 'restart_required',
    });
  }
  const previous = state.snapshots[expectedGeneration - 1];
  const current = state.current?.trust;
  const target = `${publisher}\0${keyId}`;
  if (
    state.pending ||
    state.pendingRetirement ||
    state.pendingRevocation?.proposalDigest !== proposal.proposalDigest ||
    !previous ||
    previous.trustDigest !== proposal.previousTrustDigest ||
    (state.committed?.generation ?? 0) !== expectedGeneration ||
    state.current?.digest !== proposal.previousTrustDigest ||
    !current ||
    !keyMap(current).has(target)
  ) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'trust state changed before revocation confirmation',
    );
  }
  const remainingTrust = normalizeLocalPluginPackagePublisherTrustDocument({
    schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
    keys: current.keys.filter(
      (key) => `${key.publisher}\0${key.keyId}` !== target,
    ),
  });
  const receiptMaterial = Object.freeze({
    schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATION_RECEIPT_SCHEMA,
    publisher,
    keyId,
    expectedGeneration,
    mutationId: value.mutationId,
    proposalDigest: proposal.proposalDigest,
    proposerSubjectId,
    confirmerSubjectId,
    authorizationMode: value.authorizationMode,
    reasonCode: value.reasonCode,
    confirmedAtMs,
    impactDigest: proposal.impactDigest,
    impactedLockDigests: proposal.impactedLockDigests,
  });
  const requestedReceipt = Object.freeze({
    ...receiptMaterial,
    receiptDigest: digest(revocationReceiptMaterial(receiptMaterial)),
  });
  const existingReceipt = state.revocationReceipts.find(
    (candidate) => candidate.mutationId === proposal.mutationId,
  );
  if (
    existingReceipt &&
    existingReceipt.receiptDigest !== requestedReceipt.receiptDigest
  ) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'revocation receipt identity was reused',
    );
  }
  if (!existingReceipt) {
    publishImmutableDocument(
      state.root,
      `revocation-receipt-${identityDigest}.json`,
      `${JSON.stringify(requestedReceipt)}\n`,
      normalizeRevocationReceipt,
    );
  }
  await value.afterReceiptPublished?.(requestedReceipt);
  const requestedSnapshot = createSnapshot(
    'revoke',
    expectedGeneration,
    value.mutationId,
    confirmedAtMs,
    remainingTrust,
    previous,
  );
  state = loadState(value.trustRoot);
  if (
    state.pending ||
    state.pendingRetirement ||
    state.pendingRevocation?.proposalDigest !== proposal.proposalDigest ||
    !state.revocationReceipts.some(
      (candidate) => candidate.receiptDigest === requestedReceipt.receiptDigest,
    ) ||
    (state.committed?.generation ?? 0) !== expectedGeneration ||
    state.current?.digest !== proposal.previousTrustDigest
  ) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'trust state changed before revocation publication',
    );
  }
  revalidateDirectory(state.root);
  publishSnapshot(state.root, requestedSnapshot);
  await value.afterSnapshotPublished?.();
  promoteCurrent(state.root, requestedSnapshot);
  return Object.freeze({
    status: existingReceipt ? 'recovered' : 'published',
    generation: requestedSnapshot.generation,
    keyCount: requestedSnapshot.trust.keys.length,
    trustDigest: requestedSnapshot.trustDigest,
    authorizationMode: requestedReceipt.authorizationMode,
    quarantinedLockCount: requestedReceipt.impactedLockDigests.length,
    runtimeAction: 'restart_required',
  });
}
