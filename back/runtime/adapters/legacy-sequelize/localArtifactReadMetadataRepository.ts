import { QueryTypes, Sequelize } from 'sequelize';
import {
  RUN_ATTEMPT_TABLE,
  RUN_TABLE,
} from '../../../migrations/0002-run-schema';
import { LOCAL_ARTIFACT_RETENTION_TABLE } from '../../../migrations/0015-local-artifact-retention';
import {
  normalizeLocalArtifactReadMetadata,
  type LocalArtifactReadMetadata,
} from '../../domain/artifactRead';
import type { LocalArtifactReadMetadataRepository } from '../../ports/localArtifactReadMetadataRepository';

interface ArtifactMetadataRow {
  project_id: string;
  run_id: string;
  attempt_id: string;
  attempt_finished_at_ms: number | string | null;
  log_artifact_id: string;
  retention_log_artifact_id: string | null;
  retention_disposition: string | null;
  retention_finished_at_ms: number | string | null;
  retention_eligible_at_ms: number | string | null;
  retention_bytes_reclaimed: number | string | null;
  retention_recorded_at_ms: number | string | null;
}

export class CorruptLocalArtifactReadMetadataError extends Error {
  constructor() {
    super('Local Artifact read metadata is corrupt or ambiguous');
    this.name = 'CorruptLocalArtifactReadMetadataError';
  }
}

function rowToMetadata(
  row: ArtifactMetadataRow,
): Readonly<LocalArtifactReadMetadata> {
  const retentionValues = [
    row.retention_log_artifact_id,
    row.retention_disposition,
    row.retention_finished_at_ms,
    row.retention_eligible_at_ms,
    row.retention_bytes_reclaimed,
    row.retention_recorded_at_ms,
  ];
  const hasRetention = retentionValues.every((value) => value !== null);
  if (!hasRetention && retentionValues.some((value) => value !== null)) {
    throw new CorruptLocalArtifactReadMetadataError();
  }
  if (hasRetention && row.retention_log_artifact_id !== row.log_artifact_id) {
    throw new CorruptLocalArtifactReadMetadataError();
  }
  if (
    hasRetention &&
    (row.attempt_finished_at_ms === null ||
      Number(row.retention_finished_at_ms) !==
        Number(row.attempt_finished_at_ms))
  ) {
    throw new CorruptLocalArtifactReadMetadataError();
  }
  try {
    return normalizeLocalArtifactReadMetadata({
      projectId: row.project_id,
      runId: row.run_id,
      attemptId: row.attempt_id,
      logArtifactId: row.log_artifact_id,
      ...(hasRetention
        ? {
            retention: {
              disposition: row.retention_disposition as NonNullable<
                LocalArtifactReadMetadata['retention']
              >['disposition'],
              finishedAtMs: Number(row.retention_finished_at_ms),
              eligibleAtMs: Number(row.retention_eligible_at_ms),
              bytesReclaimed: Number(row.retention_bytes_reclaimed),
              recordedAtMs: Number(row.retention_recorded_at_ms),
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof CorruptLocalArtifactReadMetadataError) throw error;
    throw new CorruptLocalArtifactReadMetadataError();
  }
}

export class LegacySequelizeLocalArtifactReadMetadataRepository
  implements LocalArtifactReadMetadataRepository
{
  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Local Artifact read metadata repository is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
  }

  async find({
    projectId,
    runId,
    logArtifactId,
  }: Parameters<
    LocalArtifactReadMetadataRepository['find']
  >[0]): Promise<Readonly<LocalArtifactReadMetadata> | null> {
    const rows = await this.database.query<ArtifactMetadataRow>(
      `SELECT run.project_id,
              run.id AS run_id,
              attempt.id AS attempt_id,
              attempt.finished_at_ms AS attempt_finished_at_ms,
              attempt.log_artifact_id,
              retained.log_artifact_id AS retention_log_artifact_id,
              retained.disposition AS retention_disposition,
              retained.finished_at_ms AS retention_finished_at_ms,
              retained.eligible_at_ms AS retention_eligible_at_ms,
              retained.bytes_reclaimed AS retention_bytes_reclaimed,
              retained.recorded_at_ms AS retention_recorded_at_ms
         FROM "${RUN_TABLE}" AS run
         JOIN "${RUN_ATTEMPT_TABLE}" AS attempt ON attempt.run_id = run.id
    LEFT JOIN "${LOCAL_ARTIFACT_RETENTION_TABLE}" AS retained
           ON retained.attempt_id = attempt.id
        WHERE run.project_id = :projectId
          AND run.id = :runId
          AND run.execution_owner = 'runtime'
          AND attempt.executor_type = 'local_process'
          AND attempt.log_artifact_id = :logArtifactId
          AND attempt.log_artifact_id LIKE 'local-%'
        LIMIT 2`,
      {
        type: QueryTypes.SELECT,
        replacements: { projectId, runId, logArtifactId },
      },
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new CorruptLocalArtifactReadMetadataError();
    return rowToMetadata(rows[0]);
  }
}
