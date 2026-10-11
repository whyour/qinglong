const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { compatibilityRoute } = require('../../dist/compat');
const { parse } = require('../helpers/commands.cjs');

test('legacy adapter maps positional switches and preserves subscription arguments', () => {
  for (const [input, expected] of [
    [['update'], ['update']],
    [['update', 'true'], ['update']],
    [
      ['-l', 'update', 'false'],
      ['update', '--download-only'],
    ],
    [['reload'], ['reload', '--target', 'services']],
    [
      ['reload', 'system'],
      ['reload', '--target', 'system'],
    ],
    [
      ['reload', 'data'],
      ['reload', '--target', 'data'],
    ],
  ]) {
    const route = compatibilityRoute(input);
    assert.deepEqual(route, { surface: 'local', args: expected });
    assert.doesNotThrow(() => parse(route.args, 'local'));
  }
  for (const action of ['repo', 'raw']) {
    const args = [
      action,
      'https://example.invalid/owner/repo.git',
      '',
      'a b',
      '',
      'feature/test',
    ];
    assert.deepEqual(compatibilityRoute(args), {
      surface: 'subscription',
      args,
    });
  }
  const reset = compatibilityRoute(['resetpwd', '--literal-password']);
  assert.deepEqual(parse(reset.args, 'local').positionals, [
    '--literal-password',
  ]);
  for (const input of [
    ['update', 'maybe'],
    ['reload', 'wrong'],
    ['login'],
    ['task', 'run', '1'],
  ])
    assert.throws(() => compatibilityRoute(input));
});

test('legacy adapter help runs without panel setup and invalid commands fail before execution', () => {
  const entry = path.resolve(__dirname, '../../dist/compat.js');
  const env = {
    PATH: process.env.PATH,
    QL_DIR: '/nonexistent-panel',
    QL_LANG: 'en',
  };
  const help = spawnSync(process.execPath, [entry, '--help'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: ql-compat/);
  const invalid = spawnSync(process.execPath, [entry, 'update', 'maybe'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  assert.equal(JSON.parse(invalid.stderr).code, 2);
});

test('legacy maintenance logs output and reports lifecycle without sourcing config twice', async (t) => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const http = require('node:http');
  const { promisify } = require('node:util');
  const exec = promisify(require('node:child_process').execFile);
  for (const flags of ['no_tee=true', 'real_time=true\nno_tee=true']) {
    for (const failed of [false, true]) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-compat-log-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const calls = [];
      const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        calls.push({ url: req.url, body: JSON.parse(body) });
        res.end(JSON.stringify({ code: 200 }));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        await fs.mkdir(path.join(root, 'data/config'), { recursive: true });
        await fs.writeFile(
          path.join(root, 'data/config/config.sh'),
          `${flags}\nprintf x >> "$QL_DIR/config-loads"\n`,
        );
        await fs.writeFile(
          path.join(root, 'data/config/token.json'),
          JSON.stringify({
            value: 'fixture',
            expiration: Date.now() / 1000 + 3600,
          }),
        );
        await fs.writeFile(
          path.join(root, 'data/config/extra.sh'),
          `printf 'fixture-output\\n'\n${failed ? 'exit 7' : ':'}\n`,
        );
        const result = await exec(
          process.execPath,
          [path.resolve(__dirname, '../../dist/compat.js'), 'extra'],
          {
            env: {
              PATH: process.env.PATH,
              QL_DIR: root,
              QlPort: String(server.address().port),
              QL_CLI_LIFECYCLE: 'extended',
              ID: '9',
              QL_EXECUTION_ORIGIN: 'scheduled_system',
            },
            timeout: 15000,
          },
        ).then(
          (value) => ({ ...value, code: 0 }),
          (error) => error,
        );
        assert.equal(result.code, failed ? 1 : 0);
        assert.equal(
          await fs.readFile(path.join(root, 'config-loads'), 'utf8'),
          'x',
        );
        assert.equal(calls.length, 2);
        assert.ok(calls.every((call) => call.url === '/open/crons/status'));
        assert.deepEqual(
          calls.map((call) => call.body.status),
          ['0', '1'],
        );
        assert.equal(calls[1].body.exit_code, failed ? 1 : 0);
        assert.deepEqual(calls[0].body.ids, [9]);
        assert.match(
          calls[0].body.execution_id,
          /^legacy-system:\d+:[0-9a-f-]+$/,
        );
        assert.equal(calls[0].body.execution_id, calls[1].body.execution_id);
        const logPath = calls[0].body.log_path;
        assert.match(logPath, /^extra\/.*\.log$/);
        if (flags.startsWith('real_time')) {
          await assert.rejects(fs.stat(path.join(root, 'data/log', logPath)), {
            code: 'ENOENT',
          });
          assert.match(result.stderr, /fixture-output/);
        } else {
          const log = await fs.readFile(
            path.join(root, 'data/log', logPath),
            'utf8',
          );
          assert.match(log, /fixture-output/);
          assert.match(log, /执行结束/);
          assert.doesNotMatch(result.stderr, /fixture-output/);
        }
        if (!failed) assert.equal(JSON.parse(result.stdout).logPath, logPath);
        else assert.equal(result.stdout, '');
      } finally {
        await new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        });
      }
    }
  }
});

test('raw worker and compatibility route share subscription logs and lifecycle', async (t) => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const http = require('node:http');
  const exec = require('node:util').promisify(
    require('node:child_process').execFile,
  );
  for (const entry of ['compat.js', 'subscription-worker.js']) {
    for (const failed of [false, true]) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-worker-log-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const calls = [];
      const server = http.createServer(async (req, res) => {
        if (req.url === '/fixture.js') {
          res.writeHead(failed ? 503 : 200);
          res.end('console.log("downloaded");');
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        calls.push(JSON.parse(body));
        res.end(JSON.stringify({ code: 200 }));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        await fs.mkdir(path.join(root, 'data/config'), { recursive: true });
        await fs.writeFile(
          path.join(root, 'data/config/config.sh'),
          'no_tee=true\nprintf x >> "$QL_DIR/config-loads"\n',
        );
        await fs.writeFile(
          path.join(root, 'data/config/token.json'),
          JSON.stringify({
            value: 'fixture',
            expiration: Date.now() / 1000 + 3600,
          }),
        );
        const port = String(server.address().port);
        const result = await exec(
          process.execPath,
          [
            path.resolve(__dirname, '../../dist', entry),
            'raw',
            `http://127.0.0.1:${port}/fixture.js`,
            '',
            'false',
            'false',
          ],
          {
            env: {
              PATH: process.env.PATH,
              QL_DIR: root,
              QlPort: port,
              QL_CLI_LIFECYCLE: 'extended',
              ID: '12',
              SUB_ID: '3',
            },
            timeout: 15000,
          },
        ).then(
          (value) => ({ ...value, code: 0 }),
          (error) => error,
        );
        assert.equal(result.code, failed ? 1 : 0, result.stderr);
        assert.equal(
          await fs.readFile(path.join(root, 'config-loads'), 'utf8'),
          'x',
        );
        assert.equal(calls.length, 2);
        assert.deepEqual(
          calls.map((call) => call.status),
          ['0', '1'],
        );
        assert.deepEqual(calls[0].ids, [12]);
        assert.equal(calls[1].exit_code, failed ? 1 : 0);
        const logPath = calls[0].log_path;
        assert.match(logPath, /^raw\/.*\.log$/);
        const log = await fs.readFile(
          path.join(root, 'data/log', logPath),
          'utf8',
        );
        assert.doesNotMatch(log, /开始执行|执行结束/);
        if (failed) {
          assert.match(log, /503/);
          assert.doesNotMatch(result.stderr, /curl:.*503/);
        } else {
          const payload = JSON.parse(result.stdout);
          assert.equal(payload.logPath, logPath);
          assert.match(
            await fs.readFile(
              path.join(root, 'data/scripts', payload.data.file),
              'utf8',
            ),
            /downloaded/,
          );
        }
      } finally {
        await new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        });
      }
    }
  }
});

test(
  'compatibility commands finish lifecycle after signals and stop active children',
  { timeout: 90000 },
  async (t) => {
    const fs = require('node:fs/promises');
    const os = require('node:os');
    const http = require('node:http');
    const { spawn } = require('node:child_process');
    for (const mode of ['config', 'extra', 'raw', 'worker']) {
      for (const [signal, code] of [
        ['SIGINT', 130],
        ['SIGTERM', 143],
        ['SIGHUP', 129],
        ['SIGQUIT', 128 + os.constants.signals.SIGQUIT],
        ['SIGALRM', 128 + os.constants.signals.SIGALRM],
        ['SIGTSTP', 128 + os.constants.signals.SIGTSTP],
      ]) {
        const root = await fs.mkdtemp(
          path.join(os.tmpdir(), 'ql-compat-signal-'),
        );
        t.after(() => fs.rm(root, { recursive: true, force: true }));
        const calls = [];
        let ready;
        const started = new Promise((resolve) => {
          ready = resolve;
        });
        const server = http.createServer(async (req, res) => {
          if (req.url === '/waiting.js') {
            ready();
            return; // curl remains active until the command receives a signal.
          }
          let body = '';
          for await (const chunk of req) body += chunk;
          calls.push(JSON.parse(body));
          res.end(JSON.stringify({ code: 200 }));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        let child;
        try {
          await fs.mkdir(path.join(root, 'data/config'), { recursive: true });
          const wait =
            'echo $$ > "$QL_DIR/child.pid"\nprintf "READY\\n" >&2\nexec sleep 60\n';
          await fs.writeFile(
            path.join(root, 'data/config/config.sh'),
            mode === 'config' ? wait : '',
          );
          await fs.writeFile(path.join(root, 'data/config/extra.sh'), wait);
          await fs.writeFile(
            path.join(root, 'data/config/token.json'),
            JSON.stringify({
              value: 'fixture',
              expiration: Date.now() / 1000 + 3600,
            }),
          );
          const port = String(server.address().port);
          const args = [
            'raw',
            `http://127.0.0.1:${port}/waiting.js`,
            '',
            'false',
            'false',
          ];
          child = spawn(
            process.execPath,
            [
              path.resolve(
                __dirname,
                '../../dist',
                mode === 'worker' ? 'subscription-worker.js' : 'compat.js',
              ),
              ...(mode === 'config' || mode === 'extra' ? ['extra'] : args),
            ],
            {
              env: {
                PATH: process.env.PATH,
                QL_DIR: root,
                QlPort: port,
                QL_CLI_LIFECYCLE: 'extended',
                ID: '13',
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          let stdout = '',
            stderr = '';
          child.stdout.on('data', (chunk) => (stdout += chunk));
          child.stderr.on('data', (chunk) => {
            stderr += chunk;
            if (stderr.includes('READY')) ready();
          });
          const closed = new Promise((resolve) =>
            child.on('close', (code, signal) => resolve({ code, signal })),
          );
          await Promise.race([
            started,
            closed.then(() => {
              throw new Error(`Exited before readiness: ${stderr}`);
            }),
          ]);
          child.kill(signal);
          const result = await closed;
          assert.deepEqual(
            result,
            { code, signal: null },
            `${mode} ${signal}: ${stderr}`,
          );
          assert.equal(stdout, '');
          assert.equal(JSON.parse(stderr.trim().split('\n').at(-1)).code, code);
          if (mode === 'config') assert.equal(calls.length, 0);
          else {
            assert.deepEqual(
              calls.map((call) => call.status),
              ['0', '1'],
            );
            assert.equal(calls[1].exit_code, code);
          }
          if (mode === 'extra' || mode === 'config') {
            const pid = Number(
              await fs.readFile(path.join(root, 'child.pid'), 'utf8'),
            );
            assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
          }
        } finally {
          if (child?.exitCode === null && child?.signalCode === null)
            child.kill('SIGKILL');
          await new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          });
        }
      }
    }
  },
);
