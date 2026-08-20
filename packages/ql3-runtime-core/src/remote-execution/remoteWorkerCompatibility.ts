import { semver } from '../versioning/pinnedSemver';

export const REMOTE_WORKER_PROTOCOL_VERSION = '1.0.0';
export const REMOTE_WORKER_PROTOCOL_RANGE = '>=1.0.0 <2.0.0';

export const REMOTE_WORKER_SUPPORT_TIERS = [
  'tier1',
  'candidate',
  'experimental',
  'legacy-only',
] as const;

export type RemoteWorkerSupportTier =
  (typeof REMOTE_WORKER_SUPPORT_TIERS)[number];

export const REMOTE_WORKER_ARCHITECTURES_BY_SUPPORT_TIER = Object.freeze({
  tier1: Object.freeze(['amd64', 'arm64'] as const),
  candidate: Object.freeze(['ppc64le', 's390x'] as const),
  experimental: Object.freeze(['arm/v7'] as const),
  'legacy-only': Object.freeze(['arm/v6', '386'] as const),
});

export type RemoteWorkerArchitecture =
  (typeof REMOTE_WORKER_ARCHITECTURES_BY_SUPPORT_TIER)[RemoteWorkerSupportTier][number];

const REMOTE_WORKER_ARCHITECTURES = Object.freeze(
  Object.values(REMOTE_WORKER_ARCHITECTURES_BY_SUPPORT_TIER).flat(),
);

function invalid(message: string): never {
  throw new TypeError(
    `Remote Worker compatibility value is invalid: ${message}`,
  );
}

export function normalizeRemoteWorkerProtocolVersion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    semver().valid(value) === null
  ) {
    invalid('protocolVersion is not semver');
  }
  return value;
}

export function normalizeRemoteWorkerArchitecture(
  value: unknown,
): RemoteWorkerArchitecture {
  if (
    typeof value !== 'string' ||
    !REMOTE_WORKER_ARCHITECTURES.includes(value as RemoteWorkerArchitecture)
  ) {
    invalid('architecture is outside the release support policy');
  }
  return value as RemoteWorkerArchitecture;
}

export function remoteWorkerSupportTierForArchitecture(
  value: unknown,
): RemoteWorkerSupportTier {
  const architecture = normalizeRemoteWorkerArchitecture(value);
  for (const supportTier of REMOTE_WORKER_SUPPORT_TIERS) {
    if (
      (
        REMOTE_WORKER_ARCHITECTURES_BY_SUPPORT_TIER[
          supportTier
        ] as readonly string[]
      ).includes(architecture)
    ) {
      return supportTier;
    }
  }
  return invalid('architecture has no supportTier');
}

export function remoteWorkerArchitectureForNodeRuntime(
  nodeArchitecture: string,
  armVersion?: unknown,
): RemoteWorkerArchitecture {
  if (nodeArchitecture === 'x64') return 'amd64';
  if (nodeArchitecture === 'arm64') return 'arm64';
  if (nodeArchitecture === 'ppc64') return 'ppc64le';
  if (nodeArchitecture === 's390x') return 's390x';
  if (nodeArchitecture === 'ia32') return '386';
  if (nodeArchitecture === 'arm' && (armVersion === 6 || armVersion === '6')) {
    return 'arm/v6';
  }
  if (nodeArchitecture === 'arm' && (armVersion === 7 || armVersion === '7')) {
    return 'arm/v7';
  }
  return invalid('Node runtime architecture is unsupported or ambiguous');
}

export function normalizeRemoteWorkerProtocolVersionRange(
  value: unknown,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    semver().validRange(value) === null
  ) {
    invalid('protocolVersionRange is not semver');
  }
  return value;
}

export function normalizeRemoteWorkerSupportTier(
  value: unknown,
): RemoteWorkerSupportTier {
  if (
    typeof value !== 'string' ||
    !REMOTE_WORKER_SUPPORT_TIERS.includes(value as RemoteWorkerSupportTier)
  ) {
    invalid('supportTier is unknown');
  }
  return value as RemoteWorkerSupportTier;
}

export function assertRemoteWorkerCompatibilityCapability(
  value: unknown,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('capabilities must be an object');
  }
  const source = value as Record<string, unknown>;
  const architecture = normalizeRemoteWorkerArchitecture(source.architecture);
  normalizeRemoteWorkerProtocolVersion(source.protocolVersion);
  const supportTier = normalizeRemoteWorkerSupportTier(source.supportTier);
  if (remoteWorkerSupportTierForArchitecture(architecture) !== supportTier) {
    invalid('architecture does not belong to supportTier');
  }
}

export function remoteWorkerProtocolIsCompatible(
  protocolVersion: string,
  requiredRange = REMOTE_WORKER_PROTOCOL_RANGE,
): boolean {
  const version = normalizeRemoteWorkerProtocolVersion(protocolVersion);
  const range = normalizeRemoteWorkerProtocolVersionRange(requiredRange);
  return semver().satisfies(version, range, { includePrerelease: true });
}
