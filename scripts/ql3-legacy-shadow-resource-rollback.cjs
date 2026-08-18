#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const sqlite3 = require('sqlite3');
const { DataTypes, QueryTypes, Sequelize } = require('sequelize');
const REPOSITORY_ROOT = path.resolve(__dirname, '..');
process.env.QL_DIR ??= REPOSITORY_ROOT;
const BUILD_ROOT = path.join(REPOSITORY_ROOT, 'static/build');
const BUILD_AVAILABLE = fs.existsSync(
  path.join(
    BUILD_ROOT,
    'runtime/application/legacyShadowTerminalDifferenceAuditor.js',
  ),
);
if (!BUILD_AVAILABLE) require('ts-node/register/transpile-only');
const fromRuntime = (relativePath) =>
  require(path.join(
    BUILD_AVAILABLE ? BUILD_ROOT : path.join(REPOSITORY_ROOT, 'back'),
    relativePath,
  ));

const MIB = 1024 * 1024;
const BASE_TIME_MS = 1_750_200_000_000;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const PROFILES = Object.freeze({
  edge: Object.freeze({ candidates: 8, pageSize: 8, maxPages: 1 }),
  standalone: Object.freeze({ candidates: 128, pageSize: 32, maxPages: 4 }),
});
const MEASURES = Object.freeze([
  'real_sequelize_sqlite_shadow_terminal_audit',
  'profile_maximum_closed_window_candidate_count',
  'bounded_candidate_and_evidence_query_count',
  'read_only_database_storage_stability',
  'process_restart_shadow_enabled_to_off',
  'real_legacy_child_execution_before_and_after_restart',
  'off_path_zero_fact_factory_and_shadow_write',
]);
const EXCLUSIONS = Object.freeze([
  'legacy_to_shadow_capture_rate',
  'physical_router_or_flash_wear',
  'power_loss_survival',
  'production_task_content_or_identity',
  'primary_execution_eligibility',
  'cluster_or_postgresql_runtime',
]);

class QingLong3LegacyShadowResourceRollbackError extends Error {
  constructor(message) {
    super(
      `QingLong 3.0 Legacy Shadow resource/rollback gate failed: ${message}`,
    );
    this.name = 'QingLong3LegacyShadowResourceRollbackError';
  }
}

function integerArgument(name, value, minimum, maximum) {
  if (!/^\d+$/.test(value)) {
    throw new QingLong3LegacyShadowResourceRollbackError(
      `${name} must be an integer`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new QingLong3LegacyShadowResourceRollbackError(
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    profile: 'edge',
    mode: 'full',
    samples: 8,
    maxAuditP95Ms: 2_000,
    maxRssDeltaBytes: 64 * MIB,
    requireCompiled: false,
    json: false,
  };
  for (const argument of argv) {
    if (argument === '--' || argument === '--json') {
      if (argument === '--json') options.json = true;
    } else if (argument === '--require-compiled') {
      options.requireCompiled = true;
    } else if (argument.startsWith('--profile=')) {
      const value = argument.slice('--profile='.length);
      if (!(value in PROFILES)) {
        throw new QingLong3LegacyShadowResourceRollbackError(
          '--profile must be edge or standalone',
        );
      }
      options.profile = value;
    } else if (argument.startsWith('--mode=')) {
      const value = argument.slice('--mode='.length);
      if (value !== 'audit-only' && value !== 'full') {
        throw new QingLong3LegacyShadowResourceRollbackError(
          '--mode must be audit-only or full',
        );
      }
      options.mode = value;
    } else if (argument.startsWith('--samples=')) {
      options.samples = integerArgument(
        '--samples',
        argument.slice('--samples='.length),
        1,
        32,
      );
    } else if (argument.startsWith('--max-audit-p95-ms=')) {
      options.maxAuditP95Ms = integerArgument(
        '--max-audit-p95-ms',
        argument.slice('--max-audit-p95-ms='.length),
        1,
        60_000,
      );
    } else if (argument.startsWith('--max-rss-delta-mb=')) {
      options.maxRssDeltaBytes =
        integerArgument(
          '--max-rss-delta-mb',
          argument.slice('--max-rss-delta-mb='.length),
          1,
          512,
        ) * MIB;
    } else {
      throw new QingLong3LegacyShadowResourceRollbackError(
        `unsupported argument ${argument}`,
      );
    }
  }
  return Object.freeze(options);
}

function nextIdentifier(sequence) {
  return `019f7500-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
}

async function createFixture(databasePath, profile) {
  const { defineSchemaMigrationModel } = fromRuntime('data/schemaMigration');
  const { runSchemaMigration } = fromRuntime('migrations/0002-run-schema');
  const { runningInstanceRunReferenceMigration } = fromRuntime(
    'migrations/0003-running-instance-run-reference',
  );
  const { runCancellationRequestMigration } = fromRuntime(
    'migrations/0004-run-cancellation-request',
  );
  const { runAttemptDeadlineMigration } = fromRuntime(
    'migrations/0006-run-attempt-deadline',
  );
  const { runMigrations } = fromRuntime('migrations/runner');
  const { createLegacyLogArtifactId } = fromRuntime(
    'runtime/compatibility/legacyTaskRevision',
  );
  const { LegacySequelizeRunRepository } = fromRuntime(
    'runtime/adapters/legacy-sequelize/runRepository',
  );
  const { LegacyShadowRunWriter } = fromRuntime(
    'runtime/application/legacyShadowRunWriter',
  );
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: databasePath,
    logging: false,
  });
  try {
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
    let identifierSequence = 10_000;
    const repository = new LegacySequelizeRunRepository(database);
    const writer = new LegacyShadowRunWriter(repository, () => {
      identifierSequence += 1;
      return nextIdentifier(identifierSequence);
    });
    const rows = [];
    for (let index = 0; index < PROFILES[profile].candidates; index += 1) {
      const acceptedAtMs = BASE_TIME_MS + index * 2_000;
      const legacyCronId = index + 1;
      const pid = 20_000 + index;
      const logPath = `resource/${index}.log`;
      const reference = await writer.accept({
        origin: 'manual',
        projectId: 'default',
        taskId: `legacy-resource:${index}`,
        taskRevision: `sha256:${String(index).padStart(64, '0')}`,
        legacyCronId,
        triggerType: 'manual',
        acceptedAtMs,
      });
      await writer.spawned(reference, {
        atMs: acceptedAtMs + 100,
        pid,
        logArtifactId: createLegacyLogArtifactId(logPath),
      });
      await writer.running(reference, acceptedAtMs + 200);
      await writer.exited(reference, {
        atMs: acceptedAtMs + 500,
        exitCode: 0,
      });
      rows.push({
        cron_id: legacyCronId,
        run_id: reference.runId,
        attempt_id: reference.attemptId,
        pid,
        log_path: logPath,
        started_at: Math.floor((acceptedAtMs + 100) / 1_000),
        finished_at: Math.floor((acceptedAtMs + 500) / 1_000),
        status: 1,
        exit_code: 0,
      });
    }
    await database.getQueryInterface().bulkInsert('RunningInstances', rows);
  } finally {
    await database.close();
  }
}

function fileStorage(databasePath) {
  const files = [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`,
  ];
  let logicalBytes = 0;
  let allocatedBytes = 0;
  let fileCount = 0;
  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      logicalBytes += stat.size;
      allocatedBytes += stat.blocks * 512;
      fileCount += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return Object.freeze({ logicalBytes, allocatedBytes, fileCount });
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

async function auditChild(options) {
  const { createLegacyLogArtifactId } = fromRuntime(
    'runtime/compatibility/legacyTaskRevision',
  );
  const { LegacySequelizeShadowTerminalDifferenceSource } = fromRuntime(
    'runtime/adapters/legacy-sequelize/legacyShadowTerminalDifferenceSource',
  );
  const { LegacyShadowTerminalDifferenceAuditor } = fromRuntime(
    'runtime/application/legacyShadowTerminalDifferenceAuditor',
  );
  const databasePath = process.env.QL3_SHADOW_DRILL_DATABASE;
  if (!path.isAbsolute(databasePath ?? '')) {
    throw new QingLong3LegacyShadowResourceRollbackError(
      'internal audit database is invalid',
    );
  }
  let queryCount = 0;
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: databasePath,
    logging() {
      queryCount += 1;
    },
    dialectOptions: { mode: sqlite3.OPEN_READONLY },
    pool: { max: 1, min: 0, idle: 1_000, acquire: 5_000 },
  });
  const rssBeforeBytes = process.memoryUsage().rss;
  const durationsMs = [];
  let pages = 0;
  let scanned = 0;
  try {
    const source = new LegacySequelizeShadowTerminalDifferenceSource(
      database,
      createLegacyLogArtifactId,
    );
    const auditor = new LegacyShadowTerminalDifferenceAuditor(source);
    const profile = PROFILES[options.profile];
    const windowEndMs = BASE_TIME_MS + (profile.candidates - 1) * 2_000 + 1_000;
    for (let sample = 0; sample < options.samples; sample += 1) {
      const startedAt = performance.now();
      const report = await auditor.run({
        profile: options.profile,
        origins: ['manual'],
        windowStartMs: BASE_TIME_MS - 1,
        windowEndMs,
        observedAtMs: windowEndMs + 5 * 60_000,
      });
      durationsMs.push(performance.now() - startedAt);
      if (
        report.assessment !== 'matched' ||
        report.scanned !== profile.candidates ||
        report.remaining ||
        !report.evidenceComplete ||
        report.terminalAgreementPermille !== 1_000
      ) {
        throw new QingLong3LegacyShadowResourceRollbackError(
          'audit child did not reproduce the closed matched cohort',
        );
      }
      pages += report.pages;
      scanned += report.scanned;
    }
  } finally {
    await database.close();
  }
  const rssAfterBytes = process.memoryUsage().rss;
  return Object.freeze({
    samples: options.samples,
    pages,
    scanned,
    queryCount,
    expectedQueryCount: pages * 2,
    durationP50Ms: Number(percentile(durationsMs, 0.5).toFixed(3)),
    durationP95Ms: Number(percentile(durationsMs, 0.95).toFixed(3)),
    durationMaxMs: Number(Math.max(...durationsMs).toFixed(3)),
    rssBeforeBytes,
    rssAfterBytes,
    rssDeltaBytes: Math.max(0, rssAfterBytes - rssBeforeBytes),
    peakProcessRssBytes: process.resourceUsage().maxRSS * 1024,
  });
}

function logger() {
  return { info() {}, warn() {}, error() {} };
}

async function runSummary(database) {
  const [row] = await database.query(
    `SELECT
       COUNT(*) AS count,
       SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded
       FROM Runs
      WHERE execution_owner = 'legacy'`,
    { type: QueryTypes.SELECT },
  );
  return Object.freeze({
    count: Number(row.count),
    succeeded: Number(row.succeeded ?? 0),
  });
}

async function rollbackChild(mode, expectedBefore, profile) {
  const databasePath = process.env.QL3_SHADOW_DRILL_DATABASE;
  if (!path.isAbsolute(databasePath ?? '')) {
    throw new QingLong3LegacyShadowResourceRollbackError(
      'internal rollback database is invalid',
    );
  }
  const taskLimit = fromRuntime('shared/pLimit').default;
  await taskLimit.setCustomLimit();
  const ScheduleService = fromRuntime('services/schedule').default;
  const bridge = fromRuntime('runtime/compatibility/legacyExecutionBridge');
  const { createLegacyShadowCaptureReport } = fromRuntime(
    'runtime/application/legacyShadowCaptureAuthority',
  );
  const { sequelize } = fromRuntime('data');
  let shortCircuitFactCalls = 0;
  try {
    const configuredOrigins = bridge.configuredLegacyShadowOrigins();
    const captureBefore =
      mode === 'enabled'
        ? bridge.legacyShadowCaptureSnapshot(['system'])
        : undefined;
    if (mode === 'off') {
      const observation = bridge.observeLegacyExecution('system', () => {
        shortCircuitFactCalls += 1;
        throw new Error('off path must not construct a Shadow fact');
      });
      if (observation !== undefined || shortCircuitFactCalls !== 0) {
        throw new QingLong3LegacyShadowResourceRollbackError(
          'off path did not short-circuit before Shadow fact construction',
        );
      }
    }
    const service = new ScheduleService(logger());
    const command = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;
    const result = await service.runTask(
      command,
      {},
      {
        id: 'opaque-resource-rollback',
        name: 'resource rollback fixture',
        schedule: '0 * * * *',
        runOrigin: 'system',
      },
    );
    const expectedAfter = expectedBefore + (mode === 'enabled' ? 1 : 0);
    const deadline = Date.now() + 10_000;
    let observed = await runSummary(sequelize);
    while (
      (observed.count !== expectedAfter ||
        observed.succeeded !== expectedAfter) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      observed = await runSummary(sequelize);
    }
    const loadedModules = Object.keys(require.cache);
    const defaultObserverLoaded = loadedModules.some((filePath) =>
      /legacyShadowRunObserver\.(?:ts|js)$/.test(filePath),
    );
    const repositoryLoaded = loadedModules.some((filePath) =>
      /legacy-sequelize\/runRepository\.(?:ts|js)$/.test(filePath),
    );
    if (
      result?.code !== 0 ||
      observed.count !== expectedAfter ||
      observed.succeeded !== expectedAfter
    ) {
      throw new QingLong3LegacyShadowResourceRollbackError(
        `${mode} restart did not preserve the expected Legacy result`,
      );
    }
    const capture =
      mode === 'enabled'
        ? createLegacyShadowCaptureReport(
            profile,
            ['system'],
            captureBefore,
            bridge.legacyShadowCaptureSnapshot(['system']),
          )
        : undefined;
    return Object.freeze({
      mode,
      configuredOrigins,
      legacyExitCode: result.code,
      runCountBefore: expectedBefore,
      runCountAfter: observed.count,
      succeededRunCountAfter: observed.succeeded,
      runDelta: observed.count - expectedBefore,
      shortCircuitFactCalls,
      defaultObserverLoaded,
      repositoryLoaded,
      ...(capture === undefined ? {} : { capture }),
      peakProcessRssBytes: process.resourceUsage().maxRSS * 1024,
    });
  } finally {
    await sequelize.close();
  }
}

function runInternalChild(args, env) {
  const result = spawnSync(process.execPath, [__filename, ...args], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new QingLong3LegacyShadowResourceRollbackError(
      `internal child failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  try {
    const lines = result.stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines.reverse()) {
      try {
        return JSON.parse(line);
      } catch {
        // Some legacy dependencies emit bounded diagnostics on stdout.
      }
    }
    throw new Error('no JSON record was emitted');
  } catch (error) {
    throw new QingLong3LegacyShadowResourceRollbackError(
      `internal child returned invalid JSON: ${error.message}`,
    );
  }
}

async function inspectDatabase(databasePath) {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: databasePath,
    logging: false,
    dialectOptions: { mode: sqlite3.OPEN_READONLY },
    pool: { max: 1, min: 0 },
  });
  try {
    const [integrity] = await database.query('PRAGMA integrity_check', {
      type: QueryTypes.SELECT,
    });
    return Object.freeze({
      integrity: integrity.integrity_check,
      runCount: (await runSummary(database)).count,
    });
  } finally {
    await database.close();
  }
}

async function runEvidence(options) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-legacy-shadow-resource-'),
  );
  const dataDirectory = path.join(directory, 'data');
  const databaseDirectory = path.join(dataDirectory, 'db');
  const databasePath = path.join(databaseDirectory, 'database.sqlite');
  const previousDataDirectory = process.env.QL_DATA_DIR;
  fs.mkdirSync(databaseDirectory, { recursive: true });
  process.env.QL_DATA_DIR = dataDirectory;
  try {
    await createFixture(databasePath, options.profile);
    const beforeAudit = fileStorage(databasePath);
    const childEnvironment = {
      QL_DATA_DIR: dataDirectory,
      QL3_SHADOW_DRILL_DATABASE: databasePath,
    };
    let audit;
    if (options.mode === 'audit-only') {
      const previousDatabase = process.env.QL3_SHADOW_DRILL_DATABASE;
      process.env.QL3_SHADOW_DRILL_DATABASE = databasePath;
      try {
        audit = await auditChild(options);
      } finally {
        if (previousDatabase === undefined) {
          delete process.env.QL3_SHADOW_DRILL_DATABASE;
        } else {
          process.env.QL3_SHADOW_DRILL_DATABASE = previousDatabase;
        }
      }
    } else {
      audit = runInternalChild(
        [
          '--internal-child=audit',
          `--profile=${options.profile}`,
          `--samples=${options.samples}`,
          `--max-audit-p95-ms=${options.maxAuditP95Ms}`,
          `--max-rss-delta-mb=${options.maxRssDeltaBytes / MIB}`,
        ],
        { ...childEnvironment, QL3_SHADOW_ORIGINS: '' },
      );
    }
    const afterAudit = fileStorage(databasePath);
    const fixtureRunCount = PROFILES[options.profile].candidates;
    const enabled =
      options.mode === 'full'
        ? runInternalChild(
            [
              '--internal-child=rollback-enabled',
              `--expected-before=${fixtureRunCount}`,
              `--profile=${options.profile}`,
            ],
            { ...childEnvironment, QL3_SHADOW_ORIGINS: 'system' },
          )
        : undefined;
    const off =
      options.mode === 'full'
        ? runInternalChild(
            [
              '--internal-child=rollback-off',
              `--expected-before=${fixtureRunCount + 1}`,
              `--profile=${options.profile}`,
            ],
            { ...childEnvironment, QL3_SHADOW_ORIGINS: '' },
          )
        : undefined;
    const finalDatabase = await inspectDatabase(databasePath);
    const violations = [];
    if (audit.queryCount !== audit.expectedQueryCount) {
      violations.push('audit query count exceeded the two-query page contract');
    }
    if (audit.durationP95Ms > options.maxAuditP95Ms) {
      violations.push('audit p95 exceeded its configured resource budget');
    }
    if (audit.rssDeltaBytes > options.maxRssDeltaBytes) {
      violations.push(
        'audit RSS delta exceeded its configured resource budget',
      );
    }
    if (
      beforeAudit.logicalBytes !== afterAudit.logicalBytes ||
      beforeAudit.allocatedBytes !== afterAudit.allocatedBytes ||
      beforeAudit.fileCount !== afterAudit.fileCount
    ) {
      violations.push('read-only audit changed SQLite storage');
    }
    if (
      options.mode === 'full' &&
      (enabled.runDelta !== 1 ||
        enabled.legacyExitCode !== 0 ||
        !enabled.defaultObserverLoaded ||
        !enabled.repositoryLoaded)
    ) {
      violations.push(
        'enabled restart did not produce one Shadow terminal Run',
      );
    }
    if (
      options.mode === 'full' &&
      (off.runDelta !== 0 ||
        off.legacyExitCode !== 0 ||
        off.configuredOrigins.length !== 0 ||
        off.shortCircuitFactCalls !== 0 ||
        off.defaultObserverLoaded ||
        off.repositoryLoaded)
    ) {
      violations.push('off restart retained Shadow initialization or writes');
    }
    if (
      finalDatabase.integrity !== 'ok' ||
      finalDatabase.runCount !==
        fixtureRunCount + (options.mode === 'full' ? 1 : 0)
    ) {
      violations.push('rollback drill database did not converge safely');
    }
    return Object.freeze({
      schemaVersion: 1,
      fixture: 'qinglong/legacy-shadow-resource-rollback-evidence@v1',
      profile: options.profile,
      workload: Object.freeze({
        mode: options.mode,
        runtime: BUILD_AVAILABLE ? 'compiled_backend' : 'typescript_fallback',
        candidates: PROFILES[options.profile].candidates,
        pageSize: PROFILES[options.profile].pageSize,
        maxPages: PROFILES[options.profile].maxPages,
        samples: options.samples,
      }),
      audit: Object.freeze({
        ...audit,
        databaseStorageBefore: beforeAudit,
        databaseStorageAfter: afterAudit,
        readOnlyStorageStable:
          beforeAudit.logicalBytes === afterAudit.logicalBytes &&
          beforeAudit.allocatedBytes === afterAudit.allocatedBytes &&
          beforeAudit.fileCount === afterAudit.fileCount,
      }),
      rollback:
        options.mode === 'full'
          ? Object.freeze({
              performed: true,
              mechanism: 'process_restart_environment_disable',
              enabled: Object.freeze({
                configuredOrigins: enabled.configuredOrigins,
                legacyExitCode: enabled.legacyExitCode,
                runDelta: enabled.runDelta,
                defaultObserverLoaded: enabled.defaultObserverLoaded,
                repositoryLoaded: enabled.repositoryLoaded,
                capture: enabled.capture,
                peakProcessRssBytes: enabled.peakProcessRssBytes,
              }),
              off: Object.freeze({
                configuredOrigins: off.configuredOrigins,
                legacyExitCode: off.legacyExitCode,
                runDelta: off.runDelta,
                shortCircuitFactCalls: off.shortCircuitFactCalls,
                defaultObserverLoaded: off.defaultObserverLoaded,
                repositoryLoaded: off.repositoryLoaded,
                peakProcessRssBytes: off.peakProcessRssBytes,
              }),
              finalRunCount: finalDatabase.runCount,
              databaseIntegrity: finalDatabase.integrity,
              legacyContinued:
                enabled.legacyExitCode === 0 && off.legacyExitCode === 0,
              shadowWritesStopped: enabled.runDelta === 1 && off.runDelta === 0,
              physicalPowerLossProven: false,
            })
          : Object.freeze({
              performed: false,
              reason: 'separate_release_gate',
              finalRunCount: finalDatabase.runCount,
              databaseIntegrity: finalDatabase.integrity,
            }),
      qualification: Object.freeze({
        passed: violations.length === 0,
        measures: options.mode === 'full' ? MEASURES : MEASURES.slice(0, 4),
        doesNotProve:
          options.mode === 'full'
            ? EXCLUSIONS
            : [...EXCLUSIONS, 'shadow_off_process_restart_rollback'],
        violations,
      }),
    });
  } finally {
    if (previousDataDirectory === undefined) {
      delete process.env.QL_DATA_DIR;
    } else {
      process.env.QL_DATA_DIR = previousDataDirectory;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const internalChild = process.argv.find((argument) =>
    argument.startsWith('--internal-child='),
  );
  if (internalChild) {
    const mode = internalChild.slice('--internal-child='.length);
    const profile =
      process.argv
        .find((argument) => argument.startsWith('--profile='))
        ?.slice('--profile='.length) ?? 'edge';
    const samples = Number(
      process.argv
        .find((argument) => argument.startsWith('--samples='))
        ?.slice('--samples='.length) ?? 1,
    );
    let report;
    if (mode === 'audit') {
      report = await auditChild({ profile, samples });
    } else if (mode === 'rollback-enabled' || mode === 'rollback-off') {
      const expectedBefore = Number(
        process.argv
          .find((argument) => argument.startsWith('--expected-before='))
          ?.slice('--expected-before='.length),
      );
      if (!Number.isSafeInteger(expectedBefore) || expectedBefore < 0) {
        throw new QingLong3LegacyShadowResourceRollbackError(
          'internal expected Run count is invalid',
        );
      }
      report = await rollbackChild(
        mode === 'rollback-enabled' ? 'enabled' : 'off',
        expectedBefore,
        profile,
      );
    } else {
      throw new QingLong3LegacyShadowResourceRollbackError(
        'internal child mode is invalid',
      );
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  const options = parseArguments(process.argv.slice(2));
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new QingLong3LegacyShadowResourceRollbackError(
      'Node.js 24 or newer is required',
    );
  }
  if (options.requireCompiled && !BUILD_AVAILABLE) {
    throw new QingLong3LegacyShadowResourceRollbackError(
      'compiled backend is required for resource evidence',
    );
  }
  const report = await runEvidence(options);
  process.stdout.write(
    `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`,
  );
  if (!report.qualification.passed) process.exitCode = 1;
}

module.exports = {
  EXCLUSIONS,
  MEASURES,
  PROFILES,
  QingLong3LegacyShadowResourceRollbackError,
  parseArguments,
  percentile,
  runEvidence,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
