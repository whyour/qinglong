import { randomBytes } from 'node:crypto';
import fs, { constants } from 'node:fs';
import path from 'node:path';

import {
  LocalPluginPackagePublisherTrustConfigurationError,
  LocalPluginPackagePublisherTrustConflictError,
  MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_GENERATIONS,
  MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENTS,
  MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATIONS,
  type LocalPluginPackagePublisherTrustDocument,
} from './contracts';
import {
  activeKeyCount,
  digest,
  keyMap,
  normalizeLocalPluginPackagePublisherTrustDocument,
  canonicalTrust,
  retirementIdentityDigest,
  normalizeRetirementIntent,
  normalizeRetirementReceipt,
  normalizeRevocationProposal,
  normalizeRevocationReceipt,
  normalizeSnapshot,
  sameSnapshot,
  snapshotName,
  type TrustSnapshot,
  type RetirementIntent,
  type RetirementReceipt,
  type RevocationProposal,
  type RevocationReceipt,
} from './codec';
const CURRENT_FILE = 'current.json';
const SNAPSHOT_PATTERN = /^([0-9]{20})\.json$/;
export const TEMPORARY_PATTERN = /^\.qlpkg-trust-[0-9a-f]{32}\.tmp$/;
const RETIREMENT_INTENT_PATTERN = /^retirement-([0-9a-f]{64})\.json$/;
const RETIREMENT_RECEIPT_PATTERN = /^retirement-receipt-([0-9a-f]{64})\.json$/;
const REVOCATION_PROPOSAL_PATTERN = /^revocation-([0-9a-f]{64})\.json$/;
const REVOCATION_RECEIPT_PATTERN = /^revocation-receipt-([0-9a-f]{64})\.json$/;
const MAX_ROOT_ENTRIES =
  MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_GENERATIONS * 2 +
  MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENTS * 2 +
  MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATIONS * 2 +
  1;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PATH_BYTES = 4_096;

export interface DirectoryIdentity {
  readonly path: string;
  readonly uid: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly entries: readonly string[];
}

export interface LoadedState {
  readonly root: DirectoryIdentity;
  readonly snapshots: readonly Readonly<TrustSnapshot>[];
  readonly current:
    | Readonly<{
        trust: Readonly<LocalPluginPackagePublisherTrustDocument>;
        digest: string;
      }>
    | undefined;
  readonly committed: Readonly<TrustSnapshot> | undefined;
  readonly pending: Readonly<TrustSnapshot> | undefined;
  readonly retirementIntents: readonly Readonly<RetirementIntent>[];
  readonly retirementReceipts: readonly Readonly<RetirementReceipt>[];
  readonly pendingRetirement: Readonly<RetirementIntent> | undefined;
  readonly revocationProposals: readonly Readonly<RevocationProposal>[];
  readonly revocationReceipts: readonly Readonly<RevocationReceipt>[];
  readonly pendingRevocation: Readonly<RevocationProposal> | undefined;
}

export function absolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

export function currentUid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    process.getuid() !== process.geteuid()
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'real and effective POSIX users must match',
    );
  }
  return process.getuid();
}

export function directory(candidate: unknown): DirectoryIdentity {
  const root = absolutePath(candidate, 'trustRoot');
  const uid = currentUid();
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(root, { bigint: true });
  } catch (error) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'trust root is unavailable',
      error,
    );
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    (Number(stat.mode) & 0o777) !== 0o700 ||
    fs.realpathSync(root) !== root
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'trust root must be an owner-only non-symlink directory',
    );
  }
  const entries = fs.readdirSync(root).sort();
  const snapshots = entries.filter((entry) => SNAPSHOT_PATTERN.test(entry));
  const temporary = entries.filter((entry) => TEMPORARY_PATTERN.test(entry));
  const retirementIntents = entries.filter((entry) =>
    RETIREMENT_INTENT_PATTERN.test(entry),
  );
  const retirementReceipts = entries.filter((entry) =>
    RETIREMENT_RECEIPT_PATTERN.test(entry),
  );
  const revocationProposals = entries.filter((entry) =>
    REVOCATION_PROPOSAL_PATTERN.test(entry),
  );
  const revocationReceipts = entries.filter((entry) =>
    REVOCATION_RECEIPT_PATTERN.test(entry),
  );
  if (
    entries.length > MAX_ROOT_ENTRIES ||
    snapshots.length > MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_GENERATIONS ||
    temporary.length > MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_GENERATIONS ||
    retirementIntents.length >
      MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENTS ||
    retirementReceipts.length >
      MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENTS ||
    revocationProposals.length >
      MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATIONS ||
    revocationReceipts.length >
      MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATIONS ||
    entries.some(
      (entry) =>
        entry !== CURRENT_FILE &&
        !SNAPSHOT_PATTERN.test(entry) &&
        !TEMPORARY_PATTERN.test(entry) &&
        !RETIREMENT_INTENT_PATTERN.test(entry) &&
        !RETIREMENT_RECEIPT_PATTERN.test(entry) &&
        !REVOCATION_PROPOSAL_PATTERN.test(entry) &&
        !REVOCATION_RECEIPT_PATTERN.test(entry),
    )
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'trust root contains unbounded or unknown entries',
    );
  }
  return Object.freeze({
    path: root,
    uid,
    device: stat.dev,
    inode: stat.ino,
    entries: Object.freeze(entries),
  });
}

export function revalidateDirectory(identity: DirectoryIdentity): void {
  const stat = fs.lstatSync(identity.path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== identity.uid ||
    (Number(stat.mode) & 0o777) !== 0o700 ||
    stat.dev !== identity.device ||
    stat.ino !== identity.inode ||
    fs.realpathSync(identity.path) !== identity.path
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'trust root identity changed',
    );
  }
}

export function syncDirectory(directoryPath: string): void {
  const descriptor = fs.openSync(directoryPath, constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readPrivateJson(filePath: string, uid: number): unknown {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      constants.O_RDONLY |
        (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0),
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      (Number(before.mode) & 0o777) !== 0o600 ||
      before.size < 1n ||
      before.size > BigInt(MAX_FILE_BYTES)
    ) {
      throw new LocalPluginPackagePublisherTrustConfigurationError(
        'trust file must be a bounded owner-only regular file',
      );
    }
    const buffer = Buffer.alloc(Number(before.size) + 1);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      bytes !== Number(before.size) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      Number(after.uid) !== uid ||
      (Number(after.mode) & 0o777) !== 0o600
    ) {
      throw new LocalPluginPackagePublisherTrustConfigurationError(
        'trust file changed while being read',
      );
    }
    const text = buffer.subarray(0, bytes).toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(buffer.subarray(0, bytes))) {
      throw new LocalPluginPackagePublisherTrustConfigurationError(
        'trust file must contain strict UTF-8',
      );
    }
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof LocalPluginPackagePublisherTrustConfigurationError) {
      throw error;
    }
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'trust file cannot be read',
      error,
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function loadRetirements(
  root: DirectoryIdentity,
  snapshots: readonly Readonly<TrustSnapshot>[],
): Readonly<{
  intents: readonly Readonly<RetirementIntent>[];
  receipts: readonly Readonly<RetirementReceipt>[];
  pending: Readonly<RetirementIntent> | undefined;
}> {
  const intents = root.entries
    .filter((entry) => RETIREMENT_INTENT_PATTERN.test(entry))
    .map((entry) => {
      const intent = normalizeRetirementIntent(
        readPrivateJson(path.join(root.path, entry), root.uid),
      );
      if (
        entry !==
        `retirement-${retirementIdentityDigest(
          intent.publisher,
          intent.keyId,
        )}.json`
      ) {
        throw new LocalPluginPackagePublisherTrustConfigurationError(
          'publisher key retirement intent filename is invalid',
        );
      }
      return intent;
    });
  const receipts = root.entries
    .filter((entry) => RETIREMENT_RECEIPT_PATTERN.test(entry))
    .map((entry) => {
      const receipt = normalizeRetirementReceipt(
        readPrivateJson(path.join(root.path, entry), root.uid),
      );
      if (
        entry !==
        `retirement-receipt-${retirementIdentityDigest(
          receipt.publisher,
          receipt.keyId,
        )}.json`
      ) {
        throw new LocalPluginPackagePublisherTrustConfigurationError(
          'publisher key retirement receipt filename is invalid',
        );
      }
      return receipt;
    });
  const intentByMutation = new Map(
    intents.map((intent) => [intent.mutationId, intent]),
  );
  const receiptByMutation = new Map(
    receipts.map((receipt) => [receipt.mutationId, receipt]),
  );
  if (
    intentByMutation.size !== intents.length ||
    receiptByMutation.size !== receipts.length
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher key retirement mutation identity is duplicated',
    );
  }
  for (const receipt of receipts) {
    const intent = intentByMutation.get(receipt.mutationId);
    if (
      !intent ||
      receipt.publisher !== intent.publisher ||
      receipt.keyId !== intent.keyId ||
      receipt.expectedGeneration !== intent.expectedGeneration ||
      receipt.intentDigest !== intent.intentDigest ||
      receipt.occurredAtMs !== intent.occurredAtMs
    ) {
      throw new LocalPluginPackagePublisherTrustConfigurationError(
        'publisher key retirement receipt is not bound to its intent',
      );
    }
  }
  for (const snapshot of snapshots.filter(({ mode }) => mode === 'retire')) {
    const intent = intentByMutation.get(snapshot.mutationId);
    const receipt = receiptByMutation.get(snapshot.mutationId);
    const previous = snapshots[snapshot.generation - 2];
    if (
      !intent ||
      !receipt ||
      !previous ||
      intent.expectedGeneration !== previous.generation ||
      intent.previousTrustDigest !== previous.trustDigest ||
      intent.occurredAtMs !== snapshot.occurredAtMs
    ) {
      throw new LocalPluginPackagePublisherTrustConfigurationError(
        'publisher key retirement snapshot lacks its proof chain',
      );
    }
    const before = keyMap(previous.trust);
    const after = keyMap(snapshot.trust);
    const target = `${intent.publisher}\0${intent.keyId}`;
    if (
      !before.has(target) ||
      after.has(target) ||
      before.size !== after.size + 1 ||
      [...after].some(
        ([identifier, definition]) =>
          JSON.stringify(before.get(identifier)) !== JSON.stringify(definition),
      ) ||
      activeKeyCount(snapshot.trust, snapshot.occurredAtMs) < 1
    ) {
      throw new LocalPluginPackagePublisherTrustConfigurationError(
        'publisher key retirement snapshot transition is invalid',
      );
    }
  }
  const pending = intents.filter(
    (intent) =>
      !snapshots.some(
        (snapshot) =>
          snapshot.mode === 'retire' &&
          snapshot.mutationId === intent.mutationId,
      ),
  );
  if (
    pending.length > 1 ||
    pending.some(
      (intent) =>
        intent.expectedGeneration !== snapshots.length ||
        intent.previousTrustDigest !== snapshots.at(-1)?.trustDigest,
    )
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher key retirement intent does not match the trust head',
    );
  }
  return Object.freeze({
    intents: Object.freeze(intents),
    receipts: Object.freeze(receipts),
    pending: pending[0],
  });
}

export function loadRevocations(
  root: DirectoryIdentity,
  snapshots: readonly Readonly<TrustSnapshot>[],
): Readonly<{
  proposals: readonly Readonly<RevocationProposal>[];
  receipts: readonly Readonly<RevocationReceipt>[];
  pending: Readonly<RevocationProposal> | undefined;
}> {
  const proposals = root.entries
    .filter((entry) => REVOCATION_PROPOSAL_PATTERN.test(entry))
    .map((entry) => {
      const proposal = normalizeRevocationProposal(
        readPrivateJson(path.join(root.path, entry), root.uid),
      );
      if (
        entry !==
        `revocation-${retirementIdentityDigest(
          proposal.publisher,
          proposal.keyId,
        )}.json`
      ) {
        throw new LocalPluginPackagePublisherTrustConfigurationError(
          'publisher key revocation proposal filename is invalid',
        );
      }
      return proposal;
    });
  const receipts = root.entries
    .filter((entry) => REVOCATION_RECEIPT_PATTERN.test(entry))
    .map((entry) => {
      const receipt = normalizeRevocationReceipt(
        readPrivateJson(path.join(root.path, entry), root.uid),
      );
      if (
        entry !==
        `revocation-receipt-${retirementIdentityDigest(
          receipt.publisher,
          receipt.keyId,
        )}.json`
      ) {
        throw new LocalPluginPackagePublisherTrustConfigurationError(
          'publisher key revocation receipt filename is invalid',
        );
      }
      return receipt;
    });
  const proposalByMutation = new Map(
    proposals.map((proposal) => [proposal.mutationId, proposal]),
  );
  const receiptByMutation = new Map(
    receipts.map((receipt) => [receipt.mutationId, receipt]),
  );
  if (
    proposalByMutation.size !== proposals.length ||
    receiptByMutation.size !== receipts.length
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher key revocation mutation identity is duplicated',
    );
  }
  for (const receipt of receipts) {
    const proposal = proposalByMutation.get(receipt.mutationId);
    if (
      !proposal ||
      receipt.publisher !== proposal.publisher ||
      receipt.keyId !== proposal.keyId ||
      receipt.expectedGeneration !== proposal.expectedGeneration ||
      receipt.proposalDigest !== proposal.proposalDigest ||
      receipt.proposerSubjectId !== proposal.proposerSubjectId ||
      receipt.impactDigest !== proposal.impactDigest ||
      JSON.stringify(receipt.impactedLockDigests) !==
        JSON.stringify(proposal.impactedLockDigests) ||
      receipt.confirmedAtMs < proposal.occurredAtMs
    ) {
      throw new LocalPluginPackagePublisherTrustConfigurationError(
        'publisher key revocation receipt is not bound to its proposal',
      );
    }
  }
  for (const snapshot of snapshots.filter(({ mode }) => mode === 'revoke')) {
    const proposal = proposalByMutation.get(snapshot.mutationId);
    const receipt = receiptByMutation.get(snapshot.mutationId);
    const previous = snapshots[snapshot.generation - 2];
    if (
      !proposal ||
      !receipt ||
      !previous ||
      proposal.expectedGeneration !== previous.generation ||
      proposal.previousTrustDigest !== previous.trustDigest ||
      receipt.confirmedAtMs !== snapshot.occurredAtMs
    ) {
      throw new LocalPluginPackagePublisherTrustConfigurationError(
        'publisher key revocation snapshot lacks its authorization chain',
      );
    }
    const before = keyMap(previous.trust);
    const after = keyMap(snapshot.trust);
    const target = `${proposal.publisher}\0${proposal.keyId}`;
    if (
      !before.has(target) ||
      after.has(target) ||
      before.size !== after.size + 1 ||
      [...after].some(
        ([identifier, definition]) =>
          JSON.stringify(before.get(identifier)) !== JSON.stringify(definition),
      )
    ) {
      throw new LocalPluginPackagePublisherTrustConfigurationError(
        'publisher key revocation snapshot transition is invalid',
      );
    }
  }
  const pending = proposals.filter(
    (proposal) =>
      !snapshots.some(
        (snapshot) =>
          snapshot.mode === 'revoke' &&
          snapshot.mutationId === proposal.mutationId,
      ),
  );
  if (
    pending.length > 1 ||
    pending.some(
      (proposal) =>
        proposal.expectedGeneration !== snapshots.length ||
        proposal.previousTrustDigest !== snapshots.at(-1)?.trustDigest,
    )
  ) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher key revocation proposal does not match the trust head',
    );
  }
  return Object.freeze({
    proposals: Object.freeze(proposals),
    receipts: Object.freeze(receipts),
    pending: pending[0],
  });
}

export function loadState(candidateRoot: unknown): LoadedState {
  const root = directory(candidateRoot);
  const snapshots = root.entries
    .filter((entry) => SNAPSHOT_PATTERN.test(entry))
    .map((entry) => {
      const match = SNAPSHOT_PATTERN.exec(entry)!;
      const generation = Number(match[1]);
      const snapshot = normalizeSnapshot(
        readPrivateJson(path.join(root.path, entry), root.uid),
      );
      if (
        !Number.isSafeInteger(generation) ||
        generation !== snapshot.generation ||
        entry !== snapshotName(snapshot.generation)
      ) {
        throw new LocalPluginPackagePublisherTrustConfigurationError(
          'publisher trust snapshot filename is invalid',
        );
      }
      return snapshot;
    })
    .sort((left, right) => left.generation - right.generation);
  for (const [index, snapshot] of snapshots.entries()) {
    const previous = snapshots[index - 1];
    if (
      snapshot.generation !== index + 1 ||
      (previous === undefined
        ? snapshot.mode !== 'provision' ||
          snapshot.previousSnapshotDigest !== null ||
          snapshot.previousTrustDigest !== null
        : (snapshot.mode !== 'rotate' &&
            snapshot.mode !== 'retire' &&
            snapshot.mode !== 'revoke') ||
          snapshot.previousSnapshotDigest !== previous.snapshotDigest ||
          snapshot.previousTrustDigest !== previous.trustDigest)
    ) {
      throw new LocalPluginPackagePublisherTrustConfigurationError(
        'publisher trust snapshot chain is invalid',
      );
    }
  }
  const retirements = loadRetirements(root, snapshots);
  const revocations = loadRevocations(root, snapshots);
  if (retirements.pending && revocations.pending) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'trust root has conflicting pending key lifecycle mutations',
    );
  }
  const currentPath = path.join(root.path, CURRENT_FILE);
  const current = root.entries.includes(CURRENT_FILE)
    ? (() => {
        const trust = normalizeLocalPluginPackagePublisherTrustDocument(
          readPrivateJson(currentPath, root.uid),
        );
        return Object.freeze({
          trust,
          digest: digest(canonicalTrust(trust)),
        });
      })()
    : undefined;
  if (snapshots.length === 0) {
    if (current !== undefined) {
      throw new LocalPluginPackagePublisherTrustConfigurationError(
        'publisher trust current file has no immutable snapshot',
      );
    }
    return Object.freeze({
      root,
      snapshots: Object.freeze([]),
      current: undefined,
      committed: undefined,
      pending: undefined,
      retirementIntents: retirements.intents,
      retirementReceipts: retirements.receipts,
      pendingRetirement: retirements.pending,
      revocationProposals: revocations.proposals,
      revocationReceipts: revocations.receipts,
      pendingRevocation: revocations.pending,
    });
  }
  const latest = snapshots.at(-1)!;
  if (current?.digest === latest.trustDigest) {
    return Object.freeze({
      root,
      snapshots: Object.freeze(snapshots),
      current,
      committed: latest,
      pending: undefined,
      retirementIntents: retirements.intents,
      retirementReceipts: retirements.receipts,
      pendingRetirement: retirements.pending,
      revocationProposals: revocations.proposals,
      revocationReceipts: revocations.receipts,
      pendingRevocation: revocations.pending,
    });
  }
  const previous = snapshots.at(-2);
  if (
    (previous === undefined && current === undefined) ||
    current?.digest === previous?.trustDigest
  ) {
    return Object.freeze({
      root,
      snapshots: Object.freeze(snapshots),
      current,
      committed: previous,
      pending: latest,
      retirementIntents: retirements.intents,
      retirementReceipts: retirements.receipts,
      pendingRetirement: retirements.pending,
      revocationProposals: revocations.proposals,
      revocationReceipts: revocations.receipts,
      pendingRevocation: revocations.pending,
    });
  }
  throw new LocalPluginPackagePublisherTrustConfigurationError(
    'publisher trust current file does not match its snapshot chain',
  );
}

export function writePrivateTemporary(
  root: DirectoryIdentity,
  contents: string,
): string {
  if (Buffer.byteLength(contents, 'utf8') > MAX_FILE_BYTES) {
    throw new LocalPluginPackagePublisherTrustConfigurationError(
      'publisher trust file exceeds its byte bound',
    );
  }
  const temporaryPath = path.join(
    root.path,
    `.qlpkg-trust-${randomBytes(16).toString('hex')}.tmp`,
  );
  const descriptor = fs.openSync(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return temporaryPath;
}

export function publishSnapshot(
  root: DirectoryIdentity,
  snapshot: Readonly<TrustSnapshot>,
): void {
  const targetPath = path.join(root.path, snapshotName(snapshot.generation));
  const temporaryPath = writePrivateTemporary(
    root,
    `${JSON.stringify(snapshot)}\n`,
  );
  try {
    try {
      fs.linkSync(temporaryPath, targetPath);
      syncDirectory(root.path);
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error as { code?: string }).code !== 'EEXIST'
      ) {
        throw error;
      }
      const existing = normalizeSnapshot(readPrivateJson(targetPath, root.uid));
      if (!sameSnapshot(existing, snapshot)) {
        throw new LocalPluginPackagePublisherTrustConflictError(
          'another trust generation won publication',
        );
      }
    }
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
      syncDirectory(root.path);
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error as { code?: string }).code !== 'ENOENT'
      ) {
        throw error;
      }
    }
  }
}

export function publishImmutableDocument(
  root: DirectoryIdentity,
  fileName: string,
  contents: string,
  normalize: (value: unknown) => Readonly<{ readonly schema: string }>,
): void {
  const targetPath = path.join(root.path, fileName);
  const temporaryPath = writePrivateTemporary(root, contents);
  try {
    try {
      fs.linkSync(temporaryPath, targetPath);
      syncDirectory(root.path);
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error as { code?: string }).code !== 'EEXIST'
      ) {
        throw error;
      }
      const existing = normalize(readPrivateJson(targetPath, root.uid));
      if (`${JSON.stringify(existing)}\n` !== contents) {
        throw new LocalPluginPackagePublisherTrustConflictError(
          'immutable retirement evidence already has different content',
        );
      }
    }
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
      syncDirectory(root.path);
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error as { code?: string }).code !== 'ENOENT'
      ) {
        throw error;
      }
    }
  }
}

export function promoteCurrent(
  root: DirectoryIdentity,
  snapshot: Readonly<TrustSnapshot>,
): void {
  revalidateDirectory(root);
  const currentPath = path.join(root.path, CURRENT_FILE);
  if (fs.existsSync(currentPath)) {
    const current = normalizeLocalPluginPackagePublisherTrustDocument(
      readPrivateJson(currentPath, root.uid),
    );
    const currentDigest = digest(canonicalTrust(current));
    if (currentDigest === snapshot.trustDigest) return;
    if (currentDigest !== snapshot.previousTrustDigest) {
      throw new LocalPluginPackagePublisherTrustConflictError(
        'current trust changed before promotion',
      );
    }
  } else if (snapshot.previousTrustDigest !== null) {
    throw new LocalPluginPackagePublisherTrustConflictError(
      'current trust disappeared before promotion',
    );
  }
  const temporaryPath = writePrivateTemporary(
    root,
    canonicalTrust(snapshot.trust),
  );
  try {
    if (snapshot.previousTrustDigest === null) {
      try {
        fs.linkSync(temporaryPath, currentPath);
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          (error as { code?: string }).code !== 'EEXIST'
        ) {
          throw error;
        }
        const current = normalizeLocalPluginPackagePublisherTrustDocument(
          readPrivateJson(currentPath, root.uid),
        );
        if (digest(canonicalTrust(current)) !== snapshot.trustDigest) {
          throw new LocalPluginPackagePublisherTrustConflictError(
            'another initial trust won publication',
          );
        }
      }
    } else {
      fs.renameSync(temporaryPath, currentPath);
    }
    syncDirectory(root.path);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
      syncDirectory(root.path);
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error as { code?: string }).code !== 'ENOENT'
      ) {
        throw error;
      }
    }
  }
}
