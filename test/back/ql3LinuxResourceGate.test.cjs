const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  RESOURCE_TIERS,
  createWorkloadPlans,
  parseArguments,
  parseCpuMax,
  parseKeyValueFile,
  parseLimit,
  parseMountOptions,
  parseNodeTestReport,
  validateEnvelope,
} = require('../../scripts/ql3-linux-resource-gate.cjs');

function envelopeFor(tierName) {
  const tier = RESOURCE_TIERS[tierName];
  return {
    memoryMaxBytes: tier.memoryMaxBytes,
    memoryPeakBytes: 64 * 1024 * 1024,
    swapMaxBytes: tier.swapMaxBytes,
    cpuQuotaCores: tier.cpuQuotaCores,
    pidsMax: tier.pidsMax,
    noNewPrivileges: 1,
    seccompMode: 2,
    mounts: new Map([
      ['/', ['ro', 'relatime']],
      ['/workspace', ['ro', 'nodev']],
      ['/tmp', ['rw', 'nosuid', 'nodev']],
    ]),
  };
}

test('defines separate router stress, edge release and cluster control envelopes', () => {
  assert.deepEqual(Object.keys(RESOURCE_TIERS), [
    'router-stress-ci',
    'edge-release-ci',
    'cluster-control-ci',
  ]);
  assert.equal(RESOURCE_TIERS['router-stress-ci'].supportedMinimum, false);
  assert.equal(
    RESOURCE_TIERS['router-stress-ci'].memoryMaxBytes,
    128 * 1024 * 1024,
  );
  assert.equal(
    RESOURCE_TIERS['edge-release-ci'].memoryMaxBytes,
    256 * 1024 * 1024,
  );
  assert.equal(
    RESOURCE_TIERS['cluster-control-ci'].memoryMaxBytes,
    512 * 1024 * 1024,
  );
  assert.notEqual(
    RESOURCE_TIERS['router-stress-ci'].workload,
    RESOURCE_TIERS['cluster-control-ci'].workload,
  );
});

test('parses bounded cgroup v2 and mount evidence', () => {
  assert.equal(parseLimit('134217728\n', 'memory.max'), 134217728);
  assert.equal(parseLimit('max\n', 'memory.max'), Number.POSITIVE_INFINITY);
  assert.equal(parseCpuMax('50000 100000\n'), 0.5);
  assert.deepEqual(parseKeyValueFile('oom 0\noom_kill 1\n', 'events'), {
    oom: 0,
    oom_kill: 1,
  });
  const mounts = parseMountOptions(
    'overlay / overlay ro,relatime 0 0\ntmpfs /tmp tmpfs rw,nosuid,nodev 0 0\nsource /workspace fakeowner ro,nodev 0 0\n',
  );
  assert.deepEqual(mounts.get('/'), ['ro', 'relatime']);
  assert.deepEqual(mounts.get('/tmp'), ['rw', 'nosuid', 'nodev']);
  assert.deepEqual(mounts.get('/workspace'), ['ro', 'nodev']);
});

test('fails open hosts, root execution and a widened resource envelope', () => {
  const valid = envelopeFor('router-stress-ci');
  assert.deepEqual(
    validateEnvelope('router-stress-ci', valid, {
      platform: 'linux',
      architecture: 'arm64',
      uid: 65532,
    }),
    [],
  );
  const widened = {
    ...valid,
    memoryMaxBytes: 256 * 1024 * 1024,
    mounts: new Map([
      ['/', ['rw']],
      ['/workspace', ['rw']],
      ['/tmp', ['rw']],
    ]),
  };
  assert.deepEqual(
    validateEnvelope('router-stress-ci', widened, {
      platform: 'darwin',
      architecture: 'arm64',
      uid: 0,
    }),
    [
      'memory.max 268435456 did not equal 134217728',
      'platform darwin is not linux',
      'resource workload must be non-root',
      '/ must be mounted read-only',
      '/workspace must be mounted read-only',
    ],
  );
});

test('builds tier-specific workload plans without shell commands', () => {
  const edge = createWorkloadPlans('/workspace', 'router-stress-ci');
  assert.deepEqual(
    edge.map(({ name }) => name),
    [
      'edge-executor',
      'node-sqlite',
      'local-workflow-product',
      'local-workflow-sqlite-lock',
      'local-workflow-admission-crash-recovery',
      'local-workflow-control-crash-recovery',
    ],
  );
  assert.match(edge[0].script, /ql3-edge-benchmark\.cjs$/);
  assert.ok(edge[0].args.includes('--max-rss-delta-mb=64'));
  assert.equal(edge[2].format, 'node_test');
  assert.ok(
    edge[2].nodeArgs.some((argument) =>
      /ql3-local-application\/test\/activation\.test\.cjs$/.test(argument),
    ),
  );
  assert.equal(edge[2].maxProcessRssBytes, 96 * 1024 * 1024);
  assert.equal(edge[2].contract, undefined);
  assert.equal(
    edge[2].nodeArgs.includes(
      '--test-name-pattern=executes one admitted Workflow',
    ),
    true,
  );
  const edgeRelease = createWorkloadPlans(
    '/workspace',
    'edge-release-ci',
  );
  assert.deepEqual(
    edgeRelease.map(({ name }) => name),
    [
      'edge-executor',
      'node-sqlite',
      'local-workflow-product',
      'local-ai-prompt-durable-output-edge',
      'local-ai-prompt-durable-output-standalone',
      'local-workflow-sqlite-lock',
      'local-workflow-admission-crash-recovery',
      'local-workflow-control-crash-recovery',
      'local-ai-prompt-model-invocation-crash-recovery',
      'local-ai-prompt-outer-transaction-crash-recovery',
    ],
  );
  assert.equal(
    edgeRelease[2].nodeArgs.includes(
      '--test-name-pattern=executes one admitted Workflow|stops one running Workflow Task',
    ),
    true,
  );
  assert.deepEqual(edgeRelease[2].contract, {
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
  });
  assert.equal(edgeRelease[3].maxProcessRssBytes, 192 * 1024 * 1024);
  assert.deepEqual(edgeRelease[3].env, {
    QL3_PROMPT_RESOURCE_PROFILE: 'edge',
    QL3_PROMPT_RESOURCE_OUTPUT_BYTES: String(512 * 1024),
  });
  assert.equal(edgeRelease[3].contract.providerCalls, 2);
  assert.equal(edgeRelease[3].contract.exactReplay, true);
  assert.equal(edgeRelease[3].contract.contentFree, true);
  assert.equal(edgeRelease[3].contract.durableOutputBytes, 512 * 1024);
  assert.equal(
    edgeRelease[3].contract.maxWalWriteAmplificationPermille,
    0,
  );
  assert.equal(edgeRelease[4].contract.profile, 'standalone');
  assert.equal(edgeRelease[4].contract.journalMode, 'wal');
  assert.equal(edgeRelease[4].contract.requireWalGrowth, true);
  assert.match(
    edge[3].script,
    /ql3-local-workflow-resource-benchmark\.cjs$/,
  );
  assert.ok(edge[3].args.includes('--lock-samples=16'));
  assert.ok(edge[3].args.includes('--max-lock-p95-ms=500'));
  assert.equal(edge[4].contract.scenarios, 16);
  assert.equal(edge[4].contract.physicalPowerLossProven, false);
  assert.equal(edge[5].contract.scenarios, 16);
  assert.equal(edge[5].contract.conclusiveStopObserved, true);
  assert.equal(edge[5].contract.physicalPowerLossProven, false);
  assert.equal(edgeRelease[8].contract.scenarios, 14);
  assert.deepEqual(edgeRelease[8].contract.boundaries, [
    'model_start',
    'model_completion',
  ]);
  assert.equal(edgeRelease[8].contract.physicalPowerLossProven, false);
  assert.equal(edgeRelease[9].contract.scenarios, 20);
  assert.deepEqual(edgeRelease[9].contract.operations, [
    'admission',
    'finalization',
  ]);
  assert.equal(edgeRelease[9].contract.exactReplay, true);
  assert.equal(edgeRelease[9].contract.contentFree, true);
  assert.equal(
    edgeRelease[9].contract.promptAdmissionFinalizationCrashProven,
    true,
  );
  assert.equal(edgeRelease[9].contract.physicalPowerLossProven, false);
  const cluster = createWorkloadPlans('/workspace', 'cluster-control-ci');
  assert.deepEqual(
    cluster.map(({ name }) => name),
    ['cluster-control'],
  );
  assert.match(cluster[0].script, /ql3-cluster-control-benchmark\.cjs$/);
});

test('rejects unknown tiers and architecture labels', () => {
  assert.deepEqual(
    parseArguments(['--tier=edge-release-ci', '--expected-arch=x64', '--json']),
    { tier: 'edge-release-ci', expectedArch: 'x64', json: true },
  );
  assert.throws(
    () => parseArguments(['--tier=router']),
    /--tier must be one of/,
  );
  assert.throws(
    () => parseArguments(['--tier=router-stress-ci', '--expected-arch=arm']),
    /--expected-arch must be x64 or arm64/,
  );
});

test('fails closed when durable Prompt resource evidence drifts', () => {
  const [edgePlan, standalonePlan] = createWorkloadPlans(
    '/workspace',
    'edge-release-ci',
  ).filter(({ contract }) => contract?.kind === 'durable_prompt_output_resource');
  const evidence = {
    profile: 'edge',
    journalMode: 'delete',
    durableOutputBytes: 512 * 1024,
    providerCalls: 2,
    keyLoads: 1,
    keyResolutions: 1,
    liveOnlyKeyLoads: 0,
    exactReplay: true,
    contentFree: true,
    durableFacts: { attempts: 0 },
    peakProcessRssBytes: 100 * 1024 * 1024,
    databaseLogicalWriteAmplificationPermille: 1_383,
    databaseAllocatedWriteAmplificationPermille: 1_383,
    walWriteAmplificationPermille: 0,
    walGrowthBytes: 0,
    physicalPowerLossProven: false,
  };
  const output = (value) =>
    `tests 1\npass 1\nfail 0\nskipped 0\nQL3_RESOURCE_EVIDENCE=${JSON.stringify(value)}\n`;
  assert.equal(
    parseNodeTestReport(output(evidence), edgePlan).evidence.profile,
    'edge',
  );
  assert.throws(
    () =>
      parseNodeTestReport(
        output({
          ...evidence,
          databaseLogicalWriteAmplificationPermille: 3_001,
        }),
        edgePlan,
      ),
    /durable Prompt output evidence violated its contract/,
  );
  assert.throws(
    () =>
      parseNodeTestReport(
        output({
          ...evidence,
          profile: 'standalone',
          journalMode: 'wal',
          walWriteAmplificationPermille: 0,
          walGrowthBytes: 0,
        }),
        standalonePlan,
      ),
    /durable Prompt output evidence violated its contract/,
  );
});

test('fails closed when authenticated Workflow cancellation evidence drifts', () => {
  const plan = createWorkloadPlans(
    '/workspace',
    'edge-release-ci',
  ).find(
    ({ contract }) =>
      contract?.kind === 'local_workflow_product_lifecycle',
  );
  assert.ok(plan);
  const completionEvidence = {
    schemaVersion: 1,
    profile: 'edge',
    workflowSteps: 2,
    attempts: 2,
    peakProcessRssBytes: 79 * 1024 * 1024,
  };
  const cancellationEvidence = {
    schemaVersion: 1,
    profile: 'edge',
    cancelCommandStatus: 'accepted',
    exactReplay: true,
    processIdentityObserved: true,
    processExited: true,
    parentRunStatus: 'cancelled',
    attemptStatus: 'cancelled',
    cancelledStepRuns: 2,
    cancelEvents: 1,
    cancelAudits: 1,
    peakProcessRssBytes: 80 * 1024 * 1024,
    physicalPowerLossProven: false,
  };
  const output = (value) =>
    `tests 2\npass 2\nfail 0\nskipped 0\nQL3_RESOURCE_EVIDENCE=${JSON.stringify(completionEvidence)}\nQL3_RESOURCE_EVIDENCE=${JSON.stringify(value)}\n`;
  assert.equal(
    parseNodeTestReport(output(cancellationEvidence), plan)
      .evidenceRecords[1].processExited,
    true,
  );
  assert.throws(
    () =>
      parseNodeTestReport(
        output({ ...cancellationEvidence, cancelAudits: 0 }),
        plan,
      ),
    /local Workflow cancellation evidence violated its contract/,
  );
  assert.throws(
    () =>
      parseNodeTestReport(
        output({
          ...cancellationEvidence,
          peakProcessRssBytes: 161 * 1024 * 1024,
        }),
        plan,
      ),
    /process RSS exceeded its tier budget/,
  );
});
