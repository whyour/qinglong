const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

function inspectEntrypoint(specifier) {
  const packageDirectory = path.resolve(__dirname, '..');
  const script = `
    const exported = require(${JSON.stringify(specifier)});
    const loaded = Object.keys(require.cache).map((file) => file.replaceAll('\\\\', '/'));
    process.stdout.write(JSON.stringify({
      hasStore: typeof exported.S3ClusterRemoteWorkerArtifactStore === 'function',
      loadedAwsSdk: loaded.some((file) => file.includes('/@aws-sdk/')),
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: packageDirectory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('default and production entrypoints do not load the S3 client', () => {
  for (const specifier of [
    '@qinglong/cluster-control',
    '@qinglong/cluster-control/production',
  ]) {
    const report = inspectEntrypoint(specifier);
    assert.equal(report.hasStore, false, specifier);
    assert.equal(report.loadedAwsSdk, false, specifier);
  }
});

test('S3 artifact store is reachable only through its explicit subpath', () => {
  const report = inspectEntrypoint(
    '@qinglong/cluster-control/s3-artifact-store',
  );
  assert.equal(report.hasStore, true);
  assert.equal(report.loadedAwsSdk, true);
});
