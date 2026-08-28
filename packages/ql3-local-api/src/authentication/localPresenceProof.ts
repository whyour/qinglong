import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { LocalApplicationProfile } from '@qinglong/local-application';

const PRESENCE_DIRECTORY = 'console-presence';
const AUTHORIZATION_TTL_MS = 120_000;
const AUTHORIZATION_PATTERN =
  /^ql3p_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface PendingLocalPresenceAuthorization {
  readonly authorizationId: string;
  readonly fileName: string;
  readonly requestDigest: string;
  readonly credentialDigest: string;
  readonly proofDigest: Buffer;
  readonly expiresAtMs: number;
}

export interface LocalPresenceBinding {
  readonly requestDigest: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly subjectType: 'user';
  readonly subjectId: string;
}

export interface LocalPresenceChallenge {
  readonly authorizationId: string;
  readonly requestDigest: string;
  readonly expiresAtMs: number;
  readonly proofFileName: string;
}

export interface ConsumedLocalPresenceProof {
  readonly authorizationId: string;
  readonly authenticatedAtMs: number;
  readonly expiresAtMs: number;
}

export interface LocalPresenceProofManager {
  issue(binding: Readonly<LocalPresenceBinding>): LocalPresenceChallenge;
  consume(
    presentation: string | null,
    binding: Readonly<LocalPresenceBinding>,
  ): ConsumedLocalPresenceProof | null;
  close(): void;
}

export interface LocalPresenceProofManagerOptions {
  readonly deploymentRoot: string;
  readonly profile: LocalApplicationProfile;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
  readonly randomSecret?: () => Buffer;
}

export class LocalPresenceProofConfigurationError extends TypeError {
  readonly code = 'QL3_LOCAL_PRESENCE_CONFIG_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(`Local presence proof configuration is invalid: ${message}`, options);
    this.name = 'LocalPresenceProofConfigurationError';
  }
}

export class LocalPresenceProofUnavailableError extends Error {
  readonly code = 'QL3_LOCAL_PRESENCE_UNAVAILABLE';

  constructor(message: string, options?: ErrorOptions) {
    super(`Local presence proof is unavailable: ${message}`, options);
    this.name = 'LocalPresenceProofUnavailableError';
  }
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new LocalPresenceProofConfigurationError(
      'POSIX user identity is unavailable',
    );
  }
  const uid = process.getuid();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new LocalPresenceProofConfigurationError('POSIX user is invalid');
  }
  return uid;
}

function privateDirectory(directoryPath: string, uid: number): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directoryPath);
  } catch (error) {
    throw new LocalPresenceProofConfigurationError(
      'private directory is unavailable',
      { cause: error },
    );
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new LocalPresenceProofConfigurationError(
      'private directory ownership or mode is invalid',
    );
  }
}

function clock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalPresenceProofUnavailableError('clock is invalid');
  }
  return value;
}

function credentialDigest(binding: Readonly<LocalPresenceBinding>): string {
  if (
    !binding ||
    typeof binding !== 'object' ||
    Array.isArray(binding) ||
    Object.keys(binding).sort().join('\0') !==
      [
        'credentialId',
        'credentialVersion',
        'requestDigest',
        'subjectId',
        'subjectType',
      ]
        .sort()
        .join('\0') ||
    !SHA256_PATTERN.test(binding.requestDigest) ||
    typeof binding.credentialId !== 'string' ||
    binding.credentialId.length < 1 ||
    binding.credentialId.length > 64 ||
    !Number.isSafeInteger(binding.credentialVersion) ||
    binding.credentialVersion < 1 ||
    binding.subjectType !== 'user' ||
    typeof binding.subjectId !== 'string' ||
    binding.subjectId.length < 1 ||
    binding.subjectId.length > 128
  ) {
    throw new LocalPresenceProofUnavailableError('binding is invalid');
  }
  return createHash('sha256')
    .update('qinglong3.local-presence-credential.v1\0', 'utf8')
    .update(binding.credentialId, 'utf8')
    .update('\0', 'utf8')
    .update(String(binding.credentialVersion), 'utf8')
    .update('\0', 'utf8')
    .update(binding.subjectType, 'utf8')
    .update('\0', 'utf8')
    .update(binding.subjectId, 'utf8')
    .digest('hex');
}

function removeFile(directory: string, fileName: string): void {
  try {
    fs.unlinkSync(path.join(directory, fileName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new LocalPresenceProofUnavailableError(
        'proof file cannot be removed',
        { cause: error },
      );
    }
  }
}

function writeProofFile(
  directory: string,
  authorization: Omit<PendingLocalPresenceAuthorization, 'proofDigest'>,
  presentation: string,
): void {
  const filePath = path.join(directory, authorization.fileName);
  const payload = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-presence-proof',
      authorizationId: authorization.authorizationId,
      requestDigest: authorization.requestDigest,
      expiresAtMs: authorization.expiresAtMs,
      proof: presentation,
    })}\n`,
    'utf8',
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.writeFileSync(descriptor, payload);
    fs.fsyncSync(descriptor);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
      throw new Error('proof file identity is invalid');
    }
  } catch (error) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Preserve the original publication failure.
    }
    throw new LocalPresenceProofUnavailableError(
      'proof file cannot be published',
      { cause: error },
    );
  } finally {
    payload.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function createLocalPresenceProofManager(
  options: Readonly<LocalPresenceProofManagerOptions>,
): Readonly<LocalPresenceProofManager> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        key !== 'deploymentRoot' &&
        key !== 'profile' &&
        key !== 'now' &&
        key !== 'randomUuid' &&
        key !== 'randomSecret',
    ) ||
    typeof options.deploymentRoot !== 'string' ||
    !path.isAbsolute(options.deploymentRoot) ||
    path.normalize(options.deploymentRoot) !== options.deploymentRoot ||
    path.parse(options.deploymentRoot).root === options.deploymentRoot ||
    (options.profile !== 'edge' && options.profile !== 'standalone') ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.randomUuid !== undefined &&
      typeof options.randomUuid !== 'function') ||
    (options.randomSecret !== undefined &&
      typeof options.randomSecret !== 'function')
  ) {
    throw new LocalPresenceProofConfigurationError('options are invalid');
  }
  const uid = currentUid();
  privateDirectory(options.deploymentRoot, uid);
  const directory = path.join(options.deploymentRoot, PRESENCE_DIRECTORY);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
      throw new LocalPresenceProofConfigurationError(
        'private directory cannot be created',
        { cause: error },
      );
    }
  }
  privateDirectory(directory, uid);
  const now = options.now ?? Date.now;
  const uuid = options.randomUuid ?? randomUUID;
  const secret = options.randomSecret ?? (() => randomBytes(32));
  const maximumPending = options.profile === 'edge' ? 8 : 32;
  const pending = new Map<string, PendingLocalPresenceAuthorization>();
  let closed = false;

  const sweep = (nowMs: number) => {
    for (const [authorizationId, authorization] of pending) {
      if (authorization.expiresAtMs > nowMs) continue;
      removeFile(directory, authorization.fileName);
      authorization.proofDigest.fill(0);
      pending.delete(authorizationId);
    }
  };

  return Object.freeze({
    issue(binding: Readonly<LocalPresenceBinding>) {
      if (closed) {
        throw new LocalPresenceProofUnavailableError('manager is closed');
      }
      const nowMs = clock(now);
      sweep(nowMs);
      if (pending.size >= maximumPending) {
        throw new LocalPresenceProofUnavailableError(
          'pending authorization capacity is exhausted',
        );
      }
      const boundCredentialDigest = credentialDigest(binding);
      const authorizationId = uuid();
      if (
        !AUTHORIZATION_PATTERN.test(`ql3p_${authorizationId}_${'A'.repeat(43)}`)
      ) {
        throw new LocalPresenceProofUnavailableError(
          'authorization identity is invalid',
        );
      }
      const material = secret();
      if (!Buffer.isBuffer(material) || material.byteLength !== 32) {
        throw new LocalPresenceProofUnavailableError(
          'proof entropy is unavailable',
        );
      }
      let presentation: string | undefined;
      try {
        presentation = `ql3p_${authorizationId}_${material.toString(
          'base64url',
        )}`;
        const authorization = Object.freeze({
          authorizationId,
          fileName: `${authorizationId}.json`,
          requestDigest: binding.requestDigest,
          credentialDigest: boundCredentialDigest,
          expiresAtMs: nowMs + AUTHORIZATION_TTL_MS,
        });
        writeProofFile(directory, authorization, presentation);
        pending.set(
          authorizationId,
          Object.freeze({
            ...authorization,
            proofDigest: createHash('sha256')
              .update('qinglong3.local-presence-proof.v1\0', 'utf8')
              .update(presentation, 'utf8')
              .digest(),
          }),
        );
        return Object.freeze({
          authorizationId,
          requestDigest: binding.requestDigest,
          expiresAtMs: authorization.expiresAtMs,
          proofFileName: authorization.fileName,
        });
      } finally {
        material.fill(0);
        presentation = undefined;
      }
    },

    consume(
      presentation: string | null,
      binding: Readonly<LocalPresenceBinding>,
    ) {
      if (closed || typeof presentation !== 'string') return null;
      const nowMs = clock(now);
      sweep(nowMs);
      const match = AUTHORIZATION_PATTERN.exec(presentation);
      if (!match) return null;
      const authorization = pending.get(match[1]!);
      if (!authorization) return null;
      const actualProofDigest = createHash('sha256')
        .update('qinglong3.local-presence-proof.v1\0', 'utf8')
        .update(presentation, 'utf8')
        .digest();
      let valid = false;
      try {
        valid =
          authorization.expiresAtMs > nowMs &&
          authorization.requestDigest === binding.requestDigest &&
          authorization.credentialDigest === credentialDigest(binding) &&
          timingSafeEqual(actualProofDigest, authorization.proofDigest);
      } finally {
        actualProofDigest.fill(0);
      }
      if (!valid) return null;
      pending.delete(authorization.authorizationId);
      removeFile(directory, authorization.fileName);
      authorization.proofDigest.fill(0);
      return Object.freeze({
        authorizationId: authorization.authorizationId,
        authenticatedAtMs: nowMs,
        expiresAtMs: authorization.expiresAtMs,
      });
    },

    close() {
      if (closed) return;
      closed = true;
      let firstError: unknown;
      for (const authorization of pending.values()) {
        try {
          removeFile(directory, authorization.fileName);
        } catch (error) {
          firstError ??= error;
        }
        authorization.proofDigest.fill(0);
      }
      pending.clear();
      if (firstError) throw firstError;
    },
  });
}
