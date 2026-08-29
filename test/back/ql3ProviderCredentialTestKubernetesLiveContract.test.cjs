const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  aiFeatureMigrationJob,
  applyCloudNativePgResources,
  applyExecutorNetworkPolicy,
  applyFixturePostgresVolumes,
  actorJob,
  canI,
  deployProvider,
  executorJob,
  providerObservationKey,
  providerServerSource,
  readyProviderPodForGeneration,
  retryProviderEvidence,
  terminalJobSnapshot,
} = require('../../scripts/ql3-provider-credential-test-kubernetes-live-contract.cjs');
const {
  AI_MIGRATION_COUNT,
} = require('../../scripts/ql3-provider-credential-test-kubernetes-live-audit.cjs');
const {
  postgresModelInvocationMigrationDefinition,
} = require('../../packages/ql3-ai/dist/migration/modelInvocationMigration.js');

test('binds live evidence to the complete reviewed AI migration stream', () => {
  assert.equal(
    AI_MIGRATION_COUNT,
    postgresModelInvocationMigrationDefinition.migrations.length,
  );
});

function template() {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: 'ql3-provider-credential-test-executor',
      namespace: 'qinglong3-system',
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 60,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: { labels: {} },
        spec: {
          serviceAccountName: 'ql3-provider-credential-test-executor',
          automountServiceAccountToken: false,
          containers: [
            {
              name: 'executor',
              image: 'template',
              env: [],
              volumeMounts: [],
            },
          ],
          volumes: [
            {
              name: 'command',
              projected: {
                sources: [
                  { configMap: { name: 'command' } },
                  { configMap: { name: 'allowlist' } },
                ],
              },
            },
            {
              name: 'provider-secret',
              secret: { secretName: 'material', items: [] },
            },
          ],
        },
      },
    },
  };
}

test('renders an isolated one-shot executor without mutating its template', () => {
  const source = template();
  const job = executorJob({
    template: source,
    adminImage: 'ql3-admin:live',
    name: 'ql3-provider-test-one',
    commandConfigMap: 'command-one',
    allowlistConfigMap: 'allowlist-one',
    materialFileName: 'a'.repeat(64),
  });

  assert.equal(source.metadata.name, 'ql3-provider-credential-test-executor');
  assert.equal(source.spec.template.spec.volumes.length, 2);
  assert.equal(job.metadata.name, 'ql3-provider-test-one');
  assert.equal(job.spec.template.spec.containers[0].image, 'ql3-admin:live');
  assert.equal(
    job.spec.template.spec.containers[0].terminationMessagePolicy,
    'FallbackToLogsOnError',
  );
  assert.deepEqual(job.spec.template.spec.containers[0].env.at(-1), {
    name: 'NODE_EXTRA_CA_CERTS',
    value: '/var/run/secrets/qinglong3/provider-ca/ca.crt',
  });
  assert.deepEqual(
    job.spec.template.spec.volumes.find(
      (volume) => volume.name === 'provider-secret',
    ).secret.items,
    [{ key: 'a'.repeat(64), path: 'a'.repeat(64) }],
  );
  assert.equal(
    job.spec.template.spec.volumes.find(
      (volume) => volume.name === 'provider-ca',
    ).secret.secretName,
    'ql3-provider-live-tls',
  );
});

test('actor falls back to bounded logs when the termination file is empty', () => {
  const job = actorJob(
    'ql3-admin:live',
    'ql3-provider-test-bind',
    'ql3-provider-test-bind-command',
  );

  assert.equal(
    job.spec.template.spec.containers[0].terminationMessagePolicy,
    'FallbackToLogsOnError',
  );
  assert.deepEqual(job.spec.template.spec.containers[0].env[0], {
    name: 'NODE_PATH',
    value: '/opt/qinglong/node_modules',
  });
});

test('derives a separate AI feature migration Job from the base stream', () => {
  const source = template();
  source.spec.template.metadata.labels = {
    'app.kubernetes.io/name': 'ql3-cluster-migration',
    'app.kubernetes.io/component': 'database-migration',
  };
  source.spec.template.spec.containers[0].command = [
    'node',
    '/opt/qinglong/node_modules/@qinglong/cluster-postgres/dist/migration/migrationCli.js',
  ];

  const job = aiFeatureMigrationJob(source, 'ql3-admin:live');

  assert.equal(source.metadata.name, 'ql3-provider-credential-test-executor');
  assert.equal(job.metadata.name, 'ql3-ai-feature-migration');
  assert.equal(
    job.spec.template.metadata.labels['app.kubernetes.io/component'],
    'ai-feature-migration',
  );
  assert.deepEqual(job.spec.template.spec.containers[0].command, [
    'node',
    '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/modelInvocationMigrationCli.js',
  ]);
});

test('keeps provider egress closed until an exact Pod CIDR is supplied', () => {
  const applied = [];
  const fixture = { apply: (resource) => applied.push(resource) };

  applyExecutorNetworkPolicy(fixture, null);
  applyExecutorNetworkPolicy(fixture, '10.42.7.19');

  assert.equal(applied[0].spec.egress.length, 2);
  assert.equal(JSON.stringify(applied[0]).includes('ipBlock'), false);
  assert.deepEqual(applied[1].spec.egress.at(-1), {
    to: [{ ipBlock: { cidr: '10.42.7.19/32' } }],
    ports: [{ protocol: 'TCP', port: 8443 }],
  });
});

test('prebinds data and WAL volumes to all three fixture nodes', () => {
  const applied = [];
  const dockerCommands = [];
  const fixture = {
    nodes: ['server', 'agent-a', 'agent-b'],
    apply: (resource) => applied.push(resource),
    dockerRun: (command) => dockerCommands.push(command),
  };

  applyFixturePostgresVolumes(fixture);

  assert.equal(applied[0].kind, 'StorageClass');
  assert.equal(applied[0].provisioner, 'kubernetes.io/no-provisioner');
  assert.equal(applied.length, 7);
  assert.deepEqual(
    applied.slice(1).map((volume) => volume.spec.claimRef.name),
    [
      'ql3-postgres-1',
      'ql3-postgres-1-wal',
      'ql3-postgres-2',
      'ql3-postgres-2-wal',
      'ql3-postgres-3',
      'ql3-postgres-3-wal',
    ],
  );
  assert.deepEqual(
    applied
      .slice(1)
      .map(
        (volume) =>
          volume.spec.nodeAffinity.required.nodeSelectorTerms[0]
            .matchExpressions[0].values[0],
      ),
    ['agent-a', 'agent-a', 'agent-b', 'agent-b', 'server', 'server'],
  );
  assert.equal(dockerCommands.length, 18);
  assert.deepEqual(dockerCommands.slice(0, 3), [
    [
      'exec',
      'agent-a',
      'mkdir',
      '-p',
      '/var/lib/qinglong3-live/postgres-1-data',
    ],
    [
      'exec',
      'agent-a',
      'chown',
      '26:26',
      '/var/lib/qinglong3-live/postgres-1-data',
    ],
    [
      'exec',
      'agent-a',
      'chmod',
      '0700',
      '/var/lib/qinglong3-live/postgres-1-data',
    ],
  ]);
});

test('patches only fixture storage classes in the reviewed CNPG resources', () => {
  const applied = [];
  const fixture = {
    kubectl() {
      return {
        stdout: `apiVersion: postgresql.cnpg.io/v1\nkind: Cluster\nmetadata:\n  name: ql3-postgres\nspec:\n  storage:\n    size: 20Gi\n  walStorage:\n    size: 5Gi\n---\napiVersion: postgresql.cnpg.io/v1\nkind: Database\nmetadata:\n  name: ql3-postgres-qinglong\n`,
      };
    },
    apply: (resource) => applied.push(resource),
  };

  applyCloudNativePgResources(fixture);

  assert.equal(applied.length, 2);
  assert.equal(
    applied[0].spec.storage.storageClass,
    'ql3-provider-test-static',
  );
  assert.equal(
    applied[0].spec.walStorage.storageClass,
    'ql3-provider-test-static',
  );
  assert.equal(applied[1].kind, 'Database');
});

test('treats kubectl auth can-i exit one as an explicit denial', () => {
  const calls = [];
  const fixture = {
    kubectl(args, options) {
      calls.push({ args, options });
      return { status: 1, stdout: 'no', stderr: '' };
    },
  };

  assert.equal(canI(fixture, 'get', 'secrets'), 'no');
  assert.equal(calls[0].options.allowFailure, true);
  assert.throws(
    () =>
      canI(
        {
          kubectl: () => ({ status: 2, stdout: '', stderr: 'unavailable' }),
        },
        'get',
        'secrets',
      ),
    /unexpected kubectl auth can-i response/,
  );
});

test('captures a terminal Pod before a completed Job can recycle it', async () => {
  let podVisible = true;
  const fixture = {
    kubectlJson(args) {
      if (args.includes('pods')) {
        assert.equal(podVisible, true);
        return {
          items: [
            {
              metadata: { name: 'probe-pod' },
              status: {
                containerStatuses: [{ state: { terminated: { exitCode: 0 } } }],
              },
            },
          ],
        };
      }
      podVisible = false;
      return {
        status: {
          conditions: [{ type: 'Complete', status: 'True' }],
        },
      };
    },
  };

  const snapshot = await terminalJobSnapshot(fixture, 'probe', 1_000);
  assert.equal(snapshot.pod.metadata.name, 'probe-pod');
  assert.equal(snapshot.terminal.complete, true);
  assert.equal(snapshot.terminal.failed, false);
});

test('reloads the local admin image after node recovery before convergence', () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      '../../scripts/ql3-provider-credential-test-kubernetes-live-contract.cjs',
    ),
    'utf8',
  );
  const nodeRecovery = source.indexOf(
    "'three recovered CloudNativePG instances'",
  );
  const imageReload = source.indexOf("'provider-test-admin-post-failover.tar'");
  const postFailoverConvergence = source.indexOf("label: 'post-failover'");

  assert.ok(nodeRecovery >= 0);
  assert.ok(imageReload > nodeRecovery);
  assert.ok(postFailoverConvergence > imageReload);
});

test('reads provider evidence from the exact ready Pod with trusted TLS SNI', () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      '../../scripts/ql3-provider-credential-test-kubernetes-live-contract.cjs',
    ),
    'utf8',
  );

  assert.match(source, /currentPod = await readyProviderPodForGeneration/);
  assert.match(source, /providerPodIp: currentPod\.status\.podIP/);
  assert.match(source, /host:process\.argv\[1\]/);
  assert.match(source, /servername:process\.argv\[3\]/);
  assert.match(
    source,
    /ca:fs\.readFileSync\('\/var\/run\/provider-ca\/ca\.crt'\)/,
  );
  assert.doesNotMatch(
    source,
    /fetch\('https:\/\/'\+process\.argv\[1\].*\/evidence/,
  );
});

test('starts a fresh provider request baseline after a container restart', () => {
  const pod = {
    metadata: { uid: 'provider-uid' },
    status: {
      containerStatuses: [{ name: 'provider', restartCount: 0 }],
    },
  };

  assert.equal(providerObservationKey(pod), 'provider-uid:0');
  pod.status.containerStatuses[0].restartCount = 1;
  assert.equal(providerObservationKey(pod), 'provider-uid:1');
});

test('retries only bounded transient provider evidence failures', async () => {
  let attempts = 0;
  const evidence = await retryProviderEvidence(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('{"code":"ECONNREFUSED"}');
      return { requestCount: 1 };
    },
    { pause: async () => {} },
  );
  assert.deepEqual(evidence, { requestCount: 1 });
  assert.equal(attempts, 3);
  await assert.rejects(
    retryProviderEvidence(
      async () => {
        throw new Error('invalid evidence schema');
      },
      { pause: async () => {} },
    ),
    /invalid evidence schema/,
  );

  attempts = 0;
  await assert.rejects(
    retryProviderEvidence(
      async () => {
        attempts += 1;
        throw new Error('{"code":"ECONNREFUSED"}');
      },
      { maxAttempts: 8, pause: async () => {} },
    ),
    /ECONNREFUSED/,
  );
  assert.equal(attempts, 8);

  attempts = 0;
  let elapsedMs = 0;
  await assert.rejects(
    retryProviderEvidence(
      async () => {
        attempts += 1;
        throw new Error('{"code":"ETIMEDOUT"}');
      },
      {
        intervalMs: 1_000,
        maxAttempts: 100,
        now: () => elapsedMs,
        pause: async (delayMs) => {
          elapsedMs += delayMs;
        },
        timeoutMs: 3_000,
      },
    ),
    /ETIMEDOUT/,
  );
  assert.equal(attempts, 4);
});

test('provider fixture logs only generation and authorization decision', () => {
  const source = providerServerSource();
  assert.match(source, /event:'provider_request',generation,allowed/);
  assert.doesNotMatch(source, /JSON\.stringify\([^)]*authorization/);
  assert.doesNotMatch(source, /process\.stdout\.write\([^)]*expected/);
});

test('provider fixture uses headless DNS for exact Pod CIDR policy', async () => {
  const applied = [];
  const fixture = {
    apply: (resource) => applied.push(resource),
    kubectl() {},
    kubectlJson() {
      return {
        items: [
          {
            metadata: {
              uid: 'provider-uid',
              annotations: {
                'qinglong.io/provider-generation': '1-initial',
              },
            },
            status: {
              podIP: '10.42.7.19',
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
        ],
      };
    },
  };

  await deployProvider(fixture, 'ql3-admin:live', 1, 'secret', 'initial');

  const service = applied.find((resource) => resource.kind === 'Service');
  assert.equal(service.spec.clusterIP, 'None');
});

test('binds a rollout to the exact ready provider generation', async () => {
  const fixture = {
    kubectlJson() {
      return {
        items: [
          {
            metadata: {
              uid: 'old-provider',
              annotations: {
                'qinglong.io/provider-generation': '1-initial',
              },
            },
            status: {
              podIP: '10.42.7.18',
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
          {
            metadata: {
              uid: 'current-provider',
              annotations: {
                'qinglong.io/provider-generation': '2-material-rotation',
              },
            },
            status: {
              podIP: '10.42.7.19',
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
        ],
      };
    },
  };

  const provider = await readyProviderPodForGeneration(
    fixture,
    '2-material-rotation',
    1_000,
  );

  assert.equal(provider.metadata.uid, 'current-provider');
  assert.equal(provider.status.podIP, '10.42.7.19');
});

test('actor writes bounded failure diagnostics to its termination message', () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      '../../scripts/ql3-provider-credential-test-kubernetes-live-actor.cjs',
    ),
    'utf8',
  );

  assert.match(source, /fs\.writeFileSync\('\/dev\/termination-log', failure/);
  assert.match(source, /error\.message\.slice\(0, 1_024\)/);
  assert.doesNotMatch(source, /stack:/);
});
