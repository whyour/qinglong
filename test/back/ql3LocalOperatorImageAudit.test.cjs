const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  auditLocalOperatorImageContract,
} = require('../../scripts/ql3-local-operator-image-audit.cjs');

const root = path.resolve(__dirname, '../..');

test('accepts the short-lived Local operator image contract', () => {
  const report = auditLocalOperatorImageContract(root);
  assert.equal(report.compatible, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.lifecycle, 'short-lived');
  assert.deepEqual(report.runtimePackages, [
    '@qinglong/ai',
    '@qinglong/local-admin',
    '@qinglong/local-command-file',
    '@qinglong/local-owner-cli',
    '@qinglong/local-owner-console',
    '@qinglong/local-secret',
    '@qinglong/local-sqlite',
    '@qinglong/runtime-core',
    'semver',
  ]);
});

test('rejects a long-lived network surface or mutable runtime base', () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-local-operator-audit-'),
  );
  try {
    fs.mkdirSync(path.join(temporaryRoot, 'deploy/containers'), {
      recursive: true,
    });
    fs.cpSync(
      path.join(root, 'deploy/containers/ql3-local-operator'),
      path.join(temporaryRoot, 'deploy/containers/ql3-local-operator'),
      { recursive: true },
    );
    fs.mkdirSync(path.join(temporaryRoot, '.github/workflows'), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(root, '.github/workflows/ql3-ci.yml'),
      path.join(temporaryRoot, '.github/workflows/ql3-ci.yml'),
    );
    fs.copyFileSync(
      path.join(root, 'ql3-release.json'),
      path.join(temporaryRoot, 'ql3-release.json'),
    );
    const dockerfilePath = path.join(
      temporaryRoot,
      'deploy/containers/ql3-local-operator/Dockerfile',
    );
    const dockerfile = fs
      .readFileSync(dockerfilePath, 'utf8')
      .replace(
        '@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436',
        '',
      )
      .concat('\nEXPOSE 5700\n');
    fs.writeFileSync(dockerfilePath, dockerfile);
    const report = auditLocalOperatorImageContract(temporaryRoot);
    assert.equal(report.compatible, false);
    assert.ok(
      report.findings.some(({ code }) => code === 'DOCKERFILE_CONTRACT_DRIFT'),
    );
    assert.ok(
      report.findings.some(
        ({ code }) => code === 'UNREVIEWED_RUNTIME_OR_BUILD_SURFACE',
      ),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('rejects removal of the fresh Owner journey or two-image manifest', () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-local-operator-ci-audit-'),
  );
  try {
    fs.mkdirSync(path.join(temporaryRoot, 'deploy/containers'), {
      recursive: true,
    });
    fs.cpSync(
      path.join(root, 'deploy/containers/ql3-local-operator'),
      path.join(temporaryRoot, 'deploy/containers/ql3-local-operator'),
      { recursive: true },
    );
    fs.mkdirSync(path.join(temporaryRoot, '.github/workflows'), {
      recursive: true,
    });
    const workflow = fs
      .readFileSync(path.join(root, '.github/workflows/ql3-ci.yml'), 'utf8')
      .replaceAll(
        'scripts/ql3-local-alpha-trial-kit-live-contract.cjs',
        'removed-live-contract.cjs',
      )
      .replace(
        'scripts/ql3-local-alpha-trial-kit-bundle.cjs',
        "schema: 'single-image'",
      );
    fs.writeFileSync(
      path.join(temporaryRoot, '.github/workflows/ql3-ci.yml'),
      workflow,
    );
    fs.copyFileSync(
      path.join(root, 'ql3-release.json'),
      path.join(temporaryRoot, 'ql3-release.json'),
    );
    const report = auditLocalOperatorImageContract(temporaryRoot);
    assert.equal(report.compatible, false);
    assert.ok(
      report.findings.some(
        ({ code }) => code === 'LOCAL_OPERATOR_CI_CONTRACT_DRIFT',
      ),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
