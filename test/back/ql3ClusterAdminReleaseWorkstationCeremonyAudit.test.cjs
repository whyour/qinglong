'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AUDIT_SCHEMA,
  auditReport,
} = require('../../scripts/ql3-cluster-admin-release-workstation-ceremony-audit.cjs');

const ROOT = path.resolve(__dirname, '../..');
const script = path.join(
  ROOT,
  'scripts/ql3-cluster-admin-release-workstation-ceremony-audit.cjs',
);
const image = `ghcr.io/example/qinglong3-cluster-admin@sha256:${'b'.repeat(
  64,
)}`;
const repository = 'example/qinglong';
const sourceRevision = 'c'.repeat(40);
const sourceRef = 'refs/tags/v3.0.0-alpha.1';
const emptyDigest =
  'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function resign(report) {
  const unsigned = {};
  for (const [key, value] of Object.entries(report)) {
    if (key !== 'contentDigest') unsigned[key] = value;
  }
  report.contentDigest = digest(Buffer.from(canonicalize(unsigned), 'utf8'));
  return report;
}

function validReport() {
  const toolDigest = {
    cosign: `sha256:${'1'.repeat(64)}`,
    gh: `sha256:${'2'.repeat(64)}`,
    docker: `sha256:${'3'.repeat(64)}`,
  };
  const definitions = [
    ['keyless_signature', 'cosign'],
    ['provenance_attestation', 'gh'],
    ['cyclonedx_sbom_attestation', 'gh'],
    ['os_vulnerability_attestation', 'gh'],
    ['immutable_image_pull', 'docker'],
    ['local_digest_inspection', 'docker'],
    ['embedded_evidence_verifier', 'docker'],
  ];
  return resign({
    schema: 'qinglong/cluster-admin-release-workstation-ceremony@v1',
    schemaVersion: 1,
    observedAt: '2026-08-16T12:00:00.000Z',
    release: {
      image,
      repository,
      sourceRevision,
      sourceRef,
      workflowIdentity: `https://github.com/${repository}/.github/workflows/ql3-image-release.yml@${sourceRef}`,
    },
    tools: ['cosign', 'gh', 'docker'].map((name, index) => ({
      name,
      sha256: toolDigest[name],
      sizeBytes: 1000 + index,
    })),
    verification: {
      keylessSignature: true,
      provenance: true,
      cyclonedxSbom: true,
      osVulnerabilityEvidence: true,
      imagePulled: true,
      localRepoDigestBound: true,
      embeddedEvidenceVerifier: true,
    },
    evidenceVector: {
      schema: 'qinglong/cluster-console-redacted-evidence-bundle@v1',
      contentDigest: '4'.repeat(64),
      entryCount: 1,
      totalRawCanonicalBytes: 123,
      classification: 'synthetic_non_sensitive',
    },
    isolation: {
      network: 'none_for_embedded_verifier',
      readOnlyRoot: true,
      capabilities: 'none',
      noNewPrivileges: true,
      pids: 32,
      memoryBytes: 134217728,
      cpus: 0.25,
      verifierMutation: false,
      verifierFileWrites: false,
    },
    steps: definitions.map(([name, tool], index) => ({
      sequence: index + 1,
      name,
      tool,
      executableSha256: toolDigest[tool],
      argvSha256: `sha256:${'56789ab'[index].repeat(64)}`,
      stdoutBytes: index === 6 ? 400 : 0,
      stdoutSha256: index === 6 ? `sha256:${'d'.repeat(64)}` : emptyDigest,
      stderrBytes: 0,
      stderrSha256: emptyDigest,
      exitCode: 0,
    })),
    claims: {
      externalToolResults: 'exit_zero_with_digest_only_transcript',
      registryAvailability: 'observed_once',
      offlineAudit: 'structure_and_digest_only',
      workstationIdentityIncluded: false,
      credentialIncluded: false,
      reportAttestation: 'none',
      actionAuthority: 'none',
    },
  });
}

const expected = { image, repository, sourceRevision, sourceRef };

function fixture(t, report = validReport()) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-release-ceremony-audit-')),
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reportFile = path.join(directory, 'report.json');
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  return { directory, reportFile };
}

function args(reportFile, overrides = {}) {
  return [
    `--report=${reportFile}`,
    `--image=${overrides.image ?? image}`,
    `--repository=${repository}`,
    `--source-revision=${sourceRevision}`,
    `--source-ref=${sourceRef}`,
  ];
}

test('accepts a canonical digest-bound ceremony report without replay claims', (t) => {
  const report = validReport();
  assert.deepEqual(auditReport(report, expected), {
    compatible: true,
    reportContentDigest: report.contentDigest,
    releaseImage: image,
    verificationSteps: 7,
    externalResults: 'not_replayed',
    actionAuthority: 'none',
  });
  const value = fixture(t, report);
  const result = spawnSync(
    process.execPath,
    [script, ...args(value.reportFile)],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    schema: AUDIT_SCHEMA,
    compatible: true,
    reportContentDigest: report.contentDigest,
    releaseImage: image,
    verificationSteps: 7,
    externalResults: 'not_replayed',
    actionAuthority: 'none',
  });
});

test('rejects structural claim widening even after the report is re-digested', () => {
  for (const mutate of [
    (report) => {
      report.verification.provenance = false;
    },
    (report) => {
      report.claims.reportAttestation = 'verified';
    },
    (report) => {
      report.isolation.network = 'default';
    },
    (report) => {
      report.steps[6].stderrBytes = 1;
    },
    (report) => {
      report.secret = 'must-not-be-accepted';
    },
  ]) {
    const report = validReport();
    mutate(report);
    resign(report);
    assert.throws(
      () => auditReport(report, expected),
      /release workstation ceremony audit failed/i,
    );
  }
});

test('rejects report swapping, noncanonical encoding and symlinks', (t) => {
  const value = fixture(t);
  const swapped = spawnSync(
    process.execPath,
    [
      script,
      ...args(value.reportFile, {
        image: `ghcr.io/example/qinglong3-cluster-admin@sha256:${'a'.repeat(
          64,
        )}`,
      }),
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(swapped.status, 1);
  assert.equal(swapped.stdout, '');

  fs.writeFileSync(value.reportFile, JSON.stringify(validReport()), {
    mode: 0o600,
  });
  const noncanonical = spawnSync(
    process.execPath,
    [script, ...args(value.reportFile)],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(noncanonical.status, 1);

  const target = path.join(value.directory, 'target.json');
  fs.renameSync(value.reportFile, target);
  fs.symlinkSync(target, value.reportFile);
  const linked = spawnSync(
    process.execPath,
    [script, ...args(value.reportFile)],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  );
  assert.equal(linked.status, 1);
});
