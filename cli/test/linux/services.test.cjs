const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createContext } = require('../../dist/local/context');
const { bootstrapPanel } = require('../../dist/local/bootstrap');
const { stopPanel } = require('../../dist/local/operator');
const { runProcess } = require('../../dist/local/process');

test(
  'real PM2 and nginx bootstrap reload serves requests and replaces configuration',
  { timeout: 45000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-services-'));
    const context = createContext(
      { root },
      {
        PATH: process.env.PATH,
        PM2_HOME: path.join(root, 'pm2'),
        HOME: root,
      },
    );
    const nginxConfig = path.join(root, 'nginx.conf');
    const options = {
      cwd: root,
      env: context.env,
      output: () => {},
      timeoutMs: 10000,
    };
    t.after(async () => {
      await runProcess('nginx', ['-c', nginxConfig, '-s', 'quit'], options);
      await runProcess('pm2', ['kill'], options);
      await fs.rm(root, { recursive: true, force: true });
    });
    await fs.mkdir(path.join(root, 'sample'));
    for (const name of [
      'config.sample.sh',
      'task.sample.sh',
      'extra.sample.sh',
      'notify.py',
      'notify.js',
      'ql_sample.js',
      'ql_sample.py',
    ])
      await fs.writeFile(path.join(root, 'sample', name), '');
    await fs.writeFile(path.join(root, '.env.example'), 'FIXTURE=1\n');
    await fs.mkdir(path.join(root, 'static/build'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'static/build/app.js'),
      'require("http").createServer((q,s)=>s.end(JSON.stringify({pid:process.pid}))).listen(5801,"127.0.0.1")',
    );
    await fs.writeFile(
      path.join(root, 'ecosystem.config.js'),
      'module.exports={apps:[{name:"fixture-panel",script:"static/build/app.js",instances:1,exec_mode:"fork"}]}',
    );
    const writeNginx = (generation) =>
      fs.writeFile(
        nginxConfig,
        `pid ${root}/nginx.pid;\nerror_log ${root}/nginx-error.log;\nevents {}\nhttp { access_log off; server { listen 127.0.0.1:5802; location / { add_header X-Fixture ${generation}; proxy_pass http://127.0.0.1:5801; } } }\n`,
      );
    await writeNginx('one');
    const system = {
      nginxConfig,
      nginxIncludes: path.join(root, 'nginx-includes'),
      nginxRun: path.join(root, 'nginx-run'),
      background: async () => {
        throw new Error('reload must not dispatch hooks');
      },
    };
    async function response(generation) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          const result = await fetch('http://127.0.0.1:5802', {
            signal: AbortSignal.timeout(500),
          });
          const body = await result.json();
          if (result.ok && result.headers.get('x-fixture') === generation)
            return body;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`nginx did not serve generation ${generation}`);
    }
    const first = await bootstrapPanel(context, true, system);
    assert.equal(first.service.manager, 'pm2');
    const before = await response('one');
    await writeNginx('two');
    const second = await bootstrapPanel(context, true, system);
    assert.equal(second.service.manager, 'pm2');
    const after = await response('two');
    assert.notEqual(after.pid, before.pid);
    await stopPanel(context);
    const list = await runProcess('pm2', ['jlist'], {
      ...options,
      capture: true,
    });
    assert.deepEqual(JSON.parse(list.stdout), []);
  },
);
