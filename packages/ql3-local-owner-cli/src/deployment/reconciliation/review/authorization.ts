import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { LocalSecretKeyMaterial } from '@qinglong/runtime-core/local-secret';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';

import { LocalDeploymentConfigurationError } from '../../foundation/error';
import {
  LOCAL_RECONCILIATION_PLAN_DOMAINS,
  type LocalReconciliationPlanDomain,
} from '../planning/contract';
import type {
  LocalReconciliationReviewDecision,
  LocalReconciliationReviewDisposition,
  LocalReconciliationReviewReason,
} from './decisionFile';
import { LocalReconciliationReviewIssuerKeyringFileProvider } from './issuerKeyring';

const HEADER_KIND =
  'qinglong3-local-reconciliation-review-authorization-header';
const DECISION_KIND =
  'qinglong3-local-reconciliation-review-authorization-decision';
const SIGNATURE_KIND =
  'qinglong3-local-reconciliation-review-authorization-signature';
const MAX_LINE_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface LocalReconciliationReviewAuthorizationHeader {
  readonly schemaVersion: 1;
  readonly kind: typeof HEADER_KIND;
  readonly reviewId: string;
  readonly profile: 'edge' | 'standalone';
  readonly planDigest: string;
  readonly preparationDigest: string;
  readonly bundleDigest: string;
  readonly bundleFingerprintDigest: string;
  readonly preparedHeadDigest: string;
  readonly reviewer: Readonly<SecurityPrincipal>;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface LocalReconciliationReviewAuthorizationEvidence {
  readonly fileBytes: number;
  readonly authorizationDigest: string;
  readonly decisionCount: number;
  readonly decisionSetDigest: string;
  readonly decisionFileDigest: string;
  readonly keyId: string;
  readonly dispositionCounts: Readonly<
    Record<LocalReconciliationReviewDisposition, number>
  >;
  readonly reasonCounts: Readonly<
    Record<LocalReconciliationReviewReason, number>
  >;
  readonly domainDecisionCounts: readonly Readonly<LocalReconciliationReviewAuthorizationDomainDecisionCounts>[];
  readonly header: Readonly<LocalReconciliationReviewAuthorizationHeader>;
}

export interface LocalReconciliationReviewAuthorizationDomainDecisionCounts {
  readonly domain: LocalReconciliationPlanDomain;
  readonly legacy: Readonly<
    Record<LocalReconciliationReviewDisposition, number>
  >;
  readonly target: Readonly<
    Record<LocalReconciliationReviewDisposition, number>
  >;
}

interface SignatureRecord {
  readonly schemaVersion: 1;
  readonly kind: typeof SIGNATURE_KIND;
  readonly algorithm: 'hmac-sha256';
  readonly keyId: string;
  readonly contentBytes: number;
  readonly contentDigest: string;
  readonly decisionCount: number;
  readonly decisionSetDigest: string;
  readonly decisionFileDigest: string;
  readonly dispositionCounts: Readonly<
    Record<LocalReconciliationReviewDisposition, number>
  >;
  readonly reasonCounts: Readonly<
    Record<LocalReconciliationReviewReason, number>
  >;
  readonly authenticationTag: string;
}

const DISPOSITIONS = [
  'retain_target',
  'adopt_legacy',
  'retain_both',
  'exclude_legacy',
  'defer',
  'manual_external',
] as const;
const REASONS = [
  'preserve_target',
  'prefer_legacy',
  'preserve_both',
  'legacy_excluded',
  'deferred_review',
  'external_recovery_required',
] as const;

function zeroCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function zeroDomainDecisionCounts(): Array<{
  domain: LocalReconciliationPlanDomain;
  legacy: Record<LocalReconciliationReviewDisposition, number>;
  target: Record<LocalReconciliationReviewDisposition, number>;
}> {
  return LOCAL_RECONCILIATION_PLAN_DOMAINS.map((domain) => ({
    domain,
    legacy: zeroCounts(DISPOSITIONS),
    target: zeroCounts(DISPOSITIONS),
  }));
}

function freezeDomainDecisionCounts(
  counts: ReturnType<typeof zeroDomainDecisionCounts>,
): readonly Readonly<LocalReconciliationReviewAuthorizationDomainDecisionCounts>[] {
  return Object.freeze(
    counts.map((selected) =>
      Object.freeze({
        domain: selected.domain,
        legacy: Object.freeze({ ...selected.legacy }),
        target: Object.freeze({ ...selected.target }),
      }),
    ),
  );
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation review authorization ${message}`,
    { cause },
  );
}

function exact(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    configurationError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    configurationError(`${label} shape is invalid`);
  }
  return record;
}

function canonicalLine(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (bytes.byteLength < 3 || bytes.byteLength > MAX_LINE_BYTES + 1) {
    configurationError('record exceeds its line bound');
  }
  return bytes;
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = fs.writeSync(
      descriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
    );
    if (written < 1) configurationError('write stalled');
    offset += written;
  }
}

function signingMessage(
  contentDigest: string,
  contentBytes: number,
  decisionFileDigest: string,
): Buffer {
  return Buffer.from(
    `qinglong3.local-reconciliation-review-authorization.v1\0${contentDigest}\0${contentBytes}\0${decisionFileDigest}`,
    'utf8',
  );
}

function wipe(material: LocalSecretKeyMaterial | null | undefined): void {
  material?.key.fill(0);
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function normalizeHeader(
  value: unknown,
): Readonly<LocalReconciliationReviewAuthorizationHeader> {
  const record = exact(
    value,
    [
      'bundleDigest',
      'bundleFingerprintDigest',
      'expiresAtMs',
      'issuedAtMs',
      'kind',
      'planDigest',
      'preparationDigest',
      'preparedHeadDigest',
      'profile',
      'reviewId',
      'reviewer',
      'schemaVersion',
    ],
    'header',
  );
  if (
    record.schemaVersion !== 1 ||
    record.kind !== HEADER_KIND ||
    (record.profile !== 'edge' && record.profile !== 'standalone') ||
    !Number.isSafeInteger(record.issuedAtMs) ||
    !Number.isSafeInteger(record.expiresAtMs) ||
    (record.expiresAtMs as number) <= (record.issuedAtMs as number) ||
    typeof record.reviewId !== 'string' ||
    [
      record.planDigest,
      record.preparationDigest,
      record.bundleDigest,
      record.bundleFingerprintDigest,
      record.preparedHeadDigest,
    ].some((value) => typeof value !== 'string' || !DIGEST_PATTERN.test(value))
  ) {
    configurationError('header is invalid');
  }
  const principal = normalizeSecurityPrincipal(
    record.reviewer as SecurityPrincipal,
    record.issuedAtMs as number,
  );
  if (
    principal.subject.type !== 'user' ||
    !['hardware', 'local_console', 'multi_factor'].includes(
      principal.assurance,
    ) ||
    (record.issuedAtMs as number) - principal.authenticatedAtMs >
      5 * 60 * 1_000 ||
    principal.authenticatedAtMs > (record.issuedAtMs as number) ||
    (record.expiresAtMs as number) - (record.issuedAtMs as number) >
      30 * 60 * 1_000
  ) {
    configurationError('reviewer authority is invalid');
  }
  return Object.freeze({
    ...(record as unknown as LocalReconciliationReviewAuthorizationHeader),
    reviewer: principal,
  });
}

function authorizationDecision(
  value: unknown,
): Readonly<LocalReconciliationReviewDecision> {
  const record = exact(
    value,
    [
      'database',
      'disposition',
      'domain',
      'factDigest',
      'factKind',
      'kind',
      'ordinal',
      'reason',
      'schemaVersion',
    ],
    'decision',
  );
  if (
    record.schemaVersion !== 1 ||
    record.kind !== DECISION_KIND ||
    (record.database !== 'legacy' && record.database !== 'target') ||
    ![
      'schema_lineage',
      'automation',
      'secret_and_config',
      'run_history',
      'plugin_package',
      'ai_and_tool',
      'identity_policy_audit',
      'unknown',
    ].includes(record.domain as string) ||
    (record.factKind !== 'schema_object' && record.factKind !== 'table') ||
    !Number.isSafeInteger(record.ordinal) ||
    (record.ordinal as number) < 1 ||
    typeof record.factDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.factDigest) ||
    !DISPOSITIONS.includes(
      record.disposition as LocalReconciliationReviewDisposition,
    ) ||
    !REASONS.includes(record.reason as LocalReconciliationReviewReason)
  ) {
    configurationError('decision record is invalid');
  }
  const reasonByDisposition: Record<
    LocalReconciliationReviewDisposition,
    LocalReconciliationReviewReason
  > = {
    retain_target: 'preserve_target',
    adopt_legacy: 'prefer_legacy',
    retain_both: 'preserve_both',
    exclude_legacy: 'legacy_excluded',
    defer: 'deferred_review',
    manual_external: 'external_recovery_required',
  };
  if (
    reasonByDisposition[
      record.disposition as LocalReconciliationReviewDisposition
    ] !== record.reason
  ) {
    configurationError('decision reason does not match disposition');
  }
  return Object.freeze({
    ...(record as unknown as LocalReconciliationReviewDecision),
    kind: 'qinglong3-local-reconciliation-review-decision',
  });
}

function normalizeCounts<T extends string>(
  value: unknown,
  keys: readonly T[],
  label: string,
): Readonly<Record<T, number>> {
  const record = exact(value, keys, label);
  if (
    keys.some(
      (key) =>
        !Number.isSafeInteger(record[key]) || (record[key] as number) < 0,
    )
  ) {
    configurationError(`${label} is invalid`);
  }
  return Object.freeze(record) as Readonly<Record<T, number>>;
}

function parseSignature(value: unknown): Readonly<SignatureRecord> {
  const record = exact(
    value,
    [
      'algorithm',
      'authenticationTag',
      'contentBytes',
      'contentDigest',
      'decisionCount',
      'decisionFileDigest',
      'decisionSetDigest',
      'dispositionCounts',
      'keyId',
      'kind',
      'reasonCounts',
      'schemaVersion',
    ],
    'signature',
  );
  let tag: Buffer | undefined;
  try {
    tag =
      typeof record.authenticationTag === 'string'
        ? Buffer.from(record.authenticationTag, 'base64url')
        : Buffer.alloc(0);
    if (
      record.schemaVersion !== 1 ||
      record.kind !== SIGNATURE_KIND ||
      record.algorithm !== 'hmac-sha256' ||
      typeof record.keyId !== 'string' ||
      !Number.isSafeInteger(record.contentBytes) ||
      (record.contentBytes as number) < 1 ||
      typeof record.contentDigest !== 'string' ||
      !DIGEST_PATTERN.test(record.contentDigest) ||
      !Number.isSafeInteger(record.decisionCount) ||
      (record.decisionCount as number) < 0 ||
      typeof record.decisionSetDigest !== 'string' ||
      !DIGEST_PATTERN.test(record.decisionSetDigest) ||
      typeof record.decisionFileDigest !== 'string' ||
      !DIGEST_PATTERN.test(record.decisionFileDigest) ||
      tag.byteLength !== 32 ||
      tag.toString('base64url') !== record.authenticationTag
    ) {
      configurationError('signature record is invalid');
    }
    return Object.freeze({
      ...(record as unknown as SignatureRecord),
      dispositionCounts: normalizeCounts(
        record.dispositionCounts,
        DISPOSITIONS,
        'disposition counts',
      ),
      reasonCounts: normalizeCounts(
        record.reasonCounts,
        REASONS,
        'reason counts',
      ),
    });
  } finally {
    tag?.fill(0);
  }
}

export async function publishLocalReconciliationReviewAuthorization(
  options: Readonly<{
    targetPath: string;
    stagePath: string;
    maxBytes: number;
    header: Readonly<LocalReconciliationReviewAuthorizationHeader>;
    keyProvider: LocalReconciliationReviewIssuerKeyringFileProvider;
    writeDecisions: (
      append: (decision: Readonly<LocalReconciliationReviewDecision>) => void,
    ) => Readonly<{
      readonly decisionFileDigest: string;
      readonly confirmDecisionFileAuthority: () => void;
    }>;
    confirmAuthority: () => void | Promise<void>;
  }>,
): Promise<Readonly<LocalReconciliationReviewAuthorizationEvidence>> {
  await options.confirmAuthority();
  const keyringBefore = options.keyProvider.inspect();
  let material: LocalSecretKeyMaterial | undefined;
  let descriptor: number | undefined;
  let created = false;
  try {
    material = await options.keyProvider.active();
    if (
      material.keyId !== keyringBefore.activeKeyId ||
      material.key.byteLength !== 32
    ) {
      configurationError('active issuer key drifted');
    }
    descriptor = fs.openSync(
      options.stagePath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    fs.fchmodSync(descriptor, 0o600);
    const fileHash = createHash('sha256');
    const contentHash = createHash('sha256');
    const decisionHash = createHash('sha256').update(
      'qinglong3.local-reconciliation-review-decision-set.v1\0',
    );
    let fileBytes = 0;
    let contentBytes = 0;
    let decisionCount = 0;
    const dispositionCounts = zeroCounts(DISPOSITIONS);
    const reasonCounts = zeroCounts(REASONS);
    const domainDecisionCounts = zeroDomainDecisionCounts();
    const writeContent = (value: unknown, isDecision: boolean): void => {
      const line = canonicalLine(value);
      try {
        if (fileBytes + line.byteLength > options.maxBytes) {
          configurationError('exceeds profile byte budget');
        }
        writeAll(descriptor!, line);
        fileHash.update(line);
        contentHash.update(line);
        contentBytes += line.byteLength;
        fileBytes += line.byteLength;
        if (isDecision) decisionHash.update(line);
      } finally {
        line.fill(0);
      }
    };
    writeContent(options.header, false);
    const decisionFile = options.writeDecisions((selected) => {
      const record = Object.freeze({ ...selected, kind: DECISION_KIND });
      writeContent(record, true);
      decisionCount += 1;
      dispositionCounts[selected.disposition] += 1;
      reasonCounts[selected.reason] += 1;
      const domain = domainDecisionCounts.find(
        (candidate) => candidate.domain === selected.domain,
      );
      if (!domain) configurationError('decision domain is unavailable');
      domain[selected.database][selected.disposition] += 1;
    });
    if (!DIGEST_PATTERN.test(decisionFile.decisionFileDigest)) {
      configurationError('decision file evidence is invalid');
    }
    await options.confirmAuthority();
    decisionFile.confirmDecisionFileAuthority();
    const keyringAfter = options.keyProvider.inspect();
    if (
      keyringAfter.keyringDigest !== keyringBefore.keyringDigest ||
      keyringAfter.activeKeyId !== material.keyId
    ) {
      configurationError('issuer authority changed while signing');
    }
    const contentDigest = contentHash.digest('hex');
    const decisionSetDigest = decisionHash.digest('hex');
    const message = signingMessage(
      contentDigest,
      contentBytes,
      decisionFile.decisionFileDigest,
    );
    const authenticationTag = createHmac('sha256', material.key)
      .update(message)
      .digest('base64url');
    message.fill(0);
    await options.confirmAuthority();
    decisionFile.confirmDecisionFileAuthority();
    const keyringSigned = options.keyProvider.inspect();
    if (
      keyringSigned.keyringDigest !== keyringBefore.keyringDigest ||
      keyringSigned.activeKeyId !== material.keyId
    ) {
      configurationError('issuer authority changed after signing');
    }
    const signature: SignatureRecord = Object.freeze({
      schemaVersion: 1,
      kind: SIGNATURE_KIND,
      algorithm: 'hmac-sha256',
      keyId: material.keyId,
      contentBytes,
      contentDigest,
      decisionCount,
      decisionFileDigest: decisionFile.decisionFileDigest,
      decisionSetDigest,
      dispositionCounts: Object.freeze(dispositionCounts),
      reasonCounts: Object.freeze(reasonCounts),
      authenticationTag,
    });
    const signatureLine = canonicalLine(signature);
    try {
      if (fileBytes + signatureLine.byteLength > options.maxBytes) {
        configurationError('exceeds profile byte budget');
      }
      writeAll(descriptor, signatureLine);
      fileHash.update(signatureLine);
      fileBytes += signatureLine.byteLength;
    } finally {
      signatureLine.fill(0);
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(options.stagePath, options.targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      configurationError('target already exists');
    }
    syncDirectory(path.dirname(options.targetPath));
    fs.unlinkSync(options.stagePath);
    created = false;
    syncDirectory(path.dirname(options.stagePath));
    return Object.freeze({
      fileBytes,
      authorizationDigest: fileHash.digest('hex'),
      decisionCount,
      decisionFileDigest: decisionFile.decisionFileDigest,
      decisionSetDigest,
      keyId: material.keyId,
      dispositionCounts: Object.freeze(dispositionCounts),
      reasonCounts: Object.freeze(reasonCounts),
      domainDecisionCounts: freezeDomainDecisionCounts(domainDecisionCounts),
      header: options.header,
    });
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('cannot be published', error);
  } finally {
    wipe(material);
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created) {
      try {
        fs.unlinkSync(options.stagePath);
      } catch {
        // A complete signed stage may be recovered; partial stages fail closed.
      }
    }
  }
}

function parseLine(line: Buffer): unknown {
  if (line.byteLength < 2 || line.byteLength > MAX_LINE_BYTES) {
    configurationError('line bound is invalid');
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
  } catch (error) {
    configurationError('line is not valid UTF-8 JSON', error);
  }
}

export async function verifyLocalReconciliationReviewAuthorization(
  filePath: string,
  options: Readonly<{
    maxBytes: number;
    allowedModes: readonly number[];
    keyProvider: LocalReconciliationReviewIssuerKeyringFileProvider;
    expected: Readonly<{
      reviewId: string;
      profile: 'edge' | 'standalone';
      planDigest: string;
      preparationDigest: string;
      bundleDigest: string;
      bundleFingerprintDigest: string;
      preparedHeadDigest: string;
    }>;
  }>,
): Promise<Readonly<LocalReconciliationReviewAuthorizationEvidence>> {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid !== process.geteuid?.()) {
    configurationError('requires stable POSIX identity');
  }
  const before = fs.lstatSync(filePath, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    Number(before.uid) !== uid ||
    !options.allowedModes.includes(Number(before.mode) & 0o777) ||
    before.nlink !== 1n ||
    before.size < 2n ||
    before.size > BigInt(options.maxBytes)
  ) {
    configurationError('file identity or size is invalid');
  }
  let descriptor: number | undefined;
  let material: LocalSecretKeyMaterial | null = null;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      configurationError('file changed while opening');
    }
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const fileHash = createHash('sha256');
    const contentHash = createHash('sha256');
    const decisionHash = createHash('sha256').update(
      'qinglong3.local-reconciliation-review-decision-set.v1\0',
    );
    let offset = 0;
    let length = 0;
    let fileBytes = 0;
    let contentBytes = 0;
    const lineBuffer = Buffer.allocUnsafe(MAX_LINE_BYTES);
    let lineLength = 0;
    const nextLine = (): Buffer | null => {
      while (true) {
        if (offset >= length) {
          length = fs.readSync(descriptor!, chunk, 0, chunk.byteLength, null);
          offset = 0;
          if (length === 0) {
            if (lineLength !== 0) configurationError('must end with newline');
            return null;
          }
          fileBytes += length;
          fileHash.update(chunk.subarray(0, length));
        }
        const byte = chunk[offset++]!;
        if (byte === 0x0a) {
          const line = Buffer.from(lineBuffer.subarray(0, lineLength));
          lineLength = 0;
          return line;
        }
        if (lineLength >= MAX_LINE_BYTES)
          configurationError('line is too large');
        lineBuffer[lineLength] = byte;
        lineLength += 1;
      }
    };
    const updateContent = (
      line: Buffer,
      includeInDecisionSet: boolean,
    ): void => {
      contentHash.update(line).update('\n');
      contentBytes += line.byteLength + 1;
      if (includeInDecisionSet) decisionHash.update(line).update('\n');
    };
    const first = nextLine();
    if (first === null) configurationError('header is absent');
    const normalizedHeader = normalizeHeader(parseLine(first));
    updateContent(first, false);
    for (const [key, expected] of Object.entries(options.expected)) {
      if (
        normalizedHeader[
          key as keyof LocalReconciliationReviewAuthorizationHeader
        ] !== expected
      ) {
        configurationError('header binding drifted');
      }
    }
    const dispositionCounts = zeroCounts(DISPOSITIONS);
    const reasonCounts = zeroCounts(REASONS);
    const domainDecisionCounts = zeroDomainDecisionCounts();
    let decisionCount = 0;
    let pending = nextLine();
    if (pending === null) configurationError('signature is absent');
    while (true) {
      const following = nextLine();
      if (following === null) break;
      const selected = authorizationDecision(parseLine(pending));
      updateContent(pending, true);
      decisionCount += 1;
      dispositionCounts[selected.disposition] += 1;
      reasonCounts[selected.reason] += 1;
      const domain = domainDecisionCounts.find(
        (candidate) => candidate.domain === selected.domain,
      );
      if (!domain) configurationError('decision domain is unavailable');
      domain[selected.database][selected.disposition] += 1;
      pending.fill(0);
      pending = following;
    }
    const signature = parseSignature(parseLine(pending));
    pending.fill(0);
    const contentDigest = contentHash.digest('hex');
    const decisionSetDigest = decisionHash.digest('hex');
    if (
      signature.contentBytes !== contentBytes ||
      signature.contentDigest !== contentDigest ||
      signature.decisionCount !== decisionCount ||
      signature.decisionSetDigest !== decisionSetDigest ||
      JSON.stringify(signature.dispositionCounts) !==
        JSON.stringify(dispositionCounts) ||
      JSON.stringify(signature.reasonCounts) !== JSON.stringify(reasonCounts)
    ) {
      configurationError('signed summary drifted');
    }
    material = await options.keyProvider.resolve(signature.keyId);
    if (!material || material.key.byteLength !== 32)
      configurationError('issuer key is unavailable');
    const message = signingMessage(
      contentDigest,
      contentBytes,
      signature.decisionFileDigest,
    );
    const expectedTag = createHmac('sha256', material.key)
      .update(message)
      .digest();
    message.fill(0);
    const actualTag = Buffer.from(signature.authenticationTag, 'base64url');
    const valid = timingSafeEqual(expectedTag, actualTag);
    expectedTag.fill(0);
    actualTag.fill(0);
    if (!valid) configurationError('signature is invalid');
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(filePath, { bigint: true });
    if (
      fileBytes !== Number(before.size) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino ||
      pathAfter.size !== before.size ||
      pathAfter.mtimeNs !== before.mtimeNs ||
      pathAfter.ctimeNs !== before.ctimeNs ||
      pathAfter.mode !== before.mode ||
      pathAfter.nlink !== before.nlink
    ) {
      configurationError('file changed while reading');
    }
    return Object.freeze({
      fileBytes,
      authorizationDigest: fileHash.digest('hex'),
      decisionCount,
      decisionFileDigest: signature.decisionFileDigest,
      decisionSetDigest,
      keyId: signature.keyId,
      dispositionCounts: Object.freeze(dispositionCounts),
      reasonCounts: Object.freeze(reasonCounts),
      domainDecisionCounts: freezeDomainDecisionCounts(domainDecisionCounts),
      header: normalizedHeader,
    });
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('cannot be verified', error);
  } finally {
    wipe(material);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
