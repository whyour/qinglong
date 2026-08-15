const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  CopilotFailureDiagnosisApplicationService,
  CopilotFailureDiagnosisApplicationUnavailableError,
} = require('@qinglong/ai/failure-diagnosis-application');
const {
  BUILTIN_RUN_LOG_EXCERPT_TOOL_DEFINITION,
} = require('@qinglong/runtime-core/builtin-run-log-excerpt-tool');
const {
  createPluginPackageResourceGenerationFromReferences,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const {
  createProjectToolDefinitionSnapshot,
} = require('@qinglong/runtime-core/project-tool-definition-snapshot');

const NOW = 1_800_000_000_000;
const KEY = Buffer.alloc(32, 0x42);
const MODEL = Object.freeze({
  provider: 'provider-primary',
  model: 'model-diagnosis',
  modelBoundary: 'external',
  responseLanguage: 'zh-CN',
  maxOutputTokens: 512,
  egressPolicy: Object.freeze({
    schema: 'qinglong/copilot-model-egress-policy@v1',
    revision: 'application-test-v1',
    potentiallySensitiveDataBoundaries: Object.freeze(['external']),
    maxInputBytes: 64 * 1024,
    maxOutputTokens: 1024,
  }),
});

function snapshot() {
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: 'installation-copilot-test',
    projectId: 'project-1',
    packageName: 'qinglong',
    lockDigest: 'a'.repeat(64),
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: 'b'.repeat(64),
    resources: [],
  });
  return createProjectToolDefinitionSnapshot({
    projectId: 'project-1',
    contributions: [
      {
        generation,
        revisionDigest: 'c'.repeat(64),
        definitions: [BUILTIN_RUN_LOG_EXCERPT_TOOL_DEFINITION],
      },
    ],
  });
}

function command(overrides = {}) {
  return {
    requestId: 'diagnosis-request-1',
    traceId: 'diagnosis-trace-1',
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    principal: {
      subject: { type: 'user', id: 'owner-1' },
      authenticationId: 'auth-1',
      authenticatedAtMs: NOW - 1000,
      expiresAtMs: NOW + 60_000,
      assurance: 'multi_factor',
    },
    ...overrides,
  };
}

function fixture(options = {}) {
  let plan = null;
  let artifacts = null;
  let failArtifactOnce = options.failArtifactOnce === true;
  let activeKeyCopies = [];
  let resolvedKeyCopies = [];
  let toolCalls = 0;
  let modelCalls = 0;
  let releaseTool;
  const toolGate = options.blockTool
    ? new Promise((resolve) => { releaseTool = resolve; })
    : Promise.resolve();
  const admissions = {
    async findByRequestId(requestId) {
      return plan?.requestId === requestId
        ? { requestId, planDigest: plan.planDigest }
        : null;
    },
    async findPlanByRequestId(requestId) {
      return plan?.requestId === requestId ? plan : null;
    },
    async admit(value) {
      const status = plan ? 'existing' : 'created';
      plan ??= value;
      assert.equal(plan.planDigest, value.planDigest);
      return {
        status,
        receipt: {
          requestId: plan.requestId,
          planDigest: plan.planDigest,
          runId: plan.runId,
        },
      };
    },
  };
  const snapshots = {
    async findCurrent() { return { snapshot: snapshot(), committedAtMs: NOW }; },
  };
  const runs = {
    async findRunById() {
      return {
        id: 'source-run-1', projectId: 'project-1', status: 'failed',
        version: 8, eventSequence: 8,
      };
    },
    async findLatestAttemptByRunId() {
      return {
        id: 'source-attempt-1', runId: 'source-run-1', attempt: 1,
        status: 'failed', executorType: 'remote_worker', callbackSequence: 0,
        createdAtMs: NOW - 3000, finishedAtMs: NOW - 1000,
        logArtifactId: `wlog-${'d'.repeat(30)}`,
      };
    },
  };
  const artifactRepository = {
    async put(input, preview) {
      if (failArtifactOnce) {
        failArtifactOnce = false;
        throw new Error('simulated admission-to-artifact crash');
      }
      if (artifacts) {
        assert.deepEqual(input, artifacts.input);
        assert.deepEqual(preview, artifacts.preview);
        return { status: 'existing' };
      }
      artifacts = { input, preview };
      return { status: 'inserted' };
    },
    async findInput() { return artifacts?.input ?? null; },
    async findPreview() { return artifacts?.preview ?? null; },
  };
  const invocationKeys = {
    async active() {
      const copy = Buffer.from(KEY);
      activeKeyCopies.push(copy);
      return { keyId: 'invocation-key-1', key: copy };
    },
    async resolve(keyId) {
      assert.equal(keyId, 'invocation-key-1');
      const copy = Buffer.from(KEY);
      resolvedKeyCopies.push(copy);
      return { keyId, key: copy };
    },
  };
  const unlocks = { async findByRequestId() { return null; }, async commit() {} };
  const tool = {
    admissions,
    snapshots,
    runs,
    artifacts: artifactRepository,
    invocationKeys,
    resultKeys: { async resolve() { return null; } },
    stepRuns: { async findById() { return null; } },
    barriers: {}, completions: {}, failureCompletions: {},
    resultKeyCatalog: {}, resultRekeys: {}, logs: {}, unlocks,
  };
  const model = {
    admissions,
    unlocks,
    toolResults: {}, modelInvocations: {}, outputs: {}, gateway: {},
    successfulCompletion: {}, finalizations: {},
  };
  const service = new CopilotFailureDiagnosisApplicationService({
    admissions,
    snapshots,
    runs,
    artifacts: artifactRepository,
    invocationKeys,
    authorizer: {
      async authorize() {
        return {
          effect: 'allow', reasons: ['role_grant'],
          fence: { projectVersion: 1, bindingVersion: 1 },
        };
      },
    },
    tool,
    model,
    modelIntent: MODEL,
    executionTimeoutMs: 60_000,
    now: () => NOW,
    async executeTool() {
      toolCalls += 1;
      await toolGate;
      return options.toolFailure
        ? { outcome: 'failed', completionStatus: 'created', unlockStatus: null }
        : {
            outcome: 'succeeded', completionStatus: 'created',
            unlockStatus: 'created', completion: {}, unlock: {},
          };
    },
    async executeModel() {
      modelCalls += 1;
      return {
        outcome: 'succeeded',
        output: { artifactId: 'output-1' },
        finalization: { requestId: 'diagnosis-request-1' },
      };
    },
  });
  return {
    service,
    releaseTool: () => releaseTool?.(),
    state: () => ({
      plan, artifacts, toolCalls, modelCalls,
      activeKeyCopies, resolvedKeyCopies,
    }),
  };
}

test('application derives, admits and executes one server-owned diagnosis with exact replay', async () => {
  const testFixture = fixture();
  const first = await testFixture.service.execute(command());
  assert.equal(first.admissionStatus, 'created');
  assert.equal(first.tool.outcome, 'succeeded');
  assert.equal(first.model.outcome, 'succeeded');
  assert.equal(first.terminalizationRequired, false);
  const second = await testFixture.service.execute(command());
  assert.equal(second.admissionStatus, 'existing');
  const state = testFixture.state();
  assert.equal(state.toolCalls, 2);
  assert.equal(state.modelCalls, 2);
  assert.equal(state.plan.source.attemptId, 'source-attempt-1');
  assert.equal(state.plan.tool.invocationArtifact.artifactId.startsWith('cdia:'), true);
  assert.equal(state.activeKeyCopies[0].every((value) => value === 0), true);
  assert.equal(state.resolvedKeyCopies[0].every((value) => value === 0), true);
});

test('application repairs the durable admission-to-Artifact crash window', async () => {
  const testFixture = fixture({ failArtifactOnce: true });
  await assert.rejects(
    testFixture.service.execute(command()),
    CopilotFailureDiagnosisApplicationUnavailableError,
  );
  assert.ok(testFixture.state().plan);
  assert.equal(testFixture.state().artifacts, null);
  const replay = await testFixture.service.execute(command());
  assert.equal(replay.admissionStatus, 'existing');
  assert.ok(testFixture.state().artifacts);
});

test('application coalesces exact callers and exposes Tool terminalization debt', async () => {
  const concurrent = fixture({ blockTool: true });
  const first = concurrent.service.execute(command());
  const second = concurrent.service.execute(command());
  assert.equal(first, second);
  concurrent.releaseTool();
  await first;
  assert.equal(concurrent.state().toolCalls, 1);

  const failed = fixture({ toolFailure: true });
  const result = await failed.service.execute(command());
  assert.equal(result.tool.outcome, 'failed');
  assert.equal(result.model, null);
  assert.equal(result.terminalizationRequired, true);
  assert.equal(failed.state().modelCalls, 0);
});
