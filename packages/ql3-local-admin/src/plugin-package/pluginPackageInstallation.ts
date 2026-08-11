import {
  PluginPackageInstallationCoordinator,
  type PluginPackageStageProvider,
} from '@qinglong/runtime-core/plugin-package-installation';
import type { PluginPackageAdmissionRepository } from '@qinglong/runtime-core/plugin-package-admission';
import type { PluginPackageActivationPublisher } from '@qinglong/runtime-core/plugin-package-activation';
import {
  normalizePluginPackageLock,
  type PluginPackageLock,
} from '@qinglong/runtime-core/plugin-package-install';
import type { PluginPackageManifest } from '@qinglong/runtime-core/plugin-package';
import type {
  PluginPackagePublisherTrustRegistry,
  PluginPackageSignature,
} from '@qinglong/runtime-core/plugin-package-bundle';

import {
  stagePluginPackageFromFile,
  type StagePluginPackageFromFileOptions,
} from './pluginPackageStaging';

export type LocalPluginPackageFileStageProviderOptions = Omit<
  StagePluginPackageFromFileOptions,
  'lock'
>;

export function createLocalPluginPackageFileStageProvider(
  options: LocalPluginPackageFileStageProviderOptions,
): PluginPackageStageProvider {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length !== 6
  ) {
    throw new TypeError('Plugin Package file stage provider is invalid');
  }
  const frozen = Object.freeze({
    bundlePath: options.bundlePath,
    stagingRoot: options.stagingRoot,
    manifest: options.manifest as PluginPackageManifest,
    signature: options.signature as PluginPackageSignature,
    trust: options.trust as PluginPackagePublisherTrustRegistry,
    observedAtMs: options.observedAtMs,
  });
  return Object.freeze({
    async stage(lockValue: Readonly<PluginPackageLock>) {
      const lock = normalizePluginPackageLock(lockValue);
      const staged = await stagePluginPackageFromFile({
        ...frozen,
        lock,
      });
      return Object.freeze({
        stageRef: staged.stageRef,
        artifactDigest: staged.inspection.artifactDigest,
        manifestDigest: staged.inspection.manifestDigest,
        contentDigest: staged.inspection.contentDigest,
        evidenceDigest: staged.receiptDigest,
      });
    },
  });
}

export function createLocalPluginPackageInstallationCoordinator(options: {
  readonly repository: PluginPackageAdmissionRepository;
  readonly publisher: PluginPackageActivationPublisher;
}): PluginPackageInstallationCoordinator {
  return new PluginPackageInstallationCoordinator(options);
}
