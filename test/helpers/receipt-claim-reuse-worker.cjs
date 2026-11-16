const fs = require('node:fs');
const path = require('node:path');
const [moduleFile, file, id, outcome, time, barrier, recovery, stage] = process.argv.slice(2);
const { retireLegacyFile } = require(moduleFile);
// Both collectors have read the source and hold its directory lock at this point.
const rename = fs.promises.rename.bind(fs.promises);
let captured;
async function gate(suffix, data, release) {
  fs.writeFileSync(barrier + '.tmp', JSON.stringify(data));
  fs.renameSync(barrier + '.tmp', barrier + suffix);
  const limit = performance.now() + 90000;
  while (!fs.existsSync(barrier + release)) {
    if (performance.now() > limit) throw Error('Timed out waiting for ' + release);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
fs.promises.rename = async (source, target) => {
  if (await fs.promises.realpath(source) !== file) return rename(source, target);
  const ready = { pid: process.pid, path:file, target,
    directoryInode: (await fs.promises.stat(path.dirname(source))).ino,
    fileInode: (await fs.promises.stat(source)).ino };
  await gate('.ready', ready, '.go');
  try {
    await rename(source, target);
  } catch (error) {
    if (stage === 'recordMoveError')
      fs.writeFileSync(barrier + '.error', JSON.stringify({code:error.code, errno:error.errno, syscall:error.syscall}));
    throw error;
  }
  captured = target;
  if (stage === 'holdMoved') await gate('.moved', {target, inode:(await fs.promises.stat(target)).ino}, '.release');
};
const unlink = fs.promises.unlink.bind(fs.promises);
fs.promises.unlink = async file => {
  if (stage === 'holdUnlink' && captured === file)
    await gate('.checked', {target:file, inode:(await fs.promises.stat(file)).ino}, '.release');
  return unlink(file);
};
const settlement = recovery
  ? require(recovery).triggerHistory().complete(id,'unknown',null,null)
  : retireLegacyFile(id, file, {outcome, time:Number(time)});
settlement.catch(error => {
  // Another collector may have already removed the same settled inode.
  if (error.code !== 'ENOENT') { console.error(error); process.exitCode = 1; }
}).finally(() => {
  if (recovery) return require(path.join(path.dirname(recovery),'../data')).sequelize.close();
});
