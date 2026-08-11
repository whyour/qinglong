import type {
  ApprovedActionRecoveryFinding,
  ApprovedActionRecoverySnapshot,
} from '../domain/approvedActionRecovery';

export type ApprovedActionRecoveryCapability = 'automatic' | 'manual_only';

export type ApprovedActionRecoveryEvidence =
  | {
      finding: 'verified_succeeded' | 'verified_failed';
      resultCode: string;
      evidenceDigest: string;
    }
  | {
      finding: Exclude<
        ApprovedActionRecoveryFinding,
        'verified_succeeded' | 'verified_failed'
      >;
      resultCode: string;
      evidenceDigest?: string;
    };

export interface ApprovedActionRecoveryEvidenceContext {
  snapshot: Readonly<ApprovedActionRecoverySnapshot>;
  idempotencyKey: string;
  observedAtMs: number;
}

export interface ApprovedActionRecoveryEvidenceProvider {
  readonly actionType: string;
  readonly capability: ApprovedActionRecoveryCapability;

  /** Must only observe evidence; it must not repeat the approved side effect. */
  inspect(
    context: Readonly<ApprovedActionRecoveryEvidenceContext>,
  ): Promise<ApprovedActionRecoveryEvidence>;
}
