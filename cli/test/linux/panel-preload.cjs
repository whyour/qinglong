// Explicit opt-in: execute only in the disposable packaged evaluation panel.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createContext } = require('../../dist/internal/runtime/context');
const { LocalApi } = require('../../dist/internal/runtime/api');

(async () => {
  assert.equal(process.env.QL_PANEL_INTEGRATION, '1');
  assert.equal(process.env.QL_CLI_ROOT, '/opt/qinglong-cli');
  const api = new LocalApi(createContext({ root: '/ql' }, process.env));
  const marker = randomUUID();
  const name = `ql-preload-${marker}`;
  const global = execFileSync('pnpm', ['root', '-g'], {
    encoding: 'utf8',
  }).trim();
  assert.ok(path.isAbsolute(global));
  const packagePath = path.join(global, name);
  const beforePath = '/ql/data/config/task_before.sh';
  const before = await fs.readFile(beforePath);
  const ids = [],
    scripts = [];
  await fs.mkdir(packagePath, { recursive: true });
  try {
    await fs.writeFile(
      path.join(packagePath, 'package.json'),
      JSON.stringify({
        name,
        type: 'module',
        exports: { '.': './index.mjs', './feature': './feature.mjs' },
      }),
    );
    await fs.writeFile(
      path.join(packagePath, 'index.mjs'),
      `export default ${JSON.stringify(marker)};`,
    );
    await fs.writeFile(
      path.join(packagePath, 'feature.mjs'),
      `export default ${JSON.stringify(marker)};`,
    );
    await fs.appendFile(beforePath, `\nexport QL_PRELOAD_FIXTURE=${marker}\n`);
    for (const extension of ['js', 'mjs', 'py']) {
      const filename = `${name}.${extension}`;
      const file = path.join('/ql/data/scripts', filename);
      scripts.push(file);
      const source =
        extension === 'py'
          ? 'import os,json,builtins\nprint("PANEL_PRELOAD:"+json.dumps([os.getenv("QL_PRELOAD_FIXTURE"),hasattr(builtins,"QLAPI")]))\n'
          : extension === 'mjs'
          ? `import value from '${name}/feature'; console.log('PANEL_PRELOAD:'+JSON.stringify([process.env.QL_PRELOAD_FIXTURE,!!globalThis.QLAPI,value]));`
          : "console.log('PANEL_PRELOAD:'+JSON.stringify([process.env.QL_PRELOAD_FIXTURE,!!globalThis.QLAPI]));";
      await fs.writeFile(file, source);
      const task = (
        await api.call('crons', 'POST', {
          name: `Packaged preload ${extension}`,
          command: `task ${filename}`,
          schedule: '0 0 1 1 *',
        })
      ).data;
      ids.push(task.id);
      if (
        extension === 'js' &&
        process.env.QL_PANEL_RELOAD_INTEGRATION === '1'
      ) {
        const reload = JSON.parse(
          execFileSync(
            process.execPath,
            [
              path.resolve(__dirname, '../../dist/admin.js'),
              'reload',
              '--root',
              '/ql',
              '--json',
            ],
            { encoding: 'utf8', timeout: 60000 },
          ),
        );
        assert.equal(reload.code, 200);
        const deadline = Date.now() + 30000;
        let saved;
        while (Date.now() < deadline) {
          try {
            saved = (await api.call(`crons/${task.id}`)).data;
            break;
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        assert.equal(
          saved?.command,
          task.command,
          'task must survive services reload',
        );
        console.log(
          JSON.stringify({ servicesReloaded: true, taskRetained: true }),
        );
      }
      await api.call('crons/run', 'PUT', [task.id]);
      let log = '';
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        log = (await api.call(`crons/${task.id}/log`)).data || '';
        if (log.includes('PANEL_PRELOAD:') && /完成|执行结束/.test(log)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const found = log.match(/PANEL_PRELOAD:(.*)/);
      assert.ok(found, `${extension}: ${log}`);
      assert.deepEqual(
        JSON.parse(found[1]),
        extension === 'mjs' ? [marker, true, marker] : [marker, true],
      );
      assert.doesNotMatch(log, /run task before error|run builtin code error/);
      console.log(
        JSON.stringify({
          language: extension,
          panelScheduled: true,
          shellHook: true,
          QLAPI: true,
          ...(extension === 'mjs' ? { globalExportedSubpath: true } : {}),
        }),
      );
    }
  } finally {
    const cleaned = await Promise.allSettled([
      ...(ids.length ? [api.call('crons', 'DELETE', ids)] : []),
      fs.writeFile(beforePath, before),
      ...scripts.map((file) => fs.rm(file, { force: true })),
      fs.rm(packagePath, { recursive: true, force: true }),
    ]);
    const failed = cleaned.filter((result) => result.status === 'rejected');
    if (failed.length)
      throw new AggregateError(
        failed.map((result) => result.reason),
        'Disposable preload cleanup failed',
      );
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
