const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  PluginPackageManagementLiveEvidenceCollectionError,
  buildLiveEvidenceReport,
  collectDatabaseSnapshot,
  collectKubernetesSnapshot,
  collectOidcSnapshot,
  parseArguments,
  policyIsBounded,
  validateExercise,
} = require('../../scripts/ql3-plugin-package-management-live-evidence-collect.cjs');
const {
  validatePluginPackageManagementLiveEvidence,
} = require('../../scripts/ql3-plugin-package-management-live-evidence-audit.cjs');

function sha(character) {
  return `sha256:${character.repeat(64)}`;
}

function conditionReady() {
  return [{ type: 'Ready', status: 'True' }];
}

function node(name, uid, role) {
  return {
    metadata: {
      name,
      uid,
      labels: {
        'kubernetes.io/arch': 'arm64',
        ...(role === 'control-plane'
          ? { 'node-role.kubernetes.io/control-plane': '' }
          : {}),
      },
    },
    spec: {},
    status: { conditions: conditionReady() },
  };
}

function pod(name, uid, nodeName, imageId, containerName = 'management') {
  return {
    metadata: { name, uid },
    spec: {
      nodeName,
      serviceAccountName: 'ql3-plugin-package-management',
      automountServiceAccountToken: false,
    },
    status: {
      conditions: conditionReady(),
      containerStatuses: [
        {
          name: containerName,
          ready: true,
          imageID: `containerd://${imageId}`,
        },
      ],
    },
  };
}

function validExercise() {
  return {
    schemaVersion: 1,
    fixture: 'qinglong/plugin-package-management-live-exercise@v1',
    observedAt: '2026-07-25T12:00:00.000Z',
    identity: {
      issuer: 'https://login.example.com/',
      audience: 'qinglong3-package-management',
      requesterSubject: 'tenant-a/requester-42',
      reviewerSubject: 'tenant-a/reviewer-17',
      requesterAssurance: 'multi_factor',
      reviewerAssurance: 'hardware',
      keysetGenerations: [7, 8, 9],
    },
    ceremony: {
      proposalAuditEventId: '123e4567-e89b-42d3-a456-426614174000',
      approvalAuditEventId: '123e4567-e89b-42d3-a456-426614174001',
      decisionAuditEventId: '123e4567-e89b-42d3-a456-426614174002',
      proposeStatus: 200,
      proposeOperation: 'plugin-package.propose',
      selfDecisionStatus: 403,
      selfDecisionError: 'forbidden',
      reviewerDecisionStatus: 200,
      reviewerDecisionOperation: 'plugin-package.decide',
      inspectionStatus: 200,
      inspectionOperation: 'plugin-package.inspect',
    },
    isolation: {
      labelledClientOutcome: 'tls13_connected',
      unlabelledClientOutcome: 'timeout',
      wrongPortOutcome: 'timeout',
      kubernetesApiEgressOutcome: 'timeout',
      publicInternetEgressOutcome: 'timeout',
      postgresEgressOutcome: 'postgres_ready',
    },
    rotation: {
      overlapOldStatus: 200,
      newStatus: 200,
      revokedOldStatus: 401,
      revokedOldError: 'authentication_required',
      previousTlsSerial: '01:A2:03',
      currentTlsSerial: '09:B8:07',
      previousTlsSecretResourceVersion: '48192',
      currentTlsSecretResourceVersion: '49201',
      readinessSamples: ['before', 'overlap', 'revoked'].map((phase) => ({
        phase,
        replicas: 2,
        readyReplicas: 2,
        unavailableReplicas: 0,
        tlsProtocol: 'TLSv1.3',
      })),
    },
  };
}

function migrationIds() {
  return Array.from({ length: 25 }, (_, index) =>
    index === 24
      ? 'pg-0025-plugin-package-materialized-revisions'
      : `pg-${String(index + 1).padStart(4, '0')}-migration`,
  );
}

function databaseSnapshot() {
  return {
    currentRole: 'ql3_package_manager',
    serverVersionNumber: 180004,
    migrationIds: migrationIds(),
    controlCoreCapability: 24,
    tableCount: 38,
    auditRows: 3,
    ledger: {
      generation: 9,
      issuer: 'https://login.example.com/',
      audience: 'qinglong3-package-management',
      revokedKeyCount: 2,
    },
  };
}

function kubernetesSnapshot() {
  return {
    kubernetesVersion: 'v1.34.2',
    architecture: 'arm64',
    managementImageId: sha('1'),
    postgresImageId: sha('2'),
    cniName: 'cilium',
    cniVersion: '1.17.1',
    controlPlaneNodes: 3,
    workerNodes: 2,
    replicas: 2,
    readyReplicas: 2,
    podIdentitySha256: [sha('3'), sha('4')],
    nodeIdentitySha256: [sha('5'), sha('6')],
    serviceAccount: 'ql3-plugin-package-management',
    automountServiceAccountToken: false,
    boundedNetworkPolicy: true,
    managerSecretReadDenied: true,
    managerExecutorMutationDenied: true,
  };
}

function kubectlFixture() {
  const nodes = [
    node('cp-a', 'node-cp-a', 'control-plane'),
    node('cp-b', 'node-cp-b', 'control-plane'),
    node('cp-c', 'node-cp-c', 'control-plane'),
    node('worker-a', 'node-worker-a', 'worker'),
    node('worker-b', 'node-worker-b', 'worker'),
  ];
  const managementImage = sha('1');
  const postgresImage = sha('2');
  const values = new Map([
    [
      'version -o json',
      { clientVersion: {}, serverVersion: { gitVersion: 'v1.34.2' } },
    ],
    ['get nodes -o json', { items: nodes }],
    [
      '-n qinglong3-system get deployment ql3-plugin-package-management -o json',
      {
        spec: { replicas: 2 },
        status: { readyReplicas: 2, unavailableReplicas: 0 },
      },
    ],
    [
      '-n qinglong3-system get service ql3-plugin-package-management -o json',
      {
        spec: { ports: [{ port: 8443, protocol: 'TCP' }] },
      },
    ],
    [
      '-n qinglong3-system get serviceaccount ql3-plugin-package-management -o json',
      {
        metadata: { name: 'ql3-plugin-package-management' },
        automountServiceAccountToken: false,
      },
    ],
    [
      '-n qinglong3-system get networkpolicy ql3-plugin-package-management -o json',
      {
        spec: {
          podSelector: {
            matchLabels: {
              'app.kubernetes.io/name': 'ql3-plugin-package-management',
              'app.kubernetes.io/component': 'plugin-package-management',
            },
          },
          policyTypes: ['Ingress', 'Egress'],
          ingress: [
            {
              from: [
                {
                  podSelector: {
                    matchLabels: {
                      'qinglong.io/plugin-package-management-client': 'true',
                    },
                  },
                },
              ],
              ports: [{ port: 8443, protocol: 'TCP' }],
            },
          ],
          egress: [
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: {
                      'kubernetes.io/metadata.name': 'kube-system',
                    },
                  },
                  podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
                },
              ],
              ports: [
                { port: 53, protocol: 'UDP' },
                { port: 53, protocol: 'TCP' },
              ],
            },
            {
              to: [
                {
                  podSelector: {
                    matchLabels: { 'cnpg.io/cluster': 'ql3-postgres' },
                  },
                },
              ],
              ports: [{ port: 5432, protocol: 'TCP' }],
            },
          ],
        },
      },
    ],
    [
      '-n qinglong3-system get pods -l app.kubernetes.io/name=ql3-plugin-package-management,app.kubernetes.io/component=plugin-package-management -o json',
      {
        items: [
          pod('management-a', 'pod-a', 'worker-a', managementImage),
          pod('management-b', 'pod-b', 'worker-b', managementImage),
        ],
      },
    ],
    [
      '-n kube-system get daemonset cilium -o json',
      {
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: 'cilium-agent',
                  image: 'quay.io/cilium/cilium:v1.17.1',
                },
              ],
            },
          },
        },
        status: { desiredNumberScheduled: 5, numberReady: 5 },
      },
    ],
    [
      '-n qinglong3-system get pods -l cnpg.io/cluster=ql3-postgres -o json',
      {
        items: [
          pod('postgres-a', 'pg-a', 'worker-a', postgresImage, 'postgres'),
          pod('postgres-b', 'pg-b', 'worker-b', postgresImage, 'postgres'),
          pod('postgres-c', 'pg-c', 'worker-a', postgresImage, 'postgres'),
        ],
      },
    ],
  ]);
  return (args) => {
    const command = args.join(' ');
    if (command.startsWith('auth can-i ')) {
      return { status: 0, stdout: 'no\n', stderr: '' };
    }
    const value = values.get(command);
    assert.ok(value, `unexpected kubectl command: ${command}`);
    return { status: 0, stdout: JSON.stringify(value), stderr: '' };
  };
}

test('collects immutable Kubernetes topology, images, CNI and denied authority', () => {
  const result = collectKubernetesSnapshot(
    {
      cniDaemonSet: { namespace: 'kube-system', name: 'cilium' },
      cniContainer: 'cilium-agent',
      cniName: 'cilium',
    },
    kubectlFixture(),
  );
  assert.equal(result.kubernetesVersion, 'v1.34.2');
  assert.equal(result.controlPlaneNodes, 3);
  assert.equal(result.workerNodes, 2);
  assert.equal(result.managementImageId, sha('1'));
  assert.equal(result.postgresImageId, sha('2'));
  assert.equal(result.cniVersion, '1.17.1');
  assert.equal(result.managerSecretReadDenied, true);
  assert.equal(result.managerExecutorMutationDenied, true);
  assert.equal(new Set(result.podIdentitySha256).size, 2);
  assert.equal(new Set(result.nodeIdentitySha256).size, 2);
});

test('rejects empty selectors and any live NetworkPolicy widening', () => {
  assert.equal(
    policyIsBounded({
      spec: {
        podSelector: {
          matchLabels: {
            'app.kubernetes.io/name': 'ql3-plugin-package-management',
            'app.kubernetes.io/component': 'plugin-package-management',
          },
        },
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          {
            from: [{ podSelector: {} }],
            ports: [{ port: 8443, protocol: 'TCP' }],
          },
        ],
        egress: [
          {
            to: [{}],
            ports: [{ port: 443, protocol: 'TCP' }],
          },
        ],
      },
    }),
    false,
  );
});

test('queries PostgreSQL through the manager role and binds audit plus ledger', () => {
  const exercise = validateExercise(
    validExercise(),
    Date.parse('2026-07-25T12:01:00.000Z'),
  );
  let invocation;
  const result = collectDatabaseSnapshot(
    exercise,
    { pgService: 'ql3_evidence' },
    (args) => {
      invocation = args;
      return {
        status: 0,
        stdout: JSON.stringify(databaseSnapshot()),
        stderr: '',
      };
    },
  );
  assert.equal(result.currentRole, 'ql3_package_manager');
  assert.equal(result.auditRows, 3);
  assert.ok(invocation.includes('--dbname=service=ql3_evidence'));
  const sql = invocation.find((value) => value.startsWith('--command='));
  assert.match(sql, /plugin_package_identity_keyset_ledger/);
  assert.doesNotMatch(sql, /password|postgres(?:ql)?:\/\//i);
});

test('fetches and hashes the exercised external OIDC discovery and JWKS', async () => {
  const calls = [];
  const documents = new Map([
    [
      'https://login.example.com/.well-known/openid-configuration',
      JSON.stringify({
        issuer: 'https://login.example.com/',
        jwks_uri: 'https://login.example.com/keys',
      }),
    ],
    [
      'https://login.example.com/keys',
      JSON.stringify({ keys: [{ kid: 'production-key-1', kty: 'OKP' }] }),
    ],
  ]);
  const result = await collectOidcSnapshot(
    validExercise().identity,
    async (url, options) => {
      calls.push({ url, options });
      const body = Buffer.from(documents.get(url));
      return {
        status: 200,
        async arrayBuffer() {
          return body;
        },
      };
    },
  );
  assert.equal(calls.length, 2);
  assert.ok(result.discoveryDocumentSha256.startsWith('sha256:'));
  assert.ok(result.jwksSha256.startsWith('sha256:'));
  assert.notEqual(result.discoveryDocumentSha256, result.jwksSha256);
});

test('rejects OIDC SSRF targets and oversized streamed metadata before accepting evidence', async () => {
  let calls = 0;
  await assert.rejects(
    collectOidcSnapshot(
      {
        ...validExercise().identity,
        issuer: 'https://127.0.0.1/',
      },
      async () => {
        calls += 1;
      },
    ),
    PluginPackageManagementLiveEvidenceCollectionError,
  );
  assert.equal(calls, 0);

  await assert.rejects(
    collectOidcSnapshot(validExercise().identity, async () => ({
      status: 200,
      headers: { get: () => null },
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.alloc(1024 * 1024);
          yield Buffer.from('x');
        },
      },
    })),
    /exceeds 1 MiB/,
  );
});

test('derives a compatible report without leaking raw subjects, event IDs or TLS identities', () => {
  const exercise = validateExercise(
    validExercise(),
    Date.parse('2026-07-25T12:01:00.000Z'),
  );
  const report = buildLiveEvidenceReport({
    kubernetes: kubernetesSnapshot(),
    database: databaseSnapshot(),
    oidc: {
      discoveryDocumentSha256: sha('7'),
      jwksSha256: sha('8'),
    },
    exercise,
    observedAt: '2026-07-25T12:02:00.000Z',
  });
  assert.equal(
    validatePluginPackageManagementLiveEvidence(report).compatible,
    true,
  );
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /tenant-a\/requester-42/);
  assert.doesNotMatch(serialized, /123e4567-e89b-42d3-a456-426614174000/);
  assert.doesNotMatch(serialized, /01:A2:03/);
  assert.doesNotMatch(serialized, /48192/);
});

test('rejects claimed gates and non-private collection inputs', () => {
  const claimed = validExercise();
  claimed.gates = { passed: true };
  assert.throws(
    () => validateExercise(claimed, Date.parse('2026-07-25T12:01:00.000Z')),
    PluginPackageManagementLiveEvidenceCollectionError,
  );

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-live-evidence-collector-'),
  );
  try {
    const files = ['kubeconfig', 'exercise.json', 'pg-service.conf'];
    for (const name of files) {
      fs.writeFileSync(
        path.join(directory, name),
        name === 'exercise.json' ? '{}' : 'private',
        { mode: 0o600 },
      );
    }
    fs.chmodSync(path.join(directory, 'exercise.json'), 0o640);
    assert.throws(
      () =>
        parseArguments([
          `--kubeconfig=${path.join(directory, 'kubeconfig')}`,
          '--context=production',
          '--cni-daemonset=kube-system/cilium',
          '--cni-container=cilium-agent',
          '--cni-name=cilium',
          `--exercise=${path.join(directory, 'exercise.json')}`,
          `--pg-service-file=${path.join(directory, 'pg-service.conf')}`,
          '--pg-service=ql3_evidence',
          `--output=${path.join(directory, 'report.json')}`,
        ]),
      PluginPackageManagementLiveEvidenceCollectionError,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
