const fs = require('node:fs/promises');
const path = require('node:path');
const tar = require('tar');
const bundle = require('../cli/src/internal/maintenance/platformBundle.cjs');
const {
  verifyUpgrade,
} = require('../cli/src/internal/maintenance/upgradeArtifacts.cjs');

async function buildBundle(root, output) {
  root = path.resolve(root);
  output = path.resolve(output);
  const target = await bundle.runtimeTarget();
  if (process.platform !== 'linux')
    throw new Error('Release bundles must be built and probed on Linux');
  const build = await verifyUpgrade(root, path.join(root, 'static'));
  await bundle.smokeDependencies(root);
  await fs.mkdir(output, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(output, '.bundle-'));
  try {
    const payload = path.join(workspace, 'qinglong');
    const source = path.join(payload, 'source'),
      staticRoot = path.join(payload, 'static');
    await fs.mkdir(source, { recursive: true });
    const excluded = new Set([
      '.git',
      '.tmp',
      '.env',
      'data',
      'static',
      'output',
      'node_modules',
    ]);
    for (const name of await fs.readdir(root)) {
      if (excluded.has(name)) continue;
      await fs.cp(path.join(root, name), path.join(source, name), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    await fs.cp(
      path.join(root, 'node_modules'),
      path.join(source, 'node_modules'),
      { recursive: true, verbatimSymlinks: true },
    );
    await fs.cp(path.join(root, 'static'), staticRoot, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const manifest = {
      format: 2,
      sourceCommit: build.sourceCommit,
      version: JSON.parse(
        await fs.readFile(path.join(root, 'package.json'), 'utf8'),
      ).version,
      lockfileSha256: build.lockfileSha256,
      target: {
        platform: target.platform,
        arch: target.arch,
        libc: target.libc,
        libcMinimum: target.libcVersion,
        endianness: target.endianness,
        armFloatAbi: target.armFloatAbi,
      },
      nodeMinimum: '20.18.1',
      nodeApi: 6,
      files: await bundle.inventory({ source, static: staticRoot }),
    };
    await fs.writeFile(
      path.join(payload, 'bundle.json'),
      JSON.stringify(manifest),
    );
    const filename = `qinglong-${build.sourceCommit}-${bundle.targetKey(
      target,
    )}.tar.gz`;
    await tar.c(
      {
        gzip: true,
        portable: true,
        noMtime: true,
        cwd: workspace,
        file: path.join(output, filename),
      },
      ['qinglong'],
    );
    const bytes = await fs.readFile(path.join(output, filename));
    const record = {
      format: 2,
      sourceCommit: build.sourceCommit,
      target: bundle.targetKey(target),
      filename,
      baseImage: process.env.QL_BUNDLE_BASE_IMAGE,
      size: bytes.length,
      sha256: bundle.sha256(bytes),
    };
    await fs.writeFile(
      path.join(output, filename + '.json'),
      JSON.stringify(record) + '\n',
    );
    console.log(JSON.stringify(record));
    return record;
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}
module.exports = { buildBundle };
if (require.main === module)
  buildBundle(process.argv[2] || '/ql', process.argv[3] || '/out').catch(
    (e) => {
      console.error(e);
      process.exitCode = 1;
    },
  );
