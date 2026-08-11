export const DEPLOYMENT_PROFILES = [
  'edge',
  'standalone',
  'cluster-control',
  'worker',
] as const;

export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number];

export interface BoundedRecoveryResourcePolicy {
  intervalMs: number;
  initialDelayMs: number;
  stopTimeoutMs: number;
  pageSize: number;
  maxPages: number;
}

export interface LocalArtifactRetentionResourcePolicy {
  intervalMs: number;
  initialDelayMs: number;
  stopTimeoutMs: number;
  pageSize: number;
  maximumDeletions: number;
  normalRetentionMs: number;
  pressureRetentionMs: number;
}

export interface ApprovedActionResourcePolicy {
  intervalMs: number;
  initialDelayMs: number;
  stopTimeoutMs: number;
  dispatch: {
    pageSize: number;
    maxPages: number;
  };
  recovery: {
    pageSize: number;
    maxPages: number;
  };
}

export interface LocalPrimaryResourcePolicy {
  profile: 'edge' | 'standalone';
  receiptPublishGraceMs: number;
  receiptTerminalMissingRetentionMs: number;
  receiptQuarantineRetentionMs: number;
  completion: BoundedRecoveryResourcePolicy;
  cancellation: BoundedRecoveryResourcePolicy;
  timeout: BoundedRecoveryResourcePolicy;
  retry: BoundedRecoveryResourcePolicy;
  approvedAction: ApprovedActionResourcePolicy;
  artifactRetention: LocalArtifactRetentionResourcePolicy;
}

const VALID_PROFILES = new Set<DeploymentProfile>(DEPLOYMENT_PROFILES);

const LOCAL_PRIMARY_POLICIES: Record<
  LocalPrimaryResourcePolicy['profile'],
  LocalPrimaryResourcePolicy
> = {
  edge: {
    profile: 'edge',
    receiptPublishGraceMs: 50,
    receiptTerminalMissingRetentionMs: 2 * 60_000,
    receiptQuarantineRetentionMs: 5 * 60_000,
    completion: {
      intervalMs: 30_000,
      initialDelayMs: 0,
      stopTimeoutMs: 5_000,
      pageSize: 8,
      maxPages: 2,
    },
    cancellation: {
      intervalMs: 5_000,
      initialDelayMs: 0,
      stopTimeoutMs: 5_000,
      pageSize: 8,
      maxPages: 2,
    },
    timeout: {
      intervalMs: 30_000,
      initialDelayMs: 0,
      stopTimeoutMs: 5_000,
      pageSize: 8,
      maxPages: 2,
    },
    retry: {
      intervalMs: 30_000,
      initialDelayMs: 0,
      stopTimeoutMs: 5_000,
      pageSize: 8,
      maxPages: 1,
    },
    approvedAction: {
      intervalMs: 30_000,
      initialDelayMs: 0,
      stopTimeoutMs: 5_000,
      dispatch: { pageSize: 8, maxPages: 1 },
      recovery: { pageSize: 8, maxPages: 1 },
    },
    artifactRetention: {
      intervalMs: 5 * 60_000,
      initialDelayMs: 0,
      stopTimeoutMs: 5_000,
      pageSize: 8,
      maximumDeletions: 4,
      normalRetentionMs: 7 * 24 * 60 * 60_000,
      pressureRetentionMs: 24 * 60 * 60_000,
    },
  },
  standalone: {
    profile: 'standalone',
    receiptPublishGraceMs: 100,
    receiptTerminalMissingRetentionMs: 60_000,
    receiptQuarantineRetentionMs: 60 * 60_000,
    completion: {
      intervalMs: 2_000,
      initialDelayMs: 0,
      stopTimeoutMs: 5_000,
      pageSize: 32,
      maxPages: 4,
    },
    cancellation: {
      intervalMs: 1_000,
      initialDelayMs: 0,
      stopTimeoutMs: 5_000,
      pageSize: 32,
      maxPages: 4,
    },
    timeout: {
      intervalMs: 5_000,
      initialDelayMs: 0,
      stopTimeoutMs: 5_000,
      pageSize: 32,
      maxPages: 4,
    },
    retry: {
      intervalMs: 5_000,
      initialDelayMs: 0,
      stopTimeoutMs: 5_000,
      pageSize: 32,
      maxPages: 1,
    },
    approvedAction: {
      intervalMs: 2_000,
      initialDelayMs: 0,
      stopTimeoutMs: 5_000,
      dispatch: { pageSize: 32, maxPages: 4 },
      recovery: { pageSize: 16, maxPages: 2 },
    },
    artifactRetention: {
      intervalMs: 60_000,
      initialDelayMs: 0,
      stopTimeoutMs: 5_000,
      pageSize: 32,
      maximumDeletions: 16,
      normalRetentionMs: 30 * 24 * 60 * 60_000,
      pressureRetentionMs: 7 * 24 * 60 * 60_000,
    },
  },
};

export function parseDeploymentProfile(
  value: string | undefined,
): DeploymentProfile {
  if (value === undefined || value === '') return 'standalone';
  if (
    value.trim() !== value ||
    !VALID_PROFILES.has(value as DeploymentProfile)
  ) {
    throw new TypeError('QL_DEPLOYMENT_PROFILE is invalid');
  }
  return value as DeploymentProfile;
}

function cloneRecoveryPolicy(
  policy: BoundedRecoveryResourcePolicy,
): BoundedRecoveryResourcePolicy {
  return { ...policy };
}

function cloneArtifactRetentionPolicy(
  policy: LocalArtifactRetentionResourcePolicy,
): LocalArtifactRetentionResourcePolicy {
  return { ...policy };
}

function cloneApprovedActionPolicy(
  policy: ApprovedActionResourcePolicy,
): ApprovedActionResourcePolicy {
  return {
    ...policy,
    dispatch: { ...policy.dispatch },
    recovery: { ...policy.recovery },
  };
}

/**
 * The incubating SQLite + LocalProcess Primary stack is intentionally local.
 * Cluster control needs PostgreSQL/shared artifacts; worker has a separate boot
 * topology. Refusing those profiles prevents accidental shared-SQLite clusters.
 */
export function localPrimaryResourcePolicy(
  profile: DeploymentProfile,
): LocalPrimaryResourcePolicy {
  if (profile !== 'edge' && profile !== 'standalone') {
    throw new TypeError(
      `Deployment profile ${profile} cannot host the local SQLite Primary stack`,
    );
  }
  const policy = LOCAL_PRIMARY_POLICIES[profile];
  return {
    profile,
    receiptPublishGraceMs: policy.receiptPublishGraceMs,
    receiptTerminalMissingRetentionMs: policy.receiptTerminalMissingRetentionMs,
    receiptQuarantineRetentionMs: policy.receiptQuarantineRetentionMs,
    completion: cloneRecoveryPolicy(policy.completion),
    cancellation: cloneRecoveryPolicy(policy.cancellation),
    timeout: cloneRecoveryPolicy(policy.timeout),
    retry: cloneRecoveryPolicy(policy.retry),
    approvedAction: cloneApprovedActionPolicy(policy.approvedAction),
    artifactRetention: cloneArtifactRetentionPolicy(policy.artifactRetention),
  };
}
