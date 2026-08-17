'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ARTIFACT_TYPE,
  FILE_MEDIA_TYPE,
  OCI_EMPTY_CONFIG_DIGEST,
  OCI_EMPTY_CONFIG_MEDIA_TYPE,
  OCI_MANIFEST_MEDIA_TYPE,
  createCatalogPlan,
} = require('../../scripts/ql3-release-catalog-contract.cjs');
const {
  auditClusterImageCiWorkflow,
} = require('../../scripts/ql3-cluster-image-release-audit.cjs');
const {
  privateReleaseEvidenceReceipts,
} = require('./ql3ReleaseEvidenceFixture.cjs');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(
  ROOT,
  'scripts/ql3-release-catalog-consumption-ceremony.cjs',
);
const VERSION = '3.0.0-alpha.0';
const REVISION = 'a'.repeat(40);
const SOURCE_REF = `refs/tags/v${VERSION}`;
const OWNER = 'example';
const SOURCE_REPOSITORY = `${OWNER}/qinglong`;
const TOKEN = 'github_pat_catalog_consumption_fixture';

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function selectedImages(scope) {
  const cluster = [
    ['control', 'qinglong3-cluster-control'],
    ['control-ai', 'qinglong3-cluster-control-ai'],
    ['admin', 'qinglong3-cluster-admin'],
    ['worker', 'qinglong3-worker'],
  ];
  const local = [['local', 'qinglong3-local-application']];
  return scope === 'local'
    ? local
    : scope === 'cluster'
    ? cluster
    : [...cluster, ...local];
}

function releaseSet(scope) {
  const selected = selectedImages(scope);
  const release = {
    version: VERSION,
    sourceRevision: REVISION,
    sourceRef: SOURCE_REF,
    scope,
  };
  const images = selected.map(([name, repository], index) => {
    const digest = `sha256:${(index + 1).toString(16).repeat(64)}`;
    const reference = `ghcr.io/${OWNER}/${repository}`;
    return {
      name,
      repository,
      digest,
      reference: `${reference}@${digest}`,
      versionTag: `${reference}:${VERSION}`,
      sourceTag: `${reference}:sha-${REVISION}`,
      platforms: ['linux/amd64', 'linux/arm64'],
      imageRecordDigest: `sha256:${(index + 6).toString(16).repeat(64)}`,
    };
  });
  const names = images.map((entry) => entry.name);
  const unsigned = {
    schemaVersion: 1,
    schema: 'qinglong/release-set@v3',
    release,
    candidate: {
      schema: 'qinglong/release-candidate-contract@v1',
      contractDigest: `sha256:${'b'.repeat(64)}`,
    },
    repositoryOwner: OWNER,
    platforms: ['linux/amd64', 'linux/arm64'],
    deploymentFamilies: {
      local: {
        selected: ['local', 'all'].includes(scope),
        profiles: ['edge', 'standalone'],
        images: names.filter((name) => name === 'local'),
      },
      cluster: {
        selected: ['cluster', 'all'].includes(scope),
        profiles: ['cluster', 'worker-edge', 'worker-node'],
        images: names.filter((name) => name !== 'local'),
      },
    },
    evidenceReceipts: privateReleaseEvidenceReceipts(release),
    images,
    promotion: {
      authority: 'complete_verified_release_set',
      versionTags: 'promote_after_complete_set_audit',
      sourceTags: 'promote_after_complete_set_audit',
      crossRepositoryAtomicity: false,
      recovery: 'verify_exact_digest_then_continue',
    },
    requiredVerification: {
      imageKeylessSignature: true,
      imageAttestations: [
        'github-provenance',
        'cyclonedx-sbom',
        'os-vulnerability',
        'release-candidate-contract',
      ],
      privateReleaseEvidenceReceipts:
        scope === 'local'
          ? []
          : ['worker-management', 'cloudnativepg-disaster-recovery'],
      releaseSetBuildProvenance: true,
    },
  };
  return { ...unsigned, releaseSetDigest: sha256(JSON.stringify(unsigned)) };
}

function catalogManifest(value, scope) {
  const identity = {
    version: VERSION,
    sourceRevision: REVISION,
    sourceRef: SOURCE_REF,
    releaseScope: scope,
    repositoryOwner: OWNER,
    sourceRepository: SOURCE_REPOSITORY,
  };
  const plan = createCatalogPlan(value, identity);
  return {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST_MEDIA_TYPE,
    artifactType: ARTIFACT_TYPE,
    config: {
      mediaType: OCI_EMPTY_CONFIG_MEDIA_TYPE,
      digest: OCI_EMPTY_CONFIG_DIGEST,
      size: 2,
    },
    layers: [
      {
        mediaType: FILE_MEDIA_TYPE,
        digest: plan.releaseSet.contentDigest,
        size: plan.releaseSet.bytes,
        annotations: {
          'org.opencontainers.image.title': plan.releaseSet.fileName,
        },
      },
    ],
    annotations: { ...plan.catalog.annotations },
  };
}

function fixture(t, options = {}) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-catalog-consumption-')),
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scope = options.scope || 'local';
  const release = releaseSet(scope);
  const releaseText = options.nonCanonicalRelease
    ? `${JSON.stringify(release, null, 2)}\n`
    : `${JSON.stringify(release)}\n`;
  const manifest = catalogManifest(release, scope);
  const manifestText = JSON.stringify(manifest);
  const manifestDigest = sha256(Buffer.from(manifestText, 'utf8'));
  const changedDigest = `sha256:${'f'.repeat(64)}`;
  const capture = path.join(directory, 'calls.jsonl');
  const state = path.join(directory, 'state');
  const tokenFile = path.join(directory, 'github-token');
  const outputDirectory = path.join(directory, 'bundle');
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  const tools = {};
  for (const name of ['regctl', 'cosign', 'gh']) {
    const tool = path.join(directory, name);
    let behavior = '';
    if (name === 'regctl') {
      behavior = `
if (args[0] === 'image' && args[1] === 'digest') {
  const count = fs.existsSync(${JSON.stringify(
    state,
  )}) ? Number(fs.readFileSync(${JSON.stringify(state)}, 'utf8')) : 0;
  fs.writeFileSync(${JSON.stringify(state)}, String(count + 1));
  const digest = count > 0 && ${JSON.stringify(
    Boolean(options.changeDiscovery),
  )} ? ${JSON.stringify(changedDigest)} : ${JSON.stringify(manifestDigest)};
  process.stdout.write(digest + '\\n');
  if (count === 0 && ${JSON.stringify(Boolean(options.mutateCosign))}) {
    fs.appendFileSync(${JSON.stringify(path.join(directory, 'cosign'))}, '\\n');
  }
} else if (args[0] === 'artifact' && args[1] === 'get') {
  process.stdout.write(${JSON.stringify(releaseText)});
} else if (args[0] === 'manifest' && args[1] === 'get') {
  process.stdout.write(${JSON.stringify(
    options.manifestDrift ? `${manifestText} ` : manifestText,
  )});
} else {
  process.exitCode = 7;
}
`;
    } else {
      behavior = `
process.stdout.write(JSON.stringify({ verified: true, tool: name }) + '\\n');
if (name === 'cosign' && ${JSON.stringify(Boolean(options.cosignFailure))}) {
  process.exitCode = 9;
}
`;
    }
    const source = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(
      capture,
    )}, JSON.stringify({ name, args, tokenPresent: process.env.GH_TOKEN === ${JSON.stringify(
      TOKEN,
    )} }) + '\\n');
${behavior}
`;
    fs.writeFileSync(tool, source, { mode: 0o700 });
    tools[name] = tool;
  }
  return {
    capture,
    directory,
    manifestDigest,
    outputDirectory,
    release,
    scope,
    tokenFile,
    tools,
  };
}

function createArguments(value) {
  return [
    '--mode=create',
    `--version=${VERSION}`,
    `--source-revision=${REVISION}`,
    `--source-ref=${SOURCE_REF}`,
    `--release-scope=${value.scope}`,
    `--repository-owner=${OWNER}`,
    `--source-repository=${SOURCE_REPOSITORY}`,
    `--regctl=${value.tools.regctl}`,
    `--cosign=${value.tools.cosign}`,
    `--gh=${value.tools.gh}`,
    `--github-token-file=${value.tokenFile}`,
    `--output-directory=${value.outputDirectory}`,
  ];
}

function auditArguments(value) {
  return [
    '--mode=audit',
    `--version=${VERSION}`,
    `--source-revision=${REVISION}`,
    `--source-ref=${SOURCE_REF}`,
    `--release-scope=${value.scope}`,
    `--repository-owner=${OWNER}`,
    `--source-repository=${SOURCE_REPOSITORY}`,
    `--output-directory=${value.outputDirectory}`,
  ];
}

function invoke(arguments_) {
  return spawnSync(process.execPath, [SCRIPT, ...arguments_], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {},
  });
}

function createAndAudit(value) {
  const created = invoke(createArguments(value));
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.stderr, '');
  const audited = invoke(auditArguments(value));
  assert.equal(audited.status, 0, audited.stderr);
  assert.equal(audited.stderr, '');
  return {
    created: JSON.parse(created.stdout),
    audited: JSON.parse(audited.stdout),
  };
}

test('consumes one immutable catalog into an auditable no-replace bundle', (t) => {
  const value = fixture(t);
  const result = createAndAudit(value);
  assert.equal(result.created.compatible, true);
  assert.equal(result.audited.compatible, true);
  assert.equal(result.audited.releaseScope, 'local');
  assert.equal(
    result.created.immutableReference,
    `ghcr.io/${OWNER}/qinglong3-release-catalog@${value.manifestDigest}`,
  );

  assert.equal(fs.statSync(value.outputDirectory).mode & 0o777, 0o700);
  const names = fs.readdirSync(value.outputDirectory).sort();
  assert.deepEqual(names, [
    `qinglong3-release-catalog-consumption-${VERSION}-local.json`,
    `qinglong3-release-catalog-manifest-${VERSION}-local.json`,
    `qinglong3-release-set-${VERSION}-local.json`,
  ]);
  for (const name of names) {
    assert.equal(
      fs.statSync(path.join(value.outputDirectory, name)).mode & 0o777,
      0o600,
    );
  }
  const report = fs.readFileSync(
    path.join(
      value.outputDirectory,
      `qinglong3-release-catalog-consumption-${VERSION}-local.json`,
    ),
    'utf8',
  );
  assert.equal(report.includes(TOKEN), false);
  const parsed = JSON.parse(report);
  assert.equal(
    parsed.schema,
    'qinglong/release-catalog-consumption-ceremony@v1',
  );
  assert.equal(parsed.verification.discoveryResolvedTwice, true);
  assert.equal(parsed.verification.catalogReceiptReconstructed, true);
  assert.equal(parsed.claims.deploymentMutation, false);
  assert.equal(
    parsed.claims.workstationFileWrites,
    'private_temporary_only_plus_final_bundle',
  );
  assert.equal(parsed.steps.length, 6);
  assert.equal(
    fs
      .readdirSync(value.directory)
      .some((name) => name.startsWith('.ql3-release-catalog-consumption-')),
    false,
  );

  const calls = fs
    .readFileSync(value.capture, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((entry) => entry.name),
    ['regctl', 'cosign', 'gh', 'regctl', 'regctl', 'regctl'],
  );
  assert.deepEqual(
    calls.map((entry) => entry.tokenPresent),
    [false, false, true, false, false, false],
  );
  assert.deepEqual(calls[0].args, [
    'image',
    'digest',
    `ghcr.io/${OWNER}/qinglong3-release-catalog:v${VERSION}-local`,
  ]);
  assert.ok(calls[1].args.includes(parsed.workflowIdentity));
  assert.ok(calls[2].args.includes('--deny-self-hosted-runners'));
  assert.deepEqual(calls[3].args.slice(0, 4), [
    'artifact',
    'get',
    '--file',
    `qinglong3-release-set-${VERSION}-local.json`,
  ]);
});

test('supports the complete all-scope image family without runtime coupling', (t) => {
  const value = fixture(t, { scope: 'all' });
  createAndAudit(value);
  const report = JSON.parse(
    fs.readFileSync(
      path.join(
        value.outputDirectory,
        `qinglong3-release-catalog-consumption-${VERSION}-all.json`,
      ),
      'utf8',
    ),
  );
  assert.deepEqual(report.releaseSet.images, [
    'control',
    'control-ai',
    'admin',
    'worker',
    'local',
  ]);
  assert.equal(report.releaseSet.imageCount, 5);
  assert.equal(report.claims.deploymentMutation, false);
});

test('fails before publication when discovery changes during verification', (t) => {
  const value = fixture(t, { changeDiscovery: true });
  const result = invoke(createArguments(value));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /catalog discovery changed/);
  assert.equal(fs.existsSync(value.outputDirectory), false);
});

test('rejects non-canonical release sets and mismatched raw manifests', async (t) => {
  await t.test('release set', () => {
    const value = fixture(t, { nonCanonicalRelease: true });
    const result = invoke(createArguments(value));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /canonical JSON/);
    assert.equal(fs.existsSync(value.outputDirectory), false);
  });
  await t.test('manifest', () => {
    const value = fixture(t, { manifestDrift: true });
    const result = invoke(createArguments(value));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /catalog manifest digest/);
    assert.equal(fs.existsSync(value.outputDirectory), false);
  });
});

test('rejects external verification failure and executable mutation', async (t) => {
  await t.test('cosign failure', () => {
    const value = fixture(t, { cosignFailure: true });
    const result = invoke(createArguments(value));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /keyless_signature/);
    assert.equal(fs.existsSync(value.outputDirectory), false);
  });
  await t.test('tool mutation', () => {
    const value = fixture(t, { mutateCosign: true });
    const result = invoke(createArguments(value));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /executable changed/);
    assert.equal(fs.existsSync(value.outputDirectory), false);
  });
});

test('offline audit detects every durable bundle drift surface', async (t) => {
  for (const [name, mutate] of [
    [
      'release set',
      (value) => {
        const file = path.join(
          value.outputDirectory,
          `qinglong3-release-set-${VERSION}-local.json`,
        );
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        parsed.images[0].digest = `sha256:${'e'.repeat(64)}`;
        fs.writeFileSync(file, `${JSON.stringify(parsed)}\n`);
      },
    ],
    [
      'manifest',
      (value) => {
        fs.appendFileSync(
          path.join(
            value.outputDirectory,
            `qinglong3-release-catalog-manifest-${VERSION}-local.json`,
          ),
          ' ',
        );
      },
    ],
    [
      'report',
      (value) => {
        const file = path.join(
          value.outputDirectory,
          `qinglong3-release-catalog-consumption-${VERSION}-local.json`,
        );
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        parsed.claims.deploymentMutation = true;
        fs.writeFileSync(file, `${JSON.stringify(parsed)}\n`);
      },
    ],
    [
      'extra file',
      (value) => {
        fs.writeFileSync(path.join(value.outputDirectory, 'unexpected'), 'x', {
          mode: 0o600,
        });
      },
    ],
  ]) {
    await t.test(name, () => {
      const value = fixture(t);
      createAndAudit(value);
      mutate(value);
      const audited = invoke(auditArguments(value));
      assert.notEqual(audited.status, 0);
    });
  }
});

test('rejects output reuse, public credentials, symlinks and open CLI shapes', async (t) => {
  await t.test('no replace', () => {
    const value = fixture(t);
    createAndAudit(value);
    const result = invoke(createArguments(value));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not already exist/);
  });
  await t.test('public token', () => {
    const value = fixture(t);
    fs.chmodSync(value.tokenFile, 0o644);
    const result = invoke(createArguments(value));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /owner-private/);
  });
  await t.test('symlink tool', () => {
    const value = fixture(t);
    const link = path.join(value.directory, 'linked');
    fs.symlinkSync(value.tools.regctl, link);
    const arguments_ = createArguments(value).map((argument) =>
      argument.startsWith('--regctl=') ? `--regctl=${link}` : argument,
    );
    const result = invoke(arguments_);
    assert.notEqual(result.status, 0);
  });
  await t.test('open arguments', () => {
    const value = fixture(t);
    const result = invoke([...createArguments(value), '--unknown=true']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /arguments are invalid/);
  });
});

test('supply-chain CI cannot silently remove the consumption ceremony tests', () => {
  const source = fs.readFileSync(
    path.join(ROOT, '.github/workflows/ql3-ci.yml'),
    'utf8',
  );
  const mutated = source.replace(
    'test/back/ql3ReleaseCatalogConsumptionCeremony.test.cjs',
    'test/back/release-catalog-consumption-removed.test.cjs',
  );
  assert.throws(
    () => auditClusterImageCiWorkflow(mutated),
    /catalog consumption ceremony/,
  );
});
