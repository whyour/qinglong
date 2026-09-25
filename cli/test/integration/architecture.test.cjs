const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = path.resolve(__dirname, '../../src');
function files(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory()
      ? files(file)
      : file.endsWith('.ts')
      ? [file]
      : [];
  });
}

test('shared, remote and internal dependencies respect their source boundaries', () => {
  for (const file of files(source)) {
    const owner = path.relative(source, file).split(path.sep)[0];
    const allowed = {
      shared: ['shared'],
      remote: ['remote', 'shared'],
      internal: ['internal', 'shared'],
    }[owner];
    if (!allowed) continue;
    const imports = ts.preProcessFile(
      fs.readFileSync(file, 'utf8'),
      true,
      true,
    ).importedFiles;
    for (const imported of imports) {
      if (!imported.fileName.startsWith('.')) continue;
      const target = path
        .relative(source, path.resolve(path.dirname(file), imported.fileName))
        .split(path.sep)[0];
      assert.ok(
        allowed.includes(target),
        `${path.relative(source, file)} imports ${imported.fileName}`,
      );
    }
  }
});

test('stable build aliases point to real modules and preserve exported entry functions', () => {
  const entries = require('../../scripts/entrypoints.cjs');
  for (const [name, entry] of Object.entries(entries)) {
    const alias = path.resolve(__dirname, '../../dist', name);
    const target = path.resolve(__dirname, '../../dist', entry.module);
    assert.ok(fs.statSync(alias).isFile(), name);
    assert.ok(fs.statSync(target).isFile(), entry.module);
    // Auto-starting entry modules are exercised through child-process integration tests.
    if (entry.method)
      assert.equal(
        require(alias)[entry.method],
        require(target)[entry.method],
        name,
      );
  }
});
