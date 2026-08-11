#!/usr/bin/env node

const { Buffer } = require('node:buffer');
const { createHash, createPrivateKey, sign } = require('node:crypto');
const {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { isIP } = require('node:net');
const path = require('node:path');

const {
  createPluginPackagePromptOutputExternalCustodyReceipt,
} = require('../packages/ql3-ai/dist/prompt-output/custody/pluginPackagePromptOutputExternalCustody.js');
const {
  PLUGIN_PACKAGE_PROMPT_OUTPUT_EXTERNAL_CUSTODY_BUNDLE_SCHEMA,
  createPluginPackagePromptOutputExternalCustodyBundle,
  openPluginPackagePromptOutputExternalCustodyBundle,
} = require('../packages/ql3-ai/dist/prompt-output/custody/pluginPackagePromptOutputExternalCustodyBundle.js');
const {
  pluginPackagePromptOutputKeyRotationMaterialProof,
} = require('../packages/ql3-ai/dist/prompt-output/key-management/pluginPackagePromptOutputKeyRotation.js');

const BUNDLE_SCHEMA =
  PLUGIN_PACKAGE_PROMPT_OUTPUT_EXTERNAL_CUSTODY_BUNDLE_SCHEMA;
const WRAPPING_KEY_REF_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-prompt-output-vault-transit-wrapping-key-ref-digest@v1\0',
  'utf8',
);
const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_BUNDLE_BYTES = 128 * 1024;
const MAX_KEY_FILE_BYTES = 16 * 1024;
const MAX_TOKEN_BYTES = 4 * 1024;
const MAX_VAULT_RESPONSE_BYTES = 128 * 1024;
const VAULT_TIMEOUT_MS = 10_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const VAULT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TOKEN = /^[\x21-\x7e]{1,4096}$/;
const VAULT_CIPHERTEXT = /^vault:v([1-9][0-9]*):[A-Za-z0-9+/=]+$/;

class VaultTransitPromptOutputCustodyError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'VaultTransitPromptOutputCustodyError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new VaultTransitPromptOutputCustodyError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('QL3_VAULT_CUSTODY_COMMAND_INVALID', `${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    fail('QL3_VAULT_CUSTODY_COMMAND_INVALID', `${label} shape is invalid`);
  }
}

function identifier(value, label, pattern = ID) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail('QL3_VAULT_CUSTODY_COMMAND_INVALID', `${label} is invalid`);
  }
  return value;
}

function digest(value, label) {
  return identifier(value, label, DIGEST);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('QL3_VAULT_CUSTODY_COMMAND_INVALID', `${label} is invalid`);
  }
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('QL3_VAULT_CUSTODY_COMMAND_INVALID', `${label} is invalid`);
  }
  return value;
}

function absolutePath(value, label) {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) {
    fail('QL3_VAULT_CUSTODY_COMMAND_INVALID', `${label} is invalid`);
  }
  return value;
}

function readStableFile(
  filePath,
  { label, minimumBytes, maximumBytes, privateFile = true },
) {
  let descriptor;
  try {
    descriptor = openSync(
      absolutePath(filePath, `${label} path`),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < minimumBytes ||
      before.size > maximumBytes ||
      (before.mode & 0o222) !== 0 ||
      (before.mode & 0o111) !== 0 ||
      (before.mode & 0o440) === 0 ||
      (privateFile && (before.mode & 0o007) !== 0)
    ) {
      fail('QL3_VAULT_CUSTODY_FILE_UNSAFE', `${label} is unsafe`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      bytes.byteLength !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      bytes.fill(0);
      fail('QL3_VAULT_CUSTODY_FILE_CHANGED', `${label} changed during read`);
    }
    return bytes;
  } catch (cause) {
    if (cause instanceof VaultTransitPromptOutputCustodyError) throw cause;
    fail(
      'QL3_VAULT_CUSTODY_FILE_UNAVAILABLE',
      `${label} is unavailable`,
      cause,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readJsonFile(filePath, label, maximumBytes) {
  const bytes = readStableFile(filePath, {
    label,
    minimumBytes: 2,
    maximumBytes,
  });
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    fail('QL3_VAULT_CUSTODY_JSON_INVALID', `${label} is invalid`, cause);
  } finally {
    bytes.fill(0);
  }
}

function readToken(filePath) {
  const bytes = readStableFile(filePath, {
    label: 'Vault token file',
    minimumBytes: 1,
    maximumBytes: MAX_TOKEN_BYTES + 1,
  });
  try {
    const raw = bytes.toString('utf8');
    const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (!TOKEN.test(value) || (raw !== value && raw !== `${value}\n`)) {
      fail('QL3_VAULT_CUSTODY_TOKEN_INVALID', 'Vault token is invalid');
    }
    return value;
  } finally {
    bytes.fill(0);
  }
}

function normalizeVault(value) {
  exactKeys(
    value,
    ['caFile', 'endpoint', 'keyName', 'tokenFile', 'transitMount', 'transport'],
    'Vault configuration',
  );
  const transport = value.transport;
  if (transport !== 'https' && transport !== 'loopback-http-fixture') {
    fail('QL3_VAULT_CUSTODY_COMMAND_INVALID', 'Vault transport is invalid');
  }
  let endpoint;
  try {
    endpoint = new URL(value.endpoint);
  } catch (cause) {
    fail(
      'QL3_VAULT_CUSTODY_COMMAND_INVALID',
      'Vault endpoint is invalid',
      cause,
    );
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash ||
    (transport === 'https' && endpoint.protocol !== 'https:') ||
    (transport === 'loopback-http-fixture' &&
      (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'))
  ) {
    fail(
      'QL3_VAULT_CUSTODY_COMMAND_INVALID',
      'Vault endpoint authority is invalid',
    );
  }
  if (
    (transport === 'https' && value.caFile === null) ||
    (transport === 'loopback-http-fixture' && value.caFile !== null)
  ) {
    fail('QL3_VAULT_CUSTODY_COMMAND_INVALID', 'Vault CA binding is invalid');
  }
  return Object.freeze({
    transport,
    endpoint: endpoint.origin,
    caFile:
      value.caFile === null
        ? null
        : absolutePath(value.caFile, 'Vault CA file'),
    tokenFile: absolutePath(value.tokenFile, 'Vault token file'),
    transitMount: identifier(
      value.transitMount,
      'Vault transit mount',
      VAULT_NAME,
    ),
    keyName: identifier(value.keyName, 'Vault key name', VAULT_NAME),
  });
}

function readCommand(filePath) {
  const value = readJsonFile(
    filePath,
    'Vault custody command',
    MAX_COMMAND_BYTES,
  );
  if (value?.schemaVersion !== 1 || typeof value.operation !== 'string') {
    fail('QL3_VAULT_CUSTODY_COMMAND_INVALID', 'Command value is invalid');
  }
  if (value.operation === 'external.prompt-output-key.vault-transit.wrap') {
    exactKeys(
      value,
      [
        'bundleOutputFile',
        'custody',
        'materialFile',
        'operation',
        'schemaVersion',
        'vault',
      ],
      'Wrap command',
    );
    exactKeys(
      value.custody,
      [
        'custodyId',
        'keyId',
        'receiptSigningPrivateKeyFile',
        'receiptSigningPublicKeyFile',
        'sourceCatalogDigest',
        'sourceGeneration',
      ],
      'Custody metadata',
    );
    return Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      vault: normalizeVault(value.vault),
      materialFile: absolutePath(value.materialFile, 'Material file'),
      bundleOutputFile: absolutePath(
        value.bundleOutputFile,
        'Custody bundle output file',
      ),
      custody: Object.freeze({
        custodyId: identifier(value.custody.custodyId, 'Custody id'),
        keyId: identifier(value.custody.keyId, 'Key id'),
        sourceGeneration: positiveInteger(
          value.custody.sourceGeneration,
          'Source generation',
        ),
        sourceCatalogDigest: digest(
          value.custody.sourceCatalogDigest,
          'Source catalog digest',
        ),
        receiptSigningPrivateKeyFile: absolutePath(
          value.custody.receiptSigningPrivateKeyFile,
          'Receipt signing private key file',
        ),
        receiptSigningPublicKeyFile: absolutePath(
          value.custody.receiptSigningPublicKeyFile,
          'Receipt signing public key file',
        ),
      }),
    });
  }
  if (value.operation === 'external.prompt-output-key.vault-transit.unwrap') {
    exactKeys(
      value,
      [
        'bundleFile',
        'custodyPublicKeyFile',
        'operation',
        'recoveredMaterialOutputFile',
        'schemaVersion',
        'vault',
      ],
      'Unwrap command',
    );
    return Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      vault: normalizeVault(value.vault),
      bundleFile: absolutePath(value.bundleFile, 'Custody bundle file'),
      custodyPublicKeyFile: absolutePath(
        value.custodyPublicKeyFile,
        'Custody public key file',
      ),
      recoveredMaterialOutputFile: absolutePath(
        value.recoveredMaterialOutputFile,
        'Recovered material output file',
      ),
    });
  }
  fail('QL3_VAULT_CUSTODY_COMMAND_INVALID', 'Command operation is invalid');
}

function wrappingKeyReferenceDigest(vault, keyVersion) {
  return createHash('sha256')
    .update(WRAPPING_KEY_REF_DIGEST_DOMAIN)
    .update(
      JSON.stringify({
        provider: 'vault-transit',
        endpoint: vault.endpoint,
        transitMount: vault.transitMount,
        keyName: vault.keyName,
        keyVersion,
      }),
    )
    .digest('hex');
}

function parseCiphertext(value) {
  const match = typeof value === 'string' ? VAULT_CIPHERTEXT.exec(value) : null;
  if (!match) {
    fail('QL3_VAULT_CUSTODY_RESPONSE_INVALID', 'Vault ciphertext is invalid');
  }
  return Object.freeze({ value, keyVersion: Number(match[1]) });
}

function normalizeBundle(value, trustedPublicKey, vault) {
  let bundle;
  try {
    bundle = openPluginPackagePromptOutputExternalCustodyBundle(
      value,
      trustedPublicKey,
    );
  } catch (cause) {
    fail(
      'QL3_VAULT_CUSTODY_BUNDLE_UNTRUSTED',
      'Custody receipt is untrusted',
      cause,
    );
  }
  try {
    const ciphertext = parseCiphertext(bundle.wrappedMaterial.toString('utf8'));
    if (
      bundle.receipt.wrappingProvider !== 'vault-transit' ||
      bundle.receipt.wrappingKeyRefDigest !==
        wrappingKeyReferenceDigest(vault, ciphertext.keyVersion)
    ) {
      fail(
        'QL3_VAULT_CUSTODY_BUNDLE_UNTRUSTED',
        'Custody bundle binding is untrusted',
      );
    }
    return Object.freeze({ ...bundle, ciphertext });
  } catch (cause) {
    bundle.wrappedMaterial.fill(0);
    if (
      cause instanceof VaultTransitPromptOutputCustodyError &&
      cause.code === 'QL3_VAULT_CUSTODY_BUNDLE_UNTRUSTED'
    ) {
      throw cause;
    }
    fail(
      'QL3_VAULT_CUSTODY_BUNDLE_UNTRUSTED',
      'Custody bundle is untrusted',
      cause,
    );
  }
}

function readBundle(filePath, trustedPublicKey, vault) {
  return normalizeBundle(
    readJsonFile(filePath, 'Custody bundle', MAX_BUNDLE_BYTES),
    trustedPublicKey,
    vault,
  );
}

function writeExclusive(filePath, bytes) {
  let descriptor;
  try {
    descriptor = openSync(
      absolutePath(filePath, 'Output file'),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o400,
    );
    fchmodSync(descriptor, 0o400);
    writeFileSync(descriptor, bytes);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function existingFile(filePath, options) {
  try {
    return readStableFile(filePath, options);
  } catch (cause) {
    if (cause.cause?.code === 'ENOENT') return null;
    throw cause;
  }
}

function vaultRequest(vault, operation, token, body) {
  const requestBody = Buffer.from(JSON.stringify(body), 'utf8');
  const ca =
    vault.caFile === null
      ? undefined
      : readStableFile(vault.caFile, {
          label: 'Vault CA file',
          minimumBytes: 32,
          maximumBytes: MAX_KEY_FILE_BYTES,
          privateFile: false,
        });
  const target = new URL(
    `/v1/${encodeURIComponent(
      vault.transitMount,
    )}/${operation}/${encodeURIComponent(vault.keyName)}`,
    vault.endpoint,
  );
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = transport.request(
        target,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'content-length': String(requestBody.byteLength),
            'x-vault-token': token,
          },
          ...(ca === undefined
            ? {}
            : {
                ca,
                rejectUnauthorized: true,
                ...(isIP(target.hostname) === 0
                  ? { servername: target.hostname }
                  : {}),
              }),
        },
        (response) => {
          const chunks = [];
          let length = 0;
          const disposeChunks = () =>
            chunks.splice(0).forEach((chunk) => chunk.fill(0));
          response.on('data', (chunk) => {
            length += chunk.byteLength;
            if (length > MAX_VAULT_RESPONSE_BYTES) {
              response.destroy(
                new VaultTransitPromptOutputCustodyError(
                  'QL3_VAULT_CUSTODY_RESPONSE_TOO_LARGE',
                  'Vault response is too large',
                ),
              );
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.once('error', (cause) => {
            disposeChunks();
            reject(cause);
          });
          response.on('end', () => {
            const bytes = Buffer.concat(chunks);
            disposeChunks();
            try {
              if (response.statusCode !== 200) {
                fail(
                  'QL3_VAULT_CUSTODY_REQUEST_REJECTED',
                  'Vault request was rejected',
                );
              }
              resolve(JSON.parse(bytes.toString('utf8')));
            } catch (cause) {
              reject(cause);
            } finally {
              bytes.fill(0);
            }
          });
        },
      );
    } catch (cause) {
      requestBody.fill(0);
      ca?.fill(0);
      reject(cause);
      return;
    }
    request.setTimeout(VAULT_TIMEOUT_MS, () => {
      request.destroy(
        new VaultTransitPromptOutputCustodyError(
          'QL3_VAULT_CUSTODY_REQUEST_TIMEOUT',
          'Vault request timed out',
        ),
      );
    });
    request.once('error', reject);
    request.once('close', () => {
      requestBody.fill(0);
      ca?.fill(0);
    });
    request.end(requestBody);
  });
}

function wrapMetadataMatches(receipt, command) {
  return (
    receipt.custodyId === command.custody.custodyId &&
    receipt.keyId === command.custody.keyId &&
    receipt.sourceGeneration === command.custody.sourceGeneration &&
    receipt.sourceCatalogDigest === command.custody.sourceCatalogDigest
  );
}

async function wrap(command, dependencies = {}) {
  const request = dependencies.request ?? vaultRequest;
  const now = dependencies.now ?? Date.now;
  const publicKey = readStableFile(
    command.custody.receiptSigningPublicKeyFile,
    {
      label: 'Receipt signing public key',
      minimumBytes: 32,
      maximumBytes: MAX_KEY_FILE_BYTES,
    },
  );
  let existing;
  try {
    const existingBytes = existingFile(command.bundleOutputFile, {
      label: 'Custody bundle output',
      minimumBytes: 2,
      maximumBytes: MAX_BUNDLE_BYTES,
    });
    if (existingBytes) {
      try {
        existing = normalizeBundle(
          JSON.parse(existingBytes.toString('utf8')),
          publicKey,
          command.vault,
        );
      } finally {
        existingBytes.fill(0);
      }
      if (!wrapMetadataMatches(existing.receipt, command)) {
        fail(
          'QL3_VAULT_CUSTODY_REPLAY_CONFLICT',
          'Existing custody bundle conflicts with the command',
        );
      }
      return Object.freeze({
        status: 'existing',
        receipt: existing.receipt,
        bundleDigest: existing.bundleDigest,
      });
    }
  } catch (cause) {
    publicKey.fill(0);
    throw cause;
  } finally {
    existing?.wrappedMaterial.fill(0);
    if (existing) publicKey.fill(0);
  }

  const material = readStableFile(command.materialFile, {
    label: 'Prompt output key material',
    minimumBytes: 32,
    maximumBytes: 32,
  });
  const privateKeyBytes = readStableFile(
    command.custody.receiptSigningPrivateKeyFile,
    {
      label: 'Receipt signing private key',
      minimumBytes: 32,
      maximumBytes: MAX_KEY_FILE_BYTES,
    },
  );
  let token;
  let wrappedMaterial;
  try {
    token = readToken(command.vault.tokenFile);
    const response = await request(command.vault, 'encrypt', token, {
      plaintext: material.toString('base64'),
    });
    const ciphertext = parseCiphertext(response?.data?.ciphertext);
    wrappedMaterial = Buffer.from(ciphertext.value, 'utf8');
    const privateKey = createPrivateKey(privateKeyBytes);
    const receipt = createPluginPackagePromptOutputExternalCustodyReceipt(
      {
        custodyId: command.custody.custodyId,
        keyId: command.custody.keyId,
        materialProof: pluginPackagePromptOutputKeyRotationMaterialProof(
          command.custody.keyId,
          material,
        ),
        sourceGeneration: command.custody.sourceGeneration,
        sourceCatalogDigest: command.custody.sourceCatalogDigest,
        wrappingProvider: 'vault-transit',
        wrappingKeyRefDigest: wrappingKeyReferenceDigest(
          command.vault,
          ciphertext.keyVersion,
        ),
        wrappedMaterialDigest: createHash('sha256')
          .update(wrappedMaterial)
          .digest('hex'),
        wrappedMaterialBytes: wrappedMaterial.byteLength,
        createdAtMs: timestamp(now(), 'Custody creation time'),
      },
      {
        publicKey,
        sign: (message) => sign(null, message, privateKey),
      },
    );
    const bundle = createPluginPackagePromptOutputExternalCustodyBundle(
      receipt,
      publicKey,
      wrappedMaterial,
    );
    const bytes = Buffer.from(`${JSON.stringify(bundle)}\n`, 'utf8');
    try {
      try {
        writeExclusive(command.bundleOutputFile, bytes);
      } catch (cause) {
        if (cause?.code !== 'EEXIST') throw cause;
        const winner = readBundle(
          command.bundleOutputFile,
          publicKey,
          command.vault,
        );
        try {
          if (
            !wrapMetadataMatches(winner.receipt, command) ||
            winner.receipt.materialProof !== receipt.materialProof
          ) {
            fail(
              'QL3_VAULT_CUSTODY_REPLAY_CONFLICT',
              'Concurrent custody bundle conflicts with the command',
            );
          }
          return Object.freeze({
            status: 'existing',
            receipt: winner.receipt,
            bundleDigest: winner.bundleDigest,
          });
        } finally {
          winner.wrappedMaterial.fill(0);
        }
      }
    } finally {
      bytes.fill(0);
    }
    return Object.freeze({
      status: 'completed',
      receipt,
      bundleDigest: bundle.bundleDigest,
    });
  } finally {
    material.fill(0);
    privateKeyBytes.fill(0);
    publicKey.fill(0);
    wrappedMaterial?.fill(0);
    token = undefined;
  }
}

function verifyRecoveredMaterial(material, receipt) {
  if (
    material.byteLength !== 32 ||
    pluginPackagePromptOutputKeyRotationMaterialProof(
      receipt.keyId,
      material,
    ) !== receipt.materialProof
  ) {
    fail(
      'QL3_VAULT_CUSTODY_RECOVERED_MATERIAL_UNTRUSTED',
      'Recovered material is untrusted',
    );
  }
}

async function unwrap(command, dependencies = {}) {
  const request = dependencies.request ?? vaultRequest;
  const publicKey = readStableFile(command.custodyPublicKeyFile, {
    label: 'Custody public key',
    minimumBytes: 32,
    maximumBytes: MAX_KEY_FILE_BYTES,
  });
  let bundle;
  let recovered;
  let token;
  try {
    bundle = readBundle(command.bundleFile, publicKey, command.vault);
    const existing = existingFile(command.recoveredMaterialOutputFile, {
      label: 'Recovered material output',
      minimumBytes: 32,
      maximumBytes: 32,
    });
    if (existing) {
      try {
        verifyRecoveredMaterial(existing, bundle.receipt);
      } finally {
        existing.fill(0);
      }
      return Object.freeze({ status: 'existing', receipt: bundle.receipt });
    }
    token = readToken(command.vault.tokenFile);
    const response = await request(command.vault, 'decrypt', token, {
      ciphertext: bundle.ciphertext.value,
    });
    if (typeof response?.data?.plaintext !== 'string') {
      fail(
        'QL3_VAULT_CUSTODY_RESPONSE_INVALID',
        'Vault plaintext response is invalid',
      );
    }
    recovered = Buffer.from(response.data.plaintext, 'base64');
    if (recovered.toString('base64') !== response.data.plaintext) {
      fail(
        'QL3_VAULT_CUSTODY_RESPONSE_INVALID',
        'Vault plaintext encoding is invalid',
      );
    }
    verifyRecoveredMaterial(recovered, bundle.receipt);
    try {
      writeExclusive(command.recoveredMaterialOutputFile, recovered);
      return Object.freeze({ status: 'completed', receipt: bundle.receipt });
    } catch (cause) {
      if (cause?.code !== 'EEXIST') throw cause;
      const winner = readStableFile(command.recoveredMaterialOutputFile, {
        label: 'Recovered material output',
        minimumBytes: 32,
        maximumBytes: 32,
      });
      try {
        verifyRecoveredMaterial(winner, bundle.receipt);
      } finally {
        winner.fill(0);
      }
      return Object.freeze({ status: 'existing', receipt: bundle.receipt });
    }
  } finally {
    publicKey.fill(0);
    bundle?.wrappedMaterial.fill(0);
    recovered?.fill(0);
    token = undefined;
  }
}

async function run(command, dependencies) {
  return command.operation === 'external.prompt-output-key.vault-transit.wrap'
    ? wrap(command, dependencies)
    : unwrap(command, dependencies);
}

function report(operation, result) {
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-external-vault-transit-prompt-output-custody',
    event:
      operation === 'external.prompt-output-key.vault-transit.wrap'
        ? 'custody_bundle_created'
        : 'custody_material_recovered',
    status: result.status,
    custodyId: result.receipt.custodyId,
    keyId: result.receipt.keyId,
    materialProof: result.receipt.materialProof,
    receiptDigest: result.receipt.receiptDigest,
    wrappedMaterialDigest: result.receipt.wrappedMaterialDigest,
    ...(result.bundleDigest === undefined
      ? {}
      : { bundleDigest: result.bundleDigest }),
  });
}

async function main(argv) {
  const usage =
    'Usage: ql3-vault-transit-prompt-output-custody <wrap|unwrap> --command-file /absolute/command.json';
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (
    argv.length !== 3 ||
    !['wrap', 'unwrap'].includes(argv[0]) ||
    argv[1] !== '--command-file' ||
    !argv[2]
  ) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_VAULT_CUSTODY_CLI_USAGE_INVALID',
        message: usage,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const command = readCommand(argv[2]);
    const expectedOperation = `external.prompt-output-key.vault-transit.${argv[0]}`;
    if (command.operation !== expectedOperation) {
      fail(
        'QL3_VAULT_CUSTODY_COMMAND_INVALID',
        'CLI and command operation differ',
      );
    }
    const result = await run(command);
    const output = report(command.operation, result);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (cause) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-external-vault-transit-prompt-output-custody',
        event: 'custody_operation_failed',
        name:
          typeof cause?.name === 'string' ? cause.name.slice(0, 128) : 'Error',
        ...(typeof cause?.code === 'string'
          ? { code: cause.code.slice(0, 128) }
          : {}),
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) void main(process.argv.slice(2));

module.exports = {
  BUNDLE_SCHEMA,
  VaultTransitPromptOutputCustodyError,
  normalizeBundle,
  readCommand,
  run,
  unwrap,
  vaultRequest,
  wrap,
  wrappingKeyReferenceDigest,
};
