require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const {
  LegacyShadowCaptureAuthority,
} = require('../../back/runtime/application/legacyShadowCaptureAuthority');
const {
  bootstrapLegacyShadowCaptureEvidence,
} = require('../../back/runtime/adapters/legacy/bootstrapLegacyShadowCaptureEvidence');

const directories = [];

function startup(state = 'reconciled') {
  if (state !== 'reconciled') return { state };
  return {
    state: 'reconciled',
    profile: 'edge',
    origins: 1,
    summary: {},
    metrics: {},
    report: {
      schema: 'qinglong/legacy-shadow-startup-difference-report@v1',
      schemaVersion: 1,
      profile: 'edge',
      assessment: 'converged',
      configuredOriginCount: 1,
      budget: { pageSize: 8, maxPages: 1, maxCandidates: 8 },
      coverage: {
        pages: 1,
        scanned: 0,
        stopReason: 'complete',
        remaining: false,
        resumeAvailable: false,
      },
      outcomes: {
        completed: 0,
        cancelled: 0,
        abandoned: 0,
        markedLost: 0,
        repaired: 0,
        pending: 0,
        ambiguous: 0,
        skipped: 0,
        failed: 0,
      },
      byOrigin: [
        {
          origin: 'manual',
          scanned: 0,
          completed: 0,
          cancelled: 0,
          abandoned: 0,
          markedLost: 0,
          repaired: 0,
          pending: 0,
          ambiguous: 0,
          skipped: 0,
          failed: 0,
        },
      ],
    },
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

test('exports one qualified no-identity capture report on clean shutdown', async () => {
  let now = 1_750_300_000_000;
  const authority = new LegacyShadowCaptureAuthority(
    { now: () => now },
    '019f75d2-3333-7333-8333-333333333333',
  );
  let evidence;
  const audits = [];
  const handle = await bootstrapLegacyShadowCaptureEvidence({
    startup: startup(),
    origins: ['manual'],
    profile: 'edge',
    outputPath: '/private/evidence.json',
    snapshot: (origins) => authority.snapshot(origins),
    async write(_outputPath, value) {
      evidence = value;
    },
    audit: (record) => audits.push(record),
  });
  for (let index = 0; index < 8; index += 1) {
    authority.admit('manual').captured();
  }
  now += 1_000;

  assert.equal(handle.active, true);
  assert.equal((await handle.close()).state, 'exported');
  assert.deepEqual(await handle.close(), audits.at(-1));
  assert.equal(evidence.qualification.passed, true);
  assert.equal(evidence.capture.totals.admitted, 8);
  assert.equal(evidence.capture.capturePermille, 1_000);
  assert.doesNotMatch(JSON.stringify(evidence), /taskId|runId|attemptId|pid/);
  assert.deepEqual(
    audits.map((record) => record.state),
    ['armed', 'exported'],
  );
});

test('writes owner-private evidence once and refuses overwrite', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-capture-'));
  directories.push(directory);
  const outputPath = path.join(directory, 'capture.json');
  let now = 1_750_300_000_000;
  const authority = new LegacyShadowCaptureAuthority(
    { now: () => now },
    '019f75d2-4444-7444-8444-444444444444',
  );
  const options = {
    startup: startup(),
    origins: ['manual'],
    profile: 'edge',
    outputPath,
    snapshot: (origins) => authority.snapshot(origins),
    audit() {},
  };
  const first = await bootstrapLegacyShadowCaptureEvidence(options);
  authority.admit('manual').captured();
  now += 1_000;
  assert.equal((await first.close()).state, 'exported');
  assert.equal((await fs.stat(outputPath)).mode & 0o777, 0o600);

  const second = await bootstrapLegacyShadowCaptureEvidence(options);
  authority.admit('manual').captured();
  now += 1_000;
  assert.equal((await second.close()).state, 'failed');
});

test('stays inert without an explicit path and rejects missing startup authority', async () => {
  const disabled = await bootstrapLegacyShadowCaptureEvidence({
    startup: { state: 'disabled' },
    origins: [],
    profile: 'edge',
    audit() {},
  });
  assert.equal(disabled.active, false);
  assert.equal((await disabled.close()).state, 'disabled');

  const failed = await bootstrapLegacyShadowCaptureEvidence({
    startup: { state: 'incomplete' },
    origins: ['manual'],
    profile: 'edge',
    outputPath: '/private/evidence.json',
    audit() {},
  });
  assert.equal(failed.active, false);
  assert.equal((await failed.close()).state, 'failed');
});
