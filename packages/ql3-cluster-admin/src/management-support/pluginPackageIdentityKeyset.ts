/** Shared bounded identity keyset and rotation boundary for cluster management planes. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import {
  CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_IDENTITY_ASSERTION_PROFILE,
  CLUSTER_AUTOMATION_MANAGEMENT_IDENTITY_ASSERTION_PROFILE,
  CLUSTER_APPROVAL_MANAGEMENT_IDENTITY_ASSERTION_PROFILE,
  CLUSTER_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_IDENTITY_ASSERTION_PROFILE,
  CLUSTER_RUN_MANAGEMENT_IDENTITY_ASSERTION_PROFILE,
  CLUSTER_SECURITY_ADMINISTRATION_IDENTITY_ASSERTION_PROFILE,
  createClusterPluginPackageIdentityAssertionVerifier,
  type ClusterManagementIdentityAssertionProfile,
  type ClusterPluginPackageIdentityAssertionAuthentication,
  type ClusterPluginPackageIdentityAssertionVerifier,
} from './pluginPackageIdentityAssertion';

const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const MIN_MAX_FILE_BYTES = 4 * 1024;
const HARD_MAX_FILE_BYTES = 256 * 1024;
const MAX_REVOKED_KEYS = 64;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export interface ClusterPluginPackageIdentityKeysetFileOptions {
  readonly filePath: string;
  readonly maxFileBytes?: number;
  readonly now?: () => number;
  readonly ledger?: ClusterPluginPackageIdentityKeysetLedger;
  readonly assertionProfile?: Readonly<ClusterManagementIdentityAssertionProfile>;
}

export type ClusterWorkerCredentialIdentityKeysetFileOptions = Omit<
  ClusterPluginPackageIdentityKeysetFileOptions,
  'assertionProfile'
>;

export interface ClusterPluginPackageIdentityKeysetSnapshot {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly digest: string;
  readonly issuer: string;
  readonly audience: string;
  readonly activeKeyIds: readonly string[];
  readonly revokedKeyIds: readonly string[];
}

export interface ClusterPluginPackageIdentityKeysetFile {
  reload(): Promise<Readonly<ClusterPluginPackageIdentityKeysetSnapshot>>;
  bind(
    assertion: unknown,
  ): Readonly<ClusterPluginPackageIdentityAssertionAuthentication>;
}

export interface ClusterPluginPackageIdentityKeysetLedger {
  observe(
    snapshot: Readonly<ClusterPluginPackageIdentityKeysetSnapshot>,
  ): Promise<void>;
}

export class ClusterPluginPackageIdentityKeysetConfigurationError extends TypeError {
  readonly code =
    'CLUSTER_PLUGIN_PACKAGE_IDENTITY_KEYSET_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(
      `Cluster Plugin Package identity keyset configuration is invalid: ${message}`,
    );
    this.name = 'ClusterPluginPackageIdentityKeysetConfigurationError';
  }
}

export class ClusterPluginPackageIdentityKeysetUnavailableError extends Error {
  readonly code = 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_KEYSET_UNAVAILABLE';

  constructor(readonly cause?: unknown) {
    super('Cluster Plugin Package identity keyset is unavailable');
    this.name = 'ClusterPluginPackageIdentityKeysetUnavailableError';
  }
}

interface LoadedKeyset {
  readonly generation: number;
  readonly digest: string;
  readonly verifier: Readonly<ClusterPluginPackageIdentityAssertionVerifier>;
  readonly activeKeyIds: ReadonlySet<string>;
  readonly revokedKeyIds: ReadonlySet<string>;
  readonly snapshot: Readonly<ClusterPluginPackageIdentityKeysetSnapshot>;
}

function configurationFailure(
  message: string,
): ClusterPluginPackageIdentityKeysetConfigurationError {
  return new ClusterPluginPackageIdentityKeysetConfigurationError(message);
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configurationFailure(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw configurationFailure(`${label} shape is invalid`);
  }
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw configurationFailure(`${label} is invalid`);
  }
  return value as number;
}

function sameFileState(
  left: Readonly<{
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  }>,
  right: Readonly<{
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  }>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readBoundedRegularFile(
  filePath: string,
  maxFileBytes: number,
): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > maxFileBytes ||
      (before.mode & 0o022) !== 0
    ) {
      throw configurationFailure(
        'keyset file must be a bounded non-writable regular file',
      );
    }
    const buffer = Buffer.allocUnsafe(maxFileBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size ||
      offset > maxFileBytes ||
      !sameFileState(before, after)
    ) {
      throw configurationFailure('keyset file changed while being read');
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseJson(bytes: Buffer): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw configurationFailure('keyset file must be strict UTF-8');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw configurationFailure('keyset file must contain JSON');
  }
  exactObject(
    value,
    [
      'schemaVersion',
      'generation',
      'issuer',
      'audience',
      'keys',
      'revokedKids',
      'assuranceMappings',
      'constraints',
    ],
    'keyset',
  );
  return value;
}

function reviewedRevokedKeyIds(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length > MAX_REVOKED_KEYS) {
    throw configurationFailure('revoked key ids are invalid');
  }
  const ids = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== 'string' ||
      !KEY_ID_PATTERN.test(candidate) ||
      ids.has(candidate)
    ) {
      throw configurationFailure('revoked key id is invalid or duplicated');
    }
    ids.add(candidate);
  }
  return ids;
}

function activeKeys(
  value: unknown,
  revokedKeyIds: ReadonlySet<string>,
): {
  readonly all: readonly Readonly<Record<string, unknown>>[];
  readonly active: readonly Readonly<Record<string, unknown>>[];
  readonly activeKeyIds: ReadonlySet<string>;
} {
  if (!Array.isArray(value)) {
    throw configurationFailure('keys must be an array');
  }
  const all = value as readonly Readonly<Record<string, unknown>>[];
  const active: Readonly<Record<string, unknown>>[] = [];
  const activeKeyIds = new Set<string>();
  for (const candidate of all) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      throw configurationFailure('key must be an object');
    }
    const kid = candidate.kid;
    if (typeof kid !== 'string') {
      throw configurationFailure('key id is invalid');
    }
    if (!revokedKeyIds.has(kid)) {
      active.push(candidate);
      activeKeyIds.add(kid);
    }
  }
  if (active.length < 1) {
    throw configurationFailure('at least one key must remain active');
  }
  return Object.freeze({ all, active, activeKeyIds });
}

function loadDocument(
  bytes: Buffer,
  now: (() => number) | undefined,
  digest: string,
  assertionProfile:
    | Readonly<ClusterManagementIdentityAssertionProfile>
    | undefined,
): LoadedKeyset {
  const document = parseJson(bytes);
  if (document.schemaVersion !== 1) {
    throw configurationFailure('schemaVersion is invalid');
  }
  const generation = boundedInteger(
    document.generation,
    1,
    Number.MAX_SAFE_INTEGER,
    'generation',
  );
  const revokedKeyIds = reviewedRevokedKeyIds(document.revokedKids);
  const keySelection = activeKeys(document.keys, revokedKeyIds);
  exactObject(
    document.constraints,
    [
      'maxAssertionBytes',
      'maxLifetimeMs',
      'maxAuthenticationAgeMs',
      'clockSkewMs',
    ],
    'constraints',
  );
  const verifierOptions = {
    issuer: document.issuer as string,
    audience: document.audience as string,
    assuranceMappings: document.assuranceMappings as never,
    maxAssertionBytes: document.constraints.maxAssertionBytes as number,
    maxLifetimeMs: document.constraints.maxLifetimeMs as number,
    maxAuthenticationAgeMs: document.constraints
      .maxAuthenticationAgeMs as number,
    clockSkewMs: document.constraints.clockSkewMs as number,
    ...(assertionProfile === undefined ? {} : { assertionProfile }),
    ...(now === undefined ? {} : { now }),
  };
  // Validate revoked definitions too; revocation must not become a channel for
  // retaining malformed or private key material in the trust document.
  createClusterPluginPackageIdentityAssertionVerifier({
    ...verifierOptions,
    keys: keySelection.all,
  });
  const verifier = createClusterPluginPackageIdentityAssertionVerifier({
    ...verifierOptions,
    keys: keySelection.active,
  });
  const issuer = document.issuer as string;
  const audience = document.audience as string;
  const snapshot = Object.freeze({
    schemaVersion: 1 as const,
    generation,
    digest,
    issuer,
    audience,
    activeKeyIds: Object.freeze([...keySelection.activeKeyIds].sort()),
    revokedKeyIds: Object.freeze([...revokedKeyIds].sort()),
  });
  return Object.freeze({
    generation,
    digest,
    verifier,
    activeKeyIds: keySelection.activeKeyIds,
    revokedKeyIds,
    snapshot,
  });
}

function assertForwardRotation(
  current: LoadedKeyset,
  candidate: LoadedKeyset,
): void {
  if (candidate.generation < current.generation) {
    throw configurationFailure('keyset generation rollback is forbidden');
  }
  if (
    candidate.generation === current.generation &&
    candidate.digest !== current.digest
  ) {
    throw configurationFailure('keyset generation rewrite is forbidden');
  }
  if (candidate.generation === current.generation) return;
  for (const kid of current.revokedKeyIds) {
    if (!candidate.revokedKeyIds.has(kid)) {
      throw configurationFailure('revoked key ids are append-only');
    }
  }
  for (const kid of current.activeKeyIds) {
    if (!candidate.activeKeyIds.has(kid) && !candidate.revokedKeyIds.has(kid)) {
      throw configurationFailure(
        'removed active keys must be explicitly revoked',
      );
    }
  }
}

export function createClusterPluginPackageIdentityKeysetFile(
  options: ClusterPluginPackageIdentityKeysetFileOptions,
): Readonly<ClusterPluginPackageIdentityKeysetFile> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        key !== 'filePath' &&
        key !== 'maxFileBytes' &&
        key !== 'now' &&
        key !== 'ledger' &&
        key !== 'assertionProfile',
    ) ||
    typeof options.filePath !== 'string' ||
    options.filePath.length < 1 ||
    options.filePath.length > 4_096 ||
    CONTROL_PATTERN.test(options.filePath) ||
    !isAbsolute(options.filePath) ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.ledger !== undefined &&
      (!options.ledger ||
        typeof options.ledger !== 'object' ||
        typeof options.ledger.observe !== 'function'))
  ) {
    throw configurationFailure('options are invalid');
  }
  const maxFileBytes =
    options.maxFileBytes === undefined
      ? DEFAULT_MAX_FILE_BYTES
      : boundedInteger(
          options.maxFileBytes,
          MIN_MAX_FILE_BYTES,
          HARD_MAX_FILE_BYTES,
          'maximum file bytes',
        );
  let current: LoadedKeyset | undefined;

  const reload = async (): Promise<
    Readonly<ClusterPluginPackageIdentityKeysetSnapshot>
  > => {
    try {
      const bytes = await readBoundedRegularFile(
        options.filePath,
        maxFileBytes,
      );
      const digest = createHash('sha256').update(bytes).digest('base64url');
      if (current?.digest === digest) {
        await options.ledger?.observe(current.snapshot);
        return current.snapshot;
      }
      const candidate = loadDocument(
        bytes,
        options.now,
        digest,
        options.assertionProfile,
      );
      if (current) {
        assertForwardRotation(current, candidate);
      }
      await options.ledger?.observe(candidate.snapshot);
      current = candidate;
      return candidate.snapshot;
    } catch (error) {
      if (error instanceof ClusterPluginPackageIdentityKeysetUnavailableError) {
        throw error;
      }
      throw new ClusterPluginPackageIdentityKeysetUnavailableError(error);
    }
  };

  return Object.freeze({
    reload,
    bind(assertion: unknown) {
      return Object.freeze({
        async authenticate() {
          await reload();
          if (!current) {
            throw new ClusterPluginPackageIdentityKeysetUnavailableError();
          }
          return current.verifier.verify(assertion);
        },
      });
    },
  });
}

export function createClusterWorkerCredentialIdentityKeysetFile(
  options: ClusterWorkerCredentialIdentityKeysetFileOptions,
): Readonly<ClusterPluginPackageIdentityKeysetFile> {
  return createClusterPluginPackageIdentityKeysetFile({
    ...options,
    assertionProfile:
      CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_IDENTITY_ASSERTION_PROFILE,
  });
}

export function createClusterAutomationIdentityKeysetFile(
  options: ClusterWorkerCredentialIdentityKeysetFileOptions,
): Readonly<ClusterPluginPackageIdentityKeysetFile> {
  return createClusterPluginPackageIdentityKeysetFile({
    ...options,
    assertionProfile: CLUSTER_AUTOMATION_MANAGEMENT_IDENTITY_ASSERTION_PROFILE,
  });
}

export function createClusterApprovalIdentityKeysetFile(
  options: ClusterWorkerCredentialIdentityKeysetFileOptions,
): Readonly<ClusterPluginPackageIdentityKeysetFile> {
  return createClusterPluginPackageIdentityKeysetFile({
    ...options,
    assertionProfile: CLUSTER_APPROVAL_MANAGEMENT_IDENTITY_ASSERTION_PROFILE,
  });
}

export function createClusterModelProviderCredentialIdentityKeysetFile(
  options: ClusterWorkerCredentialIdentityKeysetFileOptions,
): Readonly<ClusterPluginPackageIdentityKeysetFile> {
  return createClusterPluginPackageIdentityKeysetFile({
    ...options,
    assertionProfile:
      CLUSTER_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_IDENTITY_ASSERTION_PROFILE,
  });
}

export function createClusterRunIdentityKeysetFile(
  options: ClusterWorkerCredentialIdentityKeysetFileOptions,
): Readonly<ClusterPluginPackageIdentityKeysetFile> {
  return createClusterPluginPackageIdentityKeysetFile({
    ...options,
    assertionProfile: CLUSTER_RUN_MANAGEMENT_IDENTITY_ASSERTION_PROFILE,
  });
}

export function createClusterSecurityAdministrationIdentityKeysetFile(
  options: ClusterWorkerCredentialIdentityKeysetFileOptions,
): Readonly<ClusterPluginPackageIdentityKeysetFile> {
  return createClusterPluginPackageIdentityKeysetFile({
    ...options,
    assertionProfile:
      CLUSTER_SECURITY_ADMINISTRATION_IDENTITY_ASSERTION_PROFILE,
  });
}
