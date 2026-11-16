// Run on the dedicated ext4 test disk. Two independent recovery processes have
// validated one slot. A third writer replaces just the file before either move.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createHash } = require('node:crypto');
const volume = '/ql/data/db';
const moduleFile = '/ql/static/build/shared/managedExit.cjs';
const { receiptPath, readExit, retiringExits } = require(moduleFile);

(async () => {
  const usage = await fs.statfs(volume);
  assert.equal(usage.type,0xef53);
  assert.ok(usage.blocks * usage.bsize <= 32 * 1024 * 1024 && usage.files <= 8192);
  await fs.access(path.join(volume,'.qa-isolated-volume'));
  const root = await fs.mkdtemp(path.join(volume,'.qa-slot-'));
  const workers = [];
  try {
    process.env.QL_DATA_DIR = root;
    const id = 'occupied-slot', directory = path.join(path.dirname(receiptPath(id)),'.claim.' + id + '.qaTest');
    await fs.mkdir(directory,{recursive:true});
    const slot = path.join(directory,'receipt');
    const receipt = code => JSON.stringify({code, signal:null, time:1000, version:1,
      checksum:createHash('sha256').update(JSON.stringify([id,code,null,1000])).digest('hex')});
    await fs.writeFile(slot,receipt(17),{flag:'wx'});
    for (const role of ['A','B']) {
      const barrier = path.join(root, role);
      const child = spawn(process.execPath,[path.join(__dirname,'receipt-claim-reuse-worker.cjs'),
        moduleFile, slot, id, '17', '1000', barrier],{stdio:'inherit'});
      workers.push({barrier,child,done:once(child,'exit')});
    }
    const deadline = performance.now() + 10000;
    const before = await Promise.all(workers.map(async ({barrier}) => {
      while (performance.now() < deadline) {
        try { return JSON.parse(await fs.readFile(barrier+'.ready','utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await delay(20);
      }
      throw Error('Both collectors must validate the original slot');
    }));
    assert.equal(before[0].fileInode,before[1].fileInode);
    assert.equal(before[0].directoryInode,before[1].directoryInode);
    await fs.writeFile(slot+'.new',receipt(42),{flag:'wx'});
    await fs.rename(slot+'.new',slot);
    const inode = (await fs.stat(slot)).ino;
    assert.notEqual(inode,before[0].fileInode);
    for (const {barrier} of workers) await fs.writeFile(barrier+'.go','');
    for (const {done} of workers) assert.deepEqual(await done,[0,null]);
    const captures = await retiringExits();
    assert.equal(captures.length,1);
    assert.equal((await fs.stat(captures[0].file)).ino,inode);
    assert.equal((await readExit(id,captures[0].file)).code,42);
    console.log(JSON.stringify({before,replacementInode:inode,retained:captures[0].file}));
  } finally {
    for (const {child} of workers) if (child.exitCode === null) child.kill();
    await fs.rm(root,{recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode=1; });
