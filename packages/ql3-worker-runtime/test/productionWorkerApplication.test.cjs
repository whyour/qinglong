'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  startProductionWorkerApplication,
} = require('@qinglong/worker-runtime/product');
const {
  startProductionWorkerHeadlessApplicationWithStack,
} = require('@qinglong/worker-runtime/production');

const AUTHORIZATION = `Worker ql3w_worker_primary_${Buffer.alloc(
  32,
  7,
).toString('base64url')}`;
const fixtures = path.resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls',
);

async function material(name) {
  return fs.readFile(path.join(fixtures, name));
}

async function temporaryStorage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-worker-product-'));
  return {
    root,
    storage: {
      journalRoot: path.join(root, 'journal'),
      logRoot: path.join(root, 'logs'),
      receiptRoot: path.join(root, 'receipts'),
    },
  };
}

function capabilities() {
  return {
    architecture: 'x64',
    operatingSystem: 'linux',
    executors: ['local_process'],
    runtimes: [{ name: 'node', version: '24.14.0' }],
    labels: {},
    capacity: { cpuCores: 1, memoryBytes: 256 * 1024 * 1024 },
    features: [],
  };
}

test('owns one TLS Agent across register, drain and offline', async () => {
  const [ca, serverCertificate, serverKey, clientCertificate, clientKey] =
    await Promise.all([
      material('ca-cert.pem'),
      material('server-cert.pem'),
      material('server-key.pem'),
      material('client-cert.pem'),
      material('client-key.pem'),
    ]);
  const temporary = await temporaryStorage();
  const observations = [];
  const sockets = new Set();
  let version = -1;
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
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const match = request.url.match(
          /^\/api\/v3\/worker-ingress\/workers\/edge-1\/sessions\/([^/]+)\/(register|transition)$/,
        );
        assert.ok(match);
        sockets.add(request.socket);
        observations.push({
          operation: match[2],
          status: body.status,
          availableSlots: body.availableSlots,
          authorized: request.socket.authorized,
          protocol: request.socket.getProtocol(),
        });
        version += 1;
        const status = match[2] === 'register' ? 'online' : body.status;
        const payload = {
          schema: body.schema,
          workerId: 'edge-1',
          sessionId: match[1],
          generation: 1,
          version,
          status,
          leaseExpiresAtMs: 46_000,
          ...(match[2] === 'register' ? { replacedSession: false } : {}),
        };
        const encoded = JSON.stringify(payload);
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(encoded)),
        });
        response.end(encoded);
      });
    },
  );
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const application = await startProductionWorkerApplication({
      enabled: true,
      profile: 'worker',
      capacityProfile: 'edge',
      origin: `https://127.0.0.1:${address.port}`,
      credentials: {
        async load() {
          return {
            authorization: AUTHORIZATION,
            certificateChainPem: clientCertificate,
            privateKeyPem: clientKey,
            trustAnchors: [ca],
          };
        },
      },
      workerId: 'edge-1',
      capabilities: capabilities(),
      maxConcurrentRuns: 2,
      storage: temporary.storage,
      cadenceMs: 60_000,
      drainTimeoutMs: 1_000,
      drainPollMs: 25,
      now: () => 1_000,
    });
    assert.equal(application.status, 'active');
    assert.equal(await application.stop(), 'stopped');
    assert.equal(await application.stop(), 'stopped');
    assert.equal(sockets.size, 1);
    assert.deepEqual(observations, [
      {
        operation: 'register',
        status: undefined,
        availableSlots: 2,
        authorized: true,
        protocol: 'TLSv1.3',
      },
      {
        operation: 'transition',
        status: 'draining',
        availableSlots: undefined,
        authorized: true,
        protocol: 'TLSv1.3',
      },
      {
        operation: 'transition',
        status: 'offline',
        availableSlots: undefined,
        authorized: true,
        protocol: 'TLSv1.3',
      },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(temporary.root, { recursive: true, force: true });
  }
});

test('rejects an unsettled startup journal before Session registration', async () => {
  const temporary = await temporaryStorage();
  let registers = 0;
  let releases = 0;
  const options = {
    enabled: true,
    profile: 'worker',
    capacityProfile: 'edge',
    origin: 'https://worker-control.invalid',
    credentials: {
      async load() {
        throw new Error('not used');
      },
    },
    session: {
      current() {
        return undefined;
      },
      async register() {
        registers += 1;
      },
      async beginDrain() {},
    },
    storage: temporary.storage,
  };
  const stack = {
    journal: {
      async listOffers() {
        return {
          records: [{ state: 'accepted', offer: { offerId: 'offer-1' } }],
        };
      },
    },
    lifecycle: {
      async start() {
        return 'started';
      },
      async stop() {
        releases += 1;
      },
    },
    client: { close() {} },
    offerTransport: { close() {} },
    ownsClient: false,
  };
  try {
    await assert.rejects(
      startProductionWorkerHeadlessApplicationWithStack(options, stack),
      /startup_recovery_required/,
    );
    assert.equal(registers, 0);
    assert.equal(releases, 1);
  } finally {
    await fs.rm(temporary.root, { recursive: true, force: true });
  }
});

test('rejects unavailable startup identity before Session registration', async () => {
  const temporary = await temporaryStorage();
  let registers = 0;
  let fences = 0;
  let releases = 0;
  let transportCloses = 0;
  const options = {
    enabled: true,
    profile: 'worker',
    capacityProfile: 'edge',
    origin: 'https://worker-control.invalid',
    credentials: {
      async load() {
        throw new Error('not used');
      },
    },
    certificateRenewal: {
      async run() {
        return { status: 'unavailable', nextAttemptAtMs: 2_000 };
      },
    },
    session: {
      current() {
        return undefined;
      },
      async register() {
        registers += 1;
      },
      failClosed() {
        fences += 1;
      },
      async beginDrain() {},
    },
    storage: temporary.storage,
  };
  const stack = {
    journal: {
      async listOffers() {
        return { records: [] };
      },
    },
    lifecycle: {
      async start() {},
      async tick() {
        return { status: 'reconciled', processed: 0 };
      },
      async stop() {
        releases += 1;
      },
    },
    client: { close() {} },
    offerTransport: {
      close() {
        transportCloses += 1;
      },
    },
    ownsClient: false,
  };
  try {
    await assert.rejects(
      startProductionWorkerHeadlessApplicationWithStack(options, stack),
      /certificate_unavailable/,
    );
    assert.equal(registers, 0);
    assert.equal(fences, 1);
    assert.equal(releases, 1);
    assert.equal(transportCloses, 1);
  } finally {
    await fs.rm(temporary.root, { recursive: true, force: true });
  }
});

test('drives Session and execution in one cadence and releases ownership last', async () => {
  const temporary = await temporaryStorage();
  const events = [];
  let status;
  let draining = false;
  const options = {
    enabled: true,
    profile: 'worker',
    capacityProfile: 'edge',
    origin: 'https://worker-control.invalid',
    credentials: {
      async load() {
        throw new Error('not used');
      },
    },
    session: {
      current() {
        return status === undefined
          ? undefined
          : {
              workerId: 'edge-1',
              sessionId: '018f0000-0000-7000-8000-000000000001',
              generation: 1,
              status,
              leaseExpiresAtMs: Date.now() + 60_000,
            };
      },
      async register() {
        events.push('session:register');
        status = 'available';
      },
      async tick() {
        events.push('session:tick');
      },
      async beginDrain() {
        events.push('session:drain');
        status = 'draining';
      },
      async disconnect() {
        events.push('session:offline');
        status = 'offline';
      },
    },
    storage: temporary.storage,
    cadenceMs: 60_000,
    drainTimeoutMs: 1_000,
    drainPollMs: 25,
  };
  let startup = true;
  const stack = {
    journal: {
      async listOffers() {
        return { records: [] };
      },
    },
    lifecycle: {
      async start() {
        events.push('execution:start');
      },
      async tick() {
        if (startup) {
          startup = false;
          events.push('execution:reconcile');
          return { status: 'reconciled', processed: 0 };
        }
        events.push('execution:tick');
        return draining
          ? { status: 'draining' }
          : { status: 'session_unavailable' };
      },
      async beginDrain() {
        events.push('execution:drain');
        draining = true;
      },
      async stop() {
        events.push('execution:release');
      },
    },
    client: {
      close() {
        events.push('client:close');
      },
    },
    offerTransport: {
      close() {
        events.push('transport:close');
      },
    },
    ownsClient: false,
  };
  try {
    const application = await startProductionWorkerHeadlessApplicationWithStack(
      options,
      stack,
    );
    await application.tick();
    assert.equal(await application.stop(), 'stopped');
    assert.deepEqual(events, [
      'execution:start',
      'execution:reconcile',
      'session:register',
      'session:tick',
      'execution:tick',
      'execution:drain',
      'session:drain',
      'session:tick',
      'execution:tick',
      'session:offline',
      'execution:release',
      'transport:close',
    ]);
  } finally {
    await fs.rm(temporary.root, { recursive: true, force: true });
  }
});

test('runs certificate renewal in the existing cadence and fences admission', async () => {
  const temporary = await temporaryStorage();
  const events = [];
  const diagnostics = [];
  let renewalRuns = 0;
  let sessionAvailable = true;
  const options = {
    enabled: true,
    profile: 'worker',
    capacityProfile: 'edge',
    origin: 'https://worker-control.invalid',
    credentials: {
      async load() {
        throw new Error('not used');
      },
    },
    certificateRenewal: {
      async run() {
        renewalRuns += 1;
        events.push(`certificate:${renewalRuns}`);
        if (renewalRuns === 1) {
          return { status: 'not_due', identity: {}, renewAtMs: 10_000 };
        }
        return { status: 'unavailable', nextAttemptAtMs: 20_000 };
      },
    },
    session: {
      current() {
        return sessionAvailable
          ? {
              workerId: 'edge-1',
              sessionId: '018f0000-0000-7000-8000-000000000001',
              generation: 1,
              status: 'available',
              leaseExpiresAtMs: Date.now() + 60_000,
            }
          : undefined;
      },
      async register() {
        events.push('session:register');
      },
      async tick() {
        events.push('session:tick');
      },
      failClosed() {
        events.push('session:fail-closed');
        sessionAvailable = false;
      },
      async beginDrain() {
        events.push('session:drain');
      },
    },
    storage: temporary.storage,
    cadenceMs: 60_000,
    drainTimeoutMs: 1_000,
    drainPollMs: 25,
    diagnostic(fact) {
      diagnostics.push(fact.code);
    },
  };
  let startup = true;
  const stack = {
    journal: {
      async listOffers() {
        return { records: [] };
      },
    },
    lifecycle: {
      async start() {
        events.push('execution:start');
      },
      async tick() {
        if (startup) {
          startup = false;
          events.push('execution:reconcile');
          return { status: 'reconciled', processed: 0 };
        }
        events.push('execution:tick');
        return { status: 'session_unavailable' };
      },
      async beginDrain() {
        events.push('execution:drain');
      },
      async stop() {
        events.push('execution:release');
      },
    },
    client: { close() {} },
    offerTransport: {
      close() {
        events.push('transport:close');
      },
    },
    ownsClient: false,
  };
  try {
    const application = await startProductionWorkerHeadlessApplicationWithStack(
      options,
      stack,
    );
    assert.deepEqual(events.slice(0, 4), [
      'execution:start',
      'execution:reconcile',
      'certificate:1',
      'session:register',
    ]);
    assert.deepEqual(await application.tick(), {
      status: 'session_unavailable',
    });
    assert.equal(events.includes('session:tick'), false);
    assert.deepEqual(events.slice(4), [
      'certificate:2',
      'session:fail-closed',
      'execution:tick',
    ]);
    assert.deepEqual(await application.tick(), {
      status: 'session_unavailable',
    });
    assert.equal(
      events.filter((event) => event === 'session:fail-closed').length,
      1,
    );
    assert.deepEqual(diagnostics, ['certificate_unavailable']);
    assert.equal(await application.stop(), 'stopped');
  } finally {
    await fs.rm(temporary.root, { recursive: true, force: true });
  }
});

test('retries owner release after Session is already durably offline', async () => {
  const temporary = await temporaryStorage();
  let status;
  let releases = 0;
  let transportCloses = 0;
  const options = {
    enabled: true,
    profile: 'worker',
    capacityProfile: 'edge',
    origin: 'https://worker-control.invalid',
    credentials: {
      async load() {
        throw new Error('not used');
      },
    },
    session: {
      current() {
        return status === undefined
          ? undefined
          : {
              workerId: 'edge-1',
              sessionId: '018f0000-0000-7000-8000-000000000001',
              generation: 1,
              status,
              leaseExpiresAtMs: Date.now() + 60_000,
            };
      },
      async register() {
        status = 'available';
      },
      async tick() {},
      async beginDrain() {
        if (status !== 'offline') status = 'draining';
      },
      async disconnect() {
        if (status !== 'offline') status = 'offline';
      },
    },
    storage: temporary.storage,
    cadenceMs: 60_000,
    drainTimeoutMs: 1_000,
    drainPollMs: 25,
  };
  let startup = true;
  const stack = {
    journal: {
      async listOffers() {
        return { records: [] };
      },
    },
    lifecycle: {
      async start() {},
      async tick() {
        if (startup) {
          startup = false;
          return { status: 'reconciled', processed: 0 };
        }
        return { status: 'draining' };
      },
      async beginDrain() {},
      async stop() {
        releases += 1;
        if (releases === 1) throw new Error('owner release unavailable');
      },
    },
    client: { close() {} },
    offerTransport: {
      close() {
        transportCloses += 1;
      },
    },
    ownsClient: false,
  };
  try {
    const application = await startProductionWorkerHeadlessApplicationWithStack(
      options,
      stack,
    );
    await assert.rejects(application.stop(), /owner release unavailable/);
    assert.equal(status, 'offline');
    assert.equal(transportCloses, 0);
    assert.equal(await application.stop(), 'stopped');
    assert.equal(releases, 2);
    assert.equal(transportCloses, 1);
  } finally {
    await fs.rm(temporary.root, { recursive: true, force: true });
  }
});
