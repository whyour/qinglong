import { assertLocalModelInvocationFeatureReady } from '@qinglong/ai/model-invocation-migration';
import { PluginPackagePromptOutputFileKeyring } from '@qinglong/ai/plugin-package-prompt-output-file-keyring';
import { PluginPackagePromptOutputKeyRetirementCoordinator } from '@qinglong/ai/plugin-package-prompt-output-key-retirement';
import { LocalPluginPackagePromptOutputKeyRetirementRepository } from '@qinglong/ai/local-plugin-package-prompt-output-key-retirement-storage';
import {
  openLocalSqliteOptionalFeatureRuntimeDatabase,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '@qinglong/local-sqlite/optional-feature-runtime';

export interface OpenLocalOwnerPromptOutputKeyRetirementOptions
  extends LocalSqliteDatabaseOptions {
  readonly keyringPath: string;
}

export interface RetireLocalOwnerPromptOutputKeyRequest {
  readonly keyId: string;
  readonly retirementId: string;
  readonly requestId: string;
  readonly mutationId: string;
}

export interface LocalOwnerPromptOutputKeyRetirementAuthority {
  readonly profile: LocalSqliteProfile;
  retire(request: RetireLocalOwnerPromptOutputKeyRequest): Promise<Readonly<{
    status: 'completed' | 'existing';
    keyId: string;
    retirementId: string;
    preparationDigest: string;
    completionDigest: string;
    completedAtMs: number;
  }>>;
  close(): Promise<void>;
}

export async function openLocalOwnerPromptOutputKeyRetirement(
  options: OpenLocalOwnerPromptOutputKeyRetirementOptions,
): Promise<LocalOwnerPromptOutputKeyRetirementAuthority> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.keyringPath !== 'string'
  ) {
    throw new TypeError('Local Prompt output key retirement options are invalid');
  }
  const database = await openLocalSqliteOptionalFeatureRuntimeDatabase({
    databasePath: options.databasePath,
    profile: options.profile,
    ...(options.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: options.busyTimeoutMs }),
  });
  try {
    assertLocalModelInvocationFeatureReady(database.authority.client);
    const keys = new PluginPackagePromptOutputFileKeyring(options.keyringPath);
    const repository =
      new LocalPluginPackagePromptOutputKeyRetirementRepository({
        authority: database.authority,
      });
    const coordinator = new PluginPackagePromptOutputKeyRetirementCoordinator({
      repository,
      materials: keys,
    });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: database.profile,
      async retire(request: RetireLocalOwnerPromptOutputKeyRequest) {
        const result = await coordinator.retire(request);
        return Object.freeze({
          status: result.status,
          keyId: result.preparation.keyId,
          retirementId: result.preparation.retirementId,
          preparationDigest: result.preparation.preparationDigest,
          completionDigest: result.completion.completionDigest,
          completedAtMs: result.completion.completedAtMs,
        });
      },
      close() {
        closePromise ??= database.close();
        return closePromise;
      },
    });
  } catch (cause) {
    await database.close();
    throw cause;
  }
}
