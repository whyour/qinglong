#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const MIB = 1024 * 1024;
const DEFAULT_MAX_DURATION_MS = 10_000;
const DEFAULT_MAX_RSS_DELTA_MB = 96;
const DEFAULT_MAX_DATABASE_GROWTH_BYTES = 4 * MIB;

const REPORT_KEYS = Object.freeze([
  'calls',
  'database',
  'durable',
  'evidenceClass',
  'gates',
  'identity',
  'limitations',
  'measurement',
  'recovery',
  'schemaVersion',
  'supported',
  'thresholds',
]);
const CALL_KEYS = Object.freeze([
  'byteSourceClose',
  'byteSourceOpen',
  'byteSourceRead',
  'publisherInspect',
  'publisherPublish',
  'stage',
]);
const DATABASE_KEYS = Object.freeze([
  'allocatedBytes',
  'allocatedGrowthBytes',
  'files',
  'integrityCheck',
  'journalMode',
  'logicalBytes',
  'logicalGrowthBytes',
  'materializedCandidateRevisions',
  'synchronous',
]);
const DATABASE_FILE_KEYS = Object.freeze([
  'allocatedBytes',
  'logicalBytes',
  'suffix',
]);
const DURABLE_KEYS = Object.freeze([
  'activeLockDigestPreserved',
  'failedFrom',
  'failureReason',
  'headInstallationIsCandidate',
  'previousActiveLockDigestPreserved',
  'state',
]);
const GATE_KEYS = Object.freeze(['passed', 'violations']);
const IDENTITY_KEYS = Object.freeze(['architecture', 'node', 'platform']);
const MEASUREMENT_KEYS = Object.freeze([
  'durationMs',
  'rssAfterBytes',
  'rssBeforeBytes',
  'rssDeltaBytes',
]);
const RECOVERY_KEYS = Object.freeze([
  'deferred',
  'manualRequired',
  'pages',
  'remaining',
  'retry',
  'safeToAdmit',
  'scanned',
  'settled',
  'superseded',
]);
const THRESHOLD_KEYS = Object.freeze([
  'maxDatabaseGrowthBytes',
  'maxDurationMs',
  'maxRssDeltaBytes',
]);
const EXPECTED_LIMITATIONS = Object.freeze([
  'container_or_vm_resource_limits_are_not_physical_support_evidence',
  'physical_power_loss_not_proven',
]);

class QingLong3PluginPackageRecoveryEdgeBenchmarkError extends Error {
  constructor(message) {
    super(
      `QingLong 3.0 Plugin Package recovery Edge benchmark failed: ${message}`,
    );
    this.name = 'QingLong3PluginPackageRecoveryEdgeBenchmarkError';
  }
}

function hasExactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected)
  );
}

function positiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new QingLong3PluginPackageRecoveryEdgeBenchmarkError(
      `${label} must be a positive number`,
    );
  }
  return parsed;
}

function positiveSafeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new QingLong3PluginPackageRecoveryEdgeBenchmarkError(
      `${label} must be a positive safe integer`,
    );
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    json: false,
    maxDatabaseGrowthBytes: DEFAULT_MAX_DATABASE_GROWTH_BYTES,
    maxDurationMs: DEFAULT_MAX_DURATION_MS,
    maxRssDeltaBytes: DEFAULT_MAX_RSS_DELTA_MB * MIB,
  };
  for (const argument of argv) {
    if (argument === '--') continue;
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    const [name, raw] = argument.split('=', 2);
    if (raw === undefined) {
      throw new QingLong3PluginPackageRecoveryEdgeBenchmarkError(
        `unsupported argument ${argument}`,
      );
    }
    if (name === '--max-duration-ms') {
      options.maxDurationMs = positiveNumber(raw, name);
    } else if (name === '--max-rss-delta-mb') {
      options.maxRssDeltaBytes = positiveNumber(raw, name) * MIB;
    } else if (name === '--max-database-growth-bytes') {
      options.maxDatabaseGrowthBytes = positiveSafeInteger(raw, name);
    } else {
      throw new QingLong3PluginPackageRecoveryEdgeBenchmarkError(
        `unsupported argument ${name}`,
      );
    }
  }
  return Object.freeze(options);
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function storageSnapshot(databasePath) {
  const files = [
    ['database', databasePath],
    ['-journal', `${databasePath}-journal`],
    ['-wal', `${databasePath}-wal`],
    ['-shm', `${databasePath}-shm`],
  ]
    .filter(([, filePath]) => fs.existsSync(filePath))
    .map(([suffix, filePath]) => {
      const stat = fs.statSync(filePath);
      return Object.freeze({
        suffix,
        logicalBytes: stat.size,
        allocatedBytes: stat.blocks * 512,
      });
    });
  return Object.freeze({
    files: Object.freeze(files),
    logicalBytes: files.reduce((sum, file) => sum + file.logicalBytes, 0),
    allocatedBytes: files.reduce((sum, file) => sum + file.allocatedBytes, 0),
  });
}

function packageFixture(runtime, generation, previous, invalidWorkflow) {
  const packageArchitecture =
    process.arch === 'x64'
      ? 'amd64'
      : process.arch === 'arm'
      ? 'arm/v7'
      : process.arch;
  const task = (id) => ({
    schema: 'qinglong/plugin-package-task-resource@v1',
    id,
    name: `Recovery ${id}`,
    labels: { 'plugin.qinglong.io/source': 'edge-recovery-benchmark' },
    enabled: true,
    kind: 'command',
    spec: {
      schema: 'qinglong/command@v1',
      config: {
        command: {
          kind: 'argv',
          file: '/usr/bin/printf',
          args: [id],
        },
      },
    },
  });
  const workflow = {
    schema: 'qinglong/plugin-package-workflow-resource@v1',
    id: 'recovery',
    name: 'Recovery qualification',
    enabled: true,
    steps: invalidWorkflow
      ? [
          { id: 'collect', task: 'collect', needs: ['report'] },
          { id: 'report', task: 'report', needs: ['collect'] },
        ]
      : [
          { id: 'collect', task: 'collect', needs: [] },
          { id: 'report', task: 'report', needs: ['collect'] },
        ],
  };
  const values = {
    'tasks/collect.json': task('collect'),
    'tasks/report.json': task('report'),
    'workflows/recovery.json': workflow,
  };
  const bytes = Object.fromEntries(
    Object.entries(values).map(([resourcePath, value]) => [
      resourcePath,
      Buffer.from(JSON.stringify(value)),
    ]),
  );
  const descriptors = Object.entries(bytes)
    .map(([resourcePath, material]) => ({
      path: resourcePath,
      bytes: material.byteLength,
      digest: sha256(material),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    apiVersion: runtime.PLUGIN_PACKAGE_API_VERSION,
    kind: runtime.PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'edge-recovery-benchmark',
      displayName: 'Edge recovery benchmark',
      version: `${generation}.0.0`,
      description: 'Bounded failed-upgrade qualification workload',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: [packageArchitecture],
        deploymentProfiles: ['edge'],
      },
      runtimes: [],
      resources: {
        memory: { recommended: '16Mi' },
        disk: { install: '4Mi', working: '8Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets: [],
        tools: ['system.command'],
      },
      contents: {
        tasks: ['tasks/collect.json', 'tasks/report.json'],
        workflows: ['workflows/recovery.json'],
        prompts: [],
        tools: [],
      },
    },
  };
  const environment = {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: packageArchitecture,
    deploymentProfile: 'edge',
    runtimes: [],
    availableMemoryBytes: 128 * MIB,
    availableDiskBytes: 256 * MIB,
  };
  const plan = runtime.planPluginPackageInstall(
    manifest,
    environment,
    previous?.manifest,
  );
  const artifactDigest = sha256(`edge-recovery-artifact-${generation}`);
  const action = {
    lockId: `edge-recovery-lock-${generation}`,
    projectId: 'default',
    manifest,
    plan,
    environment,
    ...(previous ? { previousManifest: previous.manifest } : {}),
    source: {
      kind: 'offline',
      locator: `offline:sha256:${artifactDigest}`,
      artifactDigest,
      artifactBytes: Object.values(bytes).reduce(
        (sum, material) => sum + material.byteLength,
        0,
      ),
      contentDigest: runtime.pluginPackageContentTreeDigest(descriptors),
    },
    architecture: packageArchitecture,
    deploymentProfile: 'edge',
    targetGeneration: generation,
    ...(previous ? { previousLockDigest: previous.lock.lockDigest } : {}),
  };
  const lock = runtime.createPluginPackageLock({
    ...action,
    approval: {
      requestId: `edge-recovery-approval-${generation}`,
      requestVersion: 1,
      dispatchId: `edge-recovery-dispatch-${generation}`,
      actionDigest: runtime.pluginPackageInstallActionDigest(action),
      previewDigest: runtime.pluginPackageInstallPlanDigest(plan),
      approvedBy: { type: 'user', id: 'edge-owner' },
      approvedAtMs: 100 + generation,
      expiresAtMs: 100_000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs: 200 + generation,
  });
  return Object.freeze({
    bytes: Object.freeze(bytes),
    lock,
    manifest,
    manifestBytes: Buffer.from(
      runtime.serializePluginPackageManifest(manifest),
    ),
  });
}

function stage(runtime, value, record, occurredAtMs) {
  return runtime.transitionPluginPackageInstall(value.lock, record, {
    type: 'stage_completed',
    mutationId: `edge-recovery-stage-${value.lock.targetGeneration}`,
    occurredAtMs,
    stageRef: `edge-recovery:${value.lock.lockDigest}`,
    artifactDigest: value.lock.source.artifactDigest,
    manifestDigest: value.lock.manifestDigest,
    contentDigest: value.lock.source.contentDigest,
    evidenceDigest: sha256(
      `edge-recovery-stage-${value.lock.targetGeneration}`,
    ),
  });
}

async function createActiveGeneration(runtime, repository, value) {
  const queued = runtime.createPluginPackageInstall(value.lock, {
    installationId: 'edge-recovery-install-1',
    mutationId: 'edge-recovery-create-1',
    occurredAtMs: 301,
  });
  await repository.create(
    runtime.pluginPackageInstallCreate(value.lock, queued, null),
  );
  const staged = stage(runtime, value, queued, 302);
  await repository.commit(runtime.pluginPackageInstallCommit(queued, staged));
  const activating = runtime.transitionPluginPackageInstall(
    value.lock,
    staged,
    {
      type: 'activation_started',
      mutationId: 'edge-recovery-activate-1',
      occurredAtMs: 303,
    },
  );
  await repository.commit(
    runtime.pluginPackageInstallCommit(staged, activating),
  );
  const active = runtime.transitionPluginPackageInstall(
    value.lock,
    activating,
    {
      type: 'activation_committed',
      mutationId: 'edge-recovery-commit-1',
      occurredAtMs: 304,
      activationRef: `edge-active:${value.lock.lockDigest}`,
      intentDigest: runtime.pluginPackageActivationIntentDigest(
        value.lock,
        activating,
      ),
      generation: 1,
      contentDigest: value.lock.source.contentDigest,
    },
  );
  await repository.commit(
    runtime.pluginPackageInstallCommit(activating, active),
  );
  return active;
}

async function createStagedUpgrade(runtime, repository, value, active) {
  const queued = runtime.createPluginPackageInstall(value.lock, {
    installationId: 'edge-recovery-install-2',
    mutationId: 'edge-recovery-create-2',
    occurredAtMs: 401,
  });
  await repository.create(
    runtime.pluginPackageInstallCreate(value.lock, queued, active),
  );
  const staged = stage(runtime, value, queued, 402);
  await repository.commit(runtime.pluginPackageInstallCommit(queued, staged));
  return staged;
}

function runtimeDependencies() {
  const pluginPackage = require('../packages/ql3-runtime-core/dist/plugin-package/pluginPackage');
  const install = require('../packages/ql3-runtime-core/dist/plugin-package/installation/pluginPackageInstall');
  const bundle = require('../packages/ql3-runtime-core/dist/plugin-package/pluginPackageBundle');
  const recovery = require('../packages/ql3-runtime-core/dist/plugin-package/installation/pluginPackageRecovery');
  const materialization = require('../packages/ql3-runtime-core/dist/plugin-package/pluginPackageResourceMaterialization');
  const generation = require('../packages/ql3-runtime-core/dist/plugin-package/pluginPackageResourceGeneration');
  const semantics = require('../packages/ql3-runtime-core/dist/task-definition/taskSpecSemantic');
  return {
    ...pluginPackage,
    ...install,
    ...bundle,
    ...recovery,
    ...materialization,
    ...generation,
    ...semantics,
  };
}

async function runBenchmark(options) {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new QingLong3PluginPackageRecoveryEdgeBenchmarkError(
      'Node.js 24 or newer is required',
    );
  }
  const { DatabaseSync } = require('node:sqlite');
  const runtime = runtimeDependencies();
  const {
    LocalSqlitePluginPackageInstallRepository,
  } = require('../packages/ql3-local-sqlite/dist/plugin-package/pluginPackageInstallRepository');
  const {
    LocalSqlitePluginPackageMaterializedRevisionRepository,
  } = require('../packages/ql3-local-sqlite/dist/plugin-package/pluginPackageMaterializedRevisionRepository');
  const {
    migrateLocalSqliteDatabase,
  } = require('../packages/ql3-local-sqlite/dist/migration/migration');
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-package-recovery-edge-'),
  );
  fs.chmodSync(temporaryRoot, 0o700);
  const databasePath = path.join(temporaryRoot, 'recovery.sqlite');
  let database;
  try {
    database = new DatabaseSync(databasePath, {
      allowExtension: false,
      allowUnknownNamedParameters: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: 1_000,
    });
    await migrateLocalSqliteDatabase(database);
    database.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;');
    const baseline = storageSnapshot(databasePath);
    const repository = new LocalSqlitePluginPackageInstallRepository(database);
    const registry = runtime.createBuiltInTaskSpecSemanticRegistry();
    const materializedRepository =
      new LocalSqlitePluginPackageMaterializedRevisionRepository(
        database,
        registry,
      );
    const first = packageFixture(runtime, 1, null, false);
    const second = packageFixture(runtime, 2, first, true);
    const calls = {
      byteSourceClose: 0,
      byteSourceOpen: 0,
      byteSourceRead: 0,
      publisherInspect: 0,
      publisherPublish: 0,
      stage: 0,
    };
    const rssBeforeBytes = process.memoryUsage().rss;
    const startedAt = performance.now();
    const active = await createActiveGeneration(runtime, repository, first);
    const staged = await createStagedUpgrade(
      runtime,
      repository,
      second,
      active,
    );
    const prerequisite =
      new runtime.PluginPackageResourceActivationPrerequisite({
        byteSource: {
          async open(generation) {
            if (
              generation.lockDigest !== second.lock.lockDigest ||
              generation.installationId !== staged.installationId
            ) {
              throw new Error('byte source received another generation');
            }
            calls.byteSourceOpen += 1;
            return {
              async read(resourcePath, maximumBytes) {
                calls.byteSourceRead += 1;
                const material =
                  resourcePath === 'package.json'
                    ? second.manifestBytes
                    : second.bytes[resourcePath];
                if (!material || material.byteLength > maximumBytes) {
                  throw new Error('byte source path or bound is invalid');
                }
                return new Uint8Array(material);
              },
              async close() {
                calls.byteSourceClose += 1;
              },
            };
          },
        },
        materializedRepository,
        taskSpecSemanticRegistry: registry,
      });
    const coordinator = new runtime.PluginPackageRecoveryCoordinator({
      repository,
      stageProvider: {
        async stage() {
          calls.stage += 1;
          throw new Error('staged upgrade must not be staged again');
        },
      },
      publisher: {
        async publish() {
          calls.publisherPublish += 1;
          throw new Error('invalid candidate must not be published');
        },
        async inspect() {
          calls.publisherInspect += 1;
          throw new Error('invalid candidate must not be inspected');
        },
      },
      activationPrerequisite: prerequisite,
      now: () => 500,
    });
    const recovery = await coordinator.recover({ pageSize: 1, maxPages: 2 });
    const durationMs = performance.now() - startedAt;
    const rssAfterBytes = process.memoryUsage().rss;
    const durable = await repository.find(staged.projectId, staged.packageName);
    const candidateGeneration =
      runtime.createPluginPackageResourceGenerationFromReferences({
        installationId: staged.installationId,
        projectId: staged.projectId,
        packageName: staged.packageName,
        lockDigest: second.lock.lockDigest,
        generation: second.lock.targetGeneration,
        previousActiveLockDigest: first.lock.lockDigest,
        contentDigest: second.lock.source.contentDigest,
        resources: second.lock.resources,
      });
    const materializedCandidateRevisions = database
      .prepare(
        `SELECT count(*) AS count
         FROM "QingLong3PluginPackageMaterializedRevisions"
         WHERE generation_digest = ?`,
      )
      .get(candidateGeneration.generationDigest).count;
    const integrityCheck = database
      .prepare('PRAGMA integrity_check')
      .get().integrity_check;
    const finalStorage = storageSnapshot(databasePath);
    const logicalGrowthBytes = Math.max(
      0,
      finalStorage.logicalBytes - baseline.logicalBytes,
    );
    const allocatedGrowthBytes = Math.max(
      0,
      finalStorage.allocatedBytes - baseline.allocatedBytes,
    );
    const rssDeltaBytes = Math.max(0, rssAfterBytes - rssBeforeBytes);
    const violations = [];
    if (
      !durable ||
      durable.installationId !== staged.installationId ||
      durable.state !== 'failed' ||
      durable.failure?.reason !== 'activation_fact_conflict' ||
      durable.failure?.failedFrom !== 'staged'
    ) {
      violations.push('candidate did not fail closed from staged');
    }
    if (
      durable?.previousActiveLockDigest !== first.lock.lockDigest ||
      durable?.activeLockDigest !== first.lock.lockDigest
    ) {
      violations.push('previous active lock was not preserved');
    }
    if (
      calls.stage !== 0 ||
      calls.publisherPublish !== 0 ||
      calls.publisherInspect !== 0
    ) {
      violations.push(
        'invalid candidate reached stage or activation publisher',
      );
    }
    if (
      calls.byteSourceOpen !== 1 ||
      calls.byteSourceRead !== 4 ||
      calls.byteSourceClose !== 1
    ) {
      violations.push('candidate bytes were not read exactly once');
    }
    if (materializedCandidateRevisions !== 0) {
      violations.push('invalid candidate materialized revision was published');
    }
    if (integrityCheck !== 'ok') {
      violations.push(`SQLite integrity_check returned ${integrityCheck}`);
    }
    if (durationMs > options.maxDurationMs) {
      violations.push('duration exceeded the configured bound');
    }
    if (rssDeltaBytes > options.maxRssDeltaBytes) {
      violations.push('RSS delta exceeded the configured bound');
    }
    if (
      Math.max(logicalGrowthBytes, allocatedGrowthBytes) >
      options.maxDatabaseGrowthBytes
    ) {
      violations.push('database growth exceeded the configured bound');
    }
    const report = Object.freeze({
      schemaVersion: 1,
      evidenceClass: 'plugin_package_failed_upgrade_edge_candidate',
      supported: false,
      identity: Object.freeze({
        node: process.version,
        architecture: process.arch,
        platform: process.platform,
      }),
      measurement: Object.freeze({
        durationMs: round(durationMs),
        rssBeforeBytes,
        rssAfterBytes,
        rssDeltaBytes,
      }),
      thresholds: Object.freeze({
        maxDurationMs: options.maxDurationMs,
        maxRssDeltaBytes: options.maxRssDeltaBytes,
        maxDatabaseGrowthBytes: options.maxDatabaseGrowthBytes,
      }),
      database: Object.freeze({
        journalMode: 'delete',
        synchronous: 'full',
        integrityCheck,
        logicalBytes: finalStorage.logicalBytes,
        allocatedBytes: finalStorage.allocatedBytes,
        logicalGrowthBytes,
        allocatedGrowthBytes,
        files: finalStorage.files,
        materializedCandidateRevisions,
      }),
      durable: Object.freeze({
        state: durable?.state ?? null,
        failureReason: durable?.failure?.reason ?? null,
        failedFrom: durable?.failure?.failedFrom ?? null,
        headInstallationIsCandidate:
          durable?.installationId === staged.installationId,
        previousActiveLockDigestPreserved:
          durable?.previousActiveLockDigest === first.lock.lockDigest,
        activeLockDigestPreserved:
          durable?.activeLockDigest === first.lock.lockDigest,
      }),
      recovery: Object.freeze(recovery),
      calls: Object.freeze(calls),
      limitations: EXPECTED_LIMITATIONS,
      gates: Object.freeze({
        passed: violations.length === 0,
        violations: Object.freeze(violations),
      }),
    });
    const reportViolations = validateReport(report);
    if (reportViolations.length > 0) {
      throw new QingLong3PluginPackageRecoveryEdgeBenchmarkError(
        `report contract rejected: ${reportViolations.join('; ')}`,
      );
    }
    if (!report.gates.passed) {
      throw new QingLong3PluginPackageRecoveryEdgeBenchmarkError(
        report.gates.violations.join('; '),
      );
    }
    return report;
  } finally {
    database?.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function validateReport(report) {
  const violations = [];
  if (!hasExactKeys(report, REPORT_KEYS)) {
    return Object.freeze(['report shape is invalid']);
  }
  if (
    report.schemaVersion !== 1 ||
    report.evidenceClass !== 'plugin_package_failed_upgrade_edge_candidate' ||
    report.supported !== false
  ) {
    violations.push('report identity is invalid');
  }
  if (
    !hasExactKeys(report.identity, IDENTITY_KEYS) ||
    typeof report.identity.node !== 'string' ||
    !['arm64', 'x64', 'arm'].includes(report.identity.architecture) ||
    typeof report.identity.platform !== 'string'
  ) {
    violations.push('runtime identity is invalid');
  }
  if (
    !hasExactKeys(report.measurement, MEASUREMENT_KEYS) ||
    !Number.isFinite(report.measurement.durationMs) ||
    report.measurement.durationMs < 0 ||
    !Number.isSafeInteger(report.measurement.rssBeforeBytes) ||
    report.measurement.rssBeforeBytes < 1 ||
    !Number.isSafeInteger(report.measurement.rssAfterBytes) ||
    report.measurement.rssAfterBytes < 1 ||
    !Number.isSafeInteger(report.measurement.rssDeltaBytes) ||
    report.measurement.rssDeltaBytes < 0
  ) {
    violations.push('measurement is invalid');
  }
  if (
    !hasExactKeys(report.thresholds, THRESHOLD_KEYS) ||
    !Number.isFinite(report.thresholds.maxDurationMs) ||
    report.thresholds.maxDurationMs <= 0 ||
    !Number.isSafeInteger(report.thresholds.maxRssDeltaBytes) ||
    report.thresholds.maxRssDeltaBytes < 1 ||
    !Number.isSafeInteger(report.thresholds.maxDatabaseGrowthBytes) ||
    report.thresholds.maxDatabaseGrowthBytes < 1
  ) {
    violations.push('thresholds are invalid');
  }
  if (
    !hasExactKeys(report.database, DATABASE_KEYS) ||
    report.database.journalMode !== 'delete' ||
    report.database.synchronous !== 'full' ||
    report.database.integrityCheck !== 'ok' ||
    report.database.materializedCandidateRevisions !== 0 ||
    ![
      'logicalBytes',
      'allocatedBytes',
      'logicalGrowthBytes',
      'allocatedGrowthBytes',
    ].every(
      (key) =>
        Number.isSafeInteger(report.database[key]) && report.database[key] >= 0,
    ) ||
    !Array.isArray(report.database.files) ||
    report.database.files.length < 1 ||
    report.database.files.length > 4 ||
    report.database.files.some(
      (file) =>
        !hasExactKeys(file, DATABASE_FILE_KEYS) ||
        !['database', '-journal', '-wal', '-shm'].includes(file.suffix) ||
        !Number.isSafeInteger(file.logicalBytes) ||
        file.logicalBytes < 0 ||
        !Number.isSafeInteger(file.allocatedBytes) ||
        file.allocatedBytes < 0,
    )
  ) {
    violations.push('database evidence is invalid');
  }
  if (
    !hasExactKeys(report.durable, DURABLE_KEYS) ||
    report.durable.state !== 'failed' ||
    report.durable.failureReason !== 'activation_fact_conflict' ||
    report.durable.failedFrom !== 'staged' ||
    report.durable.headInstallationIsCandidate !== true ||
    report.durable.previousActiveLockDigestPreserved !== true ||
    report.durable.activeLockDigestPreserved !== true
  ) {
    violations.push('durable recovery facts are invalid');
  }
  if (
    !hasExactKeys(report.recovery, RECOVERY_KEYS) ||
    report.recovery.pages !== 1 ||
    report.recovery.scanned !== 1 ||
    report.recovery.settled !== 1 ||
    report.recovery.retry !== 0 ||
    report.recovery.manualRequired !== 0 ||
    report.recovery.superseded !== 0 ||
    report.recovery.deferred !== 0 ||
    report.recovery.remaining !== false ||
    report.recovery.safeToAdmit !== true
  ) {
    violations.push('recovery outcome is invalid');
  }
  if (
    !hasExactKeys(report.calls, CALL_KEYS) ||
    report.calls.stage !== 0 ||
    report.calls.publisherPublish !== 0 ||
    report.calls.publisherInspect !== 0 ||
    report.calls.byteSourceOpen !== 1 ||
    report.calls.byteSourceRead !== 4 ||
    report.calls.byteSourceClose !== 1
  ) {
    violations.push('authority call evidence is invalid');
  }
  if (
    JSON.stringify(report.limitations) !== JSON.stringify(EXPECTED_LIMITATIONS)
  ) {
    violations.push('limitations are invalid');
  }
  if (
    !hasExactKeys(report.gates, GATE_KEYS) ||
    report.gates.passed !== true ||
    !Array.isArray(report.gates.violations) ||
    report.gates.violations.length !== 0
  ) {
    violations.push('gates did not pass exactly');
  }
  if (
    report.measurement?.durationMs > report.thresholds?.maxDurationMs ||
    report.measurement?.rssDeltaBytes > report.thresholds?.maxRssDeltaBytes ||
    Math.max(
      report.database?.logicalGrowthBytes ?? Number.POSITIVE_INFINITY,
      report.database?.allocatedGrowthBytes ?? Number.POSITIVE_INFINITY,
    ) > report.thresholds?.maxDatabaseGrowthBytes
  ) {
    violations.push('measurement exceeded its declared threshold');
  }
  return Object.freeze(violations);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runBenchmark(options);
  process.stdout.write(
    `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`,
  );
}

module.exports = {
  QingLong3PluginPackageRecoveryEdgeBenchmarkError,
  parseArguments,
  runBenchmark,
  validateReport,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
