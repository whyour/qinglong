require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  bootstrapDefaultManualPrimaryRuntime,
} = require('../../back/runtime/adapters/legacy/bootstrapDefaultManualPrimaryRuntime');
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
    },
    ...(status === 'accepted'
      ? {
          primaryGateReceipt: {
            schema: 'qinglong/legacy-shadow-primary-gate@v1',
            schemaVersion: 1,
            profile: 'standalone',
            origin: 'manual',
            generatedAtMs: NOW - 2_000,
            assessment: 'eligible',
            window: {
              startInclusiveMs: NOW - 10_000,
              endExclusiveMs: NOW - 5_000,
            },
            counts: {
              admitted: 32,
              captured: 32,
              terminalScanned: 32,
              terminalMatched: 32,
            },
            evidence: {
              captureSha256: 'a'.repeat(64),
              terminalSha256: 'b'.repeat(64),
              resourceSha256: 'c'.repeat(64),
            },
            violations: [],
          },
        }
      : {}),
  };
}

test('default-off bootstrap does not import or construct the Primary stack', async () => {
  const calls = [];
  const result = await bootstrapDefaultManualPrimaryRuntime({
    load: async () => loadResult('missing'),
    async loadStack() {
      calls.push('load-stack');
      throw new Error('must remain lazy');
    },
    install() {
      calls.push('install');
      return () => undefined;
    },
    audit(record) {
      calls.push(`audit:${record.activation}`);
    },
  });

  assert.equal(result.active, false);
  assert.deepEqual(calls, ['audit:not_activated']);
});

test('accepted bootstrap lazily loads the stack and delegates activation', async () => {
  const calls = [];
  const result = await bootstrapDefaultManualPrimaryRuntime({
    load: async () => loadResult('accepted', 'primary'),
    async loadStack() {
      calls.push('load-stack');
      return {
        createDefaultManualPrimaryActivationStack(_rollout, options) {
          calls.push('create-stack');
          calls.push(`profile:${options.deploymentProfile}`);
          return {
            router: {
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
            },
            async reconcile() {
              calls.push('reconcile');
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
              };
            },
            startCompletion() {
              calls.push('start-completion');
              return true;
            },
            async stopCompletion() {
              calls.push('stop-completion');
              return 'drained';
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
  await result.stop();
  assert.deepEqual(calls, [
    'load-stack',
    'audit:selected',
    'create-stack',
    'profile:standalone',
    'reconcile',
    'audit:reconciled',
    'start-completion',
    'start-timeout',
    'start-cancellation',
    'install',
    'audit:activated',
    'dispose',
    'stop-timeout',
    'stop-cancellation',
    'stop-completion',
    'audit:stopped',
  ]);
});

test('accepted bootstrap audits a lazy stack import failure without installing', async () => {
  const calls = [];
  await assert.rejects(
    bootstrapDefaultManualPrimaryRuntime({
      load: async () => loadResult('accepted', 'primary'),
      async loadStack() {
        calls.push('load-stack');
        throw new Error('stack import failed');
      },
      install() {
        calls.push('install');
        return () => calls.push('dispose');
      },
      audit(record) {
        calls.push(`audit:${record.activation}`);
      },
    }),
    /stack import failed/,
  );
  assert.deepEqual(calls, ['load-stack', 'audit:failed']);
});

test('accepted bootstrap rejects a Primary receipt for another Profile before loading', async () => {
  const calls = [];
  const load = loadResult('accepted', 'primary');
  load.primaryGateReceipt.profile = 'edge';
  await assert.rejects(
    bootstrapDefaultManualPrimaryRuntime({
      load: async () => load,
      deploymentProfile: 'standalone',
      async loadStack() {
        calls.push('load-stack');
        throw new Error('must remain lazy');
      },
      audit(record) {
        calls.push(`audit:${record.activation}`);
      },
    }),
    /does not authorize this deployment Profile/,
  );
  assert.deepEqual(calls, ['audit:failed']);
});

test('disabled bootstrap stays inert even with an invalid deployment profile', async () => {
  const previous = process.env.QL_DEPLOYMENT_PROFILE;
  process.env.QL_DEPLOYMENT_PROFILE = 'invalid-profile';
  try {
    const result = await bootstrapDefaultManualPrimaryRuntime({
      load: async () => loadResult('disabled'),
      async loadStack() {
        throw new Error('must remain lazy');
      },
      install() {
        throw new Error('must remain uninstalled');
      },
      audit() {},
    });
    assert.equal(result.active, false);
  } finally {
    if (previous === undefined) delete process.env.QL_DEPLOYMENT_PROFILE;
    else process.env.QL_DEPLOYMENT_PROFILE = previous;
  }
});

test('accepted bootstrap rejects and audits an invalid deployment profile', async () => {
  const previous = process.env.QL_DEPLOYMENT_PROFILE;
  process.env.QL_DEPLOYMENT_PROFILE = 'invalid-profile';
  const calls = [];
  try {
    await assert.rejects(
      bootstrapDefaultManualPrimaryRuntime({
        load: async () => loadResult('accepted', 'primary'),
        async loadStack() {
          calls.push('load-stack');
          return {
            createDefaultManualPrimaryActivationStack() {
              calls.push('create-stack');
              throw new Error('profile must be rejected first');
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
      /QL_DEPLOYMENT_PROFILE is invalid/,
    );
    assert.deepEqual(calls, ['audit:failed']);
  } finally {
    if (previous === undefined) delete process.env.QL_DEPLOYMENT_PROFILE;
    else process.env.QL_DEPLOYMENT_PROFILE = previous;
  }
});
