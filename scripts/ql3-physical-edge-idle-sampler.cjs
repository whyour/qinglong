#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const {
  canonicalDigest,
  writeNoReplace,
} = require('./ql3-physical-edge-evidence.cjs');

const MAX_PROC_BYTES = 64 * 1024;
const MANIFEST_KEYS = Object.freeze([
  'deviceId',
  'durationSeconds',
  'evidenceClass',
  'expectedExecutable',
  'processId',
  'profile',
  'sampleIntervalMs',
  'schemaVersion',
]);

class QingLong3PhysicalIdleEvidenceError extends Error {
  constructor(message) {
    super(`QingLong 3.0 physical Edge idle evidence failed: ${message}`);
    this.name = 'QingLong3PhysicalIdleEvidenceError';
  }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new QingLong3PhysicalIdleEvidenceError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new QingLong3PhysicalIdleEvidenceError(
      `${label} keys must be exactly ${expected.join(', ')}`,
    );
  }
}

function normalizeIdleManifest(value) {
  exactKeys(value, MANIFEST_KEYS, 'manifest');
  if (value.schemaVersion !== 1) {
    throw new QingLong3PhysicalIdleEvidenceError(
      'manifest schemaVersion must be 1',
    );
  }
  if (value.evidenceClass !== 'physical_edge_idle_candidate') {
    throw new QingLong3PhysicalIdleEvidenceError(
      'manifest evidenceClass must be physical_edge_idle_candidate',
    );
  }
  if (value.profile !== 'edge') {
    throw new QingLong3PhysicalIdleEvidenceError(
      'manifest profile must be edge',
    );
  }
  if (
    typeof value.deviceId !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value.deviceId)
  ) {
    throw new QingLong3PhysicalIdleEvidenceError(
      'manifest deviceId is invalid',
    );
  }
  if (
    !Number.isSafeInteger(value.processId) ||
    value.processId < 2 ||
    value.processId > 4_194_304
  ) {
    throw new QingLong3PhysicalIdleEvidenceError(
      'manifest processId is invalid',
    );
  }
  if (
    typeof value.expectedExecutable !== 'string' ||
    !path.isAbsolute(value.expectedExecutable) ||
    value.expectedExecutable.length > 4096
  ) {
    throw new QingLong3PhysicalIdleEvidenceError(
      'manifest expectedExecutable must be a bounded absolute path',
    );
  }
  if (
    !Number.isSafeInteger(value.durationSeconds) ||
    value.durationSeconds < 30 ||
    value.durationSeconds > 3600
  ) {
    throw new QingLong3PhysicalIdleEvidenceError(
      'manifest durationSeconds must be between 30 and 3600',
    );
  }
  if (
    !Number.isSafeInteger(value.sampleIntervalMs) ||
    value.sampleIntervalMs < 1000 ||
    value.sampleIntervalMs > 60_000 ||
    (value.durationSeconds * 1000) % value.sampleIntervalMs !== 0
  ) {
    throw new QingLong3PhysicalIdleEvidenceError(
      'manifest sampleIntervalMs must divide the duration and be between 1000 and 60000',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_idle_candidate',
    profile: 'edge',
    deviceId: value.deviceId,
    processId: value.processId,
    expectedExecutable: value.expectedExecutable,
    durationSeconds: value.durationSeconds,
    sampleIntervalMs: value.sampleIntervalMs,
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
      throw new QingLong3PhysicalIdleEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (name === '--manifest') options.manifestPath = value;
    else if (name === '--output') options.outputPath = value;
    else {
      throw new QingLong3PhysicalIdleEvidenceError(
        `unsupported argument ${argument}`,
      );
    }
  }
  for (const name of ['manifestPath', 'outputPath']) {
    if (!path.isAbsolute(options[name] ?? '')) {
      throw new QingLong3PhysicalIdleEvidenceError(`${name} must be absolute`);
    }
  }
  return Object.freeze(options);
}

function readBoundedFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROC_BYTES) {
    throw new QingLong3PhysicalIdleEvidenceError(
      `${label} must be a bounded regular file`,
    );
  }
  const value = fs.readFileSync(filePath);
  if (value.length > MAX_PROC_BYTES) {
    throw new QingLong3PhysicalIdleEvidenceError(`${label} is oversized`);
  }
  return value;
}

function readManifest(filePath) {
  try {
    return normalizeIdleManifest(
      JSON.parse(readBoundedFile(filePath, 'manifest').toString('utf8')),
    );
  } catch (error) {
    if (error instanceof QingLong3PhysicalIdleEvidenceError) throw error;
    throw new QingLong3PhysicalIdleEvidenceError(
      `manifest could not be read: ${error.message}`,
    );
  }
}

function safeInteger(raw, label, { allowNegative = false } = {}) {
  if (!/^-?\d+$/.test(raw)) {
    throw new QingLong3PhysicalIdleEvidenceError(`${label} is invalid`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new QingLong3PhysicalIdleEvidenceError(`${label} is invalid`);
  }
  return value;
}

function parseProcStat(raw) {
  const close = raw.lastIndexOf(') ');
  if (!raw.startsWith('(') && !/^\d+ \(/.test(raw)) {
    throw new QingLong3PhysicalIdleEvidenceError('process stat is malformed');
  }
  if (close < 4) {
    throw new QingLong3PhysicalIdleEvidenceError('process stat is malformed');
  }
  const open = raw.indexOf('(');
  const processId = safeInteger(raw.slice(0, open).trim(), 'process stat pid');
  const fields = raw
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  if (fields.length < 22 || !/^[RSDTtXZIKWP]$/.test(fields[0])) {
    throw new QingLong3PhysicalIdleEvidenceError('process stat is malformed');
  }
  return Object.freeze({
    processId,
    state: fields[0],
    minorFaults: safeInteger(fields[7], 'process stat minor faults'),
    majorFaults: safeInteger(fields[9], 'process stat major faults'),
    userTicks: safeInteger(fields[11], 'process stat user ticks'),
    systemTicks: safeInteger(fields[12], 'process stat system ticks'),
    threadCount: safeInteger(fields[17], 'process stat thread count'),
    startTicks: safeInteger(fields[19], 'process stat start ticks'),
    rssPages: safeInteger(fields[21], 'process stat RSS pages'),
  });
}

function linesByName(raw, separator) {
  const values = new Map();
  for (const line of raw.trim().split('\n')) {
    const index = line.indexOf(separator);
    if (index < 1) continue;
    values.set(
      line.slice(0, index),
      line.slice(index + separator.length).trim(),
    );
  }
  return values;
}

function parseProcStatus(raw) {
  const values = linesByName(raw, ':');
  const rss = values.get('VmRSS')?.match(/^(\d+) kB$/);
  const uid = values.get('Uid')?.split(/\s+/).map(Number);
  if (
    !rss ||
    uid?.length !== 4 ||
    uid.some((value) => !Number.isSafeInteger(value))
  ) {
    throw new QingLong3PhysicalIdleEvidenceError('process status is malformed');
  }
  return Object.freeze({
    uid: uid[0],
    rssBytes: safeInteger(rss[1], 'process status RSS') * 1024,
    threadCount: safeInteger(
      values.get('Threads') ?? '',
      'process status thread count',
    ),
    voluntaryContextSwitches: safeInteger(
      values.get('voluntary_ctxt_switches') ?? '',
      'process status voluntary context switches',
    ),
    involuntaryContextSwitches: safeInteger(
      values.get('nonvoluntary_ctxt_switches') ?? '',
      'process status involuntary context switches',
    ),
  });
}

function parseProcIo(raw) {
  const values = linesByName(raw, ':');
  const read = (name) =>
    safeInteger(values.get(name) ?? '', `process I/O ${name}`);
  return Object.freeze({
    readBytes: read('read_bytes'),
    writeBytes: read('write_bytes'),
    readSyscalls: read('syscr'),
    writeSyscalls: read('syscw'),
  });
}

function readProcessSnapshot(processId) {
  const root = `/proc/${processId}`;
  const stat = parseProcStat(
    readBoundedFile(`${root}/stat`, 'process stat').toString('utf8'),
  );
  const status = parseProcStatus(
    readBoundedFile(`${root}/status`, 'process status').toString('utf8'),
  );
  const io = parseProcIo(
    readBoundedFile(`${root}/io`, 'process I/O').toString('utf8'),
  );
  const command = readBoundedFile(`${root}/cmdline`, 'process command');
  if (command.length === 0) {
    throw new QingLong3PhysicalIdleEvidenceError('process command is empty');
  }
  return Object.freeze({
    monotonicMs: performance.now(),
    wallTimeMs: Date.now(),
    bootId: readBoundedFile('/proc/sys/kernel/random/boot_id', 'boot identity')
      .toString('utf8')
      .trim(),
    executable: fs.realpathSync(`${root}/exe`),
    commandSha256: crypto.createHash('sha256').update(command).digest('hex'),
    ...stat,
    ...status,
    ...io,
  });
}

function delta(first, last, name, violations) {
  const value = last[name] - first[name];
  if (!Number.isSafeInteger(value) || value < 0) {
    violations.push(`${name} counter regressed`);
    return null;
  }
  return value;
}

function validateSnapshotSeries(manifest, snapshots) {
  const violations = [];
  const expectedSamples =
    (manifest.durationSeconds * 1000) / manifest.sampleIntervalMs + 1;
  if (snapshots.length !== expectedSamples) {
    violations.push(
      `sample count ${snapshots.length} did not equal ${expectedSamples}`,
    );
  }
  const first = snapshots[0];
  if (!first) return Object.freeze(violations);
  for (const [index, snapshot] of snapshots.entries()) {
    if (snapshot.processId !== manifest.processId) {
      violations.push(`sample ${index} process identity changed`);
    }
    if (snapshot.executable !== manifest.expectedExecutable) {
      violations.push(`sample ${index} executable changed`);
    }
    if (snapshot.bootId !== first.bootId) {
      violations.push(`sample ${index} boot identity changed`);
    }
    if (snapshot.startTicks !== first.startTicks) {
      violations.push(`sample ${index} process generation changed`);
    }
    if (snapshot.commandSha256 !== first.commandSha256) {
      violations.push(`sample ${index} command identity changed`);
    }
    if (snapshot.uid !== first.uid) {
      violations.push(`sample ${index} process UID changed`);
    }
    if (['Z', 'X'].includes(snapshot.state)) {
      violations.push(`sample ${index} process was not live`);
    }
    if (index > 0 && snapshot.monotonicMs <= snapshots[index - 1].monotonicMs) {
      violations.push(`sample ${index} monotonic time did not advance`);
    }
  }
  return Object.freeze([...new Set(violations)]);
}

function percentile(sorted, percentage) {
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * percentage) - 1)
  ];
}

function summarizeSnapshots(snapshots, violations = []) {
  if (snapshots.length < 2) {
    throw new QingLong3PhysicalIdleEvidenceError(
      'at least two process samples are required',
    );
  }
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const rss = snapshots.map(({ rssBytes }) => rssBytes).sort((a, b) => a - b);
  return Object.freeze({
    sampleCount: snapshots.length,
    actualDurationMs: Number((last.monotonicMs - first.monotonicMs).toFixed(3)),
    rssBytes: Object.freeze({
      minimum: rss[0],
      p50: percentile(rss, 0.5),
      p95: percentile(rss, 0.95),
      maximum: rss[rss.length - 1],
      final: last.rssBytes,
    }),
    threadCountMaximum: Math.max(
      ...snapshots.map(({ threadCount }) => threadCount),
    ),
    cpuTicks: Object.freeze({
      user: delta(first, last, 'userTicks', violations),
      system: delta(first, last, 'systemTicks', violations),
    }),
    faults: Object.freeze({
      minor: delta(first, last, 'minorFaults', violations),
      major: delta(first, last, 'majorFaults', violations),
    }),
    contextSwitches: Object.freeze({
      voluntary: delta(first, last, 'voluntaryContextSwitches', violations),
      involuntary: delta(first, last, 'involuntaryContextSwitches', violations),
    }),
    io: Object.freeze({
      readBytes: delta(first, last, 'readBytes', violations),
      writeBytes: delta(first, last, 'writeBytes', violations),
      readSyscalls: delta(first, last, 'readSyscalls', violations),
      writeSyscalls: delta(first, last, 'writeSyscalls', violations),
    }),
  });
}

function buildIdleEvidenceReport({ manifest, snapshots, generatedAt }) {
  const violations = [...validateSnapshotSeries(manifest, snapshots)];
  const summary = summarizeSnapshots(snapshots, violations);
  const first = snapshots[0];
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_idle_candidate',
    supported: false,
    generatedAt,
    manifest,
    identity: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      bootId: first.bootId,
      processId: first.processId,
      processUid: first.uid,
      executable: first.executable,
      commandSha256: first.commandSha256,
      startTicks: first.startTicks,
    },
    summary,
    qualification: {
      passed: violations.length === 0,
      violations,
      measures: [
        'process_rss',
        'process_cpu_ticks',
        'process_context_switches',
        'process_io',
      ],
      doesNotProve: [
        'whole_device_cpu_wakeups',
        'whole_device_flash_write_amplification',
        'cold_start_or_first_ready',
      ],
    },
  };
  return Object.freeze({ ...body, sha256: canonicalDigest(body) });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function collectSnapshots(manifest) {
  if (process.platform !== 'linux') {
    throw new QingLong3PhysicalIdleEvidenceError('sampler requires Linux');
  }
  const canonicalExecutable = fs.realpathSync(manifest.expectedExecutable);
  if (canonicalExecutable !== manifest.expectedExecutable) {
    throw new QingLong3PhysicalIdleEvidenceError(
      'expectedExecutable must be canonical',
    );
  }
  const sampleCount =
    (manifest.durationSeconds * 1000) / manifest.sampleIntervalMs + 1;
  const snapshots = [];
  for (let index = 0; index < sampleCount; index += 1) {
    if (index > 0) await delay(manifest.sampleIntervalMs);
    snapshots.push(readProcessSnapshot(manifest.processId));
  }
  return Object.freeze(snapshots);
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new QingLong3PhysicalIdleEvidenceError(
      'Node.js 24 or newer is required',
    );
  }
  const options = parseArguments(process.argv.slice(2));
  const manifest = readManifest(options.manifestPath);
  const snapshots = await collectSnapshots(manifest);
  const report = buildIdleEvidenceReport({
    manifest,
    snapshots,
    generatedAt: new Date().toISOString(),
  });
  const serialized = `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`;
  writeNoReplace(options.outputPath, serialized);
  process.stdout.write(serialized);
  if (!report.qualification.passed) process.exitCode = 1;
}

module.exports = {
  QingLong3PhysicalIdleEvidenceError,
  buildIdleEvidenceReport,
  normalizeIdleManifest,
  parseArguments,
  parseProcIo,
  parseProcStat,
  parseProcStatus,
  summarizeSnapshots,
  validateSnapshotSeries,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
