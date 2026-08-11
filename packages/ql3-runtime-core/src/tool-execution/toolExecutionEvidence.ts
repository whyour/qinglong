import { createHash } from 'node:crypto';

import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '../security/audit/securityAudit';

export const TOOL_EXECUTION_TRACE_ANCHOR_SCHEMA =
  'qinglong/tool-execution-trace-anchor@v1' as const;
export const TOOL_EXECUTION_AUDIT_RECEIPT_SCHEMA =
  'qinglong/tool-execution-audit-receipt@v1' as const;
export const TOOL_EXECUTION_EVIDENCE_BUNDLE_SCHEMA =
  'qinglong/tool-execution-evidence-bundle@v1' as const;
export const TOOL_EXECUTION_START_AUDIT_OPERATION =
  'tool.invoke.start' as const;

export const MAX_TOOL_EXECUTION_EVIDENCE_BYTES = 16 * 1024;
export const MAX_TOOL_EXECUTION_EVIDENCE_PAGE_SIZE = 128;

export interface ToolExecutionTraceAnchor {
  readonly schema: typeof TOOL_EXECUTION_TRACE_ANCHOR_SCHEMA;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly invocationPlanDigest: string;
  readonly bindingDigest: string;
  readonly adapterDigest: string;
  readonly redactionContractDigest: string;
  readonly auditContractDigest: string;
  readonly createdAtMs: number;
  readonly traceDigest: string;
}

export interface ToolExecutionAuditReceipt {
  readonly schema: typeof TOOL_EXECUTION_AUDIT_RECEIPT_SCHEMA;
  readonly eventId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly traceDigest: string;
  readonly invocationPlanDigest: string;
  readonly bindingDigest: string;
  readonly auditRecordDigest: string;
  readonly createdAtMs: number;
  readonly receiptDigest: string;
}

export interface ToolExecutionEvidenceBundle {
  readonly schema: typeof TOOL_EXECUTION_EVIDENCE_BUNDLE_SCHEMA;
  readonly trace: Readonly<ToolExecutionTraceAnchor>;
  readonly audit: Readonly<SecurityAuditRecord>;
  readonly receipt: Readonly<ToolExecutionAuditReceipt>;
}

export interface CreateToolExecutionEvidenceInput {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly invocationPlanDigest: string;
  readonly bindingDigest: string;
  readonly adapterDigest: string;
  readonly redactionContractDigest: string;
  readonly auditContractDigest: string;
  readonly audit: SecurityAuditRecord;
  readonly createdAtMs: number;
}

export interface ToolExecutionEvidenceCursor {
  readonly createdAtMs: number;
  readonly traceId: string;
  readonly spanId: string;
}

export interface ListToolExecutionEvidenceQuery {
  readonly runId: string;
  readonly limit: number;
  readonly after?: ToolExecutionEvidenceCursor;
}

export interface ListToolExecutionEvidenceResult {
  readonly bundles: readonly Readonly<ToolExecutionEvidenceBundle>[];
  readonly truncated: boolean;
  readonly next?: Readonly<ToolExecutionEvidenceCursor>;
}

export interface PrepareToolExecutionEvidenceResult {
  readonly status: 'created' | 'existing';
  readonly bundle: Readonly<ToolExecutionEvidenceBundle>;
}

export interface ToolExecutionEvidenceRepository {
  findByTrace(
    traceId: string,
    spanId: string,
  ): Promise<Readonly<ToolExecutionEvidenceBundle> | null>;
  findByAuditEventId(
    eventId: string,
  ): Promise<Readonly<ToolExecutionEvidenceBundle> | null>;
  listByRun(
    query: ListToolExecutionEvidenceQuery,
  ): Promise<ListToolExecutionEvidenceResult>;
  prepare(
    bundle: ToolExecutionEvidenceBundle,
  ): Promise<Readonly<PrepareToolExecutionEvidenceResult>>;
}

export class InvalidToolExecutionEvidenceError extends TypeError {
  readonly code = 'TOOL_EXECUTION_EVIDENCE_INVALID';

  constructor(message: string) {
    super(`Tool execution evidence is invalid: ${message}`);
    this.name = 'InvalidToolExecutionEvidenceError';
  }
}

export class ToolExecutionEvidenceConflictError extends Error {
  readonly code = 'TOOL_EXECUTION_EVIDENCE_CONFLICT';

  constructor() {
    super('Tool execution evidence identity is bound to different content');
    this.name = 'ToolExecutionEvidenceConflictError';
  }
}

export class ToolExecutionEvidenceUnavailableError extends Error {
  readonly code = 'TOOL_EXECUTION_EVIDENCE_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Tool execution evidence repository is unavailable', options);
    this.name = 'ToolExecutionEvidenceUnavailableError';
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TRACE_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-trace-anchor-digest@v1\0',
  'utf8',
);
const AUDIT_RECORD_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-audit-record-digest@v1\0',
  'utf8',
);
const AUDIT_RECEIPT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-audit-receipt-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidToolExecutionEvidenceError(message);
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    )
  ) {
    return invalid(`${label} must contain enumerable data properties`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value).sort();
  const requiredKeys = [...required].sort();
  const allowed = new Set([...required, ...optional]);
  if (
    requiredKeys.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function traceId(value: unknown): string {
  if (typeof value !== 'string' || !TRACE_ID_PATTERN.test(value)) {
    return invalid('traceId is invalid');
  }
  return value;
}

function spanId(value: unknown, label = 'spanId'): string {
  if (typeof value !== 'string' || !SPAN_ID_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) invalid('canonical value is invalid');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const record = dataRecord(value, 'canonical value');
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function hash(domain: Buffer, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function traceUnsigned(
  value: Readonly<ToolExecutionTraceAnchor>,
): Omit<ToolExecutionTraceAnchor, 'traceDigest'> {
  const {
    traceDigest: _traceDigest,
    ...unsigned
  } = value;
  return unsigned;
}

function receiptUnsigned(
  value: Readonly<ToolExecutionAuditReceipt>,
): Omit<ToolExecutionAuditReceipt, 'receiptDigest'> {
  const {
    receiptDigest: _receiptDigest,
    ...unsigned
  } = value;
  return unsigned;
}

export function toolExecutionAuditRecordDigest(
  value: SecurityAuditRecord,
): string {
  return hash(
    AUDIT_RECORD_DIGEST_DOMAIN,
    normalizeSecurityAuditRecord(value),
  );
}

export function normalizeToolExecutionTraceAnchor(
  value: ToolExecutionTraceAnchor,
): Readonly<ToolExecutionTraceAnchor> {
  const record = dataRecord(value, 'trace anchor');
  exactKeys(
    record,
    [
      'adapterDigest',
      'auditContractDigest',
      'bindingDigest',
      'createdAtMs',
      'invocationPlanDigest',
      'parentSpanId',
      'projectId',
      'redactionContractDigest',
      'runId',
      'schema',
      'spanId',
      'stepRunId',
      'traceDigest',
      'traceId',
    ],
    [],
    'trace anchor',
  );
  if (value.schema !== TOOL_EXECUTION_TRACE_ANCHOR_SCHEMA) {
    return invalid('trace anchor schema is invalid');
  }
  const normalized = Object.freeze({
    schema: TOOL_EXECUTION_TRACE_ANCHOR_SCHEMA,
    traceId: traceId(value.traceId),
    spanId: spanId(value.spanId),
    parentSpanId:
      value.parentSpanId === null
        ? null
        : spanId(value.parentSpanId, 'parentSpanId'),
    projectId: identifier(value.projectId, 'projectId'),
    runId: identifier(value.runId, 'runId'),
    stepRunId: identifier(value.stepRunId, 'stepRunId'),
    invocationPlanDigest: digest(
      value.invocationPlanDigest,
      'invocationPlanDigest',
    ),
    bindingDigest: digest(value.bindingDigest, 'bindingDigest'),
    adapterDigest: digest(value.adapterDigest, 'adapterDigest'),
    redactionContractDigest: digest(
      value.redactionContractDigest,
      'redactionContractDigest',
    ),
    auditContractDigest: digest(
      value.auditContractDigest,
      'auditContractDigest',
    ),
    createdAtMs: timestamp(value.createdAtMs, 'createdAtMs'),
    traceDigest: digest(value.traceDigest, 'traceDigest'),
  });
  if (
    normalized.parentSpanId === normalized.spanId ||
    hash(TRACE_DIGEST_DOMAIN, traceUnsigned(normalized)) !==
      normalized.traceDigest ||
    Buffer.byteLength(canonicalJson(normalized), 'utf8') >
      MAX_TOOL_EXECUTION_EVIDENCE_BYTES
  ) {
    return invalid('trace anchor semantic digest is invalid');
  }
  return normalized;
}

export function normalizeToolExecutionAuditReceipt(
  value: ToolExecutionAuditReceipt,
): Readonly<ToolExecutionAuditReceipt> {
  const record = dataRecord(value, 'audit receipt');
  exactKeys(
    record,
    [
      'auditRecordDigest',
      'bindingDigest',
      'createdAtMs',
      'eventId',
      'invocationPlanDigest',
      'projectId',
      'receiptDigest',
      'runId',
      'schema',
      'spanId',
      'stepRunId',
      'traceDigest',
      'traceId',
    ],
    [],
    'audit receipt',
  );
  if (value.schema !== TOOL_EXECUTION_AUDIT_RECEIPT_SCHEMA) {
    return invalid('audit receipt schema is invalid');
  }
  const normalized = Object.freeze({
    schema: TOOL_EXECUTION_AUDIT_RECEIPT_SCHEMA,
    eventId: identifier(value.eventId, 'eventId'),
    projectId: identifier(value.projectId, 'projectId'),
    runId: identifier(value.runId, 'runId'),
    stepRunId: identifier(value.stepRunId, 'stepRunId'),
    traceId: traceId(value.traceId),
    spanId: spanId(value.spanId),
    traceDigest: digest(value.traceDigest, 'traceDigest'),
    invocationPlanDigest: digest(
      value.invocationPlanDigest,
      'invocationPlanDigest',
    ),
    bindingDigest: digest(value.bindingDigest, 'bindingDigest'),
    auditRecordDigest: digest(
      value.auditRecordDigest,
      'auditRecordDigest',
    ),
    createdAtMs: timestamp(value.createdAtMs, 'createdAtMs'),
    receiptDigest: digest(value.receiptDigest, 'receiptDigest'),
  });
  if (
    hash(AUDIT_RECEIPT_DIGEST_DOMAIN, receiptUnsigned(normalized)) !==
      normalized.receiptDigest ||
    Buffer.byteLength(canonicalJson(normalized), 'utf8') >
      MAX_TOOL_EXECUTION_EVIDENCE_BYTES
  ) {
    return invalid('audit receipt semantic digest is invalid');
  }
  return normalized;
}

export function normalizeToolExecutionEvidenceBundle(
  value: ToolExecutionEvidenceBundle,
): Readonly<ToolExecutionEvidenceBundle> {
  const record = dataRecord(value, 'evidence bundle');
  exactKeys(record, ['audit', 'receipt', 'schema', 'trace'], [], 'evidence bundle');
  if (value.schema !== TOOL_EXECUTION_EVIDENCE_BUNDLE_SCHEMA) {
    return invalid('evidence bundle schema is invalid');
  }
  let audit: Readonly<SecurityAuditRecord>;
  try {
    audit = normalizeSecurityAuditRecord(value.audit);
  } catch {
    return invalid('security audit record is invalid');
  }
  const trace = normalizeToolExecutionTraceAnchor(value.trace);
  const receipt = normalizeToolExecutionAuditReceipt(value.receipt);
  if (
    audit.operationId !== TOOL_EXECUTION_START_AUDIT_OPERATION ||
    audit.outcome !== 'allowed' ||
    audit.projectId !== trace.projectId ||
    audit.fence === null ||
    audit.occurredAtMs !== trace.createdAtMs ||
    receipt.eventId !== audit.eventId ||
    receipt.projectId !== trace.projectId ||
    receipt.runId !== trace.runId ||
    receipt.stepRunId !== trace.stepRunId ||
    receipt.traceId !== trace.traceId ||
    receipt.spanId !== trace.spanId ||
    receipt.traceDigest !== trace.traceDigest ||
    receipt.invocationPlanDigest !== trace.invocationPlanDigest ||
    receipt.bindingDigest !== trace.bindingDigest ||
    receipt.auditRecordDigest !== toolExecutionAuditRecordDigest(audit) ||
    receipt.createdAtMs !== trace.createdAtMs
  ) {
    return invalid('evidence bundle bindings are inconsistent');
  }
  const bundle = Object.freeze({
    schema: TOOL_EXECUTION_EVIDENCE_BUNDLE_SCHEMA,
    trace,
    audit,
    receipt,
  });
  if (
    Buffer.byteLength(canonicalJson(bundle), 'utf8') >
    MAX_TOOL_EXECUTION_EVIDENCE_BYTES
  ) {
    return invalid('evidence bundle exceeds the byte limit');
  }
  return bundle;
}

export function createToolExecutionEvidenceBundle(
  inputValue: CreateToolExecutionEvidenceInput,
): Readonly<ToolExecutionEvidenceBundle> {
  const input = dataRecord(inputValue, 'create input');
  exactKeys(
    input,
    [
      'adapterDigest',
      'audit',
      'auditContractDigest',
      'bindingDigest',
      'createdAtMs',
      'invocationPlanDigest',
      'projectId',
      'redactionContractDigest',
      'runId',
      'spanId',
      'stepRunId',
      'traceId',
    ],
    ['parentSpanId'],
    'create input',
  );
  let audit: Readonly<SecurityAuditRecord>;
  try {
    audit = normalizeSecurityAuditRecord(inputValue.audit);
  } catch {
    return invalid('security audit record is invalid');
  }
  const traceWithoutDigest = Object.freeze({
    schema: TOOL_EXECUTION_TRACE_ANCHOR_SCHEMA,
    traceId: traceId(inputValue.traceId),
    spanId: spanId(inputValue.spanId),
    parentSpanId:
      inputValue.parentSpanId === undefined
        ? null
        : spanId(inputValue.parentSpanId, 'parentSpanId'),
    projectId: identifier(inputValue.projectId, 'projectId'),
    runId: identifier(inputValue.runId, 'runId'),
    stepRunId: identifier(inputValue.stepRunId, 'stepRunId'),
    invocationPlanDigest: digest(
      inputValue.invocationPlanDigest,
      'invocationPlanDigest',
    ),
    bindingDigest: digest(inputValue.bindingDigest, 'bindingDigest'),
    adapterDigest: digest(inputValue.adapterDigest, 'adapterDigest'),
    redactionContractDigest: digest(
      inputValue.redactionContractDigest,
      'redactionContractDigest',
    ),
    auditContractDigest: digest(
      inputValue.auditContractDigest,
      'auditContractDigest',
    ),
    createdAtMs: timestamp(inputValue.createdAtMs, 'createdAtMs'),
  });
  const trace = normalizeToolExecutionTraceAnchor({
    ...traceWithoutDigest,
    traceDigest: hash(TRACE_DIGEST_DOMAIN, traceWithoutDigest),
  });
  const receiptWithoutDigest = Object.freeze({
    schema: TOOL_EXECUTION_AUDIT_RECEIPT_SCHEMA,
    eventId: audit.eventId,
    projectId: trace.projectId,
    runId: trace.runId,
    stepRunId: trace.stepRunId,
    traceId: trace.traceId,
    spanId: trace.spanId,
    traceDigest: trace.traceDigest,
    invocationPlanDigest: trace.invocationPlanDigest,
    bindingDigest: trace.bindingDigest,
    auditRecordDigest: toolExecutionAuditRecordDigest(audit),
    createdAtMs: trace.createdAtMs,
  });
  const receipt = normalizeToolExecutionAuditReceipt({
    ...receiptWithoutDigest,
    receiptDigest: hash(
      AUDIT_RECEIPT_DIGEST_DOMAIN,
      receiptWithoutDigest,
    ),
  });
  return normalizeToolExecutionEvidenceBundle({
    schema: TOOL_EXECUTION_EVIDENCE_BUNDLE_SCHEMA,
    trace,
    audit,
    receipt,
  });
}

export function toolExecutionAdmissionEvidence(
  value: ToolExecutionEvidenceBundle,
): Readonly<{
  trace: Readonly<{ traceId: string; spanId: string; digest: string }>;
  audit: Readonly<{ eventId: string; digest: string }>;
}> {
  const bundle = normalizeToolExecutionEvidenceBundle(value);
  return Object.freeze({
    trace: Object.freeze({
      traceId: bundle.trace.traceId,
      spanId: bundle.trace.spanId,
      digest: bundle.trace.traceDigest,
    }),
    audit: Object.freeze({
      eventId: bundle.receipt.eventId,
      digest: bundle.receipt.receiptDigest,
    }),
  });
}

export function normalizeListToolExecutionEvidenceQuery(
  value: ListToolExecutionEvidenceQuery,
): Readonly<ListToolExecutionEvidenceQuery> {
  const query = dataRecord(value, 'list query');
  exactKeys(query, ['limit', 'runId'], ['after'], 'list query');
  const limit = value.limit;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_TOOL_EXECUTION_EVIDENCE_PAGE_SIZE
  ) {
    return invalid('list limit is invalid');
  }
  let after: Readonly<ToolExecutionEvidenceCursor> | undefined;
  if (value.after !== undefined) {
    const cursor = dataRecord(value.after, 'list cursor');
    exactKeys(
      cursor,
      ['createdAtMs', 'spanId', 'traceId'],
      [],
      'list cursor',
    );
    after = Object.freeze({
      createdAtMs: timestamp(value.after.createdAtMs, 'cursor createdAtMs'),
      traceId: traceId(value.after.traceId),
      spanId: spanId(value.after.spanId),
    });
  }
  return Object.freeze({
    runId: identifier(value.runId, 'runId'),
    limit,
    ...(after ? { after } : {}),
  });
}

export function normalizeListToolExecutionEvidenceResult(
  value: ListToolExecutionEvidenceResult,
  queryValue: ListToolExecutionEvidenceQuery,
): Readonly<ListToolExecutionEvidenceResult> {
  const query = normalizeListToolExecutionEvidenceQuery(queryValue);
  const result = dataRecord(value, 'list result');
  exactKeys(result, ['bundles', 'truncated'], ['next'], 'list result');
  if (
    !Array.isArray(value.bundles) ||
    value.bundles.length > query.limit ||
    typeof value.truncated !== 'boolean'
  ) {
    return invalid('list result is invalid');
  }
  const bundles = value.bundles.map(normalizeToolExecutionEvidenceBundle);
  if (
    bundles.some((bundle) => bundle.trace.runId !== query.runId) ||
    bundles.some(
      (bundle, index) =>
        index > 0 &&
        (bundle.trace.createdAtMs < bundles[index - 1]!.trace.createdAtMs ||
          (bundle.trace.createdAtMs ===
            bundles[index - 1]!.trace.createdAtMs &&
            `${bundle.trace.traceId}:${bundle.trace.spanId}` <=
              `${bundles[index - 1]!.trace.traceId}:${
                bundles[index - 1]!.trace.spanId
              }`)),
    )
  ) {
    return invalid('list result ordering is invalid');
  }
  const last = bundles.at(-1);
  const expectedNext =
    value.truncated && last
      ? Object.freeze({
          createdAtMs: last.trace.createdAtMs,
          traceId: last.trace.traceId,
          spanId: last.trace.spanId,
        })
      : undefined;
  if (
    (expectedNext === undefined) !== (value.next === undefined) ||
    (expectedNext &&
      (value.next!.createdAtMs !== expectedNext.createdAtMs ||
        value.next!.traceId !== expectedNext.traceId ||
        value.next!.spanId !== expectedNext.spanId))
  ) {
    return invalid('list continuation is invalid');
  }
  return Object.freeze({
    bundles: Object.freeze(bundles),
    truncated: value.truncated,
    ...(expectedNext ? { next: expectedNext } : {}),
  });
}
