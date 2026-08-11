import type { ApprovedRunCreationPlan } from '../domain/approvedRunAction';

export interface ApprovedRunActionPlanResolver {
  /** Resolves an immutable, versioned plan without performing its side effect. */
  resolve(actionRef: string): Promise<Readonly<ApprovedRunCreationPlan> | null>;
}
