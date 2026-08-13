#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const k8s = require('@kubernetes/client-node');
const {
  PluginPackageActivationConflictError,
  PluginPackageActivationUnavailableError,
  PLUGIN_PACKAGE_ACTIVATION_INTENT_SCHEMA,
} = require('@qinglong/runtime-core/plugin-package-activation');
const {
  createPluginPackageResourceGeneration,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const {
  createPluginPackageSecretBindingTarget,
} = require('@qinglong/runtime-core/plugin-package-secret-binding');
const {
  createPluginPackageSecretBindingTransitionPlan,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-transition-plan');
const {
  createPluginPackageSecretBindingFromTransitionPlan,
  createPluginPackageSecretBindingTransitionReceipt,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-transition-receipt');
const {
  secretProjectionFileName,
} = require('@qinglong/runtime-core/secret-projection');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  PluginPackageKubernetesActivationPublisher,
  pluginPackageKubernetesProjectedSecretWorkloadVolume,
} = require('@qinglong/cluster-admin/plugin-package-kubernetes-activation');

const TOKEN_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const RESULT_SCHEMA = 'qinglong/plugin-package-kubernetes-live-actor-result@v1';
const NAMESPACE = process.env.QL3_LIVE_NAMESPACE;
const ACTOR = process.env.QL3_LIVE_ACTOR;
const PEER = ACTOR === 'a' ? 'b' : ACTOR === 'b' ? 'a' : null;
const INITIAL_LOCK_DIGEST = 'a'.repeat(64);
const CANDIDATES = Object.freeze({
  a: Object.freeze({
    installationId: 'install-live-a',
    lockDigest: '1'.repeat(64),
    stageReceiptDigest: '2'.repeat(64),
    stageEvidenceDigest: '3'.repeat(64),
    contentDigest: '4'.repeat(64),
    intentDigest: '5'.repeat(64),
  }),
  b: Object.freeze({
    installationId: 'install-live-b',
    lockDigest: '6'.repeat(64),
    stageReceiptDigest: '7'.repeat(64),
    stageEvidenceDigest: '8'.repeat(64),
    contentDigest: '9'.repeat(64),
    intentDigest: '0'.repeat(64),
  }),
  c: Object.freeze({
    installationId: 'install-live-revoke',
    lockDigest: 'f'.repeat(64),
    stageReceiptDigest: 'a'.repeat(64),
    stageEvidenceDigest: 'b'.repeat(64),
    contentDigest: 'c'.repeat(64),
    intentDigest: 'd'.repeat(64),
  }),
});

function fail(message) {
  throw new Error(message);
}

function apiStatus(error) {
  if (!error || typeof error !== 'object') return null;
  if ('code' in error && typeof error.code === 'number') return error.code;
  if (
    'response' in error &&
    error.response &&
    typeof error.response === 'object' &&
    'statusCode' in error.response &&
    typeof error.response.statusCode === 'number'
  ) {
    return error.response.statusCode;
  }
  return null;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, inspect) {
  const deadline = Date.now() + 60_000;
  let lastFact = 'not observed';
  while (Date.now() < deadline) {
    try {
      const result = await inspect();
      if (result?.ready) return result.value;
      if (result?.fact) lastFact = result.fact;
    } catch (error) {
      lastFact = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  fail(`${description} timed out: ${lastFact}`);
}

function activationIntent(overrides = {}) {
  const lockDigest = overrides.lockDigest ?? INITIAL_LOCK_DIGEST;
  const installationId = overrides.installationId ?? 'install-live-initial';
  const targetGeneration = overrides.targetGeneration ?? 1;
  const previousActiveLockDigest = overrides.previousActiveLockDigest ?? null;
  const contentDigest = overrides.contentDigest ?? 'd'.repeat(64);
  return Object.freeze({
    schema: PLUGIN_PACKAGE_ACTIVATION_INTENT_SCHEMA,
    installationId,
    projectId: 'default',
    packageName: 'live-cas-package',
    lockDigest,
    targetGeneration,
    previousActiveLockDigest,
    stageRef: `cluster-stage:${lockDigest}`,
    stageReceiptDigest: overrides.stageReceiptDigest ?? 'b'.repeat(64),
    stageEvidenceDigest: overrides.stageEvidenceDigest ?? 'c'.repeat(64),
    contentDigest,
    resourceGeneration: createPluginPackageResourceGeneration({
      installationId,
      projectId: 'default',
      packageName: 'live-cas-package',
      lockDigest,
      generation: targetGeneration,
      previousActiveLockDigest,
      contentDigest,
      contents: {
        tasks: ['tasks/live.yaml'],
        workflows: [],
        prompts: [],
        tools: [],
      },
    }),
    intentDigest: overrides.intentDigest ?? 'e'.repeat(64),
  });
}

function manifest(version, secrets) {
  return Object.freeze({
    apiVersion: 'qinglong.io/v1alpha1',
    kind: 'Package',
    metadata: Object.freeze({
      name: 'live-cas-package',
      displayName: 'Live CAS Package',
      version,
      description: 'Real Kubernetes Secret projection CAS gate',
      license: 'Apache-2.0',
    }),
    spec: Object.freeze({
      compatibility: Object.freeze({
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: Object.freeze(['arm64']),
        deploymentProfiles: Object.freeze(['cluster-control']),
      }),
      runtimes: Object.freeze([]),
      resources: Object.freeze({
        memory: Object.freeze({ recommended: '16Mi' }),
        disk: Object.freeze({ install: '4Mi', working: '16Mi' }),
      }),
      permissions: Object.freeze({
        network: Object.freeze({ allowedHosts: Object.freeze([]) }),
        secrets: Object.freeze(secrets),
        tools: Object.freeze(secrets.length === 0 ? [] : ['secret.use']),
      }),
      contents: Object.freeze({
        tasks: Object.freeze(['tasks/live.yaml']),
        workflows: Object.freeze([]),
        prompts: Object.freeze([]),
        tools: Object.freeze([]),
      }),
    }),
  });
}

function transitionEvidence(initial, candidate, actor = ACTOR) {
  const secretRef = createSecretRef({
    projectId: 'default',
    name: `live-token-${actor}`,
    version: 2,
  });
  const previousManifest = manifest('1.0.0', []);
  const nextManifest = manifest('2.0.0', [
    Object.freeze({ name: 'TOKEN', required: true }),
  ]);
  const plan = createPluginPackageSecretBindingTransitionPlan({
    previousTarget: createPluginPackageSecretBindingTarget(
      initial.resourceGeneration,
      previousManifest,
    ),
    previousBinding: null,
    previousAttemptGeneration: 1,
    nextGeneration: candidate.resourceGeneration,
    nextManifest,
    assignments: [Object.freeze({ name: 'TOKEN', secretRef })],
    plannedAtMs: 100,
  });
  const binding = createPluginPackageSecretBindingFromTransitionPlan(
    plan,
    'approved-action-execution',
    candidate.stageEvidenceDigest,
    200,
  );
  const receipt = createPluginPackageSecretBindingTransitionReceipt({
    transitionPlan: plan,
    authority: Object.freeze({
      kind: 'approved-action-execution',
      evidenceDigest: candidate.stageEvidenceDigest,
    }),
    binding,
    committedAtMs: 200,
  });
  return Object.freeze({ secretRef, binding, receipt });
}

function revokeEvidence(activeCandidate, activeTransition, candidate) {
  const plan = createPluginPackageSecretBindingTransitionPlan({
    previousTarget: createPluginPackageSecretBindingTarget(
      activeCandidate.resourceGeneration,
      manifest('2.0.0', [
        Object.freeze({ name: 'TOKEN', required: true }),
      ]),
    ),
    previousBinding: activeTransition.binding,
    previousAttemptGeneration: 2,
    nextGeneration: candidate.resourceGeneration,
    nextManifest: manifest('3.0.0', []),
    assignments: [],
    plannedAtMs: 300,
  });
  const receipt = createPluginPackageSecretBindingTransitionReceipt({
    transitionPlan: plan,
    authority: Object.freeze({
      kind: 'approved-action-execution',
      evidenceDigest: candidate.stageEvidenceDigest,
    }),
    binding: null,
    committedAtMs: 400,
  });
  return Object.freeze({ binding: null, receipt });
}

function activeTargetName() {
  return (
    'ql3p-' +
    require('node:crypto')
      .createHash('sha256')
      .update(
        Buffer.from('qinglong/plugin-package-kubernetes-target@v1\0', 'utf8'),
      )
      .update(
        require('node:crypto')
          .createHash('sha256')
          .update('qinglong/plugin-package-kubernetes-cluster@v1\0', 'utf8')
          .update('ql3-plugin-package-live-cluster', 'utf8')
          .digest('hex'),
        'utf8',
      )
      .update('\0', 'utf8')
      .update(NAMESPACE, 'utf8')
      .update('\0default\0live-cas-package', 'utf8')
      .digest('hex')
      .slice(0, 52)
  );
}

function exactEvidence(intent) {
  return Object.freeze({
    lockDigest: intent.lockDigest,
    stageRef: intent.stageRef,
    stageReceiptDigest: intent.stageReceiptDigest,
    stageEvidenceDigest: intent.stageEvidenceDigest,
    contentDigest: intent.contentDigest,
  });
}

async function expectForbidden(operation) {
  try {
    await operation();
  } catch (error) {
    assert.equal(apiStatus(error), 403);
    return 403;
  }
  fail('Kubernetes RBAC unexpectedly allowed a forbidden request');
}

function readyConfigMap(name) {
  return Object.freeze({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    immutable: false,
    metadata: Object.freeze({
      name,
      namespace: NAMESPACE,
      labels: Object.freeze({
        'app.kubernetes.io/managed-by': 'qinglong3-live-gate',
        'qinglong.io/live-gate-role': 'cas-barrier',
      }),
    }),
    data: Object.freeze({ actor: ACTOR }),
  });
}

async function main() {
  if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(NAMESPACE ?? '')) {
    fail('QL3_LIVE_NAMESPACE is invalid');
  }
  if (ACTOR !== 'a' && ACTOR !== 'b' && ACTOR !== 'c') {
    fail('QL3_LIVE_ACTOR must be a, b or c');
  }
  const token = fs.readFileSync(TOKEN_FILE);
  assert.ok(token.length >= 32 && token.length <= 16 * 1024);
  token.fill(0);

  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromCluster();
  const rawApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
  let createCalls = 0;
  let replaceCalls = 0;
  let injectedCreateResponseLoss = ACTOR === 'a';
  let replaceResourceVersion = null;

  const activationApi = {
    readNamespacedConfigMap(request) {
      return rawApi.readNamespacedConfigMap(request);
    },
    async createNamespacedConfigMap(request) {
      createCalls += 1;
      const created = await rawApi.createNamespacedConfigMap(request);
      if (injectedCreateResponseLoss) {
        injectedCreateResponseLoss = false;
        throw new Error(
          'injected response loss after Kubernetes API-confirmed create',
        );
      }
      return created;
    },
    async replaceNamespacedConfigMap(request) {
      replaceCalls += 1;
      replaceResourceVersion = request.body.metadata.resourceVersion;
      assert.match(replaceResourceVersion ?? '', /^[1-9][0-9]*$/);
      if (PEER !== null) {
        const ownReadyName = `ql3-live-cas-ready-${ACTOR}`;
        const peerReadyName = `ql3-live-cas-ready-${PEER}`;
        await rawApi.createNamespacedConfigMap({
          namespace: NAMESPACE,
          body: readyConfigMap(ownReadyName),
          fieldManager: 'qinglong-plugin-package-live-gate',
          fieldValidation: 'Strict',
        });
        await waitFor(
          `peer CAS barrier ConfigMap/${peerReadyName}`,
          async () => {
            try {
              const peer = await rawApi.readNamespacedConfigMap({
                namespace: NAMESPACE,
                name: peerReadyName,
              });
              return {
                ready: peer.data?.actor === PEER,
                fact: `peer actor=${String(peer.data?.actor)}`,
              };
            } catch (error) {
              if (apiStatus(error) === 404) return { ready: false };
              throw error;
            }
          },
        );
      }
      return rawApi.replaceNamespacedConfigMap(request);
    },
  };

  let nowCalls = 0;
  const createPublisher = (secretProjection) =>
    new PluginPackageKubernetesActivationPublisher(
      activationApi,
      { verify: async (intent) => exactEvidence(intent) },
      {
        clusterIdentity: 'ql3-plugin-package-live-cluster',
        namespace: NAMESPACE,
        now() {
          nowCalls += 1;
          return (ACTOR === 'a' ? 1_000 : 2_000) + nowCalls;
        },
        ...(secretProjection === undefined ? {} : { secretProjection }),
      },
    );

  if (ACTOR === 'c') {
    const initial = activationIntent();
    const activeConfigMap = await rawApi.readNamespacedConfigMap({
      namespace: NAMESPACE,
      name: activeTargetName(),
    });
    const activePointer = JSON.parse(activeConfigMap.data?.['active.json']);
    const winnerActor = ['a', 'b'].find(
      (actor) => CANDIDATES[actor].lockDigest === activePointer.intent.lockDigest,
    );
    assert.ok(winnerActor);
    const activeCandidate = activationIntent({
      ...CANDIDATES[winnerActor],
      targetGeneration: 2,
      previousActiveLockDigest: INITIAL_LOCK_DIGEST,
    });
    const activeTransition = transitionEvidence(
      initial,
      activeCandidate,
      winnerActor,
    );
    assert.equal(
      activePointer.secretProjection.bindingDigest,
      activeTransition.binding.bindingDigest,
    );
    const candidate = activationIntent({
      ...CANDIDATES.c,
      targetGeneration: 3,
      previousActiveLockDigest: activeCandidate.lockDigest,
    });
    const transition = revokeEvidence(
      activeCandidate,
      activeTransition,
      candidate,
    );
    const publisher = createPublisher({
      sourceSecretName: 'ql3-cluster-plugin-package-values',
      bindings: { find: async () => null },
      transitions: { find: async () => transition.receipt },
    });
    const receipt = await publisher.publish(candidate);
    assert.equal(replaceCalls, 1);
    const active = await publisher.findActiveDeployment(
      'default',
      'live-cas-package',
    );
    assert.ok(active);
    assert.equal(active.resourceGeneration.lockDigest, candidate.lockDigest);
    assert.equal(active.secretProjection.items.length, 0);
    assert.equal(
      pluginPackageKubernetesProjectedSecretWorkloadVolume(
        active.secretProjection,
      ),
      null,
    );
    const rbac = Object.freeze({
      listConfigMaps: await expectForbidden(() =>
        rawApi.listNamespacedConfigMap({ namespace: NAMESPACE }),
      ),
      deleteConfigMap: await expectForbidden(() =>
        rawApi.deleteNamespacedConfigMap({
          namespace: NAMESPACE,
          name: activeTargetName(),
        }),
      ),
      readSecret: await expectForbidden(() =>
        rawApi.readNamespacedSecret({
          namespace: NAMESPACE,
          name: 'forbidden-secret',
        }),
      ),
      crossNamespaceRead: await expectForbidden(() =>
        rawApi.readNamespacedConfigMap({
          namespace: 'default',
          name: 'kube-root-ca.crt',
        }),
      ),
    });
    const result = JSON.stringify({
      schema: RESULT_SCHEMA,
      actor: ACTOR,
      mode: 'revoke',
      serviceAccountTokenMounted: true,
      responseLoss: null,
      cas: {
        status: 'fulfilled',
        receipt,
        attemptedResourceVersion: replaceResourceVersion,
        replaceCalls,
      },
      final: {
        resourceVersion: activeConfigMap.metadata.resourceVersion,
        lockDigest: candidate.lockDigest,
        generation: receipt.generation,
        pointerSchema: 'qinglong/plugin-package-kubernetes-active-pointer@v3',
        projectionDigest: active.secretProjection.projectionDigest,
        transitionReceiptDigest:
          active.secretProjection.transitionReceiptDigest,
        projectionItemCount: active.secretProjection.items.length,
        projectedWorkloadVolume: false,
      },
      rbac,
    });
    fs.writeFileSync('/dev/termination-log', result, {
      encoding: 'utf8',
      flag: 'w',
    });
    process.stdout.write(`${result}\n`);
    return;
  }

  const initial = activationIntent();
  const initialPublisher = createPublisher();
  let responseLoss = null;
  if (ACTOR === 'a') {
    await assert.rejects(
      initialPublisher.publish(initial),
      PluginPackageActivationUnavailableError,
    );
    const observation = await initialPublisher.inspect(initial);
    assert.equal(observation.status, 'published');
    const replay = await initialPublisher.publish(initial);
    assert.deepEqual(replay, observation.receipt);
    assert.equal(createCalls, 1);
    assert.equal(nowCalls, 1);
    responseLoss = Object.freeze({
      injectedAfterApiConfirmedCreate: true,
      firstCallFailedClosed: true,
      durableInspectPublished: true,
      replayReturnedExactReceipt: true,
      createCalls,
      nowCalls,
    });
  } else {
    await waitFor('initial active pointer', async () => {
      const observation = await initialPublisher.inspect(initial);
      return {
        ready: observation.status === 'published',
        fact: observation.status,
      };
    });
    assert.equal(createCalls, 0);
  }

  const candidate = activationIntent({
    ...CANDIDATES[ACTOR],
    targetGeneration: 2,
    previousActiveLockDigest: INITIAL_LOCK_DIGEST,
  });
  const transition = transitionEvidence(initial, candidate);
  const publisher = createPublisher({
    sourceSecretName: 'ql3-cluster-plugin-package-values',
    bindings: { find: async () => transition.binding },
    transitions: { find: async () => transition.receipt },
  });
  let outcome;
  try {
    const receipt = await publisher.publish(candidate);
    outcome = Object.freeze({
      status: 'fulfilled',
      receipt,
    });
  } catch (error) {
    assert.ok(error instanceof PluginPackageActivationConflictError);
    outcome = Object.freeze({ status: 'conflict' });
  }
  assert.equal(replaceCalls, 1);

  const targetName = activeTargetName();
  const finalConfigMap = await rawApi.readNamespacedConfigMap({
    namespace: NAMESPACE,
    name: targetName,
  });
  const finalPointer = JSON.parse(finalConfigMap.data['active.json']);
  assert.equal(finalPointer.schema.endsWith('@v3'), true);
  assert.equal(finalPointer.secretProjection.defaultMode, 0o440);
  assert.match(
    finalPointer.secretProjection.transitionReceiptDigest,
    /^[0-9a-f]{64}$/,
  );
  const projectionPath = secretProjectionFileName(transition.secretRef);
  const winnerUsesThisActor =
    finalPointer.intent.lockDigest === candidate.lockDigest;
  if (winnerUsesThisActor) {
    assert.deepEqual(finalPointer.secretProjection.items, [
      { key: projectionPath, path: projectionPath },
    ]);
  }
  const workloadVolume = pluginPackageKubernetesProjectedSecretWorkloadVolume(
    finalPointer.secretProjection,
  );
  assert.equal(workloadVolume.volume.secret.optional, false);
  assert.equal(workloadVolume.volume.secret.defaultMode, 0o440);

  const rbac = Object.freeze({
    listConfigMaps: await expectForbidden(() =>
      rawApi.listNamespacedConfigMap({ namespace: NAMESPACE }),
    ),
    deleteConfigMap: await expectForbidden(() =>
      rawApi.deleteNamespacedConfigMap({
        namespace: NAMESPACE,
        name: targetName,
      }),
    ),
    readSecret: await expectForbidden(() =>
      rawApi.readNamespacedSecret({
        namespace: NAMESPACE,
        name: 'forbidden-secret',
      }),
    ),
    crossNamespaceRead: await expectForbidden(() =>
      rawApi.readNamespacedConfigMap({
        namespace: 'default',
        name: 'kube-root-ca.crt',
      }),
    ),
  });

  const result = JSON.stringify({
    schema: RESULT_SCHEMA,
    actor: ACTOR,
    mode: 'rotate',
    serviceAccountTokenMounted: true,
    responseLoss,
    cas: {
      ...outcome,
      attemptedResourceVersion: replaceResourceVersion,
      replaceCalls,
    },
    final: {
      resourceVersion: finalConfigMap.metadata.resourceVersion,
      lockDigest: finalPointer.intent.lockDigest,
      generation: finalPointer.receipt.generation,
      pointerSchema: finalPointer.schema,
      projectionDigest: finalPointer.secretProjection.projectionDigest,
      transitionReceiptDigest:
        finalPointer.secretProjection.transitionReceiptDigest,
      projectionItemCount: finalPointer.secretProjection.items.length,
      projectedWorkloadVolume: workloadVolume !== null,
    },
    rbac,
  });
  fs.writeFileSync('/dev/termination-log', result, {
    encoding: 'utf8',
    flag: 'w',
  });
  process.stdout.write(`${result}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      schema: RESULT_SCHEMA,
      actor: ACTOR ?? null,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
