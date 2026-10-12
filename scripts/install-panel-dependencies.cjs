#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { verifyBundledDependencies } = require('./verify-bundled-dependencies.cjs');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert(['--root', '--pnpm-cli', '--static-dir', '--source-commit'].includes(process.argv[i]) && process.argv[i + 1], 'Expected a supported option with a value');
  options[process.argv[i]] = process.argv[i + 1];
}
const root = fs.realpathSync(options['--root'] || path.join(__dirname, '..'));
let runEnvironment = { ...process.env };
const run = (command, args, capture = false) => {
  const result = spawnSync(command, args, { cwd: root, env: runEnvironment, stdio: capture ? 'pipe' : 'inherit', encoding: capture ? 'utf8' : undefined });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Panel dependency command failed: ${command}`);
  return capture ? result.stdout.trim() : undefined;
};
if (fs.existsSync(path.join(root, 'qinglong-npm-dependency-proof.json'))) {
  const verified = verifyBundledDependencies(root);
  run(process.execPath, [path.join(root, 'scripts', 'install-bundled-sqlite.cjs')]);
  verifyBundledDependencies(root);
  console.log(JSON.stringify({ mode: 'bundled', resolverInstallSkipped: true, verifiedPlacements: verified.verifiedPlacements, verifiedEdges: verified.verifiedEdges }));
} else {
  const lock = path.join(root, 'pnpm-lock.yaml');
  assert(fs.existsSync(lock), 'Panel source has no frozen pnpm lock; refusing an npm re-resolution');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert(pkg.engines?.node, 'Panel source must declare its supported Node engine');
  assert.equal(pkg.packageManager?.split('+')[0], 'pnpm@10.34.6', 'Panel source requires pinned pnpm@10.34.6; install its reviewed runtime archive');
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = hash(lock);
  let cli = options['--pnpm-cli'] || process.env.QINGLONG_PNPM_CLI;
  let command = cli ? process.execPath : 'pnpm';
  let prefix = cli ? [fs.realpathSync(cli)] : [];
  const version = spawnSync(command, [...prefix, '--config.manage-package-manager-versions=false', '--version'], { cwd: root, env: process.env, encoding: 'utf8' });
  let temporary;
  let owner;
  let runtimeArchive = null;
  try {
    if (version.error || version.status !== 0 || version.stdout.trim() !== '10.34.6') {
      const candidates = [options['--static-dir'], path.join(root, 'static'), path.basename(root) === 'source' ? path.join(path.dirname(root), 'static') : null].filter(Boolean);
      const selected = candidates.find((directory) => ['build-info.json', 'runtime-tools.tgz', 'runtime-tools-proof.json'].every((name) => fs.existsSync(path.join(directory, name))));
      assert(selected, 'Active pnpm is not 10.34.6 and no controlled runtime artifact exists; refusing an unfrozen npm fallback');
      const staticRoot = fs.realpathSync(selected);
      const build = JSON.parse(fs.readFileSync(path.join(staticRoot, 'build-info.json')));
      const proof = JSON.parse(fs.readFileSync(path.join(staticRoot, 'runtime-tools-proof.json')));
      assert.equal(build.dirty, false); assert.match(build.sourceCommit, /^[a-f0-9]{40}$/);
      assert.equal(build.sourceCommit, proof.sourceCommit, 'Source/static runtime commits differ');
      assert.equal(build.lockfileSha256, before, 'Source and static frozen lock hashes differ');
      let sourceCommit = options['--source-commit'];
      if (fs.existsSync(path.join(root, '.git'))) {
        const head = run('git', ['rev-parse', 'HEAD'], true);
        if (sourceCommit) assert.equal(sourceCommit, head, 'Explicit source commit differs from Git HEAD');
        sourceCommit = head;
      }
      assert(sourceCommit, 'Archive source requires --source-commit from the verified upgrade download');
      assert.equal(build.sourceCommit, sourceCommit, 'Runtime artifact is not from the verified source commit');
      for (const name of ['runtime-tools.tgz', 'runtime-tools-proof.json']) assert.equal(hash(path.join(staticRoot, name)), build.files[name], `Static runtime tool hash differs: ${name}`);
      for (const input of proof.inputs) {
        assert(input.path && !path.isAbsolute(input.path) && !input.path.split(/[\\/]/).includes('..'), 'Unsafe runtime input path');
        const file = path.join(root, input.path);
        assert(fs.realpathSync(file).startsWith(`${root}${path.sep}`), 'Runtime source input escapes source root');
        assert.equal(hash(file), input.sha256, `Runtime tool input differs from verified source: ${input.path}`);
      }
      const installer = path.join(__dirname, 'install-runtime-tools.cjs');
      const installerInput = proof.inputs.find((input) => input.path === 'scripts/install-runtime-tools.cjs');
      assert(installerInput && hash(installer) === installerInput.sha256, 'Use the installed, reviewed runtime archive verifier');
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qinglong-source-tools-'));
      owner = Buffer.from(JSON.stringify({ id: crypto.randomUUID(), sourceCommit }));
      fs.writeFileSync(path.join(temporary, '.qinglong-source-tools-owner.json'), owner);
      const toolPrefix = path.join(temporary, 'prefix');
      runEnvironment = { ...runEnvironment, NPM_CONFIG_USERCONFIG: path.join(temporary, 'public.npmrc'), npm_config_userconfig: path.join(temporary, 'public.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(temporary, 'global.npmrc'), npm_config_globalconfig: path.join(temporary, 'global.npmrc'), NPM_CONFIG_CACHE: path.join(temporary, 'npm-cache'), npm_config_cache: path.join(temporary, 'npm-cache'), PNPM_HOME: path.join(temporary, 'pnpm-home'), XDG_CACHE_HOME: path.join(temporary, 'xdg-cache'), XDG_STATE_HOME: path.join(temporary, 'xdg-state'), XDG_DATA_HOME: path.join(temporary, 'xdg-data') };
      fs.writeFileSync(runEnvironment.NPM_CONFIG_USERCONFIG, 'registry=https://registry.npmjs.org/\n'); fs.writeFileSync(runEnvironment.NPM_CONFIG_GLOBALCONFIG, '');
      run(process.execPath, [installer, '--archive', path.join(staticRoot, 'runtime-tools.tgz'), '--proof', path.join(staticRoot, 'runtime-tools-proof.json'), '--prefix', toolPrefix]);
      const gyp = path.join(toolPrefix, 'lib', 'node_modules', 'qinglong-runtime-tools', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
      runEnvironment = { ...runEnvironment, PATH: [path.join(toolPrefix, 'bin'), path.dirname(process.execPath), runEnvironment.PATH || ''].join(path.delimiter), npm_config_node_gyp: gyp, NPM_CONFIG_NODE_GYP: gyp };
      cli = path.join(toolPrefix, 'lib', 'node_modules', 'qinglong-runtime-tools', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
      command = process.execPath; prefix = [cli];
      assert.equal(run(command, [...prefix, '--config.manage-package-manager-versions=false', '--version'], true), '10.34.6');
      runtimeArchive = { sourceCommit, sha256: proof.archive.sha256, prefixScope: 'fresh temporary only' };
    }
    const install = [...prefix, '--config.manage-package-manager-versions=false', '--config.engine-strict=true', 'install', '--prod', '--frozen-lockfile'];
    if (temporary) install.push('--store-dir', path.join(temporary, 'pnpm-store'));
    run(command, install);
    assert.equal(hash(lock), before, 'Frozen production installation changed the lock');
    console.log(JSON.stringify({ mode: 'source', frozen: true, productionLockSHA256: before, pnpm: '10.34.6', runtimeArchive }));
  } finally {
    if (temporary) { assert(fs.readFileSync(path.join(temporary, '.qinglong-source-tools-owner.json')).equals(owner), 'Temporary runtime prefix ownership changed'); fs.rmSync(temporary, { recursive: true }); }
  }
}
