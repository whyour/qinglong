// Verify the actual archive under an unsupported Node without touching any
// existing installation. This is also the Node 20 negative CI matrix entry.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

async function verifyRuntimeFloor(input, output) {
  assert.equal(
    Number(process.versions.node.split('.')[0]),
    20,
    'Run this rejection test with Node 20',
  );
  const names = (await fs.readdir(input)).filter((name) =>
    name.endsWith('.tgz'),
  );
  assert.equal(names.length, 1, 'Expected one actual npm archive');
  const archive = path.resolve(input, names[0]);
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ql-node-floor-')),
  );
  const env = {
    PATH: process.env.PATH,
    HOME: temp,
    TMPDIR: temp,
    npm_config_cache: path.join(temp, 'cache'),
    npm_config_userconfig: path.join(temp, 'npmrc'),
    npm_config_globalconfig: path.join(temp, 'global-npmrc'),
  };
  const npm = (args) =>
    execute('npm', args, {
      cwd: temp,
      env,
      encoding: 'utf8',
      timeout: 600000,
      maxBuffer: 4 * 1024 * 1024,
    });
  try {
    await fs.writeFile(env.npm_config_userconfig, '');
    await fs.writeFile(env.npm_config_globalconfig, '');
    const legacy = path.join(temp, 'legacy');
    await fs.mkdir(legacy);
    await fs.writeFile(
      path.join(legacy, 'package.json'),
      JSON.stringify({ name: '@whyour/qinglong', version: '2.22.0' }),
    );
    await fs.writeFile(path.join(legacy, 'legacy-marker'), 'old application');
    const [old] = JSON.parse(
      (
        await execute('npm', ['pack', '--json', '--ignore-scripts'], {
          cwd: legacy,
          env,
        })
      ).stdout,
    );
    for (const global of [false, true]) {
      const prefix = path.join(temp, global ? 'global' : 'local');
      const installed = path.join(
        prefix,
        global
          ? 'lib/node_modules/@whyour/qinglong'
          : 'node_modules/@whyour/qinglong',
      );
      const args = [
        'install',
        ...(global ? ['--global'] : []),
        '--prefix',
        prefix,
        '--omit=dev',
        '--no-audit',
        '--no-fund',
      ];
      await npm([...args, path.join(legacy, old.filename)]);
      const environment = Buffer.from(
        'QL_DATA_DIR=/external/data\r\nSYNTHETIC_SECRET=keep\n',
      );
      const data = path.join(temp, global ? 'global-data' : 'local-data');
      await fs.writeFile(path.join(installed, '.env'), environment);
      await fs.writeFile(data, 'synthetic old data');
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
        const fs=require('node:fs'),http=require('node:http');
        const value=fs.readFileSync(process.argv[1],'utf8')+fs.readFileSync(process.argv[2],'utf8');
        const server=http.createServer((q,r)=>r.end(value));
        server.listen(0,'127.0.0.1',()=>process.send(server.address().port));
      `,
          path.join(installed, '.env'),
          data,
        ],
        { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
      );
      const stopped = new Promise((resolve) => child.once('exit', resolve));
      try {
        const port = await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Old service startup timed out')),
            10000,
          );
          child.once('message', (value) => {
            clearTimeout(timer);
            resolve(value);
          });
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('exit', () => {
            clearTimeout(timer);
            reject(new Error('Old service exited'));
          });
        });
        const url = `http://127.0.0.1:${port}`;
        const before = await (await fetch(url)).text();
        await assert.rejects(npm([...args, archive]), (error) => {
          assert.equal(
            error.killed,
            false,
            `npm did not reach the runtime guard: ${error.message}`,
          );
          assert.match(error.stderr + error.stdout, /requires Node >=22\.17/);
          return true;
        });
        assert.equal(
          JSON.parse(await fs.readFile(path.join(installed, 'package.json')))
            .version,
          '2.22.0',
        );
        assert.deepEqual(
          await fs.readFile(path.join(installed, '.env')),
          environment,
        );
        assert.equal(await fs.readFile(data, 'utf8'), 'synthetic old data');
        assert.equal(child.exitCode, null);
        assert.equal(await (await fetch(url)).text(), before);
      } finally {
        child.kill('SIGKILL');
        await stopped;
      }
    }
    const result = {
      node: process.version,
      unsupportedRuntimeRejected: true,
      localAndGlobalOldPackagePreserved: true,
      environmentAndDataPreserved: true,
      oldServiceStayedHealthy: true,
    };
    if (output) {
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(
        path.join(output, `verification-${process.version}.json`),
        JSON.stringify(result, null, 2),
      );
    }
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

module.exports = { verifyRuntimeFloor };
if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input)
    throw new Error(
      'Usage: node scripts/verify-panel-runtime-floor.cjs ARCHIVE_DIRECTORY [RESULT_DIRECTORY]',
    );
  verifyRuntimeFloor(path.resolve(input), output && path.resolve(output)).catch(
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
