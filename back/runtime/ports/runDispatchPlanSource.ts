import type { RunDispatchCandidate } from '../domain/runDispatchCandidate';
import type { RunDispatchPlan } from '../domain/runDispatchOffer';

/**
 * Prepares one bounded plan in trusted control-plane memory. The Dispatcher must
 * not expose it as an execution offer until the corresponding lease is claimed.
 */
export interface RunDispatchPlanSource {
  prepare(candidate: RunDispatchCandidate): Promise<RunDispatchPlan | null>;
}
