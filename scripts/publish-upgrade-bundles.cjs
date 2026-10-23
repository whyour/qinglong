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
function releaseIndex(directory, commit, repository, options = {}) {
  const {
    version,
    releaseTag = `upgrade-${commit}`,
    migration = false,
  } = options;
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !/^[\w.+-]+$/.test(releaseTag)
  )
    throw new Error('Invalid release source');
  const readPackages = (bridge) => {
    const packages = {};
    for (const target of platforms) {
      const filename = `qinglong-${
        bridge ? 'migration-' : ''
      }${commit}-${target}.tar.gz`;
      const record = JSON.parse(
        fs.readFileSync(path.join(directory, filename + '.json')),
      );
      const bytes = fs.readFileSync(path.join(directory, filename));
      if (
        record.format !== 2 ||
        record.sourceCommit !== commit ||
        (version !== undefined &&
          (bridge ? record.migrationBridge?.targetVersion : record.version) !==
            version) ||
        (bridge &&
          (record.migrationVerified !== true ||
            record.migrationBridge?.sourceCommit !== commit ||
            record.migrationBridge?.legacySourceCommit !==
              require('../docker/migration-bridge-images.json')
                .sourceCommit)) ||
        (!bridge && record.migrationBridge) ||
        record.target !== target ||
        record.filename !== filename ||
        record.size !== bytes.length ||
        record.sha256 !== sha256(bytes)
      )
        throw new Error(`Unverified platform bundle: ${target}`);
      packages[target] = {
        size: record.size,
        sha256: record.sha256,
        url: `https://github.com/${repository}/releases/download/${encodeURIComponent(
          releaseTag,
        )}/${filename}`,
      };
    }
    return packages;
  };
  const runtimePackages = readPackages(false);
  return {
    format: 2,
    sourceCommit: commit,
    packages: migration ? readPackages(true) : runtimePackages,
    ...(migration ? { runtimePackages } : {}),
  };
}
function publishBundles({
  directory,
  commit,
  repository,
  branch,
  version,
  buildId,
  gh = (...args) =>
    execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
}) {
  if (!['master', 'develop'].includes(branch))
    throw new Error('Only master or develop images publish bundles');
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version || ''))
    throw new Error('Invalid bundle version');
  if (!/^\d+-\d+$/.test(buildId || ''))
    throw new Error('Invalid bundle build ID');
  // Rebuilding a version gets new download URLs, including when its commit is
  // unchanged. Only the version/channel pointer is overwritten, never bytes
  // that an in-flight download has already selected by hash.
  const development = branch === 'develop';
  const tag = `upgrade-build-${
    development ? 'develop-' : ''
  }v${version}-${buildId}`;
  const index = {
    ...releaseIndex(directory, commit, repository, {
      version,
      releaseTag: tag,
      migration: true,
    }),
    version,
    buildId,
    channel: branch,
  };
  const installer = fs.readFileSync(path.join(directory, 'install-bundle.cjs'));
  index.installer = {
    size: installer.length,
    sha256: sha256(installer),
    url: `https://github.com/${repository}/releases/download/${encodeURIComponent(
      tag,
    )}/install-bundle.cjs`,
  };
  fs.writeFileSync(
    path.join(directory, 'latest.json'),
    JSON.stringify(index) + '\n',
  );
  const lookup = (ref) => {
    try {
      return JSON.parse(
        gh(
          'api',
          `repos/${repository}/releases/tags/${encodeURIComponent(ref)}`,
        ),
      );
    } catch (error) {
      if (/\bHTTP 404\b/.test(String(error.stderr))) return null;
      throw error;
    }
  };
  const notes =
    `Verified platform bundles for v${version}, source ${commit}, build ${buildId}. Existing Node runtime is retained.\n\n` +
    Object.entries(index.runtimePackages)
      .map(([target, entry]) => `- [${target}](${entry.url})`)
      .join('\n') +
    `\n- [Standalone offline installer](${index.installer.url})\n\n` +
    'Legacy format-2 panels update the upgrader first, then download the runtime. ' +
    'The packages index contains the separate legacy bridge; runtimePackages contains the normal online/offline packages.';
  const ensureRelease = (ref, title) => {
    if (!lookup(ref))
      gh(
        'release',
        'create',
        ref,
        '--repo',
        repository,
        '--target',
        commit,
        '--prerelease',
        '--latest=false',
        '--title',
        title,
        '--notes',
        notes,
      );
  };
  const currentSource = () =>
    gh(
      'api',
      `repos/${repository}/git/ref/heads/${branch}`,
      '--jq',
      '.object.sha',
    ).trim() === commit;
  if (!currentSource()) {
    console.log('Newer source exists; leaving version and channel unchanged');
    return false;
  }
  ensureRelease(tag, `Platform upgrade v${version} (${buildId})`);
  const assets = platforms
    .flatMap((target) =>
      [false, true].flatMap((bridge) => {
        const archive = path.join(
          directory,
          `qinglong-${bridge ? 'migration-' : ''}${commit}-${target}.tar.gz`,
        );
        return [archive, archive + '.json'];
      }),
    )
    .concat(
      path.join(directory, 'install-bundle.cjs'),
      path.join(directory, 'latest.json'),
    );
  const published = lookup(tag);
  const missing = [];
  const matches = (asset, file) => {
    const bytes = fs.readFileSync(file);
    return (
      asset?.size === bytes.length && asset.digest === `sha256:${sha256(bytes)}`
    );
  };
  for (const file of assets) {
    const previous = published.assets.find(
      (a) => a.name === path.basename(file),
    );
    if (!previous) missing.push(file);
    else if (!matches(previous, file))
      throw new Error(
        `Immutable release asset differs: ${path.basename(file)}`,
      );
  }
  if (missing.length)
    gh('release', 'upload', tag, ...missing, '--repo', repository);
  const uploaded = lookup(tag);
  if (
    !assets.every((file) =>
      matches(
        uploaded.assets.find((a) => a.name === path.basename(file)),
        file,
      ),
    )
  )
    throw new Error('Published platform bundle verification failed');

  // Each channel serializes its image builds and pointer writes as one release.
  // A rerun of an earlier workflow is allowed to replace the same
  // version/commit; an obsolete source commit must never advance either alias.
  const aliases = development
    ? ['upgrade-develop']
    : [`upgrade-v${version}`, 'upgrade-master'];
  for (const ref of aliases) {
    if (!currentSource()) {
      console.log('Newer source exists; leaving version and channel unchanged');
      return false;
    }
    ensureRelease(
      ref,
      ref === `upgrade-${branch}`
        ? `Upgrade channel ${branch}`
        : `Platform upgrade v${version}`,
    );
    gh(
      'release',
      'upload',
      ref,
      path.join(directory, 'latest.json'),
      '--repo',
      repository,
      '--clobber',
    );
    gh('release', 'edit', ref, '--repo', repository, '--notes', notes);
    if (
      !matches(
        lookup(ref)?.assets.find((a) => a.name === 'latest.json'),
        path.join(directory, 'latest.json'),
      )
    )
      throw new Error('Published channel index verification failed');
  }
  // Only prune development releases after the complete new batch and its
  // channel pointer are verified. Production versions and aliases are retained.
  if (development && currentSource()) {
    const pages = JSON.parse(
      gh(
        'api',
        `repos/${repository}/releases?per_page=100`,
        '--paginate',
        '--slurp',
      ),
    );
    for (const release of pages.flat()) {
      if (
        release.tag_name !== tag &&
        /^upgrade-build-develop-v\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?-\d+-\d+$/.test(
          release.tag_name,
        ) &&
        release.prerelease === true &&
        release.draft === false
      ) {
        if (!currentSource()) break;
        gh(
          'release',
          'delete',
          release.tag_name,
          '--repo',
          repository,
          '--yes',
        );
      }
    }
  }
  return true;
}
module.exports = { releaseIndex, platforms, publishBundles };
if (require.main === module) {
  const [directory, commit, repository, branch] = process.argv.slice(2);
  const version = require('../package.json').version;
  if (
    require('js-yaml').load(
      fs.readFileSync(path.join(__dirname, '../version.yaml'), 'utf8'),
    ).version !== version
  )
    throw new Error('Package and image release versions differ');
  publishBundles({
    directory,
    commit,
    repository,
    branch,
    version,
    buildId: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  });
}
