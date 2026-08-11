import type { ExecutionOrigin } from '../domain/run';
import type { RunRetryPolicyDefinition } from '../domain/runRetryPolicy';

export interface RunRetryPolicyAdmissionRequest {
  projectId: string;
  taskId: string;
  taskRevision: string;
  triggerType: string;
  executionOrigin: ExecutionOrigin;
}

/**
 * Trusted server-side admission. Implementations must resolve policy from the
 * pinned Task revision or another administrator-controlled immutable source;
 * an individual Run request is never allowed to self-assert retry safety.
 * `deduplicated` is valid only when that revision binds an enforced business
 * deduplication contract, not merely a descriptive user flag.
 */
export interface RunRetryPolicyAdmission {
  resolve(
    request: Readonly<RunRetryPolicyAdmissionRequest>,
  ): Promise<RunRetryPolicyDefinition | undefined>;
}
