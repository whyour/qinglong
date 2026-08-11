#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MIB = 1024 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 4 * MIB;
const PROMPT_RESOURCE_OUTPUT_BYTES = 512 * 1024;
const RESOURCE_TIERS = Object.freeze({
  'router-stress-ci': Object.freeze({
    evidenceClass: 'ci_stress_only',
    supportedMinimum: false,
    memoryMaxBytes: 128 * MIB,
    swapMaxBytes: 0,
    cpuQuotaCores: 0.5,
    pidsMax: 64,
    workload: 'edge',
    edgeMaxRssDeltaMb: 64,
    edgeMaxCancelMs: 5_000,
    sqliteIterations: 100,
    sqliteMaxTransactionP95Ms: 500,
    sqliteMaxBatchStallMs: 5_000,
    sqliteMaxRssDeltaMb: 32,
    workflowLockSamples: 16,
    workflowMaxLockP95Ms: 500,
    workflowMaxProcessRssMb: 96,
    promptMaxProcessRssMb: 120,
  }),
  'edge-release-ci': Object.freeze({
    evidenceClass: 'ci_release_guard',
    supportedMinimum: false,
    memoryMaxBytes: 256 * MIB,
    swapMaxBytes: 0,
    cpuQuotaCores: 1,
    pidsMax: 128,
    workload: 'edge',
    edgeMaxRssDeltaMb: 96,
    edgeMaxCancelMs: 5_000,
    sqliteIterations: 250,
    sqliteMaxTransactionP95Ms: 250,
    sqliteMaxBatchStallMs: 2_500,
    sqliteMaxRssDeltaMb: 64,
    workflowLockSamples: 32,
    workflowMaxLockP95Ms: 250,
    workflowMaxProcessRssMb: 160,
    promptMaxProcessRssMb: 192,
  }),
  'cluster-control-ci': Object.freeze({
    evidenceClass: 'ci_cluster_guard',
    supportedMinimum: false,
    memoryMaxBytes: 512 * MIB,
    swapMaxBytes: 0,
    cpuQuotaCores: 2,
    pidsMax: 256,
    workload: 'cluster-control',
    clusterMaxRssDeltaMb: 128,
    clusterMaxDisabledActivationMs: 1_000,
  }),
});

class QingLong3LinuxResourceGateError extends Error {
  constructor(message) {
    super(`QingLong 3.0 Linux resource gate failed: ${message}`);
    this.name = 'QingLong3LinuxResourceGateError';
  }
}

function parseArguments(argv) {
  const options = { json: false };
  for (const argument of argv) {
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    const separator = argument.indexOf('=');
    if (separator < 1) {
      throw new QingLong3LinuxResourceGateError(
        `unsupported argument ${argument}`,
      );
    }
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (name === '--tier') options.tier = value;
    else if (name === '--expected-arch') options.expectedArch = value;
    else {
      throw new QingLong3LinuxResourceGateError(
        `unsupported argument ${argument}`,
      );
    }
  }
  if (!(options.tier in RESOURCE_TIERS)) {
    throw new QingLong3LinuxResourceGateError(
      `--tier must be one of ${Object.keys(RESOURCE_TIERS).join(', ')}`,
    );
  }
  if (
    options.expectedArch !== undefined &&
    !['x64', 'arm64'].includes(options.expectedArch)
  ) {
    throw new QingLong3LinuxResourceGateError(
      '--expected-arch must be x64 or arm64',
    );
  }
  return Object.freeze(options);
}

function parseLimit(raw, label) {
  const value = raw.trim();
  if (value === 'max') return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new QingLong3LinuxResourceGateError(`${label} is invalid`);
  }
  return parsed;
}

function parseCpuMax(raw) {
  const [quotaRaw, periodRaw, extra] = raw.trim().split(/\s+/);
  if (!quotaRaw || !periodRaw || extra !== undefined) {
    throw new QingLong3LinuxResourceGateError('cpu.max is invalid');
  }
  if (quotaRaw === 'max') return Number.POSITIVE_INFINITY;
  const quota = parseLimit(quotaRaw, 'cpu.max quota');
  const period = parseLimit(periodRaw, 'cpu.max period');
  if (quota < 1 || period < 1) {
    throw new QingLong3LinuxResourceGateError('cpu.max must be positive');
  }
  return quota / period;
}

function parseKeyValueFile(raw, label) {
  const values = {};
  for (const line of raw.trim().split('\n')) {
    const [name, valueRaw, extra] = line.trim().split(/\s+/);
    const value = Number(valueRaw);
    if (
      !name ||
      extra !== undefined ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new QingLong3LinuxResourceGateError(`${label} is invalid`);
    }
    values[name] = value;
  }
  return Object.freeze(values);
}

function unescapeMountPath(value) {
  return value.replace(/\\040/g, ' ').replace(/\\011/g, '\t');
}

function parseMountOptions(raw) {
  const mounts = new Map();
  for (const line of raw.trim().split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 4) continue;
    mounts.set(
      unescapeMountPath(fields[1]),
      Object.freeze(fields[3].split(',')),
    );
  }
  return mounts;
}

function readLinuxEnvelope(root = '/') {
  const read = (relativePath) =>
    fs.readFileSync(path.join(root, relativePath), 'utf8');
  const status = parseKeyValueFile(
    read('proc/self/status')
      .split('\n')
      .filter((line) => /^(NoNewPrivs|Seccomp):/.test(line))
      .map((line) => line.replace(':', ' '))
      .join('\n'),
    'process security status',
  );
  return Object.freeze({
    cgroupVersion: 2,
    memoryMaxBytes: parseLimit(read('sys/fs/cgroup/memory.max'), 'memory.max'),
    memoryPeakBytes: parseLimit(
      read('sys/fs/cgroup/memory.peak'),
      'memory.peak',
    ),
    swapMaxBytes: parseLimit(
      read('sys/fs/cgroup/memory.swap.max'),
      'memory.swap.max',
    ),
    cpuQuotaCores: parseCpuMax(read('sys/fs/cgroup/cpu.max')),
    pidsMax: parseLimit(read('sys/fs/cgroup/pids.max'), 'pids.max'),
    memoryEvents: parseKeyValueFile(
      read('sys/fs/cgroup/memory.events'),
      'memory.events',
    ),
    noNewPrivileges: status.NoNewPrivs,
    seccompMode: status.Seccomp,
    mounts: parseMountOptions(read('proc/mounts')),
  });
}

function validateEnvelope(tierName, envelope, identity) {
  const tier = RESOURCE_TIERS[tierName];
  const violations = [];
  const exact = (actual, expected, label) => {
    if (actual !== expected) {
      violations.push(`${label} ${actual} did not equal ${expected}`);
    }
  };
  exact(envelope.memoryMaxBytes, tier.memoryMaxBytes, 'memory.max');
  exact(envelope.swapMaxBytes, tier.swapMaxBytes, 'memory.swap.max');
  exact(envelope.cpuQuotaCores, tier.cpuQuotaCores, 'cpu.max cores');
  exact(envelope.pidsMax, tier.pidsMax, 'pids.max');
  exact(envelope.noNewPrivileges, 1, 'NoNewPrivs');
  exact(envelope.seccompMode, 2, 'Seccomp');
  if (identity.platform !== 'linux') {
    violations.push(`platform ${identity.platform} is not linux`);
  }
  if (!['x64', 'arm64'].includes(identity.architecture)) {
    violations.push(`architecture ${identity.architecture} is unsupported`);
  }
  if (identity.uid === 0) violations.push('resource workload must be non-root');
  for (const mountPath of ['/', '/workspace']) {
    if (!envelope.mounts.get(mountPath)?.includes('ro')) {
      violations.push(`${mountPath} must be mounted read-only`);
    }
  }
  if (!envelope.mounts.get('/tmp')?.includes('rw')) {
    violations.push('/tmp must be a writable bounded tmpfs');
  }
  return Object.freeze(violations);
}

function createWorkloadPlans(root, tierName) {
  const tier = RESOURCE_TIERS[tierName];
  if (tier.workload === 'edge') {
    return Object.freeze([
      Object.freeze({
        name: 'edge-executor',
        script: path.join(root, 'scripts/ql3-edge-benchmark.cjs'),
        args: Object.freeze([
          '--json',
          `--max-rss-delta-mb=${tier.edgeMaxRssDeltaMb}`,
          `--max-cancel-ms=${tier.edgeMaxCancelMs}`,
        ]),
      }),
      Object.freeze({
        name: 'node-sqlite',
        script: path.join(root, 'scripts/ql3-node-sqlite-benchmark.cjs'),
        args: Object.freeze([
          '--json',
          `--iterations=${tier.sqliteIterations}`,
          '--batch-size=10',
          `--max-transaction-p95-ms=${tier.sqliteMaxTransactionP95Ms}`,
          `--max-batch-stall-ms=${tier.sqliteMaxBatchStallMs}`,
          `--max-rss-delta-mb=${tier.sqliteMaxRssDeltaMb}`,
        ]),
      }),
      Object.freeze({
        name: 'local-workflow-product',
        format: 'node_test',
        nodeArgs: Object.freeze([
          '--test',
          `--test-name-pattern=${
            tierName === 'edge-release-ci'
              ? 'executes one admitted Workflow|stops one running Workflow Task'
              : 'executes one admitted Workflow'
          }`,
          path.join(
            root,
            'packages/ql3-local-application/test/activation.test.cjs',
          ),
        ]),
        maxProcessRssBytes: tier.workflowMaxProcessRssMb * MIB,
        ...(tierName === 'edge-release-ci'
          ? {
              contract: Object.freeze({
                kind: 'local_workflow_product_lifecycle',
                profile: 'edge',
                completedWorkflowSteps: 2,
                completedAttempts: 2,
                cancelCommandStatus: 'accepted',
                exactReplay: true,
                processIdentityObserved: true,
                processExited: true,
                parentRunStatus: 'cancelled',
                attemptStatus: 'cancelled',
                cancelledStepRuns: 2,
                cancelEvents: 1,
                cancelAudits: 1,
                physicalPowerLossProven: false,
              }),
            }
          : {}),
      }),
      ...(tierName === 'edge-release-ci'
        ? ['edge', 'standalone'].map((profile) =>
            Object.freeze({
          name: `local-ai-prompt-durable-output-${profile}`,
          format: 'node_test',
          nodeArgs: Object.freeze([
            '--test',
            '--test-name-pattern=executes one active Package Prompt',
            path.join(
              root,
              'packages/ql3-local-application/test/activation.test.cjs',
            ),
          ]),
          env: Object.freeze({
            QL3_PROMPT_RESOURCE_PROFILE: profile,
            QL3_PROMPT_RESOURCE_OUTPUT_BYTES: String(
              PROMPT_RESOURCE_OUTPUT_BYTES,
            ),
          }),
          maxProcessRssBytes: tier.promptMaxProcessRssMb * MIB,
          contract: Object.freeze({
            kind: 'durable_prompt_output_resource',
            profile,
            journalMode: profile === 'edge' ? 'delete' : 'wal',
            durableOutputBytes: PROMPT_RESOURCE_OUTPUT_BYTES,
            providerCalls: 2,
            keyLoads: 1,
            keyResolutions: 1,
            exactReplay: true,
            contentFree: true,
            maxLogicalWriteAmplificationPermille: 3_000,
            maxAllocatedWriteAmplificationPermille: 3_500,
            maxWalWriteAmplificationPermille:
              profile === 'standalone' ? 3_000 : 0,
            requireWalGrowth: profile === 'standalone',
            runAttempts: 0,
            physicalPowerLossProven: false,
          }),
            }),
          )
        : []),
      Object.freeze({
        name: 'local-workflow-sqlite-lock',
        format: 'json',
        script: path.join(
          root,
          'scripts/ql3-local-workflow-resource-benchmark.cjs',
        ),
        args: Object.freeze([
          '--json',
          `--lock-samples=${tier.workflowLockSamples}`,
          `--max-lock-p95-ms=${tier.workflowMaxLockP95Ms}`,
        ]),
      }),
      Object.freeze({
        name: 'local-workflow-admission-crash-recovery',
        format: 'node_test',
        nodeArgs: Object.freeze([
          path.join(
            root,
            'packages/ql3-local-sqlite/test/pluginPackageWorkflowAdmissionCrashMatrix.test.cjs',
          ),
        ]),
        contract: Object.freeze({
          profiles: Object.freeze(['edge', 'standalone']),
          crashPointsPerProfile: 8,
          scenarios: 16,
          mechanism: 'process_sigkill_then_database_reopen',
          physicalPowerLossProven: false,
        }),
      }),
      Object.freeze({
        name: 'local-workflow-control-crash-recovery',
        format: 'node_test',
        nodeArgs: Object.freeze([
          path.join(
            root,
            'packages/ql3-local-sqlite/test/pluginPackageWorkflowTaskControlCrashMatrix.test.cjs',
          ),
        ]),
        contract: Object.freeze({
          profiles: Object.freeze(['edge', 'standalone']),
          crashPointsPerProfile: 8,
          scenarios: 16,
          conclusiveStopObserved: true,
          physicalPowerLossProven: false,
        }),
      }),
      ...(tierName === 'edge-release-ci'
        ? [
            Object.freeze({
              name: 'local-ai-prompt-model-invocation-crash-recovery',
              format: 'node_test',
              nodeArgs: Object.freeze([
                path.join(
                  root,
                  'packages/ql3-ai/test/modelInvocationCrashMatrix.test.cjs',
                ),
              ]),
              contract: Object.freeze({
                profiles: Object.freeze(['edge', 'standalone']),
                crashPointsPerProfile: 7,
                scenarios: 14,
                boundaries: Object.freeze([
                  'model_start',
                  'model_completion',
                ]),
                mechanism: 'process_sigkill_then_database_reopen',
                physicalPowerLossProven: false,
              }),
            }),
            Object.freeze({
              name: 'local-ai-prompt-outer-transaction-crash-recovery',
              format: 'node_test',
              nodeArgs: Object.freeze([
                path.join(
                  root,
                  'packages/ql3-ai/test/pluginPackagePromptCrashMatrix.test.cjs',
                ),
              ]),
              contract: Object.freeze({
                profiles: Object.freeze(['edge', 'standalone']),
                operations: Object.freeze(['admission', 'finalization']),
                crashPointsPerProfile: 10,
                scenarios: 20,
                mechanism: 'process_sigkill_then_database_reopen',
                exactReplay: true,
                contentFree: true,
                promptAdmissionFinalizationCrashProven: true,
                physicalPowerLossProven: false,
              }),
            }),
          ]
        : []),
    ]);
  }
  return Object.freeze([
    Object.freeze({
      name: 'cluster-control',
      script: path.join(root, 'scripts/ql3-cluster-control-benchmark.cjs'),
      args: Object.freeze([
        '--json',
        `--max-rss-delta-mb=${tier.clusterMaxRssDeltaMb}`,
        `--max-disabled-activation-ms=${tier.clusterMaxDisabledActivationMs}`,
      ]),
    }),
  ]);
}

function parseNodeTestReport(output, plan) {
  const count = (name) =>
    Number(output.match(new RegExp(`\\b${name} (\\d+)`))?.[1]);
  const evidenceRecords = [
    ...output.matchAll(/QL3_RESOURCE_EVIDENCE=(\{[^\n]+\})/g),
  ].map((match) => JSON.parse(match[1]));
  const evidence = evidenceRecords[0];
  const report = {
    tests: count('tests'),
    pass: count('pass'),
    fail: count('fail'),
    skipped: count('skipped'),
    evidence,
    ...(evidenceRecords.length > 1 ? { evidenceRecords } : {}),
    contract: plan.contract,
  };
  if (report.fail !== 0 || report.pass < 1) {
    throw new QingLong3LinuxResourceGateError(
      `${plan.name} returned an invalid node:test summary`,
    );
  }
  if (
    plan.maxProcessRssBytes !== undefined &&
    (evidenceRecords.length < 1 ||
      evidenceRecords.some(
        (record) =>
          !Number.isSafeInteger(record.peakProcessRssBytes) ||
          record.peakProcessRssBytes > plan.maxProcessRssBytes,
      ))
  ) {
    throw new QingLong3LinuxResourceGateError(
      `${plan.name} process RSS exceeded its tier budget`,
    );
  }
  if (plan.contract?.kind === 'durable_prompt_output_resource') {
    const contract = plan.contract;
    const invalid =
      !evidence ||
      evidence.profile !== contract.profile ||
      evidence.journalMode !== contract.journalMode ||
      evidence.durableOutputBytes !== contract.durableOutputBytes ||
      evidence.providerCalls !== contract.providerCalls ||
      evidence.keyLoads !== contract.keyLoads ||
      evidence.keyResolutions !== contract.keyResolutions ||
      evidence.liveOnlyKeyLoads !== 0 ||
      evidence.exactReplay !== contract.exactReplay ||
      evidence.contentFree !== contract.contentFree ||
      evidence.durableFacts?.attempts !== contract.runAttempts ||
      evidence.physicalPowerLossProven !==
        contract.physicalPowerLossProven ||
      !Number.isSafeInteger(
        evidence.databaseLogicalWriteAmplificationPermille,
      ) ||
      evidence.databaseLogicalWriteAmplificationPermille < 1 ||
      evidence.databaseLogicalWriteAmplificationPermille >
        contract.maxLogicalWriteAmplificationPermille ||
      !Number.isSafeInteger(
        evidence.databaseAllocatedWriteAmplificationPermille,
      ) ||
      evidence.databaseAllocatedWriteAmplificationPermille < 1 ||
      evidence.databaseAllocatedWriteAmplificationPermille >
        contract.maxAllocatedWriteAmplificationPermille ||
      !Number.isSafeInteger(evidence.walWriteAmplificationPermille) ||
      evidence.walWriteAmplificationPermille < 0 ||
      evidence.walWriteAmplificationPermille >
        contract.maxWalWriteAmplificationPermille ||
      (contract.requireWalGrowth && evidence.walGrowthBytes < 1) ||
      (!contract.requireWalGrowth && evidence.walGrowthBytes !== 0);
    if (invalid) {
      throw new QingLong3LinuxResourceGateError(
        `${plan.name} durable Prompt output evidence violated its contract`,
      );
    }
  }
  if (plan.contract?.kind === 'local_workflow_product_lifecycle') {
    const contract = plan.contract;
    const completionEvidence = evidenceRecords.find(
      (record) =>
        record.workflowSteps !== undefined && record.attempts !== undefined,
    );
    const cancellationEvidence = evidenceRecords.find(
      (record) => record.cancelCommandStatus !== undefined,
    );
    const invalid =
      !completionEvidence ||
      completionEvidence.schemaVersion !== 1 ||
      completionEvidence.profile !== contract.profile ||
      completionEvidence.workflowSteps !== contract.completedWorkflowSteps ||
      completionEvidence.attempts !== contract.completedAttempts ||
      !cancellationEvidence ||
      cancellationEvidence.schemaVersion !== 1 ||
      cancellationEvidence.profile !== contract.profile ||
      cancellationEvidence.cancelCommandStatus !==
        contract.cancelCommandStatus ||
      cancellationEvidence.exactReplay !== contract.exactReplay ||
      cancellationEvidence.processIdentityObserved !==
        contract.processIdentityObserved ||
      cancellationEvidence.processExited !== contract.processExited ||
      cancellationEvidence.parentRunStatus !== contract.parentRunStatus ||
      cancellationEvidence.attemptStatus !== contract.attemptStatus ||
      cancellationEvidence.cancelledStepRuns !== contract.cancelledStepRuns ||
      cancellationEvidence.cancelEvents !== contract.cancelEvents ||
      cancellationEvidence.cancelAudits !== contract.cancelAudits ||
      cancellationEvidence.physicalPowerLossProven !==
        contract.physicalPowerLossProven;
    if (invalid) {
      throw new QingLong3LinuxResourceGateError(
        `${plan.name} local Workflow cancellation evidence violated its contract`,
      );
    }
  }
  return Object.freeze(report);
}

function runWorkload(plan, root) {
  const nodeArgs = plan.nodeArgs ?? [plan.script, ...plan.args];
  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...plan.env },
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new QingLong3LinuxResourceGateError(
      `${plan.name} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  if (plan.format === 'node_test') {
    return Object.freeze({
      name: plan.name,
      report: parseNodeTestReport(result.stdout, plan),
    });
  }
  try {
    return Object.freeze({
      name: plan.name,
      report: JSON.parse(result.stdout.trim()),
    });
  } catch (error) {
    throw new QingLong3LinuxResourceGateError(
      `${plan.name} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function eventDelta(before, after, name) {
  return (after[name] ?? 0) - (before[name] ?? 0);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 24) {
    throw new QingLong3LinuxResourceGateError(
      'Node.js 24 or newer is required',
    );
  }
  if (
    options.expectedArch !== undefined &&
    process.arch !== options.expectedArch
  ) {
    throw new QingLong3LinuxResourceGateError(
      `architecture ${process.arch} did not equal ${options.expectedArch}`,
    );
  }
  const root = path.resolve(__dirname, '..');
  const before = readLinuxEnvelope();
  const identity = Object.freeze({
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    uid: process.getuid?.() ?? null,
    gid: process.getgid?.() ?? null,
  });
  const violations = [...validateEnvelope(options.tier, before, identity)];
  const workloads = createWorkloadPlans(root, options.tier).map((plan) =>
    runWorkload(plan, root),
  );
  const after = readLinuxEnvelope();
  for (const event of ['max', 'oom', 'oom_kill', 'oom_group_kill']) {
    const delta = eventDelta(before.memoryEvents, after.memoryEvents, event);
    if (delta !== 0)
      violations.push(`memory.events ${event} increased by ${delta}`);
  }
  if (after.memoryPeakBytes > after.memoryMaxBytes) {
    violations.push('memory.peak exceeded memory.max');
  }
  const tier = RESOURCE_TIERS[options.tier];
  const report = {
    schemaVersion: 1,
    tier: options.tier,
    evidenceClass: tier.evidenceClass,
    supportedMinimum: tier.supportedMinimum,
    identity,
    envelope: {
      memoryMaxBytes: after.memoryMaxBytes,
      memoryPeakBytes: after.memoryPeakBytes,
      swapMaxBytes: after.swapMaxBytes,
      cpuQuotaCores: after.cpuQuotaCores,
      pidsMax: after.pidsMax,
      noNewPrivileges: after.noNewPrivileges,
      seccompMode: after.seccompMode,
      rootReadOnly: after.mounts.get('/')?.includes('ro') ?? false,
      workspaceReadOnly:
        after.mounts.get('/workspace')?.includes('ro') ?? false,
      tmpWritable: after.mounts.get('/tmp')?.includes('rw') ?? false,
      memoryEventsBefore: before.memoryEvents,
      memoryEventsAfter: after.memoryEvents,
    },
    workloads,
    gates: {
      passed: violations.length === 0,
      violations,
    },
  };
  process.stdout.write(
    `${JSON.stringify(report, null, options.json ? 0 : 2)}\n`,
  );
  if (violations.length > 0) process.exitCode = 1;
}

module.exports = {
  RESOURCE_TIERS,
  QingLong3LinuxResourceGateError,
  createWorkloadPlans,
  parseArguments,
  parseCpuMax,
  parseKeyValueFile,
  parseLimit,
  parseMountOptions,
  parseNodeTestReport,
  validateEnvelope,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
