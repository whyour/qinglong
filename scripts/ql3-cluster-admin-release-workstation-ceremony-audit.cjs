#!/usr/bin/env node

'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const SCHEMA = 'qinglong/cluster-admin-release-workstation-ceremony@v1';
const AUDIT_SCHEMA =
  'qinglong/cluster-admin-release-workstation-ceremony-audit@v1';
const CONTROL = /[\u0000-\u001f\u007f]/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_REPORT_BYTES = 512 * 1024;
const EMPTY_DIGEST =
  'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

class ReleaseWorkstationCeremonyAuditError extends Error {
  constructor(message) {
    super(
      `Cluster Admin release workstation ceremony audit failed: ${message}`,
    );
    this.name = 'ReleaseWorkstationCeremonyAuditError';
  }
}

function fail(message) {
  throw new ReleaseWorkstationCeremonyAuditError(message);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

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

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

function exactObject(value, keys, label) {
  if (!exactKeys(value, keys)) fail(`${label} shape is invalid`);
  return value;
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) {
      fail('arguments are invalid');
    }
    values[match[1]] = match[2];
  }
  const expected = [
    'report',
    'image',
    'repository',
    'source-revision',
    'source-ref',
  ];
  if (
    JSON.stringify(Object.keys(values).sort()) !==
    JSON.stringify(expected.sort())
  ) {
    fail('arguments are invalid');
  }
  return Object.freeze({
    reportFile: values.report,
    image: values.image,
    repository: values.repository,
    sourceRevision: values['source-revision'],
    sourceRef: values['source-ref'],
  });
}

function readReport(filePath) {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    filePath.length > 4096 ||
    CONTROL.test(filePath) ||
    path.normalize(filePath) !== filePath
  ) {
    fail('report path is invalid');
  }
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail('report is unavailable');
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > MAX_REPORT_BYTES ||
    fs.realpathSync(filePath) !== filePath ||
    typeof process.getuid !== 'function' ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  ) {
    fail('report must be one canonical owner-private bounded file');
  }
  let descriptor = -1;
  let bytes;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY |
        (fs.constants.O_CLOEXEC ?? 0) |
        (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.mode !== stat.mode ||
      opened.uid !== stat.uid ||
      opened.size !== stat.size
    ) {
      fail('report changed before open');
    }
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count < 1) fail('report read was incomplete');
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      fail('report changed while read');
    }
    let value;
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      fail('report must contain UTF-8 JSON');
    }
    if (`${JSON.stringify(value, null, 2)}\n` !== bytes.toString('utf8')) {
      fail('report encoding is not canonical');
    }
    return Object.freeze({ bytes, value });
  } catch (error) {
    if (bytes) bytes.fill(0);
    if (error instanceof ReleaseWorkstationCeremonyAuditError) throw error;
    fail('report could not be read safely');
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function validIsoTime(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function same(value, expected, label) {
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    fail(`${label} is invalid`);
  }
}

function validateRelease(value, expected) {
  exactObject(
    value,
    ['image', 'repository', 'sourceRevision', 'sourceRef', 'workflowIdentity'],
    'release',
  );
  const owner = expected.repository.split('/')[0];
  if (
    !/^[a-z0-9][a-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u.test(
      expected.repository,
    ) ||
    !new RegExp(
      `^ghcr\\.io/${owner}/qinglong3-cluster-admin@sha256:[a-f0-9]{64}$`,
      'u',
    ).test(expected.image) ||
    !/^[a-f0-9]{40}$/u.test(expected.sourceRevision) ||
    !/^refs\/tags\/v3\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/u.test(
      expected.sourceRef,
    )
  ) {
    fail('expected release identity is invalid');
  }
  const workflow = `${expected.repository}/.github/workflows/ql3-image-release.yml`;
  same(
    value,
    {
      image: expected.image,
      repository: expected.repository,
      sourceRevision: expected.sourceRevision,
      sourceRef: expected.sourceRef,
      workflowIdentity: `https://github.com/${workflow}@${expected.sourceRef}`,
    },
    'release identity',
  );
}

function auditReport(value, expected) {
  exactObject(
    value,
    [
      'schema',
      'schemaVersion',
      'observedAt',
      'release',
      'tools',
      'verification',
      'evidenceVector',
      'isolation',
      'steps',
      'claims',
      'contentDigest',
    ],
    'report',
  );
  if (
    value.schema !== SCHEMA ||
    value.schemaVersion !== 1 ||
    !validIsoTime(value.observedAt) ||
    typeof value.contentDigest !== 'string' ||
    !DIGEST.test(value.contentDigest)
  ) {
    fail('report identity is invalid');
  }
  validateRelease(value.release, expected);
  if (!Array.isArray(value.tools) || value.tools.length !== 3) {
    fail('tool evidence is invalid');
  }
  const expectedTools = ['cosign', 'gh', 'docker'];
  value.tools.forEach((tool, index) => {
    exactObject(tool, ['name', 'sha256', 'sizeBytes'], 'tool');
    if (
      tool.name !== expectedTools[index] ||
      typeof tool.sha256 !== 'string' ||
      !DIGEST.test(tool.sha256) ||
      !Number.isSafeInteger(tool.sizeBytes) ||
      tool.sizeBytes < 2 ||
      tool.sizeBytes > 256 * 1024 * 1024
    ) {
      fail('tool evidence is invalid');
    }
  });
  same(
    value.verification,
    {
      keylessSignature: true,
      provenance: true,
      cyclonedxSbom: true,
      osVulnerabilityEvidence: true,
      imagePulled: true,
      localRepoDigestBound: true,
      embeddedEvidenceVerifier: true,
    },
    'verification claims',
  );
  exactObject(
    value.evidenceVector,
    [
      'schema',
      'contentDigest',
      'entryCount',
      'totalRawCanonicalBytes',
      'classification',
    ],
    'evidence vector',
  );
  if (
    value.evidenceVector.schema !==
      'qinglong/cluster-console-redacted-evidence-bundle@v1' ||
    !/^[a-f0-9]{64}$/u.test(value.evidenceVector.contentDigest) ||
    value.evidenceVector.entryCount !== 1 ||
    !Number.isSafeInteger(value.evidenceVector.totalRawCanonicalBytes) ||
    value.evidenceVector.totalRawCanonicalBytes < 2 ||
    value.evidenceVector.totalRawCanonicalBytes > 8 * 1024 * 1024 ||
    value.evidenceVector.classification !== 'synthetic_non_sensitive'
  ) {
    fail('evidence vector is invalid');
  }
  same(
    value.isolation,
    {
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
    'verifier isolation',
  );
  const expectedSteps = [
    ['keyless_signature', 'cosign'],
    ['provenance_attestation', 'gh'],
    ['cyclonedx_sbom_attestation', 'gh'],
    ['os_vulnerability_attestation', 'gh'],
    ['immutable_image_pull', 'docker'],
    ['local_digest_inspection', 'docker'],
    ['embedded_evidence_verifier', 'docker'],
  ];
  if (
    !Array.isArray(value.steps) ||
    value.steps.length !== expectedSteps.length
  ) {
    fail('step evidence is invalid');
  }
  const toolDigests = Object.fromEntries(
    value.tools.map((tool) => [tool.name, tool.sha256]),
  );
  value.steps.forEach((step, index) => {
    exactObject(
      step,
      [
        'sequence',
        'name',
        'tool',
        'executableSha256',
        'argvSha256',
        'stdoutBytes',
        'stdoutSha256',
        'stderrBytes',
        'stderrSha256',
        'exitCode',
      ],
      'step',
    );
    const [name, tool] = expectedSteps[index];
    if (
      step.sequence !== index + 1 ||
      step.name !== name ||
      step.tool !== tool ||
      step.executableSha256 !== toolDigests[tool] ||
      !DIGEST.test(step.argvSha256) ||
      !Number.isSafeInteger(step.stdoutBytes) ||
      step.stdoutBytes < 0 ||
      step.stdoutBytes > 1024 * 1024 ||
      !DIGEST.test(step.stdoutSha256) ||
      !Number.isSafeInteger(step.stderrBytes) ||
      step.stderrBytes < 0 ||
      step.stderrBytes > 1024 * 1024 ||
      !DIGEST.test(step.stderrSha256) ||
      step.exitCode !== 0
    ) {
      fail('step evidence is invalid');
    }
  });
  const verifierStep = value.steps[6];
  if (
    verifierStep.stdoutBytes < 2 ||
    verifierStep.stderrBytes !== 0 ||
    verifierStep.stderrSha256 !== EMPTY_DIGEST
  ) {
    fail('embedded verifier transcript is invalid');
  }
  same(
    value.claims,
    {
      externalToolResults: 'exit_zero_with_digest_only_transcript',
      registryAvailability: 'observed_once',
      offlineAudit: 'structure_and_digest_only',
      workstationIdentityIncluded: false,
      credentialIncluded: false,
      reportAttestation: 'none',
      actionAuthority: 'none',
    },
    'claim boundary',
  );
  const unsigned = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'contentDigest') unsigned[key] = entry;
  }
  if (
    digest(Buffer.from(canonicalize(unsigned), 'utf8')) !== value.contentDigest
  ) {
    fail('report digest is invalid');
  }
  return Object.freeze({
    compatible: true,
    reportContentDigest: value.contentDigest,
    releaseImage: value.release.image,
    verificationSteps: value.steps.length,
    externalResults: 'not_replayed',
    actionAuthority: 'none',
  });
}

function runCli(argv) {
  const options = parseArguments(argv);
  const report = readReport(options.reportFile);
  try {
    const result = auditReport(report.value, options);
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        schema: AUDIT_SCHEMA,
        ...result,
      })}\n`,
    );
  } finally {
    report.bytes.fill(0);
  }
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error
          ? error.message
          : 'release workstation ceremony audit failed'
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  AUDIT_SCHEMA,
  SCHEMA,
  auditReport,
  parseArguments,
  readReport,
  runCli,
};
