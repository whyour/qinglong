require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');
const {
  CompletionReceiptOrphanFileDirectory,
} = require('../../back/runtime/adapters/fs/completionReceiptOrphanDirectory');
const {
  CompletionReceiptOrphanAuditor,
} = require('../../back/runtime/application/completionReceiptOrphanAuditor');
const { parseArguments } = require('../../scripts/ql3-receipt-audit.cjs');

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(REPOSITORY_ROOT, 'scripts', 'ql3-receipt-audit.cjs');
const OBSERVED_AT_MS = 1_800_000_000_000;
const OLD_MTIME_MS = OBSERVED_AT_MS - 10 * 60_000;
const YOUNG_MTIME_MS = OBSERVED_AT_MS - 1_000;
const OWNED_ID = '019f7400-0000-7000-8000-000000000001';
const ACTIVE_ID = '019f7400-0000-7000-8000-000000000002';
const TERMINAL_ID = '019f7400-0000-7000-8000-000000000003';
const UNKNOWN_ID = '019f7400-0000-7000-8000-000000000004';
const YOUNG_ID = '019f7400-0000-7000-8000-000000000005';
const JOURNAL_ONLY_ID = '019f7400-0000-7000-8000-000000000006';
const roots = [];

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-orphan-audit-'));
  roots.push(root);
  return root;
}

async function writeAt(root, shard, name, modifiedAtMs = OLD_MTIME_MS) {
  const directory = path.join(root, shard);
  const target = path.join(directory, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(target, '{}');
  const timestamp = new Date(modifiedAtMs);
  await fs.utimes(target, timestamp, timestamp);
  return target;
}

function ownershipSource(values) {
  const ownership = new Map(values.map((value) => [value.attemptId, value]));
  return {
    async lookup(attemptIds) {
      return new Map(
        attemptIds
          .filter((attemptId) => ownership.has(attemptId))
          .map((attemptId) => [attemptId, ownership.get(attemptId)]),
      );
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

test('audits Journal ownership and quarantines only old regular orphans', async () => {
  const root = await temporaryRoot();
  const shard = '01';
  const names = {
    owned: `${OWNED_ID}.json`,
    active: `${ACTIVE_ID}.json`,
    terminal: `${TERMINAL_ID}.json`,
    unknown: `${UNKNOWN_ID}.json`,
    young: `${YOUNG_ID}.json`,
    temporary: `.${UNKNOWN_ID}.${'a'.repeat(32)}.tmp`,
    malformed: 'unexpected.bin',
    unsafe: 'unsafe-link',
  };
  for (const [key, name] of Object.entries(names)) {
    if (key !== 'unsafe') {
      await writeAt(
        root,
        shard,
        name,
        key === 'young' ? YOUNG_MTIME_MS : OLD_MTIME_MS,
      );
    }
  }
  await fs.symlink(
    path.join(root, shard, names.malformed),
    path.join(root, shard, names.unsafe),
  );
  const auditor = new CompletionReceiptOrphanAuditor(
    new CompletionReceiptOrphanFileDirectory(root),
    ownershipSource([
      {
        attemptId: OWNED_ID,
        attemptStatus: 'running',
        journalState: 'pending',
      },
      { attemptId: ACTIVE_ID, attemptStatus: 'running' },
      { attemptId: TERMINAL_ID, attemptStatus: 'succeeded' },
    ]),
  );

  const audit = await auditor.run({
    observedAtMs: OBSERVED_AT_MS,
    startShard: 1,
    shardCount: 1,
    maxEntriesPerShard: 16,
    minimumAgeMs: 5 * 60_000,
  });
  assert.equal(audit.scannedEntries, 8);
  assert.deepEqual(audit.overflowShards, []);
  assert.equal(audit.counts.journaled, 1);
  assert.equal(audit.counts.active_attempt, 1);
  assert.equal(audit.counts.terminal_orphan, 1);
  assert.equal(audit.counts.unknown_receipt, 1);
  assert.equal(audit.counts.young_unknown_receipt, 1);
  assert.equal(audit.counts.stale_temporary, 1);
  assert.equal(audit.counts.unknown_entry, 1);
  assert.equal(audit.counts.unsafe_entry, 1);
  assert.equal(
    audit.entries.filter((entry) => entry.action === 'eligible').length,
    4,
  );

  const quarantine = await auditor.run({
    mode: 'quarantine',
    observedAtMs: OBSERVED_AT_MS,
    startShard: 1,
    shardCount: 1,
    maxEntriesPerShard: 16,
    minimumAgeMs: 5 * 60_000,
  });
  assert.equal(
    quarantine.entries.filter((entry) => entry.action === 'quarantined').length,
    4,
  );
  for (const name of [
    names.terminal,
    names.unknown,
    names.temporary,
    names.malformed,
  ]) {
    await assert.rejects(fs.lstat(path.join(root, shard, name)), /ENOENT/);
  }
  for (const name of [names.owned, names.active, names.young, names.unsafe]) {
    assert.ok(await fs.lstat(path.join(root, shard, name)));
  }
  const quarantineFiles = await fs.readdir(
    path.join(root, '.orphan-quarantine', shard),
  );
  assert.equal(quarantineFiles.length, 4);
});

test('fails closed when a shard exceeds its fixed entry capacity', async () => {
  const root = await temporaryRoot();
  for (const name of ['a.bin', 'b.bin', 'c.bin']) {
    await writeAt(root, '02', name);
  }
  const auditor = new CompletionReceiptOrphanAuditor(
    new CompletionReceiptOrphanFileDirectory(root),
    ownershipSource([]),
  );
  const report = await auditor.run({
    mode: 'quarantine',
    observedAtMs: OBSERVED_AT_MS,
    startShard: 2,
    shardCount: 1,
    maxEntriesPerShard: 2,
    minimumAgeMs: 0,
  });

  assert.deepEqual(report.overflowShards, ['02']);
  assert.equal(report.scannedEntries, 2);
  assert.ok(
    report.entries.every((entry) => entry.action === 'blocked_overflow'),
  );
  assert.equal((await fs.readdir(path.join(root, '02'))).length, 3);
  await assert.rejects(
    auditor.run({ shardCount: 33 }),
    /shardCount must be between 1 and 32/,
  );
  await assert.rejects(
    auditor.run({ maxEntriesPerShard: 65 }),
    /maxEntriesPerShard must be between 1 and 64/,
  );
});

test('rejects shard and quarantine directory symlink escapes', async () => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot();
  await fs.symlink(outside, path.join(root, '03'));
  const directory = new CompletionReceiptOrphanFileDirectory(root);
  await assert.rejects(directory.inspectShard('03', 4), /not a safe directory/);

  await writeAt(root, '04', 'orphan.bin');
  const snapshot = await directory.inspectShard('04', 4);
  await fs.symlink(outside, path.join(root, '.orphan-quarantine'));
  await assert.rejects(
    directory.quarantine(snapshot.entries[0]),
    /not a safe directory/,
  );
  assert.ok(await fs.lstat(path.join(root, '04', 'orphan.bin')));
  assert.throws(
    () => new CompletionReceiptOrphanFileDirectory(path.parse(root).root),
    /must not be a filesystem root/,
  );
});

test('parses a bounded shard cursor and keeps audit as the default mode', () => {
  const options = parseArguments([
    '--start-shard=fe',
    '--shards=2',
    '--entries-per-shard=4',
    '--minimum-age-ms=1000',
  ]);
  assert.equal(options.mode, 'audit');
  assert.equal(options.startShard, 254);
  assert.equal(options.shardCount, 2);
  assert.equal(options.maxEntriesPerShard, 4);
  assert.throws(() => parseArguments(['--shards=33']), /between 1 and 32/);
  assert.throws(() => parseArguments(['--start-shard=FF']), /lowercase hex/);
});

test(
  'Node 24 CLI reads ownership without opening the database for writes',
  { skip: Number(process.versions.node.split('.')[0]) < 24 },
  async () => {
    const root = await temporaryRoot();
    const databasePath = path.join(root, 'database.sqlite');
    const receiptRoot = path.join(root, 'receipts');
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE RunAttempts (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE CompletionReceiptJournals (
        attempt_id TEXT PRIMARY KEY,
        state TEXT NOT NULL
      );
      INSERT INTO RunAttempts (id, status)
      VALUES ('${TERMINAL_ID}', 'succeeded');
      INSERT INTO CompletionReceiptJournals (attempt_id, state)
      VALUES ('${JOURNAL_ONLY_ID}', 'pending');
    `);
    database.close();
    await writeAt(receiptRoot, '01', `${TERMINAL_ID}.json`);
    await writeAt(receiptRoot, '01', `${JOURNAL_ONLY_ID}.json`);

    const result = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        '--json',
        `--database=${databasePath}`,
        `--root=${receiptRoot}`,
        '--start-shard=01',
        '--shards=1',
        '--entries-per-shard=4',
        '--minimum-age-ms=0',
      ],
      { cwd: REPOSITORY_ROOT, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.counts.terminal_orphan, 1);
    assert.equal(report.counts.journaled, 1);
    assert.equal(
      report.entries.find((entry) => entry.attemptId === TERMINAL_ID).action,
      'eligible',
    );
    assert.ok(
      await fs.lstat(path.join(receiptRoot, '01', `${TERMINAL_ID}.json`)),
    );
  },
);
