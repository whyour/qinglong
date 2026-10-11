const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('standalone public commands load only public modules and never local operators or backend dependencies', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ql-loading-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist');
  await fs.cp(path.resolve(__dirname, '../../dist'), dist, { recursive: true });
  const script = `
const path = require('node:path');
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
process.stderr.write = () => true;
const entry = process.argv[1];
require(entry).main(JSON.parse(process.argv[2])).then(code => {
  originalWrite(JSON.stringify({ code, modules: Object.keys(require.cache).map(file => path.relative(path.dirname(entry), file)) }));
});
`;
  for (const [args, expected] of [
    [['--help'], 0],
    [['task', 'list', '--help'], 0],
    [['auth', 'logout'], 0],
    [['auth', 'status', '--json'], 3],
    [['task', 'list', '--json'], 3],
    [['subscription', 'list', '--json'], 3],
  ]) {
    const child = spawnSync(
      process.execPath,
      ['-e', script, path.join(dist, 'main.js'), JSON.stringify(args)],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          QL_CLI_CONFIG: path.join(root, 'missing/config.json'),
          QL_DIR: '/nonexistent-panel',
        },
        timeout: 10000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.code, expected, JSON.stringify(args));
    assert.ok(result.modules.length > 0);
    for (const module of result.modules) {
      assert.ok(!module.startsWith('..'), `External module loaded: ${module}`);
      assert.doesNotMatch(
        module,
        /^(local|internal|back|preload)[/\\]|(^|[/\\])node_modules[/\\]/,
        JSON.stringify(args),
      );
    }
    if (args.includes('--help'))
      assert.ok(
        !result.modules.some((module) =>
          /^remote[/\\](commands[/\\](auth|open|task|subscription)\.js|api[/\\](client|download)\.js|auth[/\\])/.test(module),
        ),
        'Help eagerly loaded command implementation',
      );
    if (args[0] === 'task' && !args.includes('--help'))
      assert.ok(result.modules.includes(path.join('remote', 'commands', 'task.js')));
    if (args[0] === 'subscription')
      assert.ok(
        result.modules.includes(path.join('remote', 'commands', 'subscription.js')),
      );
  }
});
