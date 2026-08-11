const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { createServer } = require('node:https');
const { connect: connectTcp } = require('node:net');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

const {
  ClusterPluginPackageManagementKubernetesClientConfigurationError,
  ClusterPluginPackageManagementKubernetesClientTunnelError,
  executeClusterPluginPackageManagementKubernetesClient,
  openClusterPluginPackageManagementPortForward,
} = require(
  '@qinglong/cluster-admin/plugin-package-management-kubernetes-client'
);
const {
  ClusterPluginPackageManagementClientRemoteError,
} = require('@qinglong/cluster-admin/plugin-package-management-client');

const SERVICE_HOST =
  'ql3-plugin-package-management.qinglong3-system.svc';
const SERVICE_CERT = resolve(
  __dirname,
  'fixtures/management-service-cert.pem',
);
const SERVICE_KEY = resolve(
  __dirname,
  'fixtures/management-service-key.pem',
);
const KUBERNETES_CLIENT_CERT = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/client-cert.pem',
);
const KUBERNETES_CLIENT_KEY = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/client-key.pem',
);
const CLIENT_CLI = resolve(
  __dirname,
  '../dist/plugin-package/management/pluginPackageManagementKubernetesClientCli.js',
);
const ASSERTION = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.c2ln';
const KUBERNETES_TOKEN = 'kube-token-secret';

function privateWrite(path, value) {
  writeFileSync(
    path,
    typeof value === 'string' ? value : JSON.stringify(value),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

function inspectCommand() {
  return {
    schemaVersion: 1,
    operation: 'plugin-package.inspect',
    request: {
      actionRef: 'package:cluster-monitor:1',
      approvalRequestId: 'approval-cluster-monitor-1',
      inspectionId: 'inspection-cluster-monitor-1',
    },
  };
}

function kubeconfig(overrides = {}) {
  const certificateAuthorityData = readFileSync(SERVICE_CERT).toString(
    'base64',
  );
  const cluster = {
    server: 'https://kubernetes.example.test:6443',
    'certificate-authority-data': certificateAuthorityData,
    ...(overrides.cluster ?? {}),
  };
  const user = {
    token: KUBERNETES_TOKEN,
    ...(overrides.user ?? {}),
  };
  return {
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name: 'production', cluster }],
    users: [{ name: 'ql3-operator', user }],
    contexts: [
      {
        name: 'production',
        context: {
          cluster: 'production',
          user: 'ql3-operator',
          namespace: 'qinglong3-system',
        },
      },
    ],
    'current-context': overrides.currentContext ?? 'production',
  };
}

function createClientFiles(kubeconfigValue = kubeconfig()) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'ql3-kubernetes-client-')),
  );
  const configFile = join(directory, 'client.json');
  const commandFile = join(directory, 'command.json');
  const assertionFile = join(directory, 'assertion.jwt');
  const kubeconfigFile = join(directory, 'kubeconfig.json');
  const kubernetesFile = join(directory, 'kubernetes.json');
  privateWrite(configFile, {
    schemaVersion: 1,
    endpoint: `https://${SERVICE_HOST}:8443/api/v3/plugin-packages/management`,
    servername: SERVICE_HOST,
    caFile: SERVICE_CERT,
    requestTimeoutMs: 2_000,
  });
  privateWrite(commandFile, inspectCommand());
  privateWrite(assertionFile, ASSERTION);
  privateWrite(kubeconfigFile, kubeconfigValue);
  privateWrite(kubernetesFile, {
    schemaVersion: 1,
    kubeconfigFile,
    context: 'production',
    namespace: 'qinglong3-system',
    apiTimeoutMs: 2_000,
  });
  return {
    directory,
    paths: {
      configFile,
      commandFile,
      assertionFile,
      kubernetesFile,
    },
    kubeconfigFile,
  };
}

function readyPod(name, overrides = {}) {
  return {
    metadata: {
      name,
      namespace: 'qinglong3-system',
      uid: `uid-${name}`,
      labels: {
        'app.kubernetes.io/name': 'ql3-plugin-package-management',
        'app.kubernetes.io/component': 'plugin-package-management',
      },
      ...(overrides.metadata ?? {}),
    },
    spec: {
      serviceAccountName: 'ql3-plugin-package-management',
      automountServiceAccountToken: false,
      containers: [{ name: 'management' }],
      ...(overrides.spec ?? {}),
    },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [{ name: 'management', ready: true }],
      ...(overrides.status ?? {}),
    },
  };
}

async function startServer(handler) {
  const server = createServer(
    {
      key: readFileSync(SERVICE_KEY),
      cert: readFileSync(SERVICE_CERT),
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    },
    handler,
  );
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

function sendJson(response, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
  });
  response.end(body);
}

test('uses one ready Pod tunnel and preserves end-to-end TLS 1.3 hostname verification', async () => {
  const requests = [];
  const server = await startServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('end', () => {
      requests.push({
        authorization: request.headers.authorization,
        protocol: request.socket.getProtocol(),
        servername: request.socket.servername,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      sendJson(response, {
        schemaVersion: 1,
        requestId: 'request-kubernetes-client-1',
        result: {
          schemaVersion: 1,
          operation: 'plugin-package.inspect',
          proposal: null,
          approval: null,
        },
      });
    });
  });
  const files = createClientFiles();
  const calls = { lists: [], tunnels: [], closes: 0 };
  try {
    const result =
      await executeClusterPluginPackageManagementKubernetesClient(
        files.paths,
        {
          createRuntime() {
            return {
              pods: {
                async listNamespacedPod(request) {
                  calls.lists.push(request);
                  return {
                    items: [
                      readyPod(
                        'ql3-plugin-package-management-bbbbb-22222',
                      ),
                      readyPod(
                        'ql3-plugin-package-management-aaaaa-11111',
                      ),
                    ],
                  };
                },
              },
              async openPortForward(request) {
                calls.tunnels.push(request);
                const stream = connectTcp({
                  host: '127.0.0.1',
                  port: server.port,
                });
                return {
                  stream,
                  close() {
                    calls.closes += 1;
                    stream.destroy();
                  },
                };
              },
            };
          },
        },
      );
    assert.equal(result.requestId, 'request-kubernetes-client-1');
    assert.deepEqual(calls.lists, [
      {
        namespace: 'qinglong3-system',
        labelSelector:
          'app.kubernetes.io/name=ql3-plugin-package-management,' +
          'app.kubernetes.io/component=plugin-package-management',
        limit: 3,
        timeoutSeconds: 2,
        watch: false,
      },
    ]);
    assert.deepEqual(calls.tunnels, [
      {
        namespace: 'qinglong3-system',
        podName: 'ql3-plugin-package-management-aaaaa-11111',
        port: 8443,
      },
    ]);
    assert.equal(calls.closes, 1);
    assert.deepEqual(requests, [
      {
        authorization: `Bearer ${ASSERTION}`,
        protocol: 'TLSv1.3',
        servername: SERVICE_HOST,
        body: inspectCommand(),
      },
    ]);
  } finally {
    await server.close();
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rejects ambient, executable, proxied, insecure, and file-backed kubeconfig authority', async () => {
  const cases = [
    kubeconfig({ cluster: { 'insecure-skip-tls-verify': true } }),
    kubeconfig({ cluster: { 'proxy-url': 'https://proxy.invalid' } }),
    kubeconfig({
      cluster: {
        'certificate-authority': '/private/ca.pem',
        'certificate-authority-data': undefined,
      },
    }),
    kubeconfig({
      user: {
        token: undefined,
        exec: {
          apiVersion: 'client.authentication.k8s.io/v1',
          command: '/usr/bin/cloud-login',
        },
      },
    }),
    kubeconfig({
      user: {
        token: undefined,
        'auth-provider': { name: 'oidc' },
      },
    }),
    kubeconfig({
      user: { token: undefined, username: 'admin', password: 'secret' },
    }),
    kubeconfig({ user: { as: 'root' } }),
    kubeconfig({
      user: {
        token: undefined,
        'client-certificate-data': readFileSync(
          KUBERNETES_CLIENT_CERT,
        ).toString('base64'),
        'client-key-data': readFileSync(SERVICE_KEY).toString('base64'),
      },
    }),
  ];
  for (const candidate of cases) {
    const files = createClientFiles(candidate);
    try {
      await assert.rejects(
        executeClusterPluginPackageManagementKubernetesClient(
          files.paths,
          {
            createRuntime() {
              assert.fail('invalid kubeconfig reached runtime creation');
            },
          },
        ),
        ClusterPluginPackageManagementKubernetesClientConfigurationError,
      );
    } finally {
      rmSync(files.directory, { recursive: true, force: true });
    }
  }
});

test('accepts one matching embedded Kubernetes client certificate and key', async () => {
  const files = createClientFiles(
    kubeconfig({
      user: {
        token: undefined,
        'client-certificate-data': readFileSync(
          KUBERNETES_CLIENT_CERT,
        ).toString('base64'),
        'client-key-data': readFileSync(KUBERNETES_CLIENT_KEY).toString(
          'base64',
        ),
      },
    }),
  );
  let runtimeCreated = false;
  try {
    await assert.rejects(
      executeClusterPluginPackageManagementKubernetesClient(files.paths, {
        createRuntime() {
          runtimeCreated = true;
          return {
            pods: {
              async listNamespacedPod() {
                return { items: [] };
              },
            },
            async openPortForward() {
              assert.fail('empty Pod list opened a tunnel');
            },
          };
        },
      }),
      ClusterPluginPackageManagementKubernetesClientTunnelError,
    );
    assert.equal(runtimeCreated, true);
  } finally {
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test('maps one PortForward WebSocket to one bounded raw duplex and closes once', async () => {
  const calls = [];
  const clientBytes = [];
  const listeners = { close: [], error: [] };
  let closeCalls = 0;
  let errorStream;
  let serverOutput;
  const connection =
    await openClusterPluginPackageManagementPortForward(
      {
        async portForward(
          namespace,
          podName,
          ports,
          output,
          error,
          input,
          retryCount,
        ) {
          calls.push({
            namespace,
            podName,
            ports,
            retryCount,
          });
          serverOutput = output;
          errorStream = error;
          input.on('data', (chunk) =>
            clientBytes.push(Buffer.from(chunk)),
          );
          return {
            addEventListener(type, listener) {
              listeners[type].push(listener);
            },
            close() {
              closeCalls += 1;
            },
          };
        },
      },
      {
        namespace: 'qinglong3-system',
        podName: 'ql3-plugin-package-management-aaaaa-11111',
        port: 8443,
      },
    );
  assert.deepEqual(calls, [
    {
      namespace: 'qinglong3-system',
      podName: 'ql3-plugin-package-management-aaaaa-11111',
      ports: [8443],
      retryCount: 0,
    },
  ]);
  connection.stream.write(Buffer.from('client-request'));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(Buffer.concat(clientBytes).toString(), 'client-request');

  const incoming = once(connection.stream, 'data');
  serverOutput.write(Buffer.from('server-response'));
  assert.equal((await incoming)[0].toString(), 'server-response');

  errorStream.write(Buffer.alloc(0));
  assert.equal(connection.stream.destroyed, false);
  const failed = once(connection.stream, 'error');
  errorStream.write(Buffer.from('redacted Kubernetes diagnostic'));
  assert.equal(
    (await failed)[0] instanceof
      ClusterPluginPackageManagementKubernetesClientTunnelError,
    true,
  );
  connection.close();
  connection.close();
  assert.equal(closeCalls, 1);
});

test('binds the upstream Kubernetes PortForward path and channel protocol exactly', async () => {
  const kubernetes = await import('@kubernetes/client-node');
  const config = new kubernetes.KubeConfig();
  config.loadFromString(JSON.stringify(kubeconfig()));
  config.setCurrentContext('production');
  const sent = [];
  const listeners = { close: [], error: [] };
  let connectedPath;
  let binaryHandler;
  let closeCalls = 0;
  const webSocket = {
    protocol: 'v5.channel.k8s.io',
    send(chunk) {
      sent.push(Buffer.from(chunk));
    },
    close() {
      closeCalls += 1;
    },
    addEventListener(type, listener) {
      listeners[type].push(listener);
    },
  };
  const forward = new kubernetes.PortForward(config, true, {
    async connect(path, _textHandler, handler) {
      connectedPath = path;
      binaryHandler = handler;
      return webSocket;
    },
  });
  const connection =
    await openClusterPluginPackageManagementPortForward(
      forward,
      {
        namespace: 'qinglong3-system',
        podName: 'ql3-plugin-package-management-aaaaa-11111',
        port: 8443,
      },
    );
  assert.equal(
    connectedPath,
    '/api/v1/namespaces/qinglong3-system/pods/' +
      'ql3-plugin-package-management-aaaaa-11111/' +
      'portforward?ports=8443',
  );

  connection.stream.write(Buffer.from('client-bytes'));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(
    sent[0],
    Buffer.concat([Buffer.from([0]), Buffer.from('client-bytes')]),
  );

  const portHeader = Buffer.alloc(2);
  portHeader.writeUInt16BE(8443);
  const incoming = once(connection.stream, 'data');
  assert.equal(
    binaryHandler(
      0,
      Buffer.concat([portHeader, Buffer.from('server-bytes')]),
    ),
    true,
  );
  assert.equal((await incoming)[0].toString(), 'server-bytes');

  connection.close();
  assert.equal(closeCalls, 1);
});

test('rejects overflow, continue, unready, and token-mounted Pod targets without a tunnel', async () => {
  const files = createClientFiles();
  const lists = [
    {
      metadata: { continue: 'next-page' },
      items: [readyPod('ql3-plugin-package-management-aaaaa-11111')],
    },
    {
      items: [
        readyPod('ql3-plugin-package-management-aaaaa-11111'),
        readyPod('ql3-plugin-package-management-bbbbb-22222'),
        readyPod('ql3-plugin-package-management-ccccc-33333'),
      ],
    },
    {
      items: [
        readyPod('ql3-plugin-package-management-aaaaa-11111', {
          status: {
            phase: 'Pending',
            conditions: [],
            containerStatuses: [],
          },
        }),
      ],
    },
    {
      items: [
        readyPod('ql3-plugin-package-management-aaaaa-11111', {
          spec: { automountServiceAccountToken: true },
        }),
      ],
    },
  ];
  try {
    for (const list of lists) {
      let tunnelCalls = 0;
      await assert.rejects(
        executeClusterPluginPackageManagementKubernetesClient(
          files.paths,
          {
            createRuntime() {
              return {
                pods: { async listNamespacedPod() { return list; } },
                async openPortForward() {
                  tunnelCalls += 1;
                  throw new Error('must not open');
                },
              };
            },
          },
        ),
        ClusterPluginPackageManagementKubernetesClientTunnelError,
      );
      assert.equal(tunnelCalls, 0);
    }
  } finally {
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test('does not retry or switch Pods when the tunneled response is lost', async () => {
  const server = await startServer((request) => {
    request.resume();
    request.once('end', () => request.socket.destroy());
  });
  const files = createClientFiles();
  let listCalls = 0;
  let tunnelCalls = 0;
  let closeCalls = 0;
  try {
    await assert.rejects(
      executeClusterPluginPackageManagementKubernetesClient(files.paths, {
        createRuntime() {
          return {
            pods: {
              async listNamespacedPod() {
                listCalls += 1;
                return {
                  items: [
                    readyPod(
                      'ql3-plugin-package-management-aaaaa-11111',
                    ),
                    readyPod(
                      'ql3-plugin-package-management-bbbbb-22222',
                    ),
                  ],
                };
              },
            },
            async openPortForward() {
              tunnelCalls += 1;
              const stream = connectTcp({
                host: '127.0.0.1',
                port: server.port,
              });
              return {
                stream,
                close() {
                  closeCalls += 1;
                  stream.destroy();
                },
              };
            },
          };
        },
      }),
    );
    assert.equal(listCalls, 1);
    assert.equal(tunnelCalls, 1);
    assert.equal(closeCalls, 1);
  } finally {
    await server.close();
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test('preserves bounded management rejection facts across the tunnel', async () => {
  const server = await startServer((request, response) => {
    request.resume();
    request.once('end', () => {
      const body = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          requestId: 'request-kubernetes-rejected-1',
          error: { code: 'forbidden' },
        }),
      );
      response.writeHead(403, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
      });
      response.end(body);
    });
  });
  const files = createClientFiles();
  let closes = 0;
  try {
    await assert.rejects(
      executeClusterPluginPackageManagementKubernetesClient(files.paths, {
        createRuntime() {
          return {
            pods: {
              async listNamespacedPod() {
                return {
                  items: [
                    readyPod(
                      'ql3-plugin-package-management-aaaaa-11111',
                    ),
                  ],
                };
              },
            },
            async openPortForward() {
              const stream = connectTcp({
                host: '127.0.0.1',
                port: server.port,
              });
              return {
                stream,
                close() {
                  closes += 1;
                  stream.destroy();
                },
              };
            },
          };
        },
      }),
      (error) => {
        assert.equal(
          error instanceof ClusterPluginPackageManagementClientRemoteError,
          true,
        );
        assert.equal(error.statusCode, 403);
        assert.equal(error.responseCode, 'forbidden');
        assert.equal(error.requestId, 'request-kubernetes-rejected-1');
        return true;
      },
    );
    assert.equal(closes, 1);
  } finally {
    await server.close();
    rmSync(files.directory, { recursive: true, force: true });
  }
});

test('rejects non-private kubeconfig and keeps CLI failure output secret-free', () => {
  const files = createClientFiles(
    kubeconfig({
      user: {
        token: KUBERNETES_TOKEN,
        exec: {
          apiVersion: 'client.authentication.k8s.io/v1',
          command: '/usr/bin/cloud-login-secret',
        },
      },
    }),
  );
  try {
    chmodSync(files.kubeconfigFile, 0o644);
    const result = spawnSync(
      process.execPath,
      [
        CLIENT_CLI,
        `--config=${files.paths.configFile}`,
        `--command=${files.paths.commandFile}`,
        `--assertion=${files.paths.assertionFile}`,
        `--kubernetes=${files.paths.kubernetesFile}`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    const fact = JSON.parse(result.stderr);
    assert.deepEqual(fact, {
      schemaVersion: 1,
      component:
        'qinglong3-plugin-package-management-kubernetes-client',
      event: 'command_failed',
      code:
        'QL3_PLUGIN_PACKAGE_MANAGEMENT_KUBERNETES_CLIENT_CONFIG_INVALID',
    });
    for (const secret of [
      KUBERNETES_TOKEN,
      ASSERTION,
      'cloud-login-secret',
      files.directory,
    ]) {
      assert.equal(result.stderr.includes(secret), false);
    }
  } finally {
    rmSync(files.directory, { recursive: true, force: true });
  }
});
