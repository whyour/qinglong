const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const load = require('../helpers/load-security-module.cjs');
const source = path.join(__dirname, '../../back/shared/scriptHistory.ts');
const mocks = {
  '../config/util': {
    fileExist: async (file) =>
      fs.access(file).then(
        () => true,
        () => false,
      ),
  },
};
const { ScriptHistory, SCRIPT_HISTORY_LIMITS } = load(source, mocks);

async function fixture(t, limits = {}, History = ScriptHistory) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-history-'));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const scripts = path.join(root, 'scripts');
  const history = path.join(root, 'history');
  await fs.mkdir(scripts);
  const file = path.join(scripts, 'test.js');
  await fs.writeFile(file, 'original\n');
  const service = new History(scripts, history, ['auth.json'], {
    ...SCRIPT_HISTORY_LIMITS,
    ...limits,
  });
  return { root, scripts, history, file, service };
}

test('first save, unchanged save, restore and undo restore preserve exact content', async (t) => {
  const { service, file, history } = await fixture(t);
  assert.deepEqual((await service.list('', 'test.js')).versions, []);
  await assert.rejects(fs.stat(history), { code: 'ENOENT' });
  await service.save('', 'test.js', 'second\r\n中文');
  let list = await service.list('', 'test.js');
  assert.equal(list.versions.length, 1);
  assert.equal(list.versions[0].source, 'baseline');
  assert.equal(
    (await service.detail('', 'test.js', list.versions[0].id)).version.content,
    'original\n',
  );
  const archive = path.join(history, (await fs.readdir(history))[0]);
  const before = await fs.readFile(archive);
  await service.save('', 'test.js', 'second\r\n中文');
  assert.deepEqual(
    await fs.readFile(archive),
    before,
    'unchanged save performs no archive write',
  );
  await service.restore('', 'test.js', list.versions[0].id, list.currentHash);
  assert.equal(await fs.readFile(file, 'utf8'), 'original\n');
  list = await service.list('', 'test.js');
  assert.equal(list.versions[0].source, 'save');
  await service.restore('', 'test.js', list.versions[0].id, list.currentHash);
  assert.equal(await fs.readFile(file, 'utf8'), 'second\r\n中文');
  assert.equal(
    (await service.list('', 'test.js')).versions[0].source,
    'restore',
  );
});

test('conflict check refuses to overwrite a file changed after preview, including external edits', async (t) => {
  const { service, file } = await fixture(t);
  await service.save('', 'test.js', 'saved');
  const list = await service.list('', 'test.js');
  await fs.writeFile(file, 'external');
  await assert.rejects(
    service.restore('', 'test.js', list.versions[0].id, list.currentHash),
    { status: 409 },
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'external');
  await service.save('', 'test.js', 'after external');
  const current = await service.list('', 'test.js');
  assert.equal(current.versions[0].source, 'external');
  assert.equal(
    (await service.detail('', 'test.js', current.versions[0].id)).version
      .content,
    'external',
  );
});

test('same-name files are isolated, traversal, blacklist and escaping symlinks are forbidden', async (t) => {
  const { service, scripts, root } = await fixture(t);
  await fs.mkdir(path.join(scripts, 'nested'));
  await fs.writeFile(path.join(scripts, 'nested', 'test.js'), 'nested');
  await service.save('nested', 'test.js', 'changed');
  assert.equal((await service.list('', 'test.js')).versions.length, 0);
  await fs.writeFile(path.join(root, 'outside.js'), 'secret');
  await fs.symlink(
    path.join(root, 'outside.js'),
    path.join(scripts, 'escape.js'),
  );
  for (const filename of ['../outside.js', 'auth.json', 'escape.js']) {
    await assert.rejects(service.save('', filename, 'bad'), { status: 403 });
    await assert.rejects(service.list('', filename), { status: 403 });
  }
  await fs.symlink(
    path.join(scripts, 'test.js'),
    path.join(scripts, 'alias.js'),
  );
  await service.save('', 'alias.js', 'via alias');
  assert.equal(
    (await service.list('', 'test.js')).versions.length,
    1,
    'safe aliases share one canonical history',
  );
});

test('concurrent saves across service instances serialize snapshots without losing content', async (t) => {
  const { service, scripts, history, file } = await fixture(t);
  const other = new ScriptHistory(scripts, history);
  await Promise.all([
    service.save('', 'test.js', 'A'),
    other.save('', 'test.js', 'B'),
  ]);
  const list = await service.list('', 'test.js');
  const contents = await Promise.all(
    list.versions.map((v) =>
      service.detail('', 'test.js', v.id).then((d) => d.version.content),
    ),
  );
  contents.push(await fs.readFile(file, 'utf8'));
  assert.deepEqual(contents.sort(), ['A', 'B', 'original\n'].sort());
});

test('retention trims old revisions and bounds file count and global compressed storage', async (t) => {
  const { service, scripts, history } = await fixture(t, {
    versions: 3,
    files: 2,
    totalBytes: 1800,
  });
  for (let i = 0; i < 6; i++) await service.save('', 'test.js', `version ${i}`);
  const list = await service.list('', 'test.js');
  assert.equal(list.versions.length, 3);
  assert.equal(
    (await service.detail('', 'test.js', list.versions.at(-1).id)).version
      .content,
    'version 2',
  );
  for (let i = 0; i < 5; i++) {
    const name = `${i}.js`;
    await fs.writeFile(
      path.join(scripts, name),
      randomBytes(300).toString('hex'),
    );
    await service.save('', name, 'new');
  }
  const files = await fs.readdir(history);
  assert.ok(files.length <= 2);
  let total = 0;
  for (const name of files)
    total += (await fs.stat(path.join(history, name))).size;
  assert.ok(total <= 1800);
  assert.equal((await service.list('', '4.js')).versions.length, 1);
});

test('invalid text, oversized files and corrupted archives fail without overwriting scripts', async (t) => {
  const { service, file, history } = await fixture(t, { fileBytes: 100 });
  await assert.rejects(service.save('', 'test.js', 'a'.repeat(101)), {
    status: 413,
  });
  await fs.writeFile(file, Buffer.from([0xff, 0xfe]));
  await assert.rejects(service.save('', 'test.js', 'new'), { status: 413 });
  await fs.writeFile(file, 'before');
  await service.save('', 'test.js', 'after');
  await fs.writeFile(
    path.join(history, (await fs.readdir(history))[0]),
    'corrupt',
  );
  await assert.rejects(service.save('', 'test.js', 'replacement'), {
    status: 500,
  });
  assert.equal(await fs.readFile(file, 'utf8'), 'after');
});

test('archive failure prevents overwrite; file-write failure retains snapshot and releases locks', async (t) => {
  let fail = 'archive';
  const { ScriptHistory: FailingHistory } = load(source, {
    ...mocks,
    'fs/promises': {
      ...fs,
      writeFile: async (file, ...args) => {
        if (fail === 'archive' && String(file).endsWith('.pending.tmp')) {
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return fs.writeFile(file, ...args);
      },
      rename: async (from, to) => {
        if (fail === 'script' && String(to).endsWith('test.js'))
          throw Object.assign(new Error('commit failed'), { code: 'ENOSPC' });
        return fs.rename(from, to);
      },
    },
  });
  const { service, file } = await fixture(t, {}, FailingHistory);
  await assert.rejects(service.save('', 'test.js', 'new'), { code: 'ENOSPC' });
  assert.equal(await fs.readFile(file, 'utf8'), 'original\n');
  fail = 'script';
  await assert.rejects(service.save('', 'test.js', 'new'), { code: 'ENOSPC' });
  assert.equal((await service.list('', 'test.js')).versions.length, 0);
  assert.equal(await fs.readFile(file, 'utf8'), 'original\n');
  fail = '';
  await service.save('', 'test.js', 'success');
  assert.equal(await fs.readFile(file, 'utf8'), 'success');
  assert.equal((await service.list('', 'test.js')).versions.length, 1);
});

test('empty content is a valid recoverable version and missing versions return 404', async (t) => {
  const { service, file } = await fixture(t);
  await service.save('', 'test.js', '');
  await service.save('', 'test.js', 'again');
  const list = await service.list('', 'test.js');
  const empty = list.versions[0];
  assert.equal(empty.size, 0);
  await service.restore('', 'test.js', empty.id, list.currentHash);
  assert.equal(await fs.readFile(file, 'utf8'), '');
  await assert.rejects(service.detail('', 'test.js', 'unknown'), {
    status: 404,
  });
});

test('quota eviction never happens on failed preparation or failed commit', async (t) => {
  let failure = '';
  const { ScriptHistory: Faulty } = load(source, {
    ...mocks,
    'fs/promises': {
      ...fs,
      writeFile: async (file, ...args) => {
        if (
          failure === 'archive-write' &&
          String(file).endsWith('.pending.tmp')
        )
          throw Object.assign(new Error('full'), { code: 'ENOSPC' });
        if (
          failure === 'script-write' &&
          path.basename(file).startsWith('.ql-save-')
        )
          throw Object.assign(new Error('full'), { code: 'ENOSPC' });
        return fs.writeFile(file, ...args);
      },
      rename: async (from, to) => {
        if (failure === 'archive-commit' && String(to).endsWith('.br'))
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        if (failure === 'script-commit' && String(to).endsWith('.js'))
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return fs.rename(from, to);
      },
    },
  });
  const { service, scripts, history } = await fixture(t, { files: 1 }, Faulty);
  await service.save('', 'test.js', 'saved');
  const archive = path.join(history, (await fs.readdir(history))[0]);
  const original = await fs.readFile(archive);
  await fs.writeFile(path.join(scripts, 'other.js'), 'other-original');
  for (const step of [
    'archive-write',
    'script-write',
    'archive-commit',
    'script-commit',
  ]) {
    failure = step;
    await assert.rejects(service.save('', 'other.js', 'other-changed'), {
      code: step.endsWith('write') ? 'ENOSPC' : 'EACCES',
    });
    assert.deepEqual(await fs.readFile(archive), original, step);
    assert.equal(
      await fs.readFile(path.join(scripts, 'other.js'), 'utf8'),
      'other-original',
    );
    assert.equal((await fs.readdir(history)).length, 1);
    assert.equal(
      (await fs.readdir(scripts)).length,
      2,
      'no script staging leftovers',
    );
  }
  // Updating an existing history also restores its exact prior bytes if the
  // script rename fails, including revisions that retention would have pruned.
  failure = 'script-commit';
  await assert.rejects(service.save('', 'test.js', 'changed'), {
    code: 'EACCES',
  });
  assert.deepEqual(await fs.readFile(archive), original);
  assert.equal(
    await fs.readFile(path.join(scripts, 'test.js'), 'utf8'),
    'saved',
  );
  failure = '';
  await service.save('', 'other.js', 'other-changed');
  assert.equal((await service.list('', 'test.js')).versions.length, 0);
});

test('cleanup errors report a successful save with a warning and are retried on the next save', async (t) => {
  let failure = false;
  const { ScriptHistory: Faulty } = load(source, {
    ...mocks,
    'fs/promises': {
      ...fs,
      unlink: async (file) => {
        if (failure && String(file).endsWith('.br'))
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return fs.unlink(file);
      },
    },
  });
  const { service, scripts, history } = await fixture(t, { files: 1 }, Faulty);
  await service.save('', 'test.js', 'saved');
  await fs.writeFile(path.join(scripts, 'other.js'), 'old');
  failure = true;
  const result = await service.save('', 'other.js', 'new');
  assert.equal(result.cleanupPending, true);
  assert.equal(
    await fs.readFile(path.join(scripts, 'other.js'), 'utf8'),
    'new',
  );
  failure = false;
  await service.save('', 'other.js', 'next');
  assert.equal((await fs.readdir(history)).length, 1);
});

test('large files can be reduced only after explicit historyless confirmation with a matching hash', async (t) => {
  const { service, file } = await fixture(t, { fileBytes: 100 });
  await fs.writeFile(file, 'x'.repeat(101));
  let confirmation;
  try {
    await service.save('', 'test.js', 'small');
  } catch (error) {
    confirmation = error;
  }
  assert.equal(confirmation.status, 413);
  assert.match(confirmation.currentHash, /^[a-f0-9]{64}$/);
  assert.equal((await fs.stat(file)).size, 101);
  await assert.rejects(
    service.save('', 'test.js', 'small', {
      skipHistory: true,
      expectedHash: '0'.repeat(64),
    }),
    { status: 409 },
  );
  const result = await service.save('', 'test.js', 'small', {
    skipHistory: true,
    expectedHash: confirmation.currentHash,
  });
  assert.equal(result.historyRecorded, false);
  assert.equal(await fs.readFile(file, 'utf8'), 'small');
  await service.save('', 'test.js', 'normal');
  assert.equal(
    (await service.list('', 'test.js')).versions.length,
    1,
    'normal history resumes',
  );
  try {
    await service.save('', 'test.js', 'x'.repeat(101));
  } catch (error) {
    confirmation = error;
  }
  await fs.writeFile(file, 'someone else changed it');
  await assert.rejects(
    service.save('', 'test.js', 'x'.repeat(101), {
      skipHistory: true,
      expectedHash: confirmation.currentHash,
    }),
    { status: 409 },
  );
});

test('atomic saves preserve executable mode and canonical symlink targets', async (t) => {
  const { service, scripts, file } = await fixture(t);
  await fs.chmod(file, 0o755);
  await fs.symlink(file, path.join(scripts, 'alias.js'));
  await service.save('', 'alias.js', 'new');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o755);
  assert.equal(
    (await fs.lstat(path.join(scripts, 'alias.js'))).isSymbolicLink(),
    true,
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'new');
});
