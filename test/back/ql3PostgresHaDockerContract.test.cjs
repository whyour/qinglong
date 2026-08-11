const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  privateReportPath,
  writePrivateReport,
} = require('../../scripts/ql3-postgres-ha-contract.cjs');

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'scripts/ql3-postgres-ha-contract.cjs'),
  'utf8',
);

test('mounts PostgreSQL 18 named volumes at the image-declared root', () => {
  assert.match(
    SOURCE,
    /const POSTGRES_VOLUME_ROOT = '\/var\/lib\/postgresql';/,
  );
  assert.match(
    SOURCE,
    /const POSTGRES_DATA = '\/var\/lib\/postgresql\/18\/docker';/,
  );
  assert.equal(
    SOURCE.match(
      /\$\{names\.(?:primary|standby)Volume\}:\$\{POSTGRES_VOLUME_ROOT\}/g,
    )?.length,
    6,
  );
  assert.doesNotMatch(
    SOURCE,
    /\$\{names\.(?:primary|standby)Volume\}:\$\{POSTGRES_DATA\}/,
  );
  assert.equal(SOURCE.match(/`PGDATA=\$\{POSTGRES_DATA\}`/g)?.length, 2);
  assert.match(
    SOURCE,
    /mkdir -p \$\{POSTGRES_DATA\} && chown -R postgres:postgres \$\{POSTGRES_DATA\}/,
  );
});

test('removes only its isolated HA containers, named volumes and networks', () => {
  const removeContainers =
    "docker(['rm', '-f', '-v', names.primary, names.standby]";
  const removeVolumes =
    "docker(['volume', 'rm', names.primaryVolume, names.standbyVolume]";
  assert.match(SOURCE, /ql3-ha-primary-/);
  assert.match(SOURCE, /ql3-ha-standby-/);
  assert.ok(SOURCE.indexOf(removeContainers) > 0);
  assert.ok(SOURCE.indexOf(removeVolumes) > SOURCE.indexOf(removeContainers));
  assert.doesNotMatch(SOURCE, /(?:system|builder|volume) prune/);
  assert.doesNotMatch(SOURCE, /ql3-cnpg-evidence-control-plane/);
});

test('publishes only a compact stdout envelope after durable report creation', () => {
  assert.match(SOURCE, /const reportFile = privateReportPath\(argv\);/);
  assert.match(SOURCE, /writePrivateReport\(reportFile, report\);/);
  assert.ok(
    SOURCE.indexOf('writePrivateReport(reportFile, report);') <
      SOURCE.indexOf('reportSha256:'),
  );
  assert.doesNotMatch(
    SOURCE,
    /process\.stdout\.write\(`\$\{JSON\.stringify\(report, null, 2\)\}/,
  );
});

test('publishes a private no-replace PostgreSQL HA report atomically', (t) => {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'ql3-postgres-ha-report-test-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reportPath = path.join(directory, 'report.json');
  assert.equal(privateReportPath([`--report=${reportPath}`], {}), reportPath);
  assert.equal(
    privateReportPath(['--', `--report=${reportPath}`], {}),
    reportPath,
  );

  const report = {
    schemaVersion: 1,
    fixture: 'qinglong/postgresql-ha-contract@v1',
    gates: { passed: true },
  };
  writePrivateReport(reportPath, report);
  assert.equal(fs.lstatSync(reportPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), report);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')),
    [],
  );
  assert.throws(
    () => writePrivateReport(reportPath, report),
    /EEXIST|file already exists/,
  );
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('selects a canonical private temporary report path by default', () => {
  const selected = privateReportPath([], {});
  assert.equal(path.isAbsolute(selected), true);
  assert.equal(fs.realpathSync(path.dirname(selected)), path.dirname(selected));
  assert.equal(fs.existsSync(selected), false);
});

test('rejects ambiguous, relative, existing and symlink-parent report paths', (t) => {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'ql3-postgres-ha-path-test-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reportPath = path.join(directory, 'report.json');
  assert.throws(
    () => privateReportPath(['--report=relative.json'], {}),
    /normalized absolute file/,
  );
  assert.throws(
    () =>
      privateReportPath([`--report=${reportPath}`], {
        QL3_HA_REPORT: path.join(directory, 'other.json'),
      }),
    /only once/,
  );
  fs.writeFileSync(reportPath, '{}\n', { mode: 0o600 });
  assert.throws(
    () => privateReportPath([`--report=${reportPath}`], {}),
    /refusing to overwrite/,
  );
  const realParent = path.join(directory, 'real');
  const linkedParent = path.join(directory, 'linked');
  fs.mkdirSync(realParent, { mode: 0o700 });
  fs.symlinkSync(realParent, linkedParent);
  assert.throws(
    () =>
      privateReportPath(
        [`--report=${path.join(linkedParent, 'report.json')}`],
        {},
      ),
    /canonical real directory/,
  );
});
