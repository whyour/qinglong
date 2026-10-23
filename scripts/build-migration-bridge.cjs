// A separate first-hop package for installed format-2 verifiers. Its database
// backend and dependencies remain the pinned legacy implementation. Only the
// updater and frontend are replaced; the next download uses runtimePackages.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { pipeline } = require('node:stream/promises');
const { once } = require('node:events');
const { collectBuildFiles } = require('../docker/build-manifest.cjs');
const { buildBundle } = require('./build-upgrade-bundle.cjs');
const artifacts = require('../cli/src/internal/maintenance/upgradeArtifacts.cjs');
const bundle = require('../cli/src/internal/maintenance/platformBundle.cjs');
const baseline = require('../docker/migration-bridge-images.json');
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

async function prepareBridge(legacy, current, destination) {
  const oldBuild = await artifacts.verifyUpgrade(
    legacy,
    path.join(legacy, 'static'),
  );
  const build = await artifacts.verifyUpgrade(
    current,
    path.join(current, 'static'),
  );
  const pkg = await read(path.join(legacy, 'package.json'));
  const next = await read(path.join(current, 'package.json'));
  if (
    oldBuild.sourceCommit !== baseline.sourceCommit ||
    pkg.qinglongUpgradeFormat !== 2 ||
    !pkg.dependencies?.sqlite3 ||
    !pkg.dependencies?.sequelize ||
    !next.dependencies?.['@mikro-orm/sql']
  )
    throw new Error(
      'Migration bridge requires the pinned legacy backend and a modern runtime',
    );
  // Never copy user state, even if this builder is used outside Docker.
  const excluded = new Set(['.git', '.tmp', '.env', 'data', 'output']);
  await fs.cp(legacy, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (file) =>
      !excluded.has(path.relative(legacy, file).split(path.sep)[0]),
  });
  const maintenance = 'cli/src/internal/maintenance';
  await fs.rm(path.join(destination, maintenance), {
    recursive: true,
    force: true,
  });
  await fs.cp(
    path.join(current, maintenance),
    path.join(destination, maintenance),
    { recursive: true },
  );
  await fs.rm(path.join(destination, 'static/dist'), {
    recursive: true,
    force: true,
  });
  await fs.cp(
    path.join(current, 'static/dist'),
    path.join(destination, 'static/dist'),
    { recursive: true },
  );
  const migrationBridge = {
    format: 1,
    legacySourceCommit: oldBuild.sourceCommit,
    sourceCommit: build.sourceCommit,
    targetVersion: next.version,
  };
  await fs.writeFile(
    path.join(destination, 'package.json'),
    JSON.stringify(
      {
        ...pkg,
        qinglongRuntimeMinimum: '22.17.0',
        qinglongMigrationBridge: migrationBridge,
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    path.join(destination, 'static/build-info.json'),
    JSON.stringify({
      ...oldBuild,
      sourceCommit: build.sourceCommit,
      files: collectBuildFiles(path.join(destination, 'static')),
    }),
  );
  // No backend bytes or dependency lock may change in the updater hop.
  assert.equal(
    bundle.sha256(
      await fs.readFile(path.join(destination, 'static/build/app.js')),
    ),
    oldBuild.files['build/app.js'],
  );
  assert.equal(
    bundle.sha256(await fs.readFile(path.join(destination, 'pnpm-lock.yaml'))),
    oldBuild.lockfileSha256,
  );
  return migrationBridge;
}

async function verifyBothDownloads(legacy, current, directory, records) {
  let index, workspace;
  const files = new Map(
    records.map((r) => ['/' + r.filename, path.join(directory, r.filename)]),
  );
  const server = http.createServer((req, res) => {
    if (!index) {
      res.writeHead(503);
      res.end();
      return;
    }
    if (req.url === '/latest.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(index));
    } else if (files.has(req.url)) {
      const record = records.find((r) => '/' + r.filename === req.url);
      res.setHeader('Content-Length', record.size);
      pipeline(createReadStream(files.get(req.url)), res).catch(() =>
        res.destroy(),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const entry = (r) => ({
      size: r.size,
      sha256: r.sha256,
      url: base + '/' + r.filename,
    });
    const [bridge, runtime] = records;
    index = {
      format: 2,
      sourceCommit: runtime.sourceCommit,
      packages: { [bridge.target]: entry(bridge) },
      runtimePackages: { [runtime.target]: entry(runtime) },
    };
    workspace = await fs.mkdtemp(path.join(directory, '.legacy-client-'));
    const env = {
      ...process.env,
      QL_BRANCH: 'develop',
      QL_UPGRADE_INDEX_URL: base + '/latest.json',
      QL_UPGRADE_FILE: '',
      NO_PROXY: '127.0.0.1',
      no_proxy: '127.0.0.1',
    };
    const old = require(path.join(
      legacy,
      'cli/src/internal/maintenance/upgradeArtifacts.cjs',
    ));
    const firstTmp = path.join(workspace, 'first');
    await fs.mkdir(firstTmp);
    // These are the unchanged, genuinely installed old download, dependency
    // smoke, prestart and readiness verifiers. No injected probe or verifier.
    const selected = await old.stageUpgrade({
      root: legacy,
      tmp: firstTmp,
      env,
      run: (program, args, capture) =>
        old.runProcess(env, program, args, capture),
    });
    await old.selectedUpgrade(firstTmp, 'develop', env);
    assert(
      (await read(path.join(selected.source, 'package.json')))
        .qinglongMigrationBridge,
    );
    const upgraded = require(path.join(
      selected.source,
      'cli/src/internal/maintenance/upgradeArtifacts.cjs',
    ));
    const secondTmp = path.join(workspace, 'second');
    await fs.mkdir(secondTmp);
    const next = await upgraded.stageUpgrade({
      root: selected.source,
      tmp: secondTmp,
      env,
      run: (program, args, capture) =>
        upgraded.runProcess(env, program, args, capture),
    });
    await upgraded.selectedUpgrade(secondTmp, 'develop', env);
    const pkg = await read(path.join(next.source, 'package.json'));
    assert(pkg.dependencies['@mikro-orm/sql']);
    assert.equal(pkg.qinglongMigrationBridge, undefined);
    await assert.rejects(
      fs.access(path.join(next.source, 'node_modules/sqlite3')),
      { code: 'ENOENT' },
    );
    await assert.rejects(
      fs.access(path.join(next.source, 'node_modules/sequelize')),
      { code: 'ENOENT' },
    );
    const oldBundle = require(path.join(
      legacy,
      'cli/src/internal/maintenance/platformBundle.cjs',
    ));
    const manifest = await read(
      path.join(path.dirname(selected.source), 'bundle.json'),
    );
    assert.throws(
      () =>
        oldBundle.assertCompatible(
          manifest,
          { ...manifest.target, libcVersion: manifest.target.libcMinimum },
          '20.18.1',
        ),
      /requires Node/,
    );
    return {
      legacyOnlineVerified: true,
      modernOnlineVerified: true,
      legacyNode20Rejected: true,
    };
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  }
}

async function buildMigrationBridge(legacy, current, output) {
  legacy = path.resolve(legacy);
  current = path.resolve(current);
  output = path.resolve(output);
  await fs.mkdir(output, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(output, '.migration-'));
  let bridge;
  try {
    const root = path.join(workspace, 'root');
    await prepareBridge(legacy, current, root);
    const runtime = await buildBundle(current, output);
    bridge = await buildBundle(root, output);
    const verification = await verifyBothDownloads(legacy, current, output, [
      bridge,
      runtime,
    ]);
    bridge = { ...bridge, migrationVerified: true, ...verification };
    await fs.writeFile(
      path.join(output, bridge.filename + '.json'),
      JSON.stringify(bridge) + '\n',
    );
    console.log(JSON.stringify(bridge));
    return bridge;
  } catch (error) {
    if (bridge)
      await fs.rm(path.join(output, bridge.filename + '.json'), {
        force: true,
      });
    throw error;
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

module.exports = { prepareBridge, verifyBothDownloads, buildMigrationBridge };
if (require.main === module)
  buildMigrationBridge(process.argv[2], process.argv[3], process.argv[4]).catch(
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
