/** Offline verifier for browser-local redacted Cluster Console evidence. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, normalize, parse } from 'node:path';
import { TextDecoder } from 'node:util';

export const CLUSTER_CONSOLE_EVIDENCE_BUNDLE_SCHEMA =
  'qinglong/cluster-console-redacted-evidence-bundle@v1';
export const CLUSTER_CONSOLE_EVIDENCE_VERIFICATION_SCHEMA =
  'qinglong/cluster-console-evidence-verification@v1';

const REQUEST_SCHEMA = 'qinglong/cluster-copilot-console-read-request@v1';
const MAXIMUM_PATH_BYTES = 4 * 1024;
const LIMITS = Object.freeze({
  maximumArrayItems: 64,
  maximumBundleBytes: 512 * 1024,
  maximumDepth: 16,
  maximumEntryFactBytes: 2 * 1024 * 1024 + 4 * 1024,
  maximumObjectKeys: 256,
  maximumRawBytes: 8 * 1024 * 1024,
  maximumRecords: 16,
});
const OPERATIONS = Object.freeze([
  'inspect',
  'output',
  'run_cancellation_status',
  'run_cancellation_blocked_list',
  'run_cancellation_inspect',
  'run_list',
  'run_read',
  'run_event_list',
  'run_step_list',
  'task_list',
  'task_read',
  'workflow_list',
  'workflow_run_list',
  'workflow_run_read',
  'workflow_event_list',
  'workflow_step_list',
] as const);
type EvidenceOperation = (typeof OPERATIONS)[number];
const OPERATION_SET = new Set<string>(OPERATIONS);
const REQUEST_FIELDS: Readonly<Record<EvidenceOperation, readonly string[]>> =
  Object.freeze({
    inspect: Object.freeze(['projectId', 'requestId', 'sourceRunId']),
    output: Object.freeze(['projectId', 'requestId', 'sourceRunId']),
    run_cancellation_status: Object.freeze(['projectId', 'requestId']),
    run_cancellation_blocked_list: Object.freeze([
      'cursor',
      'projectId',
      'requestId',
    ]),
    run_cancellation_inspect: Object.freeze([
      'projectId',
      'requestId',
      'runId',
    ]),
    run_list: Object.freeze([
      'afterCreatedAtMs',
      'afterRunId',
      'limit',
      'projectId',
      'requestId',
    ]),
    run_read: Object.freeze(['projectId', 'requestId', 'runId']),
    run_event_list: Object.freeze([
      'afterSequence',
      'limit',
      'projectId',
      'requestId',
      'runId',
    ]),
    run_step_list: Object.freeze([
      'afterStepKey',
      'afterStepRunId',
      'limit',
      'projectId',
      'requestId',
      'runId',
    ]),
    task_list: Object.freeze([
      'afterTaskId',
      'limit',
      'projectId',
      'requestId',
    ]),
    task_read: Object.freeze(['projectId', 'requestId', 'taskId']),
    workflow_list: Object.freeze(['packageName', 'projectId', 'requestId']),
    workflow_run_list: Object.freeze([
      'afterAdmittedAtMs',
      'afterRunId',
      'limit',
      'packageName',
      'projectId',
      'requestId',
      'workflowId',
    ]),
    workflow_run_read: Object.freeze([
      'packageName',
      'projectId',
      'requestId',
      'runId',
      'workflowId',
    ]),
    workflow_event_list: Object.freeze([
      'afterSequence',
      'limit',
      'packageName',
      'projectId',
      'requestId',
      'runId',
      'workflowId',
    ]),
    workflow_step_list: Object.freeze([
      'afterStepKey',
      'afterStepRunId',
      'limit',
      'packageName',
      'projectId',
      'requestId',
      'runId',
      'workflowId',
    ]),
  });
const IDENTIFIER_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  afterRunId: 'run',
  afterStepKey: 'step',
  afterStepRunId: 'step',
  afterTaskId: 'task',
  artifactId: 'artifact',
  attemptId: 'attempt',
  contentDigest: 'digest',
  cursor: 'cursor',
  diagnosisRunId: 'run',
  executionId: 'execution',
  id: 'identifier',
  modelId: 'model',
  outputRef: 'artifact',
  packageName: 'package',
  projectId: 'project',
  providerId: 'provider',
  requestId: 'request',
  runId: 'run',
  sourceRunId: 'run',
  stepKey: 'step',
  stepRunId: 'step',
  taskId: 'task',
  triggerId: 'trigger',
  workflowId: 'workflow',
  workerId: 'worker',
});
const SAFE_CONTAINERS = new Set([
  'attempts',
  'blockingResults',
  'counts',
  'dispatch',
  'dispatches',
  'events',
  'items',
  'metadata',
  'next',
  'reference',
  'run',
  'runs',
  'source',
  'signals',
  'step',
  'steps',
  'summary',
  'target',
  'task',
  'tasks',
  'usage',
  'workflow',
  'workflows',
]);
const SAFE_BOOLEANS = new Set([
  'active',
  'archived',
  'available',
  'cancelRequested',
  'enabled',
  'hasMore',
  'outputAvailable',
  'ready',
  'replayed',
  'tailComplete',
  'terminal',
  'truncated',
]);
const SAFE_ENUM_KEYS = new Set([
  'assessment',
  'cancelReason',
  'finishReason',
  'kind',
  'lastResult',
  'operation',
  'operatorAction',
  'outcome',
  'runStatus',
  'severity',
  'stage',
  'status',
]);
const SAFE_ENUM_VALUES = new Set([
  'accepted',
  'active',
  'admission',
  'attention_required',
  'available',
  'blocked',
  'cancelled',
  'completed',
  'completion',
  'converging',
  'critical',
  'clear',
  'dispatch',
  'dispatching',
  'disabled',
  'enabled',
  'execution',
  'failed',
  'finalization',
  'installed',
  'inspect',
  'invalid',
  'identity_mismatch',
  'local',
  'lost',
  'missing',
  'model',
  'none',
  'not_found',
  'pending',
  'pid_mismatch',
  'policy',
  'post_model',
  'pre_model',
  'prompt',
  'quarantined',
  'queued',
  'ready',
  'recovery',
  'rearm',
  'reconcile',
  'rejected',
  'remote',
  'retained',
  'retired',
  'retry_wait',
  'run',
  'running',
  'skipped',
  'staged',
  'staging',
  'step',
  'stop',
  'succeeded',
  'shutdown',
  'system',
  'task',
  'terminal',
  'timed_out',
  'timeout',
  'tool',
  'trigger',
  'unknown',
  'unsupported',
  'user',
  'wait',
  'warning',
  'ok',
  'unavailable',
  'workflow',
]);
const NUMERIC_KEY =
  /^(?:schemaVersion|version|revision|sequence|attempt|priority|limit|offset|size|total|count|exitCode|pending|leased|retryWait|dispatched|blocked|due|expiredLease|identityMismatch|pidMismatch|unsupported|invalid|[A-Za-z0-9_]*(?:AtMs|TimeMs|DurationMs|Bytes|Tokens|Micros|Sequence|Version|Count|Limit|Offset|Size|Total))$/u;
const SCHEMA_VALUE = /^[a-z0-9][a-z0-9./_-]{0,126}@[a-z0-9._-]{1,16}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CONTROL = /[\0-\x1f\x7f]/u;

export interface ClusterConsoleEvidenceVerification {
  readonly schema: typeof CLUSTER_CONSOLE_EVIDENCE_VERIFICATION_SCHEMA;
  readonly status: 'verified';
  readonly bundle: Readonly<{
    schema: typeof CLUSTER_CONSOLE_EVIDENCE_BUNDLE_SCHEMA;
    contentDigest: string;
    entryCount: number;
    totalRawCanonicalBytes: number;
  }>;
  readonly integrity: Readonly<{
    bundleDigest: 'verified';
    rawFactDigests: 'not_recomputed_without_raw_facts';
  }>;
  readonly claims: Readonly<{
    serverSignature: 'not_verified';
    attestation: 'not_verified';
    durableAudit: 'not_verified';
    actionAuthority: 'none';
  }>;
  readonly execution: Readonly<{
    networkAccess: false;
    mutation: false;
    fileWrites: false;
  }>;
}

export class ClusterConsoleEvidenceVerificationError extends TypeError {
  readonly code = 'QL3_CLUSTER_CONSOLE_EVIDENCE_VERIFICATION_INVALID';

  constructor() {
    super('Cluster Console evidence bundle verification failed');
    this.name = 'ClusterConsoleEvidenceVerificationError';
  }
}

function invalid(): never {
  throw new ClusterConsoleEvidenceVerificationError();
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function sortedKeys(value: Readonly<Record<string, unknown>>): boolean {
  const actual = Object.keys(value);
  const sorted = [...actual].sort();
  return actual.every((key, index) => key === sorted[index]);
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalValue(
  value: unknown,
  depth: number,
  stack: WeakSet<object>,
): string {
  if (depth > LIMITS.maximumDepth) return invalid();
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalid();
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null || typeof value !== 'object') return invalid();
  if (stack.has(value)) return invalid();
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > LIMITS.maximumArrayItems) return invalid();
      return `[${value
        .map((item) => canonicalValue(item, depth + 1, stack))
        .join(',')}]`;
    }
    if (!plainObject(value)) return invalid();
    const keys = Object.keys(value).sort();
    if (keys.length > LIMITS.maximumObjectKeys) return invalid();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalValue(
            value[key],
            depth + 1,
            stack,
          )}`,
      )
      .join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

function canonicalize(value: unknown): string {
  return canonicalValue(value, 0, new WeakSet());
}

interface AliasState {
  readonly nextByDomain: Map<string, number>;
  readonly seen: Set<string>;
}

function validateAlias(
  domain: string,
  value: unknown,
  aliases: AliasState,
): void {
  if (value === null) return;
  if (typeof value !== 'string') return invalid();
  const prefix = `${domain}-`;
  if (!value.startsWith(prefix)) return invalid();
  const suffix = value.slice(prefix.length);
  if (!/^[0-9]{3,}$/u.test(suffix)) return invalid();
  const numeric = Number(suffix);
  if (
    !Number.isSafeInteger(numeric) ||
    numeric < 1 ||
    String(numeric).padStart(3, '0') !== suffix
  ) {
    return invalid();
  }
  const identity = `${domain}\0${suffix}`;
  if (aliases.seen.has(identity)) return;
  const expected = aliases.nextByDomain.get(domain) ?? 1;
  if (numeric !== expected) return invalid();
  aliases.seen.add(identity);
  aliases.nextByDomain.set(domain, expected + 1);
}

function validateSafeValue(
  value: unknown,
  aliases: AliasState,
  depth: number,
): void {
  if (depth > LIMITS.maximumDepth) return invalid();
  if (Array.isArray(value)) {
    if (value.length > LIMITS.maximumArrayItems) return invalid();
    for (const item of value) {
      if (item === null) continue;
      if (!plainObject(item) && !Array.isArray(item)) return invalid();
      validateSafeValue(item, aliases, depth + 1);
    }
    return;
  }
  if (!plainObject(value) || !sortedKeys(value)) return invalid();
  const keys = Object.keys(value);
  if (keys.length > LIMITS.maximumObjectKeys) return invalid();
  for (const key of keys) {
    const candidate = value[key];
    const domain = IDENTIFIER_DOMAINS[key];
    if (domain !== undefined) {
      validateAlias(domain, candidate, aliases);
      continue;
    }
    if (/Digest$/u.test(key)) {
      validateAlias('digest', candidate, aliases);
      continue;
    }
    if (key === 'schema') {
      if (typeof candidate !== 'string' || !SCHEMA_VALUE.test(candidate)) {
        return invalid();
      }
      continue;
    }
    if (SAFE_ENUM_KEYS.has(key)) {
      if (
        candidate !== null &&
        (typeof candidate !== 'string' ||
          (key === 'operation'
            ? !OPERATION_SET.has(candidate)
            : !SAFE_ENUM_VALUES.has(candidate)))
      ) {
        return invalid();
      }
      continue;
    }
    if (SAFE_BOOLEANS.has(key)) {
      if (candidate !== null && typeof candidate !== 'boolean') {
        return invalid();
      }
      continue;
    }
    if (NUMERIC_KEY.test(key)) {
      if (candidate !== null && !safeInteger(candidate)) return invalid();
      continue;
    }
    if (SAFE_CONTAINERS.has(key)) {
      if (candidate === null) continue;
      if (!plainObject(candidate) && !Array.isArray(candidate))
        return invalid();
      validateSafeValue(candidate, aliases, depth + 1);
      continue;
    }
    return invalid();
  }
}

function validateTarget(
  value: unknown,
  operation: EvidenceOperation,
  aliases: AliasState,
): void {
  const fields = REQUEST_FIELDS[operation];
  if (!exactKeys(value, ['operation', 'schema', ...fields])) return invalid();
  if (!sortedKeys(value)) return invalid();
  if (value.schema !== REQUEST_SCHEMA || value.operation !== operation) {
    return invalid();
  }
  for (const field of fields) {
    const domain = IDENTIFIER_DOMAINS[field];
    if (domain !== undefined) {
      validateAlias(domain, value[field], aliases);
      continue;
    }
    if (!NUMERIC_KEY.test(field)) return invalid();
    const candidate = value[field];
    if (candidate !== null && !safeInteger(candidate)) return invalid();
  }
}

function validateBundle(value: unknown): ClusterConsoleEvidenceVerification {
  if (
    !exactKeys(value, [
      'actionAuthority',
      'attestation',
      'classification',
      'contentDigest',
      'entries',
      'generatedAtMs',
      'generatedBy',
      'integrity',
      'redaction',
      'schema',
      'source',
    ]) ||
    value.schema !== CLUSTER_CONSOLE_EVIDENCE_BUNDLE_SCHEMA ||
    value.classification !== 'low_sensitive_redacted' ||
    !safeInteger(value.generatedAtMs) ||
    value.generatedBy !== 'browser_local' ||
    value.actionAuthority !== 'none' ||
    value.attestation !== 'none' ||
    typeof value.contentDigest !== 'string' ||
    !SHA256.test(value.contentDigest)
  ) {
    return invalid();
  }
  if (
    !exactKeys(value.source, [
      'collection',
      'entryCount',
      'surface',
      'totalRawCanonicalBytes',
    ]) ||
    value.source.surface !== 'cluster_field_ledger' ||
    value.source.collection !== 'explicit_user_reads_only' ||
    !safeInteger(value.source.entryCount) ||
    !safeInteger(value.source.totalRawCanonicalBytes)
  ) {
    return invalid();
  }
  if (
    !exactKeys(value.redaction, [
      'copilotOutputIncluded',
      'freeTextIncluded',
      'identifiers',
      'policy',
      'unknownFieldsIncluded',
    ]) ||
    value.redaction.policy !== 'fixed_allowlist_v1' ||
    value.redaction.identifiers !== 'per_bundle_typed_alias_without_mapping' ||
    value.redaction.freeTextIncluded !== false ||
    value.redaction.copilotOutputIncluded !== false ||
    value.redaction.unknownFieldsIncluded !== false
  ) {
    return invalid();
  }
  if (
    !exactKeys(value.integrity, [
      'algorithm',
      'durableAudit',
      'scope',
      'serverSignature',
    ]) ||
    value.integrity.algorithm !== 'sha256' ||
    value.integrity.scope !== 'canonical_bundle_without_contentDigest' ||
    value.integrity.serverSignature !== false ||
    value.integrity.durableAudit !== false
  ) {
    return invalid();
  }
  if (
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > LIMITS.maximumRecords ||
    value.source.entryCount !== value.entries.length
  ) {
    return invalid();
  }

  const aliases: AliasState = {
    nextByDomain: new Map(),
    seen: new Set(),
  };
  let totalRawCanonicalBytes = 0;
  for (let index = 0; index < value.entries.length; index += 1) {
    const entry = value.entries[index];
    if (
      !exactKeys(entry, [
        'fact',
        'observedAtMs',
        'operation',
        'rawFact',
        'sanitizer',
        'sequence',
        'target',
      ]) ||
      entry.sequence !== index + 1 ||
      !safeInteger(entry.observedAtMs) ||
      typeof entry.operation !== 'string' ||
      !OPERATION_SET.has(entry.operation)
    ) {
      return invalid();
    }
    const operation = entry.operation as EvidenceOperation;
    validateTarget(entry.target, operation, aliases);
    validateSafeValue(entry.fact, aliases, 0);
    if (
      !exactKeys(entry.rawFact, ['canonicalBytes', 'sha256']) ||
      !safeInteger(entry.rawFact.canonicalBytes) ||
      entry.rawFact.canonicalBytes < 2 ||
      entry.rawFact.canonicalBytes > LIMITS.maximumEntryFactBytes ||
      typeof entry.rawFact.sha256 !== 'string' ||
      !SHA256.test(entry.rawFact.sha256)
    ) {
      return invalid();
    }
    totalRawCanonicalBytes += entry.rawFact.canonicalBytes;
    if (totalRawCanonicalBytes > LIMITS.maximumRawBytes) return invalid();
    if (
      !exactKeys(entry.sanitizer, [
        'omittedFieldCount',
        'rawContentIncluded',
      ]) ||
      !safeInteger(entry.sanitizer.omittedFieldCount) ||
      entry.sanitizer.rawContentIncluded !== false
    ) {
      return invalid();
    }
  }
  if (value.source.totalRawCanonicalBytes !== totalRawCanonicalBytes) {
    return invalid();
  }

  const unsigned: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key !== 'contentDigest') unsigned[key] = value[key];
  }
  const computed = createHash('sha256')
    .update(canonicalize(unsigned), 'utf8')
    .digest('hex');
  if (computed !== value.contentDigest) return invalid();

  return Object.freeze({
    schema: CLUSTER_CONSOLE_EVIDENCE_VERIFICATION_SCHEMA,
    status: 'verified',
    bundle: Object.freeze({
      schema: CLUSTER_CONSOLE_EVIDENCE_BUNDLE_SCHEMA,
      contentDigest: value.contentDigest,
      entryCount: value.entries.length,
      totalRawCanonicalBytes,
    }),
    integrity: Object.freeze({
      bundleDigest: 'verified',
      rawFactDigests: 'not_recomputed_without_raw_facts',
    }),
    claims: Object.freeze({
      serverSignature: 'not_verified',
      attestation: 'not_verified',
      durableAudit: 'not_verified',
      actionAuthority: 'none',
    }),
    execution: Object.freeze({
      networkAccess: false,
      mutation: false,
      fileWrites: false,
    }),
  });
}

function readStableBundle(filePath: string): Buffer {
  if (
    !isAbsolute(filePath) ||
    normalize(filePath) !== filePath ||
    parse(filePath).root === filePath ||
    Buffer.byteLength(filePath, 'utf8') > MAXIMUM_PATH_BYTES ||
    CONTROL.test(filePath)
  ) {
    return invalid();
  }
  let descriptor = -1;
  let bytes: Buffer | undefined;
  try {
    if (realpathSync(filePath) !== filePath) return invalid();
    descriptor = openSync(
      filePath,
      constants.O_RDONLY |
        ((constants as unknown as Readonly<Record<string, number>>).O_CLOEXEC ??
          0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.size < 2 ||
      before.size > LIMITS.maximumBundleBytes
    ) {
      return invalid();
    }
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read < 1) return invalid();
      offset += read;
    }
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.gid !== before.gid ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      return invalid();
    }
    return bytes;
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof ClusterConsoleEvidenceVerificationError) throw error;
    return invalid();
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

export function verifyClusterConsoleEvidenceBundleFile(
  filePath: string,
): ClusterConsoleEvidenceVerification {
  const bytes = readStableBundle(filePath);
  try {
    if (
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
    ) {
      return invalid();
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return invalid();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return invalid();
    }
    if (`${JSON.stringify(parsed, null, 2)}\n` !== text) return invalid();
    return validateBundle(parsed);
  } finally {
    bytes.fill(0);
  }
}
