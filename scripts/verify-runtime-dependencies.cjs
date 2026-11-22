// Run from the panel root, including via stdin inside an offline release image.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const yaml = require('js-yaml');

assert.equal(
  process.versions.node,
  fs.readFileSync('.nvmrc', 'utf8').trim(),
  'Node runtime differs from the production version',
);

const panelRequire = createRequire(path.resolve('package.json'));
const manifest = panelRequire('./package.json');
const lock = yaml.load(fs.readFileSync('pnpm-lock.yaml', 'utf8'));

function verifyDirect(name) {
  const entry = lock.dependencies[name];
  assert.equal(
    entry?.specifier,
    manifest.dependencies[name],
    `${name}: manifest/lock mismatch`,
  );
  // pnpm appends peer resolution context, e.g. 6.37.8(@whyour/sqlite3@1.1.5).
  assert.equal(
    panelRequire(`${name}/package.json`).version,
    entry.version.split('(')[0],
    `${name}: installed/lock mismatch`,
  );
  return entry.version;
}

for (const name of ['@grpc/grpc-js', 'compression', 'multer', 'sequelize']) {
  verifyDirect(name);
}

for (const [parent, name] of [
  ['express', 'proxy-addr'],
  ['sockjs', 'websocket-driver'],
]) {
  const version = verifyDirect(parent);
  const expected = lock.packages[`/${parent}@${version}`]?.dependencies?.[name];
  assert.ok(expected, `${parent} > ${name}: missing lock entry`);
  const parentRequire = createRequire(panelRequire.resolve(parent));
  assert.equal(
    parentRequire(`${name}/package.json`).version,
    expected.split('(')[0],
    `${parent} > ${name}: installed/lock mismatch`,
  );
}

for (const name of ['sqlite3', 'nodemailer', 'undici']) panelRequire(name);
console.log(
  'Production dependencies match the manifest and lockfile; runtime imports verified',
);
