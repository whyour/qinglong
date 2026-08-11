import type { DatabaseSync } from 'node:sqlite';

import type { LocalModelInvocationOperationAuthority } from '../../model-invocation/localModelInvocationRepository';
import {
  PluginPackagePromptOutputArtifactUnavailableError,
  normalizePluginPackagePromptOutputArtifactReference,
  pluginPackagePromptOutputArtifactReference,
  type PluginPackagePromptOutputArtifact,
  type PluginPackagePromptOutputArtifactReference,
} from '../pluginPackagePromptOutputArtifact';
import { readLocalPluginPackagePromptOutputArtifactInTransaction } from './localPluginPackagePromptOutputArtifactRepository';
import type {
  PluginPackagePromptOutputArtifactRetentionState,
  PluginPackagePromptOutputArtifactRetentionStateReader,
} from '../pluginPackagePromptOutputRead';
import {
  MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_GC_CANDIDATES,
  createPluginPackagePromptOutputArtifactTombstone,
  exactPluginPackagePromptOutputRetentionPolicy,
  normalizePluginPackagePromptOutputArtifactTombstone,
  type PluginPackagePromptOutputArtifactGarbageCollector,
  type PluginPackagePromptOutputArtifactTombstone,
  type PluginPackagePromptOutputRetentionPolicyResolver,
} from '../pluginPackagePromptOutputRetention';

type Row = Record<string, unknown>;

function unavailable(
  cause?: unknown,
): PluginPackagePromptOutputArtifactUnavailableError {
  return new PluginPackagePromptOutputArtifactUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw unavailable();
  return value;
}

function parseTombstone(
  row: Row,
): Readonly<PluginPackagePromptOutputArtifactTombstone> {
  try {
    const json = text(row, 'tombstoneJson');
    const tombstone = normalizePluginPackagePromptOutputArtifactTombstone(
      JSON.parse(json) as PluginPackagePromptOutputArtifactTombstone,
    );
    const reference = tombstone.reference;
    if (
      reference.artifactId !== text(row, 'artifactId') ||
      reference.projectId !== text(row, 'projectId') ||
      reference.runId !== text(row, 'runId') ||
      reference.stepRunId !== text(row, 'stepRunId') ||
      reference.invocationId !== text(row, 'invocationId') ||
      reference.artifactDigest !== text(row, 'artifactDigest') ||
      reference.retentionPolicyDigest !== text(row, 'retentionPolicyDigest') ||
      tombstone.tombstoneDigest !== text(row, 'tombstoneDigest') ||
      JSON.stringify(tombstone) !== json
    ) {
      throw unavailable();
    }
    return tombstone;
  } catch (cause) {
    throw cause instanceof PluginPackagePromptOutputArtifactUnavailableError
      ? cause
      : unavailable(cause);
  }
}

export function readLocalPluginPackagePromptOutputArtifactTombstoneInTransaction(
  client: DatabaseSync,
  artifactId: string,
): Readonly<PluginPackagePromptOutputArtifactTombstone> | null {
  const rows = client
    .prepare(
      `SELECT artifact_id AS "artifactId", project_id AS "projectId",
              run_id AS "runId", step_run_id AS "stepRunId",
              invocation_id AS "invocationId",
              artifact_digest AS "artifactDigest",
              retention_policy_digest AS "retentionPolicyDigest",
              tombstone_digest AS "tombstoneDigest",
              tombstone_json AS "tombstoneJson"
         FROM "ModelInvocationPromptOutputArtifactTombstones"
        WHERE artifact_id = ?
        LIMIT 2`,
    )
    .all(artifactId) as Row[];
  if (rows.length > 1) throw unavailable();
  return rows[0] ? parseTombstone(rows[0]) : null;
}

function insertTombstone(
  client: DatabaseSync,
  artifact: Readonly<PluginPackagePromptOutputArtifact>,
  tombstonedAtMs: number,
): Readonly<PluginPackagePromptOutputArtifactTombstone> {
  const tombstone = createPluginPackagePromptOutputArtifactTombstone(
    pluginPackagePromptOutputArtifactReference(artifact),
    tombstonedAtMs,
  );
  const reference = tombstone.reference;
  client
    .prepare(
      `INSERT INTO "ModelInvocationPromptOutputArtifactTombstones" (
         artifact_id, project_id, run_id, step_run_id, invocation_id,
         artifact_digest, retention_policy_digest,
         retention_eligible_at_ms, key_id, tombstoned_at_ms,
         tombstone_digest, tombstone_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      reference.artifactId,
      reference.projectId,
      reference.runId,
      reference.stepRunId,
      reference.invocationId,
      reference.artifactDigest,
      reference.retentionPolicyDigest,
      reference.retentionEligibleAtMs,
      reference.keyId,
      tombstone.tombstonedAtMs,
      tombstone.tombstoneDigest,
      JSON.stringify(tombstone),
    );
  return tombstone;
}

function terminalPromptOutput(
  client: DatabaseSync,
  artifact: Readonly<PluginPackagePromptOutputArtifact>,
): boolean {
  const rows = client
    .prepare(
      `SELECT run.status AS "runStatus", step.status AS "stepStatus",
              step.output_ref AS "outputRef",
              completion.outcome AS "completionOutcome",
              finalization.run_status AS "finalizationStatus"
         FROM "ModelInvocationPromptAdmissions" AS admission
         JOIN "ModelInvocationPromptFinalizations" AS finalization
           ON finalization.request_id = admission.request_id
         JOIN "ModelInvocationCompletions" AS completion
           ON completion.invocation_id = admission.invocation_id
         JOIN "Runs" AS run ON run.id = admission.run_id
         JOIN "StepRuns" AS step
           ON step.run_id = admission.run_id AND step.id = admission.step_run_id
        WHERE admission.invocation_id = ?
        LIMIT 2`,
    )
    .all(artifact.invocationId) as Row[];
  return (
    rows.length === 1 &&
    rows[0]?.runStatus === 'succeeded' &&
    rows[0]?.stepStatus === 'succeeded' &&
    rows[0]?.outputRef === artifact.artifactId &&
    rows[0]?.completionOutcome === 'succeeded' &&
    rows[0]?.finalizationStatus === 'succeeded'
  );
}

export class LocalPluginPackagePromptOutputRetentionRepository
  implements PluginPackagePromptOutputArtifactRetentionStateReader
{
  constructor(
    private readonly authority: LocalModelInvocationOperationAuthority,
  ) {
    if (
      !authority ||
      typeof authority !== 'object' ||
      !authority.client ||
      typeof authority.enqueue !== 'function'
    ) {
      throw unavailable();
    }
  }

  inspect(
    request: Readonly<{
      reference: Readonly<PluginPackagePromptOutputArtifactReference>;
      observedAtMs: number;
    }>,
  ): Promise<PluginPackagePromptOutputArtifactRetentionState> {
    const reference = normalizePluginPackagePromptOutputArtifactReference(
      request.reference,
    );
    if (
      !Number.isSafeInteger(request.observedAtMs) ||
      request.observedAtMs < 0
    ) {
      return Promise.reject(unavailable());
    }
    return this.authority.enqueue(
      async () => {
        const tombstone =
          readLocalPluginPackagePromptOutputArtifactTombstoneInTransaction(
            this.authority.client,
            reference.artifactId,
          );
        if (!tombstone) return Object.freeze({ state: 'retained' as const });
        if (JSON.stringify(tombstone.reference) !== JSON.stringify(reference)) {
          throw unavailable();
        }
        return Object.freeze({
          state: 'tombstoned' as const,
          tombstonedAtMs: tombstone.tombstonedAtMs,
          tombstoneDigest: tombstone.tombstoneDigest,
        });
      },
      () => unavailable(),
    );
  }
}

export class LocalPluginPackagePromptOutputGarbageCollector
  implements PluginPackagePromptOutputArtifactGarbageCollector
{
  readonly #authority: LocalModelInvocationOperationAuthority;
  readonly #policies: PluginPackagePromptOutputRetentionPolicyResolver;
  readonly #now: () => number;
  readonly #limit: number;

  constructor(
    options: Readonly<{
      authority: LocalModelInvocationOperationAuthority;
      policies: PluginPackagePromptOutputRetentionPolicyResolver;
      now?: () => number;
      limit?: number;
    }>,
  ) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      !options.authority ||
      typeof options.authority.enqueue !== 'function' ||
      !options.policies ||
      typeof options.policies.resolve !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function') ||
      (options.limit !== undefined &&
        (!Number.isSafeInteger(options.limit) ||
          options.limit < 1 ||
          options.limit > MAX_PLUGIN_PACKAGE_PROMPT_OUTPUT_GC_CANDIDATES))
    ) {
      throw unavailable();
    }
    this.#authority = options.authority;
    this.#policies = options.policies;
    this.#now = options.now ?? Date.now;
    this.#limit = options.limit ?? 32;
  }

  async collect(): Promise<
    Readonly<{
      scanned: number;
      tombstoned: number;
      skipped: number;
      hasMore: boolean;
    }>
  > {
    const nowMs = this.#now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw unavailable();
    const ids = await this.#authority.enqueue(
      async () =>
        (
          this.#authority.client
            .prepare(
              `SELECT artifact_id AS "artifactId"
               FROM "ModelInvocationPromptOutputArtifacts"
              WHERE retention_eligible_at_ms <= ?
              ORDER BY retention_eligible_at_ms, artifact_id
              LIMIT ?`,
            )
            .all(nowMs, this.#limit + 1) as Row[]
        ).map((row) => text(row, 'artifactId')),
      () => unavailable(),
    );
    const candidates = ids.slice(0, this.#limit);
    let tombstoned = 0;
    let skipped = 0;
    for (const artifactId of candidates) {
      const artifact = await this.#authority.enqueue(
        async () =>
          readLocalPluginPackagePromptOutputArtifactInTransaction(
            this.#authority.client,
            artifactId,
          ),
        () => unavailable(),
      );
      if (!artifact) {
        skipped += 1;
        continue;
      }
      let policy;
      try {
        policy = await this.#policies.resolve({
          projectId: artifact.projectId,
          revision: artifact.retentionPolicy.revision,
        });
      } catch (cause) {
        throw unavailable(cause);
      }
      if (
        !policy ||
        !exactPluginPackagePromptOutputRetentionPolicy(
          policy,
          artifact.retentionPolicy,
          artifact.retentionPolicyDigest,
        )
      ) {
        skipped += 1;
        continue;
      }
      const deleted = await this.#authority.enqueue(
        async () => {
          const client = this.#authority.client;
          client.exec('BEGIN IMMEDIATE');
          try {
            const current =
              readLocalPluginPackagePromptOutputArtifactInTransaction(
                client,
                artifactId,
              );
            if (
              !current ||
              JSON.stringify(current) !== JSON.stringify(artifact) ||
              current.retentionEligibleAtMs > nowMs ||
              !terminalPromptOutput(client, current)
            ) {
              client.exec('ROLLBACK');
              return false;
            }
            const existing =
              readLocalPluginPackagePromptOutputArtifactTombstoneInTransaction(
                client,
                artifactId,
              );
            if (existing) {
              client.exec('ROLLBACK');
              return false;
            }
            insertTombstone(client, current, nowMs);
            const deletion = client
              .prepare(
                `DELETE FROM "ModelInvocationPromptOutputArtifacts"
                  WHERE artifact_id = ? AND artifact_digest = ?`,
              )
              .run(current.artifactId, current.artifactDigest);
            if (deletion.changes !== 1) throw unavailable();
            client.exec('COMMIT');
            return true;
          } catch (cause) {
            try {
              client.exec('ROLLBACK');
            } catch {
              throw unavailable(cause);
            }
            throw cause;
          }
        },
        () => unavailable(),
      );
      if (deleted) tombstoned += 1;
      else skipped += 1;
    }
    return Object.freeze({
      scanned: candidates.length,
      tombstoned,
      skipped,
      hasMore: ids.length > this.#limit,
    });
  }
}
