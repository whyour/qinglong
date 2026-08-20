#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const MIB = 1024 * 1024;
const fixtures = path.resolve(
  __dirname,
  '../packages/ql3-cluster-control/test/fixtures/mtls',
);
const {
  remoteWorkerArchitectureForNodeRuntime,
  remoteWorkerSupportTierForArchitecture,
} = require('../packages/ql3-runtime-core/dist/remote-execution/remoteWorkerCompatibility.js');

function argumentsMap() {
  return new Map(
    process.argv.slice(2).map((argument) => {
      const separator = argument.indexOf('=');
      return separator === -1
        ? [argument, true]
        : [argument.slice(0, separator), argument.slice(separator + 1)];
    }),
  );
}

function positiveNumber(args, name) {
  const raw = args.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

async function writePrivate(pathname, value, mode) {
  await fs.writeFile(pathname, value, { mode });
  await fs.chmod(pathname, mode);
}

async function child() {
  const profile = process.env.QL3_WORKER_BENCH_PROFILE;
  if (profile !== 'edge' && profile !== 'node') {
    throw new Error('Worker benchmark profile is invalid');
  }
  const origin = process.env.QL3_WORKER_BENCH_ORIGIN;
  if (!origin) throw new Error('Worker benchmark origin is missing');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-worker-bench-'));
  const authority = path.join(root, 'authority');
  const state = path.join(root, 'state');
  await fs.mkdir(authority, { mode: 0o700 });
  await fs.mkdir(state, { mode: 0o700 });
  await fs.chmod(authority, 0o700);
  await fs.chmod(state, 0o700);
  const [
    ca,
    certificate,
    privateKey,
  ] = await Promise.all([
    fs.readFile(path.join(fixtures, 'ca-cert.pem')),
    fs.readFile(path.join(fixtures, 'client-cert.pem')),
    fs.readFile(path.join(fixtures, 'client-key.pem')),
  ]);
  const capabilitiesFile = path.join(authority, 'capabilities.json');
  const caFile = path.join(authority, 'ca.crt');
  const certificateFile = path.join(authority, 'tls.crt');
  const privateKeyFile = path.join(authority, 'tls.key');
  const tokenFile = path.join(authority, 'credential-token');
  const architecture = remoteWorkerArchitectureForNodeRuntime(
    process.arch, process.config.variables.arm_version,
  );
  await Promise.all([
    writePrivate(
      capabilitiesFile,
      `${JSON.stringify({
        architecture,
        operatingSystem: process.platform,
        executors: ['remote-worker'],
        protocolVersion: '1.0.0',
        supportTier: remoteWorkerSupportTierForArchitecture(architecture),
        runtimes: [{ name: 'node', version: process.versions.node }],
        labels: {},
        capacity: {
          cpuCores: profile === 'edge' ? 1 : 8,
          memoryBytes: (profile === 'edge' ? 256 : 1024) * MIB,
        },
        features: [],
      })}\n`,
      0o400,
    ),
    writePrivate(caFile, ca, 0o400),
    writePrivate(certificateFile, certificate, 0o400),
    writePrivate(privateKeyFile, privateKey, 0o600),
    writePrivate(
      tokenFile,
      `ql3w_worker_primary_${Buffer.alloc(32, 7).toString('base64url')}\n`,
      0o600,
    ),
  ]);
  ca.fill(0);
  certificate.fill(0);
  privateKey.fill(0);

  let signalListener;
  let activeRssBytes = 0;
  const events = [];
  const startedAt = process.hrtime.bigint();
  const { runProductionWorkerProcess } = require(
    '../packages/ql3-worker-runtime/dist/process/workerProcessApplication',
  );
  try {
    await runProductionWorkerProcess({
      environment: {
        QL_DEPLOYMENT_PROFILE: 'worker',
        QL3_WORKER_RUNTIME_ENABLED: 'true',
        QL3_WORKER_ID: `benchmark-${profile}`,
        QL3_WORKER_CONTROL_ORIGIN: origin,
        QL3_WORKER_CAPACITY_PROFILE: profile,
        QL3_WORKER_CAPABILITIES_FILE: capabilitiesFile,
        QL3_WORKER_JOURNAL_ROOT: path.join(state, 'journal'),
        QL3_WORKER_LOG_ROOT: path.join(state, 'logs'),
        QL3_WORKER_RECEIPT_ROOT: path.join(state, 'receipts'),
        QL3_WORKER_CERTIFICATE_STORE_ROOT: path.join(state, 'identity'),
        QL3_WORKER_TRUST_ANCHOR_FILE: caFile,
        QL3_WORKER_CREDENTIAL_TOKEN_FILE: tokenFile,
        QL3_WORKER_IDENTITY_BOOTSTRAP_PRIVATE_KEY_FILE: privateKeyFile,
        QL3_WORKER_IDENTITY_BOOTSTRAP_CERTIFICATE_FILE: certificateFile,
      },
      signals: {
        subscribe(listener) {
          signalListener = listener;
          return () => {
            signalListener = undefined;
          };
        },
      },
      emit(event) {
        events.push(event.event);
        if (event.event === 'active') {
          activeRssBytes = process.memoryUsage().rss;
          setImmediate(() => signalListener?.('SIGTERM'));
        }
      },
    });
    const elapsedMs =
      Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const maxRssBytes = process.resourceUsage().maxRSS * 1024;
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        profile,
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        activeRssBytes,
        maxRssBytes,
        lifecycleMs: Number(elapsedMs.toFixed(3)),
        events,
      })}\n`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function parent() {
  const args = argumentsMap();
  const profile = args.get('--profile') ?? 'edge';
  if (profile !== 'edge' && profile !== 'node') {
    throw new Error('--profile must be edge or node');
  }
  const [
    ca,
    serverCertificate,
    serverKey,
  ] = await Promise.all([
    fs.readFile(path.join(fixtures, 'ca-cert.pem')),
    fs.readFile(path.join(fixtures, 'server-cert.pem')),
    fs.readFile(path.join(fixtures, 'server-key.pem')),
  ]);
  let version = -1;
  let requests = 0;
  const sockets = new Set();
  const server = https.createServer(
    {
      ca,
      cert: serverCertificate,
      key: serverKey,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      requestCert: true,
      rejectUnauthorized: true,
    },
    (request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const match = request.url.match(
            /^\/api\/v3\/worker-ingress\/workers\/benchmark-(edge|node)\/sessions\/([^/]+)\/(register|heartbeat|transition)$/,
          );
          assert(match);
          assert.equal(request.socket.authorized, true);
          assert.equal(request.socket.getProtocol(), 'TLSv1.3');
          assert.match(
            request.headers.authorization,
            /^Worker ql3w_worker_primary_/,
          );
          sockets.add(request.socket);
          requests += 1;
          version += 1;
          const status =
            match[3] === 'register' ? 'online' : body.status ?? 'online';
          const payload = {
            schema: body.schema,
            workerId: `benchmark-${match[1]}`,
            sessionId: match[2],
            generation: 1,
            version,
            status,
            leaseExpiresAtMs: Date.now() + 45_000,
            ...(match[3] === 'register' ? { replacedSession: false } : {}),
          };
          const encoded = JSON.stringify(payload);
          response.writeHead(200, {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(encoded)),
          });
          response.end(encoded);
        } catch {
          response.writeHead(500);
          response.end();
        }
      });
    },
  );
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    const report = await new Promise((resolve, reject) => {
      const childProcess = fork(__filename, [], {
        env: {
          PATH: process.env.PATH,
          QL3_WORKER_BENCH_CHILD: 'true',
          QL3_WORKER_BENCH_PROFILE: profile,
          QL3_WORKER_BENCH_ORIGIN: `https://127.0.0.1:${address.port}`,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let stdout = '';
      let stderr = '';
      childProcess.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      childProcess.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      childProcess.once('error', reject);
      childProcess.once('exit', (code, signal) => {
        if (code !== 0) {
          reject(
            new Error(
              `Worker benchmark child failed (${code ?? signal}): ${stderr}`,
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
    assert.deepEqual(report.events, [
      'starting',
      'active',
      'shutdown_requested',
      'stopped',
    ]);
    assert.equal(requests, 3);
    assert.equal(sockets.size, 1);
    const maxActiveRssMb = positiveNumber(args, '--max-active-rss-mb');
    const maxPeakRssMb = positiveNumber(args, '--max-peak-rss-mb');
    const violations = [];
    if (
      maxActiveRssMb !== undefined &&
      report.activeRssBytes > maxActiveRssMb * MIB
    ) {
      violations.push(
        `active RSS ${report.activeRssBytes} exceeded ${maxActiveRssMb} MiB`,
      );
    }
    if (
      maxPeakRssMb !== undefined &&
      report.maxRssBytes > maxPeakRssMb * MIB
    ) {
      violations.push(
        `peak RSS ${report.maxRssBytes} exceeded ${maxPeakRssMb} MiB`,
      );
    }
    const output = {
      ...report,
      tls: {
        protocol: 'TLSv1.3',
        mutualAuthentication: true,
        requests,
        sockets: sockets.size,
      },
      gates: {
        maxActiveRssMb: maxActiveRssMb ?? null,
        maxPeakRssMb: maxPeakRssMb ?? null,
        passed: violations.length === 0,
        violations,
      },
    };
    process.stdout.write(
      `${JSON.stringify(output, null, args.has('--json') ? 0 : 2)}\n`,
    );
    if (violations.length > 0) process.exitCode = 1;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    ca.fill(0);
    serverCertificate.fill(0);
    serverKey.fill(0);
  }
}

(process.env.QL3_WORKER_BENCH_CHILD === 'true' ? child() : parent()).catch(
  (error) => {
    process.stderr.write(
      `ql3 Worker resource benchmark failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  },
);
