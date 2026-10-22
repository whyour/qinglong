import { databaseStartupFailure } from './databaseErrors';
import { Worker } from 'worker_threads';

// IPC disconnect cannot run while DatabaseSync is executing SQL. Start this
// independent, allocation-light monitor before opening SQLite so a SIGKILLed
// backend cannot leave an orphan holding the old service's database write lock.
async function monitorOwner(ownerPid: number) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1)
    throw new Error('Invalid database owner');
  const monitor = new Worker(
    `
    const {parentPort,workerData}=require('node:worker_threads');
    process.on('uncaughtException',()=>process.kill(process.pid,'SIGKILL'));
    const check=()=>{
      if(process.ppid!==workerData.ownerPid)process.kill(process.pid,'SIGKILL');
    };
    check();
    setInterval(check,500);
    parentPort.postMessage('ready');
  `,
    {
      eval: true,
      workerData: { ownerPid },
      // V8's process-wide --jitless remains active on ARMv6. Do not load the
      // source worker's ts-node compiler into this tiny, plain-JavaScript monitor.
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: 8,
        maxYoungGenerationSizeMb: 2,
        stackSizeMb: 1,
      },
    },
  );
  monitor.once('exit', () => process.exit(1));
  await new Promise<void>((resolve, reject) => {
    monitor.once('message', () => resolve());
    monitor.once('error', reject);
  });
  monitor.unref();
}

// The bootstrap catches dependency import errors before the ORM module loads.
// The advanced IPC serializer preserves Date, Buffer and undefined values.
process.once('disconnect', () => process.exit(1));
process.once('message', async (settings) => {
  const pending: unknown[] = [];
  const buffer = (request: unknown) => pending.push(request);
  // Keep a listener throughout asynchronous monitor startup. Node may flush
  // several buffered IPC messages while delivering the initial settings.
  process.on('message', buffer);
  try {
    await monitorOwner((settings as { ownerPid: number }).ownerPid);
    require('./databaseWorker').startDatabaseWorker(settings);
    process.removeListener('message', buffer);
    for (const request of pending) process.emit('message', request, undefined);
  } catch (error) {
    process.send?.({ type: 'fatal', error: databaseStartupFailure(error) });
  } finally {
    process.removeListener('message', buffer);
  }
});
