'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const script = path.join(
  ROOT,
  'scripts/ql3-cluster-admin-release-workstation-ceremony.cjs',
);
const auditScript = path.join(
  ROOT,
  'scripts/ql3-cluster-admin-release-workstation-ceremony-audit.cjs',
);
const image = `ghcr.io/example/qinglong3-cluster-admin@sha256:${'b'.repeat(
  64,
)}`;
const repository = 'example/qinglong';
const revision = 'c'.repeat(40);
const sourceRef = 'refs/tags/v3.0.0-alpha.1';
const token = 'github_pat_ceremony_fixture_only';

function fixture(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-release-ceremony-')),
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const capture = path.join(directory, 'calls.jsonl');
  const tokenFile = path.join(directory, 'github-token');
  const output = path.join(directory, 'report.json');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const tools = {};
  for (const name of ['cosign', 'gh', 'docker']) {
    const tool = path.join(directory, name);
    const source = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(
      capture,
    )}, JSON.stringify({ name, args, tokenPresent: process.env.GH_TOKEN === ${JSON.stringify(
      token,
    )} }) + '\\n');
if (name === 'docker' && args[0] === 'image' && args[1] === 'inspect') {
  process.stdout.write(JSON.stringify([{ Os: 'linux', Architecture: 'arm64', RepoDigests: [${JSON.stringify(
    image,
  )}] }]));
} else if (name === 'docker' && args[0] === 'run') {
  const mount = args[args.indexOf('--mount') + 1];
  const sourceFile = mount.split(',').find((part) => part.startsWith('src=')).slice(4);
  const bundle = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  process.stdout.write(JSON.stringify({
    schema: 'qinglong/cluster-console-evidence-verification@v1',
    status: 'verified',
    bundle: {
      schema: bundle.schema,
      contentDigest: bundle.contentDigest,
      entryCount: bundle.source.entryCount,
      totalRawCanonicalBytes: bundle.source.totalRawCanonicalBytes,
    },
    integrity: { bundleDigest: 'verified', rawFactDigests: 'not_recomputed_without_raw_facts' },
    claims: { serverSignature: 'not_verified', attestation: 'not_verified', durableAudit: 'not_verified', actionAuthority: 'none' },
    execution: { networkAccess: false, mutation: false, fileWrites: false },
  }) + '\\n');
}
`;
    fs.writeFileSync(tool, source, { mode: 0o700 });
    tools[name] = tool;
  }
  return { capture, directory, output, tokenFile, tools };
}

function args(value) {
  return [
    `--image=${image}`,
    `--repository=${repository}`,
    `--source-revision=${revision}`,
    `--source-ref=${sourceRef}`,
    `--cosign=${value.tools.cosign}`,
    `--gh=${value.tools.gh}`,
    `--docker=${value.tools.docker}`,
    `--github-token-file=${value.tokenFile}`,
    `--output=${value.output}`,
  ];
}

function invoke(arguments_) {
  return spawnSync(process.execPath, [script, ...arguments_], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {},
  });
}

test('runs the immutable release ceremony and writes only digest-level evidence', (t) => {
  const value = fixture(t);
  const result = invoke(args(value));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.compatible, true);
  assert.match(output.contentDigest, /^sha256:[a-f0-9]{64}$/);

  const reportText = fs.readFileSync(value.output, 'utf8');
  const report = JSON.parse(reportText);
  assert.equal(
    report.schema,
    'qinglong/cluster-admin-release-workstation-ceremony@v1',
  );
  assert.equal(report.release.image, image);
  assert.equal(report.release.sourceRevision, revision);
  assert.equal(report.verification.embeddedEvidenceVerifier, true);
  assert.equal(report.evidenceVector.classification, 'synthetic_non_sensitive');
  assert.equal(report.steps.length, 7);
  assert.equal(report.claims.reportAttestation, 'none');
  assert.equal(reportText.includes(token), false);
  assert.equal(fs.statSync(value.output).mode & 0o777, 0o600);
  assert.equal(
    fs
      .readdirSync(value.directory)
      .some((name) => name.startsWith('.ql3-admin-release-ceremony-')),
    false,
  );

  const calls = fs
    .readFileSync(value.capture, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map(({ name }) => name),
    ['cosign', 'gh', 'gh', 'gh', 'docker', 'docker', 'docker'],
  );
  assert.deepEqual(
    calls.map(({ tokenPresent }) => tokenPresent),
    [false, true, true, true, false, false, false],
  );
  assert.deepEqual(calls[0].args, [
    'verify',
    '--certificate-identity',
    `https://github.com/${repository}/.github/workflows/ql3-image-release.yml@${sourceRef}`,
    '--certificate-oidc-issuer',
    'https://token.actions.githubusercontent.com',
    image,
  ]);
  for (const call of calls.slice(1, 4)) {
    for (const required of [
      'attestation',
      'verify',
      `oci://${image}`,
      '--repo',
      repository,
      '--signer-workflow',
      `${repository}/.github/workflows/ql3-image-release.yml`,
      '--source-digest',
      revision,
      '--source-ref',
      sourceRef,
      '--deny-self-hosted-runners',
      '--bundle-from-oci',
    ]) {
      assert.ok(call.args.includes(required));
    }
  }
  assert.equal(calls[1].args.includes('--predicate-type'), false);
  assert.ok(calls[2].args.includes('https://cyclonedx.org/bom'));
  assert.ok(
    calls[3].args.includes(
      'https://qinglong.dev/attestations/image-os-vulnerability/v1',
    ),
  );
  const dockerRun = calls[6].args;
  for (const required of [
    '--read-only',
    'none',
    'ALL',
    'no-new-privileges',
    '10001:10001',
    '32',
    '128m',
    '0.25',
    image,
    'evidence-verify',
    '--bundle=/evidence/bundle.json',
  ]) {
    assert.ok(dockerRun.includes(required));
  }

  const audit = spawnSync(
    process.execPath,
    [
      auditScript,
      `--report=${value.output}`,
      `--image=${image}`,
      `--repository=${repository}`,
      `--source-revision=${revision}`,
      `--source-ref=${sourceRef}`,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).externalResults, 'not_replayed');
});

test('rejects mutable and source-unbound inputs before invoking tools', (t) => {
  const value = fixture(t);
  const base = args(value);
  for (const [prefix, replacement] of [
    ['--image=', '--image=ghcr.io/example/qinglong3-cluster-admin:latest'],
    ['--source-revision=', '--source-revision=short'],
    ['--source-ref=', '--source-ref=refs/heads/next'],
  ]) {
    const rejected = invoke(
      base.map((argument) =>
        argument.startsWith(prefix) ? replacement : argument,
      ),
    );
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
    assert.deepEqual(JSON.parse(rejected.stderr), {
      schemaVersion: 1,
      component: 'qinglong3-cluster-admin-release-workstation-ceremony',
      event: 'ceremony_failed',
    });
  }
  assert.equal(fs.existsSync(value.capture), false);
  assert.equal(fs.existsSync(value.output), false);
});

test('fails closed on tool failure and never replaces a report', (t) => {
  const value = fixture(t);
  fs.writeFileSync(
    value.tools.cosign,
    `#!${process.execPath}\nprocess.exit(19);\n`,
    { mode: 0o700 },
  );
  const failed = invoke(args(value));
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.equal(fs.existsSync(value.output), false);

  fs.writeFileSync(value.output, 'owner-data\n', { mode: 0o600 });
  const rejected = invoke(args(value));
  assert.equal(rejected.status, 1);
  assert.equal(fs.readFileSync(value.output, 'utf8'), 'owner-data\n');
});

test('rejects widened file authority and executable drift', (t) => {
  const value = fixture(t);
  fs.chmodSync(value.tokenFile, 0o644);
  const publicToken = invoke(args(value));
  assert.equal(publicToken.status, 1);
  assert.equal(fs.existsSync(value.capture), false);

  fs.chmodSync(value.tokenFile, 0o600);
  fs.chmodSync(value.tools.gh, 0o720);
  const writableTool = invoke(args(value));
  assert.equal(writableTool.status, 1);
  assert.equal(fs.existsSync(value.capture), false);

  fs.chmodSync(value.tools.gh, 0o700);
  fs.writeFileSync(
    value.tools.cosign,
    `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.argv[1],'\\n');\n`,
    { mode: 0o700 },
  );
  const driftedTool = invoke(args(value));
  assert.equal(driftedTool.status, 1);
  assert.equal(fs.existsSync(value.output), false);
});
