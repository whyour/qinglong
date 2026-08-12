const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const {
  validateLocalApiCancellationLiveReport,
} = require('../../scripts/ql3-local-api-cancellation-live-audit.cjs');

function report(profile = 'edge') {
  return {
    schemaVersion: 1,
    profile,
    platform: { os: 'linux', architecture: 'arm64', procfs: true },
    resourceEnvelope: {
      memoryBytes: profile === 'edge' ? 128 * 1024 * 1024 : 256 * 1024 * 1024,
      pids: profile === 'edge' ? 64 : 256,
      apiRssBytes: 80 * 1024 * 1024,
    },
    observations: {
      taskStartAccepted: true,
      cancellationAccepted: true,
      exactReplay: true,
      durableIntentEvents: 1,
      durableCancellationEvents: 1,
      durableAllowedAudits: 2,
      processIdentityObserved: true,
      processIdentityGone: true,
      restartObservedCancelled: true,
      sqliteIntegrity: 'ok',
    },
    qualification: {
      evidenceClass: 'linux_virtualized_live_contract',
      physicalDevice: false,
      passed: true,
    },
    compatible: true,
    artifact: {
      profile: `${profile}-application-api`,
      bytes: 4 * 1024 * 1024,
      files: 429,
      loadedModules: 85,
      compatible: true,
    },
  };
}

test('accepts exact Edge and Standalone API to process-stop evidence', () => {
  for (const profile of ['edge', 'standalone']) {
    assert.deepEqual(validateLocalApiCancellationLiveReport(report(profile)), {
      compatible: true,
      findings: [],
    });
  }
});

test('rejects missing process, replay, resource, artifact or qualification facts', () => {
  for (const mutate of [
    (value) => {
      value.observations.processIdentityGone = false;
    },
    (value) => {
      value.observations.exactReplay = false;
    },
    (value) => {
      value.resourceEnvelope.memoryBytes += 1;
    },
    (value) => {
      value.artifact.bytes = 6 * 1024 * 1024 + 1;
    },
    (value) => {
      value.qualification.physicalDevice = true;
    },
    (value) => {
      value.unreviewed = true;
    },
  ]) {
    const value = report();
    mutate(value);
    assert.equal(
      validateLocalApiCancellationLiveReport(value).compatible,
      false,
    );
  }
});

test('requires a fresh private report before Docker opt-in is checked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-local-cancel-test-'));
  try {
    const script = path.resolve(
      __dirname,
      '../../scripts/ql3-local-api-cancellation-live-contract.cjs',
    );
    const reportPath = path.join(root, 'report.json');
    const result = spawnSync(
      process.execPath,
      [script, '--profile=edge', `--report=${reportPath}`],
      {
        encoding: 'utf8',
        env: { ...process.env, QL3_LOCAL_API_CANCELLATION_LIVE: '0' },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing to run Docker/);
    assert.equal(fs.existsSync(reportPath), false);
    fs.writeFileSync(reportPath, '{}', { mode: 0o600 });
    const existing = spawnSync(
      process.execPath,
      [script, '--profile=edge', `--report=${reportPath}`],
      {
        encoding: 'utf8',
        env: { ...process.env, QL3_LOCAL_API_CANCELLATION_LIVE: '1' },
      },
    );
    assert.equal(existing.status, 1);
    assert.match(existing.stderr, /fresh normalized absolute/);
    assert.doesNotMatch(existing.stderr, /docker/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
