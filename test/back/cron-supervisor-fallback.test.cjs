const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { shellQuote } = require('../../back/shared/shellQuote');
const { readExit } = require('../../back/cron/settlement/exitReceipt.cjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const missing of [null, 'posix_spawn', 'waitstatus_to_exitcode']) {
  for (const cancel of [false, true]) {
    test(
      `Linux supervises silent background children (${
        missing || 'native'
      }, cancel=${cancel})`,
      { timeout: 15000, skip: process.platform !== 'linux' },
      async (t) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-fallback-'));
        const ready = path.join(root, 'ready');
        const go = path.join(root, 'go');
        const marker = path.join(root, 'db', 'cron-exits', 'silent');
        const payload = `import os,time,signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nopen(${JSON.stringify(
          ready,
        )},'w').write(str(os.getpid()))\nwhile not os.path.exists(${JSON.stringify(
          go,
        )}):time.sleep(.01)\n`;
        const bootstrap = `import os,sys,runpy,subprocess\n${
          missing
            ? `del os.${missing}\n${
                missing === 'posix_spawn'
                  ? 'subprocess._USE_POSIX_SPAWN=False\n'
                  : ''
              }`
            : ''
        }sys.argv=sys.argv[1:];sys.exit(runpy.run_path(sys.argv[0])['main']())`;
        const child = spawn(
          'python3',
          [
            '-I',
            '-S',
            '-c',
            bootstrap,
            path.resolve('shell/cron-command.py'),
            `python3 -I -S -c ${shellQuote(payload)} >/dev/null 2>&1 & exit 17`,
            String(process.pid),
            marker,
            process.execPath,
            path.resolve('back/shared/managedExit.cjs'),
            'log-output',
            path.join(root, 'output.log'),
          ],
          {
            env: { ...process.env, QL_TRIGGER_ID: 'silent' },
            stdio: ['pipe', 'ignore', 'pipe'],
          },
        );
        let stderr = '';
        child.stderr.on('data', (data) => (stderr += data));
        const closed = once(child, 'close');
        let pid;
        t.after(async () => {
          child.kill('SIGKILL');
          if (pid) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch (_) {}
          }
          await closed;
          await fs.rm(root, { recursive: true, force: true });
        });
        child.stdin.end('run\n');
        for (let i = 0; i < 500; i++) {
          pid = Number(await fs.readFile(ready, 'utf8').catch(() => ''));
          if (pid) break;
          await sleep(10);
        }
        assert.ok(pid, stderr);
        // Neither output EOF nor Bash's exit proves its silent child has ended.
        await sleep(100);
        assert.equal(child.exitCode, null, stderr);
        await assert.rejects(fs.access(marker), { code: 'ENOENT' });
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
        assert.equal(
          Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]),
          child.pid,
        );
        if (cancel) {
          const { killTask } = require('../../back/config/util');
          const {
            systemOwner,
          } = require('../../back/cron/execution/cronProcess');
          const birth = systemOwner(child.pid);
          await killTask(child.pid, true, () =>
            assert.equal(systemOwner(child.pid), birth),
          );
          await closed;
          assert.throws(() => systemOwner(pid), { code: /ENOENT|ESRCH/ });
        } else {
          await fs.writeFile(go, 'go');
          assert.equal((await closed)[0], 17, stderr);
          assert.equal((await readExit('silent', marker)).code, 17);
        }
      },
    );
  }
}
