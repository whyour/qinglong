const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  RESOURCE_TIERS,
  createWorkloadPlans,
  isPathTreeReadOnly,
  mountOptionsForPath,
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
  assert.deepEqual(mountOptionsForPath(mounts, '/workspace/cache'), [
    'ro',
    'nodev',
  ]);
  assert.equal(isPathTreeReadOnly(mounts, '/workspace'), true);
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
  const inheritedWorkspace = {
    ...valid,
    mounts: new Map([
      ['/', ['ro']],
      ['/tmp', ['rw']],
    ]),
  };
  assert.deepEqual(
    validateEnvelope('router-stress-ci', inheritedWorkspace, {
      platform: 'linux',
      architecture: 'arm64',
      uid: 65532,
    }),
    [],
  );
  assert.equal(
    isPathTreeReadOnly(
      new Map([
        ['/', ['ro']],
        ['/workspace/cache', ['rw']],
      ]),
      '/workspace',
    ),
    false,
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
      'plugin-package-failed-upgrade',
      'legacy-shadow-terminal-edge',
    ],
  );
  assert.match(edge[0].script, /ql3-edge-benchmark\.cjs$/);
  assert.ok(edge[0].args.includes('--max-rss-delta-mb=64'));
  const edgeShadow = edge.find(
    ({ name }) => name === 'legacy-shadow-terminal-edge',
  );
  assert.match(edgeShadow.script, /ql3-legacy-shadow-resource-rollback\.cjs$/);
  assert.ok(edgeShadow.args.includes('--profile=edge'));
  assert.ok(edgeShadow.args.includes('--mode=audit-only'));
  assert.ok(edgeShadow.args.includes('--samples=8'));
  const edgeWorkflow = edge.find(
    ({ name }) => name === 'local-workflow-product',
  );
  assert.equal(edgeWorkflow.format, 'node_test');
  assert.ok(
    edgeWorkflow.nodeArgs.some((argument) =>
      /ql3-local-application\/test\/activation\.test\.cjs$/.test(argument),
    ),
  );
  assert.equal(edgeWorkflow.maxProcessRssBytes, 96 * 1024 * 1024);
  assert.equal(edgeWorkflow.contract, undefined);
  assert.equal(
    edgeWorkflow.nodeArgs.includes(
      '--test-name-pattern=executes one admitted Workflow',
    ),
    true,
  );
  const edgeRelease = createWorkloadPlans('/workspace', 'edge-release-ci');
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
      'plugin-package-failed-upgrade',
      'legacy-shadow-terminal-edge',
      'legacy-shadow-terminal-standalone',
    ],
  );
  const releaseWorkflow = edgeRelease.find(
    ({ name }) => name === 'local-workflow-product',
  );
  assert.equal(
    releaseWorkflow.nodeArgs.includes(
      '--test-name-pattern=executes one admitted Workflow|stops one running Workflow Task',
    ),
    true,
  );
  assert.deepEqual(releaseWorkflow.contract, {
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
  const releaseEdgeShadow = edgeRelease.find(
    ({ name }) => name === 'legacy-shadow-terminal-edge',
  );
  const releaseStandaloneShadow = edgeRelease.find(
    ({ name }) => name === 'legacy-shadow-terminal-standalone',
  );
  assert.ok(releaseEdgeShadow.args.includes('--mode=full'));
  assert.ok(releaseStandaloneShadow.args.includes('--profile=standalone'));
  assert.ok(releaseStandaloneShadow.args.includes('--mode=audit-only'));
  const edgePrompt = edgeRelease.find(
    ({ name }) => name === 'local-ai-prompt-durable-output-edge',
  );
  const standalonePrompt = edgeRelease.find(
    ({ name }) => name === 'local-ai-prompt-durable-output-standalone',
  );
  assert.equal(edgePrompt.maxProcessRssBytes, 192 * 1024 * 1024);
  assert.deepEqual(edgePrompt.env, {
    QL3_PROMPT_RESOURCE_PROFILE: 'edge',
    QL3_PROMPT_RESOURCE_OUTPUT_BYTES: String(512 * 1024),
  });
  assert.equal(edgePrompt.contract.providerCalls, 2);
  assert.equal(edgePrompt.contract.keyLoads, 1);
  assert.equal(edgePrompt.contract.keyResolutions, 2);
  assert.equal(edgePrompt.contract.exactReplay, true);
  assert.equal(edgePrompt.contract.contentFree, true);
  assert.equal(edgePrompt.contract.durableOutputBytes, 512 * 1024);
  assert.equal(edgePrompt.contract.maxWalWriteAmplificationPermille, 0);
  assert.equal(standalonePrompt.contract.profile, 'standalone');
  assert.equal(standalonePrompt.contract.journalMode, 'wal');
  assert.equal(standalonePrompt.contract.requireWalGrowth, true);
  const workflowLock = edge.find(
    ({ name }) => name === 'local-workflow-sqlite-lock',
  );
  assert.match(
    workflowLock.script,
    /ql3-local-workflow-resource-benchmark\.cjs$/,
  );
  assert.ok(workflowLock.args.includes('--lock-samples=16'));
  assert.ok(workflowLock.args.includes('--max-lock-p95-ms=500'));
  const releaseAdmissionCrash = edgeRelease.find(
    ({ name }) => name === 'local-workflow-admission-crash-recovery',
  );
  const releaseControlCrash = edgeRelease.find(
    ({ name }) => name === 'local-workflow-control-crash-recovery',
  );
  assert.equal(releaseAdmissionCrash.env, undefined);
  assert.deepEqual(releaseAdmissionCrash.contract.profiles, [
    'edge',
    'standalone',
  ]);
  assert.equal(releaseAdmissionCrash.contract.scenarios, 16);
  assert.equal(releaseControlCrash.env, undefined);
  assert.deepEqual(releaseControlCrash.contract.profiles, [
    'edge',
    'standalone',
  ]);
  assert.equal(releaseControlCrash.contract.scenarios, 16);
  const modelCrash = edgeRelease.find(
    ({ name }) => name === 'local-ai-prompt-model-invocation-crash-recovery',
  );
  const transactionCrash = edgeRelease.find(
    ({ name }) => name === 'local-ai-prompt-outer-transaction-crash-recovery',
  );
  assert.equal(modelCrash.contract.scenarios, 14);
  assert.deepEqual(modelCrash.contract.boundaries, [
    'model_start',
    'model_completion',
  ]);
  assert.equal(modelCrash.contract.physicalPowerLossProven, false);
  assert.equal(transactionCrash.contract.scenarios, 20);
  assert.deepEqual(transactionCrash.contract.operations, [
    'admission',
    'finalization',
  ]);
  assert.equal(transactionCrash.contract.exactReplay, true);
  assert.equal(transactionCrash.contract.contentFree, true);
  assert.equal(
    transactionCrash.contract.promptAdmissionFinalizationCrashProven,
    true,
  );
  assert.equal(transactionCrash.contract.physicalPowerLossProven, false);
  const edgeUpgrade = edge.find(
    ({ name }) => name === 'plugin-package-failed-upgrade',
  );
  const releaseUpgrade = edgeRelease.find(
    ({ name }) => name === 'plugin-package-failed-upgrade',
  );
  assert.match(
    edgeUpgrade.script,
    /ql3-plugin-package-recovery-edge-benchmark\.cjs$/,
  );
  assert.ok(edgeUpgrade.args.includes('--max-rss-delta-mb=64'));
  assert.ok(releaseUpgrade.args.includes('--max-rss-delta-mb=96'));
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
  ).filter(
    ({ contract }) => contract?.kind === 'durable_prompt_output_resource',
  );
  const evidence = {
    profile: 'edge',
    journalMode: 'delete',
    durableOutputBytes: 512 * 1024,
    providerCalls: 2,
    keyLoads: 1,
    keyResolutions: 2,
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
    `tests 1\npass 1\nfail 0\nskipped 0\nQL3_RESOURCE_EVIDENCE=${JSON.stringify(
      value,
    )}\n`;
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
  const plan = createWorkloadPlans('/workspace', 'edge-release-ci').find(
    ({ contract }) => contract?.kind === 'local_workflow_product_lifecycle',
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
    `tests 2\npass 2\nfail 0\nskipped 0\nQL3_RESOURCE_EVIDENCE=${JSON.stringify(
      completionEvidence,
    )}\nQL3_RESOURCE_EVIDENCE=${JSON.stringify(value)}\n`;
  assert.equal(
    parseNodeTestReport(output(cancellationEvidence), plan).evidenceRecords[1]
      .processExited,
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
