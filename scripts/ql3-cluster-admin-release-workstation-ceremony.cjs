#!/usr/bin/env node

'use strict';

const { spawnSync } = require('node:child_process');
const { createHash, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  createClusterConsoleEvidenceBundle,
  serializeClusterConsoleEvidenceBundle,
} = require('../packages/ql3-cluster-admin/assets/copilot-console/evidence-bundle.js');

const SCHEMA = 'qinglong/cluster-admin-release-workstation-ceremony@v1';
const WORKFLOW = '.github/workflows/ql3-image-release.yml';
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TOOL_BYTES = 256 * 1024 * 1024;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

class ReleaseWorkstationCeremonyError extends Error {
  constructor() {
    super('Cluster Admin release workstation ceremony failed');
    this.name = 'ReleaseWorkstationCeremonyError';
  }
}

function fail() {
  throw new ReleaseWorkstationCeremonyError();
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

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) fail();
    values[match[1]] = match[2];
  }
  const expected = [
    'image',
    'repository',
    'source-revision',
    'source-ref',
    'cosign',
    'gh',
    'docker',
    'github-token-file',
    'output',
  ];
  if (
    JSON.stringify(Object.keys(values).sort()) !==
    JSON.stringify(expected.sort())
  ) {
    fail();
  }
  const repository = values.repository;
  if (!/^[a-z0-9][a-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u.test(repository)) {
    fail();
  }
  const owner = repository.slice(0, repository.indexOf('/'));
  const imagePattern = new RegExp(
    `^ghcr\\.io/${owner}/qinglong3-cluster-admin@sha256:[a-f0-9]{64}$`,
    'u',
  );
  if (
    !imagePattern.test(values.image) ||
    !/^[a-f0-9]{40}$/u.test(values['source-revision']) ||
    !/^refs\/tags\/v3\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/u.test(
      values['source-ref'],
    )
  ) {
    fail();
  }
  return Object.freeze({
    image: values.image,
    repository,
    sourceRevision: values['source-revision'],
    sourceRef: values['source-ref'],
    cosign: values.cosign,
    gh: values.gh,
    docker: values.docker,
    githubTokenFile: values['github-token-file'],
    output: values.output,
  });
}

function canonicalRegularFile(filePath, options) {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    filePath.length > 4096 ||
    CONTROL.test(filePath) ||
    path.normalize(filePath) !== filePath
  ) {
    fail();
  }
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail();
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < options.minimumBytes ||
    stat.size > options.maximumBytes ||
    fs.realpathSync(filePath) !== filePath ||
    (stat.mode & options.forbiddenMode) !== 0 ||
    (options.executable && (stat.mode & 0o111) === 0) ||
    (options.currentOwner &&
      (typeof process.getuid !== 'function' || stat.uid !== process.getuid()))
  ) {
    fail();
  }
  return stat;
}

function readToken(filePath) {
  const before = canonicalRegularFile(filePath, {
    minimumBytes: 1,
    maximumBytes: 4096,
    forbiddenMode: 0o077,
    executable: false,
    currentOwner: true,
  });
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
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.mode !== before.mode ||
      opened.uid !== before.uid ||
      opened.size !== before.size
    ) {
      fail();
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
      if (count < 1) fail();
      offset += count;
    }
    const token = bytes.toString('utf8');
    if (
      token.trim() !== token ||
      token.length < 8 ||
      CONTROL.test(token) ||
      /\s/u.test(token)
    ) {
      fail();
    }
    return Object.freeze({ bytes, token });
  } catch (error) {
    if (bytes) bytes.fill(0);
    if (error instanceof ReleaseWorkstationCeremonyError) throw error;
    fail();
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function executable(filePath) {
  const stat = canonicalRegularFile(filePath, {
    minimumBytes: 2,
    maximumBytes: MAX_TOOL_BYTES,
    forbiddenMode: 0o022,
    executable: true,
    currentOwner: false,
  });
  return Object.freeze({
    path: filePath,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    sha256: digest(fs.readFileSync(filePath)),
  });
}

function verifyExecutable(tool) {
  const current = executable(tool.path);
  if (
    current.dev !== tool.dev ||
    current.ino !== tool.ino ||
    current.size !== tool.size ||
    current.sha256 !== tool.sha256
  ) {
    fail();
  }
}

function privateUnusedOutput(filePath) {
  if (
    typeof filePath !== 'string' ||
    !path.isAbsolute(filePath) ||
    filePath.length > 4096 ||
    CONTROL.test(filePath) ||
    path.normalize(filePath) !== filePath ||
    fs.existsSync(filePath)
  ) {
    fail();
  }
  const parent = path.dirname(filePath);
  let stat;
  try {
    stat = fs.lstatSync(parent);
  } catch {
    fail();
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(parent) !== parent ||
    typeof process.getuid !== 'function' ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  ) {
    fail();
  }
  return parent;
}

function writeNoReplace(filePath, value) {
  privateUnusedOutput(filePath);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let descriptor = -1;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_CLOEXEC ?? 0) |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count < 1) fail();
      offset += count;
    }
    fs.fsyncSync(descriptor);
  } finally {
    bytes.fill(0);
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function runStep(tool, name, args, env, timeoutMs) {
  verifyExecutable(tool);
  const result = spawnSync(tool.path, args, {
    encoding: 'buffer',
    env,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  });
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.alloc(0);
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr
    : Buffer.alloc(0);
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    stdout.length > MAX_OUTPUT_BYTES ||
    stderr.length > MAX_OUTPUT_BYTES
  ) {
    stdout.fill(0);
    stderr.fill(0);
    fail();
  }
  return Object.freeze({
    record: Object.freeze({
      sequence: 0,
      name,
      tool: path.basename(tool.path),
      executableSha256: tool.sha256,
      argvSha256: digest(Buffer.from(JSON.stringify(args), 'utf8')),
      stdoutBytes: stdout.length,
      stdoutSha256: digest(stdout),
      stderrBytes: stderr.length,
      stderrSha256: digest(stderr),
      exitCode: 0,
    }),
    stdout,
    stderr,
  });
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail();
  }
}

async function syntheticEvidenceVector() {
  const bundle = await createClusterConsoleEvidenceBundle(
    [
      {
        operation: 'run_read',
        observedAtMs: 1_700_000_000_000,
        request: {
          schema: 'qinglong/cluster-copilot-console-read-request@v1',
          operation: 'run_read',
          projectId: 'ceremony-project',
          requestId: 'ceremony-request',
          runId: 'ceremony-run',
        },
        fact: {
          schema: 'qinglong/bounded-run-projection@v1',
          schemaVersion: 1,
          status: 'succeeded',
          projectId: 'ceremony-project',
          runId: 'ceremony-run',
          outputAvailable: false,
        },
      },
    ],
    1_700_000_001_000,
    webcrypto,
  );
  return Object.freeze({
    bundle,
    encoded: serializeClusterConsoleEvidenceBundle(bundle),
  });
}

function expectedEvidenceVerification(bundle) {
  return {
    schema: 'qinglong/cluster-console-evidence-verification@v1',
    status: 'verified',
    bundle: {
      schema: 'qinglong/cluster-console-redacted-evidence-bundle@v1',
      contentDigest: bundle.contentDigest,
      entryCount: 1,
      totalRawCanonicalBytes: bundle.source.totalRawCanonicalBytes,
    },
    integrity: {
      bundleDigest: 'verified',
      rawFactDigests: 'not_recomputed_without_raw_facts',
    },
    claims: {
      serverSignature: 'not_verified',
      attestation: 'not_verified',
      durableAudit: 'not_verified',
      actionAuthority: 'none',
    },
    execution: { networkAccess: false, mutation: false, fileWrites: false },
  };
}

function withSequence(steps) {
  return steps.map((step, index) =>
    Object.freeze({ ...step, sequence: index + 1 }),
  );
}

async function runCeremony(options) {
  const outputParent = privateUnusedOutput(options.output);
  const tools = Object.freeze({
    cosign: executable(options.cosign),
    gh: executable(options.gh),
    docker: executable(options.docker),
  });
  const token = readToken(options.githubTokenFile);
  const publicEnv = Object.freeze({
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    GH_PROMPT_DISABLED: '1',
  });
  const githubEnv = Object.freeze({
    ...publicEnv,
    GH_TOKEN: token.token,
  });
  const temporary = fs.mkdtempSync(
    path.join(outputParent, '.ql3-admin-release-ceremony-'),
  );
  fs.chmodSync(temporary, 0o700);
  const vectorFile = path.join(temporary, 'synthetic-evidence.json');
  const steps = [];
  const transcripts = [];
  const keep = (result) => {
    steps.push(result.record);
    transcripts.push(result.stdout, result.stderr);
    return result;
  };
  const discard = (result) => {
    keep(result);
    result.stdout.fill(0);
    result.stderr.fill(0);
  };
  try {
    const vector = await syntheticEvidenceVector();
    fs.writeFileSync(vectorFile, vector.encoded, { mode: 0o444, flag: 'wx' });
    const before = fs.statSync(vectorFile);
    const workflow = `${options.repository}/${WORKFLOW}`;
    const identity = `https://github.com/${workflow}@${options.sourceRef}`;
    discard(
      runStep(
        tools.cosign,
        'keyless_signature',
        [
          'verify',
          '--certificate-identity',
          identity,
          '--certificate-oidc-issuer',
          'https://token.actions.githubusercontent.com',
          options.image,
        ],
        publicEnv,
        300_000,
      ),
    );
    const attestation = (name, predicateType) => {
      const args = [
        'attestation',
        'verify',
        `oci://${options.image}`,
        '--repo',
        options.repository,
        '--signer-workflow',
        workflow,
        '--source-digest',
        options.sourceRevision,
        '--source-ref',
        options.sourceRef,
      ];
      if (predicateType) args.push('--predicate-type', predicateType);
      args.push('--deny-self-hosted-runners', '--bundle-from-oci');
      discard(runStep(tools.gh, name, args, githubEnv, 300_000));
    };
    attestation('provenance_attestation', '');
    attestation('cyclonedx_sbom_attestation', 'https://cyclonedx.org/bom');
    attestation(
      'os_vulnerability_attestation',
      'https://qinglong.dev/attestations/image-os-vulnerability/v1',
    );
    discard(
      runStep(
        tools.docker,
        'immutable_image_pull',
        ['pull', options.image],
        publicEnv,
        600_000,
      ),
    );
    const inspection = keep(
      runStep(
        tools.docker,
        'local_digest_inspection',
        ['image', 'inspect', options.image],
        publicEnv,
        60_000,
      ),
    );
    const inspected = parseJson(inspection.stdout);
    if (
      !Array.isArray(inspected) ||
      inspected.length !== 1 ||
      inspected[0]?.Os !== 'linux' ||
      !['amd64', 'arm64'].includes(inspected[0]?.Architecture) ||
      !Array.isArray(inspected[0]?.RepoDigests) ||
      !inspected[0].RepoDigests.includes(options.image)
    ) {
      fail();
    }
    const mount = `type=bind,src=${vectorFile},dst=/evidence/bundle.json,readonly`;
    const verified = keep(
      runStep(
        tools.docker,
        'embedded_evidence_verifier',
        [
          'run',
          '--rm',
          '--read-only',
          '--network',
          'none',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--user',
          '10001:10001',
          '--pids-limit',
          '32',
          '--memory',
          '128m',
          '--cpus',
          '0.25',
          '--mount',
          mount,
          options.image,
          'evidence-verify',
          '--bundle=/evidence/bundle.json',
        ],
        publicEnv,
        60_000,
      ),
    );
    if (
      verified.stderr.length !== 0 ||
      JSON.stringify(parseJson(verified.stdout)) !==
        JSON.stringify(expectedEvidenceVerification(vector.bundle))
    ) {
      fail();
    }
    const after = fs.statSync(vectorFile);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      digest(fs.readFileSync(vectorFile)) !==
        digest(Buffer.from(vector.encoded))
    ) {
      fail();
    }
    for (const tool of Object.values(tools)) verifyExecutable(tool);
    const unsigned = {
      schema: SCHEMA,
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      release: {
        image: options.image,
        repository: options.repository,
        sourceRevision: options.sourceRevision,
        sourceRef: options.sourceRef,
        workflowIdentity: identity,
      },
      tools: ['cosign', 'gh', 'docker'].map((name) => ({
        name,
        sha256: tools[name].sha256,
        sizeBytes: tools[name].size,
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
        schema: vector.bundle.schema,
        contentDigest: vector.bundle.contentDigest,
        entryCount: vector.bundle.source.entryCount,
        totalRawCanonicalBytes: vector.bundle.source.totalRawCanonicalBytes,
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
      steps: withSequence(steps),
      claims: {
        externalToolResults: 'exit_zero_with_digest_only_transcript',
        registryAvailability: 'observed_once',
        offlineAudit: 'structure_and_digest_only',
        workstationIdentityIncluded: false,
        credentialIncluded: false,
        reportAttestation: 'none',
        actionAuthority: 'none',
      },
    };
    const report = Object.freeze({
      ...unsigned,
      contentDigest: digest(Buffer.from(canonicalize(unsigned), 'utf8')),
    });
    writeNoReplace(options.output, report);
    return report;
  } finally {
    token.bytes.fill(0);
    for (const transcript of transcripts) transcript.fill(0);
    try {
      fs.rmSync(temporary, { recursive: true, force: true });
    } catch {
      // A private synthetic-only directory is best-effort cleanup on failure.
    }
  }
}

async function runCli(argv) {
  const report = await runCeremony(parseArguments(argv));
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      component: 'qinglong3-cluster-admin-release-workstation-ceremony',
      compatible: true,
      contentDigest: report.contentDigest,
    })}\n`,
  );
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      '{"schemaVersion":1,"component":"qinglong3-cluster-admin-release-workstation-ceremony","event":"ceremony_failed"}\n',
    );
    process.exitCode = 1;
  });
}

module.exports = {
  SCHEMA,
  expectedEvidenceVerification,
  parseArguments,
  runCeremony,
  runCli,
  syntheticEvidenceVector,
};
