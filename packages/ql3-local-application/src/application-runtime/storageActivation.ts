import {
  bootstrapLocalAdoptedProfileStorage,
  type LocalAdoptedProfileBootstrapResult,
} from '@qinglong/local-admin/adopted-profile';
import {
  bootstrapLocalProfileStorage,
  type LocalProfileStorageBootstrapResult,
} from '@qinglong/local-sqlite/profile';
import type { LocalApplicationEnabledBootstrapOptions } from './contract';

export type LocalApplicationReadyStorage =
  | Extract<
      LocalAdoptedProfileBootstrapResult,
      { status: 'adopted_storage_ready' }
    >
  | Extract<LocalProfileStorageBootstrapResult, { status: 'storage_ready' }>;

export async function openLocalApplicationStorage(
  options: LocalApplicationEnabledBootstrapOptions,
): Promise<LocalApplicationReadyStorage> {
  const opened =
    options.storageMode === 'fresh'
      ? await bootstrapLocalProfileStorage({
          enabled: true,
          profile: options.profile,
          databasePath: options.databasePath,
          ...(options.busyTimeoutMs === undefined
            ? {}
            : { busyTimeoutMs: options.busyTimeoutMs }),
          audit: options.audit,
        })
      : await bootstrapLocalAdoptedProfileStorage({
          enabled: true,
          profile: options.profile,
          sourcePath: options.sourcePath,
          targetPath: options.targetPath,
          recoveryPath: options.recoveryPath,
          manifestPath: options.manifestPath,
          activationPath: options.activationPath,
          expectedActivationDigest: options.expectedActivationDigest,
          ...(options.busyTimeoutMs === undefined
            ? {}
            : { busyTimeoutMs: options.busyTimeoutMs }),
          audit: options.audit,
          adoptionAudit: options.adoptionAudit,
        });
  if (
    opened.status !== 'adopted_storage_ready' &&
    opened.status !== 'storage_ready'
  ) {
    throw new Error('Enabled local application storage did not become ready');
  }
  return opened;
}
