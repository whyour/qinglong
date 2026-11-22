const fs = require('node:fs');
const path = require('node:path');
const { writeExit } = require('../../back/cron/settlement/exitReceipt.cjs');
const [stage, time] = process.argv.slice(2);
const write = fs.writeFileSync;
function checkpoint(point) {
  if (point !== stage) return;
  const ready = path.join(process.env.QL_DATA_DIR, 'publisher-ready');
  write(ready + '.tmp', point);
  fs.renameSync(ready + '.tmp', ready);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
let writes = 0;
fs.writeFileSync = (file, contents, options) => {
  if (writes++ === 0) {
    checkpoint('before-write');
    write(file, contents, options);
    checkpoint('after-write');
  } else {
    checkpoint('before-mirror');
    if (stage === 'partial') {
      write(file, contents.slice(0, 12), options);
      checkpoint('partial');
    }
    write(file, contents, options);
    checkpoint('after-mirror');
  }
};
const link = fs.linkSync;
fs.linkSync = (...args) => {
  checkpoint('before-link');
  link(...args);
  checkpoint('after-link');
};
writeExit(process.env.QL_TRIGGER_ID, 23, null, Number(time));
checkpoint('published');
