const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { Sequelize, DataTypes, QueryTypes } = require('sequelize');
const load = require('../helpers/load-security-module.cjs');
const {
  configureSqliteParsers,
} = require('../../back/shared/sqliteCompatibility');
const { migrateSchema } = require('../../back/shared/schemaMigrations');
const {
  rewriteMirrorSources,
  replaceMirrorUrl,
  normalizeMirror,
  mirrorWriteCommand,
} = require('../../back/shared/linuxMirror');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-issue-fixes-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  return root;
}

test('#3063 reads numeric legacy dates after closing and reopening a real SQLite database', async (t) => {
  const root = await fixture(t);
  const storage = path.join(root, 'database.sqlite');
  let db = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  let Row = db.define('Legacy', { at: DataTypes.DATE }, { timestamps: false });
  await Row.sync();
  await Row.create({ at: new Date() });
  await db.query('UPDATE Legacies SET at = 1770000000000');
  await assert.rejects(Row.findAll(), /date.includes/);
  await db.close();
  db = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  t.after(() => db.close());
  configureSqliteParsers(db);
  Row = db.define('Legacy', { at: DataTypes.DATE }, { timestamps: false });
  assert.equal((await Row.findOne()).at.getTime(), 1770000000000);
  for (const [value, expected] of [
    ['2026-10-11 12:00:00.000 +00:00', '2026-10-11T12:00:00.000Z'],
    ['2026-10-11T12:00:00.000Z', '2026-10-11T12:00:00.000Z'],
    ['2026-10-11T12:00:00-05:00', '2026-10-11T17:00:00.000Z'],
    ['2026-10-11 12:00:00', '2026-10-11T12:00:00.000Z'],
    [null, null],
  ]) {
    await db.query('UPDATE Legacies SET at = :value', {
      replacements: { value },
    });
    const row = await Row.findOne();
    assert.equal(row.at?.toISOString() ?? null, expected);
  }
  const query = new db.dialect.Query(null, db, {});
  assert.equal(query.applyParsers(42, 'unchanged'), 'unchanged');
  assert.equal(
    query.applyParsers('DATETIME', new Date(1770000000000)).getTime(),
    1770000000000,
  );
});

test('#2645 archives legacy duplicates and prevents duplicates from batches, parallel requests and edits', async (t) => {
  const root = await fixture(t);
  const db = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(root, 'db.sqlite'),
    logging: false,
    retry: { max: 10 },
  });
  t.after(() => db.close());
  const { DependenceModel, Dependence } = load('back/data/dependence.ts', {
    '.': { sequelize: db },
  });
  await DependenceModel.sync();
  for (const name of ['CrontabViews', 'Subscriptions', 'Crontabs', 'Envs'])
    await db.query(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, name TEXT)`);
  await DependenceModel.bulkCreate([
    {
      name: ' duplicate ',
      type: 0,
      status: 2,
      log: ['failed-old'],
      remark: 'archive-me',
    },
    {
      name: 'duplicate',
      type: 0,
      status: 1,
      log: ['installed'],
      remark: 'keep-me',
    },
    { name: 'duplicate', type: 1, status: 1 },
    { name: 'null-status', type: 2, status: null },
    { name: 'null-status', type: 2, status: null },
  ]);
  await migrateSchema(db);
  await migrateSchema(db);
  assert.equal(await DependenceModel.count(), 3);
  const kept = await DependenceModel.findOne({
    where: { name: 'duplicate', type: 0 },
  });
  assert.equal(kept.remark, 'keep-me');
  const archive = await db.query(
    'SELECT * FROM DependenceDuplicates ORDER BY id',
    { type: QueryTypes.SELECT },
  );
  assert.equal(archive.length, 2);
  assert.equal(archive[0].remark, 'archive-me');
  assert.equal(archive[0].name, ' duplicate ');
  const Service = load('back/services/dependence.ts', {
    '../data/dependence': {
      DependenceModel,
      Dependence,
      DependenceStatus: { queued: 6 },
      DependenceTypes: {},
      versionDependenceCommandTypes: {},
    },
    '../config': {},
    '../config/util': {},
    '../shared/pLimit': {},
    './sock': class {},
    '../config/const': {},
    '../shared/i18n': {},
  }).default;
  const service = new Service({}, {});
  const installations = [];
  service.installDependenceOneByOne = (docs) => {
    installations.push(...docs.map((x) => x.id));
  };
  await service.create([{ name: ' duplicate ', type: 0 }]);
  assert.equal(installations.length, 0);
  await service.create([
    { name: 'batch', type: 0 },
    { name: ' batch ', type: 0 },
  ]);
  await Promise.all(
    Array.from({ length: 8 }, () =>
      service.create([{ name: 'parallel', type: 0 }]),
    ),
  );
  assert.equal(
    await DependenceModel.count({ where: { name: 'parallel', type: 0 } }),
    1,
  );
  assert.equal(installations.length, 2);
  const separate = await service.create([
    { name: 'batch@1.0.0', type: 0 },
    { name: 'batch', type: 1 },
  ]);
  assert.equal(separate.length, 2);
  await assert.rejects(
    service.update({ id: separate[0].id, name: 'batch', type: 0 }),
  );
  assert.equal(
    await DependenceModel.count({ where: { name: 'batch', type: 0 } }),
    1,
  );
});

test('#2902/#2871 mirror writes are idempotent, preserve suites, security/ports/version paths and quote URLs', async (t) => {
  const original = `# http://leave.example/debian\nTypes: deb\nURIs: http://deb.debian.org/debian\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: http://security.debian.org/debian-security\nSuites: bookworm-security\n`;
  const url = 'https://mirror.example/mirrors/debian/';
  const changed = rewriteMirrorSources(original, url);
  assert.equal(rewriteMirrorSources(changed, url), changed);
  assert.match(
    changed,
    /URIs: https:\/\/mirror.example\/mirrors\/debian-security/,
  );
  assert.match(changed, /Suites: bookworm-security/);
  assert.match(changed, /# http:\/\/leave.example\/debian/);
  assert.equal(
    replaceMirrorUrl('http://old/debian/debian/debian', url),
    'https://mirror.example/mirrors/debian',
  );
  assert.equal(
    replaceMirrorUrl('http://old/armbian/armbian', 'https://new/armbian'),
    'https://new/armbian',
  );
  assert.equal(
    replaceMirrorUrl('http://old/ubuntu-ports', 'https://new/ubuntu'),
    'https://new/ubuntu-ports',
  );
  assert.equal(
    replaceMirrorUrl('http://old/alpine/v3.22/main', 'https://new/alpine'),
    'https://new/alpine/v3.22/main',
  );
  assert.equal(
    replaceMirrorUrl('http://old/debian', 'https://new'),
    'https://new/debian',
  );
  for (const bad of [
    'file:///tmp/a',
    'http://u:p@host',
    'https://host?x=1',
    'https://host/\nanything',
  ])
    assert.throws(() => normalizeMirror(bad));
  const root = await fixture(t);
  const file = path.join(root, "quote's", 'sources');
  const command = mirrorWriteCommand(file, changed, '', 'true');
  const result = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(file, 'utf8'), changed);
});

const updateFunctions = async () =>
  (await fs.readFile('shell/update.sh', 'utf8'))
    .split('\nmain() {')[0]
    .replace(/^[\s\S]*?(?=diff_cron\(\))/, '');

test('#2701 shell API serializes CR/LF, quotes, backslashes and colons without corrupting JSON', async () => {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source shell/api.sh
ql_api_request() { while [[ $# -gt 0 ]]; do if [[ "$1" == --data-raw ]]; then printf '%s\\n' "$2" >&3; break; fi; shift; done; printf '{"code":200}'; }
t() { :; }
add_cron_api '0 0 1 1 *' 'task a:b.js' $'quote"slash\\\\colon:\\r\\n\\t中文' 23
update_cron_api '0 0 1 1 *' 'task a:b.js' $'quote"slash\\\\colon:\\r\\n\\t中文' 27
update_cron_command_api $'task path\\\\with"quotes.js' 27
`,
    ],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', 'pipe'] },
  );
  assert.equal(result.status, 0, result.stderr);
  const payloads = result.output[3].trim().split('\n').map(JSON.parse);
  assert.equal(payloads[0].name, 'quote"slash\\colon:\r\n\t中文');
  assert.equal(payloads[0].sub_id, 23);
  assert.equal(payloads[1].id, '27');
  assert.equal(payloads[2].command, 'task path\\with"quotes.js');
});

test('#2967 sync exclusions protect ordinary/dependency/bundled/overlay files and automatic deletion', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'repo'),
    scripts = path.join(root, 'scripts'),
    lists = path.join(root, 'lists'),
    dep = path.join(root, 'dep');
  for (const dir of [repo, path.join(scripts, 'fixture/config'), lists, dep])
    await fs.mkdir(dir, { recursive: true });
  for (const file of ['normal.js', 'helper.js', 'sendNotify.js'])
    await fs.writeFile(path.join(repo, file), 'REMOTE');
  await fs.mkdir(path.join(repo, 'config'));
  await fs.writeFile(path.join(repo, 'config/env.js'), 'REMOTE');
  for (const file of [
    'normal.js',
    'helper.js',
    'sendNotify.js',
    'config/env.js',
  ])
    await fs.writeFile(path.join(scripts, 'fixture', file), 'LOCAL');
  await fs.writeFile(path.join(dep, 'helper.js'), 'OVERLAY');
  const notify = path.join(root, 'sendNotify.js');
  await fs.writeFile(notify, 'BUNDLED');
  const cron = path.join(root, 'crons');
  await fs.writeFile(cron, 'ID=3 task fixture/helper.js\n');
  const functions = await updateFunctions();
  const result = spawnSync(
    'bash',
    [
      '-c',
      `${functions}
make_dir() { mkdir -p "$1"; }
t() { :; }; del_cron_api() { :; }; notify_api() { :; }
uniq_path=fixture; dir_scripts="$2"; dir_list_tmp="$3"; dir_dep="$4"; file_notify_js="$5"; file_notify_py="$5"; list_crontab_user="$6"; cmd_task=task
QL_SUB_SKIP_FILES=$'normal.js\\nhelper.js\\nsendNotify.js\\nconfig/\\r'
gen_list_repo "$1" author '' '' 'helper' 'js'
printf 'fixture/helper.js\\n' > "$3/drop.list"
del_cron "$3/drop.list" fixture
`,
      'fixture',
      repo,
      scripts,
      lists,
      dep,
      notify,
      cron,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  for (const file of [
    'normal.js',
    'helper.js',
    'sendNotify.js',
    'config/env.js',
  ])
    assert.equal(
      await fs.readFile(path.join(scripts, 'fixture', file), 'utf8'),
      'LOCAL',
    );
  // Empty exclusions retain the legacy dependency+blacklist copy behavior.
  const legacy = spawnSync(
    'bash',
    [
      '-c',
      `${functions}
make_dir() { mkdir -p "$1"; }; uniq_path=fixture; dir_scripts="$2"; dir_list_tmp="$3"; file_notify_js="$4"; file_notify_py="$4"; list_crontab_user="$5"; cmd_task=task
QL_SUB_SKIP_FILES=''; gen_list_repo "$1" author '' 'helper' 'helper' 'js'
`,
      'fixture',
      repo,
      scripts,
      lists,
      notify,
      cron,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(
    await fs.readFile(path.join(scripts, 'fixture/helper.js'), 'utf8'),
    'REMOTE',
  );
  assert.doesNotMatch(
    await fs.readFile(path.join(lists, 'fixture_scripts.list'), 'utf8'),
    /helper/,
  );
});
