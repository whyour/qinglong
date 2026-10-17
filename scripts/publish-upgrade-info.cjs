// Publish archive sizes separately: adding them to the archive itself would
// change its bytes. Immutable commit URLs make both size and checksum stable.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function publishUpgradeInfo(
  destination,
  ref,
  sourceCommit,
  execute = execFileSync,
) {
  const run = (program, args) =>
    execute(program, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  if (!/^[a-f0-9]{40}$/.test(sourceCommit))
    throw new Error('Invalid source commit');
  run('git', ['check-ref-format', `refs/heads/${ref}`]);
  const staticCommit = run('git', [
    'ls-remote',
    destination,
    `refs/heads/${ref}`,
  ])
    .trim()
    .split(/\s/)[0];
  if (!/^[a-f0-9]{40}$/.test(staticCommit))
    throw new Error('Missing static commit');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-upgrade-info-'));
  try {
    const archives = {};
    for (const [repository, commit] of [
      ['qinglong-static', staticCommit],
      ['qinglong', sourceCommit],
    ]) {
      const filename = path.join(tmp, `${repository}.zip`);
      run('curl', [
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--connect-timeout',
        '30',
        '--max-time',
        '600',
        '--output',
        filename,
        `https://codeload.github.com/whyour/${repository}/zip/${commit}`,
      ]);
      run('unzip', ['-tq', filename]);
      if (repository === 'qinglong-static') {
        const manifest = JSON.parse(
          run('unzip', [
            '-p',
            filename,
            `${repository}-${commit}/build-info.json`,
          ]),
        );
        if (manifest.sourceCommit !== sourceCommit || manifest.dirty !== false)
          throw new Error('Static source commit does not match this build');
      }
      const bytes = fs.readFileSync(filename);
      archives[repository] = {
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }
    const info = { version: 1, sourceCommit, staticCommit, archives };
    for (let attempt = 0; attempt < 3; attempt++) {
      const checkout = path.join(tmp, `metadata-${attempt}`);
      const exists = run('git', [
        'ls-remote',
        destination,
        'refs/heads/upgrade-info',
      ]).trim();
      if (exists)
        run('git', [
          'clone',
          '--quiet',
          '--depth',
          '1',
          '--branch',
          'upgrade-info',
          '--single-branch',
          destination,
          checkout,
        ]);
      else run('git', ['init', '--quiet', '-b', 'upgrade-info', checkout]);
      const git = (...args) => run('git', ['-C', checkout, ...args]);
      git('config', 'user.name', 'github-actions[bot]');
      git(
        'config',
        'user.email',
        'github-actions[bot]@users.noreply.github.com',
      );
      fs.writeFileSync(
        path.join(checkout, `${sourceCommit}.json`),
        JSON.stringify(info) + '\n',
      );
      git('add', `${sourceCommit}.json`);
      git(
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        `Archive metadata for ${sourceCommit}`,
      );
      try {
        git('push', '--quiet', destination, 'HEAD:refs/heads/upgrade-info');
        return info;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { publishUpgradeInfo };
if (require.main === module) {
  try {
    publishUpgradeInfo(...process.argv.slice(2));
  } catch {
    // Git errors may include a credential-bearing remote URL.
    console.error('Failed to publish verified upgrade archive metadata');
    process.exitCode = 1;
  }
}
