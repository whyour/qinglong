const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  inspectLegacySqlitePath,
  prepareLocalSqliteActivation,
  stageLocalSqliteAdoption,
} = require('@qinglong/local-admin');
const {
  bootstrapLocalAdoptedProfileStorage,
} = require('@qinglong/local-admin/adopted-profile');

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-adopted-profile-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const value = {
    directory,
    sourcePath: path.join(directory, 'database.sqlite'),
    targetPath: path.join(directory, 'qinglong3.sqlite'),
    recoveryPath: path.join(directory, 'database.pre-ql3.sqlite'),
    manifestPath: path.join(directory, 'qinglong3-adoption.json'),
    activationPath: path.join(directory, 'qinglong3-activation.json'),
  };
  const source = new DatabaseSync(value.sourcePath);
  source.exec(`
    CREATE TABLE "Auths" (id INTEGER PRIMARY KEY, type TEXT, info TEXT);
    CREATE TABLE "Crontabs" (
      id INTEGER PRIMARY KEY, command TEXT NOT NULL, schedule TEXT
    );
    CREATE TABLE "Envs" (
      id INTEGER PRIMARY KEY, name TEXT, value TEXT
    );
    INSERT INTO "Crontabs" (id, command, schedule)
      VALUES (1, 'echo legacy', '0 0 * * *');
  `);
  source.close();
  return value;
}

async function prepare(t, profile = 'edge') {
  const value = fixture(t);
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile,
  });
  const adoption = await stageLocalSqliteAdoption({
    ...value,
    profile,
    expectedPlanDigest: plan.planDigest,
  });
  const activation = await prepareLocalSqliteActivation({
    ...value,
    expectedManifestDigest: adoption.manifestDigest,
  });
  return { ...value, activation };
}

test('runtime adopted composition does not load executable migration SQL', () => {
  const script = `
    require(${JSON.stringify(path.resolve(__dirname, '../dist/adopted-profile/localAdoptedProfile.js'))});
    const loaded = Object.keys(require.cache)
      .filter((entry) => /[\\/]local-sqlite[\\/]dist[\\/](?:migration|migrations[\\/])/.test(entry));
    process.stdout.write(JSON.stringify(loaded));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('disabled adopted composition never inspects activation paths', async () => {
  const storageAudits = [];
  const adoptionAudits = [];
  const result = await bootstrapLocalAdoptedProfileStorage({
    enabled: false,
    profile: 'edge',
    sourcePath: 'invalid',
    targetPath: 'invalid',
    recoveryPath: 'invalid',
    manifestPath: 'invalid',
    activationPath: 'invalid',
    expectedActivationDigest: 'invalid',
    audit: (record) => storageAudits.push(record),
    adoptionAudit: (record) => adoptionAudits.push(record),
  });

  assert.equal(result.status, 'disabled');
  assert.deepEqual(
    storageAudits.map(({ state }) => state),
    ['disabled'],
  );
  assert.deepEqual(
    adoptionAudits.map(({ state }) => state),
    ['disabled'],
  );
  assert.equal(await result.stop(), 'stopped');
  assert.deepEqual(
    adoptionAudits.map(({ state }) => state),
    ['disabled', 'stopped'],
  );
});

test('starts target storage only while the legacy source remains fenced', async (t) => {
  const value = await prepare(t, 'edge');
  const storageAudits = [];
  const adoptionAudits = [];
  const result = await bootstrapLocalAdoptedProfileStorage({
    enabled: true,
    profile: 'edge',
    ...value,
    expectedActivationDigest: value.activation.activationDigest,
    busyTimeoutMs: 100,
    audit: (record) => storageAudits.push(record),
    adoptionAudit: (record) => adoptionAudits.push(record),
  });

  assert.equal(result.status, 'adopted_storage_ready');
  assert.equal(result.evidence.contractName, 'local-control-core');
  assert.deepEqual(await result.startupRecovery.inspectCandidates(), {
    candidates: [],
    truncated: false,
  });
  assert.deepEqual(
    adoptionAudits.map(({ state }) => state),
    ['fence_acquired', 'storage_ready'],
  );
  const legacyWriter = new DatabaseSync(value.sourcePath, { timeout: 100 });
  assert.throws(
    () =>
      legacyWriter
        .prepare('INSERT INTO "Crontabs" (id, command) VALUES (?, ?)')
        .run(2, 'echo blocked'),
    (error) => error && error.errstr === 'database is locked',
  );

  assert.equal(await result.stop(), 'stopped');
  assert.equal(await result.stop(), 'stopped');
  legacyWriter
    .prepare('INSERT INTO "Crontabs" (id, command) VALUES (?, ?)')
    .run(2, 'echo released');
  legacyWriter.close();
  assert.deepEqual(
    adoptionAudits.map(({ state }) => state),
    ['fence_acquired', 'storage_ready', 'stopped'],
  );
  assert.ok(storageAudits.some(({ state }) => state === 'storage_ready'));
  assert.ok(storageAudits.some(({ state }) => state === 'stopped'));
});

test('source drift fails activation and releases the temporary fence', async (t) => {
  const value = await prepare(t, 'standalone');
  const source = new DatabaseSync(value.sourcePath);
  source
    .prepare('INSERT INTO "Crontabs" (id, command) VALUES (?, ?)')
    .run(2, 'echo late');
  source.close();
  const adoptionAudits = [];

  await assert.rejects(
    bootstrapLocalAdoptedProfileStorage({
      enabled: true,
      profile: 'standalone',
      ...value,
      expectedActivationDigest: value.activation.activationDigest,
      busyTimeoutMs: 100,
      audit() {},
      adoptionAudit: (record) => adoptionAudits.push(record),
    }),
    /legacy source identity or catalog changed after staging/,
  );
  assert.deepEqual(
    adoptionAudits.map(({ state }) => state),
    ['failed'],
  );
  const writer = new DatabaseSync(value.sourcePath, { timeout: 100 });
  writer
    .prepare('INSERT INTO "Crontabs" (id, command) VALUES (?, ?)')
    .run(3, 'echo no leaked fence');
  writer.close();
});

test('fails before readiness when the target path changes while storage opens', async (t) => {
  const value = await prepare(t, 'edge');
  const replacementPath = path.join(value.directory, 'replacement.sqlite');
  const adoptionAudits = [];

  await assert.rejects(
    bootstrapLocalAdoptedProfileStorage({
      enabled: true,
      profile: 'edge',
      ...value,
      expectedActivationDigest: value.activation.activationDigest,
      busyTimeoutMs: 100,
      audit(record) {
        if (record.state !== 'storage_ready') return;
        fs.copyFileSync(value.targetPath, replacementPath);
        fs.renameSync(replacementPath, value.targetPath);
      },
      adoptionAudit: (record) => adoptionAudits.push(record),
    }),
    /target database identity does not match the activation/,
  );
  assert.deepEqual(
    adoptionAudits.map(({ state }) => state),
    ['fence_acquired', 'failed'],
  );
  const writer = new DatabaseSync(value.sourcePath, { timeout: 100 });
  writer
    .prepare('INSERT INTO "Crontabs" (id, command) VALUES (?, ?)')
    .run(2, 'echo no leaked fence');
  writer.close();
});
