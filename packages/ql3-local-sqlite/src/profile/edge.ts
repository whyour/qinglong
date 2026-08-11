import {
  bootstrapLocalProfileStorage,
  type LocalProfileStorageBootstrapOptions,
  type LocalProfileStorageBootstrapResult,
} from './localProfile';

export type EdgeStorageBootstrapOptions = Omit<
  LocalProfileStorageBootstrapOptions,
  'profile'
>;

export function bootstrapEdgeStorage(
  options: EdgeStorageBootstrapOptions,
): Promise<LocalProfileStorageBootstrapResult> {
  return bootstrapLocalProfileStorage({ ...options, profile: 'edge' });
}

export type {
  LocalProfileStorageAudit,
  LocalProfileStorageBootstrapResult,
  LocalProfileStorageState,
} from './localProfile';
