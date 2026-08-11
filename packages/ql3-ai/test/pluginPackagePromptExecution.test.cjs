const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  InvalidPluginPackagePromptExecutionPlanError,
  PLUGIN_PACKAGE_PROMPT_EXECUTION_PLAN_SCHEMA,
  createPluginPackagePromptAdmissionBundle,
  normalizePluginPackagePromptExecutionPlan,
  pluginPackagePromptExecutionPlanDigest,
  preparePluginPackagePromptExecution,
} = require('../dist/prompt/pluginPackagePromptExecution.js');
const {
  pluginPackageAutomationPublicationDigest,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');

function publication(overrides = {}) {
  const unsigned = {
    schema: 'qinglong/plugin-package-automation-publication@v1',
    target: {
      projectId: 'project-a',
      packageName: 'package-a',
      installationId: 'installation-a',
      lockDigest: '1'.repeat(64),
      generation: 3,
      generationDigest: '2'.repeat(64),
      materializedRevisionDigest: '3'.repeat(64),
    },
    state: 'active',
    version: 1,
    previousPublicationDigest: null,
    lifecycleEventDigest: null,
    definitions: {
      workflows: [],
      prompts: [
        {
          schema: 'qinglong/plugin-package-prompt-resource@v1',
          id: 'summary',
          name: 'Summary',
          template: 'Summarize {{subject}} for {{audience}}.',
          parameters: [
            { name: 'audience', required: false },
            { name: 'subject', required: true },
          ],
        },
      ],
    },
    publishedAtMs: 1_000,
    ...overrides,
  };
  return {
    ...unsigned,
    publicationDigest: pluginPackageAutomationPublicationDigest(unsigned),
  };
}

function prepare(overrides = {}) {
  const active = publication();
  return preparePluginPackagePromptExecution({
    publication: active,
    expectedPublicationDigest: active.publicationDigest,
    promptId: 'summary',
    requestId: 'prompt-request-a',
    traceId: 'trace-a',
    requestedBySubject: { type: 'user', id: 'user-a' },
    policyFence: { projectVersion: 1, bindingVersion: 1 },
    parameters: { subject: 'QingLong 3.0' },
    provider: 'openai-compatible',
    model: 'model-a',
    maxOutputTokens: 512,
    temperature: 0.2,
    plannedAtMs: 2_000,
    deadlineAtMs: 62_000,
    ...overrides,
  });
}

test('prepares a content-free immutable Prompt execution plan', () => {
  const first = prepare();
  const second = prepare();
  assert.deepEqual(first, second);
  assert.equal(first.plan.schema, PLUGIN_PACKAGE_PROMPT_EXECUTION_PLAN_SCHEMA);
  assert.deepEqual(first.plan.output, { mode: 'live_only' });
  assert.equal(
    first.request.messages[0].content,
    'Summarize QingLong 3.0 for .',
  );
  assert.match(first.plan.invocationId, /^ppi:[0-9a-f]{32}$/);
  assert.match(first.plan.runId, /^ppr:[0-9a-f]{32}$/);
  assert.match(first.plan.stepRunId, /^pps:[0-9a-f]{32}$/);
  assert.match(first.plan.modelRequestDigest, /^sha256:[0-9a-f]{64}$/);
  const durable = JSON.stringify(first.plan);
  assert.equal(durable.includes('QingLong 3.0'), false);
  assert.equal(durable.includes('Summarize '), false);
  assert.equal(Object.isFrozen(first.plan), true);
});

test('binds explicit durable output retention and preserves legacy live-only replay', () => {
  const durable = prepare({
    output: {
      mode: 'durable_artifact',
      retentionPolicy: {
        revision: 'edge-output-v1',
        retentionMs: 86_400_000,
      },
    },
  }).plan;
  assert.equal(durable.output.mode, 'durable_artifact');
  assert.match(durable.output.retentionPolicyDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(durable.planDigest, prepare().plan.planDigest);
  assert.throws(
    () =>
      normalizePluginPackagePromptExecutionPlan({
        ...durable,
        output: {
          ...durable.output,
          retentionPolicyDigest: 'f'.repeat(64),
        },
      }),
    InvalidPluginPackagePromptExecutionPlanError,
  );

  const current = prepare().plan;
  const {
    output: _output,
    planDigest: _planDigest,
    ...legacyUnsigned
  } = current;
  const legacy = {
    ...legacyUnsigned,
    planDigest: pluginPackagePromptExecutionPlanDigest(legacyUnsigned),
  };
  assert.equal(
    normalizePluginPackagePromptExecutionPlan(legacy).output,
    undefined,
  );
});

test('binds parameter presence and content without recursively rendering values', () => {
  const omitted = prepare();
  const empty = prepare({
    parameters: { subject: 'QingLong 3.0', audience: '' },
  });
  const literal = prepare({
    parameters: { subject: '{{audience}}', audience: 'operators' },
  });
  assert.notEqual(omitted.plan.parameterDigest, empty.plan.parameterDigest);
  assert.equal(
    literal.request.messages[0].content,
    'Summarize {{audience}} for operators.',
  );
});

test('rejects stale publication, missing or widened parameters and unsafe budgets', () => {
  const active = publication();
  assert.throws(
    () =>
      preparePluginPackagePromptExecution({
        ...prepare().plan,
        publication: active,
        expectedPublicationDigest: 'f'.repeat(64),
        promptId: 'summary',
        requestId: 'request-b',
        traceId: 'trace-b',
        requestedBySubject: { type: 'user', id: 'user-b' },
        policyFence: { projectVersion: 1, bindingVersion: 1 },
        parameters: { subject: 'x' },
        provider: 'provider-a',
        model: 'model-a',
        maxOutputTokens: 1,
        plannedAtMs: 2_000,
        deadlineAtMs: 3_000,
      }),
    InvalidPluginPackagePromptExecutionPlanError,
  );
  assert.throws(() => prepare({ parameters: {} }), /subject is required/);
  assert.throws(
    () => prepare({ parameters: { subject: 'x', extra: 'y' } }),
    /undeclared name/,
  );
  assert.throws(
    () => prepare({ deadlineAtMs: 2_000 + 5 * 60_000 + 1 }),
    /deadline/,
  );
  assert.throws(() => prepare({ maxOutputTokens: 32_769 }), /maxOutputTokens/);
});

test('creates one model StepRun admission without persisting Prompt content', () => {
  const prepared = prepare();
  const bundle = createPluginPackagePromptAdmissionBundle(prepared.plan);
  assert.equal(bundle.run.status, 'running');
  assert.equal(bundle.run.version, 2);
  assert.equal(bundle.run.eventSequence, 2);
  assert.equal(bundle.run.triggerType, 'plugin_package_prompt');
  assert.equal(bundle.stepMutation.stepRun.kind, 'model');
  assert.equal(bundle.stepMutation.stepRun.status, 'ready');
  assert.equal(bundle.stepMutation.expectedRunVersion, 1);
  assert.equal(bundle.stepMutation.event.sequence, 2);
  assert.equal(bundle.receipt.finalRunVersion, 2);
  assert.equal(bundle.receipt.invocationId, prepared.plan.invocationId);
  const durable = JSON.stringify(bundle);
  assert.equal(durable.includes('QingLong 3.0'), false);
  assert.equal(durable.includes('Summarize '), false);
});

test('normalizer rejects identity and digest drift', () => {
  const plan = prepare().plan;
  assert.throws(
    () =>
      normalizePluginPackagePromptExecutionPlan({
        ...plan,
        runId: 'ppr:drift',
      }),
    InvalidPluginPackagePromptExecutionPlanError,
  );
  assert.throws(
    () =>
      normalizePluginPackagePromptExecutionPlan({
        ...plan,
        parameterDigest: 'f'.repeat(64),
      }),
    InvalidPluginPackagePromptExecutionPlanError,
  );
});
