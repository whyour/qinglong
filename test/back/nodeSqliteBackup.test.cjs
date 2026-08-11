const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

let nodeSqlite;
try {
  nodeSqlite = require('node:sqlite');
} catch {
  nodeSqlite = undefined;
}

const temporaryDirectories = [];
const nodeMajor = Number(process.versions.node.split('.')[0]);

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-backup-'));
  temporaryDirectories.push(root);
  return root;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

test(
  'Node 24 Online Backup produces an integrity-checked restorable snapshot',
  { skip: nodeMajor < 24 },
  async () => {
    assert.equal(typeof nodeSqlite?.backup, 'function');
    const root = await temporaryRoot();
    const sourcePath = path.join(root, 'source.sqlite');
    const backupPath = path.join(root, 'backup.sqlite');
    const restoredPath = path.join(root, 'restored.sqlite');
    const source = new nodeSqlite.DatabaseSync(sourcePath);
    source.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE facts(id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
    );
    const insert = source.prepare('INSERT INTO facts(value) VALUES (?)');
    for (let index = 0; index < 2_000; index += 1) {
      insert.run('fact-' + index + '-' + 'x'.repeat(128));
    }

    let progressCalls = 0;
    let insertedDuringBackup = false;
    const pages = await nodeSqlite.backup(source, backupPath, {
      rate: 1,
      progress() {
        progressCalls += 1;
        if (!insertedDuringBackup) {
          insertedDuringBackup = true;
          insert.run('inserted-during-online-backup');
        }
      },
    });
    source.close();

    assert.ok(pages > 0);
    assert.ok(progressCalls > 0);
    assert.equal(insertedDuringBackup, true);
    const backup = new nodeSqlite.DatabaseSync(backupPath, {
      readOnly: true,
    });
    assert.equal(
      backup.prepare('PRAGMA integrity_check').get().integrity_check,
      'ok',
    );
    assert.equal(
      backup
        .prepare(
          "SELECT COUNT(*) AS count FROM facts WHERE value = 'inserted-during-online-backup'",
        )
        .get().count,
      1,
    );
    const expectedCount = backup
      .prepare('SELECT COUNT(*) AS count FROM facts')
      .get().count;
    backup.close();

    await fs.copyFile(backupPath, restoredPath);
    const restoredBytes = await fs.readFile(restoredPath);
    const backupBytes = await fs.readFile(backupPath);
    assert.equal(sha256(restoredBytes), sha256(backupBytes));
    const restored = new nodeSqlite.DatabaseSync(restoredPath, {
      readOnly: true,
    });
    assert.equal(
      restored.prepare('PRAGMA quick_check').get().quick_check,
      'ok',
    );
    assert.equal(
      restored.prepare('SELECT COUNT(*) AS count FROM facts').get().count,
      expectedCount,
    );
    restored.close();
  },
);
