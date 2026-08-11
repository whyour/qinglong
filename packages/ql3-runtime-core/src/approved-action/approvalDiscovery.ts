import type { ApprovalRequestRecord } from './approvedAction';

export const MAX_APPROVAL_REQUEST_PAGE_SIZE = 64;
export const MAX_APPROVAL_DETAIL_PREVIEW_BYTES = 8 * 1024;

export interface ApprovalRequestCursor {
  readonly updatedAtMs: number;
  readonly requestId: string;
}

export interface ApprovalRequestPage {
  readonly requests: readonly Readonly<ApprovalRequestRecord>[];
  readonly truncated: boolean;
  readonly next?: Readonly<ApprovalRequestCursor>;
}

export interface ApprovalRequestSource {
  listApprovalRequests(options: {
    readonly projectId: string;
    readonly limit: number;
    readonly after?: Readonly<ApprovalRequestCursor>;
  }): Promise<Readonly<ApprovalRequestPage>>;
}

export interface ApprovalRequestDetail {
  readonly request: Readonly<ApprovalRequestRecord>;
  readonly preview: Readonly<ApprovalDetailPreview> | null;
}

export interface ApprovalDetailPreviewField {
  readonly kind: 'count' | 'identifier' | 'redacted' | 'text';
  readonly label: string;
  readonly value: string | null;
}

export interface ApprovalDetailPreview {
  readonly title: string;
  readonly summary: string;
  readonly fields: readonly Readonly<ApprovalDetailPreviewField>[];
  readonly warnings: readonly string[];
}

export interface ApprovalRequestDetailSource {
  getApprovalRequestDetail(options: {
    readonly projectId: string;
    readonly requestId: string;
  }): Promise<Readonly<ApprovalRequestDetail> | null>;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const WARNING_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const PREVIEW_FIELD_KINDS = ['count', 'identifier', 'redacted', 'text'] as const;

export class InvalidApprovalDiscoveryValueError extends TypeError {
  constructor(message: string) {
    super(`Approval discovery value is invalid: ${message}`);
    this.name = 'InvalidApprovalDiscoveryValueError';
  }
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new InvalidApprovalDiscoveryValueError(`${name} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new InvalidApprovalDiscoveryValueError(`${name} is invalid`);
  }
  return Number(value);
}

export function assertApprovalRequestPageSize(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_APPROVAL_REQUEST_PAGE_SIZE
  ) {
    throw new InvalidApprovalDiscoveryValueError('page size is invalid');
  }
}

export function assertApprovalDiscoveryProjectId(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    CONTROL_PATTERN.test(value)
  ) {
    throw new InvalidApprovalDiscoveryValueError('projectId is invalid');
  }
}

export function assertApprovalDiscoveryRequestId(value: string): void {
  identifier(value, 'requestId');
}

export function normalizeApprovalRequestCursor(
  value: ApprovalRequestCursor,
): Readonly<ApprovalRequestCursor> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApprovalDiscoveryValueError('cursor is invalid');
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !keys.includes('updatedAtMs') ||
    !keys.includes('requestId')
  ) {
    throw new InvalidApprovalDiscoveryValueError('cursor shape is invalid');
  }
  return Object.freeze({
    updatedAtMs: timestamp(value.updatedAtMs, 'cursor updatedAtMs'),
    requestId: identifier(value.requestId, 'cursor requestId'),
  });
}

function boundedText(value: unknown, maximumBytes: number, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    CONTROL_PATTERN.test(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new InvalidApprovalDiscoveryValueError(`${name} is invalid`);
  }
  return value;
}

export function normalizeApprovalDetailPreview(
  value: ApprovalDetailPreview,
): Readonly<ApprovalDetailPreview> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidApprovalDiscoveryValueError('preview is invalid');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 4 ||
    !['title', 'summary', 'fields', 'warnings'].every((key) =>
      Object.hasOwn(value, key),
    ) ||
    !Array.isArray(value.fields) ||
    value.fields.length > 16 ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 8
  ) {
    throw new InvalidApprovalDiscoveryValueError('preview shape is invalid');
  }
  const fields = value.fields.map((field) => {
    if (
      !field ||
      typeof field !== 'object' ||
      Array.isArray(field) ||
      Reflect.ownKeys(field).length !== 3 ||
      !Object.hasOwn(field, 'kind') ||
      !Object.hasOwn(field, 'label') ||
      !Object.hasOwn(field, 'value') ||
      !PREVIEW_FIELD_KINDS.includes(field.kind) ||
      (field.kind === 'redacted' && field.value !== null) ||
      (field.kind !== 'redacted' && field.value === null)
    ) {
      throw new InvalidApprovalDiscoveryValueError('preview field is invalid');
    }
    return Object.freeze({
      kind: field.kind,
      label: boundedText(field.label, 128, 'preview field label'),
      value:
        field.value === null
          ? null
          : boundedText(field.value, 512, 'preview field value'),
    });
  });
  const warnings = value.warnings.map((warning) => {
    if (typeof warning !== 'string' || !WARNING_PATTERN.test(warning)) {
      throw new InvalidApprovalDiscoveryValueError('preview warning is invalid');
    }
    return warning;
  });
  if (new Set(warnings).size !== warnings.length) {
    throw new InvalidApprovalDiscoveryValueError('preview warnings are duplicated');
  }
  const normalized = Object.freeze({
    title: boundedText(value.title, 256, 'preview title'),
    summary: boundedText(value.summary, 2048, 'preview summary'),
    fields: Object.freeze(fields),
    warnings: Object.freeze([...warnings].sort()),
  });
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
    MAX_APPROVAL_DETAIL_PREVIEW_BYTES
  ) {
    throw new InvalidApprovalDiscoveryValueError('preview byte budget exceeded');
  }
  return normalized;
}

export function approvalRequestUpdatedAtMs(
  request: Readonly<ApprovalRequestRecord>,
): number {
  return timestamp(
    request.consumedAtMs ?? request.decidedAtMs ?? request.requestedAtMs,
    'request updatedAtMs',
  );
}
