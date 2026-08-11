const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  canonicalPluginPackagePromptOutputKeyringManifest,
  pluginPackagePromptOutputKeyringCatalogDigest,
} = require('@qinglong/ai/plugin-package-prompt-output-keyring-manifest');
const {
  PluginPackagePromptOutputKeyRetirementConflictError,
  PluginPackagePromptOutputKeyRetirementUnavailableError,
  createPluginPackagePromptOutputKeyRetirementPreparation,
} = require('@qinglong/ai/plugin-package-prompt-output-key-retirement');
const {
  createPluginPackagePromptOutputProjectedKeyring,
} = require('@qinglong/ai/plugin-package-prompt-output-projected-keyring');
const {
  ClusterPromptOutputKubernetesSecretKeyring,
  clusterPromptOutputKubernetesSecretKeyringMetadata,
} = require('../dist/prompt-output/key-management/promptOutputKubernetesSecretKeyring');

function copy(value) {
  return structuredClone(value);
}

function apiError(code) {
  return Object.assign(new Error(`Kubernetes API ${code}`), { code });
}

function initialManifest() {
  return Object.freeze({
    schema: 'qinglong/plugin-package-prompt-output-file-keyring@v1',
    generation: 2,
    activeKeyId: 'cluster-key-new',
    keys: Object.freeze({
      'cluster-key-old': Buffer.alloc(32, 7).toString('base64url'),
      'cluster-key-new': Buffer.alloc(32, 8).toString('base64url'),
    }),
    retirements: Object.freeze({}),
  });
}

function secret(manifest, resourceVersion = '1', uid = 'uid-keyring-1') {
  const metadata = clusterPromptOutputKubernetesSecretKeyringMetadata;
  const bytes = canonicalPluginPackagePromptOutputKeyringManifest(manifest);
  try {
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      immutable: false,
      metadata: {
        name: 'ql3-prompt-output-keyring',
        namespace: 'qinglong',
        uid,
        resourceVersion,
        labels: {
          [metadata.managedByLabel]: metadata.managedByValue,
          [metadata.keyringLabel]: metadata.keyringLabelValue,
        },
        annotations: {
          [metadata.generationAnnotation]: String(manifest.generation),
          [metadata.catalogDigestAnnotation]:
            pluginPackagePromptOutputKeyringCatalogDigest(manifest),
        },
      },
      data: { 'keyring.json': bytes.toString('base64') },
    };
  } finally {
    bytes.fill(0);
  }
}

class FakeSecretApi {
  constructor(value) {
    this.value = copy(value);
    this.writeCount = 0;
    this.replaceAttempts = 0;
    this.failAfterReplace = false;
  }

  async readNamespacedSecret({ namespace, name }) {
    if (
      namespace !== this.value.metadata.namespace ||
      name !== this.value.metadata.name
    ) {
      throw apiError(404);
    }
    return copy(this.value);
  }

  async replaceNamespacedSecret({ namespace, name, body }) {
    this.replaceAttempts += 1;
    if (
      namespace !== this.value.metadata.namespace ||
      name !== this.value.metadata.name
    ) {
      throw apiError(404);
    }
    if (body.metadata.resourceVersion !== this.value.metadata.resourceVersion) {
      throw apiError(409);
    }
    this.writeCount += 1;
    this.value = {
      ...copy(body),
      metadata: {
        ...copy(body.metadata),
        resourceVersion: String(Number(body.metadata.resourceVersion) + 1),
      },
    };
    if (this.failAfterReplace) {
      this.failAfterReplace = false;
      throw apiError(409);
    }
    return copy(this.value);
  }
}

class LostResponseSecretApi extends FakeSecretApi {
  failed = false;

  async replaceNamespacedSecret(request) {
    const written = await super.replaceNamespacedSecret(request);
    if (!this.failed) {
      this.failed = true;
      throw new Error('connection reset after Secret replacement');
    }
    return written;
  }
}

function keyring(api, uid = 'uid-keyring-1') {
  return new ClusterPromptOutputKubernetesSecretKeyring(api, {
    namespace: 'qinglong',
    secretName: 'ql3-prompt-output-keyring',
    expectedSecretUid: uid,
  });
}

async function preparation(authority) {
  const state = await authority.inspect('cluster-key-old');
  assert.equal(state.state, 'inactive');
  return createPluginPackagePromptOutputKeyRetirementPreparation({
    keyId: state.keyId,
    retirementId: 'retirement-1',
    requestId: 'request-1',
    mutationId: 'mutation-1',
    catalogDigest: state.catalogDigest,
    materialProof: state.materialProof,
    preparedAtMs: 1_000,
  });
}

test('resourceVersion-fenced Secret keyring retires material and exactly replays', async () => {
  const oldMaterial = initialManifest().keys['cluster-key-old'];
  const api = new FakeSecretApi(secret(initialManifest()));
  const authority = keyring(api);
  const prepared = await preparation(authority);

  const retired = await authority.retire({ preparation: prepared });
  assert.equal(retired.state, 'absent');
  assert.equal(
    (await authority.inspect('cluster-key-old')).absenceProof,
    retired.absenceProof,
  );
  assert.equal((await authority.inspect('cluster-key-new')).state, 'active');
  assert.equal(api.writeCount, 1);
  assert.equal(JSON.stringify(api.value).includes(oldMaterial), false);

  assert.deepEqual(await authority.retire({ preparation: prepared }), retired);
  assert.equal(api.writeCount, 1);
});

test('lost update response and concurrent exact retirement converge to one Secret write', async () => {
  const api = new FakeSecretApi(secret(initialManifest()));
  const authority = keyring(api);
  const prepared = await preparation(authority);
  api.failAfterReplace = true;

  const [left, right] = await Promise.all([
    authority.retire({ preparation: prepared }),
    authority.retire({ preparation: prepared }),
  ]);
  assert.deepEqual(left, right);
  assert.equal(api.writeCount, 1);
  assert.ok(api.replaceAttempts >= 1);
});

test('rejects active retirement and recreated or noncanonical Secret authority', async () => {
  const api = new FakeSecretApi(secret(initialManifest()));
  const authority = keyring(api);
  const active = await authority.inspect('cluster-key-new');
  assert.equal(active.state, 'active');
  const activePreparation =
    createPluginPackagePromptOutputKeyRetirementPreparation({
      keyId: active.keyId,
      retirementId: 'retirement-active',
      requestId: 'request-active',
      mutationId: 'mutation-active',
      catalogDigest: active.catalogDigest,
      materialProof: active.materialProof,
      preparedAtMs: 1_000,
    });
  await assert.rejects(
    authority.retire({ preparation: activePreparation }),
    PluginPackagePromptOutputKeyRetirementConflictError,
  );

  await assert.rejects(
    keyring(api, 'recreated-uid').inspect('cluster-key-old'),
    PluginPackagePromptOutputKeyRetirementUnavailableError,
  );
  api.value.metadata.annotations[
    'kubectl.kubernetes.io/last-applied-configuration'
  ] = '{}';
  await assert.rejects(
    authority.inspect('cluster-key-old'),
    PluginPackagePromptOutputKeyRetirementUnavailableError,
  );
});

test('retirement CAS and runtime projection consume one canonical Secret authority', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql3-cluster-keyring-projection-'),
  );
  const api = new FakeSecretApi(secret(initialManifest()));
  const authority = keyring(api);
  let generation = 0;
  const project = async () => {
    generation += 1;
    const generationName = `..2026_08_02_${generation}`;
    const directory = path.join(root, generationName);
    await fs.mkdir(directory, { mode: 0o750 });
    const bytes = Buffer.from(api.value.data['keyring.json'], 'base64');
    await fs.writeFile(path.join(directory, 'keyring.json'), bytes, {
      mode: 0o440,
    });
    bytes.fill(0);
    const next = path.join(root, '..data-next');
    await fs.symlink(generationName, next);
    await fs.rename(next, path.join(root, '..data'));
    try {
      await fs.symlink('..data/keyring.json', path.join(root, 'keyring.json'));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  };

  try {
    await project();
    const runtime = await createPluginPackagePromptOutputProjectedKeyring({
      rootDirectory: root,
    });
    assert.equal((await runtime.active()).keyId, 'cluster-key-new');
    const historical = await runtime.resolve('cluster-key-old');
    assert.ok(historical);
    historical.key.fill(0);

    const prepared = await preparation(authority);
    await authority.retire({ preparation: prepared });
    await project();

    assert.equal(await runtime.resolve('cluster-key-old'), null);
    const active = await runtime.active();
    assert.equal(active.keyId, 'cluster-key-new');
    assert.deepEqual(Buffer.from(active.key), Buffer.alloc(32, 8));
    active.key.fill(0);
    assert.equal(api.writeCount, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rotates externally staged material with one CAS and exact replay', async () => {
  const before = initialManifest();
  const api = new FakeSecretApi(secret(before));
  const authority = keyring(api);
  const staged = Buffer.alloc(32, 0x44);
  const command = {
    expectedActiveKeyId: before.activeKeyId,
    expectedCatalogDigest:
      pluginPackagePromptOutputKeyringCatalogDigest(before),
    newKeyId: 'cluster-key-next',
    material: staged,
  };
  const rotated = await authority.rotate(command);
  assert.equal(rotated.generation, 3);
  assert.equal(rotated.previousActiveKeyId, 'cluster-key-new');
  assert.equal(rotated.activeKeyId, 'cluster-key-next');
  assert.equal(api.writeCount, 1);
  assert.equal(
    JSON.stringify(rotated).includes(staged.toString('base64url')),
    false,
  );
  assert.deepEqual(staged, Buffer.alloc(32, 0x44));

  assert.deepEqual(await authority.rotate(command), rotated);
  assert.equal(api.writeCount, 1);
});

test('recovers rotation and retirement from ambiguous lost responses', async () => {
  const rotationManifest = initialManifest();
  const rotationApi = new LostResponseSecretApi(secret(rotationManifest));
  const rotated = await keyring(rotationApi).rotate({
    expectedActiveKeyId: rotationManifest.activeKeyId,
    expectedCatalogDigest:
      pluginPackagePromptOutputKeyringCatalogDigest(rotationManifest),
    newKeyId: 'cluster-key-next',
    material: Buffer.alloc(32, 0x55),
  });
  assert.equal(rotated.activeKeyId, 'cluster-key-next');
  assert.equal(rotationApi.writeCount, 1);

  const retirementApi = new LostResponseSecretApi(secret(initialManifest()));
  const retirementAuthority = keyring(retirementApi);
  const prepared = await preparation(retirementAuthority);
  assert.equal(
    (await retirementAuthority.retire({ preparation: prepared })).state,
    'absent',
  );
  assert.equal(retirementApi.writeCount, 1);
});

test('gives concurrent exact rotations one winner and rejects changed staged material', async () => {
  const before = initialManifest();
  const api = new FakeSecretApi(secret(before));
  const authority = keyring(api);
  const command = {
    expectedActiveKeyId: before.activeKeyId,
    expectedCatalogDigest:
      pluginPackagePromptOutputKeyringCatalogDigest(before),
    newKeyId: 'cluster-key-next',
    material: Buffer.alloc(32, 0x66),
  };
  const [left, right] = await Promise.all([
    authority.rotate(command),
    authority.rotate(command),
  ]);
  assert.deepEqual(left, right);
  assert.equal(api.writeCount, 1);
  await assert.rejects(
    authority.rotate({ ...command, material: Buffer.alloc(32, 0x77) }),
    PluginPackagePromptOutputKeyRetirementConflictError,
  );
});
