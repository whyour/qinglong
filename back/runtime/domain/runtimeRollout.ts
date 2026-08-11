import {
  EXECUTION_ORIGINS,
  type ExecutionOrigin,
  type ExecutionOwner,
} from './run';

export const COMPATIBILITY_MODES = ['off', 'shadow', 'primary'] as const;
export type CompatibilityMode = (typeof COMPATIBILITY_MODES)[number];

export interface RuntimeRolloutConfig {
  defaultMode: CompatibilityMode;
  origins: Partial<Record<ExecutionOrigin, CompatibilityMode>>;
  allowLegacyFallbackBeforeStart: boolean;
}

export interface ExecutionOwnershipDecision {
  origin: ExecutionOrigin;
  mode: CompatibilityMode;
  owner: ExecutionOwner;
}

const VALID_ORIGINS = new Set<ExecutionOrigin>(EXECUTION_ORIGINS);
const VALID_MODES = new Set<CompatibilityMode>(COMPATIBILITY_MODES);

function assertConfig(config: RuntimeRolloutConfig): void {
  if (!VALID_MODES.has(config.defaultMode)) {
    throw new TypeError('Runtime rollout defaultMode is invalid');
  }
  for (const [origin, mode] of Object.entries(config.origins)) {
    if (!VALID_ORIGINS.has(origin as ExecutionOrigin)) {
      throw new TypeError(`Runtime rollout origin is invalid: ${origin}`);
    }
    if (!VALID_MODES.has(mode as CompatibilityMode)) {
      throw new TypeError(`Runtime rollout mode is invalid: ${String(mode)}`);
    }
  }
}

export class RuntimeRolloutPolicy {
  private readonly config: RuntimeRolloutConfig;

  constructor(config: RuntimeRolloutConfig) {
    assertConfig(config);
    this.config = {
      defaultMode: config.defaultMode,
      origins: { ...config.origins },
      allowLegacyFallbackBeforeStart: config.allowLegacyFallbackBeforeStart,
    };
  }

  modeFor(origin: ExecutionOrigin): CompatibilityMode {
    return this.config.origins[origin] ?? this.config.defaultMode;
  }

  decide(origin: ExecutionOrigin): ExecutionOwnershipDecision {
    const mode = this.modeFor(origin);
    return {
      origin,
      mode,
      owner: mode === 'primary' ? 'runtime' : 'legacy',
    };
  }

  snapshot(): RuntimeRolloutConfig {
    return {
      defaultMode: this.config.defaultMode,
      origins: { ...this.config.origins },
      allowLegacyFallbackBeforeStart:
        this.config.allowLegacyFallbackBeforeStart,
    };
  }
}

export function shadowOnlyRollout(
  origins: readonly ExecutionOrigin[],
): RuntimeRolloutPolicy {
  return new RuntimeRolloutPolicy({
    defaultMode: 'off',
    origins: Object.fromEntries(origins.map((origin) => [origin, 'shadow'])),
    allowLegacyFallbackBeforeStart: false,
  });
}
