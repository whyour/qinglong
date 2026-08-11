const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const {
  InvalidPluginPackageLifecycleError,
  assertPluginPackageLifecycleReceiptMatchesEvent,
  createPluginPackageLifecycleEvent,
  createPluginPackageLifecycleImpact,
  createPluginPackageLifecycleReceipt,
  normalizePluginPackageLifecycleEvent,
  normalizePluginPackageLifecycleImpact,
  normalizePluginPackageLifecycleReceipt,
  pluginPackageLifecycleActionDigest,
  pluginPackageLifecycleMutationId,
  pluginPackageLifecycleNextDisposition,
  pluginPackageLifecycleReferenceGraphDigest,
  pluginPackageLifecycleTaskMutationId,
} = require('../dist/plugin-package/lifecycle/pluginPackageLifecycle');

const digest = (value) => value.repeat(64);

function target() {
  return {
    projectId: 'default',
    packageName: 'example-monitor',
    installationId: 'install-example-v1',
    lockDigest: digest('a'),
    installVersion: 4,
    installRecordDigest: digest('b'),
  };
}

function expectation(disposition = 'active', version = 0, eventDigest = null) {
  return { disposition, version, eventDigest };
}

function impactInput(action = 'disable', overrides = {}) {
  const input = {
    action,
    target: target(),
    expected:
      action === 'disable'
        ? expectation()
        : expectation('disabled', 1, digest('c')),
    generationDigest: digest('d'),
    materializedRevisionDigest: digest('e'),
    currentToolSnapshotDigest: digest('f'),
    taskIds: ['report', 'collect'],
    resourceCounts: {
      tasks: 2,
      tools: 1,
      workflows: 1,
      prompts: 1,
    },
    blockingReferences: [],
    ...overrides,
  };
  return {
    ...input,
    referenceGraphDigest: pluginPackageLifecycleReferenceGraphDigest({
      target: input.target,
      generationDigest: input.generationDigest,
      materializedRevisionDigest: input.materializedRevisionDigest,
      taskIds: input.taskIds,
      resourceCounts: input.resourceCounts,
      blockingReferences: input.blockingReferences,
    }),
  };
}

function taskTransitions(status) {
  return [
    {
      taskId: 'report',
      previousRevision: 4,
      currentRevision: 5,
      previousContentDigest: digest('2'),
      currentContentDigest: digest('3'),
      previousEnabled: status === 'withdrawn',
      currentEnabled: status === 'restored',
    },
    {
      taskId: 'collect',
      previousRevision: 7,
      currentRevision: 8,
      previousContentDigest: digest('4'),
      currentContentDigest: digest('5'),
      previousEnabled: status === 'withdrawn',
      currentEnabled: status === 'restored',
    },
  ];
}

function capability(status) {
  const unchanged = status === 'retired';
  return {
    status,
    taskTransitions: unchanged ? [] : taskTransitions(status),
    previousActiveVectorDigest: digest('6'),
    currentActiveVectorDigest: unchanged ? digest('6') : digest('7'),
    currentToolSnapshotDigest: digest('8'),
    retainedSourceCount: 2,
  };
}

function lifecycleHead(event, disposition, version, committedAtMs) {
  const lifecycleTarget = target();
  return {
    projectId: lifecycleTarget.projectId,
    packageName: lifecycleTarget.packageName,
    installationId: lifecycleTarget.installationId,
    lockDigest: lifecycleTarget.lockDigest,
    installRecordDigest: lifecycleTarget.installRecordDigest,
    version,
    disposition,
    eventDigest: event.eventDigest,
    updatedAtMs: committedAtMs,
  };
}

test('binds one human-confirmed disable to exact resources and capability withdrawal', () => {
  const impact = createPluginPackageLifecycleImpact(impactInput());
  assert.deepEqual(impact.taskIds, ['collect', 'report']);
  assert.equal(impact.resourceCounts.workflows, 1);
  const event = createPluginPackageLifecycleEvent({
    dispatchId: 'dispatch-disable-v1',
    impact,
    requestedBy: { type: 'user', id: 'owner-a' },
    approvedBy: { type: 'user', id: 'owner-a' },
    authorizationMode: 'human_confirmation',
    occurredAtMs: 100,
  });
  assert.equal(event.actionDigest, pluginPackageLifecycleActionDigest(impact));
  assert.equal(
    event.mutationId,
    pluginPackageLifecycleMutationId(event.dispatchId, impact.impactDigest),
  );
  const receipt = createPluginPackageLifecycleReceipt({
    eventDigest: event.eventDigest,
    action: 'disable',
    target: event.impact.target,
    lifecycle: lifecycleHead(event, 'disabled', 1, 101),
    capability: capability('withdrawn'),
    committedAtMs: 101,
  });
  assert.deepEqual(normalizePluginPackageLifecycleImpact(impact), impact);
  assert.deepEqual(normalizePluginPackageLifecycleEvent(event), event);
  assert.deepEqual(normalizePluginPackageLifecycleReceipt(receipt), receipt);
  assert.doesNotThrow(() =>
    assertPluginPackageLifecycleReceiptMatchesEvent(event, receipt),
  );
  assert.match(
    pluginPackageLifecycleTaskMutationId(event.eventDigest, 'collect'),
    /^[0-9a-f-]{36}$/,
  );
});

test('allows only active-disable, disabled-enable and disabled-uninstall transitions', () => {
  assert.equal(
    pluginPackageLifecycleNextDisposition('disable', 'active'),
    'disabled',
  );
  assert.equal(
    pluginPackageLifecycleNextDisposition('enable', 'disabled'),
    'active',
  );
  assert.equal(
    pluginPackageLifecycleNextDisposition('uninstall', 'disabled'),
    'uninstalled',
  );
  for (const [action, disposition] of [
    ['disable', 'disabled'],
    ['enable', 'active'],
    ['enable', 'uninstalled'],
    ['uninstall', 'active'],
    ['uninstall', 'uninstalled'],
  ]) {
    assert.throws(
      () => pluginPackageLifecycleNextDisposition(action, disposition),
      InvalidPluginPackageLifecycleError,
    );
  }
});

test('requires exact local or separation-of-duty authorization and blocks referenced uninstall', () => {
  const disable = createPluginPackageLifecycleImpact(impactInput());
  assert.throws(
    () =>
      createPluginPackageLifecycleEvent({
        dispatchId: 'dispatch-invalid-local',
        impact: disable,
        requestedBy: { type: 'user', id: 'owner-a' },
        approvedBy: { type: 'user', id: 'owner-b' },
        authorizationMode: 'human_confirmation',
        occurredAtMs: 100,
      }),
    InvalidPluginPackageLifecycleError,
  );
  assert.throws(
    () =>
      createPluginPackageLifecycleEvent({
        dispatchId: 'dispatch-invalid-cluster',
        impact: disable,
        requestedBy: { type: 'user', id: 'owner-a' },
        approvedBy: { type: 'user', id: 'owner-a' },
        authorizationMode: 'separation_of_duty',
        occurredAtMs: 100,
      }),
    InvalidPluginPackageLifecycleError,
  );
  const uninstall = createPluginPackageLifecycleImpact(
    impactInput('uninstall', {
      blockingReferences: [
        {
          kind: 'workflow',
          ownerId: 'workflow-a',
          referenceDigest: digest('9'),
        },
      ],
    }),
  );
  assert.throws(
    () =>
      createPluginPackageLifecycleEvent({
        dispatchId: 'dispatch-blocked-uninstall',
        impact: uninstall,
        requestedBy: { type: 'user', id: 'owner-a' },
        approvedBy: { type: 'user', id: 'owner-b' },
        authorizationMode: 'separation_of_duty',
        occurredAtMs: 100,
      }),
    /blocking references/,
  );
});

test('binds enable and uninstall receipts to distinct restored and retired facts', () => {
  for (const fixture of [
    {
      action: 'enable',
      disposition: 'active',
      status: 'restored',
      dispatchId: 'dispatch-enable-v2',
    },
    {
      action: 'uninstall',
      disposition: 'uninstalled',
      status: 'retired',
      dispatchId: 'dispatch-uninstall-v2',
    },
  ]) {
    const impact = createPluginPackageLifecycleImpact(
      impactInput(fixture.action),
    );
    const event = createPluginPackageLifecycleEvent({
      dispatchId: fixture.dispatchId,
      impact,
      requestedBy: { type: 'user', id: 'owner-a' },
      approvedBy: { type: 'user', id: 'owner-b' },
      authorizationMode: 'separation_of_duty',
      occurredAtMs: 200,
    });
    const receipt = createPluginPackageLifecycleReceipt({
      eventDigest: event.eventDigest,
      action: fixture.action,
      target: event.impact.target,
      lifecycle: lifecycleHead(event, fixture.disposition, 2, 201),
      capability: capability(fixture.status),
      committedAtMs: 201,
    });
    assert.doesNotThrow(() =>
      assertPluginPackageLifecycleReceiptMatchesEvent(event, receipt),
    );
  }
});

test('rejects digest, resource-count and receipt transition drift', () => {
  const impact = createPluginPackageLifecycleImpact(impactInput());
  assert.throws(
    () =>
      normalizePluginPackageLifecycleImpact({
        ...impact,
        impactDigest: digest('0'),
      }),
    /impactDigest/,
  );
  assert.throws(
    () =>
      normalizePluginPackageLifecycleImpact({
        ...impact,
        referenceGraphDigest: digest('0'),
      }),
    /referenceGraphDigest/,
  );
  assert.throws(
    () =>
      createPluginPackageLifecycleImpact(
        impactInput('disable', {
          resourceCounts: {
            tasks: 1,
            tools: 1,
            workflows: 1,
            prompts: 1,
          },
        }),
      ),
    /taskIds/,
  );
  const event = createPluginPackageLifecycleEvent({
    dispatchId: 'dispatch-disable-drift',
    impact,
    requestedBy: { type: 'user', id: 'owner-a' },
    approvedBy: { type: 'user', id: 'owner-a' },
    authorizationMode: 'human_confirmation',
    occurredAtMs: 100,
  });
  assert.throws(
    () =>
      createPluginPackageLifecycleReceipt({
        eventDigest: event.eventDigest,
        action: 'disable',
        target: event.impact.target,
        lifecycle: lifecycleHead(event, 'disabled', 1, 101),
        capability: {
          ...capability('withdrawn'),
          currentActiveVectorDigest: digest('6'),
        },
        committedAtMs: 101,
      }),
    /active vector/,
  );
});

test('keeps originally disabled Package Tasks outside the lifecycle transition set', () => {
  const impact = createPluginPackageLifecycleImpact(
    impactInput('disable', {
      resourceCounts: {
        tasks: 3,
        tools: 1,
        workflows: 1,
        prompts: 1,
      },
    }),
  );
  assert.equal(impact.resourceCounts.tasks, 3);
  assert.deepEqual(impact.taskIds, ['collect', 'report']);
});

test('publishes lifecycle only through its explicit runtime-core subpath', () => {
  const root = require('../dist');
  assert.equal(root.createPluginPackageLifecycleImpact, undefined);
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '../package.json'), 'utf8'),
  );
  assert.deepEqual(manifest.exports['./plugin-package-lifecycle'], {
    types: './dist/plugin-package/lifecycle/pluginPackageLifecycle.d.ts',
    require: './dist/plugin-package/lifecycle/pluginPackageLifecycle.js',
    default: './dist/plugin-package/lifecycle/pluginPackageLifecycle.js',
  });
});
