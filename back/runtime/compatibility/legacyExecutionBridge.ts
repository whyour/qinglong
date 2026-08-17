import Logger from '../../loaders/logger';
import type { LegacyShadowRunCorrelator } from '../application/legacyShadowRunCorrelator';
import type { ExecutionOrigin } from '../domain/run';
import type {
  LegacyExecutionCallbackFact,
  LegacyExecutionCancellationFact,
} from '../ports/legacyExecutionCorrelation';
import type {
  LegacyExecutionAcceptedFact,
  LegacyExecutionCancelledFact,
  LegacyExecutionExitedFact,
  LegacyExecutionObservation,
  LegacyExecutionObserver,
  LegacyExecutionRunningFact,
  LegacyExecutionSpawnedFact,
  LegacyExecutionStartFailedFact,
} from '../ports/legacyExecutionObserver';
import { createLegacyLogArtifactId } from './legacyTaskRevision';
import { LegacyExecutionRegistry } from './legacyExecutionRegistry';

const SHADOW_ORIGINS_ENV = 'QL3_SHADOW_ORIGINS';
const SUPPORTED_SHADOW_ORIGINS = new Set<ExecutionOrigin>([
  'manual',
  'scheduled_node',
  'script',
  'subscription',
  'system',
]);

const NOOP_OBSERVATION: LegacyExecutionObservation = Object.freeze({
  spawned() {},
  running() {},
  startFailed() {},
  exited() {},
  cancelled() {},
});

interface ObserverOverride {
  token: symbol;
  observer: LegacyExecutionObserver;
  origins: ReadonlySet<ExecutionOrigin>;
}

export type LegacyExecutionAcceptedFactFactory =
  () => LegacyExecutionAcceptedFact;

let override: ObserverOverride | undefined;
let configuredOrigins: ReadonlySet<ExecutionOrigin> | undefined;
let defaultObserver: Promise<LegacyExecutionObserver> | undefined;
let defaultCorrelator: Promise<LegacyShadowRunCorrelator> | undefined;
const failureCounters = new Map<string, number>();
const localRegistry = new LegacyExecutionRegistry({
  onOverflow() {
    incrementFailure('registry:capacity_exceeded');
    try {
      Logger.warn('[ql3-shadow] local registry capacity exceeded');
    } catch {
      // Compatibility diagnostics must not affect legacy execution.
    }
  },
  onDispatchFailure() {
    incrementFailure('registry:dispatch_failed');
    try {
      Logger.warn('[ql3-shadow] local observation dispatch failed');
    } catch {
      // Compatibility diagnostics must not affect legacy execution.
    }
  },
});

function incrementFailure(key: string): void {
  failureCounters.set(key, (failureCounters.get(key) ?? 0) + 1);
}

function readConfiguredOrigins(): ReadonlySet<ExecutionOrigin> {
  if (configuredOrigins) return configuredOrigins;
  const origins = new Set<ExecutionOrigin>();
  const raw = process.env[SHADOW_ORIGINS_ENV]?.trim();
  if (raw) {
    for (const value of raw.split(',').map((item) => item.trim())) {
      if (SUPPORTED_SHADOW_ORIGINS.has(value as ExecutionOrigin)) {
        origins.add(value as ExecutionOrigin);
      } else if (value) {
        incrementFailure('configuration:unsupported_origin');
        try {
          Logger.warn(
            '[ql3-shadow] ignored unsupported origin; this slice supports manual,scheduled_node,script,subscription,system',
          );
        } catch {
          // Invalid compatibility configuration must not affect legacy paths.
        }
      }
    }
  }
  configuredOrigins = origins;
  return configuredOrigins;
}

async function createDefaultObserver(): Promise<LegacyExecutionObserver> {
  const [data, repositoryModule, observerModule, writerModule, rolloutModule] =
    await Promise.all([
      import('../../data'),
      import('../adapters/legacy-sequelize/runRepository'),
      import('../application/legacyShadowRunObserver'),
      import('../application/legacyShadowRunWriter'),
      import('../domain/runtimeRollout'),
    ]);
  const origins = [...readConfiguredOrigins()];
  const repository = new repositoryModule.LegacySequelizeRunRepository(
    data.sequelize,
  );
  const writer = new writerModule.LegacyShadowRunWriter(repository);
  return new observerModule.LegacyShadowRunObserver(
    rolloutModule.shadowOnlyRollout(origins),
    writer,
    {
      failure(failure) {
        const key = `${failure.origin}:${failure.operation}:${failure.errorCode}`;
        incrementFailure(key);
        Logger.warn(
          `[ql3-shadow] write failed origin=${failure.origin} operation=${failure.operation} code=${failure.errorCode}`,
        );
      },
    },
  );
}

function getDefaultObserver(): Promise<LegacyExecutionObserver> {
  defaultObserver ??= createDefaultObserver().catch((error) => {
    defaultObserver = undefined;
    incrementFailure('initialization:failed');
    Logger.warn(
      `[ql3-shadow] observer initialization failed type=${
        error instanceof Error ? error.name : 'unknown'
      }`,
    );
    throw error;
  });
  return defaultObserver;
}

async function createDefaultCorrelator(): Promise<LegacyShadowRunCorrelator> {
  const [data, repositoryModule, correlatorModule, writerModule] =
    await Promise.all([
      import('../../data'),
      import('../adapters/legacy-sequelize/runRepository'),
      import('../application/legacyShadowRunCorrelator'),
      import('../application/legacyShadowRunWriter'),
    ]);
  const repository = new repositoryModule.LegacySequelizeRunRepository(
    data.sequelize,
  );
  const writer = new writerModule.LegacyShadowRunWriter(repository);
  return new correlatorModule.LegacyShadowRunCorrelator(repository, writer, {
    failure(failure) {
      const key = `correlation:${failure.operation}:${failure.reason}`;
      incrementFailure(key);
      Logger.warn(
        `[ql3-shadow] correlation skipped operation=${failure.operation} reason=${failure.reason} candidates=${failure.candidateCount}`,
      );
    },
  });
}

function getDefaultCorrelator(): Promise<LegacyShadowRunCorrelator> {
  defaultCorrelator ??= createDefaultCorrelator().catch((error) => {
    defaultCorrelator = undefined;
    incrementFailure('correlation:initialization_failed');
    try {
      Logger.warn('[ql3-shadow] correlator initialization failed');
    } catch {
      // Compatibility diagnostics must not affect legacy execution.
    }
    throw error;
  });
  return defaultCorrelator;
}

function beginFailOpen(
  observer: LegacyExecutionObserver,
  accepted: LegacyExecutionAcceptedFact,
): LegacyExecutionObservation {
  try {
    return observer.begin(accepted);
  } catch {
    incrementFailure(`${accepted.origin}:begin:failed`);
    try {
      Logger.warn(
        `[ql3-shadow] observer begin failed origin=${accepted.origin}`,
      );
    } catch {
      // Compatibility observation must never become a legacy execution failure.
    }
    return NOOP_OBSERVATION;
  }
}

function createAcceptedFactFailOpen(
  origin: ExecutionOrigin,
  createFact: LegacyExecutionAcceptedFactFactory,
): LegacyExecutionAcceptedFact | null {
  try {
    const fact = createFact();
    if (fact.origin !== origin) {
      throw new TypeError('Legacy execution fact origin does not match flag');
    }
    return fact;
  } catch {
    incrementFailure(`${origin}:fact:failed`);
    try {
      Logger.warn(`[ql3-shadow] fact creation failed origin=${origin}`);
    } catch {
      // Compatibility observation must never become a legacy execution failure.
    }
    return null;
  }
}

function deferredObservation(
  observer: Promise<LegacyExecutionObserver>,
  accepted: LegacyExecutionAcceptedFact,
): LegacyExecutionObservation {
  const delegate = observer
    .then((value) => beginFailOpen(value, accepted))
    .catch(() => NOOP_OBSERVATION);
  const enqueue = <T>(
    operation: (observation: LegacyExecutionObservation, fact: T) => void,
    fact: T,
  ) => {
    void delegate.then((observation) => operation(observation, fact));
  };
  return {
    spawned(fact: LegacyExecutionSpawnedFact) {
      enqueue((observation, value) => observation.spawned(value), fact);
    },
    running(fact: LegacyExecutionRunningFact) {
      enqueue((observation, value) => observation.running(value), fact);
    },
    startFailed(fact: LegacyExecutionStartFailedFact) {
      enqueue((observation, value) => observation.startFailed(value), fact);
    },
    exited(fact: LegacyExecutionExitedFact) {
      enqueue((observation, value) => observation.exited(value), fact);
    },
    cancelled(fact: LegacyExecutionCancelledFact) {
      enqueue((observation, value) => observation.cancelled(value), fact);
    },
  };
}

export function observeLegacyExecution(
  origin: ExecutionOrigin,
  createFact: LegacyExecutionAcceptedFactFactory,
): LegacyExecutionObservation | undefined {
  if (override) {
    if (!override.origins.has(origin)) return undefined;
    const fact = createAcceptedFactFailOpen(origin, createFact);
    return fact
      ? localRegistry.register(fact, beginFailOpen(override.observer, fact))
      : NOOP_OBSERVATION;
  }
  if (!readConfiguredOrigins().has(origin)) return undefined;
  const fact = createAcceptedFactFailOpen(origin, createFact);
  return fact
    ? localRegistry.register(
        fact,
        deferredObservation(getDefaultObserver(), fact),
      )
    : NOOP_OBSERVATION;
}

export interface LegacyExecutionCancellationInput {
  legacyCronId: number;
  pid?: number;
  logPath?: string;
  atMs: number;
  scope: 'all' | 'one';
  reason: LegacyExecutionCancellationFact['reason'];
}

export interface LegacyExecutionCallbackInput {
  legacyCronId: number;
  pid?: number;
  logPath?: string;
  atMs: number;
  phase: LegacyExecutionCallbackFact['phase'];
  exitCode?: number;
}

export function observeLegacyCancellation(
  input: LegacyExecutionCancellationInput,
): void {
  const origins = override?.origins ?? readConfiguredOrigins();
  if (origins.size === 0) return;
  const fact: LegacyExecutionCancellationFact = {
    legacyCronId: input.legacyCronId,
    atMs: input.atMs,
    scope: input.scope,
    reason: input.reason,
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    ...(input.logPath === undefined
      ? {}
      : { logArtifactId: createLegacyLogArtifactId(input.logPath) }),
  };
  const localMatches = localRegistry.cancel(fact);
  if (override || (input.scope === 'one' && localMatches === 1)) return;
  dispatchCorrelation((correlator) => correlator.cancel(fact, [...origins]));
}

export function observeLegacyExecutionCallback(
  input: LegacyExecutionCallbackInput,
): void {
  const origins = override?.origins ?? readConfiguredOrigins();
  if (origins.size === 0) return;
  const fact: LegacyExecutionCallbackFact = {
    legacyCronId: input.legacyCronId,
    atMs: input.atMs,
    phase: input.phase,
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    ...(input.logPath === undefined
      ? {}
      : { logArtifactId: createLegacyLogArtifactId(input.logPath) }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
  };
  if (localRegistry.callback(fact) === 1 || override) return;
  dispatchCorrelation((correlator) => correlator.callback(fact, [...origins]));
}

function dispatchCorrelation(
  operation: (correlator: LegacyShadowRunCorrelator) => Promise<unknown>,
): void {
  void getDefaultCorrelator()
    .then(operation)
    .catch(() => {
      incrementFailure('correlation:operation_failed');
      try {
        Logger.warn('[ql3-shadow] correlation operation failed');
      } catch {
        // Compatibility diagnostics must not affect legacy execution.
      }
    });
}

export function installLegacyExecutionObserver(
  observer: LegacyExecutionObserver,
  origins: readonly ExecutionOrigin[],
): () => void {
  const token = Symbol('legacy-shadow-observer');
  const previous = override;
  override = { token, observer, origins: new Set(origins) };
  return () => {
    if (override?.token === token) override = previous;
  };
}

export function shadowBridgeFailureSnapshot(): Readonly<
  Record<string, number>
> {
  return Object.fromEntries(failureCounters);
}
