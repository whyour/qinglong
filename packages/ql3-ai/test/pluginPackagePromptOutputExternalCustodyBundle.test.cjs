const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { test } = require('node:test');

const {
  PLUGIN_PACKAGE_PROMPT_OUTPUT_EXTERNAL_CUSTODY_BUNDLE_SCHEMA,
  createPluginPackagePromptOutputExternalCustodyBundle,
  openPluginPackagePromptOutputExternalCustodyBundle,
} = require('../dist/prompt-output/custody/pluginPackagePromptOutputExternalCustodyBundle.js');
const {
  InvalidPluginPackagePromptOutputExternalCustodyError,
  PluginPackagePromptOutputExternalCustodyUntrustedError,
  createPluginPackagePromptOutputExternalCustodyReceipt,
} = require('../dist/prompt-output/custody/pluginPackagePromptOutputExternalCustody.js');

function fixture(byte = 0x51) {
  const keys = generateKeyPairSync('ed25519');
  const wrappedMaterial = Buffer.from(`external-provider-wrapped-${byte}`);
  const receipt = createPluginPackagePromptOutputExternalCustodyReceipt(
    {
      custodyId: 'provider-neutral-custody-001',
      keyId: 'prompt-output-key-001',
      materialProof: '1'.repeat(64),
      sourceGeneration: 3,
      sourceCatalogDigest: '2'.repeat(64),
      wrappingProvider: 'external-kms',
      wrappingKeyRefDigest: '3'.repeat(64),
      wrappedMaterialDigest: createHash('sha256')
        .update(wrappedMaterial)
        .digest('hex'),
      wrappedMaterialBytes: wrappedMaterial.byteLength,
      createdAtMs: 1_700_000_000_000,
    },
    {
      publicKey: keys.publicKey,
      sign: (message) => sign(null, message, keys.privateKey),
    },
  );
  const bundle = createPluginPackagePromptOutputExternalCustodyBundle(
    receipt,
    keys.publicKey,
    wrappedMaterial,
  );
  return { keys, wrappedMaterial, receipt, bundle };
}

test('creates and opens one provider-neutral atomic custody bundle', () => {
  const value = fixture();
  const opened = openPluginPackagePromptOutputExternalCustodyBundle(
    value.bundle,
    value.keys.publicKey,
  );
  try {
    assert.equal(
      value.bundle.schema,
      PLUGIN_PACKAGE_PROMPT_OUTPUT_EXTERNAL_CUSTODY_BUNDLE_SCHEMA,
    );
    assert.equal(opened.bundleDigest, value.bundle.bundleDigest);
    assert.equal(opened.receipt.receiptDigest, value.receipt.receiptDigest);
    assert.deepEqual(opened.wrappedMaterial, value.wrappedMaterial);
  } finally {
    opened.wrappedMaterial.fill(0);
  }
});

test('rejects split-file substitution even when the receipt remains valid', () => {
  const left = fixture(0x51);
  const right = fixture(0x52);
  assert.throws(
    () =>
      openPluginPackagePromptOutputExternalCustodyBundle(
        { ...left.bundle, wrappedMaterial: right.bundle.wrappedMaterial },
        left.keys.publicKey,
      ),
    PluginPackagePromptOutputExternalCustodyUntrustedError,
  );
});

test('rejects bundle digest drift and extra fields', () => {
  const value = fixture();
  assert.throws(
    () =>
      openPluginPackagePromptOutputExternalCustodyBundle(
        { ...value.bundle, bundleDigest: '4'.repeat(64) },
        value.keys.publicKey,
      ),
    PluginPackagePromptOutputExternalCustodyUntrustedError,
  );
  assert.throws(
    () =>
      openPluginPackagePromptOutputExternalCustodyBundle(
        { ...value.bundle, providerConfig: 'must-not-be-embedded' },
        value.keys.publicKey,
      ),
    InvalidPluginPackagePromptOutputExternalCustodyError,
  );
});

test('rejects a valid bundle under a different custody signing authority', () => {
  const value = fixture();
  const other = generateKeyPairSync('ed25519');
  assert.throws(
    () =>
      openPluginPackagePromptOutputExternalCustodyBundle(
        value.bundle,
        other.publicKey,
      ),
    PluginPackagePromptOutputExternalCustodyUntrustedError,
  );
});
