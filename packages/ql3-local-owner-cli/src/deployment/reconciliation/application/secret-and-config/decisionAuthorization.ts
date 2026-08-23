import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { LocalSecretKeyMaterial } from '@qinglong/runtime-core/local-secret';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';

import { LocalDeploymentConfigurationError } from '../../../foundation/error';
import { LocalReconciliationReviewIssuerKeyringFileProvider } from '../../review/issuerKeyring';
import {
  LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_DISPOSITIONS,
  normalizeLocalReconciliationSecretConfigDecision,
  type LocalReconciliationSecretConfigDecision,
  type LocalReconciliationSecretConfigDecisionDisposition,
} from './decisionFile';

const HEADER_KIND =
  'qinglong3-local-reconciliation-secret-config-authorization-header';
const SIGNATURE_KIND =
  'qinglong3-local-reconciliation-secret-config-authorization-signature';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_AUTHENTICATION_AGE_MS = 5 * 60 * 1_000;
const MAX_AUTHORIZATION_LIFETIME_MS = 30 * 60 * 1_000;

export interface LocalReconciliationSecretConfigAuthorizationHeader {
  readonly schemaVersion: 1;
  readonly kind: typeof HEADER_KIND;
  readonly decisionId: string;
  readonly secretConfigId: string;
  readonly profile: 'edge' | 'standalone';
  readonly secretConfigPlanDigest: string;
  readonly candidateSetDigest: string;
  readonly applicationPlanDigest: string;
  readonly preparationDigest: string;
  readonly preparedHeadDigest: string;
  readonly bundleDigest: string;
  readonly bundleFingerprintDigest: string;
  readonly reviewer: Readonly<SecurityPrincipal>;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface LocalReconciliationSecretConfigDecisionCounts {
  readonly apply_active_binding: number;
  readonly preserve_disabled: number;
  readonly skip: number;
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
  readonly dispositionCounts: Readonly<LocalReconciliationSecretConfigDecisionCounts>;
  readonly authenticationTag: string;
}

export interface LocalReconciliationSecretConfigAuthorizationEvidence {
  readonly fileBytes: number;
  readonly authorizationDigest: string;
  readonly decisionCount: number;
  readonly decisionSetDigest: string;
  readonly decisionFileDigest: string;
  readonly keyId: string;
  readonly dispositionCounts: Readonly<LocalReconciliationSecretConfigDecisionCounts>;
  readonly header: Readonly<LocalReconciliationSecretConfigAuthorizationHeader>;
}

export interface LocalReconciliationSecretConfigAuthorizationScope {
  readonly evidence: Readonly<LocalReconciliationSecretConfigAuthorizationEvidence>;
  readonly decisions: readonly Readonly<LocalReconciliationSecretConfigDecision>[];
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(
    `reconciliation secret config authorization ${message}`,
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
    bytes.fill(0);
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

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function signingMessage(
  contentDigest: string,
  contentBytes: number,
  decisionFileDigest: string,
): Buffer {
  return Buffer.from(
    `qinglong3.local-reconciliation-secret-config-authorization.v1\0${contentDigest}\0${contentBytes}\0${decisionFileDigest}`,
    'utf8',
  );
}

function wipe(material: LocalSecretKeyMaterial | null | undefined): void {
  material?.key.fill(0);
}

function zeroCounts(): Record<
  LocalReconciliationSecretConfigDecisionDisposition,
  number
> {
  return {
    apply_active_binding: 0,
    preserve_disabled: 0,
    skip: 0,
  };
}

function normalizeCounts(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigDecisionCounts> {
  const counts = exact(
    value,
    [...LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_DISPOSITIONS],
    'disposition counts',
  );
  if (
    LOCAL_RECONCILIATION_SECRET_CONFIG_DECISION_DISPOSITIONS.some(
      (key) =>
        !Number.isSafeInteger(counts[key]) || (counts[key] as number) < 0,
    )
  ) {
    configurationError('disposition counts are invalid');
  }
  return Object.freeze({
    apply_active_binding: counts.apply_active_binding as number,
    preserve_disabled: counts.preserve_disabled as number,
    skip: counts.skip as number,
  });
}

function normalizeHeader(
  value: unknown,
): Readonly<LocalReconciliationSecretConfigAuthorizationHeader> {
  const record = exact(
    value,
    [
      'applicationPlanDigest',
      'bundleDigest',
      'bundleFingerprintDigest',
      'candidateSetDigest',
      'decisionId',
      'expiresAtMs',
      'issuedAtMs',
      'kind',
      'preparationDigest',
      'preparedHeadDigest',
      'profile',
      'reviewer',
      'schemaVersion',
      'secretConfigId',
      'secretConfigPlanDigest',
    ],
    'header',
  );
  const issuedAtMs = record.issuedAtMs;
  const expiresAtMs = record.expiresAtMs;
  if (
    !Number.isSafeInteger(issuedAtMs) ||
    (issuedAtMs as number) < 0 ||
    !Number.isSafeInteger(expiresAtMs) ||
    (expiresAtMs as number) <= (issuedAtMs as number) ||
    (expiresAtMs as number) - (issuedAtMs as number) >
      MAX_AUTHORIZATION_LIFETIME_MS
  ) {
    configurationError('authorization lifetime is invalid');
  }
  let reviewer: Readonly<SecurityPrincipal>;
  try {
    reviewer = normalizeSecurityPrincipal(
      record.reviewer as SecurityPrincipal,
      issuedAtMs as number,
    );
  } catch (error) {
    return configurationError('reviewer is invalid', error);
  }
  if (
    record.schemaVersion !== 1 ||
    record.kind !== HEADER_KIND ||
    typeof record.decisionId !== 'string' ||
    !UUID_V7_PATTERN.test(record.decisionId) ||
    typeof record.secretConfigId !== 'string' ||
    !UUID_V4_PATTERN.test(record.secretConfigId) ||
    (record.profile !== 'edge' && record.profile !== 'standalone') ||
    ![
      record.secretConfigPlanDigest,
      record.candidateSetDigest,
      record.applicationPlanDigest,
      record.preparationDigest,
      record.preparedHeadDigest,
      record.bundleDigest,
      record.bundleFingerprintDigest,
    ].every(
      (selected) =>
        typeof selected === 'string' && DIGEST_PATTERN.test(selected),
    ) ||
    reviewer.subject.type !== 'user' ||
    !['hardware', 'local_console', 'multi_factor'].includes(
      reviewer.assurance,
    ) ||
    reviewer.authenticatedAtMs > (issuedAtMs as number) ||
    (issuedAtMs as number) - reviewer.authenticatedAtMs >
      MAX_AUTHENTICATION_AGE_MS ||
    reviewer.expiresAtMs < (expiresAtMs as number)
  ) {
    configurationError('header binding is invalid');
  }
  return Object.freeze({
    ...(record as unknown as LocalReconciliationSecretConfigAuthorizationHeader),
    reviewer,
  });
}

function normalizeSignature(value: unknown): Readonly<SignatureRecord> {
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
      record.keyId.length < 1 ||
      !Number.isSafeInteger(record.contentBytes) ||
      (record.contentBytes as number) < 1 ||
      typeof record.contentDigest !== 'string' ||
      !DIGEST_PATTERN.test(record.contentDigest) ||
      !Number.isSafeInteger(record.decisionCount) ||
      (record.decisionCount as number) < 1 ||
      typeof record.decisionSetDigest !== 'string' ||
      !DIGEST_PATTERN.test(record.decisionSetDigest) ||
      typeof record.decisionFileDigest !== 'string' ||
      !DIGEST_PATTERN.test(record.decisionFileDigest) ||
      typeof record.authenticationTag !== 'string' ||
      tag.byteLength !== 32 ||
      tag.toString('base64url') !== record.authenticationTag
    ) {
      configurationError('signature record is invalid');
    }
    return Object.freeze({
      ...(record as unknown as SignatureRecord),
      dispositionCounts: normalizeCounts(record.dispositionCounts),
    });
  } finally {
    tag?.fill(0);
  }
}

export function buildLocalReconciliationSecretConfigAuthorizationHeader(
  value: Omit<
    LocalReconciliationSecretConfigAuthorizationHeader,
    'schemaVersion' | 'kind'
  >,
): Readonly<LocalReconciliationSecretConfigAuthorizationHeader> {
  return normalizeHeader({
    schemaVersion: 1,
    kind: HEADER_KIND,
    ...value,
  });
}

export async function publishLocalReconciliationSecretConfigAuthorization(
  options: Readonly<{
    targetPath: string;
    stagePath: string;
    maxBytes: number;
    header: Readonly<LocalReconciliationSecretConfigAuthorizationHeader>;
    keyProvider: LocalReconciliationReviewIssuerKeyringFileProvider;
    writeDecisions: (
      append: (
        decision: Readonly<LocalReconciliationSecretConfigDecision>,
      ) => void,
    ) => Readonly<{
      decisionFileDigest: string;
      confirmDecisionFileAuthority(): void;
    }>;
    confirmAuthority(): void | Promise<void>;
  }>,
): Promise<Readonly<LocalReconciliationSecretConfigAuthorizationEvidence>> {
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
      'qinglong3.local-reconciliation-secret-config-decision-set.v1\0',
    );
    let fileBytes = 0;
    let contentBytes = 0;
    let decisionCount = 0;
    const dispositionCounts = zeroCounts();
    const writeContent = (value: unknown, selectedDecision: boolean): void => {
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
        if (selectedDecision) decisionHash.update(line);
      } finally {
        line.fill(0);
      }
    };
    writeContent(options.header, false);
    const decisionFile = options.writeDecisions((value) => {
      const selected = normalizeLocalReconciliationSecretConfigDecision(value);
      writeContent(selected, true);
      decisionCount += 1;
      dispositionCounts[selected.disposition] += 1;
    });
    if (
      decisionCount < 1 ||
      !DIGEST_PATTERN.test(decisionFile.decisionFileDigest)
    ) {
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
    const signature: Readonly<SignatureRecord> = Object.freeze({
      schemaVersion: 1,
      kind: SIGNATURE_KIND,
      algorithm: 'hmac-sha256',
      keyId: material.keyId,
      contentBytes,
      contentDigest,
      decisionCount,
      decisionSetDigest,
      decisionFileDigest: decisionFile.decisionFileDigest,
      dispositionCounts: Object.freeze({ ...dispositionCounts }),
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
    await options.confirmAuthority();
    decisionFile.confirmDecisionFileAuthority();
    const keyringSigned = options.keyProvider.inspect();
    if (
      keyringSigned.keyringDigest !== keyringBefore.keyringDigest ||
      keyringSigned.activeKeyId !== material.keyId
    ) {
      configurationError('issuer authority changed after signing');
    }
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
      decisionSetDigest,
      decisionFileDigest: decisionFile.decisionFileDigest,
      keyId: material.keyId,
      dispositionCounts: Object.freeze({ ...dispositionCounts }),
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
        // A complete owner-only stage is recoverable; partial stages fail closed.
      }
    }
  }
}

export async function verifyLocalReconciliationSecretConfigAuthorization(
  filePath: string,
  options: Readonly<{
    maxBytes: number;
    allowedModes: readonly number[];
    keyProvider: LocalReconciliationReviewIssuerKeyringFileProvider;
    expected: Readonly<{
      decisionId: string;
      secretConfigId: string;
      profile: 'edge' | 'standalone';
      secretConfigPlanDigest: string;
      candidateSetDigest: string;
      applicationPlanDigest: string;
      preparationDigest: string;
      preparedHeadDigest: string;
      bundleDigest: string;
      bundleFingerprintDigest: string;
      decisionFileDigest: string;
    }>;
  }>,
): Promise<Readonly<LocalReconciliationSecretConfigAuthorizationScope>> {
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
  let bytes: Buffer | undefined;
  let material: LocalSecretKeyMaterial | null | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs
    ) {
      configurationError('file changed while opening');
    }
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    ) {
      configurationError('file changed while reading');
    }
    const linked = fs.lstatSync(filePath, { bigint: true });
    if (
      linked.dev !== opened.dev ||
      linked.ino !== opened.ino ||
      linked.size !== opened.size ||
      linked.mtimeNs !== opened.mtimeNs ||
      linked.ctimeNs !== opened.ctimeNs
    ) {
      configurationError('file path changed while reading');
    }
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      return configurationError('file is not UTF-8', error);
    }
    const framed = decoded.split('\n');
    if (framed.at(-1) !== '') configurationError('must end with newline');
    framed.pop();
    if (framed.length < 3) configurationError('file is incomplete');
    const parsed = framed.map((line, index) => {
      if (
        Buffer.byteLength(line, 'utf8') < 2 ||
        Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES
      ) {
        configurationError(`record ${index + 1} exceeds its line bound`);
      }
      try {
        return JSON.parse(line) as unknown;
      } catch (error) {
        return configurationError(`record ${index + 1} is not JSON`, error);
      }
    });
    const selectedHeader = normalizeHeader(parsed[0]);
    const signature = normalizeSignature(parsed.at(-1));
    const decisions = Object.freeze(
      parsed
        .slice(1, -1)
        .map((value) =>
          normalizeLocalReconciliationSecretConfigDecision(value),
        ),
    );
    const expected = options.expected;
    if (
      selectedHeader.decisionId !== expected.decisionId ||
      selectedHeader.secretConfigId !== expected.secretConfigId ||
      selectedHeader.profile !== expected.profile ||
      selectedHeader.secretConfigPlanDigest !==
        expected.secretConfigPlanDigest ||
      selectedHeader.candidateSetDigest !== expected.candidateSetDigest ||
      selectedHeader.applicationPlanDigest !== expected.applicationPlanDigest ||
      selectedHeader.preparationDigest !== expected.preparationDigest ||
      selectedHeader.preparedHeadDigest !== expected.preparedHeadDigest ||
      selectedHeader.bundleDigest !== expected.bundleDigest ||
      selectedHeader.bundleFingerprintDigest !==
        expected.bundleFingerprintDigest ||
      signature.decisionFileDigest !== expected.decisionFileDigest ||
      signature.decisionCount !== decisions.length
    ) {
      configurationError('authorization binding drifted');
    }
    const contentLines = framed.slice(0, -1).map((line) => `${line}\n`);
    const content = Buffer.from(contentLines.join(''), 'utf8');
    const decisionBytes = Buffer.from(
      framed
        .slice(1, -1)
        .map((line) => `${line}\n`)
        .join(''),
      'utf8',
    );
    try {
      const counts = zeroCounts();
      for (const selected of decisions) counts[selected.disposition] += 1;
      if (
        signature.contentBytes !== content.byteLength ||
        signature.contentDigest !==
          createHash('sha256').update(content).digest('hex') ||
        signature.decisionSetDigest !==
          createHash('sha256')
            .update(
              'qinglong3.local-reconciliation-secret-config-decision-set.v1\0',
            )
            .update(decisionBytes)
            .digest('hex') ||
        JSON.stringify(signature.dispositionCounts) !== JSON.stringify(counts)
      ) {
        configurationError('authorization summary drifted');
      }
      material = await options.keyProvider.resolve(signature.keyId);
      if (!material || material.key.byteLength !== 32) {
        configurationError('issuer key is unavailable');
      }
      const message = signingMessage(
        signature.contentDigest,
        signature.contentBytes,
        signature.decisionFileDigest,
      );
      const expectedTag = createHmac('sha256', material.key)
        .update(message)
        .digest();
      const suppliedTag = Buffer.from(signature.authenticationTag, 'base64url');
      message.fill(0);
      try {
        if (
          suppliedTag.byteLength !== expectedTag.byteLength ||
          !timingSafeEqual(suppliedTag, expectedTag)
        ) {
          configurationError('authentication tag is invalid');
        }
      } finally {
        expectedTag.fill(0);
        suppliedTag.fill(0);
      }
      return Object.freeze({
        evidence: Object.freeze({
          fileBytes: bytes.byteLength,
          authorizationDigest: createHash('sha256').update(bytes).digest('hex'),
          decisionCount: decisions.length,
          decisionSetDigest: signature.decisionSetDigest,
          decisionFileDigest: signature.decisionFileDigest,
          keyId: signature.keyId,
          dispositionCounts: signature.dispositionCounts,
          header: selectedHeader,
        }),
        decisions,
      });
    } finally {
      content.fill(0);
      decisionBytes.fill(0);
    }
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('cannot be verified', error);
  } finally {
    wipe(material);
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
