const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const {
  spawnCronCommand,
  releaseCronCommand,
} = require('../../back/cron/execution/cronCommandProcess');
const { observeChildProcess } = require('../../back/shared/childProcess');
const { shellQuote } = require('../../back/shared/shellQuote');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-supervisor-log-'));
  const previous = process.env.QL_DATA_DIR;
  process.env.QL_DATA_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.QL_DATA_DIR;
    else process.env.QL_DATA_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function nodeCommand(code) {
  return `${shellQuote(process.execPath)} -e ${shellQuote(code)}`;
}

test(
  'supervisor appends complete merged output once and preserves start telemetry and exit status',
  { timeout: 10000 },
  async (t) => {
    const root = await fixture(t);
    const log = path.join(root, "log's $name.log");
    const output = '尾行 '.repeat(100000);
    await fs.writeFile(log, 'previous\n');
    let started;
    let forwarded = '';
    const child = spawnCronCommand(
      nodeCommand(
        `const fs=require('node:fs');const b=Buffer.from('尾行 '.repeat(100000));let i=0;while(i<b.length)i+=fs.writeSync(1,b,i,b.length-i);fs.writeSync(2,'STDERR\\n');process.exitCode=17;`,
      ),
      'log-append',
      (value) => {
        started = value;
      },
      log,
    );
    const result = await observeChildProcess(child, {
      onStart: () => releaseCronCommand(child),
      onStdout: async (text) => {
        forwarded += text;
      },
      onStderr: async (text) => {
        forwarded += text;
      },
    }).completed;
    assert.equal(result.code, 17);
    assert.equal(result.error, undefined);
    assert.equal(forwarded, '');
    assert.ok(
      Number.isInteger(started) && Math.abs(Date.now() - started) < 10000,
    );
    assert.equal(
      await fs.readFile(log, 'utf8'),
      'previous\n' + output + 'STDERR\n',
    );
  },
);

for (const fault of ['open', 'full']) {
  for (const disconnected of [false, true]) {
    test(
      `log ${fault} failure drains output without interrupting command (reader disconnected=${disconnected})`,
      {
        timeout: 10000,
        skip: fault === 'full' && process.platform !== 'linux',
      },
      async (t) => {
        const root = await fixture(t);
        const marker = path.join(root, 'completed');
        // A directory fails at open; /dev/full opens but every write fails ENOSPC.
        const log = fault === 'open' ? root : '/dev/full';
        const code = `const fs=require('node:fs');const b=Buffer.alloc(65536,120);for(let n=0;n<64;n++){let i=0;while(i<b.length)i+=fs.writeSync(n%2?2:1,b,i,b.length-i);}fs.writeFileSync(${JSON.stringify(
          marker,
        )},'completed');`;
        const child = spawnCronCommand(
          nodeCommand(code),
          'log-fault',
          undefined,
          log,
        );
        let result,
          errors = '';
        if (disconnected) {
          const closed = once(child, 'close');
          child.stdout.destroy();
          child.stderr.destroy();
          await releaseCronCommand(child);
          const [code, signal] = await closed;
          result = { code, signal };
        } else {
          result = await observeChildProcess(child, {
            onStart: () => releaseCronCommand(child),
            onStderr: async (text) => {
              errors += text;
            },
          }).completed;
          assert.equal(result.error, undefined);
          assert.equal(
            (errors.match(/Could not write command log/g) || []).length,
            1,
          );
          assert.match(
            errors,
            fault === 'full' ? /No space left/ : /Is a directory/,
          );
        }
        assert.equal(result.code, 0);
        assert.equal(result.signal, null);
        assert.equal(await fs.readFile(marker, 'utf8'), 'completed');
      },
    );
  }
}

test(
  'cancelled launch neither creates a log nor executes the command',
  { timeout: 10000 },
  async (t) => {
    const root = await fixture(t);
    const marker = path.join(root, 'executed');
    const log = path.join(root, 'cancelled.log');
    const child = spawnCronCommand(
      nodeCommand(
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
      ),
      'log-cancel',
      undefined,
      log,
    );
    const closed = once(child, 'close');
    child.stdin.end();
    assert.equal((await closed)[0], 125);
    await assert.rejects(fs.access(log), { code: 'ENOENT' });
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  },
);
