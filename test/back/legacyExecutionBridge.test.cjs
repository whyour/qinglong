require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  installLegacyExecutionObserver,
  observeLegacyCancellation,
  observeLegacyExecution,
  observeLegacyExecutionCallback,
  shadowBridgeFailureSnapshot,
} = require('../../back/runtime/compatibility/legacyExecutionBridge');

function acceptedFact(origin = 'manual') {
  return {
    origin,
    projectId: 'default',
    taskId: 'legacy-cron:1',
    taskRevision: 'sha256:revision',
    legacyCronId: 1,
    triggerType: origin,
    acceptedAtMs: 1_750_000_000_000,
  };
}

test('routes only installed origins and preserves observation fact order', () => {
  const facts = [];
  const observer = {
    begin(fact) {
      facts.push(['accepted', fact]);
      return {
        spawned: (value) => facts.push(['spawned', value]),
        running: (value) => facts.push(['running', value]),
        startFailed: (value) => facts.push(['start_failed', value]),
        exited: (value) => facts.push(['exited', value]),
        cancelled: (value) => facts.push(['cancelled', value]),
      };
    },
  };
  const restore = installLegacyExecutionObserver(observer, ['manual']);
  try {
    const observation = observeLegacyExecution('manual', () => acceptedFact());
    observation.spawned({ atMs: 1, pid: 10 });
    observation.running({ atMs: 2 });
    observation.exited({ atMs: 3, exitCode: 0 });

    let ignoredFactCreated = false;
    const ignored = observeLegacyExecution('boot', () => {
      ignoredFactCreated = true;
      return acceptedFact('boot');
    });
    assert.equal(ignored, undefined);
    assert.equal(ignoredFactCreated, false);
  } finally {
    restore();
  }

  assert.deepEqual(
    facts.map(([type]) => type),
    ['accepted', 'spawned', 'running', 'exited'],
  );
});

test('turns synchronous observer initialization failures into a no-op', () => {
  const before = shadowBridgeFailureSnapshot()['manual:begin:failed'] ?? 0;
  const restore = installLegacyExecutionObserver(
    {
      begin() {
        throw new Error('must not reach legacy execution');
      },
    },
    ['manual'],
  );
  try {
    const observation = observeLegacyExecution('manual', () => acceptedFact());
    assert.doesNotThrow(() => {
      observation.spawned({ atMs: 1 });
      observation.running({ atMs: 2 });
      observation.exited({ atMs: 3, exitCode: 0 });
    });
  } finally {
    restore();
  }

  const after = shadowBridgeFailureSnapshot()['manual:begin:failed'];
  assert.equal(after, before + 1);
});

test('routes local callback and cancellation facts without persistent lookup', () => {
  const facts = [];
  const restore = installLegacyExecutionObserver(
    {
      begin() {
        return {
          spawned: (fact) => facts.push(['spawned', fact]),
          running: (fact) => facts.push(['running', fact]),
          startFailed: (fact) => facts.push(['start_failed', fact]),
          exited: (fact) => facts.push(['exited', fact]),
          cancelled: (fact) => facts.push(['cancelled', fact]),
        };
      },
    },
    ['manual'],
  );
  try {
    const observation = observeLegacyExecution('manual', () => ({
      ...acceptedFact(),
      legacyCronId: 77,
    }));
    observation.spawned({ atMs: 1, pid: 700 });
    observeLegacyExecutionCallback({
      legacyCronId: 77,
      pid: 700,
      atMs: 2,
      phase: 'running',
    });
    observeLegacyCancellation({
      legacyCronId: 77,
      pid: 700,
      atMs: 3,
      scope: 'one',
      reason: 'user',
    });
  } finally {
    restore();
  }

  assert.deepEqual(
    facts.map(([operation]) => operation),
    ['spawned', 'spawned', 'running', 'cancelled'],
  );
});

test('keeps invalid shadow origin configuration fail-open when logging fails', () => {
  const Logger = require('../../back/loaders/logger').default;
  const previousWarn = Logger.warn;
  const previousOrigins = process.env.QL3_SHADOW_ORIGINS;
  let factCreated = false;
  process.env.QL3_SHADOW_ORIGINS = 'secret-invalid-origin';
  Logger.warn = () => {
    throw new Error('logger unavailable');
  };
  try {
    let observation;
    assert.doesNotThrow(() => {
      observation = observeLegacyExecution('manual', () => {
        factCreated = true;
        return acceptedFact();
      });
    });
    assert.equal(observation, undefined);
    assert.equal(factCreated, false);
  } finally {
    Logger.warn = previousWarn;
    if (previousOrigins === undefined) {
      delete process.env.QL3_SHADOW_ORIGINS;
    } else {
      process.env.QL3_SHADOW_ORIGINS = previousOrigins;
    }
  }
});
