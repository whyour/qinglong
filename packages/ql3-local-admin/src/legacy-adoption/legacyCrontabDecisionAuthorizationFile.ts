// Legacy Adoption owns the private authenticated decision authorization-file boundary.
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import fs, { constants } from 'node:fs';
import path from 'node:path';
import {
  assertLocalSecretKeyId,
  type LocalSecretKeyMaterial,
  type LocalSecretKeyProvider,
} from '@qinglong/runtime-core/local-secret';
import { MAX_LEGACY_CRONTAB_ROWS } from './legacyCrontabAdoption';
import {
  parseLegacyCrontabAdoptionDecision,
  type LegacyCrontabAdoptionDecision,
  type LegacyCrontabAdoptionDecisionReceipt,
} from './legacyCrontabDecisionReceipt';

export const MAX_LEGACY_CRONTAB_DECISION_AUTHORIZATION_FILE_BYTES =
  32 * 1024 * 1024;

const MAX_PATH_BYTES = 4096;
const MAX_LINE_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface AuthorizationFileHeader {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-legacy-crontab-decision-file-header';
  readonly decisionId: string;
  readonly profile: 'edge' | 'standalone';
  readonly planDigest: string;
  readonly inventoryDigest: string;
}

interface AuthorizationFileAuthentication {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-legacy-crontab-decision-file-authentication';
  readonly algorithm: 'hmac-sha256';
  readonly keyId: string;
  readonly contentBytes: number;
  readonly contentDigest: string;
  readonly authenticationTag: string;
}

export interface LegacyCrontabDecisionAuthorizationFileEvidence {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-legacy-crontab-decision-authorization-file';
  readonly decisionId: string;
  readonly decisionCount: number;
  readonly fileBytes: number;
  readonly fileDigest: string;
  readonly contentBytes: number;
  readonly contentDigest: string;
  readonly algorithm: 'hmac-sha256';
  readonly keyId: string;
  readonly authenticationTag: string;
}

export interface LegacyCrontabDecisionAuthorizationFileResult {
  readonly receipt: LegacyCrontabAdoptionDecisionReceipt;
  readonly file: LegacyCrontabDecisionAuthorizationFileEvidence;
}

export interface PublishLegacyCrontabDecisionAuthorizationFileOptions {
  readonly filePath: string;
  readonly decisionId: string;
  readonly profile: 'edge' | 'standalone';
  readonly planDigest: string;
  readonly inventoryDigest: string;
  readonly decisions: Iterable<LegacyCrontabAdoptionDecision>;
  readonly keyProvider: LocalSecretKeyProvider;
  readonly createReceipt: (
    decisions: Iterable<LegacyCrontabAdoptionDecision>,
  ) => LegacyCrontabAdoptionDecisionReceipt;
  readonly confirmExternalAuthority?: () => void | Promise<void>;
}

export interface VerifyLegacyCrontabDecisionAuthorizationFileOptions {
  readonly filePath: string;
  readonly expectedDecisionId: string;
  readonly expectedProfile: 'edge' | 'standalone';
  readonly expectedPlanDigest: string;
  readonly expectedInventoryDigest: string;
  readonly keyProvider: LocalSecretKeyProvider;
  readonly verifyReceipt: (
    receipt: unknown,
    decisions: Iterable<LegacyCrontabAdoptionDecision>,
  ) => LegacyCrontabAdoptionDecisionReceipt;
}

export interface VerifiedLegacyCrontabDecisionAuthorizationFileScope {
  readonly result: LegacyCrontabDecisionAuthorizationFileResult;
  readonly decisions: Iterable<LegacyCrontabAdoptionDecision>;
  readonly confirmIdentity: () => void;
}

export class LegacyCrontabDecisionAuthorizationFileError extends Error {
  readonly code = 'LEGACY_CRONTAB_DECISION_AUTHORIZATION_FILE_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Legacy Crontab decision authorization file is invalid: ${message}`);
    this.name = 'LegacyCrontabDecisionAuthorizationFileError';
  }
}

export class LegacyCrontabDecisionAuthorizationFileAlreadyExistsError extends Error {
  readonly code = 'LEGACY_CRONTAB_DECISION_AUTHORIZATION_FILE_EXISTS';

  constructor() {
    super('Legacy Crontab decision authorization file already exists');
    this.name = 'LegacyCrontabDecisionAuthorizationFileAlreadyExistsError';
  }
}

interface FileLine {
  readonly start: number;
  readonly end: number;
  readonly value: Buffer;
  readonly framed: Buffer;
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === code
  );
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      `${label} must be an object`,
    );
  }
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      `${label} shape is invalid`,
    );
  }
}

function assertHeaderIdentity(value: {
  readonly decisionId: unknown;
  readonly profile: unknown;
  readonly planDigest: unknown;
  readonly inventoryDigest: unknown;
}): void {
  if (
    typeof value.decisionId !== 'string' ||
    !UUID_V7_PATTERN.test(value.decisionId) ||
    (value.profile !== 'edge' && value.profile !== 'standalone') ||
    typeof value.planDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.planDigest) ||
    typeof value.inventoryDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.inventoryDigest)
  ) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'header identity is invalid',
    );
  }
}

function authorizationPath(value: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    value.includes('\0') ||
    path.normalize(value) !== value ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'path must be normalized, bounded, absolute and non-root',
    );
  }
  return value;
}

function currentUid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function'
  ) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'POSIX user identity is unavailable',
    );
  }
  const uid = process.getuid();
  const effectiveUid = process.geteuid();
  if (
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    !Number.isSafeInteger(effectiveUid) ||
    effectiveUid < 0 ||
    uid !== effectiveUid
  ) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'real and effective POSIX users must match',
    );
  }
  return uid;
}

function assertPrivateParent(filePath: string, uid: number): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(path.dirname(filePath));
  } catch (error) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'private parent directory is unavailable',
      error,
    );
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'parent must be an owner-only real directory',
    );
  }
}

function parseJsonLine(line: Buffer, label: string): unknown {
  if (line.length < 2 || line.length > MAX_LINE_BYTES) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      `${label} exceeds its line bound`,
    );
  }
  try {
    return JSON.parse(line.toString('utf8')) as unknown;
  } catch (error) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      `${label} is not valid JSON`,
      error,
    );
  }
}

function canonicalLine(value: unknown): Buffer {
  const line = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (line.length > MAX_LINE_BYTES + 1) {
    line.fill(0);
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'authorization record exceeds its line bound',
    );
  }
  return line;
}

function writeAll(descriptor: number, value: Buffer): void {
  let offset = 0;
  while (offset < value.length) {
    const written = fs.writeSync(
      descriptor,
      value,
      offset,
      value.length - offset,
    );
    if (written < 1) {
      throw new LegacyCrontabDecisionAuthorizationFileError(
        'authorization record could not be written',
      );
    }
    offset += written;
  }
}

function writeBoundedLine(
  descriptor: number,
  value: unknown,
  fileHash: ReturnType<typeof createHash>,
  contentHash?: ReturnType<typeof createHash>,
  currentBytes = 0,
): number {
  const line = canonicalLine(value);
  try {
    if (
      currentBytes + line.length >
      MAX_LEGACY_CRONTAB_DECISION_AUTHORIZATION_FILE_BYTES
    ) {
      throw new LegacyCrontabDecisionAuthorizationFileError(
        'authorization file exceeds its byte bound',
      );
    }
    writeAll(descriptor, line);
    fileHash.update(line);
    contentHash?.update(line);
    return line.length;
  } finally {
    line.fill(0);
  }
}

function header(value: {
  readonly decisionId: string;
  readonly profile: 'edge' | 'standalone';
  readonly planDigest: string;
  readonly inventoryDigest: string;
}): AuthorizationFileHeader {
  assertHeaderIdentity({
    decisionId: value.decisionId,
    profile: value.profile,
    planDigest: value.planDigest,
    inventoryDigest: value.inventoryDigest,
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: 'qinglong3-legacy-crontab-decision-file-header',
    decisionId: value.decisionId,
    profile: value.profile,
    planDigest: value.planDigest,
    inventoryDigest: value.inventoryDigest,
  });
}

function authenticationMessage(
  contentDigest: string,
  contentBytes: number,
): Buffer {
  return Buffer.from(
    `qinglong3.legacy-crontab-decision-authorization-file.v1\0${contentDigest}\0${contentBytes}`,
    'utf8',
  );
}

function normalizeKeyMaterial(
  value: LocalSecretKeyMaterial,
  expectedKeyId?: string,
): LocalSecretKeyMaterial {
  try {
    assertLocalSecretKeyId(value?.keyId);
  } catch (error) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'authentication key identity is invalid',
      error,
    );
  }
  if (
    (expectedKeyId !== undefined && value.keyId !== expectedKeyId) ||
    !(value.key instanceof Uint8Array) ||
    value.key.byteLength !== 32
  ) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'authentication key material is invalid',
    );
  }
  return value;
}

function wipeKeyMaterial(
  value: LocalSecretKeyMaterial | null | undefined,
): void {
  if (value?.key instanceof Uint8Array) value.key.fill(0);
}

async function authenticateContent(
  keyProvider: LocalSecretKeyProvider,
  contentDigest: string,
  contentBytes: number,
): Promise<AuthorizationFileAuthentication> {
  let material: LocalSecretKeyMaterial | undefined;
  let message: Buffer | undefined;
  try {
    material = normalizeKeyMaterial(await keyProvider.active());
    message = authenticationMessage(contentDigest, contentBytes);
    const authenticationTag = createHmac('sha256', material.key)
      .update(message)
      .digest('base64url');
    return Object.freeze({
      schemaVersion: 1,
      kind: 'qinglong3-legacy-crontab-decision-file-authentication',
      algorithm: 'hmac-sha256',
      keyId: material.keyId,
      contentBytes,
      contentDigest,
      authenticationTag,
    });
  } catch (error) {
    if (error instanceof LegacyCrontabDecisionAuthorizationFileError) {
      throw error;
    }
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'content authentication failed',
      error,
    );
  } finally {
    wipeKeyMaterial(material);
    message?.fill(0);
  }
}

function parseAuthentication(value: unknown): AuthorizationFileAuthentication {
  exactKeys(
    value,
    [
      'algorithm',
      'authenticationTag',
      'contentBytes',
      'contentDigest',
      'keyId',
      'kind',
      'schemaVersion',
    ],
    'authentication record',
  );
  let decoded: Buffer | undefined;
  try {
    assertLocalSecretKeyId(value.keyId);
    decoded =
      typeof value.authenticationTag === 'string'
        ? Buffer.from(value.authenticationTag, 'base64url')
        : Buffer.alloc(0);
    if (
      value.schemaVersion !== 1 ||
      value.kind !== 'qinglong3-legacy-crontab-decision-file-authentication' ||
      value.algorithm !== 'hmac-sha256' ||
      !Number.isSafeInteger(value.contentBytes) ||
      (value.contentBytes as number) < 1 ||
      typeof value.contentDigest !== 'string' ||
      !DIGEST_PATTERN.test(value.contentDigest) ||
      typeof value.authenticationTag !== 'string' ||
      decoded.length !== 32 ||
      decoded.toString('base64url') !== value.authenticationTag
    ) {
      throw new LegacyCrontabDecisionAuthorizationFileError(
        'authentication record content is invalid',
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      kind: 'qinglong3-legacy-crontab-decision-file-authentication',
      algorithm: 'hmac-sha256',
      keyId: value.keyId,
      contentBytes: value.contentBytes as number,
      contentDigest: value.contentDigest,
      authenticationTag: value.authenticationTag,
    });
  } catch (error) {
    if (error instanceof LegacyCrontabDecisionAuthorizationFileError) {
      throw error;
    }
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'authentication record content is invalid',
      error,
    );
  } finally {
    decoded?.fill(0);
  }
}

async function verifyAuthentication(
  keyProvider: LocalSecretKeyProvider,
  authentication: AuthorizationFileAuthentication,
): Promise<void> {
  let material: LocalSecretKeyMaterial | null | undefined;
  let message: Buffer | undefined;
  let expected: Buffer | undefined;
  let supplied: Buffer | undefined;
  try {
    material = await keyProvider.resolve(authentication.keyId);
    if (!material) {
      throw new LegacyCrontabDecisionAuthorizationFileError(
        'authentication key is unavailable',
      );
    }
    normalizeKeyMaterial(material, authentication.keyId);
    message = authenticationMessage(
      authentication.contentDigest,
      authentication.contentBytes,
    );
    expected = createHmac('sha256', material.key).update(message).digest();
    supplied = Buffer.from(authentication.authenticationTag, 'base64url');
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new LegacyCrontabDecisionAuthorizationFileError(
        'content authentication does not match',
      );
    }
  } catch (error) {
    if (error instanceof LegacyCrontabDecisionAuthorizationFileError) {
      throw error;
    }
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'content authentication could not be verified',
      error,
    );
  } finally {
    wipeKeyMaterial(material);
    message?.fill(0);
    expected?.fill(0);
    supplied?.fill(0);
  }
}

function* readLines(
  descriptor: number,
  start: number,
  end: number,
): Iterable<FileLine> {
  let position = start;
  let pending = Buffer.alloc(0);
  let pendingStart = start;
  try {
    while (position < end) {
      const chunk = Buffer.allocUnsafe(
        Math.min(READ_CHUNK_BYTES, end - position),
      );
      const bytesRead = fs.readSync(
        descriptor,
        chunk,
        0,
        chunk.length,
        position,
      );
      if (bytesRead < 1) {
        chunk.fill(0);
        throw new LegacyCrontabDecisionAuthorizationFileError(
          'authorization file ended unexpectedly',
        );
      }
      position += bytesRead;
      const material = pending.length
        ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
        : Buffer.from(chunk.subarray(0, bytesRead));
      pending.fill(0);
      chunk.fill(0);
      let cursor = 0;
      for (;;) {
        const newline = material.indexOf(0x0a, cursor);
        if (newline < 0) break;
        const lineLength = newline - cursor;
        if (lineLength < 1 || lineLength > MAX_LINE_BYTES) {
          material.fill(0);
          throw new LegacyCrontabDecisionAuthorizationFileError(
            'authorization file contains an invalid line',
          );
        }
        const lineStart = pendingStart + cursor;
        const lineEnd = pendingStart + newline + 1;
        yield Object.freeze({
          start: lineStart,
          end: lineEnd,
          value: Buffer.from(material.subarray(cursor, newline)),
          framed: Buffer.from(material.subarray(cursor, newline + 1)),
        });
        cursor = newline + 1;
      }
      const next = Buffer.from(material.subarray(cursor));
      pendingStart += cursor;
      material.fill(0);
      pending = next;
      if (pending.length > MAX_LINE_BYTES) {
        throw new LegacyCrontabDecisionAuthorizationFileError(
          'authorization file contains an overlong line',
        );
      }
    }
    if (pending.length !== 0) {
      throw new LegacyCrontabDecisionAuthorizationFileError(
        'authorization file must end with a newline',
      );
    }
  } finally {
    pending.fill(0);
  }
}

function parseHeader(value: unknown): AuthorizationFileHeader {
  exactKeys(
    value,
    [
      'decisionId',
      'inventoryDigest',
      'kind',
      'planDigest',
      'profile',
      'schemaVersion',
    ],
    'header record',
  );
  assertHeaderIdentity({
    decisionId: value.decisionId,
    profile: value.profile,
    planDigest: value.planDigest,
    inventoryDigest: value.inventoryDigest,
  });
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'qinglong3-legacy-crontab-decision-file-header'
  ) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'header version or kind is invalid',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'qinglong3-legacy-crontab-decision-file-header',
    decisionId: value.decisionId as string,
    profile: value.profile as 'edge' | 'standalone',
    planDigest: value.planDigest as string,
    inventoryDigest: value.inventoryDigest as string,
  });
}

function decisionRecord(value: unknown): LegacyCrontabAdoptionDecision {
  exactKeys(value, ['decision', 'kind', 'schemaVersion'], 'decision record');
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'qinglong3-legacy-crontab-decision-file-row'
  ) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'decision record version or kind is invalid',
    );
  }
  try {
    return parseLegacyCrontabAdoptionDecision(value.decision);
  } catch (error) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'decision record content is invalid',
      error,
    );
  }
}

function receiptRecord(value: unknown): unknown {
  exactKeys(value, ['kind', 'receipt', 'schemaVersion'], 'receipt record');
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'qinglong3-legacy-crontab-decision-file-receipt'
  ) {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'receipt record version or kind is invalid',
    );
  }
  return value.receipt;
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function evidence(
  decisionId: string,
  decisionCount: number,
  fileBytes: number,
  fileDigest: string,
  authentication: AuthorizationFileAuthentication,
): LegacyCrontabDecisionAuthorizationFileEvidence {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'qinglong3-legacy-crontab-decision-authorization-file',
    decisionId,
    decisionCount,
    fileBytes,
    fileDigest,
    contentBytes: authentication.contentBytes,
    contentDigest: authentication.contentDigest,
    algorithm: authentication.algorithm,
    keyId: authentication.keyId,
    authenticationTag: authentication.authenticationTag,
  });
}

export async function publishLegacyCrontabDecisionAuthorizationFile(
  options: PublishLegacyCrontabDecisionAuthorizationFileOptions,
): Promise<LegacyCrontabDecisionAuthorizationFileResult> {
  const filePath = authorizationPath(options.filePath);
  const uid = currentUid();
  assertPrivateParent(filePath, uid);
  const fileHeader = header(options);
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(16).toString('hex')}.tmp`,
  );
  const contentHash = createHash('sha256').update(
    'qinglong3.legacy-crontab-decision-file-content.v1\0',
  );
  const fileHash = createHash('sha256');
  let descriptor: number | undefined;
  let published = false;
  let fileBytes = 0;
  let contentBytes = 0;
  let decisionCount = 0;
  try {
    descriptor = fs.openSync(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    const headerBytes = writeBoundedLine(
      descriptor,
      fileHeader,
      fileHash,
      contentHash,
      fileBytes,
    );
    fileBytes += headerBytes;
    contentBytes += headerBytes;

    const persistedDecisions =
      (function* (): Iterable<LegacyCrontabAdoptionDecision> {
        for (const candidate of options.decisions) {
          if (decisionCount >= MAX_LEGACY_CRONTAB_ROWS) {
            throw new LegacyCrontabDecisionAuthorizationFileError(
              'decision row count exceeds its hard bound',
            );
          }
          const decision = parseLegacyCrontabAdoptionDecision(candidate);
          const rowBytes = writeBoundedLine(
            descriptor!,
            {
              schemaVersion: 1,
              kind: 'qinglong3-legacy-crontab-decision-file-row',
              decision,
            },
            fileHash,
            contentHash,
            fileBytes,
          );
          fileBytes += rowBytes;
          contentBytes += rowBytes;
          decisionCount += 1;
          yield decision;
        }
      })();

    const receipt = options.createReceipt(persistedDecisions);
    if (
      receipt.decisionId !== fileHeader.decisionId ||
      receipt.profile !== fileHeader.profile ||
      receipt.planDigest !== fileHeader.planDigest ||
      receipt.inventoryDigest !== fileHeader.inventoryDigest ||
      receipt.decisions.rowCount !== decisionCount
    ) {
      throw new LegacyCrontabDecisionAuthorizationFileError(
        'receipt does not match the authorization header or rows',
      );
    }
    const receiptBytes = writeBoundedLine(
      descriptor,
      {
        schemaVersion: 1,
        kind: 'qinglong3-legacy-crontab-decision-file-receipt',
        receipt,
      },
      fileHash,
      contentHash,
      fileBytes,
    );
    fileBytes += receiptBytes;
    contentBytes += receiptBytes;
    const contentDigest = contentHash.digest('hex');
    const authentication = await authenticateContent(
      options.keyProvider,
      contentDigest,
      contentBytes,
    );
    const authenticationBytes = writeBoundedLine(
      descriptor,
      authentication,
      fileHash,
      undefined,
      fileBytes,
    );
    fileBytes += authenticationBytes;
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    await options.confirmExternalAuthority?.();
    try {
      fs.linkSync(temporary, filePath);
      published = true;
    } catch (error) {
      if (isCode(error, 'EEXIST')) {
        throw new LegacyCrontabDecisionAuthorizationFileAlreadyExistsError();
      }
      throw error;
    }
    fs.unlinkSync(temporary);
    syncDirectory(path.dirname(filePath));
    return Object.freeze({
      receipt,
      file: evidence(
        receipt.decisionId,
        decisionCount,
        fileBytes,
        fileHash.digest('hex'),
        authentication,
      ),
    });
  } catch (error) {
    if (
      error instanceof LegacyCrontabDecisionAuthorizationFileError ||
      error instanceof LegacyCrontabDecisionAuthorizationFileAlreadyExistsError
    ) {
      throw error;
    }
    throw new LegacyCrontabDecisionAuthorizationFileError(
      published
        ? 'published file durability could not be confirmed'
        : 'file could not be published',
      error,
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The original publication failure remains authoritative.
      }
    }
    if (!published) {
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if (!isCode(error, 'ENOENT')) {
          // Temporary cleanup is diagnostic-only.
        }
      }
    }
  }
}

async function verifyLegacyCrontabDecisionAuthorizationFileInternal<T>(
  options: VerifyLegacyCrontabDecisionAuthorizationFileOptions,
  consumer?: (
    scope: VerifiedLegacyCrontabDecisionAuthorizationFileScope,
  ) => T | Promise<T>,
): Promise<LegacyCrontabDecisionAuthorizationFileResult | T> {
  const filePath = authorizationPath(options.filePath);
  const uid = currentUid();
  assertPrivateParent(filePath, uid);
  assertHeaderIdentity({
    decisionId: options.expectedDecisionId,
    profile: options.expectedProfile,
    planDigest: options.expectedPlanDigest,
    inventoryDigest: options.expectedInventoryDigest,
  });
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      (Number(before.mode) & 0o777) !== 0o600 ||
      before.size < 1n ||
      before.size > BigInt(MAX_LEGACY_CRONTAB_DECISION_AUTHORIZATION_FILE_BYTES)
    ) {
      throw new LegacyCrontabDecisionAuthorizationFileError(
        'file must be a bounded owner-only regular file',
      );
    }
    descriptor = fs.openSync(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs
    ) {
      throw new LegacyCrontabDecisionAuthorizationFileError(
        'file identity changed while opening',
      );
    }

    const size = Number(opened.size);
    const fileHash = createHash('sha256');
    const contentHash = createHash('sha256').update(
      'qinglong3.legacy-crontab-decision-file-content.v1\0',
    );
    let fileHeader: AuthorizationFileHeader | undefined;
    let receiptValue: unknown;
    let authentication: AuthorizationFileAuthentication | undefined;
    let decisionStart = -1;
    let receiptStart = -1;
    let decisionCount = 0;
    let contentBytes = 0;
    let phase: 'header' | 'decisions' | 'authentication' | 'done' = 'header';
    for (const line of readLines(descriptor, 0, size)) {
      try {
        fileHash.update(line.framed);
        const value = parseJsonLine(line.value, 'authorization record');
        exactKeys(value, Object.keys(value as object), 'authorization record');
        const kind = value.kind;
        if (phase === 'header') {
          fileHeader = parseHeader(value);
          contentHash.update(line.framed);
          contentBytes += line.framed.length;
          phase = 'decisions';
          continue;
        }
        if (phase === 'decisions') {
          if (kind === 'qinglong3-legacy-crontab-decision-file-row') {
            if (decisionCount >= MAX_LEGACY_CRONTAB_ROWS) {
              throw new LegacyCrontabDecisionAuthorizationFileError(
                'decision row count exceeds its hard bound',
              );
            }
            decisionRecord(value);
            if (decisionStart < 0) decisionStart = line.start;
            decisionCount += 1;
            contentHash.update(line.framed);
            contentBytes += line.framed.length;
            continue;
          }
          receiptValue = receiptRecord(value);
          receiptStart = line.start;
          if (decisionStart < 0) decisionStart = receiptStart;
          contentHash.update(line.framed);
          contentBytes += line.framed.length;
          phase = 'authentication';
          continue;
        }
        if (phase === 'authentication') {
          authentication = parseAuthentication(value);
          phase = 'done';
          continue;
        }
        throw new LegacyCrontabDecisionAuthorizationFileError(
          'file contains records after authentication',
        );
      } finally {
        line.value.fill(0);
        line.framed.fill(0);
      }
    }
    if (
      phase !== 'done' ||
      !fileHeader ||
      receiptValue === undefined ||
      !authentication ||
      decisionStart < 0 ||
      receiptStart < 0
    ) {
      throw new LegacyCrontabDecisionAuthorizationFileError(
        'file record sequence is incomplete',
      );
    }
    if (
      fileHeader.decisionId !== options.expectedDecisionId ||
      fileHeader.profile !== options.expectedProfile ||
      fileHeader.planDigest !== options.expectedPlanDigest ||
      fileHeader.inventoryDigest !== options.expectedInventoryDigest
    ) {
      throw new LegacyCrontabDecisionAuthorizationFileError(
        'file header does not match the expected review',
      );
    }
    const contentDigest = contentHash.digest('hex');
    if (
      authentication.contentBytes !== contentBytes ||
      authentication.contentDigest !== contentDigest
    ) {
      throw new LegacyCrontabDecisionAuthorizationFileError(
        'authenticated content evidence does not match the file',
      );
    }
    await verifyAuthentication(options.keyProvider, authentication);

    const decisions = (function* (): Iterable<LegacyCrontabAdoptionDecision> {
      for (const line of readLines(descriptor!, decisionStart, receiptStart)) {
        try {
          yield decisionRecord(parseJsonLine(line.value, 'decision record'));
        } finally {
          line.value.fill(0);
          line.framed.fill(0);
        }
      }
    })();
    const receipt = options.verifyReceipt(receiptValue, decisions);
    if (
      receipt.decisionId !== fileHeader.decisionId ||
      receipt.profile !== fileHeader.profile ||
      receipt.planDigest !== fileHeader.planDigest ||
      receipt.inventoryDigest !== fileHeader.inventoryDigest ||
      receipt.decisions.rowCount !== decisionCount
    ) {
      throw new LegacyCrontabDecisionAuthorizationFileError(
        'verified receipt does not match the file header or rows',
      );
    }

    const confirmIdentity = (): void => {
      const afterOpen = fs.fstatSync(descriptor!, { bigint: true });
      const afterPath = fs.lstatSync(filePath, { bigint: true });
      if (
        afterOpen.dev !== opened.dev ||
        afterOpen.ino !== opened.ino ||
        afterOpen.size !== opened.size ||
        afterOpen.mtimeNs !== opened.mtimeNs ||
        afterOpen.ctimeNs !== opened.ctimeNs ||
        afterPath.dev !== opened.dev ||
        afterPath.ino !== opened.ino ||
        afterPath.size !== opened.size ||
        afterPath.mtimeNs !== opened.mtimeNs ||
        afterPath.ctimeNs !== opened.ctimeNs ||
        Number(afterPath.uid) !== uid ||
        (Number(afterPath.mode) & 0o777) !== 0o600
      ) {
        throw new LegacyCrontabDecisionAuthorizationFileError(
          'file identity changed during verification',
        );
      }
    };
    confirmIdentity();
    const result = Object.freeze({
      receipt,
      file: evidence(
        receipt.decisionId,
        decisionCount,
        size,
        fileHash.digest('hex'),
        authentication,
      ),
    });
    if (!consumer) return result;
    const verifiedDecisions =
      (function* (): Iterable<LegacyCrontabAdoptionDecision> {
        for (const line of readLines(
          descriptor!,
          decisionStart,
          receiptStart,
        )) {
          try {
            yield decisionRecord(parseJsonLine(line.value, 'decision record'));
          } finally {
            line.value.fill(0);
            line.framed.fill(0);
          }
        }
      })();
    const consumed = await consumer(
      Object.freeze({
        result,
        decisions: verifiedDecisions,
        confirmIdentity,
      }),
    );
    confirmIdentity();
    return consumed;
  } catch (error) {
    if (error instanceof LegacyCrontabDecisionAuthorizationFileError) {
      throw error;
    }
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'file could not be verified',
      error,
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export async function verifyLegacyCrontabDecisionAuthorizationFile(
  options: VerifyLegacyCrontabDecisionAuthorizationFileOptions,
): Promise<LegacyCrontabDecisionAuthorizationFileResult> {
  return (await verifyLegacyCrontabDecisionAuthorizationFileInternal(
    options,
  )) as LegacyCrontabDecisionAuthorizationFileResult;
}

export async function withVerifiedLegacyCrontabDecisionAuthorizationFile<T>(
  options: VerifyLegacyCrontabDecisionAuthorizationFileOptions,
  consumer: (
    scope: VerifiedLegacyCrontabDecisionAuthorizationFileScope,
  ) => T | Promise<T>,
): Promise<T> {
  if (typeof consumer !== 'function') {
    throw new LegacyCrontabDecisionAuthorizationFileError(
      'verified authorization consumer is invalid',
    );
  }
  return (await verifyLegacyCrontabDecisionAuthorizationFileInternal(
    options,
    consumer,
  )) as T;
}
