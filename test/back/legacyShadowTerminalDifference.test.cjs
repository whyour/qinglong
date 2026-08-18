require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');
const { DataTypes, Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const { runSchemaMigration } = require('../../back/migrations/0002-run-schema');
const {
  runningInstanceRunReferenceMigration,
} = require('../../back/migrations/0003-running-instance-run-reference');
const {
  runCancellationRequestMigration,
} = require('../../back/migrations/0004-run-cancellation-request');
const {
  runAttemptDeadlineMigration,
} = require('../../back/migrations/0006-run-attempt-deadline');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeRunRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/runRepository');
const {
  LegacySequelizeShadowTerminalDifferenceSource,
} = require('../../back/runtime/adapters/legacy-sequelize/legacyShadowTerminalDifferenceSource');
const {
  LegacyShadowRunWriter,
} = require('../../back/runtime/application/legacyShadowRunWriter');
const {
  LegacyShadowTerminalDifferenceAuditor,
} = require('../../back/runtime/application/legacyShadowTerminalDifferenceAuditor');
const {
  createLegacyLogArtifactId,
} = require('../../back/runtime/compatibility/legacyTaskRevision');
const {
  parseArguments,
} = require('../../scripts/ql3-legacy-shadow-terminal-audit.cjs');

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(
  REPOSITORY_ROOT,
  'scripts',
  'ql3-legacy-shadow-terminal-audit.cjs',
);
const BASE_TIME = 1_750_100_000_000;
const databases = [];
const temporaryDirectories = [];
let idSequence = 4_000;
let timeSequence = BASE_TIME;

function nextId() {
  idSequence += 1;
  return `019f7300-0000-7000-8000-${String(idSequence).padStart(12, '0')}`;
}

function nextTime() {
  timeSequence += 10_000;
  return timeSequence;
}

async function createDatabase(storage = ':memory:') {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
  });
  await database.getQueryInterface().createTable('RunningInstances', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    cron_id: { type: DataTypes.INTEGER, allowNull: false },
    pid: { type: DataTypes.INTEGER, allowNull: true },
    log_path: { type: DataTypes.STRING, allowNull: true },
    started_at: { type: DataTypes.INTEGER, allowNull: false },
    finished_at: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.INTEGER, allowNull: false },
    exit_code: { type: DataTypes.INTEGER, allowNull: true },
  });
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: [
      runSchemaMigration,
      runningInstanceRunReferenceMigration,
      runCancellationRequestMigration,
      runAttemptDeadlineMigration,
    ],
    logger: { info() {} },
  });
  databases.push(database);
  return database;
}

async function createStack(storage) {
  const database = await createDatabase(storage);
  const repository = new LegacySequelizeRunRepository(database);
  const writer = new LegacyShadowRunWriter(repository, nextId);
  const source = new LegacySequelizeShadowTerminalDifferenceSource(
    database,
    createLegacyLogArtifactId,
  );
  const auditor = new LegacyShadowTerminalDifferenceAuditor(source);
  return { database, repository, writer, source, auditor };
}

async function createShadow(writer, overrides = {}) {
  const acceptedAtMs = overrides.acceptedAtMs ?? nextTime();
  const legacyCronId = overrides.legacyCronId ?? 31;
  const pid = overrides.pid ?? 5_101;
  const logPath = overrides.logPath ?? `cron/${acceptedAtMs}.log`;
  const origin = overrides.origin ?? 'manual';
  const reference = await writer.accept({
    origin,
    projectId: 'default',
    taskId: `legacy-cron:${legacyCronId}`,
    taskRevision: `sha256:terminal-audit-${legacyCronId}`,
    legacyCronId,
    triggerType: origin,
    acceptedAtMs,
  });
  if (overrides.acceptedOnly) {
    return { acceptedAtMs, legacyCronId, pid, logPath, origin, reference };
  }
  await writer.spawned(reference, {
    atMs: acceptedAtMs + 100,
    pid,
    logArtifactId: createLegacyLogArtifactId(logPath),
  });
  await writer.running(reference, acceptedAtMs + 200);
  if (!overrides.runningOnly) {
    await writer.exited(reference, {
      atMs: acceptedAtMs + 500,
      exitCode: overrides.shadowExitCode ?? 0,
    });
  }
  return { acceptedAtMs, legacyCronId, pid, logPath, origin, reference };
}

async function insertInstance(database, shadow, overrides = {}) {
  await database.getQueryInterface().bulkInsert('RunningInstances', [
    {
      cron_id: shadow.legacyCronId,
      run_id:
        overrides.direct === false
          ? null
          : overrides.runId ?? shadow.reference.runId,
      attempt_id:
        overrides.direct === false
          ? null
          : overrides.attemptId ?? shadow.reference.attemptId,
      pid: overrides.pid ?? shadow.pid,
      log_path: overrides.logPath ?? shadow.logPath,
      started_at: Math.floor((shadow.acceptedAtMs + 100) / 1_000),
      finished_at: Math.floor(
        (shadow.acceptedAtMs + (overrides.finishedOffsetMs ?? 500)) / 1_000,
      ),
      status: overrides.status ?? 1,
      exit_code: overrides.exitCode ?? 0,
    },
  ]);
}

function auditOptions(shadows, overrides = {}) {
  const times = shadows.map((shadow) => shadow.acceptedAtMs);
  const start = Math.min(...times) - 1;
  const end = Math.max(...times) + 1;
  return {
    profile: overrides.profile ?? 'edge',
    origins: overrides.origins ?? ['manual'],
    windowStartMs: start,
    windowEndMs: end,
    observedAtMs: overrides.observedAtMs ?? end + 5 * 60_000,
    minimumSettlingAgeMs: 5 * 60_000,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reports a closed, fully comparable Shadow-to-Legacy terminal match', async () => {
  const { database, writer, auditor } = await createStack();
  const shadow = await createShadow(writer);
  await insertInstance(database, shadow);

  const report = await auditor.run(auditOptions([shadow]));

  assert.equal(report.assessment, 'matched');
  assert.equal(report.counts.matched, 1);
  assert.equal(report.terminalAgreementPermille, 1_000);
  assert.equal(report.fullyComparablePermille, 1_000);
  assert.equal(report.coverage.direction, 'shadow_to_legacy');
  assert.equal(report.coverage.legacyWithoutShadow, 'not_measured');
  assert.equal(JSON.stringify(report).includes(shadow.reference.runId), false);
  assert.equal(JSON.stringify(report).includes(shadow.logPath), false);
});

test('separates terminal status and field differences', async () => {
  const { database, writer, auditor } = await createStack();
  const statusShadow = await createShadow(writer, { legacyCronId: 41 });
  const fieldShadow = await createShadow(writer, { legacyCronId: 42 });
  await insertInstance(database, statusShadow, { status: 3, exitCode: 1 });
  await insertInstance(database, fieldShadow, { exitCode: 9 });

  const report = await auditor.run(auditOptions([statusShadow, fieldShadow]));

  assert.equal(report.assessment, 'differences_found');
  assert.equal(report.counts.status_mismatch, 1);
  assert.equal(report.counts.field_mismatch, 1);
  assert.equal(report.dimensions.status.mismatched, 1);
  assert.equal(report.dimensions.exitCode.mismatched, 1);
  assert.equal(report.terminalAgreementPermille, 0);
});

test('does not guess when Legacy evidence is missing or ambiguous', async () => {
  const { database, writer, auditor } = await createStack();
  const missing = await createShadow(writer, { legacyCronId: 51 });
  const ambiguous = await createShadow(writer, { legacyCronId: 52 });
  await insertInstance(database, ambiguous, { direct: false });
  await insertInstance(database, ambiguous, { direct: false });

  const report = await auditor.run(auditOptions([missing, ambiguous]));

  assert.equal(report.counts.legacy_evidence_missing, 1);
  assert.equal(report.counts.legacy_evidence_ambiguous, 1);
  assert.equal(report.assessment, 'differences_found');
});

test('rejects conflicting direct Run and Attempt references as ambiguous', async () => {
  const { database, writer, auditor } = await createStack();
  const shadow = await createShadow(writer, { legacyCronId: 53 });
  await insertInstance(database, shadow, {
    attemptId: '019f7300-0000-7000-8000-999999999999',
  });

  const report = await auditor.run(auditOptions([shadow]));

  assert.equal(report.counts.legacy_evidence_ambiguous, 1);
  assert.equal(report.assessment, 'differences_found');
});

test('classifies a settled cohort member with an active Shadow Run', async () => {
  const { writer, auditor } = await createStack();
  const shadow = await createShadow(writer, { runningOnly: true });

  const report = await auditor.run(auditOptions([shadow]));

  assert.equal(report.counts.shadow_not_terminal, 1);
  assert.equal(report.assessment, 'differences_found');
});

test('withholds ratios while the measurement window is still open', async () => {
  const { database, writer, auditor } = await createStack();
  const shadow = await createShadow(writer);
  await insertInstance(database, shadow);
  const options = auditOptions([shadow], {
    observedAtMs: shadow.acceptedAtMs + 1_000,
  });

  const report = await auditor.run(options);

  assert.equal(report.assessment, 'window_open');
  assert.equal(report.window.closed, false);
  assert.equal(report.terminalAgreementPermille, undefined);
  assert.equal(report.fullyComparablePermille, undefined);
});

test('withholds ratios when the edge candidate budget is exhausted', async () => {
  const { database, writer, auditor } = await createStack();
  const shadows = [];
  for (let index = 0; index < 9; index += 1) {
    const shadow = await createShadow(writer, {
      legacyCronId: 60 + index,
      pid: 6_000 + index,
    });
    shadows.push(shadow);
    await insertInstance(database, shadow);
  }

  const report = await auditor.run(auditOptions(shadows));

  assert.equal(report.scanned, 8);
  assert.equal(report.remaining, true);
  assert.equal(report.stopReason, 'page_limit');
  assert.equal(report.assessment, 'incomplete');
  assert.equal(report.terminalAgreementPermille, undefined);
});

test('marks evidence overflow incomplete instead of accepting a partial match set', async () => {
  const { database, writer, auditor } = await createStack();
  const shadow = await createShadow(writer, { legacyCronId: 71 });
  for (let index = 0; index < 9; index += 1) {
    await insertInstance(database, shadow, {
      direct: false,
      pid: 7_100 + index,
      logPath: `cron/overflow-${index}.log`,
    });
  }

  const report = await auditor.run(auditOptions([shadow]));

  assert.equal(report.evidenceComplete, false);
  assert.equal(report.evidenceOverflowPages, 1);
  assert.equal(report.counts.legacy_evidence_ambiguous, 1);
  assert.equal(report.assessment, 'incomplete');
});

test('keeps an exact, conservation-safe matrix for configured origins', async () => {
  const { database, writer, auditor } = await createStack();
  const manual = await createShadow(writer, { legacyCronId: 81 });
  const system = await createShadow(writer, {
    legacyCronId: 82,
    origin: 'scheduled_system',
  });
  await insertInstance(database, manual);
  await insertInstance(database, system);

  const report = await auditor.run(
    auditOptions([manual, system], {
      origins: ['manual', 'scheduled_system'],
    }),
  );

  assert.deepEqual(
    report.byOrigin.map(({ origin, scanned, matched }) => ({
      origin,
      scanned,
      matched,
    })),
    [
      { origin: 'manual', scanned: 1, matched: 1 },
      { origin: 'scheduled_system', scanned: 1, matched: 1 },
    ],
  );
  assert.equal(
    Object.values(report.counts).reduce((sum, count) => sum + count, 0),
    report.scanned,
  );
});

test('reports an empty closed cohort without claiming agreement', async () => {
  const { auditor } = await createStack();
  const report = await auditor.run({
    profile: 'edge',
    origins: ['manual'],
    windowStartMs: BASE_TIME - 10_000,
    windowEndMs: BASE_TIME - 5_000,
    observedAtMs: BASE_TIME + 300_000,
  });

  assert.equal(report.assessment, 'empty');
  assert.equal(report.scanned, 0);
  assert.equal(report.terminalAgreementPermille, undefined);
});

test('rejects malformed windows, excessive origins and tolerance', async () => {
  const { auditor } = await createStack();
  await assert.rejects(
    auditor.run({
      profile: 'edge',
      origins: ['manual'],
      windowStartMs: 10,
      windowEndMs: 10,
    }),
    /non-empty/,
  );
  await assert.rejects(
    auditor.run({
      profile: 'edge',
      origins: [
        'manual',
        'boot',
        'scheduled_node',
        'scheduled_system',
        'script',
        'subscription',
        'system',
        'grpc',
      ],
      windowStartMs: 1,
      windowEndMs: 2,
    }),
    /origin count/,
  );
  await assert.rejects(
    auditor.run({
      profile: 'edge',
      origins: ['manual'],
      windowStartMs: 1,
      windowEndMs: 2,
      correlationToleranceMs: 60_001,
    }),
    /hard limit/,
  );
});

test('rejects an adapter page that exceeds the evidence hard limit', async () => {
  const auditor = new LegacyShadowTerminalDifferenceAuditor({
    async listCandidates() {
      return {
        candidates: [],
        evidence: [
          {
            instanceId: 1,
            legacyCronId: 1,
            startedAtMs: 1,
            finishedAtMs: 2,
            outcome: 'succeeded',
          },
        ],
        evidenceTruncated: false,
        truncated: false,
      };
    },
  });

  await assert.rejects(
    auditor.run({
      profile: 'edge',
      origins: ['manual'],
      windowStartMs: 1,
      windowEndMs: 2,
      observedAtMs: 300_002,
    }),
    /exceeded evidence limit/,
  );
});

test('CLI arguments require an explicit cohort and reject unsupported origins', () => {
  assert.throws(
    () => parseArguments(['--origin=manual', '--window-start-ms=1']),
    /window-end-ms is required/,
  );
  assert.throws(
    () =>
      parseArguments([
        '--origin=grpc',
        '--window-start-ms=1',
        '--window-end-ms=2',
      ]),
    /unsupported Shadow origin/,
  );
  const options = parseArguments([
    '--profile=standalone',
    '--origin=manual,scheduled_system',
    '--window-start-ms=1',
    '--window-end-ms=2',
    '--json',
  ]);
  assert.equal(options.profile, 'standalone');
  assert.deepEqual(options.origins, ['manual', 'scheduled_system']);
  assert.equal(options.json, true);
});

test('read-only CLI emits the versioned redacted report', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-shadow-audit-'));
  temporaryDirectories.push(directory);
  const storage = path.join(directory, 'database.sqlite');
  const { database, writer } = await createStack(storage);
  const shadow = await createShadow(writer, { legacyCronId: 91 });
  await insertInstance(database, shadow);
  await database.close();
  databases.splice(databases.indexOf(database), 1);
  const options = auditOptions([shadow]);

  const result = spawnSync(
    process.execPath,
    [
      CLI_PATH,
      `--database=${storage}`,
      '--profile=edge',
      '--origin=manual',
      `--window-start-ms=${options.windowStartMs}`,
      `--window-end-ms=${options.windowEndMs}`,
      `--observed-at-ms=${options.observedAtMs}`,
      '--json',
      '--fail-on-difference',
    ],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(
    report.schema,
    'qinglong/legacy-shadow-terminal-difference-report@v1',
  );
  assert.equal(report.assessment, 'matched');
  assert.equal(result.stdout.includes(shadow.reference.runId), false);
  assert.equal(result.stdout.includes(shadow.logPath), false);
});
