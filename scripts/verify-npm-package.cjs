#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  if (['--global', '--source-build', '--require-prebuilt'].includes(process.argv[i])) options[process.argv[i]] = true;
  else if (process.argv[i].startsWith('--') && process.argv[i + 1]) options[process.argv[i]] = process.argv[++i];
  else throw new Error('Unexpected verification argument');
}
for (const name of ['--tarball', '--build-summary', '--npm-cli', '--output']) assert(options[name], `Missing ${name}`);
assert(!(options['--source-build'] && options['--require-prebuilt']), 'Source and prebuilt verification modes are mutually exclusive');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const tarball = fs.realpathSync(options['--tarball']);
const summary = JSON.parse(fs.readFileSync(options['--build-summary']));
assert.equal(hash(fs.readFileSync(tarball)), summary.tarball.sha256, 'Tarball differs from trusted build summary');
const output = path.resolve(options['--output']);
const parent = fs.realpathSync(path.dirname(output));
const permitted = [os.tmpdir(), '/tmp', process.env.RUNNER_TEMP].filter(Boolean).map((folder) => fs.realpathSync(folder));
assert(permitted.some((root) => parent === root || parent.startsWith(`${root}${path.sep}`)), 'Verification output must be temporary');
assert(!fs.existsSync(output), 'Verification output must be fresh');fs.mkdirSync(output);
fs.writeFileSync(path.join(output, '.qinglong-npm-verify-owner.json'), JSON.stringify({ version: 1, id: crypto.randomUUID(), tarballSHA256: summary.tarball.sha256 }));
const env = { ...process.env, NPM_CONFIG_USERCONFIG: path.join(output, 'public.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(output, 'global.npmrc'), NPM_CONFIG_CACHE: path.join(output, 'npm-cache') };
fs.writeFileSync(env.NPM_CONFIG_USERCONFIG, 'registry=https://registry.npmjs.org/\n');fs.writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, '');
if (options['--source-build']) env.npm_config_build_from_source = 'true';
if (options['--require-prebuilt']) {
  env.npm_config_build_from_source = 'false';
  env.NPM_CONFIG_BUILD_FROM_SOURCE = 'false';
}
const npmCLI = fs.realpathSync(options['--npm-cli']);
const run = (args, name, command = process.execPath, extraEnv = {}) => {
  const result = spawnSync(command, args, { cwd: output, env: { ...env, ...extraEnv }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(output, `${name}.stdout.log`), result.stdout || '');fs.writeFileSync(path.join(output, `${name}.stderr.log`), result.stderr || '');
  assert(!result.error && result.status === 0, `${name} failed; inspect ${output}`);return result.stdout;
};
const members = run(['-tzf', tarball], 'tar-inventory', 'tar').split('\n').filter(Boolean);
assert(members.length > 0);
for (const name of members) assert(name.startsWith('package/') && !name.split('/').includes('..') && !name.endsWith('.node') && !name.split('/').some((part) => ['.npmrc', '.git', '.pnpm', '_cacache'].includes(part)), `Forbidden tarball item ${name}`);
const npmVersion = String(run([npmCLI, '--version'], 'npm-version')).trim();
const global = !!options['--global'];
const prefix = path.join(output, 'global-prefix');
if (!global) {
  const manifest = { name: 'qinglong-final-tarball-consumer', version: '1.0.0', private: true, dependencies: { '@whyour/qinglong': `file:${tarball}` } };
  if (Number(npmVersion.split('.')[0]) >= 12) manifest.allowScripts = { [`file:${tarball}`]: true };
  fs.writeFileSync(path.join(output, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
const install = [npmCLI, 'install', '--foreground-scripts', '--no-audit', '--no-fund'];
if (global) {install.push('--global', '--prefix', prefix);if (Number(npmVersion.split('.')[0]) >= 12) install.push(`--allow-scripts=file:${tarball}`);install.push(tarball);}
const installLog = run(install, 'consumer-install');
const installErrorLog = fs.readFileSync(path.join(output, 'consumer-install.stderr.log'), 'utf8');
if (options['--source-build']) {
  assert(installLog.includes('SOLINK_MODULE') || installErrorLog.includes('SOLINK_MODULE'), 'Native source compilation evidence missing');
  assert(installLog.includes('"installation":"source-built"'), 'Parent lifecycle did not report an actual source build');
}
if (options['--require-prebuilt']) {
  assert(/\[@whyour\/sqlite3\] Success: .* is installed via remote/.test(installLog), 'Successful SQLite prebuilt download evidence missing');
  assert(installLog.includes('"installation":"installer-ran"'), 'Parent lifecycle did not install the missing native binding');
  assert(!/SOLINK_MODULE|"installation":"source-built"|gyp info spawn (?:make|ninja)/.test(`${installLog}\n${installErrorLog}`), 'SQLite source fallback cannot count as prebuilt verification');
}
const packageRoot = global ? path.join(prefix, 'lib', 'node_modules', '@whyour/qinglong') : path.join(output, 'node_modules', '@whyour/qinglong');
const receipt = JSON.parse(fs.readFileSync(path.join(packageRoot, 'qinglong-npm-dependency-proof.json')));
assert.equal(receipt.sourceCommit, summary.sourceCommit);assert.equal(receipt.productionLockSHA256, summary.productionLockSHA256);
assert.equal(receipt.ciBuildInfoSHA256, summary.ciBuildInfoSHA256);
const bundled = require(path.join(__dirname, 'verify-bundled-dependencies.cjs')).verifyBundledDependencies(packageRoot);
assert.equal(bundled.verifiedPlacements, summary.shippedPackagePlacements);
for (const item of receipt.applicationFiles) assert.equal(hash(fs.readFileSync(path.join(packageRoot, item.path))), item.sha256, `Application payload changed ${item.path}`);
for (const item of receipt.shipped) {
  for (const file of item.shippedFiles || item.sourceFiles) if (file.path !== 'package.json') assert.equal(hash(fs.readFileSync(path.join(packageRoot, item.path, file.path))), file.sha256, `Bundled source changed ${item.path}/${file.path}`);
  assert.equal(hash(fs.readFileSync(path.join(packageRoot, item.path, 'package.json'))), item.publishedManifestSHA256);
}
const listArgs = [npmCLI, 'ls', '--all', '--json'];if (global) listArgs.push('--global', '--prefix', prefix);
const dependencyList = JSON.parse(run(listArgs, 'consumer-dependency-list'));assert(!dependencyList.problems?.length);
let audit = null;
if (!global) {
  audit = JSON.parse(run([npmCLI, 'audit', '--omit=dev', '--json'], 'consumer-production-audit'));
  assert.equal(audit.metadata.vulnerabilities.total, 0);
}
const protocols = run([path.join(packageRoot, 'scripts', 'verify-production-dependencies.cjs')], 'consumer-production-protocols');
for (const name of ['verifyDatabase', 'verifyGrpc', 'verifyWebsocket', 'verifyMailAndJwt']) assert(protocols.includes(`${name}: passed`));
const requirePackage = createRequire(path.join(packageRoot, 'package.json'));
run([path.join(packageRoot, 'cli', 'dist', 'ql.js'), '--help'], 'internal-cli-help');
assert(fs.existsSync(path.join(packageRoot, 'cli', 'dist', 'internal', 'maintenance', 'upgradeArtifacts.cjs')));
requirePackage('./cli/src/internal/maintenance/upgradeArtifacts.cjs');
// Repeated ql check / upgrade must verify the archive without re-resolving it.
const recheck = run([path.join(packageRoot, 'scripts', 'install-panel-dependencies.cjs'), '--root', packageRoot], 'panel-bundled-recheck', process.execPath, { npm_config_build_from_source: 'false', NPM_CONFIG_BUILD_FROM_SOURCE: 'false' });
assert(recheck.includes('"resolverInstallSkipped":true') && recheck.includes('"installation":"existing-binding"'));
const { Keyv } = requirePackage('keyv'); const { default: KeyvSqlite } = requirePackage('@keyv/sqlite');
assert.equal(createRequire(requirePackage.resolve('@keyv/sqlite')).resolve('sqlite3/package.json'), requirePackage.resolve('sqlite3/package.json'));
(async () => {
  const store = new KeyvSqlite('sqlite://:memory:');const keyv = new Keyv({ store, namespace: 'npm-consumer' });
  keyv.on('error', (error) => { throw error; });
  await keyv.set('record', { value: 7 });assert.deepEqual(await keyv.get('record'), { value: 7 });
  const rows = await store.query('SELECT key, value FROM keyv WHERE key = ?', 'npm-consumer:record');assert.equal(rows.length, 1);
  await keyv.set('expires', 'short-lived', 30);await new Promise((resolve) => setTimeout(resolve, 60));assert.equal(await keyv.get('expires'), undefined);
  assert.equal(await keyv.delete('record'), true);await keyv.set('clear', true);await keyv.clear();assert.equal(await keyv.get('clear'), undefined);await keyv.disconnect();
  const sqliteDirectory = path.dirname(requirePackage.resolve('sqlite3/package.json'));
  const binding = Object.keys(require.cache).find((file) => file.endsWith('.node') && file.startsWith(`${sqliteDirectory}${path.sep}`));assert(binding);
  const report = { version: 1, sourceCommit: receipt.sourceCommit, productionLockSHA256: receipt.productionLockSHA256, tarballSHA256: summary.tarball.sha256, node: process.version, platform: process.platform, arch: process.arch, npm: npmVersion, global, nativeSourceBuildRequested: !!options['--source-build'], nativeSourceBuildVerified: !!options['--source-build'], nativePrebuiltRequested: !!options['--require-prebuilt'], nativePrebuiltVerified: !!options['--require-prebuilt'], nativeBinding: { path: path.relative(packageRoot, binding), sha256: hash(fs.readFileSync(binding)), header: fs.readFileSync(binding).subarray(0, 16).toString('hex') }, shippedPackagePlacements: receipt.shippedPackagePlacements, bundledSourceHashesVerified: true, applicationHashesVerified: true, fullCliHelpPassed: true, rawUpgradeHelperLoaded: true, dependencyProblems: [], productionAudit: audit?.metadata || null, productionProtocolsPassed: 4, keyvActualSqlitePassed: true };
  fs.writeFileSync(path.join(output, 'npm-consumer-validation.json'), `${JSON.stringify(report, null, 2)}\n`);console.log(JSON.stringify(report));
})().catch((error) => { console.error(error);process.exitCode = 1; });
