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

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new ApprovalUnavailableError();
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ApprovalUnavailableError();
  }
  return Number(value);
}

function previewArtifact(
  row: Row,
): Readonly<ToolInvocationPreviewArtifact> | null {
  if (row.previewArtifactId === null) return null;
  try {
    const value = normalizeToolInvocationPreviewArtifact(
      JSON.parse(text(row, 'previewArtifactJson')) as ToolInvocationPreviewArtifact,
    );
    if (
      value.artifactId !== text(row, 'previewArtifactId') ||
      value.projectId !== text(row, 'previewProjectId') ||
      value.actionRef !== text(row, 'previewActionRef') ||
      value.actionDigest !== text(row, 'previewActionDigest') ||
      value.previewDigest !== text(row, 'storedPreviewDigest') ||
      value.redactionContractDigest !== text(row, 'redactionContractDigest') ||
      value.artifactDigest !== text(row, 'previewArtifactDigest') ||
      value.byteLength !== integer(row, 'previewByteLength') ||
      value.sealedAtMs !== integer(row, 'previewSealedAtMs')
    ) {
      throw new ApprovalUnavailableError();
    }
    return value;
  } catch (error) {
    if (error instanceof ApprovalUnavailableError) throw error;
    throw new ApprovalUnavailableError();
  }
}

function request(row: Row): Readonly<ApprovalRequestRecord> {
  try {
    const value = normalizeApprovalRequestRecord(
      JSON.parse(text(row, 'requestJson')) as ApprovalRequestRecord,
    );
    if (
      approvalRequestDigest(value) !== text(row, 'requestDigest') ||
      approvalRequestUpdatedAtMs(value) !== integer(row, 'updatedAtMs')
    ) {
      throw new ApprovalUnavailableError();
    }
    return value;
  } catch (error) {
    if (error instanceof ApprovalUnavailableError) throw error;
    throw new ApprovalUnavailableError();
  }
}

/** Read-only, Project-scoped Approval history over the shared SQLite queue. */
export class LocalSqliteApprovalRequestSource
  implements ApprovalRequestSource, ApprovalRequestDetailSource
{
  constructor(private readonly authority: LocalSqliteOperationAuthority) {
    if (!(authority instanceof LocalSqliteOperationAuthority)) {
      throw new TypeError('Local Approval discovery authority is invalid');
    }
  }

  listApprovalRequests(options: {
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
    return this.authority.enqueue(
      async () => {
        try {
          const rows = this.authority.client
            .prepare(
              `SELECT "request_json" AS "requestJson",
                      "request_digest" AS "requestDigest",
                      "updated_at_ms" AS "updatedAtMs"
               FROM "QingLong3ApprovalRequests"
               WHERE "project_id" = ?
                 AND (
                   ? IS NULL OR "updated_at_ms" < ? OR
                   ("updated_at_ms" = ? AND "request_id" < ?)
                 )
               ORDER BY "updated_at_ms" DESC, "request_id" DESC
               LIMIT ?`,
            )
            .all(
              options.projectId,
              after?.updatedAtMs ?? null,
              after?.updatedAtMs ?? null,
              after?.updatedAtMs ?? null,
              after?.requestId ?? '',
              options.limit + 1,
            ) as Row[] | undefined;
          if (!Array.isArray(rows)) throw new ApprovalUnavailableError();
          const truncated = rows.length > options.limit;
          const requests = Object.freeze(
            rows.slice(0, options.limit).map(request),
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
          throw new ApprovalUnavailableError();
        }
      },
      () => new ApprovalUnavailableError(),
    );
  }

  getApprovalRequestDetail(options: {
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
    return this.authority.enqueue(
      async () => {
        try {
          const rows = this.authority.client
            .prepare(
              `SELECT a."request_json" AS "requestJson",
                      a."request_digest" AS "requestDigest",
                      a."updated_at_ms" AS "updatedAtMs",
                      p."artifact_id" AS "previewArtifactId",
                      p."project_id" AS "previewProjectId",
                      p."action_ref" AS "previewActionRef",
                      p."action_digest" AS "previewActionDigest",
                      p."preview_digest" AS "storedPreviewDigest",
                      p."redaction_contract_digest" AS "redactionContractDigest",
                      p."artifact_digest" AS "previewArtifactDigest",
                      p."byte_length" AS "previewByteLength",
                      p."sealed_at_ms" AS "previewSealedAtMs",
                      p."artifact_json" AS "previewArtifactJson"
               FROM "QingLong3ApprovalRequests" a
               LEFT JOIN "ToolInvocationPreviewArtifacts" p
                 ON a."action_type" = 'tool.invoke'
                AND p."project_id" = a."project_id"
                AND p."action_ref" = a."action_ref"
                AND p."action_digest" = a."action_digest"
                AND p."preview_digest" = a."preview_digest"
               WHERE a."project_id" = ? AND a."request_id" = ?
               LIMIT 2`,
            )
            .all(options.projectId, options.requestId) as Row[] | undefined;
          if (!Array.isArray(rows) || rows.length > 1) {
            throw new ApprovalUnavailableError();
          }
          if (!rows[0]) return null;
          const approval = request(rows[0]);
          const preview = previewArtifact(rows[0]);
          if (
            preview &&
            (approval.action.actionType !== 'tool.invoke' ||
              approval.projectId !== preview.projectId ||
              approval.action.actionRef !== preview.actionRef ||
              approval.action.actionDigest !== preview.actionDigest ||
              approval.action.previewDigest !== preview.previewDigest)
          ) {
            throw new ApprovalUnavailableError();
          }
          return Object.freeze({
            request: approval,
            preview: preview?.preview ?? null,
          });
        } catch (error) {
          if (error instanceof ApprovalUnavailableError) throw error;
          throw new ApprovalUnavailableError();
        }
      },
      () => new ApprovalUnavailableError(),
    );
  }
}
