import type { PostgresPool } from '@qinglong/runtime-core';
import {
  ApprovalUnavailableError,
  approvalRequestDigest,
  normalizeApprovalRequestRecord,
  type ApprovalRequestRecord,
} from '@qinglong/runtime-core/approved-action';
import {
  approvalRequestUpdatedAtMs,
  assertApprovalDiscoveryProjectId,
  assertApprovalDiscoveryRequestId,
  assertApprovalRequestPageSize,
  normalizeApprovalRequestCursor,
  type ApprovalRequestDetail,
  type ApprovalRequestDetailSource,
  type ApprovalRequestPage,
  type ApprovalRequestSource,
} from '@qinglong/runtime-core/approval-discovery';
import {
  normalizeToolInvocationPreviewArtifact,
  type ToolInvocationPreviewArtifact,
} from '@qinglong/runtime-core/tool-invocation-artifact';

import {
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
} from '../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;

function unavailable(): ApprovalUnavailableError {
  return new ApprovalUnavailableError();
}

function request(row: Row): Readonly<ApprovalRequestRecord> {
  try {
    const value = normalizeApprovalRequestRecord(
      postgresRequiredJsonObject(
        row.requestJson,
        unavailable,
      ) as unknown as ApprovalRequestRecord,
    );
    if (
      approvalRequestDigest(value) !==
        postgresRequiredString(row.requestDigest, unavailable) ||
      approvalRequestUpdatedAtMs(value) !==
        postgresRequiredInteger(row.updatedAtMs, unavailable)
    ) {
      throw unavailable();
    }
    return value;
  } catch (error) {
    if (error instanceof ApprovalUnavailableError) throw error;
    throw unavailable();
  }
}

function previewArtifact(
  row: Row,
): Readonly<ToolInvocationPreviewArtifact> | null {
  if (row.previewArtifactId === null) return null;
  try {
    const value = normalizeToolInvocationPreviewArtifact(
      postgresRequiredJsonObject(
        row.previewArtifactJson,
        unavailable,
      ) as unknown as ToolInvocationPreviewArtifact,
    );
    if (
      value.artifactId !== postgresRequiredString(row.previewArtifactId, unavailable) ||
      value.projectId !== postgresRequiredString(row.previewProjectId, unavailable) ||
      value.actionRef !== postgresRequiredString(row.previewActionRef, unavailable) ||
      value.actionDigest !== postgresRequiredString(row.previewActionDigest, unavailable) ||
      value.previewDigest !== postgresRequiredString(row.storedPreviewDigest, unavailable) ||
      value.redactionContractDigest !==
        postgresRequiredString(row.redactionContractDigest, unavailable) ||
      value.artifactDigest !== postgresRequiredString(row.previewArtifactDigest, unavailable) ||
      value.byteLength !== postgresRequiredInteger(row.previewByteLength, unavailable) ||
      value.sealedAtMs !== postgresRequiredInteger(row.previewSealedAtMs, unavailable)
    ) {
      throw unavailable();
    }
    return value;
  } catch (error) {
    if (error instanceof ApprovalUnavailableError) throw error;
    throw unavailable();
  }
}

/** Read-only Approval history using the existing Project keyset index. */
export class PostgresApprovalRequestSource
  implements ApprovalRequestSource, ApprovalRequestDetailSource
{
  constructor(private readonly pool: Pick<PostgresPool, 'query'>) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError('PostgreSQL Approval discovery pool is invalid');
    }
  }

  async listApprovalRequests(options: {
    readonly projectId: string;
    readonly limit: number;
    readonly after?: { readonly updatedAtMs: number; readonly requestId: string };
  }): Promise<Readonly<ApprovalRequestPage>> {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Approval discovery options are invalid');
    }
    const keys = Object.keys(options);
    if (
      !keys.includes('projectId') ||
      !keys.includes('limit') ||
      keys.some((key) => !['projectId', 'limit', 'after'].includes(key))
    ) {
      throw new TypeError('Approval discovery options shape is invalid');
    }
    assertApprovalDiscoveryProjectId(options.projectId);
    assertApprovalRequestPageSize(options.limit);
    const after = options.after
      ? normalizeApprovalRequestCursor(options.after)
      : undefined;
    try {
      const result = await this.pool.query<Row>(
        `SELECT request_json AS "requestJson",
                request_digest AS "requestDigest",
                updated_at_ms AS "updatedAtMs"
         FROM "ql3"."approval_requests"
         WHERE project_id = $1
           AND (
             $2::bigint IS NULL OR updated_at_ms < $2 OR
             (updated_at_ms = $2 AND request_id < $3)
           )
         ORDER BY updated_at_ms DESC, request_id DESC
         LIMIT $4`,
        [
          options.projectId,
          after?.updatedAtMs ?? null,
          after?.requestId ?? '',
          options.limit + 1,
        ],
      );
      const truncated = result.rows.length > options.limit;
      const requests = Object.freeze(
        result.rows.slice(0, options.limit).map(request),
      );
      const last = requests.at(-1);
      return Object.freeze({
        requests,
        truncated,
        ...(truncated && last
          ? {
              next: Object.freeze({
                updatedAtMs: approvalRequestUpdatedAtMs(last),
                requestId: last.id,
              }),
            }
          : {}),
      });
    } catch {
      throw unavailable();
    }
  }

  async getApprovalRequestDetail(options: {
    readonly projectId: string;
    readonly requestId: string;
  }): Promise<Readonly<ApprovalRequestDetail> | null> {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).length !== 2 ||
      !Object.hasOwn(options, 'projectId') ||
      !Object.hasOwn(options, 'requestId')
    ) {
      throw new TypeError('Approval detail options are invalid');
    }
    assertApprovalDiscoveryProjectId(options.projectId);
    assertApprovalDiscoveryRequestId(options.requestId);
    try {
      const result = await this.pool.query<Row>(
        `SELECT a.request_json AS "requestJson",
                a.request_digest AS "requestDigest",
                a.updated_at_ms AS "updatedAtMs",
                p.artifact_id AS "previewArtifactId",
                p.project_id AS "previewProjectId",
                p.action_ref AS "previewActionRef",
                p.action_digest AS "previewActionDigest",
                p.preview_digest AS "storedPreviewDigest",
                p.redaction_contract_digest AS "redactionContractDigest",
                p.artifact_digest AS "previewArtifactDigest",
                p.byte_length AS "previewByteLength",
                p.sealed_at_ms AS "previewSealedAtMs",
                p.artifact_json AS "previewArtifactJson"
         FROM "ql3"."approval_requests" a
         LEFT JOIN "ql3"."tool_invocation_preview_artifacts" p
           ON a.action_type = 'tool.invoke'
          AND p.project_id = a.project_id
          AND p.action_ref = a.action_ref
          AND p.action_digest = a.action_digest
          AND p.preview_digest = a.preview_digest
         WHERE a.project_id = $1 AND a.request_id = $2
         LIMIT 2`,
        [options.projectId, options.requestId],
      );
      if (result.rows.length > 1) throw unavailable();
      if (!result.rows[0]) return null;
      const approval = request(result.rows[0]);
      const preview = previewArtifact(result.rows[0]);
      if (
        preview &&
        (approval.action.actionType !== 'tool.invoke' ||
          approval.projectId !== preview.projectId ||
          approval.action.actionRef !== preview.actionRef ||
          approval.action.actionDigest !== preview.actionDigest ||
          approval.action.previewDigest !== preview.previewDigest)
      ) {
        throw unavailable();
      }
      return Object.freeze({
        request: approval,
        preview: preview?.preview ?? null,
      });
    } catch (error) {
      if (error instanceof ApprovalUnavailableError) throw error;
      throw unavailable();
    }
  }
}
