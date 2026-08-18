import type { RuntimeRolloutLoadAudit } from './runtimeRolloutLoader';

export interface ManualPrimaryRuntimeReceiptLifecycle {
  activated(audit: RuntimeRolloutLoadAudit): Promise<void>;
  stopping(): Promise<void>;
  stopped(): Promise<void>;
  failed(): Promise<void>;
}
