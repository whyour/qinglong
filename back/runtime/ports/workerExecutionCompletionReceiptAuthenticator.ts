import type { CompletionReceipt } from '../domain/completionReceipt';
import type { WorkerExecutionOfferJournalRecord } from '../domain/workerExecutionOffer';

/**
 * Verifies the Worker-local completion capability without exposing it in a
 * recovery result. Implementations may compare a persisted digest, consult a
 * secure local store, or validate a rotated capability.
 */
export interface WorkerExecutionCompletionReceiptAuthenticator {
  authenticate(
    receipt: CompletionReceipt,
    record: WorkerExecutionOfferJournalRecord,
  ): boolean | Promise<boolean>;
}
