import type { PluginPackagePublisherKeyDefinition } from '@qinglong/runtime-core/plugin-package-bundle';

export const LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA =
  'qinglong/plugin-package-publisher-trust@v1' as const;
export const LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SNAPSHOT_SCHEMA =
  'qinglong/local-plugin-package-publisher-trust-snapshot@v1' as const;
export const LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENT_INTENT_SCHEMA =
  'qinglong/local-plugin-package-publisher-trust-retirement-intent@v1' as const;
export const LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENT_RECEIPT_SCHEMA =
  'qinglong/local-plugin-package-publisher-trust-retirement-receipt@v1' as const;
export const LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATION_PROPOSAL_SCHEMA =
  'qinglong/local-plugin-package-publisher-trust-revocation-proposal@v1' as const;
export const LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATION_RECEIPT_SCHEMA =
  'qinglong/local-plugin-package-publisher-trust-revocation-receipt@v1' as const;
export const MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_GENERATIONS = 64;
export const MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_RETIREMENTS = 32;
export const MAX_LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATIONS = 32;

export interface LocalPluginPackagePublisherTrustDocument {
  readonly schema: typeof LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA;
  readonly keys: readonly Readonly<PluginPackagePublisherKeyDefinition>[];
}

export interface PublishLocalPluginPackagePublisherTrustOptions {
  readonly trustRoot: string;
  readonly mode: 'provision' | 'rotate';
  readonly expectedGeneration: number;
  readonly mutationId: string;
  readonly occurredAtMs: number;
  readonly trust: unknown;
  readonly beforePublish?: () => void | Promise<void>;
  readonly afterSnapshotPublished?: () => void | Promise<void>;
}

export interface RetireLocalPluginPackagePublisherKeyOptions {
  readonly trustRoot: string;
  readonly expectedGeneration: number;
  readonly mutationId: string;
  readonly occurredAtMs: number;
  readonly publisher: string;
  readonly keyId: string;
  readonly proveRetirement: () =>
    | Readonly<LocalPluginPackagePublisherKeyRetirementProof>
    | Promise<Readonly<LocalPluginPackagePublisherKeyRetirementProof>>;
  readonly beforePublish?: () => void | Promise<void>;
  readonly afterIntentPublished?: () => void | Promise<void>;
  readonly afterReceiptPublished?: () => void | Promise<void>;
  readonly afterSnapshotPublished?: () => void | Promise<void>;
}

export interface LocalPluginPackagePublisherKeyRetirementProof {
  readonly catalogEntryCount: number;
  readonly bundleCount: number;
  readonly matchingEntryCount: number;
  readonly unresolvedTransactions: number;
}

export interface LocalPluginPackagePublisherKeyRevocationImpact {
  readonly catalogEntryCount: number;
  readonly bundleCount: number;
  readonly matchingEntryCount: number;
  readonly unresolvedTransactions: number;
  readonly impactedLockDigests: readonly string[];
  readonly impactDigest: string;
}

export interface ProposeLocalPluginPackagePublisherKeyRevocationOptions {
  readonly trustRoot: string;
  readonly expectedGeneration: number;
  readonly mutationId: string;
  readonly occurredAtMs: number;
  readonly publisher: string;
  readonly keyId: string;
  readonly proposerSubjectId: string;
  readonly impact: Readonly<LocalPluginPackagePublisherKeyRevocationImpact>;
  readonly beforePublish?: () => void | Promise<void>;
}

export interface LocalPluginPackagePublisherKeyRevocationReceipt {
  readonly schema: typeof LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_REVOCATION_RECEIPT_SCHEMA;
  readonly publisher: string;
  readonly keyId: string;
  readonly expectedGeneration: number;
  readonly mutationId: string;
  readonly proposalDigest: string;
  readonly proposerSubjectId: string;
  readonly confirmerSubjectId: string;
  readonly authorizationMode: 'dual_control' | 'break_glass';
  readonly reasonCode: 'suspected_key_compromise' | 'confirmed_key_compromise';
  readonly confirmedAtMs: number;
  readonly impactDigest: string;
  readonly impactedLockDigests: readonly string[];
  readonly receiptDigest: string;
}

export interface ConfirmLocalPluginPackagePublisherKeyRevocationOptions {
  readonly trustRoot: string;
  readonly expectedGeneration: number;
  readonly mutationId: string;
  readonly confirmedAtMs: number;
  readonly publisher: string;
  readonly keyId: string;
  readonly proposerSubjectId: string;
  readonly confirmerSubjectId: string;
  readonly authorizationMode: 'dual_control' | 'break_glass';
  readonly reasonCode: 'suspected_key_compromise' | 'confirmed_key_compromise';
  readonly expectedImpactDigest: string;
  readonly confirmAuthorization: () => void | Promise<void>;
  readonly beforePublish?: () => void | Promise<void>;
  readonly afterReceiptPublished?: (
    receipt: Readonly<LocalPluginPackagePublisherKeyRevocationReceipt>,
  ) => void | Promise<void>;
  readonly afterSnapshotPublished?: () => void | Promise<void>;
}

export interface ProposedLocalPluginPackagePublisherKeyRevocation {
  readonly status: 'proposed' | 'existing';
  readonly generation: number;
  readonly proposalDigest: string;
  readonly impactDigest: string;
  readonly matchingEntryCount: number;
  readonly runtimeAction: 'stop_required';
}

export interface PublishedLocalPluginPackagePublisherTrust {
  readonly status: 'published' | 'existing' | 'recovered';
  readonly generation: number;
  readonly keyCount: number;
  readonly trustDigest: string;
}

export interface ConfirmedLocalPluginPackagePublisherKeyRevocation
  extends PublishedLocalPluginPackagePublisherTrust {
  readonly authorizationMode: 'dual_control' | 'break_glass';
  readonly quarantinedLockCount: number;
  readonly runtimeAction: 'restart_required';
}

export interface LocalPluginPackagePublisherTrustInspection {
  readonly generation: number;
  readonly keyCount: number;
  readonly activeKeyCount: number;
  readonly snapshotCount: number;
  readonly retirementCount: number;
  readonly pendingRetirementCount: number;
  readonly revocationCount: number;
  readonly pendingRevocationCount: number;
  readonly quarantinedLockCount: number;
  readonly recoveryRequired: boolean;
  readonly pendingGeneration: number | null;
  readonly pendingMutationId: string | null;
  readonly unresolvedTransactions: number;
  readonly trustDigest: string | null;
}

export class LocalPluginPackagePublisherTrustConfigurationError extends TypeError {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local Plugin Package publisher trust is invalid: ${message}`);
    this.name = 'LocalPluginPackagePublisherTrustConfigurationError';
  }
}

export class LocalPluginPackagePublisherTrustConflictError extends Error {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_CONFLICT';

  constructor(message: string) {
    super(
      `Local Plugin Package publisher trust conflicts with current state: ${message}`,
    );
    this.name = 'LocalPluginPackagePublisherTrustConflictError';
  }
}
