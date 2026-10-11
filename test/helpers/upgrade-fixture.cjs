const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { collectBuildFiles } = require('../../docker/build-manifest.cjs');
const sourceCommit = 'a'.repeat(40);

function writeManifest(source, staticRoot) {
  const lockfile = path.join(source, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockfile)) fs.writeFileSync(lockfile, 'fixture lock\n');
  fs.mkdirSync(path.join(staticRoot, 'dist'), { recursive: true });
  if (!fs.existsSync(path.join(staticRoot, 'dist/index.html')))
    fs.writeFileSync(
      path.join(staticRoot, 'dist/index.html'),
      '<div id="root"></div>',
    );
  fs.writeFileSync(
    path.join(staticRoot, 'build-info.json'),
    JSON.stringify({
      version: 1,
      dirty: false,
      sourceCommit,
      lockfileSha256: createHash('sha256')
        .update(fs.readFileSync(lockfile))
        .digest('hex'),
      files: collectBuildFiles(staticRoot),
    }),
  );
}

module.exports = { writeManifest, sourceCommit };
