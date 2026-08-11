const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('public application, config, admission and route exports exclude migration and legacy modules', () => {
  const packageDirectory = path.resolve(__dirname, '..');
  const script = `
    const application = require('@qinglong/cluster-control/application');
    const config = require('@qinglong/cluster-control/config');
    const admission = require('@qinglong/cluster-control/admission');
    const routes = require('@qinglong/cluster-control/routes');
    const runRoutes = require('@qinglong/cluster-control/run-routes');
    const apiCredential = require('@qinglong/cluster-control/api-credential');
    const loaded = Object.keys(require.cache).map((file) => file.replaceAll('\\\\', '/'));
    process.stdout.write(JSON.stringify({
      hasStart: typeof application.startClusterControlApplication === 'function',
      hasConfig: typeof config.loadClusterControlConfig === 'function',
      hasAdmission: typeof admission.createClusterControlAdmissionPipeline === 'function',
      hasRoutes: typeof routes.createClusterControlRouteRegistry === 'function',
      hasRunReadRoute: typeof runRoutes.createClusterControlRunReadRoute === 'function',
      hasApiCredential: typeof apiCredential.createClusterControlApiCredentialAuthenticator === 'function',
      loaded,
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: packageDirectory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.hasStart, true);
  assert.equal(report.hasConfig, true);
  assert.equal(report.hasAdmission, true);
  assert.equal(report.hasRoutes, true);
  assert.equal(report.hasRunReadRoute, true);
  assert.equal(report.hasApiCredential, true);
  assert.equal(
    report.loaded.some(
      (file) =>
        file.includes('/back/') ||
        /\/ql3-cluster-postgres\/dist\/migrations\/pg-\d/.test(file) ||
        file.endsWith('/ql3-cluster-postgres/dist/migration/migrate.js') ||
        file.endsWith('/ql3-cluster-postgres/dist/migration/migration.js') ||
        file.endsWith('/ql3-cluster-postgres/dist/schema/schema.js'),
    ),
    false,
    report.loaded.join('\n'),
  );
});
