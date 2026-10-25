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
  'linux-arm64-glibc',
  'linux-ppc64-glibc',
  'linux-s390x-glibc',
];
function releaseIndex(directory, commit, repository, options = {}) {
  const { version, releaseTag = `upgrade-${commit}`, assetBuildId } = options;
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !/^[\w.+-]+$/.test(releaseTag) ||
    (assetBuildId && !/^\d+-\d+$/.test(assetBuildId))
  )
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
      (version !== undefined && record.version !== version) ||
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
      )}/${
        assetBuildId
          ? filename.replace(/\.tar\.gz$/, `-${assetBuildId}.tar.gz`)
          : filename
      }`,
    };
  }
  return { format: 2, sourceCommit: commit, packages };
}
function stageDevelopmentAssets(directory, commit, buildId) {
  const staged = fs.mkdtempSync(path.join(directory, '.upgrade-develop-'));
  const assets = [];
  try {
    for (const target of platforms) {
      const filename = `qinglong-${commit}-${target}.tar.gz`;
      const archiveName = filename.replace(/\.tar\.gz$/, `-${buildId}.tar.gz`);
      const archive = path.join(staged, archiveName);
      fs.linkSync(path.join(directory, filename), archive);
      const record = JSON.parse(
        fs.readFileSync(path.join(directory, filename + '.json')),
      );
      fs.writeFileSync(
        archive + '.json',
        JSON.stringify({
          ...record,
          filename: archiveName,
        }) + '\n',
      );
      assets.push(archive, archive + '.json');
    }
    const installer = path.join(staged, `install-bundle-${buildId}.cjs`);
    fs.linkSync(path.join(directory, 'install-bundle.cjs'), installer);
    assets.push(installer);
    return { staged, assets };
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw error;
  }
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
  const tag = development
    ? 'upgrade-develop'
    : `upgrade-build-v${version}-${buildId}`;
  const index = {
    ...releaseIndex(directory, commit, repository, {
      version,
      releaseTag: tag,
      assetBuildId: development ? buildId : undefined,
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
    )}/${development ? `install-bundle-${buildId}.cjs` : 'install-bundle.cjs'}`,
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
    `${
      development ? 'Development' : 'Verified'
    } platform bundles for v${version}, source ${commit}, build ${buildId}. Existing Node runtime is retained.\n\n` +
    Object.entries(index.packages)
      .map(([target, entry]) => `- [${target}](${entry.url})`)
      .join('\n') +
    `\n- [Standalone offline installer](${index.installer.url})`;
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
  const staged = development
    ? stageDevelopmentAssets(directory, commit, buildId)
    : null;
  try {
    ensureRelease(
      tag,
      development
        ? 'Upgrade channel develop'
        : `Platform upgrade v${version} (${buildId})`,
    );
    const assets =
      staged?.assets ||
      platforms
        .flatMap((target) => {
          const archive = path.join(
            directory,
            `qinglong-${commit}-${target}.tar.gz`,
          );
          return [archive, archive + '.json'];
        })
        .concat(
          path.join(directory, 'install-bundle.cjs'),
          path.join(directory, 'latest.json'),
        );
    const published = lookup(tag);
    const missing = [];
    const matches = (asset, file) => {
      const bytes = fs.readFileSync(file);
      return (
        asset?.size === bytes.length &&
        asset.digest === `sha256:${sha256(bytes)}`
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
        console.log(
          'Newer source exists; leaving version and channel unchanged',
        );
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
      const currentAssets = new Set(assets.map((file) => path.basename(file)));
      for (const asset of lookup(tag).assets) {
        if (
          !currentAssets.has(asset.name) &&
          (/^qinglong-[a-f0-9]{40}-linux-[\w-]+-\d+-\d+\.tar\.gz(?:\.json)?$/.test(
            asset.name,
          ) ||
            /^install-bundle-\d+-\d+\.cjs$/.test(asset.name))
        ) {
          if (!currentSource()) break;
          gh(
            'api',
            '-X',
            'DELETE',
            `repos/${repository}/releases/assets/${asset.id}`,
          );
        }
      }
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
          /^upgrade-build-develop-(?:v\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?-)?\d+-\d+$/.test(
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
  } finally {
    if (staged) fs.rmSync(staged.staged, { recursive: true, force: true });
  }
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
