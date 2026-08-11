const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { afterEach, test } = require('node:test');

const {
  createPluginPackagePromptOutputArtifact,
} = require('../../ql3-ai/dist/prompt-output/pluginPackagePromptOutputArtifact.js');
const {
  createPluginPackagePromptOutputExternalCustodyReceipt,
} = require('../../ql3-ai/dist/prompt-output/custody/pluginPackagePromptOutputExternalCustody.js');
const {
  createPluginPackagePromptOutputExternalCustodyBundle,
} = require('../../ql3-ai/dist/prompt-output/custody/pluginPackagePromptOutputExternalCustodyBundle.js');
const {
  createPluginPackagePromptOutputExternalRecoveryAuthorization,
} = require('../../ql3-ai/dist/prompt-output/custody/pluginPackagePromptOutputExternalRecoveryAuthorization.js');
const {
  pluginPackagePromptOutputKeyRotationMaterialProof,
} = require('../../ql3-ai/dist/prompt-output/key-management/pluginPackagePromptOutputKeyRotation.js');
const {
  disposeClusterPromptOutputExternalRecoveryInput,
  readClusterPromptOutputExternalRecoveryCommand,
  readClusterPromptOutputExternalRecoveryInput,
} = require('../dist/prompt-output/external-recovery/promptOutputExternalRecoveryInput.js');
const {
  ClusterPromptOutputExternalRecoveryVerifierConfigError,
  runClusterPromptOutputExternalRecoveryVerifier,
} = require('../dist/prompt-output/external-recovery/promptOutputExternalRecoveryVerifier.js');

const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function privateFile(directory, name, value, mode = 0o440) {
  const target = path.join(directory, name);
  writeFileSync(target, value, { mode: 0o600 });
  chmodSync(target, mode);
  return target;
}

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ql3-recovery-'));
  temporaryDirectories.push(directory);
  const now = Date.now();
  const material = Buffer.alloc(32, 0x5c);
  const wrapped = Buffer.from('provider-wrapped-key-material');
  const custodyKeys = generateKeyPairSync('ed25519');
  const approverAKeys = generateKeyPairSync('ed25519');
  const approverBKeys = generateKeyPairSync('ed25519');
  const catalogDigest = '1'.repeat(64);
  const artifact = createPluginPackagePromptOutputArtifact(
    {
      projectId: 'project-offline-recovery',
      runId: 'run-offline-recovery',
      stepRunId: 'step-offline-recovery',
      invocationId: 'invocation-offline-recovery',
      requestedBy: { type: 'user', id: 'requester-user' },
      result: {
        provider: 'openai-compatible',
        model: 'bounded-model',
        text: 'private offline recovery output',
        finishReason: 'stop',
        usage: {
          inputTokens: 4,
          outputTokens: 5,
          totalTokens: 9,
          costMicros: 10,
        },
      },
      retentionPolicy: {
        revision: 'offline-recovery-v1',
        retentionMs: 86_400_000,
      },
      keyId: 'offline-recovery-key',
      key: Buffer.from(material),
      sealedAtMs: now - 60_000,
    },
    () => Buffer.alloc(12, 0x39),
  );
  const receipt = createPluginPackagePromptOutputExternalCustodyReceipt(
    {
      custodyId: 'offline-custody',
      keyId: 'offline-recovery-key',
      materialProof: pluginPackagePromptOutputKeyRotationMaterialProof(
        'offline-recovery-key',
        material,
      ),
      sourceGeneration: 4,
      sourceCatalogDigest: catalogDigest,
      wrappingProvider: 'external-kms',
      wrappingKeyRefDigest: '2'.repeat(64),
      wrappedMaterialDigest: createHash('sha256').update(wrapped).digest('hex'),
      wrappedMaterialBytes: wrapped.length,
      createdAtMs: now - 120_000,
    },
    {
      publicKey: custodyKeys.publicKey,
      sign: (message) => sign(null, message, custodyKeys.privateKey),
    },
  );
  const custodyBundle = createPluginPackagePromptOutputExternalCustodyBundle(
    receipt,
    custodyKeys.publicKey,
    wrapped,
  );
  const approvalSigner = (userId, authenticationId, keys, approvedAtMs) => ({
    userId,
    authenticationId,
    authenticatedAtMs: approvedAtMs - 1_000,
    approvedAtMs,
    publicKey: keys.publicKey,
    sign: (message) => sign(null, message, keys.privateKey),
  });
  const authorization =
    createPluginPackagePromptOutputExternalRecoveryAuthorization(
      {
        recoveryId: 'offline-recovery-001',
        requestId: 'offline-request-001',
        custodyId: receipt.custodyId,
        custodyReceiptDigest: receipt.receiptDigest,
        keyId: receipt.keyId,
        artifactId: artifact.artifactId,
        artifactDigest: artifact.artifactDigest,
        policyDigest: '3'.repeat(64),
        requestedBy: {
          userId: 'requester-user',
          authenticationId: 'requester-auth',
          authenticatedAtMs: now - 4_000,
        },
        requestedAtMs: now - 3_000,
        expiresAtMs: now + 10 * 60_000,
      },
      [
        approvalSigner(
          'reviewer-a',
          'reviewer-a-auth',
          approverAKeys,
          now - 2_000,
        ),
        approvalSigner(
          'reviewer-b',
          'reviewer-b-auth',
          approverBKeys,
          now - 1_000,
        ),
      ],
    );
  const files = {
    authorizationFile: privateFile(
      directory,
      'authorization.json',
      JSON.stringify(authorization),
    ),
    custodyBundleFile: privateFile(
      directory,
      'custody-bundle.json',
      JSON.stringify(custodyBundle),
    ),
    recoveredMaterialFile: privateFile(directory, 'material.bin', material),
    durableKeyFactFile: privateFile(
      directory,
      'durable-fact.json',
      JSON.stringify({
        keyId: receipt.keyId,
        materialProof: receipt.materialProof,
        catalogDigest: receipt.sourceCatalogDigest,
      }),
    ),
    artifactFile: privateFile(
      directory,
      'artifact.json',
      JSON.stringify(artifact),
    ),
    custodyPublicKeyFile: privateFile(
      directory,
      'custody-public.pem',
      custodyKeys.publicKey.export({ format: 'pem', type: 'spki' }),
    ),
    approverAFile: privateFile(
      directory,
      'reviewer-a-public.pem',
      approverAKeys.publicKey.export({ format: 'pem', type: 'spki' }),
    ),
    approverBFile: privateFile(
      directory,
      'reviewer-b-public.pem',
      approverBKeys.publicKey.export({ format: 'pem', type: 'spki' }),
    ),
  };
  const command = {
    schemaVersion: 1,
    operation: 'cluster.prompt-output-key.verify-recovery',
    authorizationFile: files.authorizationFile,
    custodyBundleFile: files.custodyBundleFile,
    recoveredMaterialFile: files.recoveredMaterialFile,
    durableKeyFactFile: files.durableKeyFactFile,
    artifactFile: files.artifactFile,
    custodyPublicKeyFile: files.custodyPublicKeyFile,
    approverPublicKeyFiles: [
      { userId: 'reviewer-b', filePath: files.approverBFile },
      { userId: 'reviewer-a', filePath: files.approverAFile },
    ],
  };
  const commandFile = privateFile(
    directory,
    'command.json',
    JSON.stringify(command),
    0o444,
  );
  return { directory, now, files, command, commandFile };
}

test('reads one private recovery workspace and emits a content-free proof', () => {
  const value = fixture();
  const command = readClusterPromptOutputExternalRecoveryCommand(
    value.commandFile,
  );
  assert.deepEqual(
    command.approverPublicKeyFiles.map(({ userId }) => userId),
    ['reviewer-a', 'reviewer-b'],
  );
  const input = readClusterPromptOutputExternalRecoveryInput(command);
  const proof = runClusterPromptOutputExternalRecoveryVerifier(
    input,
    value.now + 3_000,
  );
  assert.equal(proof.schema.includes('authorized'), true);
  assert.equal(proof.authorizationDigest.length, 64);
  assert.equal(JSON.stringify(proof).includes('private offline'), false);
  disposeClusterPromptOutputExternalRecoveryInput(input);
  assert.equal(
    input.material.every((byte) => byte === 0),
    true,
  );
  assert.equal(
    input.wrappedMaterial.every((byte) => byte === 0),
    true,
  );
});

test('CLI verifies the workspace without database, Kubernetes or KMS input', () => {
  const value = fixture();
  const result = spawnSync(
    process.execPath,
    [
      path.resolve(
        __dirname,
        '../dist/prompt-output/external-recovery/promptOutputExternalRecoveryCli.js',
      ),
      'run',
      '--command-file',
      value.commandFile,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.event, 'recovery_verified');
  assert.equal(report.proofDigest.length, 64);
  assert.equal(result.stdout.includes('private offline'), false);
});

test('rejects writable or symlinked recovery material and custody bundles', () => {
  for (const mutation of [
    (value) => chmodSync(value.files.recoveredMaterialFile, 0o640),
    (value) => chmodSync(value.files.custodyBundleFile, 0o640),
    (value) => {
      const link = path.join(value.directory, 'material-link.bin');
      symlinkSync(value.files.recoveredMaterialFile, link);
      const command = {
        ...value.command,
        recoveredMaterialFile: link,
      };
      chmodSync(value.commandFile, 0o600);
      writeFileSync(value.commandFile, JSON.stringify(command));
      chmodSync(value.commandFile, 0o444);
    },
    (value) => {
      const link = path.join(value.directory, 'custody-bundle-link.json');
      symlinkSync(value.files.custodyBundleFile, link);
      const command = {
        ...value.command,
        custodyBundleFile: link,
      };
      chmodSync(value.commandFile, 0o600);
      writeFileSync(value.commandFile, JSON.stringify(command));
      chmodSync(value.commandFile, 0o444);
    },
  ]) {
    const value = fixture();
    mutation(value);
    const command = readClusterPromptOutputExternalRecoveryCommand(
      value.commandFile,
    );
    assert.throws(() => readClusterPromptOutputExternalRecoveryInput(command));
  }
});

test('rejects authorization and Artifact drift with a content-free error', () => {
  const value = fixture();
  const command = readClusterPromptOutputExternalRecoveryCommand(
    value.commandFile,
  );
  const input = readClusterPromptOutputExternalRecoveryInput(command);
  try {
    assert.throws(
      () =>
        runClusterPromptOutputExternalRecoveryVerifier(
          {
            ...input,
            artifact: {
              ...input.artifact,
              artifactDigest: '4'.repeat(64),
            },
          },
          value.now + 3_000,
        ),
      ClusterPromptOutputExternalRecoveryVerifierConfigError,
    );
  } finally {
    disposeClusterPromptOutputExternalRecoveryInput(input);
  }
});
