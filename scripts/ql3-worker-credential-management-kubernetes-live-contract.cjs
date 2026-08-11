#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} = require('node:crypto');
const fs = require('node:fs');
const yaml = require('js-yaml');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const K3S_IMAGE = 'rancher/k3s:v1.34.3-k3s1';
const K3S_DIGEST =
  'sha256:71abd3a56f57884c62732e0e0d87606052cb5f8555b7db7e8e33c04570b8175c';
const POSTGRES_IMAGE = 'postgres:18';
const POSTGRES_DATABASE = 'ql3_contract';
const POSTGRES_SUPERUSER_PASSWORD = 'postgres';
const NAMESPACE = 'qinglong3-system';
const DEPLOYMENT = 'ql3-worker-credential-management';
const SERVICE = 'ql3-worker-credential-management';
const IDENTITY_SECRET = 'ql3-worker-credential-management-identity';
const TLS_SECRET = 'ql3-worker-credential-management-tls';
const DATABASE_SECRET = 'ql3-worker-credential-management-database';
const SERVERNAME = `${SERVICE}.${NAMESPACE}.svc`;
const MANAGEMENT_PATH = '/api/v3/worker-credentials/management';
const ISSUER = 'https://identity.qinglong.test/';
const AUDIENCE = 'qinglong3-worker-credential-management';
const POSTGRES_ROLES = Object.freeze({
  migration: Object.freeze({
    user: 'ql3_migration',
    password: 'ql3_migration_test',
  }),
  runtime: Object.freeze({ user: 'ql3_runtime', password: 'ql3_runtime_test' }),
  admin: Object.freeze({ user: 'ql3_admin', password: 'ql3_admin_test' }),
  automationManager: Object.freeze({
    user: 'ql3_automation_manager',
    password: 'ql3_automation_manager_test',
  }),
  approvalManager: Object.freeze({
    user: 'ql3_approval_manager',
    password: 'ql3_approval_manager_test',
  }),
  packageManager: Object.freeze({
    user: 'ql3_package_manager',
    password: 'ql3_package_manager_test',
  }),
  packageExecutor: Object.freeze({
    user: 'ql3_package_executor',
    password: 'ql3_package_executor_test',
  }),
  workerCredentialManager: Object.freeze({
    user: 'ql3_worker_credential_manager',
    password: 'ql3_worker_credential_manager_test',
  }),
  workerCredentialExecutor: Object.freeze({
    user: 'ql3_worker_credential_executor',
    password: 'ql3_worker_credential_executor_test',
  }),
  workerIngress: Object.freeze({
    user: 'ql3_worker_ingress',
    password: 'ql3_worker_ingress_test',
  }),
});
const clusterRequire = createRequire(
  path.join(ROOT, 'packages/ql3-cluster-admin/package.json'),
);

const HEALTH_SCRIPT = String.raw`
const fs = require('node:fs');
const https = require('node:https');
const [host, rawPort] = process.argv.slice(1);
const ca = fs.readFileSync('/var/run/qinglong3/ca/ca.crt');
function request(path) {
  return new Promise((resolve, reject) => {
    const outgoing = https.request({
      host,
      port: Number(rawPort),
      path,
      method: 'GET',
      servername: host,
      ca,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      rejectUnauthorized: true,
      agent: false,
      headers: { connection: 'close' }
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.once('end', () => resolve({
        path,
        statusCode: incoming.statusCode,
        protocol: incoming.socket.getProtocol(),
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error('timeout')));
    outgoing.once('error', reject);
    outgoing.end();
  });
}
(async () => {
  let lastError = 'unavailable';
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const responses = await Promise.all([request('/readyz'), request('/livez')]);
      const output = JSON.stringify({ schemaVersion: 1, attempt, responses });
      fs.writeFileSync('/dev/termination-log', output + '\n');
      process.stdout.write(output + '\n');
      return;
    } catch (error) {
      lastError = String(error.code || error.name || 'UNKNOWN').slice(0, 64);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const output = JSON.stringify({ schemaVersion: 1, error: lastError });
  fs.writeFileSync('/dev/termination-log', output + '\n');
  process.stderr.write(output + '\n');
  process.exitCode = 1;
})();
`;

const RAW_REQUEST_DIAGNOSTIC_SCRIPT = String.raw`
const fs = require('node:fs');
const https = require('node:https');
const [configFile, commandFile, assertionFile] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const body = fs.readFileSync(commandFile);
const assertion = fs.readFileSync(assertionFile, 'ascii');
const target = new URL(config.endpoint);
const cert = config.clientCertificateFile
  ? fs.readFileSync(config.clientCertificateFile)
  : undefined;
const key = config.clientPrivateKeyFile
  ? fs.readFileSync(config.clientPrivateKeyFile)
  : undefined;
const outgoing = https.request({
  protocol: target.protocol,
  hostname: target.hostname,
  port: Number(target.port),
  path: target.pathname,
  method: 'POST',
  servername: config.servername,
  ca: fs.readFileSync(config.caFile),
  cert,
  key,
  minVersion: 'TLSv1.3',
  maxVersion: 'TLSv1.3',
  rejectUnauthorized: true,
  agent: false,
  headers: {
    accept: 'application/json',
    'accept-encoding': 'identity',
    authorization: 'Bearer ' + assertion,
    connection: 'close',
    'content-type': 'application/json',
    'content-length': String(body.length)
  }
}, (incoming) => {
  const chunks = [];
  incoming.on('data', (chunk) => chunks.push(chunk));
  incoming.once('end', () => {
    const responseBody = Buffer.concat(chunks).toString('utf8');
    const output = JSON.stringify({
      event: 'raw_request_completed',
      statusCode: incoming.statusCode,
      protocol: incoming.socket.getProtocol(),
      rawHeaders: incoming.rawHeaders,
      body: JSON.parse(responseBody)
    });
    fs.writeFileSync('/dev/termination-log', output + '\n');
    process.stdout.write(output + '\n');
  });
});
outgoing.setTimeout(10000, () => outgoing.destroy(new Error('timeout')));
outgoing.once('error', (error) => {
  const output = JSON.stringify({
    event: 'raw_request_failed',
    code: String(error.code || error.name || 'UNKNOWN').slice(0, 64),
    message: String(error.message || '').slice(0, 256)
  });
  fs.writeFileSync('/dev/termination-log', output + '\n');
  process.stdout.write(output + '\n');
});
outgoing.end(body);
`;

const CONNECTIVITY_SCRIPT = String.raw`
const fs = require('node:fs');
const https = require('node:https');
const [host, rawPort] = process.argv.slice(1);
const ca = fs.readFileSync('/var/run/qinglong3/ca/ca.crt');
function probe() {
  return new Promise((resolve, reject) => {
    const outgoing = https.request({
      host,
      port: Number(rawPort),
      path: '/readyz',
      method: 'GET',
      servername: host,
      ca,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      rejectUnauthorized: true,
      agent: false,
      headers: { connection: 'close' }
    }, (incoming) => {
      incoming.resume();
      incoming.once('end', () => resolve({
        statusCode: incoming.statusCode,
        protocol: incoming.socket.getProtocol()
      }));
    });
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('timeout')));
    outgoing.once('error', reject);
    outgoing.end();
  });
}
(async () => {
  let lastError = 'unavailable';
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await probe();
      if (response.statusCode === 200 && response.protocol === 'TLSv1.3') {
        const output = JSON.stringify({
          event: 'connectivity_ready',
          attempts: attempt,
          ...response
        });
        fs.writeFileSync('/dev/termination-log', output + '\n');
        process.stdout.write(output + '\n');
        return;
      }
      lastError = 'HTTP_' + String(response.statusCode);
    } catch (error) {
      lastError = String(error.code || error.name || 'UNKNOWN').slice(0, 64);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const output = JSON.stringify({ event: 'connectivity_failed', error: lastError });
  fs.writeFileSync('/dev/termination-log', output + '\n');
  process.stderr.write(output + '\n');
  process.exitCode = 1;
})();
`;

function run(binary, args, options = {}) {
  if (!options.quiet) {
    process.stderr.write(`+ ${path.basename(binary)} ${args.join(' ')}\n`);
  }
  const result = spawnSync(binary, args, {
    cwd: ROOT,
    env: options.env ?? process.env,
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.capture
      ? ['pipe', 'pipe', 'pipe']
      : [
          options.input === undefined ? 'inherit' : 'pipe',
          'inherit',
          'inherit',
        ],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${path.basename(binary)} failed with ${String(result.status)}: ` +
        `${result.stderr || result.stdout || ''}`,
    );
  }
  return Object.freeze({
    status: result.status,
    stdout: options.capture ? result.stdout.trim() : '',
    stderr: options.capture ? result.stderr.trim() : '',
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, timeoutMs, inspect) {
  const startedAt = Date.now();
  let last = 'not observed';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await inspect();
      if (value?.ready) return value.value;
      if (value?.fact) last = value.fact;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`${description} timed out: ${last}`);
}

function reviewedKey(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return Object.freeze({
    kid,
    privateKey,
    publicJwk: Object.freeze({
      ...publicKey.export({ format: 'jwk' }),
      alg: 'EdDSA',
      kid,
      use: 'sig',
    }),
  });
}

function keyset(generation, keys, revokedKids = []) {
  return Object.freeze({
    schemaVersion: 1,
    generation,
    issuer: ISSUER,
    audience: AUDIENCE,
    keys: keys.map((key) => key.publicJwk),
    revokedKids,
    assuranceMappings: [
      {
        acr: 'urn:ql3:mfa',
        assurance: 'multi_factor',
        requiredAmr: ['pwd', 'otp'],
      },
    ],
    constraints: {
      maxAssertionBytes: 8 * 1024,
      maxLifetimeMs: 5 * 60 * 1000,
      maxAuthenticationAgeMs: 5 * 60 * 1000,
      clockSkewMs: 5 * 1000,
    },
  });
}

function assertion(key, subject = 'operator-a', suffix = randomUUID()) {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(
    JSON.stringify({
      alg: 'EdDSA',
      kid: key.kid,
      typ: 'ql3-worker-credential-management+jwt',
    }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      acr: 'urn:ql3:mfa',
      amr: ['pwd', 'otp'],
      aud: AUDIENCE,
      auth_time: now - 1,
      exp: now + 240,
      iat: now,
      iss: ISSUER,
      jti: `ql3-worker-manager-live-${suffix}`,
      ql3_purpose: 'worker-credential-management',
      sub: subject,
    }),
  ).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${sign(
    null,
    Buffer.from(signed, 'ascii'),
    key.privateKey,
  ).toString('base64url')}`;
}

function planCommand(index, nowMs = Date.now()) {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'worker-credential.plan',
    request: Object.freeze({
      action: 'issue',
      actionRef: `worker-credential:manager-live:plan-${index}`,
      authorityProjectId: 'cluster-authority',
      credentialExpiresAtMs: nowMs + 60 * 60_000,
      credentialId: `manager_live_credential_${index}`,
      credentialNotBeforeAtMs: nowMs + 5 * 60_000,
      deliveryId: randomUUID(),
      deploymentGeneration: `generation-manager_live_${index}`,
      deploymentTargetDigest: 'a'.repeat(64),
      previousCredentialId: null,
      workerId: `manager-live-worker-${index}`,
    }),
  });
}

function inspectCommand(actionRef, suffix = randomUUID()) {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'worker-credential.inspect',
    request: Object.freeze({
      actionRef,
      authorityProjectId: 'cluster-authority',
      approvalRequestId: `approval-manager-live-${suffix}`,
      inspectionId: `inspection-manager-live-${suffix}`,
    }),
  });
}

async function main() {
  const docker = process.env.QL3_DOCKER_BIN || 'docker';
  const kubectlBinary = process.env.QL3_KUBECTL_BIN || 'kubectl';
  const suffix = process.pid.toString(36);
  const network = `ql3-wcm-live-${suffix}`;
  const server = `ql3-wcm-server-${suffix}`;
  const agents = [`ql3-wcm-agent-a-${suffix}`, `ql3-wcm-agent-b-${suffix}`];
  const postgres = `ql3-wcm-postgres-${suffix}`;
  const containers = [server, ...agents, postgres];
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-wcm-live-'));
  const kubeconfig = path.join(temporary, 'kubeconfig');
  const imageArchive = path.join(temporary, 'admin-image.tar');
  const adminImage = `ql3-worker-credential-manager-live:${suffix}`;
  const caKey = path.join(temporary, 'ca.key');
  const caCertificate = path.join(temporary, 'ca.crt');
  const serverKey = path.join(temporary, 'tls.key');
  const serverRequest = path.join(temporary, 'tls.csr');
  const serverCertificate = path.join(temporary, 'tls.crt');
  const serverExtensions = path.join(temporary, 'server.ext');
  const clientOldKey = path.join(temporary, 'client-old.key');
  const clientOldRequest = path.join(temporary, 'client-old.csr');
  const clientOldCertificate = path.join(temporary, 'client-old.crt');
  const clientNewKey = path.join(temporary, 'client-new.key');
  const clientNewRequest = path.join(temporary, 'client-new.csr');
  const clientNewCertificate = path.join(temporary, 'client-new.crt');
  const clientCertificateRevocationList = path.join(temporary, 'client.crl');
  const caConfig = path.join(temporary, 'ca.cnf');
  const caDatabase = path.join(temporary, 'ca.index');
  const caSerial = path.join(temporary, 'ca.serial');
  const caCrlNumber = path.join(temporary, 'ca.crlnumber');
  const caNewCertificates = path.join(temporary, 'ca-new-certificates');
  const clusterToken = randomBytes(32).toString('base64url');
  let networkCreated = false;
  const createdContainers = new Set();
  let adminImageBuilt = false;
  let migrationDatabase;
  try {
    run(docker, ['version'], { capture: true, quiet: true });
    const k3sImage = JSON.parse(
      run(docker, ['image', 'inspect', K3S_IMAGE], {
        capture: true,
        quiet: true,
      }).stdout,
    )[0];
    assert.ok(k3sImage.RepoDigests.includes(`rancher/k3s@${K3S_DIGEST}`));
    const postgresImage = JSON.parse(
      run(docker, ['image', 'inspect', POSTGRES_IMAGE], {
        capture: true,
        quiet: true,
      }).stdout,
    )[0];
    for (const name of containers) {
      assert.equal(
        run(docker, ['inspect', name], {
          capture: true,
          quiet: true,
          allowFailure: true,
        }).status,
        1,
        `refusing to reuse Docker container ${name}`,
      );
    }
    assert.equal(
      run(docker, ['network', 'inspect', network], {
        capture: true,
        quiet: true,
        allowFailure: true,
      }).status,
      1,
      'refusing to reuse Docker network',
    );
    run(docker, ['network', 'create', network], { capture: true, quiet: true });
    networkCreated = true;
    run(
      docker,
      [
        'run',
        '-d',
        '--privileged',
        '--network',
        network,
        '--name',
        server,
        '-p',
        '127.0.0.1::6443',
        K3S_IMAGE,
        'server',
        '--token',
        clusterToken,
        '--node-name',
        server,
        '--disable=traefik',
        '--disable=servicelb',
        '--write-kubeconfig-mode=600',
        '--tls-san=127.0.0.1',
      ],
      { capture: true, quiet: true },
    );
    createdContainers.add(server);
    await waitFor('K3s server readiness', 120_000, () => {
      const result = run(
        docker,
        ['exec', server, 'kubectl', 'get', '--raw=/readyz'],
        { capture: true, quiet: true, allowFailure: true },
      );
      return result.status === 0 && result.stdout === 'ok'
        ? { ready: true, value: true }
        : { ready: false, fact: result.stderr || result.stdout };
    });
    for (const agent of agents) {
      run(
        docker,
        [
          'run',
          '-d',
          '--privileged',
          '--network',
          network,
          '--name',
          agent,
          K3S_IMAGE,
          'agent',
          '--server',
          `https://${server}:6443`,
          '--token',
          clusterToken,
          '--node-name',
          agent,
        ],
        { capture: true, quiet: true },
      );
      createdContainers.add(agent);
    }
    const port = run(docker, ['port', server, '6443/tcp'], {
      capture: true,
      quiet: true,
    }).stdout;
    assert.match(port, /^127\.0\.0\.1:\d+$/);
    const config = run(
      docker,
      ['exec', server, 'cat', '/etc/rancher/k3s/k3s.yaml'],
      { capture: true, quiet: true },
    ).stdout.replace('https://127.0.0.1:6443', `https://${port}`);
    fs.writeFileSync(kubeconfig, `${config}\n`, { mode: 0o600, flag: 'wx' });
    const kubectl = (args, options = {}) =>
      run(kubectlBinary, ['--kubeconfig', kubeconfig, ...args], options);
    const kubectlJson = (args) =>
      JSON.parse(
        kubectl([...args, '-o', 'json'], {
          capture: true,
          quiet: true,
        }).stdout,
      );
    const apply = (manifest) =>
      kubectl(['apply', '-f', '-'], {
        input: `${JSON.stringify(manifest)}\n`,
        capture: true,
        quiet: true,
      });
    const create = (manifest) =>
      kubectl(['create', '-f', '-'], {
        input: `${JSON.stringify(manifest)}\n`,
        capture: true,
        quiet: true,
      });
    const loadOperationManifest = (name) =>
      yaml.load(
        fs.readFileSync(
          path.join(
            ROOT,
            'deploy/kubernetes/ql3-cluster/operations/' +
              'worker-credential-management-client/base',
            name,
          ),
          'utf8',
        ),
      );

    await waitFor('three K3s nodes', 180_000, () => {
      const nodes = kubectlJson(['get', 'nodes']).items ?? [];
      const ready = nodes.filter((node) =>
        node.status.conditions?.some(
          (condition) =>
            condition.type === 'Ready' && condition.status === 'True',
        ),
      );
      return ready.length === 3
        ? { ready: true, value: ready }
        : { ready: false, fact: `${ready.length}/3 Ready nodes` };
    });

    const sourceRevision = run('git', ['rev-parse', 'HEAD'], {
      capture: true,
      quiet: true,
    }).stdout;
    run(docker, [
      'build',
      '--file',
      'deploy/containers/ql3-cluster-admin/Dockerfile',
      '--tag',
      adminImage,
      '--build-arg',
      `SOURCE_REVISION=${sourceRevision}`,
      '.',
    ]);
    adminImageBuilt = true;
    run(docker, ['image', 'save', '--output', imageArchive, adminImage]);
    for (const node of [server, ...agents]) {
      run(docker, ['cp', imageArchive, `${node}:/tmp/ql3-admin.tar`], {
        capture: true,
        quiet: true,
      });
      run(
        docker,
        [
          'exec',
          node,
          'ctr',
          '--address',
          '/run/k3s/containerd/containerd.sock',
          '--namespace',
          'k8s.io',
          'images',
          'import',
          '/tmp/ql3-admin.tar',
        ],
        { capture: true, quiet: true },
      );
      run(docker, ['exec', node, 'rm', '-f', '/tmp/ql3-admin.tar'], {
        capture: true,
        quiet: true,
      });
    }
    fs.unlinkSync(imageArchive);

    fs.writeFileSync(
      serverExtensions,
      [
        'basicConstraints=CA:FALSE',
        'keyUsage=digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        `subjectAltName=DNS:${SERVERNAME},DNS:${SERVERNAME}.cluster.local`,
        '',
      ].join('\n'),
      { mode: 0o600, flag: 'wx' },
    );
    run(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=QL3 Worker Manager Live CA',
        '-keyout',
        caKey,
        '-out',
        caCertificate,
      ],
      { capture: true, quiet: true },
    );
    fs.mkdirSync(caNewCertificates, { mode: 0o700 });
    fs.writeFileSync(caDatabase, '', { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(caSerial, '1000\n', { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(caCrlNumber, '1000\n', { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(
      caConfig,
      [
        '[ca]',
        'default_ca=client_ca',
        '[client_ca]',
        `database=${caDatabase}`,
        `new_certs_dir=${caNewCertificates}`,
        `certificate=${caCertificate}`,
        `private_key=${caKey}`,
        `serial=${caSerial}`,
        `crlnumber=${caCrlNumber}`,
        'default_md=sha256',
        'default_days=1',
        'default_crl_days=1',
        'policy=client_policy',
        'unique_subject=no',
        'copy_extensions=none',
        '[client_policy]',
        'commonName=supplied',
        '[client_certificate]',
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=clientAuth',
        '',
      ].join('\n'),
      { mode: 0o600, flag: 'wx' },
    );
    for (const [commonName, keyFile, requestFile, certificateFile] of [
      [
        'ql3-worker-credential-management-client-old',
        clientOldKey,
        clientOldRequest,
        clientOldCertificate,
      ],
      [
        'ql3-worker-credential-management-client-new',
        clientNewKey,
        clientNewRequest,
        clientNewCertificate,
      ],
    ]) {
      run(
        'openssl',
        [
          'req',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-subj',
          `/CN=${commonName}`,
          '-keyout',
          keyFile,
          '-out',
          requestFile,
        ],
        { capture: true, quiet: true },
      );
      run(
        'openssl',
        [
          'ca',
          '-batch',
          '-notext',
          '-config',
          caConfig,
          '-extensions',
          'client_certificate',
          '-in',
          requestFile,
          '-out',
          certificateFile,
        ],
        { capture: true, quiet: true },
      );
    }
    run(
      'openssl',
      [
        'ca',
        '-gencrl',
        '-config',
        caConfig,
        '-out',
        clientCertificateRevocationList,
      ],
      { capture: true, quiet: true },
    );
    run(
      'openssl',
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        `/CN=${SERVERNAME}`,
        '-keyout',
        serverKey,
        '-out',
        serverRequest,
      ],
      { capture: true, quiet: true },
    );
    run(
      'openssl',
      [
        'x509',
        '-req',
        '-days',
        '1',
        '-in',
        serverRequest,
        '-CA',
        caCertificate,
        '-CAkey',
        caKey,
        '-CAcreateserial',
        '-extfile',
        serverExtensions,
        '-out',
        serverCertificate,
      ],
      { capture: true, quiet: true },
    );

    run(
      docker,
      [
        'run',
        '-d',
        '--network',
        network,
        '--name',
        postgres,
        '-p',
        '127.0.0.1::5432',
        '-e',
        `POSTGRES_DB=${POSTGRES_DATABASE}`,
        '-e',
        'POSTGRES_USER=postgres',
        '-e',
        `POSTGRES_PASSWORD=${POSTGRES_SUPERUSER_PASSWORD}`,
        POSTGRES_IMAGE,
      ],
      { capture: true, quiet: true },
    );
    createdContainers.add(postgres);
    await waitFor('PostgreSQL final TCP readiness', 60_000, () => {
      const result = run(
        docker,
        [
          'exec',
          postgres,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'postgres',
          '-d',
          POSTGRES_DATABASE,
        ],
        { capture: true, quiet: true, allowFailure: true },
      );
      return result.status === 0
        ? { ready: true, value: true }
        : { ready: false, fact: result.stderr || result.stdout };
    });
    const postgresEndpoint = run(docker, ['port', postgres, '5432/tcp'], {
      capture: true,
      quiet: true,
    }).stdout;
    assert.match(postgresEndpoint, /^127\.0\.0\.1:\d+$/);
    const postgresPort = Number(
      postgresEndpoint.slice(postgresEndpoint.lastIndexOf(':') + 1),
    );
    const postgresAddress = run(
      docker,
      [
        'inspect',
        '--format',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
        postgres,
      ],
      { capture: true, quiet: true },
    ).stdout;
    assert.match(postgresAddress, /^\d{1,3}(?:\.\d{1,3}){3}$/);

    const { createPostgresDatabaseOpener } = clusterRequire(
      '@qinglong/cluster-postgres/worker-credential-manager',
    );
    const { runPostgresMigrations } = clusterRequire(
      '@qinglong/cluster-postgres/migration',
    );
    const databaseUrl = ({ user, password }) =>
      `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(
        password,
      )}` + `@127.0.0.1:${postgresPort}/${POSTGRES_DATABASE}`;
    const openDatabase = (role, credential, applicationName) =>
      createPostgresDatabaseOpener({
        role,
        connection: {
          connectionString: databaseUrl(credential),
          tls: { mode: 'disable' },
        },
        pool: {
          applicationName,
          maxConnections: 1,
          connectionTimeoutMs: 2_000,
        },
        onPoolError() {},
      });
    const openMigrationDatabase = openDatabase(
      'migration',
      POSTGRES_ROLES.migration,
      'ql3-worker-manager-live-migration',
    );
    const bootstrap = await openDatabase(
      'migration',
      { user: 'postgres', password: POSTGRES_SUPERUSER_PASSWORD },
      'ql3-worker-manager-live-bootstrap',
    )();
    try {
      for (const credential of Object.values(POSTGRES_ROLES)) {
        await bootstrap.pool.query(
          `CREATE ROLE ${credential.user} LOGIN PASSWORD '${credential.password}'`,
        );
      }
      await bootstrap.pool.query(
        `ALTER DATABASE ${POSTGRES_DATABASE} OWNER TO ` +
          POSTGRES_ROLES.migration.user,
      );
    } finally {
      await bootstrap.close();
    }
    migrationDatabase = await openMigrationDatabase();
    await runPostgresMigrations({ pool: migrationDatabase.pool });
    const seededAtMs = Date.now();
    await migrationDatabase.pool.query(
      `INSERT INTO "ql3"."projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES (
         'cluster-authority', 'Cluster Authority', 'cluster-authority',
         'active', 1, $1, $1
       )`,
      [seededAtMs],
    );
    await migrationDatabase.pool.query(
      `INSERT INTO "ql3"."project_role_bindings" (
         project_id, subject_type, subject_id, version, state, role,
         mutation_id, changed_by_type, changed_by_id, created_at_ms
       ) VALUES (
         'cluster-authority', 'user', 'operator-a', 1, 'active', 'admin',
         'binding-operator-a-v1', 'user', 'owner-a', $1
       )`,
      [seededAtMs],
    );

    const oldKey = reviewedKey('worker-manager-key-1');
    const newKey = reviewedKey('worker-manager-key-2');
    const keyset1 = keyset(1, [oldKey]);
    const keyset2 = keyset(2, [oldKey, newKey]);
    const keyset3 = keyset(3, [oldKey, newKey], [oldKey.kid]);
    const caText = fs.readFileSync(caCertificate, 'utf8');
    const tlsCertificateText = fs.readFileSync(serverCertificate, 'utf8');
    const tlsKeyText = fs.readFileSync(serverKey, 'utf8');
    const clientOldCertificateText = fs.readFileSync(
      clientOldCertificate,
      'utf8',
    );
    const clientOldKeyText = fs.readFileSync(clientOldKey, 'utf8');
    const clientNewCertificateText = fs.readFileSync(
      clientNewCertificate,
      'utf8',
    );
    const clientNewKeyText = fs.readFileSync(clientNewKey, 'utf8');
    let activeClientCertificateText = clientOldCertificateText;
    let activeClientKeyText = clientOldKeyText;
    let clientCrlText = fs.readFileSync(
      clientCertificateRevocationList,
      'utf8',
    );
    const managerUrl =
      `postgresql://${encodeURIComponent(
        POSTGRES_ROLES.workerCredentialManager.user,
      )}` +
      `:${encodeURIComponent(
        POSTGRES_ROLES.workerCredentialManager.password,
      )}` +
      `@${postgresAddress}:5432/${POSTGRES_DATABASE}`;

    apply({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: NAMESPACE },
    });
    apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: TLS_SECRET, namespace: NAMESPACE },
      type: 'kubernetes.io/tls',
      stringData: {
        'tls.crt': tlsCertificateText,
        'tls.key': tlsKeyText,
        'ca.crt': caText,
        'client.crl': clientCrlText,
      },
    });
    const applyIdentity = (document) =>
      apply({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: IDENTITY_SECRET, namespace: NAMESPACE },
        type: 'Opaque',
        stringData: { 'keyset.json': `${JSON.stringify(document)}\n` },
      });
    applyIdentity(keyset1);
    apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: DATABASE_SECRET, namespace: NAMESPACE },
      type: 'Opaque',
      stringData: { 'postgres-worker-credential-manager-url': managerUrl },
    });
    apply({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: DEPLOYMENT, namespace: NAMESPACE },
      automountServiceAccountToken: false,
    });
    apply({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: SERVICE, namespace: NAMESPACE },
      spec: {
        type: 'ClusterIP',
        selector: {
          'app.kubernetes.io/name': DEPLOYMENT,
          'app.kubernetes.io/component': 'worker-credential-management',
        },
        ports: [
          { name: 'https', port: 8444, targetPort: 'https', protocol: 'TCP' },
        ],
      },
    });
    apply({
      apiVersion: 'policy/v1',
      kind: 'PodDisruptionBudget',
      metadata: { name: DEPLOYMENT, namespace: NAMESPACE },
      spec: {
        minAvailable: 1,
        selector: {
          matchLabels: {
            'app.kubernetes.io/name': DEPLOYMENT,
            'app.kubernetes.io/component': 'worker-credential-management',
          },
        },
      },
    });
    apply({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: DEPLOYMENT, namespace: NAMESPACE },
      spec: {
        podSelector: {
          matchLabels: {
            'app.kubernetes.io/name': DEPLOYMENT,
            'app.kubernetes.io/component': 'worker-credential-management',
          },
        },
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          {
            from: [
              {
                podSelector: {
                  matchLabels: {
                    'qinglong.io/worker-credential-management-client': 'true',
                  },
                },
              },
            ],
            ports: [{ protocol: 'TCP', port: 8444 }],
          },
        ],
        egress: [
          {
            to: [{ ipBlock: { cidr: `${postgresAddress}/32` } }],
            ports: [{ protocol: 'TCP', port: 5432 }],
          },
        ],
      },
    });
    apply({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: DEPLOYMENT, namespace: NAMESPACE },
      spec: {
        replicas: 2,
        minReadySeconds: 2,
        revisionHistoryLimit: 3,
        progressDeadlineSeconds: 300,
        strategy: {
          type: 'RollingUpdate',
          rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
        },
        selector: {
          matchLabels: {
            'app.kubernetes.io/name': DEPLOYMENT,
            'app.kubernetes.io/component': 'worker-credential-management',
          },
        },
        template: {
          metadata: {
            labels: {
              'app.kubernetes.io/name': DEPLOYMENT,
              'app.kubernetes.io/component': 'worker-credential-management',
              'app.kubernetes.io/part-of': 'qinglong3',
            },
            annotations: { 'qinglong.io/identity-generation': '1' },
          },
          spec: {
            serviceAccountName: DEPLOYMENT,
            automountServiceAccountToken: false,
            terminationGracePeriodSeconds: 10,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 10001,
              runAsGroup: 10001,
              fsGroup: 10001,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            affinity: {
              podAntiAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: [
                  {
                    topologyKey: 'kubernetes.io/hostname',
                    labelSelector: {
                      matchLabels: {
                        'app.kubernetes.io/name': DEPLOYMENT,
                        'app.kubernetes.io/component':
                          'worker-credential-management',
                      },
                    },
                  },
                ],
              },
            },
            containers: [
              {
                name: 'management',
                image: adminImage,
                imagePullPolicy: 'Never',
                command: [
                  'node',
                  '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/' +
                    'worker-credential/management-server/workerCredentialManagementCli.js',
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                env: [
                  { name: 'QL3_PROFILE', value: 'cluster-admin' },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_ENABLED',
                    value: 'true',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_HOST',
                    value: '0.0.0.0',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_PORT',
                    value: '8444',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_TLS_CERT_FILE',
                    value: '/var/run/secrets/qinglong3/management-tls/tls.crt',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_TLS_KEY_FILE',
                    value: '/var/run/secrets/qinglong3/management-tls/tls.key',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_CA_FILE',
                    value: '/var/run/secrets/qinglong3/management-tls/ca.crt',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_CRL_FILE',
                    value:
                      '/var/run/secrets/qinglong3/management-tls/client.crl',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_IDENTITY_KEYSET_FILE',
                    value: '/var/run/qinglong3/management-identity/keyset.json',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_QUOTA_WINDOW_MS',
                    value: '300000',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_PLAN_QUOTA',
                    value: '8',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_PROPOSE_QUOTA',
                    value: '32',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_DECIDE_QUOTA',
                    value: '32',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_INSPECT_QUOTA',
                    value: '128',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_MAX_CONNECTIONS',
                    value: '64',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_MAX_CONCURRENT_REQUESTS',
                    value: '32',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_RATE_WINDOW_MS',
                    value: '300000',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_PEER_REQUEST_LIMIT',
                    value: '128',
                  },
                  {
                    name: 'QL3_WORKER_CREDENTIAL_MANAGEMENT_GLOBAL_REQUEST_LIMIT',
                    value: '10000',
                  },
                  {
                    name: 'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_URL',
                    valueFrom: {
                      secretKeyRef: {
                        name: DATABASE_SECRET,
                        key: 'postgres-worker-credential-manager-url',
                      },
                    },
                  },
                  {
                    name: 'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_TLS_MODE',
                    value: 'disable',
                  },
                  {
                    name: 'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_ALLOW_INSECURE',
                    value: 'true',
                  },
                  {
                    name: 'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_MAX_CONNECTIONS',
                    value: '2',
                  },
                  {
                    name: 'QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_APPLICATION_NAME',
                    value: 'ql3-worker-manager-live',
                  },
                ],
                ports: [
                  { name: 'https', containerPort: 8444, protocol: 'TCP' },
                ],
                startupProbe: {
                  httpGet: { path: '/livez', port: 'https', scheme: 'HTTPS' },
                  periodSeconds: 2,
                  timeoutSeconds: 1,
                  failureThreshold: 45,
                },
                readinessProbe: {
                  httpGet: { path: '/readyz', port: 'https', scheme: 'HTTPS' },
                  periodSeconds: 2,
                  timeoutSeconds: 1,
                  failureThreshold: 2,
                },
                livenessProbe: {
                  httpGet: { path: '/livez', port: 'https', scheme: 'HTTPS' },
                  periodSeconds: 10,
                  timeoutSeconds: 2,
                  failureThreshold: 3,
                },
                resources: {
                  requests: { cpu: '50m', memory: '96Mi' },
                  limits: { cpu: '1', memory: '384Mi' },
                },
                volumeMounts: [
                  { name: 'tmp', mountPath: '/tmp' },
                  {
                    name: 'management-tls',
                    mountPath: '/var/run/secrets/qinglong3/management-tls',
                    readOnly: true,
                  },
                  {
                    name: 'management-identity',
                    mountPath: '/var/run/qinglong3/management-identity',
                    readOnly: true,
                  },
                ],
              },
            ],
            volumes: [
              {
                name: 'tmp',
                emptyDir: { medium: 'Memory', sizeLimit: '16Mi' },
              },
              {
                name: 'management-tls',
                secret: {
                  secretName: TLS_SECRET,
                  defaultMode: 288,
                  items: [
                    { key: 'tls.crt', path: 'tls.crt' },
                    { key: 'tls.key', path: 'tls.key' },
                    { key: 'ca.crt', path: 'ca.crt' },
                    { key: 'client.crl', path: 'client.crl' },
                  ],
                },
              },
              {
                name: 'management-identity',
                secret: {
                  secretName: IDENTITY_SECRET,
                  defaultMode: 292,
                  items: [{ key: 'keyset.json', path: 'keyset.json' }],
                },
              },
            ],
          },
        },
      },
    });

    const readyManagerPods = async (excludedUids = new Set()) =>
      waitFor('two Ready manager Pods on distinct nodes', 180_000, () => {
        const pods = kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'pods',
          '-l',
          `app.kubernetes.io/name=${DEPLOYMENT}`,
        ]).items.filter(
          (pod) =>
            pod.metadata.deletionTimestamp === undefined &&
            !excludedUids.has(pod.metadata.uid) &&
            pod.status.conditions?.some(
              (condition) =>
                condition.type === 'Ready' && condition.status === 'True',
            ),
        );
        const nodes = new Set(pods.map((pod) => pod.spec.nodeName));
        return pods.length === 2 && nodes.size === 2
          ? {
              ready: true,
              value: pods.sort((a, b) =>
                a.metadata.name.localeCompare(b.metadata.name),
              ),
            }
          : {
              ready: false,
              fact: `${pods.length} Ready Pods on ${nodes.size} nodes`,
            };
      });
    const patchGeneration = (generation) =>
      kubectl(
        [
          '-n',
          NAMESPACE,
          'patch',
          'deployment',
          DEPLOYMENT,
          '--type=merge',
          '-p',
          JSON.stringify({
            spec: {
              template: {
                metadata: {
                  annotations: {
                    'qinglong.io/identity-generation': generation,
                  },
                },
              },
            },
          }),
        ],
        { capture: true, quiet: true },
      );
    const waitRollout = () =>
      kubectl(
        [
          '-n',
          NAMESPACE,
          'rollout',
          'status',
          `deployment/${DEPLOYMENT}`,
          '--timeout=180s',
        ],
        { capture: true, quiet: true },
      );

    waitRollout();
    const generation1Pods = await readyManagerPods();
    assert.equal(
      new Set(generation1Pods.map((pod) => pod.spec.nodeName)).size,
      2,
    );
    for (const pod of generation1Pods) {
      assert.equal(pod.spec.automountServiceAccountToken, false);
      assert.equal(pod.spec.serviceAccountName, DEPLOYMENT);
      assert.equal(
        pod.spec.volumes.some((volume) =>
          volume.projected?.sources?.some(
            (source) => source.serviceAccountToken !== undefined,
          ),
        ),
        false,
      );
    }

    const clientShell = [
      'umask 077',
      'cp /var/run/qinglong3/client/client.json /tmp/client.json',
      'cp /var/run/qinglong3/client/command.json /tmp/command.json',
      'cp /var/run/qinglong3/client/assertion.jwt /tmp/assertion.jwt',
      'cp /var/run/qinglong3/client/ca.crt /tmp/ca.crt',
      'cp /var/run/qinglong3/client/client.crt /tmp/client.crt',
      'cp /var/run/qinglong3/client/client.key /tmp/client.key',
      'chmod 600 /tmp/client.json /tmp/command.json /tmp/assertion.jwt ' +
        '/tmp/ca.crt /tmp/client.crt /tmp/client.key',
      'set +e',
      'attempt=0',
      'while true; do',
      '  attempt=$((attempt + 1))',
      '  output="$(node /opt/qinglong/node_modules/@qinglong/cluster-admin/dist/' +
        'worker-credential/workerCredentialManagementClientCli.js ' +
        '--config=/tmp/client.json --command=/tmp/command.json ' +
        '--assertion=/tmp/assertion.jwt 2>&1)"',
      '  status=$?',
      '  if [ "$status" -eq 0 ] || ! printf \'%s\' "$output" | ' +
        'grep -q QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_REQUEST_FAILED || ' +
        '[ "$attempt" -ge 12 ]; then',
      '    break',
      '  fi',
      '  sleep 1',
      'done',
      'if [ "$status" -ne 0 ] && printf \'%s\' "$output" | ' +
        'grep -q QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_REQUEST_FAILED; then',
      '  diagnostic="$(node -e "$QL3_RAW_REQUEST_DIAGNOSTIC_SCRIPT" -- ' +
        '/tmp/client.json /tmp/command.json /tmp/assertion.jwt 2>&1)"',
      '  output="{\\"client\\":$output,\\"diagnostic\\":$diagnostic}"',
      'fi',
      'printf \'{"transportAttempts":%s}\\n%s\\n\' ' +
        '"$attempt" "$output" > /dev/termination-log',
      'printf \'%s\\n\' "$output"',
      'exit "$status"',
    ].join('\n');
    const clientConfig = Object.freeze({
      schemaVersion: 1,
      endpoint: `https://${SERVERNAME}:8444${MANAGEMENT_PATH}`,
      servername: SERVERNAME,
      caFile: '/tmp/ca.crt',
      clientCertificateFile: '/tmp/client.crt',
      clientPrivateKeyFile: '/tmp/client.key',
      requestTimeoutMs: 15_000,
    });
    const createClientJob = ({
      name,
      target,
      command,
      bearer,
      clientCertificateText = activeClientCertificateText,
      clientKeyText = activeClientKeyText,
    }) => {
      const inputSecret = `${name}-input`;
      create({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: inputSecret, namespace: NAMESPACE },
        type: 'Opaque',
        stringData: {
          'client.json': `${JSON.stringify(clientConfig)}\n`,
          'command.json': `${JSON.stringify(command)}\n`,
          'assertion.jwt': bearer,
          'ca.crt': caText,
          'client.crt': clientCertificateText,
          'client.key': clientKeyText,
        },
      });
      create({
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name, namespace: NAMESPACE },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: 60,
          ttlSecondsAfterFinished: 600,
          template: {
            metadata: {
              labels: {
                app: 'ql3-worker-manager-live-client',
                'qinglong.io/worker-credential-management-client': 'true',
              },
            },
            spec: {
              automountServiceAccountToken: false,
              restartPolicy: 'Never',
              hostAliases: [
                { ip: target.status.podIP, hostnames: [SERVERNAME] },
              ],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 10001,
                runAsGroup: 10001,
                fsGroup: 10001,
                seccompProfile: { type: 'RuntimeDefault' },
              },
              containers: [
                {
                  name: 'client',
                  image: adminImage,
                  imagePullPolicy: 'Never',
                  command: ['/bin/sh', '-c'],
                  args: [clientShell],
                  env: [
                    {
                      name: 'QL3_RAW_REQUEST_DIAGNOSTIC_SCRIPT',
                      value: RAW_REQUEST_DIAGNOSTIC_SCRIPT,
                    },
                  ],
                  terminationMessagePolicy: 'File',
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ['ALL'] },
                  },
                  resources: {
                    requests: { cpu: '10m', memory: '32Mi' },
                    limits: { cpu: '250m', memory: '128Mi' },
                  },
                  volumeMounts: [
                    { name: 'tmp', mountPath: '/tmp' },
                    {
                      name: 'client-input',
                      mountPath: '/var/run/qinglong3/client',
                      readOnly: true,
                    },
                  ],
                },
              ],
              volumes: [
                {
                  name: 'tmp',
                  emptyDir: { medium: 'Memory', sizeLimit: '4Mi' },
                },
                {
                  name: 'client-input',
                  secret: { secretName: inputSecret, defaultMode: 288 },
                },
              ],
            },
          },
        },
      });
      return Object.freeze({ name, target, command, bearer });
    };
    const waitClientJob = async (job, expected) => {
      const completion = await waitFor(
        `${job.name} completion`,
        120_000,
        () => {
          const current = kubectlJson([
            '-n',
            NAMESPACE,
            'get',
            'job',
            job.name,
          ]);
          const complete = current.status.conditions?.some(
            (condition) =>
              condition.type === 'Complete' && condition.status === 'True',
          );
          const failed = current.status.conditions?.some(
            (condition) =>
              condition.type === 'Failed' && condition.status === 'True',
          );
          return complete || failed
            ? { ready: true, value: { complete, failed } }
            : { ready: false, fact: JSON.stringify(current.status ?? {}) };
        },
      );
      const pods = kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'pods',
        '-l',
        `job-name=${job.name}`,
      ]).items;
      assert.equal(pods.length, 1);
      const terminated =
        pods[0].status.containerStatuses?.[0]?.state?.terminated;
      const outputText = terminated?.message ?? '';
      assert.equal(outputText.includes(job.bearer), false);
      assert.equal(
        outputText.includes(POSTGRES_ROLES.workerCredentialManager.password),
        false,
      );
      const outputLines = outputText.split('\n').filter(Boolean);
      const attemptFact = JSON.parse(outputLines[0]);
      assert.ok(Number.isSafeInteger(attemptFact.transportAttempts));
      assert.ok(attemptFact.transportAttempts >= 1);
      assert.ok(attemptFact.transportAttempts <= 12);
      const output = JSON.parse(outputLines.at(-1));
      const targetFailureEvidence = () => {
        const state = kubectl(
          [
            '-n',
            NAMESPACE,
            'get',
            'pod',
            job.target.metadata.name,
            '-o',
            'json',
          ],
          { capture: true, quiet: true, allowFailure: true },
        );
        const currentLogs = kubectl(
          [
            '-n',
            NAMESPACE,
            'logs',
            job.target.metadata.name,
            '--container=management',
            '--tail=80',
          ],
          { capture: true, quiet: true, allowFailure: true },
        );
        const previousLogs = kubectl(
          [
            '-n',
            NAMESPACE,
            'logs',
            job.target.metadata.name,
            '--container=management',
            '--previous',
            '--tail=80',
          ],
          { capture: true, quiet: true, allowFailure: true },
        );
        return Object.freeze({
          targetPod: job.target.metadata.name,
          expectedUid: job.target.metadata.uid,
          state: state.status === 0 ? JSON.parse(state.stdout) : state.stderr,
          currentLogs: currentLogs.stdout || currentLogs.stderr,
          previousLogs: previousLogs.stdout || previousLogs.stderr,
        });
      };
      if (expected.statusCode === 200) {
        if (!completion.complete || terminated?.exitCode !== 0) {
          throw new Error(
            `${job.name} unexpectedly failed: ${JSON.stringify({
              output,
              target: targetFailureEvidence(),
            })}`,
          );
        }
        assert.equal(completion.complete, true);
        assert.equal(terminated?.exitCode, 0);
        assert.equal(output.event, 'command_completed');
        assert.equal(output.result.operation, job.command.operation);
        if (expected.resultStatus !== undefined) {
          assert.equal(
            Array.isArray(expected.resultStatus)
              ? expected.resultStatus.includes(output.result.status)
              : output.result.status === expected.resultStatus,
            true,
          );
        }
      } else {
        if (!completion.failed || terminated?.exitCode !== 1) {
          throw new Error(
            `${job.name} unexpectedly succeeded: ${JSON.stringify(output)}`,
          );
        }
        assert.equal(completion.failed, true);
        assert.equal(terminated?.exitCode, 1);
        assert.equal(output.event, 'command_failed');
        assert.equal(output.statusCode, expected.statusCode);
        assert.equal(output.responseCode, expected.responseCode);
      }
      return Object.freeze({
        name: job.name,
        targetPod: job.target.metadata.name,
        targetPodUid: job.target.metadata.uid,
        targetNode: job.target.spec.nodeName,
        statusCode: expected.statusCode,
        transportAttempts: attemptFact.transportAttempts,
        output,
      });
    };
    const executeClient = async (definition, expected) => {
      const job = createClientJob(definition);
      return waitClientJob(job, expected);
    };
    const executeWave = async (definitions, expected) => {
      const jobs = definitions.map(createClientJob);
      return Promise.all(jobs.map((job) => waitClientJob(job, expected)));
    };
    const executeWithoutClientCertificate = async ({
      target,
      command,
      bearer,
    }) => {
      const name = 'ql3-wcm-no-client-certificate';
      const inputSecret = `${name}-input`;
      const rawConfig = {
        schemaVersion: 1,
        endpoint: clientConfig.endpoint,
        servername: clientConfig.servername,
        caFile: '/var/run/qinglong3/client/ca.crt',
        requestTimeoutMs: clientConfig.requestTimeoutMs,
      };
      create({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: inputSecret, namespace: NAMESPACE },
        type: 'Opaque',
        stringData: {
          'client.json': `${JSON.stringify(rawConfig)}\n`,
          'command.json': `${JSON.stringify(command)}\n`,
          'assertion.jwt': bearer,
          'ca.crt': caText,
        },
      });
      create({
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name, namespace: NAMESPACE },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: 60,
          ttlSecondsAfterFinished: 600,
          template: {
            metadata: {
              labels: {
                app: 'ql3-worker-manager-live-no-client-certificate',
                'qinglong.io/worker-credential-management-client': 'true',
              },
            },
            spec: {
              automountServiceAccountToken: false,
              restartPolicy: 'Never',
              hostAliases: [
                { ip: target.status.podIP, hostnames: [SERVERNAME] },
              ],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 10001,
                runAsGroup: 10001,
                fsGroup: 10001,
                seccompProfile: { type: 'RuntimeDefault' },
              },
              containers: [
                {
                  name: 'client',
                  image: adminImage,
                  imagePullPolicy: 'Never',
                  command: [
                    'node',
                    '-e',
                    RAW_REQUEST_DIAGNOSTIC_SCRIPT,
                    '--',
                    '/var/run/qinglong3/client/client.json',
                    '/var/run/qinglong3/client/command.json',
                    '/var/run/qinglong3/client/assertion.jwt',
                  ],
                  terminationMessagePolicy: 'File',
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ['ALL'] },
                  },
                  resources: {
                    requests: { cpu: '5m', memory: '16Mi' },
                    limits: { cpu: '100m', memory: '64Mi' },
                  },
                  volumeMounts: [
                    {
                      name: 'client-input',
                      mountPath: '/var/run/qinglong3/client',
                      readOnly: true,
                    },
                  ],
                },
              ],
              volumes: [
                {
                  name: 'client-input',
                  secret: { secretName: inputSecret, defaultMode: 288 },
                },
              ],
            },
          },
        },
      });
      await waitFor(`${name} completion`, 90_000, () => {
        const current = kubectlJson(['-n', NAMESPACE, 'get', 'job', name]);
        const complete = current.status.conditions?.some(
          (condition) =>
            condition.type === 'Complete' && condition.status === 'True',
        );
        return complete
          ? { ready: true, value: current }
          : { ready: false, fact: JSON.stringify(current.status ?? {}) };
      });
      const pods = kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'pods',
        '-l',
        `job-name=${name}`,
      ]).items;
      assert.equal(pods.length, 1);
      const terminated =
        pods[0].status.containerStatuses?.[0]?.state?.terminated;
      assert.equal(terminated?.exitCode, 0);
      const output = JSON.parse(terminated?.message ?? '{}');
      assert.equal(output.event, 'raw_request_completed');
      assert.equal(output.statusCode, 401);
      assert.equal(output.protocol, 'TLSv1.3');
      assert.equal(output.body.error.code, 'client_certificate_required');
      assert.equal(String(terminated?.message ?? '').includes(bearer), false);
      return Object.freeze({
        targetPod: target.metadata.name,
        statusCode: output.statusCode,
        responseCode: output.body.error.code,
      });
    };

    const executeConnectivity = async (target, index) => {
      const name = `ql3-wcm-initial-connectivity-${index + 1}`;
      create({
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name, namespace: NAMESPACE },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: 60,
          ttlSecondsAfterFinished: 600,
          template: {
            metadata: {
              labels: {
                app: 'ql3-worker-manager-live-connectivity',
                'qinglong.io/worker-credential-management-client': 'true',
              },
            },
            spec: {
              automountServiceAccountToken: false,
              restartPolicy: 'Never',
              hostAliases: [
                { ip: target.status.podIP, hostnames: [SERVERNAME] },
              ],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 10001,
                runAsGroup: 10001,
                fsGroup: 10001,
                seccompProfile: { type: 'RuntimeDefault' },
              },
              containers: [
                {
                  name: 'connectivity',
                  image: adminImage,
                  imagePullPolicy: 'Never',
                  command: [
                    'node',
                    '-e',
                    CONNECTIVITY_SCRIPT,
                    '--',
                    SERVERNAME,
                    '8444',
                  ],
                  terminationMessagePolicy: 'File',
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ['ALL'] },
                  },
                  resources: {
                    requests: { cpu: '5m', memory: '16Mi' },
                    limits: { cpu: '100m', memory: '64Mi' },
                  },
                  volumeMounts: [
                    {
                      name: 'ca',
                      mountPath: '/var/run/qinglong3/ca',
                      readOnly: true,
                    },
                  ],
                },
              ],
              volumes: [
                {
                  name: 'ca',
                  secret: {
                    secretName: TLS_SECRET,
                    defaultMode: 292,
                    items: [{ key: 'ca.crt', path: 'ca.crt' }],
                  },
                },
              ],
            },
          },
        },
      });
      await waitFor(`${name} completion`, 90_000, () => {
        const current = kubectlJson(['-n', NAMESPACE, 'get', 'job', name]);
        const complete = current.status.conditions?.some(
          (condition) =>
            condition.type === 'Complete' && condition.status === 'True',
        );
        const failed = current.status.conditions?.some(
          (condition) =>
            condition.type === 'Failed' && condition.status === 'True',
        );
        return complete || failed
          ? { ready: true, value: { complete, failed } }
          : { ready: false, fact: JSON.stringify(current.status ?? {}) };
      });
      const pods = kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'pods',
        '-l',
        `job-name=${name}`,
      ]).items;
      assert.equal(pods.length, 1);
      const terminated =
        pods[0].status.containerStatuses?.[0]?.state?.terminated;
      const output = JSON.parse(terminated?.message ?? '{}');
      assert.equal(terminated?.exitCode, 0);
      assert.equal(output.event, 'connectivity_ready');
      assert.equal(output.statusCode, 200);
      assert.equal(output.protocol, 'TLSv1.3');
      return Object.freeze({
        name,
        targetPod: target.metadata.name,
        targetNode: target.spec.nodeName,
        sourceNode: pods[0].spec.nodeName,
        attempts: output.attempts,
      });
    };
    const initialConnectivity = await Promise.all(
      generation1Pods.map(executeConnectivity),
    );
    const firstCommands = Array.from({ length: 8 }, (_, index) =>
      planCommand(index + 1),
    );
    const inspectExistingPlan = (suffix) =>
      inspectCommand(firstCommands[0].request.actionRef, suffix);
    const noClientCertificate = await executeWithoutClientCertificate({
      target: generation1Pods[0],
      command: inspectExistingPlan('no-client-certificate'),
      bearer: assertion(oldKey, 'operator-a', 'no-client-certificate'),
    });
    const firstWave = await executeWave(
      firstCommands.map((command, index) => ({
        name: `ql3-wcm-plan-admit-${String(index + 1).padStart(2, '0')}`,
        target: generation1Pods[index % 2],
        command,
        bearer: assertion(oldKey, 'operator-a', `admit-${index + 1}`),
      })),
      { statusCode: 200, resultStatus: ['created', 'existing'] },
    );
    const committedOperationName = 'ql3-worker-credential-management-client';
    const committedOperationCommand = inspectExistingPlan(
      'committed-operation',
    );
    const committedOperationAssertion = assertion(
      oldKey,
      'operator-a',
      'committed-operation',
    );
    create(loadOperationManifest('service-account.yaml'));
    create(loadOperationManifest('network-policy.yaml'));
    create({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'ql3-worker-credential-management-request',
        namespace: NAMESPACE,
      },
      immutable: true,
      data: {
        'client.json': `${JSON.stringify(clientConfig)}\n`,
        'command.json': `${JSON.stringify(committedOperationCommand)}\n`,
      },
    });
    create({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'ql3-worker-credential-management-client-trust',
        namespace: NAMESPACE,
      },
      immutable: true,
      data: { 'ca.crt': caText },
    });
    create({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'ql3-worker-credential-management-assertion',
        namespace: NAMESPACE,
      },
      immutable: true,
      type: 'Opaque',
      stringData: { 'assertion.jwt': committedOperationAssertion },
    });
    create({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: 'ql3-worker-credential-management-client-identity',
        namespace: NAMESPACE,
      },
      immutable: true,
      type: 'kubernetes.io/tls',
      stringData: {
        'tls.crt': activeClientCertificateText,
        'tls.key': activeClientKeyText,
      },
    });
    const committedOperationJob = loadOperationManifest('job.yaml');
    for (const candidate of [
      ...committedOperationJob.spec.template.spec.initContainers,
      ...committedOperationJob.spec.template.spec.containers,
    ]) {
      candidate.image = adminImage;
      candidate.imagePullPolicy = 'Never';
    }
    create(committedOperationJob);
    const committedOperationCompletion = await waitFor(
      'committed management client operation completion',
      150_000,
      () => {
        const current = kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'job',
          committedOperationName,
        ]);
        const complete = current.status.conditions?.some(
          (condition) =>
            condition.type === 'Complete' && condition.status === 'True',
        );
        const failed = current.status.conditions?.some(
          (condition) =>
            condition.type === 'Failed' && condition.status === 'True',
        );
        return complete || failed
          ? { ready: true, value: { complete, failed, current } }
          : { ready: false, fact: JSON.stringify(current.status ?? {}) };
      },
    );
    const committedOperationPods = kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'pods',
      '-l',
      `job-name=${committedOperationName}`,
    ]).items;
    assert.equal(committedOperationPods.length, 1);
    const committedOperationPod = committedOperationPods[0];
    const committedOperationInit =
      committedOperationPod.status.initContainerStatuses?.[0];
    const committedOperationClient =
      committedOperationPod.status.containerStatuses?.[0];
    assert.equal(committedOperationCompletion.complete, true);
    assert.equal(committedOperationCompletion.failed, false);
    assert.equal(committedOperationCompletion.current.status.succeeded, 1);
    assert.equal(committedOperationInit?.state?.terminated?.exitCode, 0);
    assert.equal(committedOperationInit?.restartCount, 0);
    assert.equal(committedOperationClient?.state?.terminated?.exitCode, 0);
    assert.equal(committedOperationClient?.restartCount, 0);
    assert.equal(
      committedOperationPod.spec.automountServiceAccountToken,
      false,
    );
    assert.equal(committedOperationPod.spec.enableServiceLinks, false);
    assert.equal(
      committedOperationPod.spec.serviceAccountName,
      committedOperationName,
    );
    assert.equal(
      committedOperationPod.spec.volumes.some((volume) =>
        volume.projected?.sources?.some(
          (source) => source.serviceAccountToken !== undefined,
        ),
      ),
      false,
    );
    assert.equal(
      committedOperationPod.metadata.labels?.[
        'qinglong.io/worker-credential-management-client'
      ],
      'true',
    );
    assert.equal(
      String(
        committedOperationClient?.state?.terminated?.message ?? '',
      ).includes(committedOperationAssertion),
      false,
    );
    assert.equal(
      String(
        committedOperationClient?.state?.terminated?.message ?? '',
      ).includes(POSTGRES_ROLES.workerCredentialManager.password),
      false,
    );
    for (const [kind, resourceName] of [
      ['configmap', 'ql3-worker-credential-management-request'],
      ['configmap', 'ql3-worker-credential-management-client-trust'],
      ['secret', 'ql3-worker-credential-management-assertion'],
      ['secret', 'ql3-worker-credential-management-client-identity'],
    ]) {
      assert.equal(
        kubectlJson(['-n', NAMESPACE, 'get', kind, resourceName]).immutable,
        true,
      );
    }
    const committedClientOperation = Object.freeze({
      job: committedOperationName,
      source: 'repository base manifests with test-only image substitution',
      initExitCode: committedOperationInit.state.terminated.exitCode,
      clientExitCode: committedOperationClient.state.terminated.exitCode,
      clientRestarts: committedOperationClient.restartCount,
      operation: committedOperationCommand.operation,
      completed: committedOperationCompletion.complete,
      assertionInTerminationMessage: false,
      serviceAccountTokenMounted: false,
      immutableInputs: true,
    });
    const limitedWave = await executeWave(
      Array.from({ length: 8 }, (_, index) => ({
        name: `ql3-wcm-plan-limit-${String(index + 1).padStart(2, '0')}`,
        target: generation1Pods[index % 2],
        command: planCommand(index + 9),
        bearer: assertion(oldKey, 'operator-a', `limit-${index + 1}`),
      })),
      { statusCode: 429, responseCode: 'quota_exceeded' },
    );
    const replay = await executeClient(
      {
        name: 'ql3-wcm-plan-replay-cross-pod',
        target: generation1Pods[1],
        command: firstCommands[0],
        bearer: assertion(oldKey, 'operator-a', 'replay-cross-pod'),
      },
      { statusCode: 200, resultStatus: 'existing' },
    );

    run(
      'openssl',
      ['ca', '-batch', '-config', caConfig, '-revoke', clientOldCertificate],
      { capture: true, quiet: true },
    );
    run(
      'openssl',
      [
        'ca',
        '-gencrl',
        '-config',
        caConfig,
        '-out',
        clientCertificateRevocationList,
      ],
      { capture: true, quiet: true },
    );
    clientCrlText = fs.readFileSync(clientCertificateRevocationList, 'utf8');
    apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: TLS_SECRET, namespace: NAMESPACE },
      type: 'kubernetes.io/tls',
      stringData: {
        'tls.crt': tlsCertificateText,
        'tls.key': tlsKeyText,
        'ca.crt': caText,
        'client.crl': clientCrlText,
      },
    });
    const preRevocationUids = new Set(
      generation1Pods.map((pod) => pod.metadata.uid),
    );
    patchGeneration('client-crl-2');
    waitRollout();
    const clientRevocationPods = await readyManagerPods(preRevocationUids);
    const revokedClientCertificate = await executeClient(
      {
        name: 'ql3-wcm-revoked-client-certificate',
        target: clientRevocationPods[0],
        command: inspectExistingPlan('revoked-client-certificate'),
        bearer: assertion(oldKey, 'operator-a', 'revoked-client-certificate'),
        clientCertificateText: clientOldCertificateText,
        clientKeyText: clientOldKeyText,
      },
      { statusCode: 401, responseCode: 'client_certificate_required' },
    );
    activeClientCertificateText = clientNewCertificateText;
    activeClientKeyText = clientNewKeyText;
    const activeClientCertificate = await executeClient(
      {
        name: 'ql3-wcm-active-client-certificate',
        target: clientRevocationPods[1],
        command: inspectExistingPlan('active-client-certificate'),
        bearer: assertion(oldKey, 'operator-a', 'active-client-certificate'),
      },
      { statusCode: 200 },
    );

    const generation1Uids = new Set(
      clientRevocationPods.map((pod) => pod.metadata.uid),
    );
    applyIdentity(keyset2);
    patchGeneration('2');
    waitRollout();
    const generation2Pods = await readyManagerPods(generation1Uids);
    const overlapOld = await executeClient(
      {
        name: 'ql3-wcm-overlap-old-key',
        target: generation2Pods[0],
        command: inspectExistingPlan('overlap-old'),
        bearer: assertion(oldKey, 'operator-a', 'overlap-old'),
      },
      { statusCode: 200 },
    );
    const overlapNew = await executeClient(
      {
        name: 'ql3-wcm-overlap-new-key',
        target: generation2Pods[1],
        command: inspectExistingPlan('overlap-new'),
        bearer: assertion(newKey, 'operator-a', 'overlap-new'),
      },
      { statusCode: 200 },
    );

    const generation2Uids = new Set(
      generation2Pods.map((pod) => pod.metadata.uid),
    );
    applyIdentity(keyset3);
    patchGeneration('3');
    waitRollout();
    const generation3Pods = await readyManagerPods(generation2Uids);
    const revokedOld = await executeClient(
      {
        name: 'ql3-wcm-revoked-old-key',
        target: generation3Pods[0],
        command: inspectExistingPlan('revoked-old'),
        bearer: assertion(oldKey, 'operator-a', 'revoked-old'),
      },
      { statusCode: 401, responseCode: 'authentication_required' },
    );
    const activeNew = await executeClient(
      {
        name: 'ql3-wcm-active-new-key',
        target: generation3Pods[1],
        command: inspectExistingPlan('active-new'),
        bearer: assertion(newKey, 'operator-a', 'active-new'),
      },
      { statusCode: 200 },
    );

    applyIdentity(keyset2);
    patchGeneration('rollback-2');
    const rollbackPod = await waitFor(
      'rollback surge Pod fail-closed',
      120_000,
      () => {
        const deployment = kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'deployment',
          DEPLOYMENT,
        ]);
        const pods = kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'pods',
          '-l',
          `app.kubernetes.io/name=${DEPLOYMENT}`,
        ]).items.filter((pod) => pod.metadata.deletionTimestamp === undefined);
        const ready = pods.filter((pod) =>
          pod.status.conditions?.some(
            (condition) =>
              condition.type === 'Ready' && condition.status === 'True',
          ),
        );
        const candidate = pods.find(
          (pod) =>
            !generation3Pods.some(
              (current) => current.metadata.uid === pod.metadata.uid,
            ) &&
            pod.status.containerStatuses?.[0] &&
            !pod.status.containerStatuses[0].ready &&
            (pod.status.containerStatuses[0].restartCount > 0 ||
              pod.status.containerStatuses[0].state?.waiting?.reason ===
                'CrashLoopBackOff'),
        );
        return ready.length === 2 &&
          deployment.status.readyReplicas === 2 &&
          candidate
          ? { ready: true, value: candidate }
          : {
              ready: false,
              fact:
                `ready=${ready.length} replicas=${
                  deployment.status.readyReplicas ?? 0
                } ` + `pods=${pods.length}`,
            };
      },
    );
    assert.equal(
      rollbackPod.status.containerStatuses[0].lastState?.terminated?.exitCode ??
        rollbackPod.status.containerStatuses[0].state?.terminated?.exitCode,
      1,
    );
    applyIdentity(keyset3);
    patchGeneration('3-recovered');
    kubectl(
      [
        '-n',
        NAMESPACE,
        'delete',
        'pod',
        rollbackPod.metadata.name,
        '--grace-period=0',
        '--force',
        '--wait=true',
      ],
      { capture: true, quiet: true },
    );
    waitRollout();
    const recoveredIdentityPods = await readyManagerPods();
    const recoveredIdentity = await Promise.all(
      recoveredIdentityPods.map((pod, index) =>
        executeClient(
          {
            name: `ql3-wcm-identity-recovered-${index + 1}`,
            target: pod,
            command: inspectExistingPlan(`identity-recovered-${index + 1}`),
            bearer: assertion(
              newKey,
              'operator-a',
              `identity-recovered-${index + 1}`,
            ),
          },
          { statusCode: 200 },
        ),
      ),
    );

    const beforeFailureFacts = (
      await migrationDatabase.pool.query(
        `SELECT
         (SELECT count(*)::integer
            FROM "ql3"."worker_credential_management_plans") AS "plans",
         (SELECT consumed_count::integer
            FROM "ql3"."worker_credential_management_quota_buckets"
           WHERE project_id = 'cluster-authority'
             AND subject_type = 'user'
             AND subject_id = 'operator-a'
             AND operation = 'worker-credential.plan') AS "consumedCount",
         (SELECT jsonb_array_length(receipt_ids)::integer
            FROM "ql3"."worker_credential_management_quota_buckets"
           WHERE project_id = 'cluster-authority'
             AND subject_type = 'user'
             AND subject_id = 'operator-a'
             AND operation = 'worker-credential.plan') AS "receiptCount",
         (SELECT generation::integer
            FROM "ql3"."plugin_package_identity_keyset_ledger"
           WHERE authority = 'worker-credential-management') AS "identityGeneration"`,
      )
    ).rows[0];
    assert.deepEqual(beforeFailureFacts, {
      plans: 8,
      consumedCount: 8,
      receiptCount: 8,
      identityGeneration: 3,
    });
    await migrationDatabase.close();
    migrationDatabase = undefined;

    const createHealthJob = ({ name, target }) => {
      create({
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name, namespace: NAMESPACE },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: 60,
          ttlSecondsAfterFinished: 600,
          template: {
            metadata: {
              labels: {
                app: 'ql3-worker-manager-live-health',
                'qinglong.io/worker-credential-management-client': 'true',
              },
            },
            spec: {
              automountServiceAccountToken: false,
              restartPolicy: 'Never',
              hostAliases: [
                { ip: target.status.podIP, hostnames: [SERVERNAME] },
              ],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 10001,
                runAsGroup: 10001,
                fsGroup: 10001,
                seccompProfile: { type: 'RuntimeDefault' },
              },
              containers: [
                {
                  name: 'health',
                  image: adminImage,
                  imagePullPolicy: 'Never',
                  command: [
                    'node',
                    '-e',
                    HEALTH_SCRIPT,
                    '--',
                    SERVERNAME,
                    '8444',
                  ],
                  terminationMessagePolicy: 'File',
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ['ALL'] },
                  },
                  resources: {
                    requests: { cpu: '5m', memory: '16Mi' },
                    limits: { cpu: '100m', memory: '64Mi' },
                  },
                  volumeMounts: [
                    {
                      name: 'ca',
                      mountPath: '/var/run/qinglong3/ca',
                      readOnly: true,
                    },
                  ],
                },
              ],
              volumes: [
                {
                  name: 'ca',
                  secret: {
                    secretName: TLS_SECRET,
                    defaultMode: 292,
                    items: [{ key: 'ca.crt', path: 'ca.crt' }],
                  },
                },
              ],
            },
          },
        },
      });
      return Object.freeze({ name, target });
    };
    const waitHealthJob = async (job) => {
      await waitFor(`${job.name} completion`, 90_000, () => {
        const current = kubectlJson(['-n', NAMESPACE, 'get', 'job', job.name]);
        const complete = current.status.conditions?.some(
          (condition) =>
            condition.type === 'Complete' && condition.status === 'True',
        );
        const failed = current.status.conditions?.some(
          (condition) =>
            condition.type === 'Failed' && condition.status === 'True',
        );
        return complete || failed
          ? { ready: true, value: current }
          : { ready: false, fact: JSON.stringify(current.status ?? {}) };
      });
      const pods = kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'pods',
        '-l',
        `job-name=${job.name}`,
      ]).items;
      assert.equal(pods.length, 1);
      const terminated =
        pods[0].status.containerStatuses?.[0]?.state?.terminated;
      assert.equal(terminated?.exitCode, 0);
      const output = JSON.parse(
        (terminated.message ?? '').split('\n').filter(Boolean).at(-1),
      );
      assert.deepEqual(
        output.responses.map((entry) => entry.protocol),
        ['TLSv1.3', 'TLSv1.3'],
      );
      return Object.freeze({
        targetPod: job.target.metadata.name,
        readyStatus: output.responses.find((entry) => entry.path === '/readyz')
          .statusCode,
        liveStatus: output.responses.find((entry) => entry.path === '/livez')
          .statusCode,
      });
    };
    const healthWave = async (label, pods) => {
      const jobs = pods.map((pod, index) =>
        createHealthJob({
          name: `ql3-wcm-health-${label}-${index + 1}`,
          target: pod,
        }),
      );
      return Promise.all(jobs.map(waitHealthJob));
    };

    run(docker, ['stop', '--time', '1', postgres], {
      capture: true,
      quiet: true,
    });
    const unavailableRequests = await Promise.all(
      recoveredIdentityPods.map((pod, index) =>
        executeClient(
          {
            name: `ql3-wcm-postgres-down-${index + 1}`,
            target: pod,
            command: inspectExistingPlan(`postgres-down-${index + 1}`),
            bearer: assertion(
              newKey,
              'operator-a',
              `postgres-down-${index + 1}`,
            ),
          },
          { statusCode: 503, responseCode: 'unavailable' },
        ),
      ),
    );
    const withdrawnHealth = await healthWave(
      'withdrawn',
      recoveredIdentityPods,
    );
    assert.deepEqual(
      withdrawnHealth.map((entry) => entry.readyStatus),
      [503, 503],
    );
    assert.deepEqual(
      withdrawnHealth.map((entry) => entry.liveStatus),
      [200, 200],
    );
    await waitFor(
      'manager readiness withdrawn from both replicas',
      30_000,
      () => {
        const current = kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'deployment',
          DEPLOYMENT,
        ]);
        return (current.status.readyReplicas ?? 0) === 0
          ? { ready: true, value: current }
          : {
              ready: false,
              fact: `${
                current.status.readyReplicas ?? 0
              } replicas remain Ready`,
            };
      },
    );

    run(docker, ['start', postgres], { capture: true, quiet: true });
    await waitFor('restarted PostgreSQL readiness', 60_000, () => {
      const result = run(
        docker,
        [
          'exec',
          postgres,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'postgres',
          '-d',
          POSTGRES_DATABASE,
        ],
        { capture: true, quiet: true, allowFailure: true },
      );
      return result.status === 0
        ? { ready: true, value: true }
        : { ready: false, fact: result.stderr || result.stdout };
    });
    const stillWithdrawnHealth = await healthWave(
      'still-withdrawn',
      recoveredIdentityPods,
    );
    assert.deepEqual(
      stillWithdrawnHealth.map((entry) => entry.readyStatus),
      [503, 503],
    );
    const withdrawnUids = new Set(
      recoveredIdentityPods.map((pod) => pod.metadata.uid),
    );
    patchGeneration('3-fresh-postgres');
    waitRollout();
    const freshPods = await readyManagerPods(withdrawnUids);
    const freshRequests = await Promise.all(
      freshPods.map((pod, index) =>
        executeClient(
          {
            name: `ql3-wcm-postgres-fresh-${index + 1}`,
            target: pod,
            command: inspectExistingPlan(`postgres-fresh-${index + 1}`),
            bearer: assertion(
              newKey,
              'operator-a',
              `postgres-fresh-${index + 1}`,
            ),
          },
          { statusCode: 200 },
        ),
      ),
    );

    const finalFacts = JSON.parse(
      run(
        docker,
        [
          'exec',
          '-e',
          `PGPASSWORD=${POSTGRES_ROLES.workerCredentialManager.password}`,
          postgres,
          'psql',
          '-U',
          POSTGRES_ROLES.workerCredentialManager.user,
          '-d',
          POSTGRES_DATABASE,
          '--tuples-only',
          '--no-align',
          '--command',
          `SELECT json_build_object(
         'plans', (SELECT count(*)::integer
           FROM "ql3"."worker_credential_management_plans"),
         'consumedCount', (SELECT consumed_count::integer
           FROM "ql3"."worker_credential_management_quota_buckets"
          WHERE project_id = 'cluster-authority'
            AND subject_type = 'user'
            AND subject_id = 'operator-a'
            AND operation = 'worker-credential.plan'),
         'receiptCount', (SELECT jsonb_array_length(receipt_ids)::integer
           FROM "ql3"."worker_credential_management_quota_buckets"
          WHERE project_id = 'cluster-authority'
            AND subject_type = 'user'
            AND subject_id = 'operator-a'
            AND operation = 'worker-credential.plan'),
         'identityGeneration', (SELECT generation::integer
           FROM "ql3"."plugin_package_identity_keyset_ledger"
          WHERE authority = 'worker-credential-management'),
         'activeKeyIds', (SELECT active_key_ids
           FROM "ql3"."plugin_package_identity_keyset_ledger"
          WHERE authority = 'worker-credential-management'),
         'revokedKeyIds', (SELECT revoked_key_ids
           FROM "ql3"."plugin_package_identity_keyset_ledger"
          WHERE authority = 'worker-credential-management'))`,
        ],
        { capture: true, quiet: true },
      ).stdout,
    );
    assert.deepEqual(finalFacts, {
      plans: 8,
      consumedCount: 8,
      receiptCount: 8,
      identityGeneration: 3,
      activeKeyIds: [newKey.kid],
      revokedKeyIds: [oldKey.kid],
    });

    const report = {
      schemaVersion: 1,
      fixture:
        'qinglong/worker-credential-management-kubernetes-live-contract@v1',
      kubernetes: {
        distribution: 'k3s',
        image: K3S_IMAGE,
        imageDigest: K3S_DIGEST,
        architecture: k3sImage.Architecture,
        serverVersion: kubectlJson(['version']).serverVersion.gitVersion,
        nodes: kubectlJson(['get', 'nodes']).items.map((node) => ({
          name: node.metadata.name,
          uid: node.metadata.uid,
        })),
      },
      postgresql: {
        image: POSTGRES_IMAGE,
        imageId: postgresImage.Id,
        architecture: postgresImage.Architecture,
        database: POSTGRES_DATABASE,
        managerRole: POSTGRES_ROLES.workerCredentialManager.user,
        maxConnectionsPerPod: 2,
      },
      deployment: {
        replicas: 2,
        requiredPodAntiAffinity: true,
        initialConnectivityChecks: initialConnectivity.length,
        generation1Pods: generation1Pods.map((pod) => ({
          name: pod.metadata.name,
          uid: pod.metadata.uid,
          node: pod.spec.nodeName,
        })),
        generation2Pods: generation2Pods.map((pod) => ({
          name: pod.metadata.name,
          uid: pod.metadata.uid,
          node: pod.spec.nodeName,
        })),
        generation3Pods: generation3Pods.map((pod) => ({
          name: pod.metadata.name,
          uid: pod.metadata.uid,
          node: pod.spec.nodeName,
        })),
        freshPostgresPods: freshPods.map((pod) => ({
          name: pod.metadata.name,
          uid: pod.metadata.uid,
          node: pod.spec.nodeName,
        })),
        serviceAccountAutomount: false,
        projectedServiceAccountToken: false,
        exactPostgresEgressCidr: `${postgresAddress}/32`,
      },
      managementClientOperation: committedClientOperation,
      clientCertificateAuthentication: {
        healthWithoutClientCertificate: initialConnectivity.length === 2,
        businessRouteWithoutClientCertificateStatus:
          noClientCertificate.statusCode,
        businessRouteWithoutClientCertificateCode:
          noClientCertificate.responseCode,
        revokedCertificateStatus: revokedClientCertificate.statusCode,
        activeCertificateStatus: activeClientCertificate.statusCode,
        rotationRequiresServerRollout: true,
      },
      quota: {
        competingPods: 2,
        admitted: firstWave.length,
        limited: limitedWave.length,
        requestsPerPodPerWave: 4,
        crossPodReplayStatus: replay.output.result.status,
        durablePlans: finalFacts.plans,
        durableConsumedCount: finalFacts.consumedCount,
        durableReceiptCount: finalFacts.receiptCount,
      },
      identity: {
        generations: [1, 2, 3],
        overlapOldAccepted: overlapOld.statusCode === 200,
        overlapNewAccepted: overlapNew.statusCode === 200,
        revokedOldRejected: revokedOld.statusCode === 401,
        activeNewAccepted: activeNew.statusCode === 200,
        rollbackPod: {
          name: rollbackPod.metadata.name,
          uid: rollbackPod.metadata.uid,
          exitCode: 1,
        },
        readyReplicasDuringRollback: 2,
        recoveredReplicas: recoveredIdentity.length,
        durableGeneration: finalFacts.identityGeneration,
        activeKeyIds: finalFacts.activeKeyIds,
        revokedKeyIds: finalFacts.revokedKeyIds,
      },
      availability: {
        unavailableResponses: unavailableRequests.map(
          (entry) => entry.statusCode,
        ),
        withdrawnReadyStatuses: withdrawnHealth.map(
          (entry) => entry.readyStatus,
        ),
        withdrawnLiveStatuses: withdrawnHealth.map((entry) => entry.liveStatus),
        stillWithdrawnAfterDatabaseRestart: stillWithdrawnHealth.every(
          (entry) => entry.readyStatus === 503,
        ),
        freshActivationResponses: freshRequests.map(
          (entry) => entry.statusCode,
        ),
      },
      gates: {
        realThreeNodeKubernetes: true,
        twoManagerPodsOnDistinctNodes: true,
        tls13ProductionClientAcrossBothPods: true,
        committedOneShotClientOperation: true,
        clientCertificateAndOidcRequiredForBusinessRoutes: true,
        revokedClientCertificateRejectedAfterRollout: true,
        durableQuotaConvergedAcrossPods: true,
        crossPodReplayConsumedNoAdditionalQuota: true,
        identityProjectionOverlapAndRevocation: true,
        rollbackSurgeFailedClosedWithoutAvailabilityLoss: true,
        databaseFailureWithdrewReadinessButNotLiveness: true,
        availabilityFenceDidNotRecoverInPlace: true,
        freshActivationRecoveredBothReplicas: true,
        passed: true,
      },
      limitations: [
        'three privileged K3s Docker nodes are not production infrastructure or control-plane HA evidence',
        'PostgreSQL transport is deliberately plaintext only inside the isolated disposable live fixture',
        'database failure uses container stop rather than a raw-wire or CNI partition',
        'identity assertions use deterministic local strong-User ceremony rather than an external IdP',
      ],
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (migrationDatabase) {
      await migrationDatabase.close().catch(() => undefined);
    }
    for (const name of [...createdContainers].reverse()) {
      run(docker, ['rm', '-f', '-v', name], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
    if (networkCreated) {
      run(docker, ['network', 'rm', network], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
    if (adminImageBuilt) {
      run(docker, ['image', 'rm', '-f', adminImage], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `ql3 Worker credential manager Kubernetes live contract failed: ` +
      `${error.stack || error}\n`,
  );
  process.exitCode = 1;
});
