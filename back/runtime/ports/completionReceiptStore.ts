import type { CompletionReceipt } from '../domain/completionReceipt';

export interface CompletionReceiptStore {
  publish(receipt: CompletionReceipt): Promise<void>;
  read(attemptId: string): Promise<CompletionReceipt | undefined>;
  remove(attemptId: string): Promise<boolean>;
  quarantineReference(attemptId: string): string;
  /** Moves an untrusted receipt out of the replay path for later inspection. */
  quarantine(attemptId: string): Promise<string | undefined>;
  purgeQuarantine(attemptId: string): Promise<boolean>;
}
