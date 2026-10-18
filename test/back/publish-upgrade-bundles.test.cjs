const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  sha256,
} = require('../../cli/src/internal/maintenance/platformBundle.cjs');
const {
  platforms,
  publishBundles,
} = require('../../scripts/publish-upgrade-bundles.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql-publish-bundles-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = {
    releases: new Map(),
    head: 'a'.repeat(40),
    calls: [],
    nextId: 1,
  };
  const options = {
    directory,
    commit: state.head,
    repository: 'whyour/qinglong',
    branch: 'master',
    version: '2.24.0',
    buildId: '100-1',
  };
  const write = (
    commit = options.commit,
    content = 'first',
    version = options.version,
  ) => {
    for (const target of platforms) {
      const filename = `qinglong-${commit}-${target}.tar.gz`;
      const bytes = Buffer.from(`${version}/${content}/${target}`);
      fs.writeFileSync(path.join(directory, filename), bytes);
      fs.writeFileSync(
        path.join(directory, filename + '.json'),
        JSON.stringify({
          format: 2,
          sourceCommit: commit,
          version,
          target,
          filename,
          size: bytes.length,
          sha256: sha256(bytes),
        }),
      );
    }
    fs.writeFileSync(
      path.join(directory, 'install-bundle.cjs'),
      `// ${content} installer`,
    );
  };
  const notFound = () => {
    throw Object.assign(new Error('Not found'), {
      stderr: 'gh: Not Found (HTTP 404)',
    });
  };
  const gh = (...args) => {
    state.calls.push(args);
    if (args[0] === 'api') {
      const route = args[1];
      if (route.endsWith('/git/ref/heads/master')) return state.head;
      if (route.includes('/releases/tags/')) {
        const tag = decodeURIComponent(route.split('/releases/tags/')[1]);
        if (state.lookupFailure === tag)
          throw Object.assign(new Error('Unavailable'), { stderr: 'HTTP 503' });
        const release = state.releases.get(tag);
        if (!release) return notFound();
        return JSON.stringify({
          assets: Array.from(release.values(), (a) => ({
            name: a.name,
            id: a.id,
            size: a.bytes.length,
            digest: a.digest,
          })),
        });
      }
      if (route.includes('/releases/assets/')) {
        const id = Number(route.split('/').at(-1));
        for (const release of state.releases.values())
          for (const asset of release.values())
            if (asset.id === id) return asset.bytes.toString();
        return notFound();
      }
    }
    if (args[0] === 'release' && args[1] === 'create') {
      assert.ok(!state.releases.has(args[2]));
      state.releases.set(args[2], new Map());
      return '';
    }
    if (args[0] === 'release' && args[1] === 'upload') {
      const tag = args[2],
        release = state.releases.get(tag);
      assert.ok(release);
      const files = args.slice(3, args.indexOf('--repo'));
      for (let i = 0; i < files.length; i++) {
        if (state.failBatchUpload && files.length > 1 && i === 4)
          throw new Error('Upload interrupted');
        const name = path.basename(files[i]),
          bytes = fs.readFileSync(files[i]);
        assert.ok(
          !release.has(name) || args.includes('--clobber'),
          'Batch assets must not be overwritten',
        );
        release.set(name, {
          name,
          id: state.nextId++,
          bytes: Buffer.from(bytes),
          digest: `sha256:${sha256(bytes)}`,
        });
      }
      if (files.length > 1) {
        if (state.corruptUploadedBatch)
          release.get(path.basename(files[0])).digest = 'sha256:wrong';
        if (state.changeHeadAfterUpload) state.head = 'b'.repeat(40);
      }
      return '';
    }
    if (args[0] === 'release' && args[1] === 'edit') return '';
    throw new Error(`Unexpected gh call: ${JSON.stringify(args)}`);
  };
  const publish = (overrides = {}) =>
    publishBundles({ ...options, gh, ...overrides });
  const index = (tag = 'upgrade-master') =>
    JSON.parse(state.releases.get(tag).get('latest.json').bytes);
  write();
  return { directory, state, options, write, publish, index };
}

test('publishes every platform and installer before advancing version and legacy master indexes', (t) => {
  const f = fixture(t);
  assert.equal(f.publish(), true);
  const index = f.index();
  assert.equal(index.version, '2.24.0');
  assert.equal(index.buildId, '100-1');
  assert.equal(index.sourceCommit, f.options.commit);
  assert.equal(Object.keys(index.packages).length, 13);
  assert.deepEqual(index, f.index('upgrade-v2.24.0'));
  const tag = 'upgrade-build-v2.24.0-100-1';
  assert.equal(f.state.releases.get(tag).size, 28);
  for (const entry of [...Object.values(index.packages), index.installer]) {
    const url = new URL(entry.url),
      filename = path.basename(url.pathname);
    assert.ok(url.pathname.includes(`/releases/download/${tag}/`));
    const bytes = f.state.releases.get(tag).get(filename).bytes;
    assert.equal(bytes.length, entry.size);
    assert.equal(sha256(bytes), entry.sha256);
  }
  const writes = f.state.calls.filter(
    (a) => a[0] === 'release' && a[1] === 'upload',
  );
  assert.deepEqual(
    writes.map((a) => a[2]),
    [tag, 'upgrade-v2.24.0', 'upgrade-master'],
  );
  assert.ok(writes.slice(1).every((a) => a.includes('--clobber')));
});

for (const sameCommit of [false, true])
  test(`same-version replacement updates both indexes and retains in-flight downloads (${
    sameCommit ? 'same commit rerun' : 'new commit'
  })`, (t) => {
    const f = fixture(t);
    f.publish();
    const before = f.index();
    const oldAssets = new Map(
      Array.from(
        f.state.releases.get('upgrade-build-v2.24.0-100-1'),
        ([name, a]) => [name, a.bytes.toString('base64')],
      ),
    );
    const commit = sameCommit ? f.options.commit : 'b'.repeat(40);
    f.state.head = commit;
    f.write(commit, 'replacement');
    assert.equal(f.publish({ commit, buildId: '100-2' }), true);
    const after = f.index();
    assert.equal(after.version, before.version);
    assert.equal(after.buildId, '100-2');
    assert.equal(after.sourceCommit, commit);
    assert.deepEqual(after, f.index('upgrade-v2.24.0'));
    for (const target of platforms) {
      assert.notEqual(after.packages[target].url, before.packages[target].url);
      assert.notEqual(
        after.packages[target].sha256,
        before.packages[target].sha256,
      );
    }
    assert.notEqual(after.installer.url, before.installer.url);
    assert.notEqual(after.installer.sha256, before.installer.sha256);
    assert.deepEqual(
      new Map(
        Array.from(
          f.state.releases.get('upgrade-build-v2.24.0-100-1'),
          ([name, a]) => [name, a.bytes.toString('base64')],
        ),
      ),
      oldAssets,
    );
  });

test('retrying a publication is idempotent, but changed bytes require a new build ID', (t) => {
  const f = fixture(t);
  f.publish();
  const count = () =>
    f.state.calls.filter(
      (a) =>
        a[0] === 'release' &&
        a[1] === 'upload' &&
        a[2] === 'upgrade-build-v2.24.0-100-1',
    ).length;
  assert.equal(count(), 1);
  f.publish();
  assert.equal(count(), 1);
  f.write(f.options.commit, 'changed within the same attempt');
  assert.throws(() => f.publish(), /Immutable release asset differs/);
  assert.equal(f.index().buildId, '100-1');
});

for (const fault of ['missing', 'corrupt', 'wrong-version'])
  test(`incomplete, corrupt or wrong-version packages never publish (${fault})`, (t) => {
    const f = fixture(t);
    const archive = path.join(
      f.directory,
      `qinglong-${f.options.commit}-linux-armv6-glibc.tar.gz`,
    );
    if (fault === 'missing') fs.rmSync(archive);
    else if (fault === 'corrupt') fs.appendFileSync(archive, 'corrupt');
    else {
      const record = JSON.parse(fs.readFileSync(archive + '.json'));
      record.version = '2.23.0';
      fs.writeFileSync(archive + '.json', JSON.stringify(record));
    }
    assert.throws(() => f.publish(), /ENOENT|Unverified/);
    assert.equal(f.state.calls.length, 0);
  });

for (const fault of ['failBatchUpload', 'corruptUploadedBatch'])
  test(`failed batch publication keeps both existing indexes (${fault})`, (t) => {
    const f = fixture(t);
    f.publish();
    const previous = f.index();
    f.write(f.options.commit, 'next');
    f.state[fault] = true;
    assert.throws(
      () => f.publish({ buildId: '100-2' }),
      /Upload interrupted|Published platform bundle verification failed/,
    );
    assert.deepEqual(f.index(), previous);
    assert.deepEqual(f.index('upgrade-v2.24.0'), previous);
  });

test('stale commits do not publish; a source change during upload cannot advance indexes', (t) => {
  const f = fixture(t);
  f.publish();
  const before = f.index();
  f.state.head = 'b'.repeat(40);
  assert.equal(f.publish({ buildId: '101-1' }), false);
  assert.ok(!f.state.releases.has('upgrade-build-v2.24.0-101-1'));
  f.state.head = f.options.commit;
  f.state.changeHeadAfterUpload = true;
  assert.equal(f.publish({ buildId: '102-1' }), false);
  assert.deepEqual(f.index(), before);
  assert.deepEqual(f.index('upgrade-v2.24.0'), before);
});

test('an explicitly rerun earlier workflow may replace the same version and commit', (t) => {
  const f = fixture(t);
  f.publish({ buildId: '101-1' });
  const before = f.index();
  f.write(f.options.commit, 'rebuild from an earlier run');
  assert.equal(f.publish({ buildId: '100-2' }), true);
  assert.equal(f.index().buildId, '100-2');
  assert.deepEqual(f.index(), f.index('upgrade-v2.24.0'));
  assert.notEqual(
    f.index().packages[platforms[0]].sha256,
    before.packages[platforms[0]].sha256,
  );
});

test('non-master branches, invalid build IDs and API failures cannot overwrite published versions', (t) => {
  const f = fixture(t);
  for (const branch of ['develop', 'v2.24.0', 'feature/test'])
    assert.throws(() => f.publish({ branch }), /Only master/);
  for (const buildId of [undefined, '100', '100-1/other'])
    assert.throws(() => f.publish({ buildId }), /Invalid bundle build ID/);
  assert.throws(
    () => f.publish({ version: '../bad' }),
    /Invalid bundle version/,
  );
  assert.equal(f.state.calls.length, 0);
  f.publish();
  const before = f.index();
  f.state.lookupFailure = 'upgrade-v2.24.0';
  assert.throws(() => f.publish({ buildId: '100-2' }), /Unavailable/);
  assert.deepEqual(f.index(), before);
});

test('existing master clients can migrate from indexes without version/build metadata', (t) => {
  const f = fixture(t);
  f.publish();
  const asset = f.state.releases.get('upgrade-master').get('latest.json');
  const legacy = f.index();
  delete legacy.version;
  delete legacy.buildId;
  asset.bytes = Buffer.from(JSON.stringify(legacy));
  assert.equal(f.publish({ buildId: '100-2' }), true);
  assert.equal(f.index().buildId, '100-2');
});
