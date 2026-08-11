const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  cleanQingLong3PackageArtifacts,
} = require('../../scripts/ql3-clean-package-artifacts.cjs');

test('removes dist and paired emitted source files only from QL3 importers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-clean-artifacts-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  const registeredPackage = path.join(root, 'packages/ql3-runtime-core');
  const unregisteredPackage = path.join(root, 'packages/ql3-stale-package');
  const legacyPackage = path.join(root, 'packages/legacy-package');
  for (const packageDirectory of [
    registeredPackage,
    unregisteredPackage,
    legacyPackage,
  ]) {
    fs.mkdirSync(path.join(packageDirectory, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageDirectory, 'dist/stale.js'), 'stale');
    fs.writeFileSync(path.join(packageDirectory, 'source.ts'), 'source');
  }
  fs.writeFileSync(path.join(registeredPackage, 'package.json'), '{}');
  fs.writeFileSync(path.join(legacyPackage, 'package.json'), '{}');
  fs.mkdirSync(path.join(registeredPackage, 'src/nested'), { recursive: true });
  fs.writeFileSync(path.join(registeredPackage, 'src/nested/example.ts'), '');
  for (const suffix of ['js', 'js.map', 'd.ts', 'd.ts.map']) {
    fs.writeFileSync(
      path.join(registeredPackage, `src/nested/example.${suffix}`),
      'emitted',
    );
  }
  fs.writeFileSync(
    path.join(registeredPackage, 'src/nested/intentional.js'),
    'module.exports = {};',
  );

  assert.deepEqual(cleanQingLong3PackageArtifacts(root), [
    'packages/ql3-runtime-core/dist',
  ]);
  assert.equal(fs.existsSync(path.join(registeredPackage, 'dist')), false);
  assert.equal(fs.existsSync(path.join(registeredPackage, 'source.ts')), true);
  assert.equal(
    fs.existsSync(path.join(registeredPackage, 'src/nested/example.ts')),
    true,
  );
  for (const suffix of ['js', 'js.map', 'd.ts', 'd.ts.map']) {
    assert.equal(
      fs.existsSync(
        path.join(registeredPackage, `src/nested/example.${suffix}`),
      ),
      false,
    );
  }
  assert.equal(
    fs.existsSync(path.join(registeredPackage, 'src/nested/intentional.js')),
    true,
  );
  assert.equal(fs.existsSync(path.join(unregisteredPackage, 'dist')), true);
  assert.equal(fs.existsSync(path.join(legacyPackage, 'dist')), true);
});
