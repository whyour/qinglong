const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createContext } = require('../../dist/internal/runtime/context');
const operator = require('../../dist/internal/maintenance/operator');
const { stageUpgrade } = require('../../dist/internal/maintenance/upgrade');
const { cancellableOperation } = require('../../dist/internal/runtime/cancellation');

test(
  'published master archives pass actual HTTPS download and staging validation',
  {
    skip: process.env.QL_ARCHIVE_INTEGRATION !== '1',
    timeout: 180000,
  },
  async (t) => {
    const mirror = process.env.QL_ARCHIVE_MIRROR || 'github';
    assert.ok(['github', 'gitee'].includes(mirror));
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ql-published-archive-'),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(root, 'package.json'),
      '{"name":"isolated-archive-gate"}',
    );
    const context = createContext(
      { root },
      { PATH: process.env.PATH, HOME: root, QL_BRANCH: 'master' },
    );
    const installations = [];
    // This gate must not execute code from the downloaded source. Real dependency
    // installation and retained-data upgrade are separate existing Linux gates.
    t.mock.method(
      operator,
      'installPanelDependencies',
      async (ctx, directory) => {
        assert.equal(ctx.root, root);
        assert.equal(
          path.dirname(path.dirname(directory)),
          context.paths.dir_tmp,
        );
        installations.push(directory);
      },
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('SIGTERM'), 150000);
    t.after(() => clearTimeout(timer));
    const staged = await cancellableOperation(controller.signal, () =>
      stageUpgrade(context, mirror),
    );
    assert.deepEqual(installations, [staged.source]);
    const release = await fs.readFile(
      path.join(staged.source, 'version.yaml'),
      'utf8',
    );
    assert.match(
      release,
      /^version:\s*2\./m,
      'Published branch must still be 2.x',
    );
    await fs.access(path.join(staged.static, 'build/app.js'));
    const workspace = path.dirname(staged.source);
    const pointer = JSON.parse(
      await fs.readFile(
        path.join(context.paths.dir_tmp, 'upgrade-ready-master.json'),
        'utf8',
      ),
    );
    assert.equal(pointer.directory, path.basename(workspace));
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(workspace, 'ready.json'), 'utf8')),
      staged,
    );
    assert.equal(
      await fs.readFile(path.join(root, 'package.json'), 'utf8'),
      '{"name":"isolated-archive-gate"}',
    );
    const archives = {};
    for (const name of ['qinglong', 'qinglong-static']) {
      const content = await fs.readFile(path.join(workspace, `${name}.zip`));
      archives[name] = {
        bytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      };
    }
    t.diagnostic(
      JSON.stringify({
        mirror,
        release: release.match(/^version:\s*(\S+)/m)?.[1],
        archives,
        downloadedCodeExecuted: false,
      }),
    );
  },
);
