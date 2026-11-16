// Docker acceptance worker. Both capacity limits are checked before filling the
// explicitly mounted test filesystem. Barrier files live outside that mount.
const fs = require('node:fs');
const path = require('node:path');
const volume = '/ql/data/db';
const barriers = '/tmp/journal-qa';
const [mode, id] = process.argv.slice(2);
const capacity = fs.statfsSync(volume);
const filesystem = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
  .find(line => line.split(' ')[4] === volume)?.split(' - ')[1].split(' ')[0];
const ext4 = filesystem === 'ext4' && capacity.type === 0xef53;
if (!(ext4 || (filesystem === 'tmpfs' && capacity.type === 0x01021994)) || capacity.blocks <= 0 || capacity.blocks * capacity.bsize > 32 * 1024 * 1024 ||
    capacity.files <= 0 || capacity.files > 8192 || !fs.existsSync(path.join(volume, '.qa-isolated-volume'))) {
  throw Error('Requires a dedicated bounded ext4 or tmpfs for receipt acceptance');
}
const { sequelize: db } = require('/ql/static/build/data');
const { TriggerHistory } = require('/ql/static/build/shared/triggerHistory');
function record(name, data) {
  fs.writeFileSync(path.join(barriers, name + '.tmp'), JSON.stringify(data));
  fs.renameSync(path.join(barriers, name + '.tmp'), path.join(barriers, name));
}
function exhaust(inodes) {
  const dir = fs.mkdtempSync(path.join(volume, '.qa-fill-'));
  let fd;
  try {
    if (!inodes) fd = fs.openSync(path.join(dir, 'data'), 'wx');
    const block = Buffer.alloc(64 * 1024);
    for (let n = 0; ; n++) {
      if (inodes) fs.closeSync(fs.openSync(path.join(dir, String(n)), 'wx'));
      else fs.writeSync(fd, block);
    }
  } catch (error) {
    if (error.code !== 'ENOSPC') throw error;
    if (ext4) {
      if (fd !== undefined) {
        // A large allocation may fail while individual blocks remain usable.
        try { for (;;) fs.writeSync(fd, Buffer.alloc(capacity.bsize)); }
        catch (last) { if (last.code !== 'ENOSPC') throw last; }
        fs.fsyncSync(fd);
      }
      for (const entry of [dir, volume]) {
        const handle = fs.openSync(entry, fs.constants.O_DIRECTORY);
        try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      }
    }
    record(mode + '-capacity', { dir, error: error.code, statfs: fs.statfsSync(volume) });
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// A short receipt fits one block. Request another block beyond any ext4
// preallocation to obtain kernel ENOSPC while the original prefix is intact.
function writePartialReceipt() {
  const receipt = JSON.parse(process.argv[4]);
  const { writeExit } = require('/ql/static/build/shared/managedExit.cjs');
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, content, options) => {
    if (!content || path.dirname(file) !== path.join(volume, 'cron-exits')) return write(file, content, options);
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_SYNC, 0o600);
    try {
      const bytes = Buffer.from(content);
      fs.writeSync(fd, bytes, 0, 12, 0);
      record('partial-ready', { id, file, bytes: fs.fstatSync(fd).size });
      const deadline = performance.now() + 120000;
      while (!fs.existsSync(path.join(barriers, 'partial-continue'))) {
        if (performance.now() > deadline) throw Error('Short-write barrier expired');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      }
      const offset = ext4 ? (capacity.blocks + 1) * capacity.bsize : capacity.bsize;
      try { fs.writeSync(fd, bytes, 12, bytes.length - 12, offset); }
      catch (error) {
        record('partial-error', { id, file, code: error.code, bytes: fs.fstatSync(fd).size, offset });
        // Keep the torn file open across the guest power cut in the ext4 run.
        if (ext4) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
        throw error;
      }
      throw Error('Expected ENOSPC while allocating the next page');
    } finally { fs.closeSync(fd); }
  };
  writeExit(id, receipt.code, receipt.signal, receipt.time);
}
async function main() {
  if (mode === 'partial') return writePartialReceipt();
  if (!['commit','collect'].includes(mode)) throw Error('Unexpected fault mode');
  await db.query('CREATE TABLE IF NOT EXISTS qa_commit_payload (payload BLOB)');
  const original = db.query.bind(db);
  if (mode === 'commit') {
    db.query = async (sql, ...args) => {
      if (!String(sql).startsWith('COMMIT')) return original(sql, ...args);
      exhaust(false);
      try { return await original(sql, ...args); }
      catch (error) {
        record('commit-error', { code: error.original?.code, sql: String(sql) });
        throw error;
      }
    };
  } else {
    const rename = fs.promises.rename.bind(fs.promises);
    let injected = false;
    fs.promises.rename = async (...args) => {
      if (!injected) {
        injected = true;
        exhaust(true);
      }
      try {
        await rename(...args);
        record('collect-moved', { source:args[0], destination:args[1] });
      }
      catch (error) { record('collect-error', { code: error.code, prefix: args[0] }); throw error; }
    };
  }
  await db.transaction(async transaction => {
    if (mode === 'commit') {
      await db.query('PRAGMA cache_spill=OFF', { transaction });
      await db.query('INSERT INTO qa_commit_payload VALUES (zeroblob(524288))', { transaction });
    }
    record(mode + '-ready', { id });
    const deadline = Date.now() + 86400000 * 3;
    while (!fs.existsSync(path.join(barriers, mode + '-continue'))) {
      if (Date.now() >= deadline) throw Error('Timed out at database barrier');
      await new Promise(r => setTimeout(r, 30));
    }
    await new TriggerHistory(db).completeCommandExit(id, 'unknown', null, null, transaction);
  });
}
module.exports = { exhaust };

if (require.main === module) main().catch(error => {
  if (mode !== 'commit' || error.original?.code !== 'SQLITE_FULL') {console.error(error); process.exitCode = 1;}
}).finally(async () => { await db.close(); record(mode + '-done', { id }); });
