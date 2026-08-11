// Cluster Plugin Package publisher boundary; keep provenance recovery authority explicit.
import {
  assertPluginPackageInstallMatchesLock,
  type PluginPackageInstallCommit,
  type PluginPackageInstallCreate,
  type PluginPackageInstallRecord,
  type PluginPackageInstallRecoveryCursor,
  type PluginPackageInstallRecoveryPage,
  type PluginPackageInstallRepository,
  type PluginPackageLock,
} from '@qinglong/runtime-core/plugin-package-install';
import {
  normalizePluginPackageStageEvidence,
  type PluginPackageStageEvidence,
} from '@qinglong/runtime-core/plugin-package-installation';
import {
  createPluginPackagePublisherProvenance,
  type PluginPackagePublisherProvenance,
} from '@qinglong/runtime-core/plugin-package-publisher-provenance';
import {
  PostgresPluginPackageInstallRepository,
} from '@qinglong/cluster-postgres/plugin-package-install';
import {
  POSTGRES_PLUGIN_PACKAGE_PROVENANCE_RECOVERY_PAGE_LIMIT,
  PostgresPluginPackagePublisherProvenanceRepository,
  type PluginPackagePublisherProvenanceRecoveryCursor,
} from '@qinglong/cluster-postgres/package-executor';

import type { ClusterPluginPackageStageAuthority } from '../recovery/pluginPackageOciStage';

export const MAX_CLUSTER_PLUGIN_PACKAGE_PROVENANCE_RECOVERY_PAGES = 64;

export interface ClusterPluginPackagePublisherProvenanceRecoveryResult {
  readonly pages: number;
  readonly scanned: number;
  readonly created: number;
  readonly existing: number;
  readonly remaining: boolean;
  readonly safeToAdmit: boolean;
}

function stageEvidence(
  record: Readonly<PluginPackageInstallRecord>,
): Readonly<PluginPackageStageEvidence> {
  if (record.stageReceipt === null) {
    throw new TypeError(
      'Plugin Package install lacks durable stage evidence for provenance',
    );
  }
  return normalizePluginPackageStageEvidence({
    stageRef: record.stageReceipt.stageRef,
    artifactDigest: record.stageReceipt.artifactDigest,
    manifestDigest: record.stageReceipt.manifestDigest,
    contentDigest: record.stageReceipt.contentDigest,
    evidenceDigest: record.stageReceipt.evidenceDigest,
  });
}

async function provenanceFor(
  authority: ClusterPluginPackageStageAuthority,
  lock: Readonly<PluginPackageLock>,
  record: Readonly<PluginPackageInstallRecord>,
): Promise<Readonly<PluginPackagePublisherProvenance>> {
  assertPluginPackageInstallMatchesLock(lock, record);
  const stage = stageEvidence(record);
  const signature = await authority.publisherEvidence(lock, stage);
  return createPluginPackagePublisherProvenance({
    projectId: record.projectId,
    packageName: record.packageName,
    installationId: record.installationId,
    lockDigest: record.lockDigest,
    artifactDigest: stage.artifactDigest,
    manifestDigest: stage.manifestDigest,
    contentDigest: stage.contentDigest,
    stageEvidenceDigest: stage.evidenceDigest,
    signature,
  });
}

export class ClusterPluginPackageProvenanceInstallRepository
  implements PluginPackageInstallRepository
{
  constructor(
    private readonly installs: PostgresPluginPackageInstallRepository,
    private readonly provenance: PostgresPluginPackagePublisherProvenanceRepository,
    private readonly authority: ClusterPluginPackageStageAuthority,
    private readonly trustAuthorityId: string,
  ) {
    if (
      !(installs instanceof PostgresPluginPackageInstallRepository) ||
      !(provenance instanceof
        PostgresPluginPackagePublisherProvenanceRepository) ||
      !authority ||
      typeof authority.publisherEvidence !== 'function' ||
      typeof trustAuthorityId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(trustAuthorityId)
    ) {
      throw new TypeError(
        'Cluster Plugin Package provenance install repository is invalid',
      );
    }
  }

  find(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageInstallRecord> | null> {
    return this.installs.find(projectId, packageName);
  }

  findLock(
    lockDigest: string,
  ): Promise<Readonly<PluginPackageLock> | null> {
    return this.installs.findLock(lockDigest);
  }

  create(command: Readonly<PluginPackageInstallCreate>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      record: Readonly<PluginPackageInstallRecord>;
    }>
  > {
    return this.installs.create(command);
  }

  async commit(command: Readonly<PluginPackageInstallCommit>): Promise<
    Readonly<{
      status: 'committed' | 'existing';
      record: Readonly<PluginPackageInstallRecord>;
    }>
  > {
    if (command.record.state !== 'staged') {
      return this.installs.commit(command);
    }
    const lock = await this.installs.findLock(command.record.lockDigest);
    if (!lock) {
      throw new TypeError('Plugin Package stage lock is unavailable');
    }
    return this.provenance.commitStage(
      command,
      await provenanceFor(this.authority, lock, command.record),
      this.trustAuthorityId,
    );
  }

  listRecoveryPage(options: {
    readonly limit: number;
    readonly after?: Readonly<PluginPackageInstallRecoveryCursor>;
  }): Promise<Readonly<PluginPackageInstallRecoveryPage>> {
    return this.installs.listRecoveryPage(options);
  }
}

export async function recoverClusterPluginPackagePublisherProvenance(
  installs: PostgresPluginPackageInstallRepository,
  repository: PostgresPluginPackagePublisherProvenanceRepository,
  authority: ClusterPluginPackageStageAuthority,
  options: Readonly<{
    trustAuthorityId: string;
    pageSize?: number;
    maxPages?: number;
  }>,
): Promise<Readonly<ClusterPluginPackagePublisherProvenanceRecoveryResult>> {
  const pageSize = options.pageSize ?? 16;
  const maxPages = options.maxPages ?? 16;
  if (
    !(installs instanceof PostgresPluginPackageInstallRepository) ||
    !(repository instanceof
      PostgresPluginPackagePublisherProvenanceRepository) ||
    !authority ||
    typeof authority.verify !== 'function' ||
    typeof authority.publisherEvidence !== 'function' ||
    typeof options.trustAuthorityId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
      options.trustAuthorityId,
    ) ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > POSTGRES_PLUGIN_PACKAGE_PROVENANCE_RECOVERY_PAGE_LIMIT ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > MAX_CLUSTER_PLUGIN_PACKAGE_PROVENANCE_RECOVERY_PAGES
  ) {
    throw new TypeError(
      'Cluster Plugin Package provenance recovery configuration is invalid',
    );
  }
  let after:
    | Readonly<PluginPackagePublisherProvenanceRecoveryCursor>
    | undefined;
  const counts = {
    pages: 0,
    scanned: 0,
    created: 0,
    existing: 0,
  };
  let exhausted = false;
  while (counts.pages < maxPages) {
    const page = await repository.listMissingPage({
      limit: pageSize,
      ...(after ? { after } : {}),
    });
    counts.pages += 1;
    for (const record of page.records) {
      const lock = await installs.findLock(record.lockDigest);
      if (!lock || record.stageReceipt === null) {
        throw new TypeError(
          'Cluster Plugin Package provenance recovery source is incomplete',
        );
      }
      assertPluginPackageInstallMatchesLock(lock, record);
      await authority.verify(lock, record.stageReceipt);
      const result = await repository.recordExisting(
        record,
        await provenanceFor(authority, lock, record),
        options.trustAuthorityId,
      );
      counts.scanned += 1;
      counts[result.status] += 1;
    }
    if (!page.truncated) {
      exhausted = true;
      break;
    }
    after = page.next;
  }
  const probe = await repository.listMissingPage({ limit: 1 });
  const remaining = !exhausted || probe.records.length > 0;
  return Object.freeze({
    ...counts,
    remaining,
    safeToAdmit: !remaining,
  });
}
