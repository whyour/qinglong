import type { CompletionReceipt } from '../../domain/completionReceipt';
import { matchesWorkerExecutionCompletionReceiptAuthentication } from '../../domain/workerExecutionCompletionReceiptAuthentication';
import type { WorkerExecutionOfferJournalRecord } from '../../domain/workerExecutionOffer';
import type { WorkerExecutionCompletionReceiptAuthenticator } from '../../ports/workerExecutionCompletionReceiptAuthenticator';

export class Sha256WorkerExecutionCompletionReceiptAuthenticator
  implements WorkerExecutionCompletionReceiptAuthenticator
{
  authenticate(
    receipt: CompletionReceipt,
    record: WorkerExecutionOfferJournalRecord,
  ): boolean {
    if (
      record.completionReceiptCallbackSequence === undefined ||
      record.completionReceiptTokenDigest === undefined
    ) {
      return false;
    }
    return matchesWorkerExecutionCompletionReceiptAuthentication(receipt, {
      callbackSequence: record.completionReceiptCallbackSequence,
      tokenDigest: record.completionReceiptTokenDigest,
    });
  }
}
