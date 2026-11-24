const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readLogChunk } = require('../../back/shared/logReader');
const { observeChildProcess } = require('../../back/shared/childProcess');
const { shellQuote } = require('../../back/shared/shellQuote');
const {
  spawnCronCommand,
  releaseCronCommand,
} = require('../../back/cron/execution/cronCommandProcess');

test(
  'a live viewer drains complete UTF-8 output across idle polls, supervised bursts and a nonzero exit',
  { timeout: 20000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-log-follow-'));
    const file = path.join(root, 'live.log');
    const previous = process.env.QL_DATA_DIR;
    process.env.QL_DATA_DIR = root;
    let child;
    t.after(async () => {
      child?.kill('SIGKILL');
      if (previous === undefined) delete process.env.QL_DATA_DIR;
      else process.env.QL_DATA_DIR = previous;
      await fs.rm(root, { recursive: true, force: true });
    });
    const initial = '历史🚀\n'.repeat(500000);
    await fs.writeFile(file, initial);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    let current = { nextOffset: 0 };
    const parts = [];
    async function poll() {
      current = await readLogChunk(file, {
        offset: current.nextOffset,
        cursor: current.cursor,
        follow: true,
      });
      assert.equal(current.reset, false);
      parts.push(current.content);
    }
    do {
      await poll();
    } while (current.nextOffset < current.total);
    for (let i = 0; i < 10; i++) {
      await poll();
      assert.equal(current.content, '');
    }
    const bursts = Array.from({ length: 4 }, (_, i) =>
      `批次${i}🚀\n`.repeat(40000),
    );
    const source = `const fs=require('node:fs');(async()=>{for(let i=0;i<4;i++){const b=Buffer.from(('批次'+i+'🚀\\n').repeat(40000));let offset=0;while(offset<b.length)offset+=fs.writeSync(1,b,offset,b.length-offset);await new Promise(r=>setTimeout(r,80));}fs.writeSync(2,'STDERR 尾行\\n');process.exitCode=17;})()`;
    child = spawnCronCommand(
      `${shellQuote(process.execPath)} -e ${shellQuote(source)}`,
      'live-follow',
      undefined,
      file,
    );
    let settled = false;
    const execution = observeChildProcess(child, {
      onStart: () => releaseCronCommand(child),
    }).completed.then((result) => {
      settled = true;
      return result;
    });
    while (!settled) {
      await poll();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    do {
      await poll();
    } while (current.nextOffset < current.total);
    const result = await execution;
    assert.equal(result.error, undefined);
    assert.equal(result.code, 17);
    const expected = initial + bursts.join('') + 'STDERR 尾行\n';
    assert.equal(await fs.readFile(file, 'utf8'), expected);
    assert.equal(parts.join(''), expected);
    assert.equal(current.nextOffset, Buffer.byteLength(expected));
  },
);
