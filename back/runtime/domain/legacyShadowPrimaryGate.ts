export const LEGACY_SHADOW_PRIMARY_GATE_SCHEMA =
  'qinglong/legacy-shadow-primary-gate@v1';

export type LegacyShadowPrimaryGateViolation =
  | 'capture_schema_invalid'
  | 'capture_profile_mismatch'
  | 'capture_not_qualified'
  | 'capture_origin_coverage_invalid'
  | 'capture_window_invalid'
  | 'capture_sample_budget_invalid'
  | 'capture_conservation_invalid'
  | 'startup_not_converged'
  | 'terminal_schema_invalid'
  | 'terminal_profile_mismatch'
  | 'terminal_window_mismatch'
  | 'terminal_coverage_invalid'
  | 'terminal_not_matched'
  | 'resource_schema_invalid'
  | 'resource_profile_mismatch'
  | 'resource_not_qualified'
  | 'resource_not_compiled_full_rollback';

export interface LegacyShadowPrimaryGateReceipt {
  schema: typeof LEGACY_SHADOW_PRIMARY_GATE_SCHEMA;
  schemaVersion: 1;
  profile: 'edge' | 'standalone';
  origin: 'manual';
  generatedAtMs: number;
  assessment: 'eligible' | 'ineligible';
  window: {
    startInclusiveMs: number;
    endExclusiveMs: number;
  };
  counts: {
    admitted: number;
    captured: number;
    terminalScanned: number;
    terminalMatched: number;
  };
  evidence: {
    captureSha256: string;
    terminalSha256: string;
    resourceSha256: string;
  };
  sources: {
    capture: unknown;
    terminal: unknown;
    resource: unknown;
  };
  violations: readonly LegacyShadowPrimaryGateViolation[];
}

export interface LegacyShadowPrimaryGateInput {
  profile: 'edge' | 'standalone';
  generatedAtMs: number;
  capture: unknown;
  terminal: unknown;
  resource: unknown;
}

const SAMPLE_BUDGETS = Object.freeze({
  edge: { minimum: 8, maximum: 8 },
  standalone: { minimum: 32, maximum: 128 },
});
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function object(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function add(
  violations: LegacyShadowPrimaryGateViolation[],
  violation: LegacyShadowPrimaryGateViolation,
): void {
  if (!violations.includes(violation)) violations.push(violation);
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Evidence number is invalid');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = object(value);
  if (!record) throw new TypeError('Evidence contains a non-JSON value');
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function legacyShadowPrimaryEvidenceSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function createLegacyShadowPrimaryGateReceipt(
  input: LegacyShadowPrimaryGateInput,
): LegacyShadowPrimaryGateReceipt {
  if (input.profile !== 'edge' && input.profile !== 'standalone') {
    throw new TypeError('Primary gate profile is invalid');
  }
  if (!safeCount(input.generatedAtMs)) {
    throw new TypeError('Primary gate timestamp is invalid');
  }
  const sources = {
    capture: JSON.parse(canonicalJson(input.capture)),
    terminal: JSON.parse(canonicalJson(input.terminal)),
    resource: JSON.parse(canonicalJson(input.resource)),
  };
  const evidence = {
    captureSha256: legacyShadowPrimaryEvidenceSha256(sources.capture),
    terminalSha256: legacyShadowPrimaryEvidenceSha256(sources.terminal),
    resourceSha256: legacyShadowPrimaryEvidenceSha256(sources.resource),
  };
  const violations: LegacyShadowPrimaryGateViolation[] = [];
  const captureEvidence = object(sources.capture);
  const capture = object(captureEvidence?.capture);
  const startup = object(captureEvidence?.startup);
  const captureWindow = object(capture?.window);
  const captureTotals = object(capture?.totals);
  const captureByOriginValue = capture?.byOrigin;
  const captureByOrigin = Array.isArray(captureByOriginValue)
    ? captureByOriginValue
    : [];
  const admittedValue = captureTotals?.admitted;
  const capturedValue = captureTotals?.captured;
  const admitted = safeCount(admittedValue) ? admittedValue : 0;
  const captured = safeCount(capturedValue) ? capturedValue : 0;

  if (
    captureEvidence?.schema !== 'qinglong/legacy-shadow-capture-evidence@v1' ||
    capture?.schema !== 'qinglong/legacy-shadow-capture-report@v1'
  ) {
    add(violations, 'capture_schema_invalid');
  }
  if (
    captureEvidence?.profile !== input.profile ||
    capture?.profile !== input.profile
  ) {
    add(violations, 'capture_profile_mismatch');
  }
  if (
    object(captureEvidence?.qualification)?.passed !== true ||
    capture?.assessment !== 'captured' ||
    capture?.capturePermille !== 1_000
  ) {
    add(violations, 'capture_not_qualified');
  }
  if (
    capture?.configuredOriginCount !== 1 ||
    captureByOrigin.length !== 1 ||
    object(captureByOrigin[0])?.origin !== 'manual' ||
    startup?.configuredOriginCount !== 1 ||
    !Array.isArray(startup?.byOrigin) ||
    startup.byOrigin.length !== 1 ||
    object(startup.byOrigin[0])?.origin !== 'manual'
  ) {
    add(violations, 'capture_origin_coverage_invalid');
  }
  const startInclusiveMs = captureWindow?.startInclusiveMs;
  const endExclusiveMs = captureWindow?.endExclusiveMs;
  if (
    captureWindow?.basis !== 'process_local_legacy_admission' ||
    !safeCount(startInclusiveMs) ||
    !safeCount(endExclusiveMs) ||
    startInclusiveMs >= endExclusiveMs ||
    endExclusiveMs > input.generatedAtMs
  ) {
    add(violations, 'capture_window_invalid');
  }
  const budget = SAMPLE_BUDGETS[input.profile];
  if (admitted < budget.minimum || admitted > budget.maximum) {
    add(violations, 'capture_sample_budget_invalid');
  }
  if (
    !safeCount(captureTotals?.failed) ||
    !safeCount(captureTotals?.pending) ||
    captured !== admitted ||
    captureTotals?.failed !== 0 ||
    captureTotals?.pending !== 0
  ) {
    add(violations, 'capture_conservation_invalid');
  }
  if (
    startup?.schema !== 'qinglong/legacy-shadow-startup-difference-report@v1' ||
    startup?.profile !== input.profile ||
    startup?.assessment !== 'converged' ||
    object(startup?.coverage)?.remaining !== false
  ) {
    add(violations, 'startup_not_converged');
  }

  const terminal = object(sources.terminal);
  const terminalWindow = object(terminal?.window);
  const terminalCoverage = object(terminal?.coverage);
  const terminalCounts = object(terminal?.counts);
  const terminalByOriginValue = terminal?.byOrigin;
  const terminalByOrigin = Array.isArray(terminalByOriginValue)
    ? terminalByOriginValue
    : [];
  const terminalScannedValue = terminal?.scanned;
  const terminalMatchedValue = terminalCounts?.matched;
  const terminalScanned = safeCount(terminalScannedValue)
    ? terminalScannedValue
    : 0;
  const terminalMatched = safeCount(terminalMatchedValue)
    ? terminalMatchedValue
    : 0;
  const terminalObservedAtMs = terminal?.observedAtMs;
  if (
    terminal?.schema !== 'qinglong/legacy-shadow-terminal-difference-report@v1'
  ) {
    add(violations, 'terminal_schema_invalid');
  }
  if (terminal?.profile !== input.profile) {
    add(violations, 'terminal_profile_mismatch');
  }
  if (
    terminalWindow?.startInclusiveMs !== startInclusiveMs ||
    terminalWindow?.endExclusiveMs !== endExclusiveMs ||
    terminalWindow?.closed !== true ||
    !safeCount(terminalObservedAtMs) ||
    terminalObservedAtMs > input.generatedAtMs
  ) {
    add(violations, 'terminal_window_mismatch');
  }
  if (
    terminalCoverage?.direction !== 'shadow_to_legacy' ||
    terminalCoverage?.cohort !== 'legacy_owned_shadow_runs' ||
    terminalCoverage?.legacyWithoutShadow !== 'not_measured' ||
    terminalByOrigin.length !== 1 ||
    object(terminalByOrigin[0])?.origin !== 'manual' ||
    object(terminalByOrigin[0])?.scanned !== terminalScanned
  ) {
    add(violations, 'terminal_coverage_invalid');
  }
  if (
    terminal?.assessment !== 'matched' ||
    terminal?.remaining !== false ||
    terminal?.evidenceComplete !== true ||
    terminal?.terminalAgreementPermille !== 1_000 ||
    terminal?.fullyComparablePermille !== 1_000 ||
    terminalScanned !== captured ||
    terminalMatched !== captured
  ) {
    add(violations, 'terminal_not_matched');
  }

  const resource = object(sources.resource);
  const workload = object(resource?.workload);
  const rollback = object(resource?.rollback);
  const qualification = object(resource?.qualification);
  if (
    resource?.schemaVersion !== 1 ||
    resource?.fixture !== 'qinglong/legacy-shadow-resource-rollback-evidence@v1'
  ) {
    add(violations, 'resource_schema_invalid');
  }
  if (resource?.profile !== input.profile) {
    add(violations, 'resource_profile_mismatch');
  }
  if (
    qualification?.passed !== true ||
    qualification?.violations?.length !== 0
  ) {
    add(violations, 'resource_not_qualified');
  }
  if (
    workload?.mode !== 'full' ||
    workload?.runtime !== 'compiled_backend' ||
    rollback?.performed !== true ||
    rollback?.legacyContinued !== true ||
    rollback?.shadowWritesStopped !== true ||
    rollback?.databaseIntegrity !== 'ok'
  ) {
    add(violations, 'resource_not_compiled_full_rollback');
  }

  return Object.freeze({
    schema: LEGACY_SHADOW_PRIMARY_GATE_SCHEMA,
    schemaVersion: 1,
    profile: input.profile,
    origin: 'manual',
    generatedAtMs: input.generatedAtMs,
    assessment: violations.length === 0 ? 'eligible' : 'ineligible',
    window: {
      startInclusiveMs: safeCount(startInclusiveMs) ? startInclusiveMs : 0,
      endExclusiveMs: safeCount(endExclusiveMs) ? endExclusiveMs : 0,
    },
    counts: { admitted, captured, terminalScanned, terminalMatched },
    evidence,
    sources,
    violations,
  });
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${label} shape is invalid`);
  }
}

export function parseLegacyShadowPrimaryGateReceipt(
  value: unknown,
): LegacyShadowPrimaryGateReceipt {
  const receipt = object(value);
  if (!receipt) throw new TypeError('Primary gate receipt must be an object');
  assertExactKeys(
    receipt,
    [
      'schema',
      'schemaVersion',
      'profile',
      'origin',
      'generatedAtMs',
      'assessment',
      'window',
      'counts',
      'evidence',
      'sources',
      'violations',
    ],
    'receipt',
  );
  const window = object(receipt.window);
  const counts = object(receipt.counts);
  const evidence = object(receipt.evidence);
  const sources = object(receipt.sources);
  if (!window || !counts || !evidence || !sources) {
    throw new TypeError('Primary gate receipt nested shape is invalid');
  }
  assertExactKeys(
    window,
    ['startInclusiveMs', 'endExclusiveMs'],
    'receipt.window',
  );
  assertExactKeys(
    sources,
    ['capture', 'terminal', 'resource'],
    'receipt.sources',
  );
  assertExactKeys(
    counts,
    ['admitted', 'captured', 'terminalScanned', 'terminalMatched'],
    'receipt.counts',
  );
  assertExactKeys(
    evidence,
    ['captureSha256', 'terminalSha256', 'resourceSha256'],
    'receipt.evidence',
  );
  if (
    receipt.schema !== LEGACY_SHADOW_PRIMARY_GATE_SCHEMA ||
    receipt.schemaVersion !== 1 ||
    !['edge', 'standalone'].includes(receipt.profile) ||
    receipt.origin !== 'manual' ||
    !safeCount(receipt.generatedAtMs) ||
    !['eligible', 'ineligible'].includes(receipt.assessment) ||
    !safeCount(window.startInclusiveMs) ||
    !safeCount(window.endExclusiveMs) ||
    window.startInclusiveMs >= window.endExclusiveMs ||
    !Object.values(counts).every(safeCount) ||
    !Object.values(evidence).every(
      (digest) => typeof digest === 'string' && SHA256_PATTERN.test(digest),
    ) ||
    !Array.isArray(receipt.violations) ||
    receipt.violations.some(
      (violation: unknown) =>
        typeof violation !== 'string' || violation.length > 64,
    ) ||
    (receipt.assessment === 'eligible' && receipt.violations.length !== 0) ||
    (receipt.assessment === 'ineligible' && receipt.violations.length === 0)
  ) {
    throw new TypeError('Primary gate receipt is invalid');
  }
  const recomputed = createLegacyShadowPrimaryGateReceipt({
    profile: receipt.profile as 'edge' | 'standalone',
    generatedAtMs: receipt.generatedAtMs,
    capture: sources.capture,
    terminal: sources.terminal,
    resource: sources.resource,
  });
  for (const field of [
    'assessment',
    'window',
    'counts',
    'evidence',
    'violations',
  ] as const) {
    if (canonicalJson(receipt[field]) !== canonicalJson(recomputed[field])) {
      throw new TypeError(`Primary gate receipt ${field} was not reproduced`);
    }
  }
  return receipt as unknown as LegacyShadowPrimaryGateReceipt;
}
import { createHash } from 'crypto';
