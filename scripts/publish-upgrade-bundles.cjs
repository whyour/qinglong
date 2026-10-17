const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  sha256,
} = require('../cli/src/internal/maintenance/platformBundle.cjs');
const platforms = [
  'linux-x64-musl',
  'linux-armv6-musl',
  'linux-armv7-musl',
  'linux-arm64-musl',
  'linux-ppc64-musl',
  'linux-s390x-musl',
  'linux-ia32-musl',
  'linux-x64-glibc',
  'linux-armv7-glibc',
  'linux-arm64-glibc',
  'linux-ppc64-glibc',
  'linux-s390x-glibc',
];
function releaseIndex(directory, commit, repository) {
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error('Invalid release source');
  const packages = {};
  for (const target of platforms) {
    const filename = `qinglong-${commit}-${target}.tar.gz`;
    const record = JSON.parse(
      fs.readFileSync(path.join(directory, filename + '.json')),
    );
    const bytes = fs.readFileSync(path.join(directory, filename));
    if (
      record.format !== 2 ||
      record.sourceCommit !== commit ||
      record.target !== target ||
      record.filename !== filename ||
      record.size !== bytes.length ||
      record.sha256 !== sha256(bytes)
    )
      throw new Error(`Unverified platform bundle: ${target}`);
    packages[target] = {
      size: record.size,
      sha256: record.sha256,
      url: `https://github.com/${repository}/releases/download/upgrade-${commit}/${filename}`,
    };
  }
  return { format: 2, sourceCommit: commit, packages };
}
module.exports = { releaseIndex, platforms };
if (require.main === module) {
  const [directory, commit, repository, branch] = process.argv.slice(2);
  const index = releaseIndex(directory, commit, repository);
  const installer = fs.readFileSync(path.join(directory, 'install-bundle.cjs'));
  index.installer = {
    size: installer.length,
    sha256: sha256(installer),
    url: `https://github.com/${repository}/releases/download/upgrade-${commit}/install-bundle.cjs`,
  };
  if (!['develop', 'master'].includes(branch))
    throw new Error('Invalid release channel');
  fs.writeFileSync(
    path.join(directory, 'latest.json'),
    JSON.stringify(index) + '\n',
  );
  const gh = (...args) =>
    execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const tag = `upgrade-${commit}`;
  try {
    gh('release', 'view', tag, '--repo', repository);
  } catch {
    gh(
      'release',
      'create',
      tag,
      '--repo',
      repository,
      '--target',
      commit,
      '--prerelease',
      '--title',
      `Platform upgrade ${commit.slice(0, 12)}`,
      '--notes',
      'Verified platform bundles with production dependencies. Existing Node runtime is retained.',
    );
  }
  const assets = fs
    .readdirSync(directory)
    .filter((n) => /\.(?:tar\.gz|cjs|json)$/.test(n) && n !== 'latest.json')
    .map((n) => path.join(directory, n));
  const published = JSON.parse(
    gh('api', `repos/${repository}/releases/tags/${tag}`),
  );
  const missing = [];
  for (const file of [...assets, path.join(directory, 'latest.json')]) {
    const bytes = fs.readFileSync(file);
    const previous = published.assets.find(
      (a) => a.name === path.basename(file),
    );
    if (!previous) missing.push(file);
    else if (
      previous.size !== bytes.length ||
      previous.digest !== `sha256:${sha256(bytes)}`
    )
      throw new Error(
        `Immutable release asset differs: ${path.basename(file)}`,
      );
  }
  if (missing.length)
    gh('release', 'upload', tag, ...missing, '--repo', repository);
  // An older, slower run may publish immutable assets, but must not regress a channel.
  if (
    gh(
      'api',
      `repos/${repository}/git/ref/heads/${branch}`,
      '--jq',
      '.object.sha',
    ).trim() !== commit
  ) {
    console.log('Newer source exists; leaving channel unchanged');
  } else {
    const channel = `upgrade-${branch}`;
    try {
      gh('release', 'view', channel, '--repo', repository);
    } catch {
      gh(
        'release',
        'create',
        channel,
        '--repo',
        repository,
        '--target',
        commit,
        '--prerelease',
        '--title',
        `Upgrade channel ${branch}`,
        '--notes',
        'The latest.json asset selects immutable, fully verified platform bundles.',
      );
    }
    gh(
      'release',
      'upload',
      channel,
      path.join(directory, 'latest.json'),
      '--repo',
      repository,
      '--clobber',
    );
  }
}
