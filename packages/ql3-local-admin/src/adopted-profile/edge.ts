import {
  bootstrapLocalAdoptedProfileStorage,
  type LocalAdoptedProfileBootstrapOptions,
  type LocalAdoptedProfileBootstrapResult,
} from './localAdoptedProfile';

export type EdgeAdoptedStorageBootstrapOptions = Omit<
  LocalAdoptedProfileBootstrapOptions,
  'profile'
>;

export function bootstrapEdgeAdoptedStorage(
  options: EdgeAdoptedStorageBootstrapOptions,
): Promise<LocalAdoptedProfileBootstrapResult> {
  return bootstrapLocalAdoptedProfileStorage({ ...options, profile: 'edge' });
}

export type {
  LocalAdoptedProfileAudit,
  LocalAdoptedProfileBootstrapResult,
  LocalAdoptedProfileState,
} from './localAdoptedProfile';
