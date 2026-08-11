#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  auditClusterOciLayout,
} = require('./ql3-cluster-oci-layout-audit.cjs');
const {
  auditImageOsVulnerabilityPolicy,
  readPolicy,
  writeNoReplace,
} = require('./ql3-image-os-vulnerability-policy.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const NATIVE_FIXTURE = 'qinglong/native-image-os-vulnerability-evidence@v1';
const RELEASE_FIXTURE = 'qinglong/image-os-vulnerability-release-evidence@v1';
const OCI_INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';
const TRIVY_ACTION_COMMIT = 'ed142fd0673e97e23eac54620cfb913e5ce36c25';
const MAX_JSON_BYTES = 1024 * 1024;
const EXPECTED_PLATFORMS = Object.freeze(['linux/amd64', 'linux/arm64']);

function fail(message) {
  throw new Error(message);
}

function readBoundedJson(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_JSON_BYTES) {
    fail(`invalid bounded JSON file: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256Bytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function sha256File(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_JSON_BYTES) {
    fail(`invalid bounded policy file: ${filePath}`);
  }
  return sha256Bytes(fs.readFileSync(filePath));
}

function policyEvidence(root, image) {
  const policy = readPolicy(root);
  const audit = auditImageOsVulnerabilityPolicy(policy);
  if (!audit.compatible) fail('OS vulnerability policy is incompatible');
  return {
    policyDigest: sha256File(
      path.join(root, 'deploy/containers/ql3-os-vulnerability-exceptions.json'),
    ),
    imageExceptionCount: audit.imageExceptionCounts[image],
  };
}

function nativeEvidenceRecord(options) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const platform = options.platform;
  if (!EXPECTED_PLATFORMS.includes(platform)) {
    fail('native evidence platform is invalid');
  }
  const report = auditClusterOciLayout({
    root,
    layoutRoot: options.layoutRoot,
    expectedRevision: options.expectedRevision,
    expectedPlatforms: [platform],
    image: options.image,
  });
  if (report.platforms.length !== 1 || report.platforms[0].platform !== platform) {
    fail('native OCI report platform is invalid');
  }
  const policy = policyEvidence(root, report.image);
  return {
    schemaVersion: 1,
    fixture: NATIVE_FIXTURE,
    sourceRevision: options.expectedRevision,
    image: report.image,
    platform,
    nativeRootIndexDigest: report.rootIndexDigest,
    imageManifestDigest: report.platforms[0].manifestDigest,
    configDigest: report.platforms[0].configDigest,
    scanner: {
      name: 'trivy',
      version: '0.70.0',
      actionCommit: TRIVY_ACTION_COMMIT,
    },
    policyDigest: policy.policyDigest,
    imageExceptionCount: policy.imageExceptionCount,
    scan: {
      result: 'passed',
      severities: ['HIGH', 'CRITICAL'],
      packageTypes: ['os'],
      ignoreUnfixed: false,
    },
  };
}

function readNativeLayout(layoutRoot, platform) {
  const resolved = path.resolve(layoutRoot);
  const outer = readBoundedJson(path.join(resolved, 'index.json'));
  if (
    outer.schemaVersion !== 2 ||
    outer.mediaType !== OCI_INDEX_MEDIA_TYPE ||
    !Array.isArray(outer.manifests) ||
    outer.manifests.length !== 1
  ) {
    fail('native OCI layout must contain one root index descriptor');
  }
  const rootDescriptor = outer.manifests[0];
  if (!/^sha256:[0-9a-f]{64}$/.test(rootDescriptor?.digest || '')) {
    fail('native OCI root digest is invalid');
  }
  const imageIndex = readBoundedJson(
    path.join(
      resolved,
      'blobs',
      'sha256',
      rootDescriptor.digest.slice('sha256:'.length),
    ),
  );
  if (
    imageIndex.schemaVersion !== 2 ||
    imageIndex.mediaType !== OCI_INDEX_MEDIA_TYPE ||
    !Array.isArray(imageIndex.manifests) ||
    imageIndex.manifests.length !== 2
  ) {
    fail('native OCI image index must contain one image and one attestation');
  }
  const imageDescriptor = imageIndex.manifests.find(
    (descriptor) =>
      `${descriptor.platform?.os}/${descriptor.platform?.architecture}` ===
      platform,
  );
  const attestationDescriptor = imageIndex.manifests.find(
    (descriptor) =>
      descriptor.platform?.os === 'unknown' &&
      descriptor.platform?.architecture === 'unknown',
  );
  if (
    !imageDescriptor ||
    !attestationDescriptor ||
    attestationDescriptor.annotations?.['vnd.docker.reference.digest'] !==
      imageDescriptor.digest
  ) {
    fail('native OCI descriptor pair is invalid');
  }
  return {
    layoutRoot: resolved,
    rootDescriptor,
    imageDescriptor,
    attestationDescriptor,
  };
}

function writeExclusive(filePath, bytes, mode = 0o600) {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    mode,
  );
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function copyNativeBlobs(native, destinationBlobDirectory) {
  const sourceBlobDirectory = path.join(native.layoutRoot, 'blobs', 'sha256');
  const excludedRoot = native.rootDescriptor.digest.slice('sha256:'.length);
  for (const entry of fs.readdirSync(sourceBlobDirectory, {
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !/^[0-9a-f]{64}$/.test(entry.name)) {
      fail(`invalid native OCI blob entry: ${entry.name}`);
    }
    if (entry.name === excludedRoot) continue;
    const source = path.join(sourceBlobDirectory, entry.name);
    const destination = path.join(destinationBlobDirectory, entry.name);
    if (fs.existsSync(destination)) {
      const sourceStat = fs.lstatSync(source);
      const destinationStat = fs.lstatSync(destination);
      if (
        !sourceStat.isFile() ||
        !destinationStat.isFile() ||
        sourceStat.size !== destinationStat.size
      ) {
        fail(`conflicting OCI blob: sha256:${entry.name}`);
      }
      continue;
    }
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
  }
}

function validateNativeEvidence(options, platform) {
  const expected = nativeEvidenceRecord({
    root: options.root,
    layoutRoot: options[`${platform.split('/')[1]}Layout`],
    expectedRevision: options.expectedRevision,
    image: options.image,
    platform,
  });
  const actual = readBoundedJson(
    path.resolve(options[`${platform.split('/')[1]}Evidence`]),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`native vulnerability evidence differs for ${platform}`);
  }
  return actual;
}

function mergeNativeLayouts(options) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const outputRoot = path.resolve(options.outputRoot || '');
  const predicatePath = path.resolve(options.predicatePath || '');
  const reportPath = path.resolve(options.reportPath || '');
  const inputRoots = [options.amd64Layout, options.arm64Layout].map((entry) =>
    fs.realpathSync(path.resolve(entry)),
  );
  const outputPaths = [outputRoot, predicatePath, reportPath];
  const overlaps = (left, right) =>
    left === right ||
    left.startsWith(`${right}${path.sep}`) ||
    right.startsWith(`${left}${path.sep}`);
  if (
    outputPaths.some(
      (entry) =>
        !path.isAbsolute(entry) ||
        fs.existsSync(entry) ||
        fs.realpathSync(path.dirname(entry)) !== path.dirname(entry),
    ) ||
    new Set(outputPaths).size !== outputPaths.length ||
    inputRoots.some((inputRoot) =>
      outputPaths.some((outputPath) => overlaps(inputRoot, outputPath)),
    )
  ) {
    fail('merged OCI outputs must be unused, canonical and isolated from inputs');
  }
  const evidence = EXPECTED_PLATFORMS.map((platform) =>
    validateNativeEvidence({ ...options, root }, platform),
  );
  const natives = EXPECTED_PLATFORMS.map((platform) =>
    readNativeLayout(
      options[`${platform.split('/')[1]}Layout`],
      platform,
    ),
  );
  let created = false;
  let predicateCreated = false;
  let reportCreated = false;
  try {
    fs.mkdirSync(outputRoot, { mode: 0o700 });
    created = true;
    const blobDirectory = path.join(outputRoot, 'blobs', 'sha256');
    fs.mkdirSync(path.join(outputRoot, 'blobs'), { mode: 0o700 });
    fs.mkdirSync(blobDirectory, { mode: 0o700 });
    for (const native of natives) {
      copyNativeBlobs(native, blobDirectory);
    }

    const mergedIndex = {
      schemaVersion: 2,
      mediaType: OCI_INDEX_MEDIA_TYPE,
      manifests: [
        ...natives.map((native) => native.imageDescriptor),
        ...natives.map((native) => native.attestationDescriptor),
      ],
    };
    const mergedIndexBytes = Buffer.from(JSON.stringify(mergedIndex));
    const rootIndexDigest = sha256Bytes(mergedIndexBytes);
    writeExclusive(
      path.join(
        blobDirectory,
        rootIndexDigest.slice('sha256:'.length),
      ),
      mergedIndexBytes,
    );
    writeExclusive(
      path.join(outputRoot, 'oci-layout'),
      Buffer.from(JSON.stringify({ imageLayoutVersion: '1.0.0' })),
    );
    writeExclusive(
      path.join(outputRoot, 'index.json'),
      Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: OCI_INDEX_MEDIA_TYPE,
          manifests: [
            {
              mediaType: OCI_INDEX_MEDIA_TYPE,
              digest: rootIndexDigest,
              size: mergedIndexBytes.length,
            },
          ],
        }),
      ),
    );

    const mergedReport = auditClusterOciLayout({
      root,
      layoutRoot: outputRoot,
      expectedRevision: options.expectedRevision,
      image: options.image,
    });
    if (mergedReport.rootIndexDigest !== rootIndexDigest) {
      fail('merged OCI digest changed during verification');
    }
    const predicate = {
      schemaVersion: 1,
      fixture: RELEASE_FIXTURE,
      sourceRevision: options.expectedRevision,
      image: mergedReport.image,
      subjectDigest: rootIndexDigest,
      scanner: evidence[0].scanner,
      policyDigest: evidence[0].policyDigest,
      scan: evidence[0].scan,
      platforms: evidence.map((entry) => ({
        platform: entry.platform,
        nativeRootIndexDigest: entry.nativeRootIndexDigest,
        imageManifestDigest: entry.imageManifestDigest,
        configDigest: entry.configDigest,
        imageExceptionCount: entry.imageExceptionCount,
      })),
    };
    if (
      evidence.some(
        (entry) =>
          JSON.stringify(entry.scanner) !== JSON.stringify(predicate.scanner) ||
          entry.policyDigest !== predicate.policyDigest ||
          JSON.stringify(entry.scan) !== JSON.stringify(predicate.scan),
      )
    ) {
      fail('native vulnerability evidence authorities differ');
    }
    writeNoReplace(predicatePath, `${JSON.stringify(predicate)}\n`);
    predicateCreated = true;
    const report = {
      schemaVersion: 1,
      fixture: 'qinglong/image-release-bundle@v1',
      image: mergedReport.image,
      sourceRevision: options.expectedRevision,
      rootIndexDigest,
      platforms: mergedReport.platforms,
      predicateDigest: sha256Bytes(Buffer.from(JSON.stringify(predicate))),
    };
    writeNoReplace(reportPath, `${JSON.stringify(report)}\n`);
    reportCreated = true;
    return report;
  } catch (error) {
    if (created) fs.rmSync(outputRoot, { recursive: true, force: true });
    if (reportCreated) fs.unlinkSync(reportPath);
    if (predicateCreated) fs.unlinkSync(predicatePath);
    throw error;
  }
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) fail('arguments are invalid');
    values[match[1]] = match[2];
  }
  if (values.mode === 'record-native') {
    const expected = [
      'evidence',
      'expected-revision',
      'image',
      'layout',
      'mode',
      'platform',
    ];
    if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expected)) {
      fail('record-native arguments are invalid');
    }
    return {
      mode: values.mode,
      evidencePath: path.resolve(values.evidence),
      expectedRevision: values['expected-revision'],
      image: values.image,
      layoutRoot: path.resolve(values.layout),
      platform: values.platform,
    };
  }
  if (values.mode === 'merge') {
    const expected = [
      'amd64-evidence',
      'amd64-layout',
      'arm64-evidence',
      'arm64-layout',
      'expected-revision',
      'image',
      'mode',
      'output',
      'predicate',
      'report',
    ];
    if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expected)) {
      fail('merge arguments are invalid');
    }
    return {
      mode: values.mode,
      amd64Evidence: path.resolve(values['amd64-evidence']),
      amd64Layout: path.resolve(values['amd64-layout']),
      arm64Evidence: path.resolve(values['arm64-evidence']),
      arm64Layout: path.resolve(values['arm64-layout']),
      expectedRevision: values['expected-revision'],
      image: values.image,
      outputRoot: path.resolve(values.output),
      predicatePath: path.resolve(values.predicate),
      reportPath: path.resolve(values.report),
    };
  }
  fail('mode is invalid');
}

function runCli(argv) {
  const options = parseArguments(argv);
  if (options.mode === 'record-native') {
    const record = nativeEvidenceRecord(options);
    writeNoReplace(options.evidencePath, `${JSON.stringify(record)}\n`);
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return record;
  }
  const report = mergeNativeLayouts(options);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'image bundle failed'}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  NATIVE_FIXTURE,
  RELEASE_FIXTURE,
  mergeNativeLayouts,
  nativeEvidenceRecord,
  parseArguments,
  runCli,
};
