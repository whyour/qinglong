import type { RuntimeRolloutPolicy } from '../domain/runtimeRollout';
import type { RuntimeRolloutManifest } from '../domain/runtimeRolloutManifest';
import type { LegacyShadowPrimaryGateReceipt } from '../domain/legacyShadowPrimaryGate';

export type RuntimeRolloutLoadStatus =
  | 'missing'
  | 'disabled'
  | 'accepted'
  | 'rejected';

export interface RuntimeRolloutLoadAudit {
  event: 'runtime.rollout_config_evaluated';
  evaluatedAtMs: number;
  sourcePath: string;
  status: RuntimeRolloutLoadStatus;
  sourceSha256?: string;
  revision?: string;
  reasonCode?:
    | 'FILE_MISSING'
    | 'FILE_READ_FAILED'
    | 'FILE_TOO_LARGE'
    | 'INVALID_JSON'
    | 'INVALID_MANIFEST'
    | 'PRIMARY_GATE_READ_FAILED'
    | 'PRIMARY_GATE_INVALID';
}

export interface RuntimeRolloutLoadResult {
  status: RuntimeRolloutLoadStatus;
  policy: RuntimeRolloutPolicy;
  audit: RuntimeRolloutLoadAudit;
  manifest?: RuntimeRolloutManifest;
  primaryGateReceipt?: LegacyShadowPrimaryGateReceipt;
}

export interface RuntimeRolloutLoader {
  load(): Promise<RuntimeRolloutLoadResult>;
}
