import { assertLocalModelInvocationFeatureReady } from '@qinglong/ai/model-invocation-migration';
import { LocalPluginPackagePromptOutputGarbageCollector } from '@qinglong/ai/local-plugin-package-prompt-output-retention-storage';
import {
  createPluginPackagePromptOutputRetentionPolicyCatalogResolver,
  type PluginPackagePromptOutputRetentionPolicyCatalog,
} from '@qinglong/ai/plugin-package-prompt-output-retention';
import {
  openLocalSqliteOptionalFeatureRuntimeDatabase,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '@qinglong/local-sqlite/optional-feature-runtime';

export interface OpenLocalOwnerPromptOutputGcOptions
  extends LocalSqliteDatabaseOptions {
  readonly retentionPolicyCatalog: PluginPackagePromptOutputRetentionPolicyCatalog;
  readonly limit?: number;
}

export interface LocalOwnerPromptOutputGcAuthority {
  readonly profile: LocalSqliteProfile;
  collect(): Promise<Readonly<{
    scanned: number;
    tombstoned: number;
    skipped: number;
    hasMore: boolean;
  }>>;
  close(): Promise<void>;
}

export async function openLocalOwnerPromptOutputGc(
  options: OpenLocalOwnerPromptOutputGcOptions,
): Promise<LocalOwnerPromptOutputGcAuthority> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Local Prompt output GC options are invalid');
  }
  const policies =
    createPluginPackagePromptOutputRetentionPolicyCatalogResolver(
      options.retentionPolicyCatalog,
    );
  const database = await openLocalSqliteOptionalFeatureRuntimeDatabase({
    databasePath: options.databasePath,
    profile: options.profile,
    ...(options.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: options.busyTimeoutMs }),
  });
  try {
    assertLocalModelInvocationFeatureReady(database.authority.client);
    const collector = new LocalPluginPackagePromptOutputGarbageCollector({
      authority: database.authority,
      policies,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: database.profile,
      collect() {
        return collector.collect();
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
