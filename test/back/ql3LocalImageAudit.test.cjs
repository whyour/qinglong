const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  auditLocalImageContract,
} = require('../../scripts/ql3-local-image-audit.cjs');

const root = path.resolve(__dirname, '../..');
const source = path.join(root, 'deploy/containers/ql3-local-application');

function fixture() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-local-image-audit-'),
  );
  const target = path.join(
    temporaryRoot,
    'deploy/containers/ql3-local-application',
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  const workflowTarget = path.join(
    temporaryRoot,
    '.github/workflows/ql3-ci.yml',
  );
  fs.mkdirSync(path.dirname(workflowTarget), { recursive: true });
  fs.copyFileSync(
    path.join(root, '.github/workflows/ql3-ci.yml'),
    workflowTarget,
  );
  return {
    root: temporaryRoot,
    target,
    close() {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
}

test('accepts the exact AI-excluded local application image contract', () => {
  const report = auditLocalImageContract(root);
  assert.equal(report.compatible, true);
  assert.deepEqual(report.findings, []);
  assert.equal(
    report.nodeImage,
    'node:24.18.0-alpine3.23@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436',
  );
  assert.equal(
    report.buildNodeImage,
    'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d',
  );
  assert.deepEqual(report.runtimePackages, [
    '@qinglong/local-admin',
    '@qinglong/local-application',
    '@qinglong/local-command-file',
    '@qinglong/local-execution',
    '@qinglong/local-process',
    '@qinglong/local-secret',
    '@qinglong/local-sqlite',
    '@qinglong/runtime-core',
    'croner',
    'semver',
  ]);
});

test('rejects a mutable runtime base image', () => {
  const current = fixture();
  try {
    const dockerfilePath = path.join(current.target, 'Dockerfile');
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    fs.writeFileSync(
      dockerfilePath,
      dockerfile.replace(
        '@sha256:595398b0081eacda8e1c4c5b97b76cd1020e4d58a8ebcb4843b9bca1e79e7436',
        '',
      ),
    );
    const report = auditLocalImageContract(current.root);
    assert.equal(report.compatible, false);
    assert.ok(
      report.findings.some(
        ({ code }) => code === 'BASE_IMAGE_NOT_EXACTLY_PINNED',
      ),
    );
  } finally {
    current.close();
  }
});

test('rejects a mutable or build-argument-controlled base image', () => {
  const current = fixture();
  try {
    const dockerfilePath = path.join(current.target, 'Dockerfile');
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    fs.writeFileSync(
      dockerfilePath,
      `ARG NODE_IMAGE=node:24-bookworm-slim\n${dockerfile.replaceAll(
        /node:24\.18\.0-bookworm-slim@sha256:[0-9a-f]{64}/g,
        '${NODE_IMAGE}',
      )}`,
    );
    const report = auditLocalImageContract(current.root);
    assert.equal(report.compatible, false);
    assert.ok(
      report.findings.some(
        ({ code }) => code === 'BASE_IMAGE_NOT_EXACTLY_PINNED',
      ),
    );
    assert.ok(
      report.findings.some(
        ({ code }) => code === 'BASE_IMAGE_OVERRIDE_AUTHORITY',
      ),
    );
  } finally {
    current.close();
  }
});

test('rejects AI or an unreviewed dependency in the runtime closure', () => {
  const current = fixture();
  try {
    const dockerfilePath = path.join(current.target, 'Dockerfile');
    fs.appendFileSync(
      dockerfilePath,
      '\nCOPY --from=workspace /workspace/packages/ql3-ai/dist node_modules/@qinglong/ai/dist\n',
    );
    const runtimeManifestPath = path.join(
      current.target,
      'runtime-dependencies/package.json',
    );
    const runtimeManifest = JSON.parse(
      fs.readFileSync(runtimeManifestPath, 'utf8'),
    );
    runtimeManifest.dependencies['drizzle-orm'] = '1.0.0-rc.4';
    fs.writeFileSync(
      runtimeManifestPath,
      `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    );
    const report = auditLocalImageContract(current.root);
    assert.equal(report.compatible, false);
    assert.ok(
      report.findings.some(
        ({ code }) => code === 'AI_PRESENT_IN_RUNTIME_STAGE',
      ),
    );
    assert.ok(
      report.findings.some(({ code }) => code === 'RUNTIME_DEPENDENCY_DRIFT'),
    );
  } finally {
    current.close();
  }
});

test('rejects retaining npm bin links, debug maps or declarations in the production image', () => {
  const current = fixture();
  try {
    const dockerfilePath = path.join(current.target, 'Dockerfile');
    const dockerfile = fs
      .readFileSync(dockerfilePath, 'utf8')
      .replace(
        'RUN rm -rf node_modules/.bin \\\n' +
          '  && node /tmp/ql3-prune-runtime-artifact.cjs node_modules/@qinglong \\\n' +
          '    @qinglong/local-application \\\n' +
          '    @qinglong/local-application/process \\\n' +
          '    @qinglong/local-application/plugin-package-recovery-catalog \\\n' +
          '    --exclude=@qinglong/ai \\\n' +
          '  && rm /tmp/ql3-prune-runtime-artifact.cjs\n\n',
        '',
      );
    fs.writeFileSync(dockerfilePath, dockerfile);
    const report = auditLocalImageContract(current.root);
    assert.equal(report.compatible, false);
    assert.ok(
      report.findings.some(
        ({ code }) => code === 'RUNTIME_NONESSENTIAL_FILES_NOT_REMOVED',
      ),
    );
  } finally {
    current.close();
  }
});

test('rejects removal of the SQLite rollout compatibility labels', () => {
  const current = fixture();
  try {
    const dockerfilePath = path.join(current.target, 'Dockerfile');
    const dockerfile = fs
      .readFileSync(dockerfilePath, 'utf8')
      .replace('  io.qinglong.local.sqlite-write-contract="50" \\\n', '');
    fs.writeFileSync(dockerfilePath, dockerfile);
    const report = auditLocalImageContract(current.root);
    assert.equal(report.compatible, false);
    assert.ok(
      report.findings.some(
        ({ code }) => code === 'RUNTIME_IDENTITY_OR_LABEL_DRIFT',
      ),
    );
  } finally {
    current.close();
  }
});

test('rejects runtime lifecycle scripts or closure lock drift', () => {
  const current = fixture();
  try {
    const lockPath = path.join(
      current.target,
      'runtime-dependencies/package-lock.json',
    );
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.packages['node_modules/croner'].hasInstallScript = true;
    lock.packages['node_modules/unreviewed'] = {
      version: '1.0.0',
      resolved: 'file:../unreviewed',
      integrity: 'sha512-invalid',
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const report = auditLocalImageContract(current.root);
    assert.equal(report.compatible, false);
    assert.ok(
      report.findings.some(({ code }) => code === 'LOCKED_PACKAGE_UNSAFE'),
    );
    assert.ok(
      report.findings.some(({ code }) => code === 'RUNTIME_LOCK_CLOSURE_DRIFT'),
    );
  } finally {
    current.close();
  }
});

test('rejects removal of either Profile from the native image CI gate', () => {
  const current = fixture();
  try {
    const workflowPath = path.join(
      current.root,
      '.github/workflows/ql3-ci.yml',
    );
    const workflow = fs
      .readFileSync(workflowPath, 'utf8')
      .replace(
        '          node scripts/ql3-local-image-live-contract.cjs --image="${IMAGE}" --profile=standalone\n',
        '',
      );
    fs.writeFileSync(workflowPath, workflow);
    const report = auditLocalImageContract(current.root);
    assert.equal(report.compatible, false);
    assert.ok(
      report.findings.some(
        ({ code }) => code === 'LOCAL_IMAGE_CI_CONTRACT_DRIFT',
      ),
    );
  } finally {
    current.close();
  }
});
