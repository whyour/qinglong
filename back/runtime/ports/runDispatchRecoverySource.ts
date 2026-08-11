import type {
  RecoverableRunDispatch,
  RunDispatchRecoveryCursor,
} from '../domain/runDispatchRecovery';

export interface ListRecoverableRunDispatchesOptions {
  observedAtMs: number;
  after?: RunDispatchRecoveryCursor;
  limit?: number;
}

export interface RunDispatchRecoverySource {
  listRecoverable(
    options: ListRecoverableRunDispatchesOptions,
  ): Promise<RecoverableRunDispatch[]>;
}
