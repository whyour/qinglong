const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createServer } = require('node:https');

const packageRoot = path.resolve(__dirname, '..');
const moduleDirectory = path.join(packageRoot, 'dist', 'product-cli');
const cliPath = path.join(moduleDirectory, 'cli.js');
const certificateFixture = path.join(
  packageRoot,
  'test',
  'fixtures',
  'management-service-cert.pem',
);
const privateKeyFixture = path.join(
  packageRoot,
  'test',
  'fixtures',
  'management-service-key.pem',
);
const localhostCertificateFixture = path.resolve(
  packageRoot,
  '../ql3-cluster-control/test/fixtures/mtls/server-cert.pem',
);
const localhostCaFixture = path.resolve(
  packageRoot,
  '../ql3-cluster-control/test/fixtures/mtls/ca-cert.pem',
);
const localhostPrivateKeyFixture = path.resolve(
  packageRoot,
  '../ql3-cluster-control/test/fixtures/mtls/server-key.pem',
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
);
const {
  QINGLONG3_CLUSTER_PRODUCT_COMMANDS,
  loadQingLong3ClusterProductVersion,
  qingLong3ClusterProductHelp,
  resolveQingLong3ClusterProductCommand,
} = require('../dist/product-cli/productCommand.js');
const {
  clusterProductSignalExitCode,
  forwardClusterProductSignals,
} = require('../dist/product-cli/cli.js');
const {
  loadQingLong3ClusterProductContext,
  resolveQingLong3ClusterProductContextArguments,
} = require('../dist/product-cli/productContext.js');
const {
  validateClusterAuthenticatedManagementClientConfiguration,
} = require('../dist/management-support/pluginPackageManagementClient.js');
const {
  CLUSTER_COPILOT_CLIENT_CONFIG_SCHEMA,
} = require('../dist/copilot-client/client.js');

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
}

function runCliAsync(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (status, signal) => {
      resolvePromise({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

async function startReadinessServer(status) {
  const server = createServer(
    {
      key: fs.readFileSync(localhostPrivateKeyFixture),
      cert: fs.readFileSync(localhostCertificateFixture),
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    },
    (request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/readyz');
      assert.equal(request.headers.authorization, undefined);
      const body = Buffer.from(
        JSON.stringify({ schemaVersion: 1, status: status.value }),
      );
      response.writeHead(status.value === 'ready' ? 200 : 503, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
      });
      response.end(body);
    },
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

async function startCopilotReadinessServer(status) {
  const server = createServer(
    {
      key: fs.readFileSync(localhostPrivateKeyFixture),
      cert: fs.readFileSync(localhostCertificateFixture),
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    },
    (request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/readyz');
      assert.equal(request.headers.authorization, undefined);
      const body = Buffer.from(JSON.stringify({ status: status.value }));
      response.writeHead(status.value === 'ready' ? 200 : 503, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
      });
      response.end(body);
    },
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

function privateFile(directory, name, contents) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  return filePath;
}

function contextFixture(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-cluster-context-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runConfig = privateFile(directory, 'run-client.json', '{}');
  const packageConfig = privateFile(directory, 'package-client.json', '{}');
  const kubernetes = privateFile(directory, 'kubernetes.json', '{}');
  const contextFile = privateFile(
    directory,
    'operator-context.json',
    JSON.stringify({
      schemaVersion: 1,
      commands: {
        run: { configFile: runConfig },
        'package-kubernetes': {
          configFile: packageConfig,
          kubernetesFile: kubernetes,
        },
      },
    }),
  );
  return { directory, runConfig, packageConfig, kubernetes, contextFile };
}

function validContextFixture(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-cluster-valid-context-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const caFile = privateFile(
    directory,
    'management-ca.pem',
    fs.readFileSync(certificateFixture),
  );
  const clientCertificateFile = privateFile(
    directory,
    'operator-certificate.pem',
    fs.readFileSync(certificateFixture),
  );
  const clientPrivateKeyFile = privateFile(
    directory,
    'operator-private-key.pem',
    fs.readFileSync(privateKeyFixture),
  );
  function config(name, managementPath, clientCertificate) {
    return privateFile(
      directory,
      `${name}.json`,
      JSON.stringify({
        schemaVersion: 1,
        endpoint: `https://manager.example.test:8443${managementPath}`,
        servername: 'manager.example.test',
        caFile,
        ...(clientCertificate === 'required'
          ? { clientCertificateFile, clientPrivateKeyFile }
          : {}),
        requestTimeoutMs: 1_000,
      }),
    );
  }
  const packageConfig = config(
    'package-client',
    '/api/v3/plugin-packages/management',
    'forbidden',
  );
  const copilotConfig = privateFile(
    directory,
    'copilot-client.json',
    JSON.stringify({
      schema: CLUSTER_COPILOT_CLIENT_CONFIG_SCHEMA,
      endpoint: 'https://copilot.example.test:8443/',
      servername: 'copilot.example.test',
      caFile,
      requestTimeoutMs: 1_000,
    }),
  );
  const kubeconfigFile = privateFile(
    directory,
    'kubeconfig.json',
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [
        {
          name: 'production',
          cluster: {
            server: 'https://kubernetes.example.test:6443',
            'certificate-authority-data': fs
              .readFileSync(certificateFixture)
              .toString('base64'),
          },
        },
      ],
      users: [{ name: 'operator', user: { token: 'bounded-token' } }],
      contexts: [
        {
          name: 'production',
          context: {
            cluster: 'production',
            user: 'operator',
            namespace: 'qinglong3',
          },
        },
      ],
      'current-context': 'production',
    }),
  );
  const kubernetesFile = privateFile(
    directory,
    'kubernetes-client.json',
    JSON.stringify({
      schemaVersion: 1,
      kubeconfigFile,
      context: 'production',
      namespace: 'qinglong3',
      apiTimeoutMs: 1_000,
    }),
  );
  const commands = {
    copilot: { configFile: copilotConfig },
    package: { configFile: packageConfig },
    'package-kubernetes': { configFile: packageConfig, kubernetesFile },
    'worker-credential': {
      configFile: config(
        'worker-client',
        '/api/v3/worker-credentials/management',
        'required',
      ),
    },
    approval: {
      configFile: config(
        'approval-client',
        '/api/v3/approvals/management',
        'required',
      ),
    },
    run: {
      configFile: config('run-client', '/api/v3/runs/management', 'required'),
    },
    automation: {
      configFile: config(
        'automation-client',
        '/api/v3/automations/management',
        'required',
      ),
    },
    'model-credential': {
      configFile: config(
        'provider-client',
        '/api/v3/provider-credentials/management',
        'required',
      ),
    },
  };
  return {
    directory,
    contextFile: privateFile(
      directory,
      'operator-context.json',
      JSON.stringify({ schemaVersion: 1, commands }),
    ),
    commands,
  };
}

test('catalog exposes only reviewed product entrypoints from the same package', () => {
  assert.equal(manifest.bin['ql3-cluster-admin'], 'dist/product-cli/cli.js');
  assert.equal(QINGLONG3_CLUSTER_PRODUCT_COMMANDS.length, 11);
  assert.equal(
    new Set(QINGLONG3_CLUSTER_PRODUCT_COMMANDS.map(({ name }) => name)).size,
    QINGLONG3_CLUSTER_PRODUCT_COMMANDS.length,
  );
  assert.equal(
    new Set(QINGLONG3_CLUSTER_PRODUCT_COMMANDS.map(({ binary }) => binary))
      .size,
    QINGLONG3_CLUSTER_PRODUCT_COMMANDS.length,
  );
  for (const command of QINGLONG3_CLUSTER_PRODUCT_COMMANDS) {
    assert.equal(manifest.bin[command.binary], `dist/${command.target}`);
    assert.equal(
      fs.lstatSync(path.join(packageRoot, 'dist', command.target)).isFile(),
      true,
    );
    assert.equal(
      command.binary.includes('-client') ||
        command.binary === 'ql3-copilot-mcp' ||
        command.binary === 'ql3-copilot-console' ||
        command.binary === 'ql3-copilot-evidence-verify',
      true,
    );
  }
  for (const forbidden of [
    'ql3-cluster-migrate',
    'ql3-plugin-package-recover',
    'ql3-plugin-package-manage',
    'ql3-plugin-package-execute',
    'ql3-worker-credential-manage',
    'ql3-worker-credential-execute',
    'ql3-prompt-output-key-rotate',
    'ql3-prompt-output-gc',
  ]) {
    assert.equal(
      QINGLONG3_CLUSTER_PRODUCT_COMMANDS.some(
        ({ binary }) => binary === forbidden,
      ),
      false,
    );
  }
});

test('help and version are bounded installation-derived product facts', () => {
  const help = qingLong3ClusterProductHelp();
  assert.match(help, /^Usage: ql3-cluster-admin <command> \[arguments\]/);
  assert.match(help, /\n  run\s+retry or stop Runs/);
  assert.match(help, /\n  copilot\s+diagnose, inspect, read or cancel Runs/);
  assert.match(help, /\n  copilot-mcp\s+serve the bounded Cluster Copilot MCP/);
  assert.match(help, /\n  copilot-console\s+open the loopback-only read-only/);
  assert.match(
    help,
    /\n  evidence-verify\s+verify one redacted Console evidence/,
  );
  assert.match(help, /Server, migration, recovery, executor and key-custody/);
  assert.equal(help.includes('plugin-package-manage'), false);
  assert.equal(
    loadQingLong3ClusterProductVersion(moduleDirectory),
    manifest.version,
  );
  assert.deepEqual(resolveQingLong3ClusterProductCommand([], moduleDirectory), {
    kind: 'help',
    output: help,
  });
  assert.deepEqual(
    resolveQingLong3ClusterProductCommand(['--version'], moduleDirectory),
    { kind: 'version', output: manifest.version },
  );
});

test('resolves only static remote-client targets and preserves opaque arguments', () => {
  const argv = [
    'run',
    '--config=/private/client config.json',
    '--literal=$() && *',
  ];
  const result = resolveQingLong3ClusterProductCommand(argv, moduleDirectory);
  assert.equal(result.kind, 'invoke');
  assert.equal(result.command.binary, 'ql3-run-client');
  assert.equal(
    result.targetFilePath,
    path.join(
      packageRoot,
      'dist',
      'run-management',
      'runManagementClientCli.js',
    ),
  );
  assert.deepEqual(result.argv, argv.slice(1));
  assert.equal(Object.isFrozen(result.argv), true);
  assert.equal(Object.isFrozen(result), true);

  for (const candidate of [
    '../../tmp/owned',
    '/absolute/command',
    'run/../../owned',
    'run-manage',
    'migrate',
    'execute',
  ]) {
    const rejected = resolveQingLong3ClusterProductCommand(
      [candidate, '--help'],
      moduleDirectory,
    );
    assert.equal(rejected.kind, 'invalid');
    assert.equal(rejected.code, 'QL3_CLUSTER_PRODUCT_CLI_USAGE_INVALID');
  }
});

test('injects only stable paths from an explicit owner-private operator context', (t) => {
  const fixture = contextFixture(t);
  const context = loadQingLong3ClusterProductContext(fixture.contextFile);
  assert.deepEqual(context, {
    schemaVersion: 1,
    commands: {
      run: { configFile: fixture.runConfig },
      'package-kubernetes': {
        configFile: fixture.packageConfig,
        kubernetesFile: fixture.kubernetes,
      },
    },
  });
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.commands), true);
  assert.equal(Object.isFrozen(context.commands.run), true);

  const run = resolveQingLong3ClusterProductCommand(
    [
      'run',
      `--context=${fixture.contextFile}`,
      '--command=/private/command.json',
      '--assertion=/private/assertion.jwt',
    ],
    moduleDirectory,
  );
  assert.equal(run.kind, 'invoke');
  assert.deepEqual(run.argv, [
    `--config=${fixture.runConfig}`,
    '--command=/private/command.json',
    '--assertion=/private/assertion.jwt',
  ]);

  const tunnel = resolveQingLong3ClusterProductContextArguments(
    fixture.contextFile,
    'package-kubernetes',
    ['--command=/private/command.json', '--assertion=/private/assertion.jwt'],
  );
  assert.deepEqual(tunnel, [
    `--config=${fixture.packageConfig}`,
    `--kubernetes=${fixture.kubernetes}`,
    '--command=/private/command.json',
    '--assertion=/private/assertion.jwt',
  ]);
});

test('operator context rejects weak files, unknown or secret fields and argument conflicts', (t) => {
  const fixture = contextFixture(t);
  const cases = [
    { schemaVersion: 1, commands: {} },
    { schemaVersion: 2, commands: { run: { configFile: fixture.runConfig } } },
    {
      schemaVersion: 1,
      commands: { unknown: { configFile: fixture.runConfig } },
    },
    {
      schemaVersion: 1,
      commands: {
        run: {
          configFile: fixture.runConfig,
          assertionFile: '/private/assertion.jwt',
        },
      },
    },
    {
      schemaVersion: 1,
      commands: {
        run: { configFile: fixture.runConfig, privateKeyFile: '/private/key' },
      },
    },
    {
      schemaVersion: 1,
      commands: {
        'package-kubernetes': { configFile: fixture.packageConfig },
      },
    },
  ];
  for (const [index, value] of cases.entries()) {
    const filePath = privateFile(
      fixture.directory,
      `invalid-${index}.json`,
      JSON.stringify(value),
    );
    assert.throws(
      () => loadQingLong3ClusterProductContext(filePath),
      /operator context is invalid/,
    );
  }

  const publicContext = privateFile(
    fixture.directory,
    'public.json',
    JSON.stringify({
      schemaVersion: 1,
      commands: { run: { configFile: fixture.runConfig } },
    }),
  );
  fs.chmodSync(publicContext, 0o644);
  assert.throws(() => loadQingLong3ClusterProductContext(publicContext));

  const symlink = path.join(fixture.directory, 'context-link.json');
  fs.symlinkSync(fixture.contextFile, symlink);
  assert.throws(() => loadQingLong3ClusterProductContext(symlink));

  const binaryRejected = runCli([
    'run',
    `--context=${publicContext}`,
    '--command=/private/command.json',
    '--assertion=/private/assertion.jwt',
  ]);
  assert.equal(binaryRejected.status, 78);
  assert.equal(binaryRejected.stdout, '');
  assert.deepEqual(JSON.parse(binaryRejected.stderr), {
    schemaVersion: 1,
    component: 'qinglong3-cluster-product-cli',
    code: 'QL3_CLUSTER_PRODUCT_CONTEXT_INVALID',
    message: 'QingLong 3.0 Cluster operator context is invalid',
  });
  assert.equal(binaryRejected.stderr.includes(fixture.directory), false);

  assert.throws(
    () =>
      resolveQingLong3ClusterProductCommand(
        [
          'approval',
          `--context=${fixture.contextFile}`,
          '--command=/private/command.json',
          '--assertion=/private/assertion.jwt',
        ],
        moduleDirectory,
      ),
    /operator context is invalid/,
  );

  for (const args of [
    ['run', '--context'],
    ['run', '--context='],
    [
      'run',
      `--context=${fixture.contextFile}`,
      `--context=${fixture.contextFile}`,
    ],
  ]) {
    const result = resolveQingLong3ClusterProductCommand(args, moduleDirectory);
    assert.equal(result.kind, 'invalid');
  }
  assert.throws(
    () =>
      resolveQingLong3ClusterProductCommand(
        ['run', `--context=${fixture.contextFile}`, '--config'],
        moduleDirectory,
      ),
    /operator context is invalid/,
  );
});

test('validates the complete operator context offline without operational authority', (t) => {
  const fixture = validContextFixture(t);
  const resolution = resolveQingLong3ClusterProductCommand(
    ['context', 'validate', `--context=${fixture.contextFile}`],
    moduleDirectory,
  );
  assert.deepEqual(resolution, {
    kind: 'context-validation',
    contextFile: fixture.contextFile,
  });

  const validated = runCli([
    'context',
    'validate',
    `--context=${fixture.contextFile}`,
  ]);
  assert.equal(validated.status, 0);
  assert.equal(validated.stderr, '');
  const fact = JSON.parse(validated.stdout);
  assert.deepEqual(fact, {
    schemaVersion: 1,
    component: 'qinglong3-cluster-product-cli',
    event: 'context_valid',
    commandCount: 8,
    commands: [
      { name: 'copilot', transport: 'https', clientCertificate: 'forbidden' },
      { name: 'package', transport: 'https', clientCertificate: 'forbidden' },
      {
        name: 'package-kubernetes',
        transport: 'kubernetes-port-forward',
        clientCertificate: 'forbidden',
        kubernetesAuthentication: 'token',
      },
      {
        name: 'worker-credential',
        transport: 'https',
        clientCertificate: 'required',
      },
      { name: 'approval', transport: 'https', clientCertificate: 'required' },
      { name: 'run', transport: 'https', clientCertificate: 'required' },
      {
        name: 'automation',
        transport: 'https',
        clientCertificate: 'required',
      },
      {
        name: 'model-credential',
        transport: 'https',
        clientCertificate: 'required',
      },
    ],
    networkAccess: false,
    mutation: false,
  });
  assert.equal(validated.stdout.includes(fixture.directory), false);
  assert.equal(validated.stdout.includes('manager.example.test'), false);
  assert.equal(validated.stdout.includes('bounded-token'), false);
});

test('probes a context with fixed read-only readiness semantics and exit status', async (t) => {
  const status = { value: 'ready' };
  const server = await startReadinessServer(status);
  t.after(() => server.close());
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-cluster-probe-context-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const caFile = privateFile(
    directory,
    'ca.pem',
    fs.readFileSync(localhostCaFixture),
  );
  const configFile = privateFile(
    directory,
    'package.json',
    JSON.stringify({
      schemaVersion: 1,
      endpoint: `https://localhost:${server.port}/api/v3/plugin-packages/management`,
      servername: 'localhost',
      caFile,
      requestTimeoutMs: 1_000,
    }),
  );
  const contextFile = privateFile(
    directory,
    'operator-context.json',
    JSON.stringify({
      schemaVersion: 1,
      commands: { package: { configFile } },
    }),
  );
  assert.deepEqual(
    resolveQingLong3ClusterProductCommand(
      ['context', 'probe', `--context=${contextFile}`],
      moduleDirectory,
    ),
    { kind: 'context-probe', contextFile },
  );

  const ready = await runCliAsync([
    'context',
    'probe',
    `--context=${contextFile}`,
  ]);
  assert.equal(
    ready.status,
    0,
    JSON.stringify({ stdout: ready.stdout, stderr: ready.stderr }),
  );
  assert.equal(ready.stderr, '');
  assert.deepEqual(JSON.parse(ready.stdout), {
    schemaVersion: 1,
    component: 'qinglong3-cluster-product-cli',
    event: 'context_probed',
    commandCount: 1,
    commands: [{ name: 'package', transport: 'https', status: 'ready' }],
    allReady: true,
    requestMethod: 'GET',
    requestPath: '/readyz',
    mutation: false,
  });
  assert.equal(ready.stdout.includes(directory), false);
  assert.equal(ready.stdout.includes('localhost'), false);

  status.value = 'not_ready';
  const notReady = await runCliAsync([
    'context',
    'probe',
    `--context=${contextFile}`,
  ]);
  assert.equal(notReady.status, 69);
  assert.equal(notReady.stderr, '');
  const fact = JSON.parse(notReady.stdout);
  assert.equal(fact.allReady, false);
  assert.equal(fact.commands[0].status, 'not_ready');
});

test('probes Copilot context through its separate unauthenticated readiness contract', async (t) => {
  const status = { value: 'ready' };
  const server = await startCopilotReadinessServer(status);
  t.after(() => server.close());
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-copilot-probe-context-')),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const caFile = privateFile(
    directory,
    'ca.pem',
    fs.readFileSync(localhostCaFixture),
  );
  const configFile = privateFile(
    directory,
    'copilot.json',
    JSON.stringify({
      schema: CLUSTER_COPILOT_CLIENT_CONFIG_SCHEMA,
      endpoint: `https://localhost:${server.port}/`,
      servername: 'localhost',
      caFile,
      requestTimeoutMs: 1_000,
    }),
  );
  const contextFile = privateFile(
    directory,
    'operator-context.json',
    JSON.stringify({
      schemaVersion: 1,
      commands: { copilot: { configFile } },
    }),
  );

  const ready = await runCliAsync([
    'context',
    'probe',
    `--context=${contextFile}`,
  ]);
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(ready.stderr, '');
  assert.deepEqual(JSON.parse(ready.stdout), {
    schemaVersion: 1,
    component: 'qinglong3-cluster-product-cli',
    event: 'context_probed',
    commandCount: 1,
    commands: [{ name: 'copilot', transport: 'https', status: 'ready' }],
    allReady: true,
    requestMethod: 'GET',
    requestPath: '/readyz',
    mutation: false,
  });

  status.value = 'not_ready';
  const notReady = await runCliAsync([
    'context',
    'probe',
    `--context=${contextFile}`,
  ]);
  assert.equal(notReady.status, 69);
  assert.equal(JSON.parse(notReady.stdout).allReady, false);
});

test('context validation fails closed for invalid client configuration and syntax', (t) => {
  const fixture = validContextFixture(t);
  fs.writeFileSync(fixture.commands.run.configFile, '{}', { mode: 0o600 });
  const invalid = runCli([
    'context',
    'validate',
    `--context=${fixture.contextFile}`,
  ]);
  assert.equal(invalid.status, 78);
  assert.equal(invalid.stdout, '');
  assert.deepEqual(JSON.parse(invalid.stderr), {
    schemaVersion: 1,
    component: 'qinglong3-cluster-product-cli',
    code: 'QL3_CLUSTER_PRODUCT_CONTEXT_INVALID',
    message: 'QingLong 3.0 Cluster operator context is invalid',
  });
  assert.equal(invalid.stderr.includes(fixture.directory), false);

  for (const argv of [
    ['context'],
    ['context', 'validate'],
    ['context', 'validate', '--context'],
    ['context', 'validate', '--context='],
    ['context', 'probe'],
    ['context', 'probe', '--context='],
    ['context', 'inspect', `--context=${fixture.contextFile}`],
  ]) {
    const rejected = resolveQingLong3ClusterProductCommand(
      argv,
      moduleDirectory,
    );
    assert.equal(rejected.kind, 'invalid');
    assert.equal(rejected.code, 'QL3_CLUSTER_PRODUCT_CLI_USAGE_INVALID');
  }
});

test('configuration preflight fixes every management route to its reviewed authentication class', (t) => {
  const fixture = validContextFixture(t);
  assert.throws(
    () =>
      validateClusterAuthenticatedManagementClientConfiguration(
        fixture.commands.run.configFile,
        'package',
      ),
    /configuration is invalid/,
  );
  assert.throws(
    () =>
      validateClusterAuthenticatedManagementClientConfiguration(
        fixture.commands.package.configFile,
        'run',
      ),
    /configuration is invalid/,
  );
  assert.throws(
    () =>
      validateClusterAuthenticatedManagementClientConfiguration(
        fixture.commands.package.configFile,
        'unknown',
      ),
    /configuration is invalid/,
  );
});

test('rejects symlink targets and package manifests', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-cluster-product-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakePackageRoot = path.join(root, 'package');
  const fakeModuleDirectory = path.join(fakePackageRoot, 'dist', 'product-cli');
  const targetDirectory = path.join(fakePackageRoot, 'dist', 'run-management');
  fs.mkdirSync(fakeModuleDirectory, { recursive: true });
  fs.mkdirSync(targetDirectory, { recursive: true });
  const external = path.join(root, 'external.js');
  fs.writeFileSync(external, 'process.exit(0);\n');
  fs.symlinkSync(
    external,
    path.join(targetDirectory, 'runManagementClientCli.js'),
  );
  assert.throws(
    () =>
      resolveQingLong3ClusterProductCommand(
        ['run', '--help'],
        fakeModuleDirectory,
      ),
    /unavailable/,
  );

  fs.writeFileSync(
    path.join(fakePackageRoot, 'package.real.json'),
    JSON.stringify({ name: '@qinglong/cluster-admin', version: '3.0.0' }),
  );
  fs.symlinkSync(
    path.join(fakePackageRoot, 'package.real.json'),
    path.join(fakePackageRoot, 'package.json'),
  );
  assert.throws(
    () => loadQingLong3ClusterProductVersion(fakeModuleDirectory),
    /unavailable/,
  );
});

test('binary exposes help/version and delegates without a shell', () => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: ql3-cluster-admin <command>/);
  assert.match(help.stdout, /--context=\/absolute\/operator-context\.json/);
  assert.equal(help.stderr, '');

  const version = runCli(['--version']);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), manifest.version);
  assert.equal(version.stderr, '');

  const delegatedHelp = runCli(['run', '--help']);
  assert.equal(delegatedHelp.status, 0);
  assert.match(delegatedHelp.stdout, /^Usage: ql3-run-client /);
  assert.equal(delegatedHelp.stderr, '');

  const rejected = runCli(['../../tmp/not-a-command']);
  assert.equal(rejected.status, 64);
  assert.equal(rejected.stdout, '');
  const failure = JSON.parse(rejected.stderr);
  assert.equal(failure.code, 'QL3_CLUSTER_PRODUCT_CLI_USAGE_INVALID');
  assert.equal(JSON.stringify(failure).includes('/tmp'), false);
});

test('forwards only bounded signals and removes handlers', () => {
  const signalHost = new EventEmitter();
  const received = [];
  const child = {
    exitCode: null,
    signalCode: null,
    kill(signal) {
      received.push(signal);
      return true;
    },
  };
  const remove = forwardClusterProductSignals(child, signalHost);
  signalHost.emit('SIGINT');
  signalHost.emit('SIGTERM');
  signalHost.emit('SIGHUP');
  assert.deepEqual(received, ['SIGINT', 'SIGTERM', 'SIGHUP']);
  assert.equal(clusterProductSignalExitCode('SIGINT'), 130);
  assert.equal(clusterProductSignalExitCode('SIGTERM'), 143);
  remove();
  signalHost.emit('SIGTERM');
  assert.deepEqual(received, ['SIGINT', 'SIGTERM', 'SIGHUP']);

  child.exitCode = 0;
  const removeTerminal = forwardClusterProductSignals(child, signalHost);
  signalHost.emit('SIGTERM');
  removeTerminal();
  assert.deepEqual(received, ['SIGINT', 'SIGTERM', 'SIGHUP']);
});
