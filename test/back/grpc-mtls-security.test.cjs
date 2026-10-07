const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const grpc = require('@grpc/grpc-js');
const load = require('../helpers/load-security-module.cjs');
const logger = { info() {}, debug() {}, warn() {}, error() {} };

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ql-grpc's-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const module = load(path.resolve('back/config/grpcCerts.ts'), {
    './index': { configPath: root },
    './util': { fileExist: async (p) => fs.existsSync(p) },
    '../loaders/logger': logger,
    ...extra,
  });
  return { root, module };
}

test('gRPC keys use a private reserved workspace and clean up all OpenSSL side files', async (t) => {
  const workspaces = new Set();
  const { root, module } = fixture(t, {
    child_process: {
      ...childProcess,
      execFileSync: (file, args, opts) => {
        const temporary = args.find((arg) => arg.includes('/.generate-'));
        const workspace = path.dirname(temporary);
        workspaces.add(workspace);
        assert.equal(fs.statSync(workspace).mode & 0o777, 0o700);
        return childProcess.execFileSync(file, args, opts);
      },
    },
  });
  const certs = await module.initGrpcCerts();
  assert.match(certs.serverCert, /BEGIN CERTIFICATE/);
  assert.equal(workspaces.size, 1);
  for (const dir of workspaces) assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'grpc')).sort(), [
    'ca.crt',
    'ca.key',
    'client.crt',
    'client.key',
    'server.crt',
    'server.key',
  ]);
  for (const file of ['ca.key', 'client.key', 'server.key']) {
    assert.equal(
      fs.statSync(path.join(root, 'grpc', file)).mode & 0o777,
      0o600,
    );
  }
  assert.strictEqual(await module.initGrpcCerts(), certs);
});

test('gRPC certificate generation cleans partial files on OpenSSL errors', async (t) => {
  const { root, module } = fixture(t, {
    child_process: {
      execFileSync: (_file, args) => {
        fs.writeFileSync(args[2], 'partial private key');
        throw new Error('openssl failed');
      },
    },
  });
  await assert.rejects(module.initGrpcCerts(), /openssl failed/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'grpc')), []);
});

test('real gRPC server rejects plaintext and TLS without client certificates, accepts mTLS', async (t) => {
  const { module } = fixture(t);
  const certs = await module.initGrpcCerts();
  let port;
  let checks = 0;
  const Grpc = load(path.resolve('back/services/grpc.ts'), {
    '../config': { bindHostGrpc: '127.0.0.1', grpcPort: 0 },
    '../config/grpcCerts': { initGrpcCerts: async () => certs },
    '../loaders/logger': logger,
    './metrics': { metricsService: { record() {} } },
    typedi: { Service: () => (x) => x },
    '@grpc/grpc-js': {
      ...grpc,
      Server: class extends grpc.Server {
        bindAsync(address, creds, cb) {
          super.bindAsync(address, creds, (e, boundPort) => {
            port = boundPort;
            cb(e, boundPort);
          });
        }
      },
    },
    '../schedule/addCron': {},
    '../schedule/delCron': {},
    '../schedule/setConcurrency': {},
    '../schedule/api': {},
    '../schedule/health': {
      check: (_call, cb) => {
        checks++;
        cb(null, { status: 1 });
      },
    },
  }).GrpcServerService;
  const server = new Grpc();
  await server.initialize();
  t.after(() => server.shutdown());
  const HealthClient = load(path.resolve('back/protos/health.ts')).HealthClient;
  const request = async (credentials) => {
    const client = new HealthClient(`localhost:${port}`, credentials, {
      'grpc.enable_http_proxy': 0,
    });
    try {
      return await new Promise((resolve, reject) => {
        client.check({}, { deadline: Date.now() + 2000 }, (e, reply) =>
          e ? reject(e) : resolve(reply),
        );
      });
    } finally {
      client.close();
    }
  };
  await assert.rejects(request(grpc.credentials.createInsecure()));
  await assert.rejects(
    request(grpc.credentials.createSsl(Buffer.from(certs.caCert))),
  );
  assert.equal(checks, 0);
  const reply = await request(
    grpc.credentials.createSsl(
      Buffer.from(certs.caCert),
      Buffer.from(certs.clientKey),
      Buffer.from(certs.clientCert),
    ),
  );
  assert.equal(reply.status, 1);
  assert.equal(checks, 1);
});
