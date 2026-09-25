const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Exercise the real dispatcher/parser without performing an actual upgrade,
// service restart or account mutation.
function invoke(args) {
  const script = `
require('./cli/dist/internal/commands/dispatch').dispatch = async command => ({code:200,data:command});
require('./cli/dist/ql').qlMain(JSON.parse(process.argv[1])).then(code=>{process.exitCode=code});`;
  return spawnSync(process.execPath, ['-e', script, JSON.stringify(args)], {
    cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8',
    env: { PATH: process.env.PATH, QL_LANG: 'en' }, timeout: 5000,
  });
}

test('direct maintenance commands and local aliases accept modern and legacy options identically', () => {
  for (const [args, name, values, positionals] of [
    [['update', '--mirror', 'gitee', '--download-only', '--root', '/isolated'], 'update', {mirror:'gitee', 'download-only':true, root:'/isolated'}, []],
    [['update', 'false', '--root', '/isolated'], 'update', {'download-only':true, root:'/isolated'}, []],
    [['update', 'true'], 'update', {mirror:'github'}, []],
    [['reload', 'system', '--root', '/isolated'], 'reload', {target:'system', root:'/isolated'}, []],
    [['reload', '--target', 'data'], 'reload', {target:'data'}, []],
    [['check'], 'check', {}, []],
    [['rmlog', '7'], 'rmlog', {}, ['7']],
    [['start', '--no-startup'], 'start', {'no-startup':true}, []],
    [['repair-config'], 'repair-config', {}, []],
    [['resetpwd', '--', '-literal-value'], 'resetpwd', {}, ['-literal-value']],
    [['update', '--root', 'false'], 'update', {root:'false'}, []],
  ]) {
    const direct = invoke(['--json', ...args]);
    const alias = invoke(['--json', 'local', ...args]);
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(alias.status, 0, alias.stderr);
    assert.deepEqual(JSON.parse(direct.stdout), JSON.parse(alias.stdout));
    const command = JSON.parse(direct.stdout).data;
    assert.equal(command.name, `local ${name}`);
    assert.deepEqual(command.positionals, positionals);
    for (const [key, value] of Object.entries(values)) assert.equal(command.values[key], value);
  }
});

test('invalid maintenance options fail before dispatch; help recommends direct commands', () => {
  for (const args of [
    ['update', 'invalid'], ['reload', 'invalid'], ['update', 'false', 'extra'],
    ['reload', 'system', '--target', 'data'], ['update', '--unknown'],
    ['update', '--', 'false'], ['rmlog', '-1'],
  ]) {
    const result = invoke(['--json', ...args]);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 2);
  }
  for (const group of [[], ['local']]) {
    const result = invoke([...group, 'update', '--help', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const help = JSON.parse(result.stdout).data.help;
    assert.match(help, /Usage: ql update/);
    assert.match(help, /--mirror/);
    assert.match(help, /--download-only/);
  }
});

test('direct and aliased maintenance preserve logs, lifecycle and single configuration evaluation', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const http = require('node:http');
  const exec = require('node:util').promisify(require('node:child_process').execFile);
  for (const prefix of [[], ['local']]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-direct-extra-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const reports = [];
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      reports.push({ url: req.url, data: JSON.parse(body) });
      res.end(JSON.stringify({ code: 200 }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await fs.mkdir(path.join(root, 'data/config'), { recursive: true });
      await fs.writeFile(path.join(root, 'data/config/config.sh'), 'no_tee=true\nprintf x >> "$QL_DIR/loads"\n');
      await fs.writeFile(path.join(root, 'data/config/token.json'), JSON.stringify({value:'fixture', expiration:Date.now()/1000+3600}));
      await fs.writeFile(path.join(root, 'data/config/extra.sh'), 'printf "logged-extra\\n"\n');
      const result = await exec(process.execPath, [path.resolve(__dirname, '../../dist/ql.js'), ...prefix, 'extra', '--root', root, '--json'], {
        env: {PATH:process.env.PATH, QlPort:String(server.address().port), ID:'9'}, timeout:10000,
      });
      assert.equal(await fs.readFile(path.join(root, 'loads'), 'utf8'), 'x');
      assert.equal(result.stderr, '');
      const response = JSON.parse(result.stdout);
      assert.match(response.logPath, /^extra\//);
      assert.match(await fs.readFile(path.join(root, 'data/log', response.logPath), 'utf8'), /logged-extra/);
      assert.deepEqual(reports.map(report => report.data.status), ['0', '1']);
      assert.ok(reports.every(report => report.url === '/open/crons/status'));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
});
