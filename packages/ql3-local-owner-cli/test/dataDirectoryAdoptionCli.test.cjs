const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const BINARY = path.join(__dirname, '../dist/lifecycle/adoptionCli.js');
const OPERATION = 'local-data-directory.adoption.inspect';

const RECURSIVE_CATEGORIES = Object.freeze([
  ['config', 'transform'],
  ['scripts', 'copy_reviewed'],
  ['db', 'transform'],
  ['upload', 'copy_reviewed'],
  ['ssh.d', 'transform'],
]);
const ROOT_ONLY_CATEGORIES = Object.freeze([
  ['log', 'retain_external'],
  ['syslog', 'retain_external'],
  ['bak', 'retain_external'],
  ['repo', 'regenerate'],
  ['raw', 'regenerate'],
  ['dep_cache', 'regenerate'],
  ['deps', 'regenerate'],
]);

function privateDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(directoryPath, 0o700);
}

function privateFile(filePath, content) {
  privateDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-data-directory-adoption-')),
  );
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commandsDirectory = path.join(root, 'commands');
  const dataRoot = path.join(root, 'data');
  privateDirectory(commandsDirectory);
  privateDirectory(dataRoot);

  privateFile(path.join(dataRoot, 'config', 'config.sh'), 'export A=1\n');
  privateFile(
    path.join(dataRoot, 'scripts', 'jobs', 'example.sh'),
    'echo qinglong\n',
  );
  privateFile(path.join(dataRoot, 'db', 'database.sqlite'), 'legacy-primary');
  privateFile(path.join(dataRoot, 'db', 'keyv.sqlite'), 'legacy-keyv');
  privateFile(path.join(dataRoot, 'upload', 'avatar.bin'), Buffer.from([1, 2]));
  privateFile(path.join(dataRoot, 'ssh.d', 'repository-key'), 'private-key');

  for (const [category] of ROOT_ONLY_CATEGORIES) {
    privateFile(
      path.join(dataRoot, category, 'nested', 'ignored-content'),
      `ignored-${category}`,
    );
  }
  return { root, commandsDirectory, dataRoot };
}

function runRaw(value, name, command) {
  const commandPath = path.join(value.commandsDirectory, `${name}.json`);
  fs.writeFileSync(commandPath, `${JSON.stringify(command)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(commandPath, 0o600);
  return spawnSync(
    process.execPath,
    [BINARY, 'run', '--command-file', commandPath],
    { encoding: 'utf8' },
  );
}

function inspect(value, name = 'inspect', profile = 'edge') {
  const child = runRaw(value, name, {
    schemaVersion: 1,
    operation: OPERATION,
    options: { dataRoot: value.dataRoot, profile },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  return { child, result: JSON.parse(child.stdout) };
}

function categoryMap(result) {
  return new Map(
    result.evidence.categories.map((category) => [category.name, category]),
  );
}

test('data directory adoption emits a deterministic content-free migration plan', (t) => {
  const value = fixture(t);
  const first = inspect(value, 'first');
  const second = inspect(value, 'second');

  assert.equal(first.result.schemaVersion, 1);
  assert.equal(first.result.operation, OPERATION);
  assert.equal(first.result.status, 'inspected');
  assert.equal(
    first.result.evidence.kind,
    'qinglong3-legacy-data-directory-adoption-plan',
  );
  assert.equal(first.result.evidence.profile, 'edge');
  assert.equal(first.result.evidence.policyVersion, 1);
  assert.equal(first.result.evidence.assessment, 'reviewable');
  assert.equal(first.result.evidence.unknownTopLevelEntries, 0);
  assert.equal(first.result.evidence.totalInspectedEntries, 7);
  assert.equal(first.result.evidence.totalUnsafeEntries, 0);
  assert.match(first.result.evidence.planDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(second.result, first.result);

  const categories = categoryMap(first.result);
  assert.equal(categories.size, 12);
  for (const [name, disposition] of RECURSIVE_CATEGORIES) {
    assert.deepEqual(
      {
        disposition: categories.get(name).disposition,
        inspection: categories.get(name).inspection,
        present: categories.get(name).present,
      },
      { disposition, inspection: 'recursive_content', present: true },
    );
  }
  for (const [name, disposition] of ROOT_ONLY_CATEGORIES) {
    assert.deepEqual(
      {
        disposition: categories.get(name).disposition,
        inspection: categories.get(name).inspection,
        present: categories.get(name).present,
        entries: categories.get(name).entries,
        logicalBytes: categories.get(name).logicalBytes,
      },
      {
        disposition,
        inspection: 'root_only',
        present: true,
        entries: 0,
        logicalBytes: null,
      },
    );
  }
  assert.equal(categories.get('db').primaryDatabaseFiles, 1);
  assert.equal(categories.get('db').legacyKeyValueDatabaseFiles, 1);

  assert.equal(first.child.stdout.includes(value.dataRoot), false);
  assert.equal(first.child.stdout.includes('repository-key'), false);
  assert.equal(first.child.stdout.includes('private-key'), false);
  assert.equal(first.child.stdout.includes('example.sh'), false);
});

test('root-only cache and history contents do not enter the adoption plan', (t) => {
  const value = fixture(t);
  const before = inspect(value, 'before').result;
  privateFile(
    path.join(value.dataRoot, 'repo', 'nested', 'ignored-content'),
    'different-cross-architecture-cache',
  );
  const afterRootOnlyChange = inspect(value, 'after-root-only').result;
  assert.deepEqual(afterRootOnlyChange, before);

  privateFile(
    path.join(value.dataRoot, 'scripts', 'jobs', 'example.sh'),
    'echo changed\n',
  );
  const afterRelevantChange = inspect(value, 'after-relevant').result;
  assert.notEqual(
    afterRelevantChange.evidence.planDigest,
    before.evidence.planDigest,
  );
});

test('links and unknown top-level entries fail closed without leaking names', (t) => {
  const value = fixture(t);
  const externalSecret = path.join(value.root, 'external-sensitive-value');
  privateFile(externalSecret, 'must-not-be-read');
  fs.linkSync(
    externalSecret,
    path.join(value.dataRoot, 'scripts', 'jobs', 'hard-linked-secret'),
  );
  fs.symlinkSync(
    externalSecret,
    path.join(value.dataRoot, 'scripts', 'jobs', 'linked-secret'),
  );
  const unknownName = 'customer-private-extension';
  privateFile(
    path.join(value.dataRoot, unknownName),
    'unknown-sensitive-value',
  );

  const inspected = inspect(value, 'unsafe');
  assert.equal(inspected.result.evidence.assessment, 'manual_review');
  assert.equal(inspected.result.evidence.totalUnsafeEntries, 2);
  assert.equal(inspected.result.evidence.unknownTopLevelEntries, 1);
  assert.equal(categoryMap(inspected.result).get('scripts').unsafeEntries, 2);
  for (const sensitive of [
    value.dataRoot,
    externalSecret,
    'hard-linked-secret',
    'linked-secret',
    unknownName,
    'must-not-be-read',
    'unknown-sensitive-value',
  ]) {
    assert.equal(inspected.child.stdout.includes(sensitive), false);
  }
});

test('widened commands and unsafe roots are rejected with a stable public error', (t) => {
  const value = fixture(t);
  const widened = runRaw(value, 'widened', {
    schemaVersion: 1,
    operation: OPERATION,
    options: {
      dataRoot: value.dataRoot,
      profile: 'edge',
      extraAuthority: true,
    },
  });
  assert.equal(widened.status, 1);
  assert.equal(widened.stdout, '');
  assert.equal(
    JSON.parse(widened.stderr).code,
    'LOCAL_DATA_DIRECTORY_ADOPTION_CONFIGURATION_INVALID',
  );

  fs.chmodSync(value.dataRoot, 0o777);
  const unsafe = runRaw(value, 'unsafe-root', {
    schemaVersion: 1,
    operation: OPERATION,
    options: { dataRoot: value.dataRoot, profile: 'edge' },
  });
  assert.equal(unsafe.status, 1);
  assert.equal(unsafe.stdout, '');
  const error = JSON.parse(unsafe.stderr);
  assert.equal(
    error.code,
    'LOCAL_DATA_DIRECTORY_ADOPTION_CONFIGURATION_INVALID',
  );
  assert.equal(unsafe.stderr.includes(value.dataRoot), false);
});

test('edge inspection enforces a per-file budget before reading content', (t) => {
  const value = fixture(t);
  const oversized = path.join(
    value.dataRoot,
    'scripts',
    'oversized-private-file',
  );
  privateFile(oversized, '');
  fs.truncateSync(oversized, 64 * 1024 * 1024 + 1);

  const child = runRaw(value, 'oversized', {
    schemaVersion: 1,
    operation: OPERATION,
    options: { dataRoot: value.dataRoot, profile: 'edge' },
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  const error = JSON.parse(child.stderr);
  assert.equal(
    error.code,
    'LOCAL_DATA_DIRECTORY_ADOPTION_CONFIGURATION_INVALID',
  );
  assert.match(error.message, /Profile budget/);
  assert.equal(child.stderr.includes(oversized), false);
});
