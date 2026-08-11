import type { WorkerExecutionOfferJournalRecord } from '../domain/workerExecutionOffer';

export type WorkerExecutionOfferJournalCreateResult = 'created' | 'exists';

export interface WorkerExecutionOfferJournalPage {
  records: readonly WorkerExecutionOfferJournalRecord[];
  nextAfterOfferId?: string;
}

export interface WorkerExecutionOfferJournal {
  create(
    record: WorkerExecutionOfferJournalRecord,
  ): Promise<WorkerExecutionOfferJournalCreateResult>;
  read(offerId: string): Promise<WorkerExecutionOfferJournalRecord | undefined>;
  replace(
    record: WorkerExecutionOfferJournalRecord,
    expectedRevision: number,
  ): Promise<void>;
  remove(offerId: string, expectedRevision?: number): Promise<boolean>;
  list(options?: {
    afterOfferId?: string;
    limit?: number;
  }): Promise<WorkerExecutionOfferJournalPage>;
}
