const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { writeManifest, sourceCommit } = require('./upgrade-fixture.cjs');

async function manualUpgradeFixture(t, wrongVersion = false) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ql-manual-job-')),
  );
  const tmp = path.join(root, '.tmp');
  const workspace = path.join(tmp, 'upgrade-manual');
  const selected = {
    source: path.join(workspace, 'qinglong-develop'),
    static: path.join(workspace, 'qinglong-static-develop'),
  };
  for (const dir of [
    path.join(root, 'static/build'),
    path.join(root, 'shell'),
    path.join(root, 'data/config'),
    path.join(root, 'node_modules'),
    path.join(selected.source, 'sample'),
    path.join(selected.source, 'node_modules'),
    path.join(selected.static, 'build'),
  ])
    await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(root, 'static/build/app.js'), 'old backend');
  await fs.writeFile(path.join(root, '.env'), 'preserve configuration');
  await fs.writeFile(path.join(root, 'data/keep'), 'preserve data');
  await fs.writeFile(path.join(root, 'node_modules/old'), 'old dependency');
  await fs.writeFile(
    path.join(root, 'shell/share.sh'),
    'import_config(){ :; }\ndelete_pm2(){ :; }\nreload_pm2(){ :; }\n',
  );
  await fs.writeFile(path.join(root, 'shell/env.sh'), '');
  await fs.writeFile(
    path.join(selected.source, 'sample/config.sample.sh'),
    '# sample',
  );
  await fs.writeFile(
    path.join(selected.source, 'package.json'),
    '{"version":"2.24.0"}',
  );
  await fs.writeFile(
    path.join(selected.source, 'version.yaml'),
    'version: 2.24.0\n',
  );
  await fs.writeFile(path.join(selected.static, 'build/app.js'), 'new backend');
  writeManifest(selected.source, selected.static);
  const manifest = JSON.parse(
    await fs.readFile(path.join(selected.static, 'build-info.json')),
  );
  const expected = {
    version: '2.24.0',
    sourceCommit,
    backendSha256: manifest.files['build/app.js'],
    stageDirectory: 'upgrade-manual',
  };
  await fs.writeFile(
    path.join(workspace, 'ready.json'),
    JSON.stringify({
      ...selected,
      root,
      sourceCommit,
      dependenciesChanged: true,
    }),
  );
  await fs.writeFile(
    path.join(tmp, 'upgrade-ready-develop.json'),
    '{"directory":"upgrade-manual"}',
  );
  await fs.writeFile(
    path.join(tmp, 'panel-upgrade.json'),
    JSON.stringify({
      id: 'offline-prepared',
      action: 'download',
      status: 'ready',
      phase: 'ready',
      ...expected,
    }),
  );
  const server = http.createServer(async (_request, response) => {
    const content = await fs
      .readFile(path.join(root, 'static/build/app.js'), 'utf8')
      .catch(() => 'stopped');
    const updated = content === 'new backend';
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        code: 200,
        data: {
          status: 'ok',
          services: { http: true, grpc: true },
          build: {
            version: updated ? '2.24.0' : '2.23.0',
            sourceCommit:
              updated && !wrongVersion ? sourceCommit : 'b'.repeat(40),
            backendSha256: createHash('sha256').update(content).digest('hex'),
            instanceId: updated ? 'new-instance' : 'old-instance',
            parentPid: updated ? 222 : 111,
          },
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const env = {
    ...process.env,
    QL_DIR: root,
    QL_BRANCH: 'develop',
    dir_tmp: tmp,
    dir_static: path.join(root, 'static'),
    dir_data: path.join(root, 'data'),
    dir_config: path.join(root, 'data/config'),
    QlPort: String(server.address().port),
    QlBaseUrl: '/',
  };
  return {
    root,
    tmp,
    selected,
    env,
    expected,
    state: async () =>
      JSON.parse(await fs.readFile(path.join(tmp, 'panel-upgrade.json'))),
  };
}
module.exports = { manualUpgradeFixture };
