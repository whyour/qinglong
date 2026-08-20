'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    Object.defineProperty(root, 'QingLongEvidenceBundle', {
      configurable: false,
      enumerable: false,
      value: api,
      writable: false,
    });
  }
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const schema = 'qinglong/cluster-console-redacted-evidence-bundle@v1';
  const requestSchema = 'qinglong/cluster-copilot-console-read-request@v1';
  const limits = Object.freeze({
    maximumArrayItems: 64,
    maximumBundleBytes: 512 * 1024,
    maximumDepth: 16,
    maximumEntryFactBytes: 2 * 1024 * 1024 + 4 * 1024,
    maximumObjectKeys: 256,
    maximumRawBytes: 8 * 1024 * 1024,
    maximumRecords: 16,
  });
  const operations = Object.freeze([
    'inspect',
    'output',
    'run_cancellation_status',
    'run_cancellation_blocked_list',
    'run_cancellation_inspect',
    'worker_list',
    'worker_inspect',
    'package_list',
    'package_inspect',
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
  ]);
  const operationSet = new Set(operations);
  const requestFields = Object.freeze({
    inspect: ['projectId', 'requestId', 'sourceRunId'],
    output: ['projectId', 'requestId', 'sourceRunId'],
    run_cancellation_status: ['projectId', 'requestId'],
    run_cancellation_blocked_list: ['cursor', 'projectId', 'requestId'],
    run_cancellation_inspect: ['projectId', 'requestId', 'runId'],
    worker_list: ['afterWorkerId', 'projectId', 'requestId'],
    worker_inspect: ['projectId', 'requestId', 'workerId'],
    package_list: ['afterPackageName', 'projectId', 'requestId'],
    package_inspect: ['packageName', 'projectId', 'requestId'],
    run_list: [
      'afterCreatedAtMs',
      'afterRunId',
      'limit',
      'projectId',
      'requestId',
    ],
    run_read: ['projectId', 'requestId', 'runId'],
    run_event_list: [
      'afterSequence',
      'limit',
      'projectId',
      'requestId',
      'runId',
    ],
    run_step_list: [
      'afterStepKey',
      'afterStepRunId',
      'limit',
      'projectId',
      'requestId',
      'runId',
    ],
    task_list: ['afterTaskId', 'limit', 'projectId', 'requestId'],
    task_read: ['projectId', 'requestId', 'taskId'],
    workflow_list: ['packageName', 'projectId', 'requestId'],
    workflow_run_list: [
      'afterAdmittedAtMs',
      'afterRunId',
      'limit',
      'packageName',
      'projectId',
      'requestId',
      'workflowId',
    ],
    workflow_run_read: [
      'packageName',
      'projectId',
      'requestId',
      'runId',
      'workflowId',
    ],
    workflow_event_list: [
      'afterSequence',
      'limit',
      'packageName',
      'projectId',
      'requestId',
      'runId',
      'workflowId',
    ],
    workflow_step_list: [
      'afterStepKey',
      'afterStepRunId',
      'limit',
      'packageName',
      'projectId',
      'requestId',
      'runId',
      'workflowId',
    ],
  });
  const identifierDomains = Object.freeze({
    afterRunId: 'run',
    afterStepKey: 'step',
    afterStepRunId: 'step',
    afterTaskId: 'task',
    afterWorkerId: 'worker',
    afterPackageName: 'package',
    artifactId: 'artifact',
    attemptId: 'attempt',
    contentDigest: 'digest',
    cursor: 'cursor',
    diagnosisRunId: 'run',
    executionId: 'execution',
    id: 'identifier',
    modelId: 'model',
    nextAfterWorkerId: 'worker',
    nextAfterPackageName: 'package',
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
  const safeContainers = new Set([
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
    'declaredCapacity',
    'runtimes',
    'worker',
    'workers',
    'installation',
    'installations',
    'usage',
    'workflow',
    'workflows',
  ]);
  const safeBooleans = new Set([
    'active',
    'archived',
    'available',
    'cancelRequested',
    'enabled',
    'found',
    'hasMore',
    'outputAvailable',
    'ready',
    'replayed',
    'tailComplete',
    'terminal',
    'truncated',
  ]);
  const safeEnumKeys = new Set([
    'finishReason',
    'assessment',
    'cancelReason',
    'kind',
    'architecture',
    'compatibility',
    'lifecycle',
    'lastResult',
    'operation',
    'operatorAction',
    'outcome',
    'runStatus',
    'severity',
    'stage',
    'status',
    'supportTier',
    'operatingSystem',
    'availability',
    'failureReason',
    'installOperation',
    'quarantineReason',
    'recoveryAction',
    'state',
  ]);
  const safeEnumValues = new Set([
    'accepted',
    'active',
    'admission',
    'attention_required',
    'available',
    'amd64',
    'arm64',
    'ppc64le',
    's390x',
    'arm/v7',
    'arm/v6',
    '386',
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
    'default_placement',
    'explicit_placement_required',
    'protocol_incompatible',
    'online',
    'draining',
    'offline',
    'lease_expired',
    'tier1',
    'candidate',
    'experimental',
    'legacy-only',
    'linux',
    'darwin',
    'win32',
    'freebsd',
    'aix',
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
    'not_active',
    'install',
    'reinstall',
    'upgrade',
    'rollback',
    'resume_stage',
    'resume_activation',
    'inspect_activation',
    'source_unavailable',
    'source_mismatch',
    'stage_failed',
    'activation_failed',
    'activation_fact_conflict',
    'approval_expired',
    'policy_fence_changed',
    'resource_exhausted',
    'suspected_key_compromise',
    'confirmed_key_compromise',
  ]);
  const sensitiveKey =
    /credential|token|authorization|secret|session|password|cookie|private|keyring/iu;
  const freeTextKey =
    /text|content|stdout|stderr|command|input|output|environment|reason|error|message|description|name|path|url|uri|host|endpoint/iu;
  const numericKey =
    /^(?:schemaVersion|version|revision|sequence|attempt|priority|limit|offset|size|total|count|exitCode|pending|leased|retryWait|dispatched|blocked|due|expiredLease|identityMismatch|pidMismatch|unsupported|invalid|availableSlots|maxConcurrentRuns|cpuCores|targetGeneration|[A-Za-z0-9_]*(?:AtMs|TimeMs|DurationMs|Bytes|Tokens|Micros|Sequence|Version|Count|Limit|Offset|Size|Total))$/u;
  const schemaValue = /^[a-z0-9][a-z0-9./_-]{0,126}@[a-z0-9._-]{1,16}$/u;

  class ClusterConsoleEvidenceBundleError extends TypeError {
    constructor() {
      super('Cluster Console evidence bundle input is invalid');
      this.name = 'ClusterConsoleEvidenceBundleError';
      this.code = 'QL3_CLUSTER_CONSOLE_EVIDENCE_BUNDLE_INVALID';
    }
  }

  const invalid = function () {
    throw new ClusterConsoleEvidenceBundleError();
  };

  const plainObject = function (value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };

  const safeInteger = function (value) {
    return Number.isSafeInteger(value) && value >= 0;
  };

  const canonicalValue = function (value, depth, stack) {
    if (depth > limits.maximumDepth) return invalid();
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return invalid();
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    if (typeof value === 'string') return JSON.stringify(value);
    if (!value || typeof value !== 'object') return invalid();
    if (stack.has(value)) return invalid();
    stack.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > limits.maximumArrayItems) return invalid();
        return (
          '[' +
          value
            .map(function (item) {
              return canonicalValue(item, depth + 1, stack);
            })
            .join(',') +
          ']'
        );
      }
      if (!plainObject(value)) return invalid();
      const keys = Object.keys(value).sort();
      if (keys.length > limits.maximumObjectKeys) return invalid();
      return (
        '{' +
        keys
          .map(function (key) {
            return (
              JSON.stringify(key) +
              ':' +
              canonicalValue(value[key], depth + 1, stack)
            );
          })
          .join(',') +
        '}'
      );
    } finally {
      stack.delete(value);
    }
  };

  const canonicalize = function (value) {
    return canonicalValue(value, 0, new WeakSet());
  };

  const utf8Bytes = function (value) {
    return new TextEncoder().encode(value);
  };

  const sha256 = async function (value, cryptography) {
    if (
      !cryptography ||
      !cryptography.subtle ||
      typeof cryptography.subtle.digest !== 'function'
    ) {
      return invalid();
    }
    const bytes = utf8Bytes(value);
    const digest = await cryptography.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  };

  const exactKeys = function (value, expected) {
    if (!plainObject(value)) return false;
    const actual = Object.keys(value).sort();
    const normalized = expected.slice().sort();
    return (
      actual.length === normalized.length &&
      actual.every(function (key, index) {
        return key === normalized[index];
      })
    );
  };

  const validateRecord = function (record) {
    if (
      !exactKeys(record, ['fact', 'observedAtMs', 'operation', 'request']) ||
      !operationSet.has(record.operation) ||
      !safeInteger(record.observedAtMs) ||
      !plainObject(record.fact)
    ) {
      return invalid();
    }
    const fields = requestFields[record.operation];
    if (
      !exactKeys(record.request, ['operation', 'schema'].concat(fields)) ||
      record.request.schema !== requestSchema ||
      record.request.operation !== record.operation
    ) {
      return invalid();
    }
    canonicalize(record.request);
    const factCanonical = canonicalize(record.fact);
    const factBytes = utf8Bytes(factCanonical).byteLength;
    if (factBytes < 2 || factBytes > limits.maximumEntryFactBytes) {
      return invalid();
    }
    return Object.freeze({ factBytes, factCanonical });
  };

  const createAliaser = function () {
    const counters = new Map();
    const values = new Map();
    return function (domain, value) {
      if (value === null) return null;
      if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
        return invalid();
      }
      const identity = domain + '\0' + value;
      const existing = values.get(identity);
      if (existing) return existing;
      const next = (counters.get(domain) || 0) + 1;
      counters.set(domain, next);
      const alias = domain + '-' + String(next).padStart(3, '0');
      values.set(identity, alias);
      return alias;
    };
  };

  const sanitizeValue = function (value, operation, alias, state, depth) {
    if (depth > limits.maximumDepth) return invalid();
    if (Array.isArray(value)) {
      return value.slice(0, limits.maximumArrayItems).map(function (item) {
        if (plainObject(item) || Array.isArray(item)) {
          return sanitizeValue(item, operation, alias, state, depth + 1);
        }
        state.omittedFieldCount += 1;
        return null;
      });
    }
    if (!plainObject(value)) return invalid();
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const candidate = value[key];
      const domain = identifierDomains[key];
      if (sensitiveKey.test(key)) {
        state.omittedFieldCount += 1;
        continue;
      }
      if (domain) {
        if (candidate === null || typeof candidate === 'string') {
          result[key] = alias(domain, candidate);
        } else {
          state.omittedFieldCount += 1;
        }
        continue;
      }
      if (/Digest$/u.test(key)) {
        if (candidate === null || typeof candidate === 'string') {
          result[key] = alias('digest', candidate);
        } else {
          state.omittedFieldCount += 1;
        }
        continue;
      }
      if (key === 'schema') {
        if (typeof candidate === 'string' && schemaValue.test(candidate)) {
          result[key] = candidate;
        } else {
          state.omittedFieldCount += 1;
        }
        continue;
      }
      if (safeEnumKeys.has(key)) {
        if (candidate === null) {
          result[key] = null;
        } else if (
          typeof candidate === 'string' &&
          (key === 'operation'
            ? operationSet.has(candidate)
            : safeEnumValues.has(candidate))
        ) {
          result[key] = candidate;
        } else {
          state.omittedFieldCount += 1;
        }
        continue;
      }
      if (safeBooleans.has(key)) {
        if (typeof candidate === 'boolean' || candidate === null) {
          result[key] = candidate;
        } else {
          state.omittedFieldCount += 1;
        }
        continue;
      }
      if (numericKey.test(key)) {
        if (safeInteger(candidate) || candidate === null) {
          result[key] = candidate;
        } else {
          state.omittedFieldCount += 1;
        }
        continue;
      }
      if (freeTextKey.test(key) || key === 'result') {
        state.omittedFieldCount += 1;
        continue;
      }
      if (safeContainers.has(key)) {
        if (plainObject(candidate) || Array.isArray(candidate)) {
          result[key] = sanitizeValue(
            candidate,
            operation,
            alias,
            state,
            depth + 1,
          );
        } else if (candidate === null) {
          result[key] = null;
        } else {
          state.omittedFieldCount += 1;
        }
        continue;
      }
      state.omittedFieldCount += 1;
    }
    return result;
  };

  const deepFreeze = function (value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
      return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
  };

  const measureClusterConsoleEvidenceRecord = function (record) {
    return validateRecord(record).factBytes;
  };

  const createClusterConsoleEvidenceBundle = async function (
    records,
    generatedAtMs,
    cryptography,
  ) {
    if (
      !Array.isArray(records) ||
      records.length < 1 ||
      records.length > limits.maximumRecords ||
      !safeInteger(generatedAtMs)
    ) {
      return invalid();
    }
    const cryptoProvider = cryptography || globalThis.crypto;
    const alias = createAliaser();
    let totalRawBytes = 0;
    const entries = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const validated = validateRecord(record);
      totalRawBytes += validated.factBytes;
      if (totalRawBytes > limits.maximumRawBytes) return invalid();
      const state = { omittedFieldCount: 0 };
      const target = sanitizeValue(
        record.request,
        record.operation,
        alias,
        state,
        0,
      );
      const fact = sanitizeValue(
        record.fact,
        record.operation,
        alias,
        state,
        0,
      );
      entries.push({
        sequence: index + 1,
        observedAtMs: record.observedAtMs,
        operation: record.operation,
        target,
        fact,
        rawFact: {
          canonicalBytes: validated.factBytes,
          sha256: await sha256(validated.factCanonical, cryptoProvider),
        },
        sanitizer: {
          omittedFieldCount: state.omittedFieldCount,
          rawContentIncluded: false,
        },
      });
    }
    const unsigned = {
      schema,
      classification: 'low_sensitive_redacted',
      generatedAtMs,
      generatedBy: 'browser_local',
      actionAuthority: 'none',
      attestation: 'none',
      source: {
        surface: 'cluster_field_ledger',
        collection: 'explicit_user_reads_only',
        entryCount: entries.length,
        totalRawCanonicalBytes: totalRawBytes,
      },
      redaction: {
        policy: 'fixed_allowlist_v1',
        identifiers: 'per_bundle_typed_alias_without_mapping',
        freeTextIncluded: false,
        copilotOutputIncluded: false,
        unknownFieldsIncluded: false,
      },
      integrity: {
        algorithm: 'sha256',
        scope: 'canonical_bundle_without_contentDigest',
        serverSignature: false,
        durableAudit: false,
      },
      entries,
    };
    const contentDigest = await sha256(canonicalize(unsigned), cryptoProvider);
    const bundle = { ...unsigned, contentDigest };
    const encoded = JSON.stringify(bundle, null, 2) + '\n';
    if (utf8Bytes(encoded).byteLength > limits.maximumBundleBytes) {
      return invalid();
    }
    return deepFreeze(bundle);
  };

  const serializeClusterConsoleEvidenceBundle = function (bundle) {
    if (
      !plainObject(bundle) ||
      bundle.schema !== schema ||
      typeof bundle.contentDigest !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(bundle.contentDigest)
    ) {
      return invalid();
    }
    const encoded = JSON.stringify(bundle, null, 2) + '\n';
    if (utf8Bytes(encoded).byteLength > limits.maximumBundleBytes) {
      return invalid();
    }
    return encoded;
  };

  const verifyClusterConsoleEvidenceBundle = async function (
    bundle,
    cryptography,
  ) {
    if (!plainObject(bundle) || typeof bundle.contentDigest !== 'string') {
      return false;
    }
    const unsigned = {};
    for (const key of Object.keys(bundle)) {
      if (key !== 'contentDigest') unsigned[key] = bundle[key];
    }
    try {
      return (
        /^[0-9a-f]{64}$/u.test(bundle.contentDigest) &&
        (await sha256(
          canonicalize(unsigned),
          cryptography || globalThis.crypto,
        )) === bundle.contentDigest
      );
    } catch {
      return false;
    }
  };

  return Object.freeze({
    ClusterConsoleEvidenceBundleError,
    createClusterConsoleEvidenceBundle,
    limits,
    measureClusterConsoleEvidenceRecord,
    operations,
    schema,
    serializeClusterConsoleEvidenceBundle,
    verifyClusterConsoleEvidenceBundle,
  });
});
