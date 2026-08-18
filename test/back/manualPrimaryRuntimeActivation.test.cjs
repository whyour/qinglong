require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  activateManualPrimaryRuntime,
} = require('../../back/runtime/application/manualPrimaryRuntimeActivation');
const {
  RuntimeRolloutPolicy,
} = require('../../back/runtime/domain/runtimeRollout');

const NOW = 1_750_000_000_000;

function loadResult(status, mode = 'off') {
  return {
    status,
    policy: new RuntimeRolloutPolicy({
      defaultMode: 'off',
      origins: mode === 'off' ? {} : { manual: mode },
      allowLegacyFallbackBeforeStart: false,
    }),
    audit: {
      event: 'runtime.rollout_config_evaluated',
      evaluatedAtMs: NOW,
      sourcePath: '/data/config/qinglong3-rollout.json',
      status,
      revision: 'canary-1',
      sourceSha256: 'a'.repeat(64),
    },
  };
}

function cleanRecovery(overrides = {}) {
  return {
    pages: 1,
    scanned: 0,
    verifiedRunning: 0,
    recoveredRunning: 0,
    completedFromReceipt: 0,
    quarantinedReceipts: 0,
    publishGraceWaits: 0,
    markedLost: 0,
    skipped: 0,
    ambiguous: 0,
    failed: 0,
    stopReason: 'complete',
    remaining: false,
    ...overrides,
  };
}

function router() {
  return {
    ownsNewRuns: () => true,
    async start() {
      throw new Error('not used');
    },
    async stopCron() {
      return { matched: 0, failed: 0 };
    },
    async stopAttempt() {
      return { matched: 0, failed: 0 };
    },
  };
}

function completionLifecycle(calls) {
  return {
    startCompletion() {
      calls.push('start-completion');
      return true;
    },
    async stopCompletion() {
      calls.push('stop-completion');
      return 'drained';
    },
  };
}

test('activation remains inert unless an accepted manifest selects Primary', async () => {
  for (const [status, mode] of [
    ['missing', 'off'],
    ['disabled', 'off'],
    ['rejected', 'off'],
    ['accepted', 'shadow'],
  ]) {
    const calls = [];
    const result = await activateManualPrimaryRuntime({
      load: async () => loadResult(status, mode),
      create() {
        calls.push('create');
        throw new Error('must remain inert');
      },
      install() {
        calls.push('install');
        return () => undefined;
      },
      audit(record) {
        calls.push(record.activation);
      },
    });
    assert.equal(result.active, false);
    assert.equal(await result.stop(), 'drained');
    assert.deepEqual(calls, ['not_activated']);
  }
});

test('activation reconciles before starting lifecycle and installing ownership', async () => {
  const calls = [];
  const result = await activateManualPrimaryRuntime({
    load: async () => loadResult('accepted', 'primary'),
    create() {
      calls.push('create');
      return {
        router: router(),
        ...completionLifecycle(calls),
        async reconcile() {
          calls.push('reconcile');
          return cleanRecovery({
            scanned: 2,
            recoveredRunning: 1,
            markedLost: 1,
          });
        },
        startTimeout() {
          calls.push('start-timeout');
          return true;
        },
        async stopTimeout() {
          calls.push('stop-timeout');
          return 'drained';
        },
        startCancellation() {
          calls.push('start-cancellation');
          return true;
        },
        async stopCancellation() {
          calls.push('stop-cancellation');
          return 'drained';
        },
      };
    },
    install() {
      calls.push('install');
      return () => calls.push('dispose');
    },
    audit(record) {
      calls.push(`audit:${record.activation}`);
    },
  });

  assert.equal(result.active, true);
  assert.deepEqual(calls, [
    'audit:selected',
    'create',
    'reconcile',
    'audit:reconciled',
    'start-completion',
    'start-timeout',
    'start-cancellation',
    'install',
    'audit:activated',
  ]);
  assert.equal(await result.stop(), 'drained');
  assert.equal(await result.stop(), 'drained');
  assert.deepEqual(calls.slice(-5), [
    'dispose',
    'stop-timeout',
    'stop-cancellation',
    'stop-completion',
    'audit:stopped',
  ]);
});

test('activation publishes durable state around ownership and lifecycle shutdown', async () => {
  const calls = [];
  const result = await activateManualPrimaryRuntime({
    load: async () => loadResult('accepted', 'primary'),
    create() {
      return {
        router: router(),
        ...completionLifecycle(calls),
        async reconcile() {
          return cleanRecovery();
        },
        startTimeout() {
          calls.push('start-timeout');
          return true;
        },
        async stopTimeout() {
          calls.push('stop-timeout');
          return 'drained';
        },
        startCancellation() {
          calls.push('start-cancellation');
          return true;
        },
        async stopCancellation() {
          calls.push('stop-cancellation');
          return 'drained';
        },
      };
    },
    install() {
      calls.push('install');
      return () => calls.push('dispose');
    },
    receipt: {
      async activated() {
        calls.push('receipt:active');
      },
      async stopping() {
        calls.push('receipt:stopping');
      },
      async stopped() {
        calls.push('receipt:stopped');
      },
      async failed() {
        calls.push('receipt:failed');
      },
    },
    audit(record) {
      calls.push(`audit:${record.activation}`);
    },
  });

  assert.deepEqual(calls.slice(-4), [
    'start-cancellation',
    'install',
    'receipt:active',
    'audit:activated',
  ]);
  await result.stop();
  assert.deepEqual(calls.slice(-7), [
    'receipt:stopping',
    'dispose',
    'stop-timeout',
    'stop-cancellation',
    'stop-completion',
    'receipt:stopped',
    'audit:stopped',
  ]);
});

test('activation rolls ownership back when durable receipt publication fails', async () => {
  const calls = [];
  await assert.rejects(
    activateManualPrimaryRuntime({
      load: async () => loadResult('accepted', 'primary'),
      create() {
        return {
          router: router(),
          ...completionLifecycle(calls),
          async reconcile() {
            return cleanRecovery();
          },
          startTimeout() {
            calls.push('start-timeout');
            return true;
          },
          async stopTimeout() {
            calls.push('stop-timeout');
            return 'drained';
          },
          startCancellation() {
            calls.push('start-cancellation');
            return true;
          },
          async stopCancellation() {
            calls.push('stop-cancellation');
            return 'drained';
          },
        };
      },
      install() {
        calls.push('install');
        return () => calls.push('dispose');
      },
      receipt: {
        async activated() {
          calls.push('receipt:active');
          throw new Error('receipt unavailable');
        },
        async stopping() {},
        async stopped() {},
        async failed() {
          calls.push('receipt:failed');
        },
      },
      audit(record) {
        calls.push(`audit:${record.activation}`);
      },
    }),
    /receipt unavailable/,
  );
  assert.deepEqual(calls.slice(-7), [
    'receipt:active',
    'dispose',
    'stop-timeout',
    'stop-cancellation',
    'stop-completion',
    'receipt:failed',
    'audit:failed',
  ]);
});

test('activation rejects unresolved recovery before starting or installing', async () => {
  const calls = [];
  await assert.rejects(
    activateManualPrimaryRuntime({
      load: async () => loadResult('accepted', 'primary'),
      create() {
        return {
          router: router(),
          ...completionLifecycle(calls),
          async reconcile() {
            return cleanRecovery({ ambiguous: 1 });
          },
          startTimeout() {
            calls.push('start-timeout');
            return true;
          },
          async stopTimeout() {
            calls.push('stop-timeout');
            return 'drained';
          },
          startCancellation() {
            calls.push('start');
            return true;
          },
          async stopCancellation() {
            calls.push('stop');
            return 'drained';
          },
        };
      },
      install() {
        calls.push('install');
        return () => calls.push('dispose');
      },
      audit(record) {
        calls.push(`audit:${record.activation}`);
      },
    }),
    /did not converge safely/,
  );
  assert.deepEqual(calls, ['audit:selected', 'audit:failed']);
});

test('activation rolls back router and lifecycle when final audit fails', async () => {
  const calls = [];
  await assert.rejects(
    activateManualPrimaryRuntime({
      load: async () => loadResult('accepted', 'primary'),
      create() {
        return {
          router: router(),
          ...completionLifecycle(calls),
          async reconcile() {
            return cleanRecovery();
          },
          startTimeout() {
            calls.push('start-timeout');
            return true;
          },
          async stopTimeout() {
            calls.push('stop-timeout');
            return 'drained';
          },
          startCancellation() {
            calls.push('start');
            return true;
          },
          async stopCancellation() {
            calls.push('stop');
            return 'drained';
          },
        };
      },
      install() {
        calls.push('install');
        return () => calls.push('dispose');
      },
      audit(record) {
        calls.push(`audit:${record.activation}`);
        if (record.activation === 'activated') {
          throw new Error('audit unavailable');
        }
      },
    }),
    /audit unavailable/,
  );
  assert.deepEqual(calls, [
    'audit:selected',
    'audit:reconciled',
    'start-completion',
    'start-timeout',
    'start',
    'install',
    'audit:activated',
    'dispose',
    'stop-timeout',
    'stop',
    'stop-completion',
    'audit:failed',
  ]);
});

test('activation stops timeout production when cancellation lifecycle cannot start', async () => {
  const calls = [];
  await assert.rejects(
    activateManualPrimaryRuntime({
      load: async () => loadResult('accepted', 'primary'),
      create() {
        return {
          router: router(),
          ...completionLifecycle(calls),
          async reconcile() {
            return cleanRecovery();
          },
          startTimeout() {
            calls.push('start-timeout');
            return true;
          },
          async stopTimeout() {
            calls.push('stop-timeout');
            return 'drained';
          },
          startCancellation() {
            calls.push('start-cancellation');
            return false;
          },
          async stopCancellation() {
            calls.push('stop-cancellation');
            return 'drained';
          },
        };
      },
      install() {
        calls.push('install');
        return () => calls.push('dispose');
      },
      audit(record) {
        calls.push(`audit:${record.activation}`);
      },
    }),
    /cancellation lifecycle did not start/,
  );
  assert.deepEqual(calls, [
    'audit:selected',
    'audit:reconciled',
    'start-completion',
    'start-timeout',
    'start-cancellation',
    'stop-timeout',
    'stop-completion',
    'audit:failed',
  ]);
});
