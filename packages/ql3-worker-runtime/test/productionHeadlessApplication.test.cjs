'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const {
  createProductionWorkerHeadlessExecutionStack,
  startProductionWorkerHeadlessApplication,
} = require('@qinglong/worker-runtime/production');

const SESSION_ID = '018f0000-0000-7000-8000-000000000001';

async function temporaryStorage() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql3-worker-production-'),
  );
  return {
    root,
    storage: {
      journalRoot: path.join(root, 'journal'),
      logRoot: path.join(root, 'logs'),
      receiptRoot: path.join(root, 'receipts'),
    },
  };
}

function options(storage, session, overrides = {}) {
  return {
    enabled: true,
    profile: 'worker',
    capacityProfile: 'edge',
    origin: 'https://worker-control.invalid',
    credentials: {
      async load() {
        throw new Error('credentials must remain lazy');
      },
    },
    session,
    storage,
    cadenceMs: 60_000,
    drainTimeoutMs: 1_000,
    drainPollMs: 25,
    ...overrides,
  };
}

function sessionLifecycle() {
  let status = 'available';
  let drains = 0;
  return {
    current() {
      return {
        workerId: 'worker-1',
        sessionId: SESSION_ID,
        generation: 1,
        status,
        leaseExpiresAtMs: Date.now() + 60_000,
      };
    },
    async beginDrain() {
      drains += 1;
      status = 'draining';
    },
    drains() {
      return drains;
    },
  };
}

test('disabled production Worker is resource-free before option access', async () => {
  const candidate = { enabled: false };
  Object.defineProperty(candidate, 'profile', {
    get() {
      throw new Error('disabled path inspected profile');
    },
  });
  const application = await startProductionWorkerHeadlessApplication(candidate);
  assert.equal(application.status, 'disabled');
  assert.equal(await application.stop(), 'stopped');
});

test('the concrete execution factory requires an explicit enabled authority', () => {
  assert.throws(
    () => createProductionWorkerHeadlessExecutionStack({ enabled: false }),
    /invalid_configuration/,
  );
});

test('assembles one concrete execution plane and drains before owner release', async () => {
  const temporary = await temporaryStorage();
  const session = sessionLifecycle();
  try {
    const application = await startProductionWorkerHeadlessApplication(
      options(temporary.storage, session),
    );
    assert.equal(application.status, 'active');
    const journal = await fs.stat(temporary.storage.journalRoot);
    const offers = await fs.stat(
      path.join(temporary.storage.journalRoot, 'offers'),
    );
    assert.equal(journal.isDirectory(), true);
    assert.equal(offers.isDirectory(), true);
    await assert.rejects(fs.stat(temporary.storage.logRoot), {
      code: 'ENOENT',
    });
    await assert.rejects(fs.stat(temporary.storage.receiptRoot), {
      code: 'ENOENT',
    });
    assert.equal(await application.stop(), 'stopped');
    assert.equal(await application.stop(), 'stopped');
    assert.equal(session.drains(), 1);
  } finally {
    await fs.rm(temporary.root, { recursive: true, force: true });
  }
});

test('rejects wrong Profile and overlapping authorities before filesystem use', async () => {
  const temporary = await temporaryStorage();
  const session = sessionLifecycle();
  try {
    await assert.rejects(
      startProductionWorkerHeadlessApplication(
        options(temporary.storage, session, { profile: 'cluster-control' }),
      ),
      /invalid_configuration/,
    );
    const overlapping = {
      journalRoot: path.join(temporary.root, 'state'),
      logRoot: path.join(temporary.root, 'state', 'logs'),
      receiptRoot: path.join(temporary.root, 'receipts'),
    };
    await assert.rejects(
      startProductionWorkerHeadlessApplication(options(overlapping, session)),
      /invalid_configuration/,
    );
    await assert.rejects(fs.stat(overlapping.journalRoot), { code: 'ENOENT' });
  } finally {
    await fs.rm(temporary.root, { recursive: true, force: true });
  }
});

test('a failed Session drain keeps the application owned and retryable', async () => {
  const temporary = await temporaryStorage();
  let attempts = 0;
  let status = 'available';
  const session = {
    current() {
      return {
        workerId: 'worker-1',
        sessionId: SESSION_ID,
        generation: 1,
        status,
        leaseExpiresAtMs: Date.now() + 60_000,
      };
    },
    async beginDrain() {
      attempts += 1;
      if (attempts === 1) throw new Error('drain unavailable');
      status = 'draining';
    },
  };
  try {
    const application = await startProductionWorkerHeadlessApplication(
      options(temporary.storage, session),
    );
    await assert.rejects(application.stop(), /drain unavailable/);
    assert.equal(await application.stop(), 'stopped');
    assert.equal(attempts, 2);
  } finally {
    await fs.rm(temporary.root, { recursive: true, force: true });
  }
});

test('production execution graph is reachable only through its explicit subpath', () => {
  const packageDirectory = path.resolve(__dirname, '..');
  const inspect = (specifier) => {
    const script = `
      const exported = require(${JSON.stringify(specifier)});
      const loaded = Object.keys(require.cache).map((file) => file.replaceAll('\\\\', '/'));
      process.stdout.write(JSON.stringify({
        hasProduction: typeof exported.startProductionWorkerHeadlessApplication === 'function',
        loadedJournal: loaded.some((file) => file.includes('/remoteOfferFileJournal.js')),
        loadedLock: loaded.some((file) => file.includes('/proper-lockfile/')),
        loadedCluster: loaded.some((file) => file.includes('/ql3-cluster-')),
      }));
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: packageDirectory,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(inspect('@qinglong/worker-runtime'), {
    hasProduction: false,
    loadedJournal: false,
    loadedLock: false,
    loadedCluster: false,
  });
  assert.deepEqual(inspect('@qinglong/worker-runtime/production'), {
    hasProduction: true,
    loadedJournal: true,
    loadedLock: true,
    loadedCluster: false,
  });
});
