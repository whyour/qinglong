import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, normalize, parse, relative } from 'node:path';

import type { ModelInvocationContext, ModelInvocationPolicy } from './model';
import { OpenAiCompatibleProvider } from './openAiCompatibleProvider';
import type { ModelGatewayProviderAuthority } from '../profile/profileComposition';
import type { ModelProviderAuthorizationProvider } from '../model-provider-credential/providerCredential';
import { normalizeModelInvocationPolicy } from './validation';

export const PROJECTED_MODEL_GATEWAY_AUTHORITY_SCHEMA =
  'qinglong/projected-model-gateway-authority@v1';

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_PROVIDERS = 16;
const MAX_PROJECTS = 1024;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export interface ProjectedModelGatewayProviderConfig {
  readonly type: string;
  readonly baseUrl: string;
  readonly allowPlaintextLoopback: boolean;
  readonly maxResponseBytes: number;
}

export interface ProjectedModelGatewayProjectConfig {
  readonly projectId: string;
  readonly policy: Readonly<ModelInvocationPolicy>;
}

export interface ProjectedModelGatewayAuthorityManifest {
  readonly schema: typeof PROJECTED_MODEL_GATEWAY_AUTHORITY_SCHEMA;
  readonly providers: readonly Readonly<ProjectedModelGatewayProviderConfig>[];
  readonly projects: readonly Readonly<ProjectedModelGatewayProjectConfig>[];
}

export interface ProjectedModelGatewayAuthorityOptions {
  readonly configFile: string;
  readonly credentials: ModelProviderAuthorizationProvider;
}

export class ProjectedModelGatewayAuthorityUnavailableError extends Error {
  readonly code = 'PROJECTED_MODEL_GATEWAY_AUTHORITY_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Projected model gateway authority is unavailable', options);
    this.name = 'ProjectedModelGatewayAuthorityUnavailableError';
  }
}

function unavailable(
  cause?: unknown,
): ProjectedModelGatewayAuthorityUnavailableError {
  return new ProjectedModelGatewayAuthorityUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== [...expectedKeys].sort().join('\0')
  ) {
    throw unavailable();
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    throw unavailable();
  }
  return value;
}

function configFile(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    parse(value).root === value ||
    normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw unavailable();
  }
  return value;
}

function providerConfig(
  value: unknown,
): Readonly<ProjectedModelGatewayProviderConfig> {
  const candidate = exactObject(value, [
    'allowPlaintextLoopback',
    'baseUrl',
    'maxResponseBytes',
    'type',
  ]);
  if (
    typeof candidate.baseUrl !== 'string' ||
    typeof candidate.allowPlaintextLoopback !== 'boolean' ||
    !Number.isSafeInteger(candidate.maxResponseBytes) ||
    (candidate.maxResponseBytes as number) < 1 ||
    (candidate.maxResponseBytes as number) > 8 * 1024 * 1024
  ) {
    throw unavailable();
  }
  return Object.freeze({
    type: identifier(candidate.type),
    baseUrl: candidate.baseUrl,
    allowPlaintextLoopback: candidate.allowPlaintextLoopback,
    maxResponseBytes: candidate.maxResponseBytes as number,
  });
}

function projectConfig(
  value: unknown,
): Readonly<ProjectedModelGatewayProjectConfig> {
  const candidate = exactObject(value, ['policy', 'projectId']);
  try {
    return Object.freeze({
      projectId: identifier(candidate.projectId),
      policy: normalizeModelInvocationPolicy(
        candidate.policy as ModelInvocationPolicy,
      ),
    });
  } catch (cause) {
    throw unavailable(cause);
  }
}

export function normalizeProjectedModelGatewayAuthorityManifest(
  value: ProjectedModelGatewayAuthorityManifest,
): Readonly<ProjectedModelGatewayAuthorityManifest> {
  const candidate = exactObject(value, ['projects', 'providers', 'schema']);
  if (
    candidate.schema !== PROJECTED_MODEL_GATEWAY_AUTHORITY_SCHEMA ||
    !Array.isArray(candidate.providers) ||
    candidate.providers.length < 1 ||
    candidate.providers.length > MAX_PROVIDERS ||
    !Array.isArray(candidate.projects) ||
    candidate.projects.length < 1 ||
    candidate.projects.length > MAX_PROJECTS
  ) {
    throw unavailable();
  }
  const providers = candidate.providers.map(providerConfig);
  const projects = candidate.projects.map(projectConfig);
  const providerTypes = providers.map(({ type }) => type);
  const projectIds = projects.map(({ projectId }) => projectId);
  if (
    new Set(providerTypes).size !== providerTypes.length ||
    new Set(projectIds).size !== projectIds.length ||
    providerTypes.some(
      (value, index) => index > 0 && value <= providerTypes[index - 1]!,
    ) ||
    projectIds.some(
      (value, index) => index > 0 && value <= projectIds[index - 1]!,
    ) ||
    projects.some(({ policy }) =>
      policy.allowedProviders.some(
        (provider) => !providerTypes.includes(provider),
      ),
    )
  ) {
    throw unavailable();
  }
  return Object.freeze({
    schema: PROJECTED_MODEL_GATEWAY_AUTHORITY_SCHEMA,
    providers: Object.freeze(providers),
    projects: Object.freeze(projects),
  });
}

export function canonicalProjectedModelGatewayAuthorityManifest(
  value: ProjectedModelGatewayAuthorityManifest,
): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      normalizeProjectedModelGatewayAuthorityManifest(value),
    )}\n`,
    'utf8',
  );
}

function remainsBelow(parent: string, candidate: string): boolean {
  const suffix = relative(parent, candidate);
  return (
    suffix.length > 0 &&
    !isAbsolute(suffix) &&
    suffix !== '..' &&
    !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}

async function readManifest(
  configuredFile: string,
): Promise<Readonly<ProjectedModelGatewayAuthorityManifest>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let bytes: Buffer | undefined;
  let canonical: Buffer | undefined;
  try {
    const configured = await lstat(configuredFile);
    if (!configured.isFile() && !configured.isSymbolicLink())
      throw unavailable();
    const configuredParent = parse(configuredFile).dir;
    const directParent = await lstat(configuredParent);
    if (!directParent.isDirectory() || directParent.isSymbolicLink()) {
      throw unavailable();
    }
    const parent = await realpath(configuredParent);
    const target = await realpath(configuredFile);
    if (!remainsBelow(parent, target)) throw unavailable();
    handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > MAX_CONFIG_BYTES ||
      (before.mode & 0o222) !== 0 ||
      (before.mode & 0o111) !== 0 ||
      (before.mode & 0o007) !== 0 ||
      (before.mode & 0o440) === 0
    ) {
      throw unavailable();
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      (await realpath(configuredFile)) !== target ||
      (await realpath(configuredParent)) !== parent
    ) {
      throw unavailable();
    }
    const parsed = JSON.parse(
      new TextDecoder('utf8', { fatal: true }).decode(bytes),
    );
    const manifest = normalizeProjectedModelGatewayAuthorityManifest(
      parsed as ProjectedModelGatewayAuthorityManifest,
    );
    canonical = canonicalProjectedModelGatewayAuthorityManifest(manifest);
    if (!canonical.equals(bytes)) throw unavailable();
    return manifest;
  } catch (cause) {
    throw cause instanceof ProjectedModelGatewayAuthorityUnavailableError
      ? cause
      : unavailable(cause);
  } finally {
    bytes?.fill(0);
    canonical?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

/** Loads one immutable, content-free provider/policy snapshot at activation. */
export async function loadProjectedModelGatewayProviderAuthority(
  options: ProjectedModelGatewayAuthorityOptions,
): Promise<ModelGatewayProviderAuthority> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).sort().join('\0') !== 'configFile\0credentials' ||
    typeof options.credentials?.authorizationHeader !== 'function'
  ) {
    throw unavailable();
  }
  const manifest = await readManifest(configFile(options.configFile));
  const policies = new Map(
    manifest.projects.map(({ projectId, policy }) => [projectId, policy]),
  );
  return Object.freeze({
    providers: Object.freeze(
      manifest.providers.map(
        (provider) =>
          new OpenAiCompatibleProvider({
            ...provider,
            credentials: options.credentials,
          }),
      ),
    ),
    policies: Object.freeze({
      async resolve(
        context: Readonly<ModelInvocationContext>,
      ): Promise<Readonly<ModelInvocationPolicy>> {
        const policy = policies.get(context.projectId);
        if (!policy) throw unavailable();
        return policy;
      },
    }),
  });
}
