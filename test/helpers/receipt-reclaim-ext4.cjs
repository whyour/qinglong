// Run inside the dedicated bounded ext4 acceptance volume, alongside receipt-volume-full.cjs.
// Pause the actual post-commit collector before or after its filesystem call.
const fs = require('node:fs');
const path = require('node:path');
const { exhaust } = require('./receipt-volume-full.cjs');
const { sequelize } = require('/ql/static/build/data');
const { TriggerHistory } = require('/ql/static/build/shared/triggerHistory');
const [stage, id] = process.argv.slice(2);
const volume = '/ql/data/db';
const canonical = path.join(volume, 'cron-exits', id);
const control = '/tmp/journal-qa';
const capacity = () => fs.statfsSync(volume).bavail;
if (fs.statfsSync(volume).type !== 0xef53 || !/^[a-z0-9-]+$/.test(id) ||
    !['rename-before','rename-after','rename-enospc','unlink-before','unlink-after','unlink-injected'].includes(stage)) {
  throw Error('Expected a supported ext4 collection boundary and execution ID');
}

function hold(event) {
  const target = path.join(control, stage + '-event');
  fs.writeFileSync(target + '.tmp', JSON.stringify(event));
  fs.renameSync(target + '.tmp', target);
  // The outside observer cuts power here. A failed orchestrator has a bounded wait.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
  throw Error('Power cut did not occur');
}

async function atBoundary(source, destination, operation) {
  // A hard link outside the receipt namespace keeps the allocation constant even
  // if unlink succeeds.
  const pin = path.join(volume, '.qa-reclaim-pin');
  fs.linkSync(source, pin);
  exhaust(false);
  const event = {stage, id, source, destination, blocksBefore: capacity()};
  if (event.blocksBefore !== 0) throw Error('Expected an exhausted data volume');
  if (stage === 'rename-enospc') {
    // Fill the target directory with entries the same length as the capture name.
    // Hard links expend directory space without needing another inode.
    const dir = path.dirname(destination);
    let count = 0;
    try {
      for (;;) {
        fs.linkSync(pin, path.join(dir, 'q' + count.toString(36).padStart(path.basename(destination).length - 1, '0')));
        count++;
      }
    } catch (error) {
      if (error.code !== 'ENOSPC') throw error;
    }
    event.extraDirectoryEntries = count;
  }
  if (stage.endsWith('-before')) hold({...event, called:false});
  if (stage === 'unlink-injected') {
    // Explicitly synthetic. Keep the file and let the real collector unwind.
    throw Object.assign(Error('Injected unlink capacity error'), {code:'ENOSPC', event});
  }
  try {
    await operation();
  } catch (error) {
    if (stage !== 'rename-enospc' || error.code !== 'ENOSPC') throw error;
    hold({...event, called:true, result:error.code, errno:error.errno, syscall:error.syscall,
      sourceExists:fs.existsSync(source), destinationExists:fs.existsSync(destination)});
  }
  if (stage === 'rename-enospc') throw Error('Expected rename to need another directory block');
  hold({...event, called:true, result:'success', blocksAfter:capacity(),
    sourceExists:fs.existsSync(source), destinationExists:destination && fs.existsSync(destination)});
}

const rename = fs.promises.rename.bind(fs.promises);
const unlink = fs.promises.unlink.bind(fs.promises);
let reached = false, injected;
fs.promises.rename = (from,to) => {
  if (!reached && stage.startsWith('rename-') && from === canonical) {
    reached = true;
    const destination = path.join(fs.realpathSync(path.dirname(to)), path.basename(to));
    return atBoundary(from,destination,() => rename(from,to));
  }
  return rename(from,to);
};
fs.promises.unlink = async file => {
  if (!reached && stage.startsWith('unlink-') && path.basename(file).startsWith('.pending.' + id + '.r-')) {
    reached = true;
    try {return await atBoundary(fs.realpathSync(file),null,() => unlink(file));}
    catch (error) { if (stage === 'unlink-injected') injected = error; throw error; }
  }
  return unlink(file);
};

new TriggerHistory(sequelize).complete(id,'unknown',null,null).then(() => {
  if (injected?.code === 'ENOSPC') hold({...injected.event, called:false, injected:'ENOSPC',
    privateFileRetained:fs.existsSync(injected.event.source)});
  throw Error('Collector did not reach the expected power cut');
}).catch(error => {console.error(error); process.exitCode = 1;}).finally(() => sequelize.close());
