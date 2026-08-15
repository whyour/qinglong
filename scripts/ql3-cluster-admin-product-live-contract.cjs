'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/u;
const ENTRYPOINT = [
  'node',
  '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/product-cli/cli.js',
];
const COMMANDS = Object.freeze([
  Object.freeze({
    name: 'copilot',
    usage: 'Usage: ql3-copilot-client ',
  }),
  Object.freeze({
    name: 'copilot-mcp',
    usage: 'Usage: ql3-copilot-mcp --config ',
  }),
  Object.freeze({
    name: 'copilot-console',
    usage: 'Usage:\n  ql3-copilot-console --config ',
  }),
  Object.freeze({
    name: 'package',
    usage: 'Usage: ql3-plugin-package-client ',
  }),
  Object.freeze({
    name: 'package-kubernetes',
    usage: 'Usage: ql3-plugin-package-client-kubernetes ',
  }),
  Object.freeze({
    name: 'worker-credential',
    usage: 'Usage: ql3-worker-credential-client ',
  }),
  Object.freeze({ name: 'approval', usage: 'Usage: ql3-approval-client ' }),
  Object.freeze({ name: 'run', usage: 'Usage: ql3-run-client ' }),
  Object.freeze({ name: 'automation', usage: 'Usage: ql3-automation-client ' }),
  Object.freeze({
    name: 'model-credential',
    usage: 'Usage: ql3-provider-credential-client ',
  }),
]);

function fail(message) {
  throw new Error(`ql3 Cluster Admin product live contract failed: ${message}`);
}

function parseArguments(argv) {
  if (argv.length !== 1) fail('exactly one --image argument is required');
  const match = /^--image=(.+)$/u.exec(argv[0]);
  if (!match || !IMAGE_PATTERN.test(match[1]))
    fail('image argument is invalid');
  return match[1];
}

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function dockerLogs(container) {
  const result = spawnSync('docker', ['logs', container], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    fail('published Console logs are unavailable');
  }
  return `${result.stdout}${result.stderr}`;
}

function runImage(image, args) {
  return docker([
    'run',
    '--rm',
    '--read-only',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '10001:10001',
    '--pids-limit',
    '32',
    '--memory',
    '128m',
    '--cpus',
    '0.25',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=8m,mode=700,uid=10001,gid=10001',
    image,
    ...args,
  ]);
}

function runOperatorContextContract(image) {
  const fixtureRoot = resolve(
    __dirname,
    '../packages/ql3-cluster-control/test/fixtures/mtls',
  );
  const readinessServerSource = String.raw`
const { readFileSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:https');
const server = createServer({ key: readFileSync('/evidence/server-key.pem'), cert: readFileSync('/evidence/server-cert.pem'), minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, (request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.once('end', () => {
    writeFileSync('/tmp/readiness-observation.json', JSON.stringify({ method: request.method, path: request.url, authorization: request.headers.authorization ?? null, bodyBytes: Buffer.concat(chunks).length }), { mode: 0o600 });
    const body = Buffer.from(JSON.stringify({ schemaVersion: 1, status: 'ready' }));
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
    response.end(body);
  });
});
server.listen(0, '127.0.0.1', () => writeFileSync('/tmp/readiness-port', String(server.address().port), { mode: 0o600 }));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
`;
  const source = String.raw`
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { rootCertificates } = require('node:tls');
const facade = '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/product-cli/cli.js';
const config = '/tmp/run-client.json';
const command = '/tmp/command.json';
const assertion = '/tmp/assertion.jwt';
const context = '/tmp/operator-context.json';
const ca = '/tmp/management-ca.pem';
for (const [file, contents] of [
  [config, '{}'],
  [command, '{}'],
  [assertion, 'a.b.c'],
  [context, JSON.stringify({ schemaVersion: 1, commands: { run: { configFile: config } } })],
]) writeFileSync(file, contents, { mode: 0o600 });
const injected = spawnSync(process.execPath, [facade, 'run', '--context=' + context, '--command=' + command, '--assertion=' + assertion], { encoding: 'utf8' });
let injectedFailure;
try { injectedFailure = JSON.parse(injected.stderr); } catch { process.exit(21); }
if (injected.status !== 1 || injectedFailure.code !== 'QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_CONFIG_INVALID' || injected.stdout !== '') process.exit(22);
writeFileSync(ca, rootCertificates[0], { mode: 0o600 });
writeFileSync(config, JSON.stringify({ schemaVersion: 1, endpoint: 'https://manager.example.test:8443/api/v3/plugin-packages/management', servername: 'manager.example.test', caFile: ca, requestTimeoutMs: 1000 }), { mode: 0o600 });
writeFileSync(context, JSON.stringify({ schemaVersion: 1, commands: { package: { configFile: config } } }), { mode: 0o600 });
const validated = spawnSync(process.execPath, [facade, 'context', 'validate', '--context=' + context], { encoding: 'utf8' });
let validationFact;
try { validationFact = JSON.parse(validated.stdout); } catch { process.exit(25); }
if (validated.status !== 0 || validated.stderr !== '' || validationFact.event !== 'context_valid' || validationFact.commandCount !== 1 || validationFact.networkAccess !== false || validationFact.mutation !== false || JSON.stringify(validationFact.commands) !== JSON.stringify([{ name: 'package', transport: 'https', clientCertificate: 'forbidden' }]) || validated.stdout.includes('/tmp/') || validated.stdout.includes('manager.example.test')) process.exit(26);
const readinessServer = spawn(process.execPath, ['-e', ${JSON.stringify(
    readinessServerSource,
  )}], { stdio: 'ignore' });
const waitArray = new Int32Array(new SharedArrayBuffer(4));
for (let attempt = 0; attempt < 200 && !existsSync('/tmp/readiness-port'); attempt += 1) Atomics.wait(waitArray, 0, 0, 10);
if (!existsSync('/tmp/readiness-port')) process.exit(27);
const readinessPort = Number(readFileSync('/tmp/readiness-port', 'utf8'));
writeFileSync(ca, readFileSync('/evidence/ca-cert.pem'), { mode: 0o600 });
writeFileSync(config, JSON.stringify({ schemaVersion: 1, endpoint: 'https://localhost:' + readinessPort + '/api/v3/plugin-packages/management', servername: 'localhost', caFile: ca, requestTimeoutMs: 1000 }), { mode: 0o600 });
const probed = spawnSync(process.execPath, [facade, 'context', 'probe', '--context=' + context], { encoding: 'utf8' });
readinessServer.kill('SIGTERM');
let probeFact;
try { probeFact = JSON.parse(probed.stdout); } catch { process.exit(28); }
if (probed.status !== 0 || probed.stderr !== '' || probeFact.event !== 'context_probed' || probeFact.commandCount !== 1 || probeFact.allReady !== true || probeFact.requestMethod !== 'GET' || probeFact.requestPath !== '/readyz' || probeFact.mutation !== false || JSON.stringify(probeFact.commands) !== JSON.stringify([{ name: 'package', transport: 'https', status: 'ready' }]) || probed.stdout.includes('/tmp/') || probed.stdout.includes('localhost')) process.exit(29);
let readinessObservation;
try { readinessObservation = JSON.parse(readFileSync('/tmp/readiness-observation.json', 'utf8')); } catch { process.exit(30); }
if (JSON.stringify(readinessObservation) !== JSON.stringify({ method: 'GET', path: '/readyz', authorization: null, bodyBytes: 0 })) process.exit(31);
writeFileSync(context, JSON.stringify({ schemaVersion: 1, commands: { run: { configFile: config, assertionFile: assertion } } }), { mode: 0o600 });
const rejected = spawnSync(process.execPath, [facade, 'run', '--context=' + context, '--command=' + command, '--assertion=' + assertion], { encoding: 'utf8' });
let rejectedFailure;
try { rejectedFailure = JSON.parse(rejected.stderr); } catch { process.exit(23); }
if (rejected.status !== 78 || rejectedFailure.code !== 'QL3_CLUSTER_PRODUCT_CONTEXT_INVALID' || rejected.stdout !== '' || rejected.stderr.includes('/tmp/') || rejected.stderr.includes('assertion.jwt')) process.exit(24);
process.stdout.write(JSON.stringify({ schemaVersion: 1, injected: true, contextPreflight: true, contextReadiness: true, secretFieldsRejected: true }));
`;
  const output = docker([
    'run',
    '--rm',
    '--read-only',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '10001:10001',
    '--pids-limit',
    '32',
    '--memory',
    '128m',
    '--cpus',
    '0.25',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=8m,mode=700,uid=10001,gid=10001',
    '--volume',
    `${resolve(fixtureRoot, 'ca-cert.pem')}:/evidence/ca-cert.pem:ro`,
    '--volume',
    `${resolve(fixtureRoot, 'server-cert.pem')}:/evidence/server-cert.pem:ro`,
    '--volume',
    `${resolve(fixtureRoot, 'server-key.pem')}:/evidence/server-key.pem:ro`,
    '--entrypoint',
    'node',
    image,
    '-e',
    source,
  ]);
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    fail('operator context result is invalid');
  }
  if (
    result?.schemaVersion !== 1 ||
    result?.injected !== true ||
    result?.contextPreflight !== true ||
    result?.contextReadiness !== true ||
    result?.secretFieldsRejected !== true
  ) {
    fail('operator context contract drifted');
  }
}

function runConsoleContract(image) {
  const source = String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { get } = require('node:http');
const { rootCertificates } = require('node:tls');
const facade = '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/product-cli/cli.js';
const config = '/tmp/copilot-client.json';
const credential = '/tmp/copilot-credential';
const session = '/tmp/copilot-session';
writeFileSync('/tmp/ca.pem', rootCertificates[0], { mode: 0o600 });
writeFileSync(config, JSON.stringify({ schema: 'qinglong/cluster-copilot-client-config@v1', endpoint: 'https://localhost:65535/', servername: 'localhost', caFile: '/tmp/ca.pem', requestTimeoutMs: 1000 }), { mode: 0o600 });
writeFileSync(credential, 'ql3c_console_' + Buffer.alloc(32, 9).toString('base64url'), { mode: 0o600 });
writeFileSync(session, 'A'.repeat(43), { mode: 0o600 });
const child = spawn(process.execPath, [facade, 'copilot-console', '--config', config, '--credential', credential, '--session', session, '--port=0'], { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let settled = false;
const timeout = setTimeout(() => finish(41), 5000);
function finish(code) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  process.exitCode = code;
}
child.once('error', () => finish(42));
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString('utf8');
  const newline = stdout.indexOf('\n');
  if (newline === -1 || settled) return;
  let started;
  try { started = JSON.parse(stdout.slice(0, newline)); } catch { finish(43); return; }
  if (started.event !== 'started' || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(started.origin) || JSON.stringify(started.operations) !== JSON.stringify(['inspect', 'output']) || started.mutation !== false) { finish(44); return; }
  get(started.origin, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.once('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (response.statusCode !== 200 || !body.includes('Cluster field console') || !body.includes('/app.css') || !body.includes('/app.js')) { finish(45); return; }
      child.once('close', (status, signal) => {
        if (status !== 0 || signal !== null) { finish(46); return; }
        settled = true;
        clearTimeout(timeout);
        process.stdout.write(JSON.stringify({ loopback: true, assets: true, cleanShutdown: true }));
      });
      child.kill('SIGTERM');
    });
  }).once('error', () => finish(47));
});
`;
  const output = docker([
    'run',
    '--rm',
    '--read-only',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '10001:10001',
    '--pids-limit',
    '32',
    '--memory',
    '128m',
    '--cpus',
    '0.25',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=8m,mode=700,uid=10001,gid=10001',
    '--entrypoint',
    'node',
    image,
    '-e',
    source,
  ]);
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    fail('Console live result is invalid');
  }
  if (
    result?.loopback !== true ||
    result?.assets !== true ||
    result?.cleanShutdown !== true
  ) {
    fail('Console live contract drifted');
  }
}

function runPublishedConsoleContract(image) {
  const suffix = `${process.pid}-${Date.now()}`;
  const network = `ql3-console-live-${suffix}`;
  const container = `ql3-console-live-${suffix}`;
  const containerPort = Number(
    execFileSync(
      process.execPath,
      [
        '-e',
        "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});",
      ],
      { encoding: 'utf8', timeout: 5_000 },
    ),
  );
  if (!Number.isSafeInteger(containerPort) || containerPort < 1_024) {
    fail('published Console test port is invalid');
  }
  const source = String.raw`
const { spawn } = require('node:child_process');
const { statSync, writeFileSync } = require('node:fs');
const { rootCertificates } = require('node:tls');
const facade = '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/product-cli/cli.js';
const share = '/opt/qinglong/share/ql3-copilot-console';
for (const [file, mode] of [['docker-loopback.sh', 0o555], ['verify-release.sh', 0o555], ['README.md', 0o444], ['client-config.example.json', 0o444], ['host-environment.example.json', 0o444]]) {
  if ((statSync(share + '/' + file).mode & 0o777) !== mode) process.exit(51);
}
writeFileSync('/tmp/ca.pem', rootCertificates[0], { mode: 0o600 });
writeFileSync('/tmp/client.json', JSON.stringify({ schema: 'qinglong/cluster-copilot-client-config@v1', endpoint: 'https://localhost:65535/', servername: 'localhost', caFile: '/tmp/ca.pem', requestTimeoutMs: 1000 }), { mode: 0o600 });
writeFileSync('/tmp/credential', 'ql3c_console_' + Buffer.alloc(32, 7).toString('base64url'), { mode: 0o600 });
writeFileSync('/tmp/session', Buffer.alloc(32, 11).toString('base64url'), { mode: 0o600 });
const child = spawn(process.execPath, [facade, 'copilot-console', '--container-published-loopback', '--port=${containerPort}', '--config', '/tmp/client.json', '--credential', '/tmp/credential', '--session', '/tmp/session'], { stdio: 'inherit' });
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
process.once('SIGTERM', () => child.kill('SIGTERM'));
process.once('SIGINT', () => child.kill('SIGINT'));
`;
  let createdNetwork = false;
  let createdContainer = false;
  try {
    docker(['network', 'create', '--driver', 'bridge', network]);
    createdNetwork = true;
    docker([
      'run',
      '--detach',
      '--name',
      container,
      '--read-only',
      '--network',
      network,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '10001:10001',
      '--pids-limit',
      '32',
      '--memory',
      '192m',
      '--cpus',
      '0.25',
      '--stop-timeout',
      '3',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=8m,mode=700,uid=10001,gid=10001',
      '--publish',
      `127.0.0.1:${containerPort}:${containerPort}/tcp`,
      '--entrypoint',
      'node',
      image,
      '-e',
      source,
    ]);
    createdContainer = true;

    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    let logs = '';
    for (let attempt = 0; attempt < 200; attempt += 1) {
      logs = dockerLogs(container);
      if (logs.includes('"event":"started"')) break;
      Atomics.wait(waitArray, 0, 0, 25);
    }
    const startedLine = logs
      .split('\n')
      .find((line) => line.includes('"event":"started"'));
    if (!startedLine) {
      const state = JSON.parse(docker(['inspect', container]))[0]?.State;
      let terminalCode = 'absent';
      for (const line of logs.trim().split('\n').reverse()) {
        try {
          const fact = JSON.parse(line);
          terminalCode = fact.code ?? fact.event ?? 'unknown';
          break;
        } catch {}
      }
      fail(
        `published Console did not start (running=${String(state?.Running)}, exit=${String(state?.ExitCode)}, code=${terminalCode})`,
      );
    }
    let started;
    try {
      started = JSON.parse(startedLine);
    } catch {
      fail('published Console start fact is invalid');
    }
    if (
      started?.origin !== `http://127.0.0.1:${containerPort}` ||
      started?.networkBoundary !== 'container-published-loopback' ||
      started?.publishedHostAddress !== '127.0.0.1'
    ) {
      fail('published Console boundary fact drifted');
    }

    const published = docker([
      'port',
      container,
      `${containerPort}/tcp`,
    ]).trim();
    const publishedMatch = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(
      published,
    );
    if (!publishedMatch) fail('published Console escaped host loopback');
    const origin = `http://127.0.0.1:${publishedMatch[1]}`;
    const probe = execFileSync(
      process.execPath,
      [
        '-e',
        "require('node:http').get(process.argv[1],(r)=>{const c=[];r.on('data',(x)=>c.push(x));r.on('end',()=>{const b=Buffer.concat(c).toString('utf8');if(r.statusCode!==200||!b.includes('Cluster field console'))process.exit(2);process.stdout.write(JSON.stringify({status:r.statusCode,assets:b.includes('/app.css')&&b.includes('/app.js')}));});}).on('error',()=>process.exit(3));",
        origin,
      ],
      { encoding: 'utf8', timeout: 5_000 },
    );
    const probeFact = JSON.parse(probe);
    if (probeFact.status !== 200 || probeFact.assets !== true) {
      fail('published Console host read drifted');
    }

    const inspected = JSON.parse(docker(['inspect', container]))[0];
    const binding =
      inspected?.HostConfig?.PortBindings?.[`${containerPort}/tcp`]?.[0];
    if (
      inspected?.HostConfig?.ReadonlyRootfs !== true ||
      inspected?.HostConfig?.NetworkMode !== network ||
      binding?.HostIp !== '127.0.0.1' ||
      inspected?.HostConfig?.Privileged !== false ||
      !inspected?.HostConfig?.CapDrop?.includes('ALL')
    ) {
      fail('published Console container authority drifted');
    }
  } finally {
    if (createdContainer) {
      try {
        docker(['stop', '--time', '3', container]);
      } catch {}
      try {
        docker(['rm', '--force', container]);
      } catch {}
    }
    if (createdNetwork) {
      try {
        docker(['network', 'rm', network]);
      } catch {}
    }
  }
}

function main() {
  if (process.env.QL3_CLUSTER_ADMIN_PRODUCT_LIVE !== '1') {
    fail('QL3_CLUSTER_ADMIN_PRODUCT_LIVE=1 is required');
  }
  const image = parseArguments(process.argv.slice(2));
  const inspected = JSON.parse(docker(['image', 'inspect', image]));
  if (!Array.isArray(inspected) || inspected.length !== 1) {
    fail('image inspection shape is invalid');
  }
  const fact = inspected[0];
  if (
    fact?.Os !== 'linux' ||
    (fact?.Architecture !== 'amd64' && fact?.Architecture !== 'arm64') ||
    fact?.Config?.User !== '10001:10001' ||
    JSON.stringify(fact?.Config?.Entrypoint) !== JSON.stringify(ENTRYPOINT) ||
    !Number.isSafeInteger(fact?.Size) ||
    fact.Size <= 0
  ) {
    fail('image platform, identity, entrypoint or size contract drifted');
  }

  const help = runImage(image, ['--help']);
  if (
    !help.startsWith('Usage: ql3-cluster-admin <command> [arguments]\n') ||
    !help.includes(
      'Server, migration, recovery, executor and key-custody authorities remain isolated.',
    )
  ) {
    fail('product help contract drifted');
  }
  for (const { name, usage } of COMMANDS) {
    const output = runImage(image, [name, '--help']);
    if (!output.startsWith(usage)) {
      fail(`${name} delegation contract drifted`);
    }
  }
  const version = runImage(image, ['--version']).trim();
  if (version !== '3.0.0-alpha.0') fail('product version contract drifted');
  runOperatorContextContract(image);
  runConsoleContract(image);
  runPublishedConsoleContract(image);

  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      image,
      architecture: fact.Architecture,
      user: fact.Config.User,
      imageBytes: fact.Size,
      commandCount: COMMANDS.length,
      operatorContext: true,
      contextPreflight: true,
      contextReadiness: true,
      consoleLoopback: true,
      consoleAssets: true,
      consolePublishedHostAddress: '127.0.0.1',
      consoleDistributionEmbedded: true,
      isolation: Object.freeze({
        readOnlyRoot: true,
        network: 'none',
        capabilities: 'none',
        noNewPrivileges: true,
        pids: 32,
        memoryBytes: 128 * 1024 * 1024,
        cpus: 0.25,
      }),
      compatible: true,
    })}\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'unknown failure'}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = { parseArguments };
