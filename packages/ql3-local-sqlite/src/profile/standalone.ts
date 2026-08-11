import {
  bootstrapLocalProfileStorage,
  type LocalProfileStorageBootstrapOptions,
  type LocalProfileStorageBootstrapResult,
} from './localProfile';

export type StandaloneStorageBootstrapOptions = Omit<
  LocalProfileStorageBootstrapOptions,
  'profile'
>;

export function bootstrapStandaloneStorage(
  options: StandaloneStorageBootstrapOptions,
): Promise<LocalProfileStorageBootstrapResult> {
  return bootstrapLocalProfileStorage({ ...options, profile: 'standalone' });
}

export type {
  LocalProfileStorageAudit,
  LocalProfileStorageBootstrapResult,
  LocalProfileStorageState,
} from './localProfile';
