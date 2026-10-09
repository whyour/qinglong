#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

const options = {};
const allowedOptions = new Set(['--repo', '--source-ref', '--artifact-dir', '--pnpm-cli', '--npm-cli', '--output', '--metadata-dir', '--allow-metadata-preview']);
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  assert(allowedOptions.has(key), `Unknown option ${key}`);
  if (key === '--allow-metadata-preview') options[key] = true;
  else if (key.startsWith('--') && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) options[key] = process.argv[++i];
  else throw new Error(`Unexpected argument ${key}`);
}
const required = ['--repo', '--source-ref', '--artifact-dir', '--pnpm-cli', '--npm-cli', '--output'];
for (const key of required) assert(options[key], `Missing ${key}`);
assert.match(options['--source-ref'], /^[a-f0-9]{40}$/);
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const exporterSHA256 = sha(fs.readFileSync(__filename));
const installerSHA256 = sha(fs.readFileSync(path.join(__dirname, 'install-bundled-sqlite.cjs')));
const verifierSHA256 = sha(fs.readFileSync(path.join(__dirname, 'verify-npm-package.cjs')));
const helperNames = ['build-npm-package.cjs', 'install-bundled-sqlite.cjs', 'verify-npm-package.cjs', 'verify-bundled-dependencies.cjs', 'install-panel-dependencies.cjs'];
const helperHashes = Object.fromEntries(helperNames.map((name) => [name, sha(fs.readFileSync(path.join(__dirname, name)))]));
const output = path.resolve(options['--output']);
const parent = fs.realpathSync(path.dirname(output));
const temporary = [os.tmpdir(), '/tmp', process.env.RUNNER_TEMP].filter(Boolean).map((folder) => fs.realpathSync(folder));
assert(temporary.some((root) => parent === root || parent.startsWith(`${root}${path.sep}`)), 'Output must be inside the temporary directory');
assert(!fs.existsSync(output), 'Output must not already exist');
fs.mkdirSync(output);
fs.writeFileSync(path.join(output, '.qinglong-npm-build-owner.json'), JSON.stringify({ version: 1, id: crypto.randomUUID(), sourceRef: options['--source-ref'] }));
const logs = path.join(output, 'logs');
fs.mkdirSync(logs);
const env = {
  ...process.env,
  NPM_CONFIG_USERCONFIG: path.join(output, 'public.npmrc'),
  NPM_CONFIG_GLOBALCONFIG: path.join(output, 'global.npmrc'),
  NPM_CONFIG_CACHE: path.join(output, 'npm-cache'),
  PNPM_HOME: path.join(output, 'pnpm-home'),
  XDG_DATA_HOME: path.join(output, 'xdg-data'),
  XDG_CACHE_HOME: path.join(output, 'xdg-cache'),
  XDG_STATE_HOME: path.join(output, 'xdg-state'),
};
fs.writeFileSync(env.NPM_CONFIG_USERCONFIG, 'registry=https://registry.npmjs.org/\n');
fs.writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, '');
const run = (command, args, name, cwd = output, input) => {
  const result = spawnSync(command, args, { cwd, env, input, encoding: input ? undefined : 'utf8', maxBuffer: 128 * 1024 * 1024 });
  fs.writeFileSync(path.join(logs, `${name}.log`), Buffer.concat([Buffer.from(result.stdout || ''), Buffer.from(result.stderr || '')]));
  assert(!result.error && result.status === 0, `${name} failed; inspect ${path.join(logs, `${name}.log`)}`);
  return result.stdout;
};
const sourceRef = String(run('git', ['-C', path.resolve(options['--repo']), 'rev-parse', `${options['--source-ref']}^{commit}`], 'source-ref')).trim();
assert.equal(sourceRef, options['--source-ref']);
const treeText = String(run('git', ['-C', path.resolve(options['--repo']), 'ls-tree', '-r', '-z', sourceRef], 'source-tree'));
const sourceFiles = [];
for (const record of treeText.split('\0').filter(Boolean)) {
  const [header, relative] = record.split('\t');
  const [mode, type, object] = header.split(' ');
  assert(type === 'blob' && ['100644', '100755'].includes(mode), `Unsupported tracked item ${relative}`);
  assert(relative && !path.isAbsolute(relative) && !relative.split('/').includes('..'));
  sourceFiles.push({ path: relative, mode, gitBlob: object });
}
const checkout = path.join(output, 'source');
fs.mkdirSync(checkout);
const archive = spawnSync('git', ['-C', path.resolve(options['--repo']), 'archive', '--format=tar', sourceRef], { maxBuffer: 128 * 1024 * 1024 });
assert(!archive.error && archive.status === 0);
run('tar', ['-xf', '-', '-C', checkout], 'source-archive-extract', output, archive.stdout);
for (const item of sourceFiles) {
  const bytes = fs.readFileSync(path.join(checkout, item.path));
  const blob = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
  assert.equal(blob, item.gitBlob, `Source blob changed ${item.path}`);
}
const originalPackage = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json')));
const helperProvenance = [];
for (const name of helperNames) {
  const actual = fs.readFileSync(path.join(__dirname, name));
  const tracked = path.join(checkout, 'scripts', name);
  const sameAsGit = fs.existsSync(tracked) && fs.readFileSync(tracked).equals(actual);
  assert(sameAsGit || options['--allow-metadata-preview'], `Helper differs from Git source: ${name}`);
  helperProvenance.push({ path: `scripts/${name}`, gitSourceSHA256: fs.existsSync(tracked) ? sha(fs.readFileSync(tracked)) : null, archiveHelperSHA256: sha(actual), matchesGitSource: sameAsGit });
}
const metadata = options['--metadata-dir'] ? fs.realpathSync(options['--metadata-dir']) : checkout;
const production = path.join(output, 'production');
fs.mkdirSync(production);
const metadataChanges = [];
for (const name of ['package.json', 'pnpm-lock.yaml', '.npmrc']) {
  const baseFile = path.join(checkout, name);
  const inputFile = path.join(metadata, name);
  const next = fs.readFileSync(inputFile);
  const before = fs.existsSync(baseFile) ? fs.readFileSync(baseFile) : null;
  if (!before || !before.equals(next)) {
    assert(options['--allow-metadata-preview'], `Metadata differs from Git source: ${name}`);
    metadataChanges.push({ path: name, gitSourceSHA256: before ? sha(before) : null, previewSHA256: sha(next) });
  }
  fs.writeFileSync(path.join(production, name), next);
}
const packageInput = JSON.parse(fs.readFileSync(path.join(production, 'package.json')));
assert.equal(packageInput.name, '@whyour/qinglong');
assert.equal(packageInput.name, originalPackage.name);
assert.equal(packageInput.version, originalPackage.version);
assert(!packageInput.dependencies['@ant-design/plots'], 'Frontend plots must be development-only');
assert(!packageInput.overrides, 'Use the single pnpm override source');
assert.deepEqual(packageInput.pnpm.overrides, originalPackage.pnpm.overrides, 'Preview must retain the reviewed source override map');
for (const line of fs.readFileSync(path.join(production, '.npmrc'), 'utf8').split(/\r?\n/).filter(Boolean)) {
  assert(/^(strict-peer-dependencies|strict-dep-builds)=(true|false)$/.test(line), 'Unexpected project npm configuration');
}
const artifact = fs.realpathSync(options['--artifact-dir']);
const buildInfoBytes = fs.readFileSync(path.join(artifact, 'build-info.json'));
const buildInfo = JSON.parse(buildInfoBytes);
assert.equal(buildInfo.sourceCommit, sourceRef);
assert.equal(buildInfo.dirty, false);
assert.equal(buildInfo.lockfileSha256, sha(fs.readFileSync(path.join(checkout, 'pnpm-lock.yaml'))));
assert(buildInfo.files && Object.keys(buildInfo.files).length > 0);
const walkFiles = (folder, relative = '') => {
  const result = [];
  for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
    const next = path.join(relative, item.name);
    assert(!item.isSymbolicLink(), `Unexpected symlink ${next}`);
    if (item.isDirectory()) result.push(...walkFiles(path.join(folder, item.name), next));
    else { assert(item.isFile()); result.push(next.split(path.sep).join('/')); }
  }
  return result;
};
const actualArtifactFiles = walkFiles(artifact).filter((name) => name !== 'build-info.json').sort();
assert.deepEqual(actualArtifactFiles, Object.keys(buildInfo.files).sort(), 'Static artifact inventory mismatch');
for (const [relative, expected] of Object.entries(buildInfo.files)) {
  assert(relative && !path.isAbsolute(relative) && !relative.split('/').includes('..'));
  assert.equal(sha(fs.readFileSync(path.join(artifact, relative))), expected, `Static artifact hash mismatch ${relative}`);
}
const pnpmCLI = fs.realpathSync(options['--pnpm-cli']);
const npmCLI = fs.realpathSync(options['--npm-cli']);
const pnpmVersion = String(run(process.execPath, [pnpmCLI, '--config.manage-package-manager-versions=false', '--version'], 'pnpm-version', production)).trim();
assert(packageInput.packageManager && packageInput.packageManager.split('+')[0] === `pnpm@${pnpmVersion}`, 'pnpm version must match packageManager');
const npmVersion = String(run(process.execPath, [npmCLI, '--version'], 'npm-version', production)).trim();
assert(Number(npmVersion.split('.')[0]) >= 12, 'Use npm 12+ to retain publication guard checks');
const lockSHA256 = sha(fs.readFileSync(path.join(production, 'pnpm-lock.yaml')));
run(process.execPath, [pnpmCLI, '--config.manage-package-manager-versions=false', 'install', '--prod', '--frozen-lockfile', '--ignore-scripts', '--store-dir', path.join(output, 'pnpm-store')], 'frozen-production-install', production);
assert.equal(sha(fs.readFileSync(path.join(production, 'pnpm-lock.yaml'))), lockSHA256, 'Frozen lock was changed');
const requireProduction = createRequire(path.join(production, 'package.json'));
const yaml = requireProduction('js-yaml');
const preGypRequire = createRequire(requireProduction.resolve('sqlite3/package.json'));
const semver = preGypRequire('semver');
assert(packageInput.engines?.node && semver.satisfies(process.version, packageInput.engines.node), 'Build Node must satisfy the source package engine');
const lock = yaml.load(fs.readFileSync(path.join(production, 'pnpm-lock.yaml'), 'utf8'));
assert.equal(Number(lock.lockfileVersion), 9);
// Build the full internal CLI from the same verified source. Its tracked npm
// lock is an existing compiler lock, not a second production dependency lock.
const cliRoot = path.join(checkout, 'cli');
run(process.execPath, [npmCLI, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], 'cli-frozen-compiler-install', cliRoot);
run(process.execPath, [path.join(cliRoot, 'scripts', 'build.cjs')], 'cli-full-build', checkout);
const cliBuildFiles = walkFiles(path.join(cliRoot, 'dist'));
assert(cliBuildFiles.includes('internal/maintenance/upgradeArtifacts.cjs'), 'Dynamic internal CLI CJS artifact missing');
const within = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);
const resolveInstalled = (from, name, placements) => {
  for (let folder = from; within(placements ? stage : production, folder); folder = path.dirname(folder)) {
    const file = path.join(folder, 'node_modules', name, 'package.json');
    if (placements ? placements.has(path.dirname(file)) : fs.existsSync(file)) return path.dirname(file);
    if (folder === (placements ? stage : production)) break;
  }
  return null;
};
const fileInventory = (folder) => {
  const entries = [];
  const visit = (current, relative = '') => {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === 'node_modules') continue;
      const next = path.join(relative, item.name);
      assert(!['.npmrc', '.git', '.pnpm', '_cacache'].includes(item.name), `Unexpected package payload ${next}`);
      const target = fs.realpathSync(path.join(current, item.name));
      assert(within(folder, target), `Package symlink escapes source ${next}`);
      const stat = fs.statSync(target);
      if (stat.isDirectory()) visit(target, next);
      else {
        assert(stat.isFile() && !next.endsWith('.node'), `Native or unsupported payload ${next}`);
        entries.push({ path: next.split(path.sep).join('/'), sha256: sha(fs.readFileSync(target)), mode: stat.mode & 0o777 });
      }
    }
  };
  visit(folder);
  return entries;
};
const nodes = new Map();
const pending = [];
const discover = (folder) => {
  const real = fs.realpathSync(folder);
  assert(within(path.join(production, 'node_modules'), real), 'Dependency escapes owned production tree');
  if (!nodes.has(real)) {
    const manifestBytes = fs.readFileSync(path.join(real, 'package.json'));
    const pkg = JSON.parse(manifestBytes);
    const resolution = lock.packages[`${pkg.name}@${pkg.version}`]?.resolution;
    assert(resolution && resolution.integrity, `Missing frozen registry integrity: ${pkg.name}@${pkg.version}`);
    const inventory = fileInventory(real);
    const node = { key: real, pkg, manifestBytes, inventory, resolution, edges: [], class: 0 };
    node.base = `${pkg.name}@${pkg.version}:${sha(JSON.stringify(inventory))}`;
    nodes.set(real, node); pending.push(node);
  }
  return nodes.get(real);
};
const direct = [];
for (const [name] of Object.entries(packageInput.dependencies)) {
  const folder = resolveInstalled(production, name);
  assert(folder, `Missing production dependency ${name}`);
  direct.push({ name, target: discover(folder) });
}
while (pending.length) {
  const node = pending.shift();
  for (const category of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(node.pkg[category] || {})) {
      const folder = resolveInstalled(node.key, name);
      if (!folder) {
        const optional = category === 'optionalDependencies' || (category === 'peerDependencies' && node.pkg.peerDependenciesMeta?.[name]?.optional);
        assert(optional, `Missing required ${category}: ${node.pkg.name} -> ${name}`);
        continue;
      }
      node.edges.push({ category, name, spec, target: discover(folder) });
    }
  }
}
// Partition equivalent package contexts, including their dependency and peer graphs.
let groups = new Map();
for (const node of nodes.values()) {
  if (!groups.has(node.base)) groups.set(node.base, groups.size);
  node.class = groups.get(node.base);
}
for (let round = 0; round <= nodes.size; round++) {
  const next = new Map(); const assigned = new Map();
  for (const node of nodes.values()) {
    const identity = JSON.stringify([node.base, node.edges.map((edge) => [edge.category, edge.name, edge.target.class])]);
    if (!next.has(identity)) next.set(identity, next.size);
    assigned.set(node, next.get(identity));
  }
  const stable = [...nodes.values()].every((node) => node.class === assigned.get(node));
  for (const node of nodes.values()) node.class = assigned.get(node);
  if (stable) break;
  assert(round < nodes.size, 'Package context partition did not converge');
}
const classes = new Map();
for (const node of nodes.values()) if (!classes.has(node.class)) classes.set(node.class, node);
const stage = path.join(output, 'package');
fs.mkdirSync(stage);
const stageFiles = [];
const copyFile = (from, relative, expected) => {
  const bytes = fs.readFileSync(from);
  if (expected) assert.equal(sha(bytes), expected);
  const to = path.join(stage, relative); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, bytes); fs.chmodSync(to, fs.statSync(from).mode & 0o777);
  stageFiles.push({ path: relative.split(path.sep).join('/'), sha256: sha(bytes) });
};
for (const item of sourceFiles) {
  const relative = item.path;
  if (['.env.example', 'LICENSE', 'README.md', 'README-en.md', 'SECURITY.md', 'ecosystem.config.js', 'version.yaml'].includes(relative) || relative.startsWith('shell/') || relative.startsWith('sample/') || (relative.startsWith('back/protos/') && relative.endsWith('.proto')) || ['scripts/verify-production-dependencies.cjs', 'scripts/install-runtime-tools.cjs'].includes(relative)) copyFile(path.join(checkout, relative), relative);
}
for (const [relative, expected] of Object.entries(buildInfo.files)) {
  copyFile(path.join(artifact, relative), path.join('static', relative), expected);
}
copyFile(path.join(artifact, 'build-info.json'), 'static/build-info.json', sha(buildInfoBytes));
for (const name of helperNames.filter((name) => name !== 'build-npm-package.cjs')) copyFile(path.join(__dirname, name), path.join('scripts', name));
for (const relative of cliBuildFiles) if (!relative.endsWith('.js.map')) copyFile(path.join(cliRoot, 'dist', relative), path.join('cli', 'dist', relative));
for (const relative of ['package.json', 'LOCAL.md', 'LOCAL.en.md', 'README.md', 'README.en.md', 'src/internal/maintenance/upgradeArtifacts.cjs']) copyFile(path.join(cliRoot, relative), path.join('cli', relative));
const rootPackage = structuredClone(packageInput);
if (fs.existsSync(path.join(checkout, 'scripts', 'install-runtime-tools.cjs'))) assert(['runtime-tools.tgz', 'runtime-tools-proof.json'].every((name) => Object.hasOwn(buildInfo.files, name)), 'Runtime tools must be covered by the same CI static manifest');
let runtimeTools = null;
if (Object.hasOwn(buildInfo.files, 'runtime-tools-proof.json')) {
  const toolProof = JSON.parse(fs.readFileSync(path.join(artifact, 'runtime-tools-proof.json')));
  const toolArchive = fs.readFileSync(path.join(artifact, 'runtime-tools.tgz'));
  assert.equal(toolProof.sourceCommit, sourceRef, 'Runtime tools came from another source commit');
  assert.equal(toolProof.archive.sha256, sha(toolArchive), 'Runtime tools archive differs from its proof');
  for (const input of toolProof.inputs) assert.equal(sha(fs.readFileSync(path.join(checkout, input.path))), input.sha256, `Runtime tools source input differs from Git: ${input.path}`);
  const toolFiles = new Map(toolProof.files.map((item) => [item.path, item]));
  assert.equal(sha(fs.readFileSync(pnpmCLI)), toolFiles.get('tools/node_modules/pnpm/bin/pnpm.cjs')?.sha256, 'Producer pnpm CLI differs from the reviewed runtime artifact');
  assert.equal(sha(fs.readFileSync(npmCLI)), toolFiles.get('npm/bin/npm-cli.js')?.sha256, 'Producer npm CLI differs from the reviewed runtime artifact');
  runtimeTools = { proofSHA256: sha(fs.readFileSync(path.join(artifact, 'runtime-tools-proof.json'))), archiveSHA256: sha(toolArchive), sourceCommit: toolProof.sourceCommit, builder: toolProof.builder, components: toolProof.components, residualAdvisories: toolProof.residualAdvisories };
}
delete rootPackage.pnpm; delete rootPackage.packageManager; delete rootPackage.devDependencies;
const rootMetadataTransforms = [];
for (const edge of direct) {
  const target = edge.target.pkg;
  const exact = target.name === edge.name ? target.version : `npm:${target.name}@${target.version}`;
  if (rootPackage.dependencies[edge.name] !== exact) rootMetadataTransforms.push({ category: 'dependencies', dependency: edge.name, from: rootPackage.dependencies[edge.name], to: exact, source: 'frozen direct pnpm resolution' });
  rootPackage.dependencies[edge.name] = exact;
}
rootPackage.bundleDependencies = Object.keys(rootPackage.dependencies);
rootPackage.scripts.install = 'node scripts/install-bundled-sqlite.cjs';
fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(rootPackage, null, 2)}\n`);
const rootMap = new Map();
for (const edge of direct) rootMap.set(edge.name, edge.target.class);
for (const node of nodes.values()) for (const edge of node.edges) if (!rootMap.has(edge.name)) rootMap.set(edge.name, edge.target.class);
const placements = new Map(); const placementQueue = []; const transforms = []; const shipped = [];
const permittedOverride = (edge) => {
  for (const [key, replacement] of Object.entries(packageInput.pnpm.overrides)) {
    const index = key.lastIndexOf('@'); const hasSelector = index > 0;
    const name = hasSelector ? key.slice(0, index) : key;
    const selector = hasSelector ? key.slice(index + 1) : null;
    if (name !== edge.name) continue;
    if (selector && (!semver.validRange(edge.spec) || !semver.intersects(edge.spec, selector))) continue;
    const target = edge.target.pkg;
    const expected = target.name === edge.name ? target.version : `npm:${target.name}@${target.version}`;
    if (replacement === expected) return { key, replacement };
  }
  return null;
};
const matches = (name, spec, target) => {
  if (spec.startsWith('npm:')) return spec === `npm:${target.name}@${target.version}`;
  return name === target.name && !!semver.validRange(spec) && semver.satisfies(target.version, spec);
};
const place = (folder, classID) => {
  assert(!placements.has(folder));
  const node = classes.get(classID); placements.set(folder, node); placementQueue.push(folder);
  fs.mkdirSync(folder, { recursive: true });
  for (const item of node.inventory) {
    const from = path.join(node.key, item.path); const to = path.join(folder, item.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });fs.copyFileSync(from, to);fs.chmodSync(to, item.mode);
    assert.equal(sha(fs.readFileSync(to)), item.sha256);
  }
  const pkg = structuredClone(node.pkg); const edits = [];
  for (const edge of node.edges) if (!matches(edge.name, edge.spec, edge.target.pkg)) {
    const override = permittedOverride(edge);
    assert(override, `Unverified dependency mismatch ${pkg.name}@${pkg.version} ${edge.name}: ${edge.spec} -> ${edge.target.pkg.name}@${edge.target.pkg.version}`);
    const next = edge.target.pkg.name === edge.name ? edge.target.pkg.version : `npm:${edge.target.pkg.name}@${edge.target.pkg.version}`;
    pkg[edge.category][edge.name] = next;edits.push({ category: edge.category, dependency: edge.name, from: edge.spec, to: next, pnpmOverride: override });
  }
  const manifestPath = path.join(folder, 'package.json');
  if (edits.length) {
    const after = `${JSON.stringify(pkg, null, 2)}\n`;fs.writeFileSync(manifestPath, after);
    transforms.push({ path: path.relative(stage, manifestPath), package: pkg.name, version: pkg.version, beforeSHA256: sha(node.manifestBytes), afterSHA256: sha(after), edits });
  }
  shipped.push({ path: path.relative(stage, folder), package: pkg.name, version: pkg.version, context: classID, sourcePath: path.relative(production, node.key), registryIntegrity: node.resolution.integrity, sourceFiles: node.inventory, publishedManifestSHA256: sha(fs.readFileSync(manifestPath)) });
};
for (const [name, classID] of rootMap) place(path.join(stage, 'node_modules', name), classID);
while (placementQueue.length) {
  const folder = placementQueue.shift(); const node = placements.get(folder);
  for (const edge of node.edges) {
    const found = resolveInstalled(folder, edge.name, placements);
    if (!found || placements.get(found).class !== edge.target.class) place(path.join(folder, 'node_modules', edge.name), edge.target.class);
  }
}
for (const [folder, node] of placements) for (const edge of node.edges) {
  const resolved = resolveInstalled(folder, edge.name, placements);
  assert(resolved && placements.get(resolved).class === edge.target.class, 'Exported dependency resolution differs from frozen source');
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json')));
  assert(matches(edge.name, pkg[edge.category][edge.name], edge.target.pkg), 'Exported manifest dependency remains invalid');
}
for (const item of shipped) {
  const folder = path.join(stage, item.path);
  const node = placements.get(folder);
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json')));
  item.edges = node.edges.map((edge) => ({ category: edge.category, name: edge.name, publishedSpec: pkg[edge.category][edge.name], context: edge.target.class, resolvedPath: path.relative(stage, resolveInstalled(folder, edge.name, placements)) }));
}
const receipt = {
  version: 1, package: rootPackage.name, packageVersion: rootPackage.version, sourceCommit: sourceRef,
  sourceArchiveSHA256: sha(archive.stdout), sourceFiles, sourceMetadataChanges: metadataChanges,
  previewMetadata: !!metadataChanges.length || helperProvenance.some((item) => !item.matchesGitSource), helperProvenance, productionManifestSHA256: sha(fs.readFileSync(path.join(production, 'package.json'))), productionLockSHA256: lockSHA256,
  ciBuildInfoSHA256: sha(buildInfoBytes), ciStaticSourceCommit: buildInfo.sourceCommit, ciStaticFilesVerified: actualArtifactFiles.length,
  fullInternalCli: { sourceCommit: sourceRef, compilerLockSHA256: sha(fs.readFileSync(path.join(cliRoot, 'package-lock.json'))), fullBuiltFiles: cliBuildFiles.length },
  tools: { node: process.version, pnpm: pnpmVersion, npm: npmVersion, pnpmCliSHA256: sha(fs.readFileSync(pnpmCLI)), npmCliSHA256: sha(fs.readFileSync(npmCLI)) }, runtimeTools,
  exporterSHA256, nativeInstallerSHA256: installerSHA256, verifierSHA256, helperHashes,
  publishedRootManifestSHA256: sha(fs.readFileSync(path.join(stage, 'package.json'))), rootMetadataTransforms,
  directDependencies: direct.map((edge) => ({ name: edge.name, publishedSpec: rootPackage.dependencies[edge.name], context: edge.target.class, resolvedPath: path.relative(stage, resolveInstalled(stage, edge.name, placements)) })),
  runtimeToolsIncluded: ['static/runtime-tools.tgz', 'static/runtime-tools-proof.json', 'scripts/install-runtime-tools.cjs'].every((name) => stageFiles.some((file) => file.path === name)),
  packageContexts: classes.size, shippedPackagePlacements: shipped.length, originalRegistryTreeUnmodified: !transforms.length,
  transforms, shipped, applicationFiles: stageFiles,
};
fs.writeFileSync(path.join(stage, 'qinglong-npm-dependency-proof.json'), `${JSON.stringify(receipt, null, 2)}\n`);
const artifacts = path.join(output, 'artifacts');fs.mkdirSync(artifacts);
const unpackJSON = (text) => {
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : Object.values(value);
};
// npm 12 sanitizes UUID-looking filenames in JSON (for example dotenv's .tap
// processinfo). The tar itself is authoritative, never the display-only list.
const planDirectory = path.join(output, 'plan-artifact');fs.mkdirSync(planDirectory);
const planned = unpackJSON(String(run(process.execPath, [npmCLI, 'pack', '--ignore-scripts', '--json', '--pack-destination', planDirectory], 'npm-pack-plan', stage)));
assert.equal(planned.length, 1);
const archivePaths = (file, label) => String(run('tar', ['-tzf', file], label)).split('\n').filter(Boolean).map((name) => {
  assert(name.startsWith('package/') && !name.split('/').includes('..'), 'Unsafe archive path');
  return name.slice('package/'.length);
});
const plannedPaths = new Set(archivePaths(path.join(planDirectory, planned[0].filename), 'npm-plan-tar-inventory'));
for (const item of shipped) {
  item.shippedFiles = item.sourceFiles.filter((file) => plannedPaths.has(`${item.path}/${file.path}`));
  item.omittedByNpmPack = item.sourceFiles.filter((file) => !plannedPaths.has(`${item.path}/${file.path}`));
  assert(plannedPaths.has(`${item.path}/package.json`), `Bundled manifest missing ${item.path}`);
}
for (const item of stageFiles) assert(plannedPaths.has(item.path), `Application file omitted by npm pack: ${item.path}`);
receipt.publishedFilePaths = [...plannedPaths].sort();
fs.writeFileSync(path.join(stage, 'qinglong-npm-dependency-proof.json'), `${JSON.stringify(receipt, null, 2)}\n`);
const packText = String(run(process.execPath, [npmCLI, 'pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], 'npm-pack', stage));
const packed = unpackJSON(packText);
assert.equal(packed.length, 1);
assert.equal(packed[0].name, rootPackage.name);assert.equal(packed[0].version, rootPackage.version);
const tarball = path.join(artifacts, packed[0].filename);
const actualPublishedPaths = archivePaths(tarball, 'npm-final-tar-inventory');
assert.equal(actualPublishedPaths.length, new Set(actualPublishedPaths).size, 'Duplicate archive members');
assert.deepEqual(actualPublishedPaths.sort(), receipt.publishedFilePaths, 'Actual archive differs from planned archive inventory');
for (const relative of actualPublishedPaths) assert(!relative.endsWith('.node') && !relative.split('/').some((part) => ['.npmrc', '.git', '.pnpm', '_cacache', '.qinglong-npm-build-owner.json'].includes(part)), `Forbidden archive payload ${relative}`);
assert.equal(sha(fs.readFileSync(__filename)), exporterSHA256, 'Exporter source changed during build');
assert.equal(sha(fs.readFileSync(path.join(__dirname, 'install-bundled-sqlite.cjs'))), installerSHA256, 'Installer source changed during build');
assert.equal(sha(fs.readFileSync(path.join(__dirname, 'verify-npm-package.cjs'))), verifierSHA256, 'Verifier source changed during build');
for (const name of helperNames) assert.equal(sha(fs.readFileSync(path.join(__dirname, name))), helperHashes[name], `Helper changed during build: ${name}`);
fs.writeFileSync(path.join(output, 'npm-pack.json'), `${JSON.stringify(packed, null, 2)}\n`);
fs.writeFileSync(path.join(output, 'package-build-summary.json'), `${JSON.stringify({ ...receipt, tarball: { filename: packed[0].filename, sha256: sha(fs.readFileSync(tarball)), bytes: fs.statSync(tarball).size, files: packed[0].entryCount } }, null, 2)}\n`);
console.log(JSON.stringify({ output, tarball, sourceCommit: sourceRef, lockSHA256, ciStaticFilesVerified: actualArtifactFiles.length, shippedPackages: shipped.length, transforms: transforms.length }));
