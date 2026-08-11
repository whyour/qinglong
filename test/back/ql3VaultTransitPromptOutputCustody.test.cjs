const assert = require('node:assert/strict');
const {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { generateKeyPairSync } = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');

const {
  BUNDLE_SCHEMA,
  VaultTransitPromptOutputCustodyError,
  readCommand,
  run,
  vaultRequest,
} = require('../../scripts/ql3-vault-transit-prompt-output-custody.cjs');
const {
  pluginPackagePromptOutputKeyRotationMaterialProof,
} = require('../../packages/ql3-ai/dist/prompt-output/key-management/pluginPackagePromptOutputKeyRotation.js');

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
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
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ql3-vault-custody-'));
  directories.push(directory);
  const material = Buffer.alloc(32, 0x6a);
  const signingKeys = generateKeyPairSync('ed25519');
  const files = {
    token: privateFile(directory, 'vault-token', 'fixture-vault-token\n'),
    material: privateFile(directory, 'material.bin', material),
    signingPrivate: privateFile(
      directory,
      'custody-private.pem',
      signingKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    ),
    signingPublic: privateFile(
      directory,
      'custody-public.pem',
      signingKeys.publicKey.export({ format: 'pem', type: 'spki' }),
    ),
    bundle: path.join(directory, 'custody-bundle.json'),
    recovered: path.join(directory, 'recovered-material.bin'),
  };
  const vault = {
    transport: 'loopback-http-fixture',
    endpoint: 'http://127.0.0.1:18200',
    caFile: null,
    tokenFile: files.token,
    transitMount: 'prompt-output-transit',
    keyName: 'prompt-output-custody',
  };
  const wrapValue = {
    schemaVersion: 1,
    operation: 'external.prompt-output-key.vault-transit.wrap',
    vault,
    materialFile: files.material,
    bundleOutputFile: files.bundle,
    custody: {
      custodyId: 'vault-custody-001',
      keyId: 'prompt-key-vault-001',
      sourceGeneration: 8,
      sourceCatalogDigest: '1'.repeat(64),
      receiptSigningPrivateKeyFile: files.signingPrivate,
      receiptSigningPublicKeyFile: files.signingPublic,
    },
  };
  const unwrapValue = {
    schemaVersion: 1,
    operation: 'external.prompt-output-key.vault-transit.unwrap',
    vault,
    bundleFile: files.bundle,
    custodyPublicKeyFile: files.signingPublic,
    recoveredMaterialOutputFile: files.recovered,
  };
  const wrapCommand = privateFile(
    directory,
    'wrap-command.json',
    JSON.stringify(wrapValue),
  );
  const unwrapCommand = privateFile(
    directory,
    'unwrap-command.json',
    JSON.stringify(unwrapValue),
  );
  return {
    directory,
    material,
    files,
    wrapValue,
    unwrapValue,
    wrapCommand,
    unwrapCommand,
  };
}

function transit(material, options = {}) {
  let calls = 0;
  const ciphertext = 'vault:v7:QUJDREVGRw==';
  return {
    get calls() {
      return calls;
    },
    request: async (vault, operation, token, body) => {
      calls += 1;
      assert.equal(vault.transitMount, 'prompt-output-transit');
      assert.equal(vault.keyName, 'prompt-output-custody');
      assert.equal(token, 'fixture-vault-token');
      if (operation === 'encrypt') {
        assert.equal(body.plaintext, material.toString('base64'));
        return { data: { ciphertext } };
      }
      assert.equal(operation, 'decrypt');
      assert.equal(body.ciphertext, ciphertext);
      return {
        data: {
          plaintext: (options.recoveredMaterial ?? material).toString('base64'),
        },
      };
    },
  };
}

test('creates one immutable signed Vault Transit custody bundle', async () => {
  const value = fixture();
  const provider = transit(value.material);
  const result = await run(readCommand(value.wrapCommand), {
    request: provider.request,
    now: () => 1_700_000_000_000,
  });
  assert.equal(result.status, 'completed');
  assert.equal(provider.calls, 1);
  assert.equal(statSync(value.files.bundle).mode & 0o777, 0o400);
  const bundleSource = readFileSync(value.files.bundle, 'utf8');
  const bundle = JSON.parse(bundleSource);
  assert.equal(bundle.schema, BUNDLE_SCHEMA);
  assert.equal(bundle.receipt.wrappingProvider, 'vault-transit');
  assert.equal(bundle.receipt.materialProof.length, 64);
  assert.equal(bundle.bundleDigest.length, 64);
  assert.equal(bundleSource.includes('fixture-vault-token'), false);
  assert.equal(bundleSource.includes(value.material.toString('base64')), false);
  assert.equal(bundleSource.includes('prompt-output-custody'), false);
  assert.equal(bundleSource.includes('127.0.0.1'), false);
});

test('exact wrap replay verifies the immutable bundle without Vault access', async () => {
  const value = fixture();
  const provider = transit(value.material);
  const command = readCommand(value.wrapCommand);
  const first = await run(command, {
    request: provider.request,
    now: () => 1_700_000_000_000,
  });
  const second = await run(command, {
    request: () => {
      throw new Error('Vault must not be called for replay');
    },
  });
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'existing');
  assert.equal(second.receipt.receiptDigest, first.receipt.receiptDigest);
  assert.equal(provider.calls, 1);
});

test('unwrap writes one 0400 material and exact replay avoids Vault', async () => {
  const value = fixture();
  const provider = transit(value.material);
  await run(readCommand(value.wrapCommand), {
    request: provider.request,
    now: () => 1_700_000_000_000,
  });
  const command = readCommand(value.unwrapCommand);
  const first = await run(command, { request: provider.request });
  assert.equal(first.status, 'completed');
  assert.equal(provider.calls, 2);
  assert.equal(statSync(value.files.recovered).mode & 0o777, 0o400);
  assert.deepEqual(readFileSync(value.files.recovered), value.material);
  const second = await run(command, {
    request: () => {
      throw new Error('Vault must not be called for replay');
    },
  });
  assert.equal(second.status, 'existing');
  assert.equal(provider.calls, 2);
});

test('rejects wrong recovered material and key authority drift before output', async () => {
  const value = fixture();
  const provider = transit(value.material, {
    recoveredMaterial: Buffer.alloc(32, 0x6b),
  });
  await run(readCommand(value.wrapCommand), {
    request: provider.request,
    now: () => 1_700_000_000_000,
  });
  await assert.rejects(
    () => run(readCommand(value.unwrapCommand), { request: provider.request }),
    (error) =>
      error instanceof VaultTransitPromptOutputCustodyError &&
      error.code === 'QL3_VAULT_CUSTODY_RECOVERED_MATERIAL_UNTRUSTED',
  );
  assert.equal(existsSync(value.files.recovered), false);

  const drifted = {
    ...value.unwrapValue,
    vault: { ...value.unwrapValue.vault, keyName: 'other-key' },
  };
  chmodSync(value.unwrapCommand, 0o600);
  writeFileSync(value.unwrapCommand, JSON.stringify(drifted));
  chmodSync(value.unwrapCommand, 0o440);
  await assert.rejects(
    () =>
      run(readCommand(value.unwrapCommand), {
        request: () => {
          throw new Error('drift must fail before Vault access');
        },
      }),
    (error) =>
      error instanceof VaultTransitPromptOutputCustodyError &&
      error.code === 'QL3_VAULT_CUSTODY_BUNDLE_UNTRUSTED',
  );
});

test('rejects insecure production transport and unsafe authority files', () => {
  for (const mutation of [
    (value) => {
      value.vault.transport = 'https';
      value.vault.caFile = null;
    },
    (value) => {
      value.vault.endpoint = 'http://vault.example.test:8200';
    },
  ]) {
    const value = fixture();
    const command = structuredClone(value.wrapValue);
    mutation(command);
    chmodSync(value.wrapCommand, 0o600);
    writeFileSync(value.wrapCommand, JSON.stringify(command));
    chmodSync(value.wrapCommand, 0o440);
    assert.throws(
      () => readCommand(value.wrapCommand),
      VaultTransitPromptOutputCustodyError,
    );
  }
});

test('CLI replay emits only content-free custody facts', async () => {
  const value = fixture();
  const provider = transit(value.material);
  await run(readCommand(value.wrapCommand), {
    request: provider.request,
    now: () => 1_700_000_000_000,
  });
  const result = spawnSync(
    process.execPath,
    [
      path.resolve(
        __dirname,
        '../../scripts/ql3-vault-transit-prompt-output-custody.cjs',
      ),
      'wrap',
      '--command-file',
      value.wrapCommand,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.event, 'custody_bundle_created');
  assert.equal(report.status, 'existing');
  assert.equal(result.stdout.includes('fixture-vault-token'), false);
  assert.equal(
    result.stdout.includes(value.material.toString('base64')),
    false,
  );
  assert.equal(result.stdout.includes(value.files.material), false);
});

test('material proof remains bound to the original exact 32-byte key', async () => {
  const value = fixture();
  const provider = transit(value.material);
  const result = await run(readCommand(value.wrapCommand), {
    request: provider.request,
    now: () => 1_700_000_000_000,
  });
  assert.equal(
    result.receipt.materialProof,
    pluginPackagePromptOutputKeyRotationMaterialProof(
      result.receipt.keyId,
      value.material,
    ),
  );
});

test('loopback transport sends one bounded Vault request and rejects oversized responses', async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      chunks.forEach((chunk) => chunk.fill(0));
      try {
        requests.push({
          url: request.url,
          token: request.headers['x-vault-token'],
          body: JSON.parse(body.toString('utf8')),
        });
      } finally {
        body.fill(0);
      }
      response.statusCode = 200;
      response.setHeader('connection', 'close');
      if (request.url.includes('/decrypt/')) {
        response.end(Buffer.alloc(129 * 1024, 0x61));
      } else {
        response.end(
          JSON.stringify({ data: { ciphertext: 'vault:v9:QUJDRA==' } }),
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const vault = {
    endpoint: `http://127.0.0.1:${address.port}`,
    caFile: null,
    transitMount: 'prompt-output-transit',
    keyName: 'prompt-output-custody',
  };
  try {
    const response = await vaultRequest(
      vault,
      'encrypt',
      'fixture-vault-token',
      { plaintext: 'cHJpdmF0ZS1maXh0dXJl' },
    );
    assert.equal(response.data.ciphertext, 'vault:v9:QUJDRA==');
    assert.deepEqual(requests[0], {
      url: '/v1/prompt-output-transit/encrypt/prompt-output-custody',
      token: 'fixture-vault-token',
      body: { plaintext: 'cHJpdmF0ZS1maXh0dXJl' },
    });
    await assert.rejects(
      () =>
        vaultRequest(vault, 'decrypt', 'fixture-vault-token', {
          ciphertext: 'vault:v9:QUJDRA==',
        }),
      (error) =>
        error instanceof VaultTransitPromptOutputCustodyError &&
        error.code === 'QL3_VAULT_CUSTODY_RESPONSE_TOO_LARGE',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
