const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  createQingLong3PackageClosureBuildPlan,
  resolveQingLong3Package,
} = require('../../scripts/ql3-build-package-closure.cjs');

function fixture(t, directoryName = 'ql3-example', name = '@qinglong/example') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-build-closure-'));
  const packageDirectory = path.join(root, 'packages', directoryName);
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({ name, scripts: { build: 'tsc -p tsconfig.json' } }),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { packageDirectory, root };
}

test('builds one package and its workspace dependency closure in topology order', (t) => {
  const { packageDirectory, root } = fixture(t);
  assert.deepEqual(resolveQingLong3Package(root, packageDirectory), {
    name: '@qinglong/example',
    packageDirectory,
  });
  const plan = createQingLong3PackageClosureBuildPlan(root, packageDirectory);
  assert.deepEqual(plan.args, [
    '-r',
    '--workspace-concurrency=1',
    '--filter',
    '@qinglong/example...',
    'run',
    'build',
  ]);
  assert.equal(plan.cwd, root);
});

test('rejects package escapes, non-QL3 directories and recursive builds', (t) => {
  const valid = fixture(t);
  assert.throws(
    () => resolveQingLong3Package(valid.root, valid.root),
    /cwd must be one direct packages\/ql3-\* directory/,
  );

  const legacy = fixture(t, 'legacy-example');
  assert.throws(
    () => resolveQingLong3Package(legacy.root, legacy.packageDirectory),
    /cwd must be one direct packages\/ql3-\* directory/,
  );

  const recursive = fixture(t, 'ql3-recursive', '@qinglong/recursive');
  const manifestPath = path.join(recursive.packageDirectory, 'package.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      name: '@qinglong/recursive',
      scripts: { build: 'pnpm --filter @qinglong/example build && tsc' },
    }),
  );
  assert.throws(
    () => resolveQingLong3Package(recursive.root, recursive.packageDirectory),
    /build must compile only itself/,
  );
});
