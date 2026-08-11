export type WorkerExecutionOfferJournalOwnershipState =
  | 'unowned'
  | 'owned'
  | 'releasing'
  | 'compromised';

export interface WorkerExecutionOfferJournalOwnership {
  ownershipState(): WorkerExecutionOfferJournalOwnershipState;
  acquireOwnership(): Promise<'acquired' | 'already_owned'>;
  releaseOwnership(): Promise<'released' | 'not_owned' | 'compromised'>;
}
