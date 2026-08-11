import {
  bootstrapLocalAdoptedProfileStorage,
  type LocalAdoptedProfileBootstrapOptions,
  type LocalAdoptedProfileBootstrapResult,
} from './localAdoptedProfile';

export type StandaloneAdoptedStorageBootstrapOptions = Omit<
  LocalAdoptedProfileBootstrapOptions,
  'profile'
>;

export function bootstrapStandaloneAdoptedStorage(
  options: StandaloneAdoptedStorageBootstrapOptions,
): Promise<LocalAdoptedProfileBootstrapResult> {
  return bootstrapLocalAdoptedProfileStorage({
    ...options,
    profile: 'standalone',
  });
}

export type {
  LocalAdoptedProfileAudit,
  LocalAdoptedProfileBootstrapResult,
  LocalAdoptedProfileState,
} from './localAdoptedProfile';
