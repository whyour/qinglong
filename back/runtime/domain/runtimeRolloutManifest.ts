import type { ExecutionOrigin } from './run';
import {
  RuntimeRolloutPolicy,
  type CompatibilityMode,
  type RuntimeRolloutConfig,
} from './runtimeRollout';

export const RUNTIME_ROLLOUT_MANIFEST_VERSION = 2;
export const MAX_RUNTIME_ROLLOUT_APPROVAL_MS = 30 * 24 * 60 * 60 * 1000;

export const REQUIRED_RUNTIME_ROLLOUT_GATES = [
  'durableCancellation',
  'startupReconciliation',
  'atomicLegacyProjection',
  'rollbackDrill',
  'edgeBudget',
] as const;

export type RuntimeRolloutGate =
  (typeof REQUIRED_RUNTIME_ROLLOUT_GATES)[number];

export interface DisabledRuntimeRolloutManifest {
  schemaVersion: typeof RUNTIME_ROLLOUT_MANIFEST_VERSION;
  revision: string;
  enabled: false;
}

export interface EnabledRuntimeRolloutManifest {
  schemaVersion: typeof RUNTIME_ROLLOUT_MANIFEST_VERSION;
  revision: string;
  enabled: true;
  approvedBy: string;
  approvedAtMs: number;
  expiresAtMs: number;
  rollbackPlanRef: string;
  primaryGate: {
    schema: 'qinglong/legacy-shadow-primary-gate-reference@v1';
    origin: 'manual';
    receiptFile: string;
    receiptSha256: string;
  };
  rollout: RuntimeRolloutConfig;
  gates: Record<RuntimeRolloutGate, 'passed'>;
}

export type RuntimeRolloutManifest =
  | DisabledRuntimeRolloutManifest
  | EnabledRuntimeRolloutManifest;

export interface RuntimeRolloutManifestDecision {
  manifest: RuntimeRolloutManifest;
  policy: RuntimeRolloutPolicy;
}

const MANUAL_ORIGIN = 'manual' as const satisfies ExecutionOrigin;
const ALLOWED_MANUAL_MODES = new Set<CompatibilityMode>([
  'off',
  'shadow',
  'primary',
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RECEIPT_FILE_PATTERN =
  /^(?=.{1,128}$)(?!\.)(?!.*\.\.)(?:[A-Za-z0-9][A-Za-z0-9._-]*)\.json$/u;

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  }
  for (const key of expected) {
    if (!(key in value)) throw new TypeError(`${name}.${key} is required`);
  }
}

function boundedString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function safeTimestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function disabledPolicy(): RuntimeRolloutPolicy {
  return new RuntimeRolloutPolicy({
    defaultMode: 'off',
    origins: {},
    allowLegacyFallbackBeforeStart: false,
  });
}

export function parseRuntimeRolloutManifest(
  value: unknown,
  evaluatedAtMs: number,
): RuntimeRolloutManifestDecision {
  const now = safeTimestamp(evaluatedAtMs, 'evaluatedAtMs');
  const object = asObject(value, 'manifest');
  if (object.enabled === false) {
    assertExactKeys(
      object,
      ['schemaVersion', 'revision', 'enabled'],
      'manifest',
    );
    if (object.schemaVersion !== RUNTIME_ROLLOUT_MANIFEST_VERSION) {
      throw new TypeError('manifest.schemaVersion is unsupported');
    }
    const manifest: DisabledRuntimeRolloutManifest = {
      schemaVersion: RUNTIME_ROLLOUT_MANIFEST_VERSION,
      revision: boundedString(object.revision, 'manifest.revision', 128),
      enabled: false,
    };
    return { manifest, policy: disabledPolicy() };
  }

  assertExactKeys(
    object,
    [
      'schemaVersion',
      'revision',
      'enabled',
      'approvedBy',
      'approvedAtMs',
      'expiresAtMs',
      'rollbackPlanRef',
      'primaryGate',
      'rollout',
      'gates',
    ],
    'manifest',
  );
  if (object.schemaVersion !== RUNTIME_ROLLOUT_MANIFEST_VERSION) {
    throw new TypeError('manifest.schemaVersion is unsupported');
  }
  if (object.enabled !== true) {
    throw new TypeError('manifest.enabled must be a boolean');
  }

  const approvedAtMs = safeTimestamp(
    object.approvedAtMs,
    'manifest.approvedAtMs',
  );
  const expiresAtMs = safeTimestamp(object.expiresAtMs, 'manifest.expiresAtMs');
  if (approvedAtMs > now) {
    throw new TypeError('manifest approval is not active yet');
  }
  if (expiresAtMs <= now) {
    throw new TypeError('manifest approval has expired');
  }
  if (
    expiresAtMs <= approvedAtMs ||
    expiresAtMs - approvedAtMs > MAX_RUNTIME_ROLLOUT_APPROVAL_MS
  ) {
    throw new TypeError('manifest approval window is invalid');
  }

  const rolloutObject = asObject(object.rollout, 'manifest.rollout');
  assertExactKeys(
    rolloutObject,
    ['defaultMode', 'origins', 'allowLegacyFallbackBeforeStart'],
    'manifest.rollout',
  );
  if (rolloutObject.defaultMode !== 'off') {
    throw new TypeError('manifest.rollout.defaultMode must remain off');
  }
  if (rolloutObject.allowLegacyFallbackBeforeStart !== false) {
    throw new TypeError(
      'manifest.rollout.allowLegacyFallbackBeforeStart must remain false',
    );
  }
  const origins = asObject(rolloutObject.origins, 'manifest.rollout.origins');
  assertExactKeys(origins, [MANUAL_ORIGIN], 'manifest.rollout.origins');
  if (!ALLOWED_MANUAL_MODES.has(origins.manual as CompatibilityMode)) {
    throw new TypeError('manifest.rollout.origins.manual is invalid');
  }

  const gatesObject = asObject(object.gates, 'manifest.gates');
  assertExactKeys(
    gatesObject,
    REQUIRED_RUNTIME_ROLLOUT_GATES,
    'manifest.gates',
  );
  for (const gate of REQUIRED_RUNTIME_ROLLOUT_GATES) {
    if (gatesObject[gate] !== 'passed') {
      throw new TypeError(`manifest.gates.${gate} must be passed`);
    }
  }

  const primaryGateObject = asObject(
    object.primaryGate,
    'manifest.primaryGate',
  );
  assertExactKeys(
    primaryGateObject,
    ['schema', 'origin', 'receiptFile', 'receiptSha256'],
    'manifest.primaryGate',
  );
  if (
    primaryGateObject.schema !==
      'qinglong/legacy-shadow-primary-gate-reference@v1' ||
    primaryGateObject.origin !== MANUAL_ORIGIN
  ) {
    throw new TypeError('manifest.primaryGate authority is invalid');
  }
  const receiptFile = boundedString(
    primaryGateObject.receiptFile,
    'manifest.primaryGate.receiptFile',
    128,
  );
  if (!RECEIPT_FILE_PATTERN.test(receiptFile)) {
    throw new TypeError('manifest.primaryGate.receiptFile is invalid');
  }
  const receiptSha256 = boundedString(
    primaryGateObject.receiptSha256,
    'manifest.primaryGate.receiptSha256',
    64,
  );
  if (!SHA256_PATTERN.test(receiptSha256)) {
    throw new TypeError('manifest.primaryGate.receiptSha256 is invalid');
  }

  const rollout: RuntimeRolloutConfig = {
    defaultMode: 'off',
    origins: { manual: origins.manual as CompatibilityMode },
    allowLegacyFallbackBeforeStart: false,
  };
  const manifest: EnabledRuntimeRolloutManifest = {
    schemaVersion: RUNTIME_ROLLOUT_MANIFEST_VERSION,
    revision: boundedString(object.revision, 'manifest.revision', 128),
    enabled: true,
    approvedBy: boundedString(object.approvedBy, 'manifest.approvedBy', 128),
    approvedAtMs,
    expiresAtMs,
    rollbackPlanRef: boundedString(
      object.rollbackPlanRef,
      'manifest.rollbackPlanRef',
      512,
    ),
    primaryGate: {
      schema: 'qinglong/legacy-shadow-primary-gate-reference@v1',
      origin: MANUAL_ORIGIN,
      receiptFile,
      receiptSha256,
    },
    rollout,
    gates: Object.fromEntries(
      REQUIRED_RUNTIME_ROLLOUT_GATES.map((gate) => [gate, 'passed']),
    ) as Record<RuntimeRolloutGate, 'passed'>,
  };
  return { manifest, policy: new RuntimeRolloutPolicy(rollout) };
}

export function defaultOffRuntimeRolloutPolicy(): RuntimeRolloutPolicy {
  return disabledPolicy();
}
