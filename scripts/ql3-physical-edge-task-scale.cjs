#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const {
  canonicalDigest,
  collectObservedPlatform,
  validateTaskScaleWorkload,
  writeNoReplace,
} = require('./ql3-physical-edge-evidence.cjs');

const MAX_INPUT_BYTES = 16 * 1024;
const SAMPLE_COUNTS = Object.freeze([100, 1000, 10_000]);
const MANIFEST_KEYS = Object.freeze([
  'deviceId',
  'evidenceClass',
  'expectedArchitecture',
  'expectedFilesystem',
  'profile',
  'sampleCounts',
  'schemaVersion',
]);

class QingLong3PhysicalTaskScaleEvidenceError extends Error {
  constructor(message) {
    super(
      `QingLong 3.0 physical Edge TaskDefinition scale evidence failed: ${message}`,
    );
    this.name = 'QingLong3PhysicalTaskScaleEvidenceError';
  }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new QingLong3PhysicalTaskScaleEvidenceError(
      `${label} must be an object`,
    );
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
    throw new QingLong3PhysicalTaskScaleEvidenceError(
      `${label} keys must be exactly ${expected.join(', ')}`,
    );
  }
}

function normalizeTaskScaleManifest(value) {
  exactKeys(value, MANIFEST_KEYS, 'manifest');
  if (
    value.schemaVersion !== 1 ||
    value.evidenceClass !== 'physical_edge_task_scale_candidate' ||
    value.profile !== 'edge'
  ) {
    throw new QingLong3PhysicalTaskScaleEvidenceError(
      'manifest identity is invalid',
    );
  }
  if (
    typeof value.deviceId !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value.deviceId)
  ) {
    throw new QingLong3PhysicalTaskScaleEvidenceError(
      'manifest deviceId is invalid',
    );
  }
  if (!['x64', 'arm64', 'arm'].includes(value.expectedArchitecture)) {
    throw new QingLong3PhysicalTaskScaleEvidenceError(
      'manifest expectedArchitecture is invalid',
    );
  }
  if (
    typeof value.expectedFilesystem !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{1,31}$/.test(value.expectedFilesystem)
  ) {
    throw new QingLong3PhysicalTaskScaleEvidenceError(
      'manifest expectedFilesystem is invalid',
    );
  }
  if (JSON.stringify(value.sampleCounts) !== JSON.stringify(SAMPLE_COUNTS)) {
    throw new QingLong3PhysicalTaskScaleEvidenceError(
      'manifest sampleCounts must be exactly 100, 1000 and 10000',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_task_scale_candidate',
    profile: 'edge',
    deviceId: value.deviceId,
    expectedArchitecture: value.expectedArchitecture,
    expectedFilesystem: value.expectedFilesystem,
    sampleCounts: SAMPLE_COUNTS,
  });
}

function parseArguments(argv) {
  const options = { json: false };
  let separatorSeen = false;
  for (const argument of argv) {
    if (argument === '--' && !separatorSeen) {
      separatorSeen = true;
      continue;
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    const separator = argument.indexOf('=');
    if (separator < 1) {
      throw new QingLong3PhysicalTaskScaleEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (name === '--manifest') options.manifestPath = value;
    else if (name === '--data-path') options.dataPath = value;
    else if (name === '--output') options.outputPath = value;
    else {
      throw new QingLong3PhysicalTaskScaleEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
  }
  for (const name of ['manifestPath', 'dataPath', 'outputPath']) {
    if (!path.isAbsolute(options[name] ?? '')) {
      throw new QingLong3PhysicalTaskScaleEvidenceError(
        `${name} must be absolute`,
      );
    }
  }
  return Object.freeze(options);
}

function readManifest(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_INPUT_BYTES
    ) {
      throw new QingLong3PhysicalTaskScaleEvidenceError(
        'manifest must be a bounded regular file without symlinks',
      );
    }
    const contents = fs.readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(contents) > MAX_INPUT_BYTES) {
      throw new QingLong3PhysicalTaskScaleEvidenceError(
        'manifest is oversized',
      );
    }
    return normalizeTaskScaleManifest(JSON.parse(contents));
  } catch (error) {
    if (error instanceof QingLong3PhysicalTaskScaleEvidenceError) throw error;
    throw new QingLong3PhysicalTaskScaleEvidenceError(
      `manifest could not be read: ${error.message}`,
    );
  }
}

function validateObserved(manifest, observed) {
  const violations = [];
  if (observed.platform !== 'linux') violations.push('platform must be Linux');
  if (observed.architecture !== manifest.expectedArchitecture) {
    violations.push('architecture did not match');
  }
  if (observed.dataFilesystem !== manifest.expectedFilesystem) {
    violations.push('filesystem did not match');
  }
  if (observed.dataMountOptions.includes('ro')) {
    violations.push('data filesystem is read-only');
  }
  if (observed.virtualizationIndicators.length > 0) {
    violations.push('virtualization indicators were present');
  }
  return Object.freeze(violations);
}

function taskCommand(index) {
  return Object.freeze({
    projectId: 'default',
    taskId: `physical-task-${String(index).padStart(5, '0')}`,
    expectedRevision: null,
    mutationId: `019f7300-0000-7000-8000-${String(index).padStart(12, '0')}`,
    name: `Physical TaskDefinition ${index}`,
    kind: 'command',
    spec: Object.freeze({
      schema: 'qinglong/command@v1',
      config: Object.freeze({
        command: Object.freeze({
          kind: 'argv',
          file: '/bin/echo',
          args: Object.freeze([String(index)]),
        }),
      }),
    }),
    labels: Object.freeze({ source: 'physical-scale-evidence' }),
    enabled: true,
    occurredAtMs: 1_760_000_000_000 + index,
  });
}

function fileUsage(filePath) {
  let logicalBytes = 0;
  let allocatedBytes = 0;
  const files = [];
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const candidate = `${filePath}${suffix}`;
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      logicalBytes += stat.size;
      allocatedBytes += stat.blocks * 512;
      files.push(
        Object.freeze({
          suffix: suffix || 'database',
          logicalBytes: stat.size,
          allocatedBytes: stat.blocks * 512,
        }),
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return Object.freeze({
    logicalBytes,
    allocatedBytes,
    files: Object.freeze(files),
  });
}

async function scanDefinitions(repository, expectedCount) {
  const startedAt = performance.now();
  const digest = crypto.createHash('sha256');
  let after;
  let count = 0;
  let pages = 0;
  do {
    const page = await repository.listTaskDefinitions({
      projectId: 'default',
      limit: 256,
      ...(after ? { after } : {}),
    });
    pages += 1;
    for (const definition of page.definitions) {
      count += 1;
      digest.update(`${definition.taskId}:${definition.revision}\n`);
    }
    after = page.next;
    if (page.truncated !== Boolean(after) || pages > 40) {
      throw new QingLong3PhysicalTaskScaleEvidenceError(
        'TaskDefinition pagination was inconsistent or unbounded',
      );
    }
  } while (after);
  if (count !== expectedCount) {
    throw new QingLong3PhysicalTaskScaleEvidenceError(
      `expected ${expectedCount} TaskDefinitions, observed ${count}`,
    );
  }
  return Object.freeze({
    count,
    pages,
    durationMs: Number((performance.now() - startedAt).toFixed(3)),
    identityDigest: digest.digest('hex'),
  });
}

async function runScaleWorkload(root, dataPath) {
  const { migrateLocalSqlitePath } = require(path.join(
    root,
    'packages/ql3-local-sqlite/dist/migration/migration.js',
  ));
  const { openLocalSqliteRuntimeDatabase } = require(path.join(
    root,
    'packages/ql3-local-sqlite/dist/runtime/runtimeDatabase.js',
  ));
  const scratchRoot = fs.mkdtempSync(path.join(dataPath, '.ql3-task-scale-'));
  fs.chmodSync(scratchRoot, 0o700);
  const databasePath = path.join(scratchRoot, 'task-scale.sqlite');
  let runtime;
  let peakRssBytes = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 25);
  sampler.unref?.();
  try {
    const migrationStartedAt = performance.now();
    const migrated = await migrateLocalSqlitePath({
      databasePath,
      profile: 'edge',
    });
    const migrationDurationMs = Number(
      (performance.now() - migrationStartedAt).toFixed(3),
    );
    const afterMigration = fileUsage(databasePath);
    runtime = await openLocalSqliteRuntimeDatabase({
      databasePath,
      profile: 'edge',
    });
    const baselineRssBytes = process.memoryUsage().rss;
    const cases = [];
    let previousCount = 0;
    const totalStartedAt = performance.now();
    for (const count of SAMPLE_COUNTS) {
      const appendStartedAt = performance.now();
      for (let index = previousCount + 1; index <= count; index += 1) {
        const result =
          await runtime.taskDefinitions.appendTaskDefinitionRevision(
            taskCommand(index),
          );
        if (result.status !== 'created' || result.definition.revision !== 1) {
          throw new QingLong3PhysicalTaskScaleEvidenceError(
            'TaskDefinition append did not create one immutable revision',
          );
        }
      }
      const appendDurationMs = Number(
        (performance.now() - appendStartedAt).toFixed(3),
      );
      const scan = await scanDefinitions(runtime.taskDefinitions, count);
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      cases.push(
        Object.freeze({
          count,
          appended: count - previousCount,
          appendDurationMs,
          cumulativeDurationMs: Number(
            (performance.now() - totalStartedAt).toFixed(3),
          ),
          scan,
          storage: fileUsage(databasePath),
          rssBytes: process.memoryUsage().rss,
          peakRssBytes,
        }),
      );
      previousCount = count;
    }
    await runtime.close();
    runtime = undefined;
    return Object.freeze({
      migration: Object.freeze({
        durationMs: migrationDurationMs,
        contractVersion: migrated.readiness.contractVersion,
        migrationCount: migrated.readiness.migrationIds.length,
        storage: afterMigration,
      }),
      baselineRssBytes,
      peakRssBytes,
      cases: Object.freeze(cases),
      finalStorage: fileUsage(databasePath),
    });
  } finally {
    clearInterval(sampler);
    if (runtime) await runtime.close();
    fs.rmSync(scratchRoot, { recursive: true, force: false });
  }
}

function buildTaskScaleReport({ manifest, observed, workload, generatedAt }) {
  const violations = [...validateObserved(manifest, observed)];
  violations.push(...validateTaskScaleWorkload(workload));
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_task_scale_candidate',
    supported: false,
    generatedAt,
    manifest,
    observed: Object.freeze({
      platform: observed.platform,
      architecture: observed.architecture,
      node: observed.node,
      bootId: observed.bootId,
      dataPath: observed.dataPath,
      filesystem: observed.dataFilesystem,
      mountOptions: observed.dataMountOptions,
    }),
    workload,
    qualification: Object.freeze({
      passed: violations.length === 0,
      violations: Object.freeze(violations),
      measures: Object.freeze([
        'formal_task_definition_repository_append',
        'built_in_command_v1_semantic_validation',
        'bounded_current_definition_scan',
        'process_rss',
        'database_logical_and_allocated_bytes',
        'fresh_schema_migration',
      ]),
      doesNotProve: Object.freeze([
        'legacy_crontab_adoption',
        'production_scheduler_throughput',
        'whole_device_flash_write_amplification',
        'non_command_task_spec_semantics',
        'task_definition_execution_compilation',
      ]),
    }),
  };
  return Object.freeze({ ...body, sha256: canonicalDigest(body) });
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 18 || process.platform !== 'linux') {
    throw new QingLong3PhysicalTaskScaleEvidenceError(
      'native Linux Node.js 24.18 or newer within major 24 is required',
    );
  }
  const options = parseArguments(process.argv.slice(2));
  const manifest = readManifest(options.manifestPath);
  const observed = collectObservedPlatform(options.dataPath);
  const preflight = validateObserved(manifest, observed);
  if (preflight.length > 0) {
    throw new QingLong3PhysicalTaskScaleEvidenceError(
      `device preflight rejected: ${preflight.join('; ')}`,
    );
  }
  const root = path.resolve(__dirname, '..');
  const workload = await runScaleWorkload(root, observed.dataPath);
  const report = buildTaskScaleReport({
    manifest,
    observed,
    workload,
    generatedAt: new Date().toISOString(),
  });
  const serialized = `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`;
  writeNoReplace(options.outputPath, serialized);
  process.stdout.write(serialized);
}

module.exports = {
  QingLong3PhysicalTaskScaleEvidenceError,
  SAMPLE_COUNTS,
  buildTaskScaleReport,
  fileUsage,
  normalizeTaskScaleManifest,
  parseArguments,
  scanDefinitions,
  taskCommand,
  validateObserved,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
