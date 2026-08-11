import type {
  localSqliteMigrationManifest,
  LocalSqliteProfile,
  LocalSqliteReadinessEvidence,
} from '@qinglong/local-sqlite/runtime';
import type {
  LegacyCrontabAdoptionDiagnosticPage,
  LegacyCrontabAdoptionInventory,
} from '../legacyCrontabAdoption';
import type {
  CreateLegacyCrontabAdoptionDecisionReceiptContext,
  LegacyCrontabAdoptionDecision,
  LegacyCrontabAdoptionDecisionReceipt,
} from '../legacyCrontabDecisionReceipt';
import type {
  PublishLegacyCrontabDecisionAuthorizationFileOptions,
  VerifyLegacyCrontabDecisionAuthorizationFileOptions,
} from '../legacyCrontabDecisionAuthorizationFile';

export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_SCHEMA_OBJECTS = 4096;

export interface FileIdentity {
  readonly fileName: string;
  readonly pathDigest: string;
  readonly bytes: number;
  readonly device: string;
  readonly inode: string;
  readonly modifiedAtNs: string;
}

export interface LegacySqliteCatalogEvidence {
  readonly digest: string;
  readonly objectCount: number;
  readonly tableNames: readonly string[];
}

export interface LegacySqliteAdoptionPlan {
  readonly schemaVersion: 2;
  readonly kind: 'qinglong3-local-sqlite-adoption-plan';
  readonly profile: LocalSqliteProfile;
  readonly source: FileIdentity;
  readonly catalog: LegacySqliteCatalogEvidence;
  readonly tasks: LegacyCrontabAdoptionInventory;
  readonly planDigest: string;
}

export interface LocalSqliteAdoptionManifestPayload {
  readonly schemaVersion: 2;
  readonly kind: 'qinglong3-local-sqlite-adoption';
  readonly state: 'staged';
  readonly profile: LocalSqliteProfile;
  readonly createdAtMs: number;
  readonly planDigest: string;
  readonly source: FileIdentity;
  readonly catalog: LegacySqliteCatalogEvidence;
  readonly tasks: LegacyCrontabAdoptionInventory;
  readonly recovery: {
    readonly fileName: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly target: {
    readonly fileName: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly migration: typeof localSqliteMigrationManifest;
  readonly readiness: LocalSqliteReadinessEvidence;
}

export interface LocalSqliteAdoptionManifest
  extends LocalSqliteAdoptionManifestPayload {
  readonly manifestDigest: string;
}

export interface InspectLegacySqliteOptions {
  readonly sourcePath: string;
  readonly profile: LocalSqliteProfile;
  readonly legacyTimezone?: string;
}

export interface InspectLegacyCrontabDiagnosticsOptions
  extends InspectLegacySqliteOptions {
  readonly expectedPlanDigest: string;
  readonly afterRowOrdinal?: number;
  readonly limit?: number;
}

export interface ReviewedLegacyCrontabAdoptionDiagnosticPage
  extends LegacyCrontabAdoptionDiagnosticPage {
  readonly reviewedPlanDigest: string;
}

export interface CreateReviewedLegacyCrontabAdoptionDecisionReceiptOptions
  extends InspectLegacySqliteOptions {
  readonly expectedPlanDigest: string;
  readonly decisionId: string;
  readonly reviewer: CreateLegacyCrontabAdoptionDecisionReceiptContext['reviewer'];
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly decisions: Iterable<LegacyCrontabAdoptionDecision>;
}

export interface VerifyReviewedLegacyCrontabAdoptionDecisionReceiptOptions
  extends InspectLegacySqliteOptions {
  readonly expectedPlanDigest: string;
  readonly receipt: unknown;
  readonly decisions: Iterable<LegacyCrontabAdoptionDecision>;
  readonly observedAtMs: number;
}

export interface PublishReviewedLegacyCrontabAdoptionDecisionAuthorizationFileOptions
  extends CreateReviewedLegacyCrontabAdoptionDecisionReceiptOptions {
  readonly authorizationPath: string;
  readonly keyProvider: PublishLegacyCrontabDecisionAuthorizationFileOptions['keyProvider'];
  readonly confirmExternalAuthority?: () => void | Promise<void>;
}

export interface IssueReviewedLegacyCrontabAdoptionDecisionAuthorizationFileOptions
  extends InspectLegacySqliteOptions {
  readonly expectedPlanDigest: string;
  readonly decisionId: string;
  readonly authorizationPath: string;
  readonly issuerKeyringPath: string;
  readonly decisions: Iterable<LegacyCrontabAdoptionDecision>;
  readonly authenticateReviewer: () =>
    | CreateLegacyCrontabAdoptionDecisionReceiptContext['reviewer']
    | Promise<CreateLegacyCrontabAdoptionDecisionReceiptContext['reviewer']>;
  readonly confirmIssuerAuthority: () => void | Promise<void>;
  readonly confirmDecisionStreamAuthority?: () => void | Promise<void>;
  readonly lifetimeMs?: number;
  readonly clock?: () => number;
}

export interface VerifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFileOptions
  extends InspectLegacySqliteOptions {
  readonly expectedPlanDigest: string;
  readonly expectedDecisionId: string;
  readonly authorizationPath: string;
  readonly keyProvider: VerifyLegacyCrontabDecisionAuthorizationFileOptions['keyProvider'];
  readonly observedAtMs: number;
}

export interface CommitReviewedLegacyCrontabAdoptionOptions
  extends VerifyReviewedLegacyCrontabAdoptionDecisionAuthorizationFileOptions {
  readonly targetPath: string;
  readonly projectId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly busyTimeoutMs?: number;
  readonly confirmReviewerAuthority?: (
    reviewer: CreateLegacyCrontabAdoptionDecisionReceiptContext['reviewer'],
  ) => void | Promise<void>;
}

export interface StageLocalSqliteAdoptionOptions
  extends InspectLegacySqliteOptions {
  readonly targetPath: string;
  readonly recoveryPath: string;
  readonly manifestPath: string;
  readonly expectedPlanDigest: string;
  readonly clock?: () => number;
}

export interface VerifyLocalSqliteAdoptionOptions {
  readonly targetPath: string;
  readonly recoveryPath: string;
  readonly manifestPath: string;
}

export interface LocalSqliteActivationPayload {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-local-sqlite-activation';
  readonly state: 'prepared';
  readonly profile: LocalSqliteProfile;
  readonly createdAtMs: number;
  readonly adoptionManifestDigest: string;
  readonly planDigest: string;
  readonly sourcePathDigest: string;
  readonly recoverySha256: string;
  readonly targetSha256: string;
  readonly targetPathDigest: string;
  readonly targetDevice: string;
  readonly targetInode: string;
}

export interface LocalSqliteActivation extends LocalSqliteActivationPayload {
  readonly activationDigest: string;
}

export interface PrepareLocalSqliteActivationOptions
  extends VerifyLocalSqliteAdoptionOptions {
  readonly sourcePath: string;
  readonly activationPath: string;
  readonly expectedManifestDigest: string;
  readonly clock?: () => number;
}

export interface AcquireLocalSqliteActivationOptions
  extends VerifyLocalSqliteAdoptionOptions {
  readonly sourcePath: string;
  readonly activationPath: string;
  readonly expectedActivationDigest: string;
  readonly busyTimeoutMs?: number;
}

export interface LocalSqliteActivationFence {
  readonly activation: LocalSqliteActivation;
  readonly adoption: LocalSqliteAdoptionManifest;
  readonly state: 'fenced';
  assertTargetIdentity(): void;
  release(): Promise<'released'>;
}

export interface VerifiedLocalSqliteAdoption {
  readonly manifest: LocalSqliteAdoptionManifest;
  readonly targetIdentity: FileIdentity;
}

export class LocalSqliteAdoptionError extends Error {
  readonly code = 'LOCAL_SQLITE_ADOPTION_FAILED';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local SQLite adoption failed: ${message}`);
    this.name = 'LocalSqliteAdoptionError';
  }
}
