const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  fixture: installFixture,
} = require('../../../test/contracts/pluginPackageInstallRepositoryContract.cjs');

const {
  ClusterPluginPackageManagementTransportAuthenticationError,
  ClusterPluginPackageManagementTransportRequestError,
  createClusterPluginPackageManagementTransport,
} = require('@qinglong/cluster-admin/plugin-package-management-transport');

const NOW = 1_000;
const PRIVATE_LOCATOR = `registry:private.example/qinglong/monitor@sha256:${'a'.repeat(
  64,
)}`;

function principal(overrides = {}) {
  return {
    subject: { type: 'user', id: 'cluster-reviewer' },
    authenticationId: 'oidc-session-secret',
    authenticatedAtMs: NOW - 100,
    expiresAtMs: NOW + 1_000,
    assurance: 'multi_factor',
    ...overrides,
  };
}

function actionInput() {
  return {
    lockId: 'cluster-monitor-v1',
    projectId: 'default',
    manifest: {
      apiVersion: 'qinglong.io/v1alpha1',
      kind: 'PluginPackage',
      metadata: {
        name: 'cluster-monitor',
        displayName: 'Cluster Monitor',
        version: '1.0.0',
        description: 'must not cross the low-sensitive response boundary',
        license: 'Apache-2.0',
      },
      spec: {
        compatibility: {
          qinglong: '>=3.0.0-0 <4.0.0',
          architectures: ['arm64'],
          deploymentProfiles: ['cluster'],
        },
        runtimes: [],
        resources: {
          memory: { recommended: '32Mi' },
          disk: { install: '4Mi', working: '16Mi' },
        },
        permissions: {
          network: { allowedHosts: [] },
          secrets: ['private-token'],
          tools: [],
        },
        contents: { tasks: [], workflows: [], prompts: [], tools: [] },
      },
    },
    plan: {
      schema: 'qinglong/plugin-package-install-plan@v1',
      operation: 'install',
    },
    environment: {
      qinglongVersion: '3.0.0-alpha.0',
      architecture: 'arm64',
      deploymentProfile: 'cluster',
      runtimes: [],
      availableMemoryBytes: 128 * 1024 * 1024,
      availableDiskBytes: 512 * 1024 * 1024,
    },
    source: {
      kind: 'registry',
      locator: PRIVATE_LOCATOR,
      artifactDigest: 'a'.repeat(64),
      artifactBytes: 4_096,
      contentDigest: 'b'.repeat(64),
    },
    architecture: 'arm64',
    deploymentProfile: 'cluster',
    targetGeneration: 1,
  };
}

function proposal(createdAtMs = NOW) {
  return {
    schema: 'qinglong/plugin-package-install-proposal@v1',
    actionRef: 'package:cluster-monitor:1',
    projectId: 'default',
    actionType: 'plugin_package.install',
    permission: 'package.manage',
    actionInput: actionInput(),
    actionDigest: 'c'.repeat(64),
    previewDigest: 'd'.repeat(64),
    proposedBy: { type: 'user', id: 'cluster-reviewer' },
    proposalFence: { projectVersion: 1, bindingVersion: 1 },
    createdAtMs,
    proposalDigest: 'e'.repeat(64),
  };
}

function approval(overrides = {}) {
  return {
    schema: 'qinglong/approval-request@v1',
    id: 'approval-cluster-monitor-1',
    projectId: 'default',
    version: 1,
    state: 'pending',
    action: {
      permission: 'package.manage',
      actionType: 'plugin_package.install',
      actionRef: 'package:cluster-monitor:1',
      actionDigest: 'c'.repeat(64),
      previewDigest: 'd'.repeat(64),
    },
    risk: 'high',
    decisionMode: 'separation_of_duty',
    requestedBy: { type: 'user', id: 'cluster-requester' },
    requestedAtMs: NOW,
    expiresAtMs: NOW + 15 * 60 * 1_000,
    requestFence: { projectVersion: 1, bindingVersion: 1 },
    decisionId: null,
    decision: null,
    decisionReasonCode: null,
    decidedBy: null,
    decisionAuthenticationId: null,
    decisionAssurance: null,
    decidedAtMs: null,
    decisionFence: null,
    consumptionId: null,
    dispatchId: null,
    consumedBy: null,
    consumedAtMs: null,
    consumptionFence: null,
    ...overrides,
  };
}

function proposeCommand() {
  return {
    schemaVersion: 1,
    operation: 'plugin-package.propose',
    request: {
      actionRef: 'package:cluster-monitor:1',
      approvalRequestId: 'approval-cluster-monitor-1',
      proposalAuditEventId: 'proposal-audit-1',
      approvalAuditEventId: 'approval-audit-1',
      actionInput: actionInput(),
    },
  };
}

function decideCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'plugin-package.decide',
    request: {
      actionRef: 'package:cluster-monitor:1',
      approvalRequestId: 'approval-cluster-monitor-1',
      expectedVersion: 1,
      decisionId: 'decision-cluster-monitor-1',
      auditEventId: 'decision-audit-1',
      decision: 'approved',
      reasonCode: 'reviewed',
      ...overrides,
    },
  };
}

function inspectCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'plugin-package.inspect',
    request: {
      actionRef: 'package:cluster-monitor:1',
      approvalRequestId: 'approval-cluster-monitor-1',
      inspectionId: 'inspection-cluster-monitor-1',
      ...overrides,
    },
  };
}

function installationInspectCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'plugin-package.installation.inspect',
    request: {
      projectId: 'default',
      packageName: 'cluster-monitor',
      inspectionId: 'installation-inspection-cluster-monitor-1',
      ...overrides,
    },
  };
}

function installationListCommand(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'plugin-package.installation.list',
    request: {
      projectId: 'default',
      limit: 8,
      inspectionId: 'installation-list-cluster-monitor-1',
      ...overrides,
    },
  };
}

function currentInstallationItem(quarantined = false) {
  const record = installFixture('transport-installation', {
    packageName: 'cluster-monitor',
    installationId: 'cluster-monitor-installation',
  }).install;
  return {
    record,
    quarantine: quarantined
      ? {
          eventDigest: '1'.repeat(64),
          reasonCode: 'confirmed_key_compromise',
          authorizationMode: 'break_glass',
          occurredAtMs: NOW - 10,
          capabilityStatus: 'not_active',
          receiptDigest: '2'.repeat(64),
          committedAtMs: NOW - 9,
        }
      : null,
  };
}

function fakeService(
  inspectResult = { proposal: null, approvalRequest: null },
  installationItem = currentInstallationItem(),
) {
  const calls = {
    propose: [],
    decide: [],
    consume: [],
    inspect: [],
    inspectAuthorized: [],
    inspectInstallationAuthorized: [],
    listInstallationsAuthorized: [],
    dispatch: [],
  };
  return {
    calls,
    service: {
      async propose(request) {
        calls.propose.push(request);
        return {
          proposalStatus: 'created',
          approvalStatus: 'created',
          proposal: proposal(request.requestedAtMs),
          approvalRequest: approval({
            requestedBy: request.principal.subject,
            requestedAtMs: request.requestedAtMs,
          }),
        };
      },
      async decide(request) {
        calls.decide.push(request);
        return {
          status: 'decided',
          request: approval({
            version: 2,
            state: request.decision,
            decisionId: request.decisionId,
            decision: request.decision,
            decisionReasonCode: request.reasonCode,
            decidedBy: request.principal.subject,
            decisionAuthenticationId: request.principal.authenticationId,
            decisionAssurance: request.principal.assurance,
            decidedAtMs: request.decidedAtMs,
            decisionFence: { projectVersion: 1, bindingVersion: 1 },
          }),
        };
      },
      async consume(request) {
        calls.consume.push(request);
        throw new Error('consume must not be public');
      },
      async inspect(actionRef, approvalRequestId) {
        calls.inspect.push({ actionRef, approvalRequestId });
        return inspectResult;
      },
      async inspectAuthorized(request) {
        calls.inspectAuthorized.push(request);
        return inspectResult;
      },
      async inspectInstallationAuthorized(request) {
        calls.inspectInstallationAuthorized.push(request);
        return installationItem;
      },
      async listInstallationsAuthorized(request) {
        calls.listInstallationsAuthorized.push(request);
        return {
          items: [installationItem],
          truncated: false,
        };
      },
      async dispatch(limit) {
        calls.dispatch.push(limit);
        throw new Error('dispatch must not be public');
      },
    },
  };
}

function authentication(value = principal()) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    authority: {
      async authenticate() {
        calls += 1;
        return value;
      },
    },
  };
}

function secretBindingPlan() {
  return {
    schema: 'qinglong/plugin-package-secret-binding-approval-plan@v1',
    actionRef: 'secret-binding:cluster-monitor:1',
    bindingPlan: {
      schema: 'qinglong/plugin-package-secret-binding-plan@v1',
      target: {
        installationId: 'cluster-monitor-installation',
        projectId: 'default',
        packageName: 'cluster-monitor',
        lockDigest: '1'.repeat(64),
        generation: 1,
        generationDigest: '2'.repeat(64),
        manifestDigest: '3'.repeat(64),
      },
      entries: [{
        name: 'TOKEN',
        required: true,
        secretRef:
          'qlsecret:v1:eyJwcm9qZWN0SWQiOiJkZWZhdWx0IiwibmFtZSI6InJ1bnRpbWUtdG9rZW4iLCJ2ZXJzaW9uIjoyfQ',
      }],
      plannedAtMs: NOW - 10,
      planDigest: '4'.repeat(64),
    },
    requestedBy: { type: 'user', id: 'cluster-reviewer' },
    expiresAtMs: NOW + 10_000,
    approvalPlanDigest: '5'.repeat(64),
  };
}

function fakeSecretBinding() {
  const calls = { plan: [], propose: [], decide: [], inspectAuthorized: [] };
  return {
    calls,
    service: {
      async plan(request) {
        calls.plan.push(request);
        return { status: 'created', plan: secretBindingPlan() };
      },
      async propose(request) {
        calls.propose.push(request);
        return {
          plan: secretBindingPlan(),
          approvalStatus: 'created',
          approvalRequest: approval({
            id: request.approvalRequestId,
            action: {
              permission: 'secret.manage',
              actionType: 'plugin_package.secret_binding.bind',
              actionRef: request.actionRef,
              actionDigest: '5'.repeat(64),
              previewDigest: '4'.repeat(64),
            },
            requestedBy: request.principal.subject,
          }),
        };
      },
      async decide(request) {
        calls.decide.push(request);
        return {
          status: 'decided',
          request: approval({
            id: request.approvalRequestId,
            version: 2,
            state: request.decision,
            decisionId: request.decisionId,
            decision: request.decision,
            decisionReasonCode: request.reasonCode,
            decidedBy: request.principal.subject,
            decisionAuthenticationId: request.principal.authenticationId,
            decisionAssurance: request.principal.assurance,
            decidedAtMs: NOW,
            decisionFence: { projectVersion: 1, bindingVersion: 1 },
          }),
        };
      },
      async inspectAuthorized(request) {
        calls.inspectAuthorized.push(request);
        return {
          plan: secretBindingPlan(),
          approvalRequest: null,
          stale: false,
        };
      },
    },
  };
}

function lifecyclePlan() {
  return {
    schema: 'qinglong/plugin-package-lifecycle-plan@v1',
    actionRef: 'lifecycle:cluster-monitor:disable:1',
    impact: {
      schema: 'qinglong/plugin-package-lifecycle-impact@v1',
      action: 'disable',
      target: {
        projectId: 'default',
        packageName: 'cluster-monitor',
        installationId: 'cluster-monitor-installation',
        lockDigest: '1'.repeat(64),
        installVersion: 4,
        installRecordDigest: '2'.repeat(64),
      },
      expected: {
        version: 0,
        disposition: 'active',
        eventDigest: null,
      },
      generationDigest: '3'.repeat(64),
      materializedRevisionDigest: '4'.repeat(64),
      currentToolSnapshotDigest: '5'.repeat(64),
      taskIds: ['collect'],
      resourceCounts: { tasks: 1, tools: 0, workflows: 0, prompts: 0 },
      referenceGraphDigest: '6'.repeat(64),
      blockingReferences: [],
      impactDigest: '7'.repeat(64),
    },
    requestedBy: { type: 'user', id: 'cluster-reviewer' },
    plannedAtMs: NOW - 10,
    expiresAtMs: NOW + 10_000,
    planDigest: '8'.repeat(64),
  };
}

function fakeLifecycle() {
  const calls = { propose: [], decide: [], inspectAuthorized: [] };
  return {
    calls,
    service: {
      async propose(request) {
        calls.propose.push(request);
        return {
          plan: lifecyclePlan(),
          approvalStatus: 'created',
          approvalRequest: approval({
            id: 'approval-lifecycle-cluster-monitor-1',
            action: {
              permission: 'package.manage',
              actionType: 'plugin_package.lifecycle.disable',
              actionRef: lifecyclePlan().actionRef,
              actionDigest: '9'.repeat(64),
              previewDigest: lifecyclePlan().impact.impactDigest,
            },
            requestedBy: request.principal.subject,
          }),
        };
      },
      async decide(request) {
        calls.decide.push(request);
        return {
          status: 'decided',
          request: approval({
            id: request.approvalRequestId,
            version: 2,
            state: request.decision,
            decisionId: request.decisionId,
            decision: request.decision,
            decisionReasonCode: request.reasonCode,
            decidedBy: request.principal.subject,
            decisionAuthenticationId: request.principal.authenticationId,
            decisionAssurance: request.principal.assurance,
            decidedAtMs: NOW,
            decisionFence: { projectVersion: 1, bindingVersion: 1 },
          }),
        };
      },
      async inspectAuthorized(request) {
        calls.inspectAuthorized.push(request);
        return {
          plan: lifecyclePlan(),
          approvalRequest: null,
          stale: true,
        };
      },
    },
  };
}

function publisherProposal(overrides = {}) {
  return {
    schema: 'qinglong/plugin-package-publisher-key-revocation-proposal@v1',
    actionRef: 'publisher-revoke:publisher-a.example:key-a',
    projectId: 'cluster-trust-authority',
    actionType: 'plugin_package.publisher_key.revoke',
    permission: 'package.manage',
    actionInput: {
      authorityProjectId: 'cluster-trust-authority',
      trustAuthorityId: 'cluster',
      trustGeneration: 4,
      publisher: 'publisher-a.example',
      keyId: 'key-a',
      previousTrustDigest: '1'.repeat(64),
      currentTrustDigest: '2'.repeat(64),
      authorizationMode: 'dual_control',
      reasonCode: 'suspected_key_compromise',
    },
    actionDigest: '3'.repeat(64),
    previewDigest: '4'.repeat(64),
    proposedBy: { type: 'user', id: 'cluster-reviewer' },
    proposerAssurance: 'multi_factor',
    proposalFence: { projectVersion: 1, bindingVersion: 1 },
    createdAtMs: NOW,
    proposalDigest: '5'.repeat(64),
    ...overrides,
  };
}

function publisherApproval(candidate = publisherProposal(), overrides = {}) {
  return approval({
    id: 'approval-publisher-revoke-1',
    projectId: candidate.projectId,
    action: {
      permission: candidate.permission,
      actionType: candidate.actionType,
      actionRef: candidate.actionRef,
      actionDigest: candidate.actionDigest,
      previewDigest: candidate.previewDigest,
    },
    risk: 'critical',
    ...overrides,
  });
}

function publisherCommand(operation, request = {}) {
  const common = {
    actionRef: 'publisher-revoke:publisher-a.example:key-a',
    approvalRequestId: 'approval-publisher-revoke-1',
  };
  if (operation.endsWith('.propose')) {
    return {
      schemaVersion: 1,
      operation,
      request: {
        ...common,
        proposalAuditEventId: 'proposal-publisher-audit-1',
        approvalAuditEventId: 'approval-publisher-audit-1',
        publisher: 'publisher-a.example',
        keyId: 'key-a',
        authorizationMode: 'dual_control',
        reasonCode: 'suspected_key_compromise',
        ...request,
      },
    };
  }
  if (operation.endsWith('.decide')) {
    return {
      schemaVersion: 1,
      operation,
      request: {
        ...common,
        expectedVersion: 1,
        decisionId: 'decision-publisher-revoke-1',
        auditEventId: 'decision-publisher-audit-1',
        decision: 'approved',
        reasonCode: 'reviewed',
        ...request,
      },
    };
  }
  return {
    schemaVersion: 1,
    operation,
    request: {
      ...common,
      inspectionId: 'inspection-publisher-revoke-1',
      ...request,
    },
  };
}

function fakePublisherTrust(
  inspectResult = { proposal: null, approvalRequest: null },
) {
  const calls = { propose: [], inspect: [], inspectAuthorized: [] };
  return {
    calls,
    service: {
      async propose(request) {
        calls.propose.push(request);
        const candidate = publisherProposal({
          createdAtMs: request.requestedAtMs,
          proposedBy: request.principal.subject,
          proposerAssurance: request.principal.assurance,
          actionInput: {
            ...publisherProposal().actionInput,
            authorizationMode: request.authorizationMode,
            reasonCode: request.reasonCode,
          },
        });
        return {
          proposalStatus: 'created',
          approvalStatus: 'created',
          proposal: candidate,
          approvalRequest: publisherApproval(candidate, {
            requestedBy: request.principal.subject,
            requestedAtMs: request.requestedAtMs,
          }),
        };
      },
      async inspect(actionRef, approvalRequestId) {
        calls.inspect.push({ actionRef, approvalRequestId });
        return inspectResult;
      },
      async inspectAuthorized(request) {
        calls.inspectAuthorized.push(request);
        return inspectResult;
      },
    },
  };
}

test('rejects weak or non-user principals before Package management state access', async () => {
  for (const candidate of [
    principal({ assurance: 'single_factor' }),
    principal({ subject: { type: 'api_app', id: 'cluster-api' } }),
    null,
  ]) {
    const fixture = fakeService();
    const auth = authentication(candidate);
    const transport = createClusterPluginPackageManagementTransport({
      service: fixture.service,
      now: () => NOW,
    });

    await assert.rejects(
      transport.execute(proposeCommand(), auth.authority),
      ClusterPluginPackageManagementTransportAuthenticationError,
    );
    assert.equal(auth.calls, 1);
    assert.deepEqual(fixture.calls.inspect, []);
    assert.deepEqual(fixture.calls.propose, []);
  }
});

test('rejects internal consume and dispatch operations before authentication', async () => {
  const fixture = fakeService();
  const auth = authentication();
  const transport = createClusterPluginPackageManagementTransport({
    service: fixture.service,
    now: () => NOW,
  });

  for (const operation of [
    'plugin-package.consume',
    'plugin-package.dispatch',
  ]) {
    await assert.rejects(
      transport.execute(
        { schemaVersion: 1, operation, request: {} },
        auth.authority,
      ),
      ClusterPluginPackageManagementTransportRequestError,
    );
  }
  assert.equal(auth.calls, 0);
  assert.deepEqual(fixture.calls.consume, []);
  assert.deepEqual(fixture.calls.dispatch, []);
});

test('injects strong transport authority and emits only low-sensitive proposal data', async () => {
  const fixture = fakeService();
  const auth = authentication();
  const transport = createClusterPluginPackageManagementTransport({
    service: fixture.service,
    now: () => NOW,
  });

  const result = await transport.execute(proposeCommand(), auth.authority);
  assert.equal(auth.calls, 1);
  assert.equal(fixture.calls.inspect.length, 1);
  assert.equal(fixture.calls.propose.length, 1);
  assert.equal(fixture.calls.propose[0].requestedAtMs, NOW);
  assert.deepEqual(fixture.calls.propose[0].principal, principal());
  assert.equal(Object.hasOwn(proposeCommand().request, 'principal'), false);
  assert.equal(Object.hasOwn(proposeCommand().request, 'requestedAtMs'), false);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(PRIVATE_LOCATOR), false);
  assert.equal(serialized.includes('oidc-session-secret'), false);
  assert.equal(serialized.includes('private-token'), false);
  assert.equal(
    serialized.includes('must not cross the low-sensitive response boundary'),
    false,
  );
  assert.equal(result.proposal.packageName, 'cluster-monitor');
  assert.equal(result.proposal.sourceKind, 'registry');
});

test('uses the durable proposal time when recovering a partial proposal', async () => {
  const durableProposal = proposal(NOW - 250);
  const fixture = fakeService({
    proposal: durableProposal,
    approvalRequest: null,
  });
  const transport = createClusterPluginPackageManagementTransport({
    service: fixture.service,
    now: () => NOW,
  });

  await transport.execute(proposeCommand(), authentication().authority);
  assert.equal(
    fixture.calls.propose[0].requestedAtMs,
    durableProposal.createdAtMs,
  );
});

test('replays an exact decision without mutating and timestamps a new decision', async () => {
  const decided = approval({
    version: 2,
    state: 'approved',
    decisionId: 'decision-cluster-monitor-1',
    decision: 'approved',
    decisionReasonCode: 'reviewed',
    decidedBy: { type: 'user', id: 'cluster-reviewer' },
    decisionAuthenticationId: 'previous-oidc-session',
    decisionAssurance: 'multi_factor',
    decidedAtMs: NOW - 10,
    decisionFence: { projectVersion: 1, bindingVersion: 1 },
  });
  const replayFixture = fakeService({
    proposal: proposal(),
    approvalRequest: decided,
  });
  const replayTransport = createClusterPluginPackageManagementTransport({
    service: replayFixture.service,
    now: () => NOW,
  });

  const replay = await replayTransport.execute(
    decideCommand(),
    authentication().authority,
  );
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replayFixture.calls.decide, []);

  const newFixture = fakeService({
    proposal: proposal(),
    approvalRequest: approval(),
  });
  const newTransport = createClusterPluginPackageManagementTransport({
    service: newFixture.service,
    now: () => NOW,
  });
  const decidedResult = await newTransport.execute(
    decideCommand({ decisionId: 'decision-cluster-monitor-2' }),
    authentication().authority,
  );
  assert.equal(decidedResult.status, 'decided');
  assert.equal(newFixture.calls.decide.length, 1);
  assert.equal(newFixture.calls.decide[0].decidedAtMs, NOW);
  assert.deepEqual(newFixture.calls.decide[0].principal, principal());
});

test('routes public inspection through the authorized, quota-aware service path', async () => {
  const fixture = fakeService({
    proposal: proposal(),
    approvalRequest: approval(),
  });
  const transport = createClusterPluginPackageManagementTransport({
    service: fixture.service,
    now: () => NOW,
  });

  const result = await transport.execute(
    inspectCommand(),
    authentication().authority,
  );
  assert.equal(result.operation, 'plugin-package.inspect');
  assert.equal(fixture.calls.inspect.length, 0);
  assert.deepEqual(fixture.calls.inspectAuthorized, [
    {
      actionRef: 'package:cluster-monitor:1',
      approvalRequestId: 'approval-cluster-monitor-1',
      inspectionId: 'inspection-cluster-monitor-1',
      principal: principal(),
    },
  ]);
});

test('routes bounded installation inventory and reports quarantine availability', async () => {
  const fixture = fakeService(
    { proposal: null, approvalRequest: null },
    currentInstallationItem(true),
  );
  const transport = createClusterPluginPackageManagementTransport({
    service: fixture.service,
    now: () => NOW,
  });

  const inspected = await transport.execute(
    installationInspectCommand(),
    authentication().authority,
  );
  assert.equal(inspected.installation.availability, 'quarantined');
  assert.equal(
    inspected.installation.quarantineReason,
    'confirmed_key_compromise',
  );
  assert.equal(inspected.installation.withdrawalStatus, 'not_active');
  assert.deepEqual(fixture.calls.inspectInstallationAuthorized, [
    {
      ...installationInspectCommand().request,
      principal: principal(),
    },
  ]);

  const listed = await transport.execute(
    installationListCommand(),
    authentication().authority,
  );
  assert.equal(listed.installations.length, 1);
  assert.equal(listed.truncated, false);
  assert.equal(listed.next, null);
  assert.deepEqual(fixture.calls.listInstallationsAuthorized, [
    {
      ...installationListCommand().request,
      principal: principal(),
    },
  ]);
});

test('routes lifecycle review without exposing executor mutation authority', async () => {
  const management = fakeService();
  const lifecycle = fakeLifecycle();
  const transport = createClusterPluginPackageManagementTransport({
    service: management.service,
    lifecycle: lifecycle.service,
    now: () => NOW,
  });
  const proposed = await transport.execute(
    {
      schemaVersion: 1,
      operation: 'plugin-package.lifecycle.propose',
      request: {
        actionRef: lifecyclePlan().actionRef,
        approvalRequestId: 'approval-lifecycle-cluster-monitor-1',
        approvalAuditEventId: 'audit-lifecycle-approval-1',
      },
    },
    authentication().authority,
  );
  assert.equal(proposed.plan.action, 'disable');
  assert.equal(proposed.plan.impactDigest, '7'.repeat(64));
  assert.equal(lifecycle.calls.propose.length, 1);
  assert.deepEqual(lifecycle.calls.propose[0].principal, principal());

  const decided = await transport.execute(
    {
      schemaVersion: 1,
      operation: 'plugin-package.lifecycle.decide',
      request: {
        actionRef: lifecyclePlan().actionRef,
        approvalRequestId: 'approval-lifecycle-cluster-monitor-1',
        expectedVersion: 1,
        decisionId: 'decision-lifecycle-cluster-monitor-1',
        auditEventId: 'audit-lifecycle-decision-1',
        decision: 'approved',
        reasonCode: 'reviewed',
      },
    },
    authentication().authority,
  );
  assert.equal(decided.status, 'decided');
  assert.equal(lifecycle.calls.decide.length, 1);

  const inspected = await transport.execute(
    {
      schemaVersion: 1,
      operation: 'plugin-package.lifecycle.inspect',
      request: {
        actionRef: lifecyclePlan().actionRef,
        approvalRequestId: 'approval-lifecycle-cluster-monitor-1',
        inspectionId: 'inspection-lifecycle-cluster-monitor-1',
      },
    },
    authentication().authority,
  );
  assert.equal(inspected.stale, true);
  assert.equal(inspected.approval, null);
  assert.equal(lifecycle.calls.inspectAuthorized.length, 1);
  assert.deepEqual(management.calls.consume, []);
  assert.deepEqual(management.calls.dispatch, []);
});

test('routes content-free Secret binding review without executor authority', async () => {
  const management = fakeService();
  const secretBinding = fakeSecretBinding();
  const transport = createClusterPluginPackageManagementTransport({
    service: management.service,
    secretBinding: secretBinding.service,
    now: () => NOW,
  });
  const planCommand = {
    schemaVersion: 1,
    operation: 'plugin-package.secret-binding.plan',
    request: {
      actionRef: secretBindingPlan().actionRef,
      projectId: 'default',
      packageName: 'cluster-monitor',
      assignments: secretBindingPlan().bindingPlan.entries.map(
        ({ name, secretRef }) => ({ name, secretRef }),
      ),
    },
  };
  const planned = await transport.execute(
    planCommand,
    authentication().authority,
  );
  assert.equal(planned.status, 'created');
  assert.deepEqual(Object.keys(planned.plan).sort(), [
    'actionRef', 'approvalPlanDigest', 'entries', 'expiresAtMs', 'generation',
    'generationDigest', 'installationId', 'lockDigest', 'manifestDigest',
    'packageName', 'planDigest', 'plannedAtMs', 'projectId',
  ]);
  assert.equal(JSON.stringify(planned).includes('authenticationId'), false);

  const proposed = await transport.execute({
    schemaVersion: 1,
    operation: 'plugin-package.secret-binding.propose',
    request: {
      actionRef: secretBindingPlan().actionRef,
      approvalRequestId: 'approval-secret-binding-1',
      approvalAuditEventId: 'audit-secret-binding-approval-1',
    },
  }, authentication().authority);
  assert.equal(proposed.approvalStatus, 'created');

  const decided = await transport.execute({
    schemaVersion: 1,
    operation: 'plugin-package.secret-binding.decide',
    request: {
      actionRef: secretBindingPlan().actionRef,
      approvalRequestId: 'approval-secret-binding-1',
      expectedVersion: 1,
      decisionId: 'decision-secret-binding-1',
      auditEventId: 'audit-secret-binding-decision-1',
      decision: 'approved',
      reasonCode: 'reviewed',
    },
  }, authentication().authority);
  assert.equal(decided.status, 'decided');

  const inspected = await transport.execute({
    schemaVersion: 1,
    operation: 'plugin-package.secret-binding.inspect',
    request: {
      actionRef: secretBindingPlan().actionRef,
      approvalRequestId: 'approval-secret-binding-1',
      inspectionId: 'inspection-secret-binding-1',
    },
  }, authentication().authority);
  assert.equal(inspected.stale, false);
  assert.equal(secretBinding.calls.plan.length, 1);
  assert.equal(secretBinding.calls.propose.length, 1);
  assert.equal(secretBinding.calls.decide.length, 1);
  assert.equal(secretBinding.calls.inspectAuthorized.length, 1);
  assert.deepEqual(management.calls.consume, []);
  assert.deepEqual(management.calls.dispatch, []);
});

test('routes publisher revocation proposal with derived-only low-sensitive output', async () => {
  const management = fakeService();
  const publisherTrust = fakePublisherTrust();
  const transport = createClusterPluginPackageManagementTransport({
    service: management.service,
    publisherTrust: publisherTrust.service,
    now: () => NOW,
  });
  const command = publisherCommand(
    'plugin-package.publisher-revocation.propose',
  );
  const result = await transport.execute(command, authentication().authority);
  assert.equal(result.operation, command.operation);
  assert.equal(publisherTrust.calls.propose.length, 1);
  assert.equal(Object.hasOwn(command.request, 'previousTrustDigest'), false);
  assert.equal(Object.hasOwn(command.request, 'currentTrustDigest'), false);
  assert.deepEqual(Object.keys(result.proposal).sort(), [
    'actionDigest',
    'actionRef',
    'authorizationMode',
    'createdAtMs',
    'currentTrustDigest',
    'keyId',
    'previewDigest',
    'previousTrustDigest',
    'projectId',
    'proposalDigest',
    'publisher',
    'reasonCode',
    'trustAuthorityId',
    'trustGeneration',
  ]);
});

test('requires hardware assurance for break-glass confirmation', async () => {
  const candidate = publisherProposal({
    actionInput: {
      ...publisherProposal().actionInput,
      authorizationMode: 'break_glass',
    },
    proposerAssurance: 'hardware',
  });
  const state = {
    proposal: candidate,
    approvalRequest: publisherApproval(candidate, {
      decisionMode: 'human_confirmation',
    }),
  };
  const management = fakeService();
  const publisherTrust = fakePublisherTrust(state);
  const transport = createClusterPluginPackageManagementTransport({
    service: management.service,
    publisherTrust: publisherTrust.service,
    now: () => NOW,
  });
  await assert.rejects(
    transport.execute(
      publisherCommand('plugin-package.publisher-revocation.decide'),
      authentication().authority,
    ),
    ClusterPluginPackageManagementTransportAuthenticationError,
  );
  const result = await transport.execute(
    publisherCommand('plugin-package.publisher-revocation.decide'),
    authentication(principal({ assurance: 'hardware' })).authority,
  );
  assert.equal(result.operation, 'plugin-package.publisher-revocation.decide');
  assert.equal(management.calls.decide.length, 1);
});

test('authorizes publisher revocation inspection through its scoped service', async () => {
  const candidate = publisherProposal();
  const state = {
    proposal: candidate,
    approvalRequest: publisherApproval(candidate),
  };
  const management = fakeService();
  const publisherTrust = fakePublisherTrust(state);
  const transport = createClusterPluginPackageManagementTransport({
    service: management.service,
    publisherTrust: publisherTrust.service,
    now: () => NOW,
  });
  const result = await transport.execute(
    publisherCommand('plugin-package.publisher-revocation.inspect'),
    authentication().authority,
  );
  assert.equal(result.operation, 'plugin-package.publisher-revocation.inspect');
  assert.equal(publisherTrust.calls.inspect.length, 0);
  assert.equal(publisherTrust.calls.inspectAuthorized.length, 1);
});
