const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
  LocalPluginPackagePublisherTrustConfigurationError,
  LocalPluginPackagePublisherTrustConflictError,
  assertLocalPluginPackagePublisherKeyPublicationAllowed,
  confirmLocalPluginPackagePublisherKeyRevocation,
  inspectLocalPluginPackagePublisherTrust,
  localPluginPackagePublisherKeyRevocationImpactDigest,
  publishLocalPluginPackagePublisherTrust,
  proposeLocalPluginPackagePublisherKeyRevocation,
  retireLocalPluginPackagePublisherKey,
} = require('@qinglong/local-admin/package-publisher-trust');

function key(keyId, notBeforeMs = 0, notAfterMs = 1_000) {
  const { publicKey } = generateKeyPairSync('ed25519');
  return {
    publisher: 'packages.example.com',
    keyId,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
    notBeforeMs,
    notAfterMs,
  };
}

function trust(keys) {
  return {
    schema: LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
    keys,
  };
}

function fixture(t) {
  const unresolved = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-publisher-trust-'),
  );
  const trustRoot = fs.realpathSync(unresolved);
  fs.chmodSync(trustRoot, 0o700);
  t.after(() => fs.rmSync(trustRoot, { recursive: true, force: true }));
  return trustRoot;
}

test('provisions and overlap-rotates one immutable trust chain', async (t) => {
  const trustRoot = fixture(t);
  const first = key('release-1');
  const second = key('release-2', 50, 2_000);
  let fences = 0;

  const provisioned = await publishLocalPluginPackagePublisherTrust({
    trustRoot,
    mode: 'provision',
    expectedGeneration: 0,
    mutationId: 'trust-provision-v1',
    occurredAtMs: 100,
    trust: trust([first]),
    beforePublish() {
      fences += 1;
    },
  });
  assert.equal(provisioned.status, 'published');
  assert.equal(provisioned.generation, 1);
  assert.equal(
    fs.statSync(path.join(trustRoot, 'current.json')).mode & 0o777,
    0o600,
  );
  assert.deepEqual(
    inspectLocalPluginPackagePublisherTrust({
      trustRoot,
      observedAtMs: 100,
    }),
    {
      generation: 1,
      keyCount: 1,
      activeKeyCount: 1,
      snapshotCount: 1,
      retirementCount: 0,
      pendingRetirementCount: 0,
      revocationCount: 0,
      pendingRevocationCount: 0,
      quarantinedLockCount: 0,
      recoveryRequired: false,
      pendingGeneration: null,
      pendingMutationId: null,
      unresolvedTransactions: 0,
      trustDigest: provisioned.trustDigest,
    },
  );
  assert.equal(
    (
      await publishLocalPluginPackagePublisherTrust({
        trustRoot,
        mode: 'provision',
        expectedGeneration: 0,
        mutationId: 'trust-provision-v1',
        occurredAtMs: 100,
        trust: trust([first]),
        beforePublish() {
          fences += 1;
        },
      })
    ).status,
    'existing',
  );

  const rotated = await publishLocalPluginPackagePublisherTrust({
    trustRoot,
    mode: 'rotate',
    expectedGeneration: 1,
    mutationId: 'trust-rotate-v2',
    occurredAtMs: 100,
    trust: trust([second, first]),
    beforePublish() {
      fences += 1;
    },
  });
  assert.equal(rotated.status, 'published');
  assert.equal(rotated.generation, 2);
  assert.equal(rotated.keyCount, 2);
  assert.equal(fences, 3);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(trustRoot, 'current.json'), 'utf8'),
    ).keys.map((item) => item.keyId),
    ['release-1', 'release-2'],
  );

  await assert.rejects(
    publishLocalPluginPackagePublisherTrust({
      trustRoot,
      mode: 'rotate',
      expectedGeneration: 2,
      mutationId: 'trust-remove-v3',
      occurredAtMs: 100,
      trust: trust([second]),
    }),
    LocalPluginPackagePublisherTrustConfigurationError,
  );
});

test('exact replay promotes a snapshot left durable before current', async (t) => {
  const trustRoot = fixture(t);
  const first = key('release-1');
  const command = {
    trustRoot,
    mode: 'provision',
    expectedGeneration: 0,
    mutationId: 'trust-crash-v1',
    occurredAtMs: 100,
    trust: trust([first]),
  };
  await assert.rejects(
    publishLocalPluginPackagePublisherTrust({
      ...command,
      afterSnapshotPublished() {
        throw new Error('simulated current promotion failure');
      },
    }),
    /simulated current promotion failure/,
  );
  assert.equal(fs.existsSync(path.join(trustRoot, 'current.json')), false);
  assert.deepEqual(
    inspectLocalPluginPackagePublisherTrust({
      trustRoot,
      observedAtMs: 100,
    }),
    {
      generation: 0,
      keyCount: 0,
      activeKeyCount: 0,
      snapshotCount: 1,
      retirementCount: 0,
      pendingRetirementCount: 0,
      revocationCount: 0,
      pendingRevocationCount: 0,
      quarantinedLockCount: 0,
      recoveryRequired: true,
      pendingGeneration: 1,
      pendingMutationId: 'trust-crash-v1',
      unresolvedTransactions: 0,
      trustDigest: null,
    },
  );

  const recovered = await publishLocalPluginPackagePublisherTrust(command);
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.generation, 1);
  assert.equal(fs.existsSync(path.join(trustRoot, 'current.json')), true);
});

test('rejects broad roots, unknown files and non-overlap rotation', async (t) => {
  const trustRoot = fixture(t);
  const first = key('release-1');
  await publishLocalPluginPackagePublisherTrust({
    trustRoot,
    mode: 'provision',
    expectedGeneration: 0,
    mutationId: 'trust-provision-v1',
    occurredAtMs: 100,
    trust: trust([first]),
  });
  fs.writeFileSync(path.join(trustRoot, 'unknown'), '', { mode: 0o600 });
  assert.throws(
    () =>
      inspectLocalPluginPackagePublisherTrust({
        trustRoot,
        observedAtMs: 100,
      }),
    /unknown entries/,
  );
  fs.unlinkSync(path.join(trustRoot, 'unknown'));
  const overflow = Array.from({ length: 33 }, (_, index) =>
    path.join(
      trustRoot,
      `retirement-${index.toString(16).padStart(64, '0')}.json`,
    ),
  );
  for (const filePath of overflow) {
    fs.writeFileSync(filePath, '', { mode: 0o600 });
  }
  assert.throws(
    () =>
      inspectLocalPluginPackagePublisherTrust({
        trustRoot,
        observedAtMs: 100,
      }),
    /unbounded or unknown entries/,
  );
  for (const filePath of overflow) fs.unlinkSync(filePath);
  const revocationOverflow = Array.from({ length: 33 }, (_, index) =>
    path.join(
      trustRoot,
      `revocation-${index.toString(16).padStart(64, '0')}.json`,
    ),
  );
  for (const filePath of revocationOverflow) {
    fs.writeFileSync(filePath, '', { mode: 0o600 });
  }
  assert.throws(
    () =>
      inspectLocalPluginPackagePublisherTrust({
        trustRoot,
        observedAtMs: 100,
      }),
    /unbounded or unknown entries/,
  );
  for (const filePath of revocationOverflow) fs.unlinkSync(filePath);
  fs.chmodSync(trustRoot, 0o755);
  assert.throws(
    () =>
      inspectLocalPluginPackagePublisherTrust({
        trustRoot,
        observedAtMs: 100,
      }),
    /owner-only/,
  );
});

test('retires only an unreferenced key and exact replay recovers durable evidence', async (t) => {
  const trustRoot = fixture(t);
  const first = key('release-1');
  const second = key('release-2');
  await publishLocalPluginPackagePublisherTrust({
    trustRoot,
    mode: 'provision',
    expectedGeneration: 0,
    mutationId: 'trust-provision-v1',
    occurredAtMs: 100,
    trust: trust([first]),
  });
  await publishLocalPluginPackagePublisherTrust({
    trustRoot,
    mode: 'rotate',
    expectedGeneration: 1,
    mutationId: 'trust-rotate-v2',
    occurredAtMs: 100,
    trust: trust([first, second]),
  });
  const command = {
    trustRoot,
    expectedGeneration: 2,
    mutationId: 'trust-retire-v3',
    occurredAtMs: 100,
    publisher: first.publisher,
    keyId: first.keyId,
    proveRetirement() {
      return {
        catalogEntryCount: 0,
        bundleCount: 0,
        matchingEntryCount: 0,
        unresolvedTransactions: 0,
      };
    },
  };
  await assert.rejects(
    retireLocalPluginPackagePublisherKey({
      ...command,
      afterReceiptPublished() {
        throw new Error('simulated retirement snapshot failure');
      },
    }),
    /simulated retirement snapshot failure/,
  );
  assert.throws(
    () =>
      assertLocalPluginPackagePublisherKeyPublicationAllowed({
        trustRoot,
        publisher: first.publisher,
        keyId: first.keyId,
      }),
    LocalPluginPackagePublisherTrustConflictError,
  );
  assert.doesNotThrow(() =>
    assertLocalPluginPackagePublisherKeyPublicationAllowed({
      trustRoot,
      publisher: second.publisher,
      keyId: second.keyId,
    }),
  );
  const pending = inspectLocalPluginPackagePublisherTrust({
    trustRoot,
    observedAtMs: 100,
  });
  assert.equal(pending.recoveryRequired, true);
  assert.equal(pending.pendingRetirementCount, 1);
  assert.equal(pending.retirementCount, 0);

  const recovered = await retireLocalPluginPackagePublisherKey(command);
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.generation, 3);
  assert.equal(recovered.keyCount, 1);
  assert.equal(
    (await retireLocalPluginPackagePublisherKey(command)).status,
    'existing',
  );
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(trustRoot, 'current.json'), 'utf8'),
    ).keys.map((item) => item.keyId),
    ['release-2'],
  );
});

test('retirement intent blocks publication while catalog coverage remains', async (t) => {
  const trustRoot = fixture(t);
  const first = key('release-1');
  const second = key('release-2');
  await publishLocalPluginPackagePublisherTrust({
    trustRoot,
    mode: 'provision',
    expectedGeneration: 0,
    mutationId: 'trust-provision-v1',
    occurredAtMs: 100,
    trust: trust([first]),
  });
  await publishLocalPluginPackagePublisherTrust({
    trustRoot,
    mode: 'rotate',
    expectedGeneration: 1,
    mutationId: 'trust-rotate-v2',
    occurredAtMs: 100,
    trust: trust([first, second]),
  });
  const command = {
    trustRoot,
    expectedGeneration: 2,
    mutationId: 'trust-retire-blocked-v3',
    occurredAtMs: 100,
    publisher: first.publisher,
    keyId: first.keyId,
  };
  await assert.rejects(
    retireLocalPluginPackagePublisherKey({
      ...command,
      proveRetirement() {
        return {
          catalogEntryCount: 1,
          bundleCount: 1,
          matchingEntryCount: 1,
          unresolvedTransactions: 0,
        };
      },
    }),
    /still block retirement/,
  );
  assert.throws(
    () =>
      assertLocalPluginPackagePublisherKeyPublicationAllowed({
        trustRoot,
        publisher: first.publisher,
        keyId: first.keyId,
      }),
    /blocked by a durable lifecycle mutation/,
  );
  await assert.rejects(
    retireLocalPluginPackagePublisherKey({
      ...command,
      proveRetirement() {
        return {
          catalogEntryCount: 0,
          bundleCount: 0,
          matchingEntryCount: 0,
          unresolvedTransactions: 1,
        };
      },
    }),
    /still block retirement/,
  );
  const recovered = await retireLocalPluginPackagePublisherKey({
    ...command,
    proveRetirement() {
      return {
        catalogEntryCount: 0,
        bundleCount: 0,
        matchingEntryCount: 0,
        unresolvedTransactions: 0,
      };
    },
  });
  assert.equal(recovered.status, 'recovered');
});

test('blocks a compromised signer at proposal and requires dual-control confirmation', async (t) => {
  const trustRoot = fixture(t);
  const first = key('release-1');
  const second = key('release-2');
  await publishLocalPluginPackagePublisherTrust({
    trustRoot,
    mode: 'provision',
    expectedGeneration: 0,
    mutationId: 'trust-provision-v1',
    occurredAtMs: 100,
    trust: trust([first]),
  });
  await publishLocalPluginPackagePublisherTrust({
    trustRoot,
    mode: 'rotate',
    expectedGeneration: 1,
    mutationId: 'trust-rotate-v2',
    occurredAtMs: 100,
    trust: trust([first, second]),
  });
  const impactedLockDigests = ['a'.repeat(64)];
  const impact = {
    catalogEntryCount: 1,
    bundleCount: 1,
    matchingEntryCount: 1,
    unresolvedTransactions: 1,
    impactedLockDigests,
    impactDigest: localPluginPackagePublisherKeyRevocationImpactDigest({
      publisher: first.publisher,
      keyId: first.keyId,
      catalogEntryCount: 1,
      bundleCount: 1,
      matchingEntryCount: 1,
      unresolvedTransactions: 1,
      impactedLockDigests,
    }),
  };
  const proposalCommand = {
    trustRoot,
    expectedGeneration: 2,
    mutationId: 'trust-revoke-v3',
    occurredAtMs: 200,
    publisher: first.publisher,
    keyId: first.keyId,
    proposerSubjectId: 'owner-a',
    impact,
  };
  const proposed = await proposeLocalPluginPackagePublisherKeyRevocation(
    proposalCommand,
  );
  assert.equal(proposed.status, 'proposed');
  assert.equal(proposed.runtimeAction, 'stop_required');
  assert.equal(
    (await proposeLocalPluginPackagePublisherKeyRevocation(proposalCommand))
      .status,
    'existing',
  );
  assert.throws(
    () =>
      assertLocalPluginPackagePublisherKeyPublicationAllowed({
        trustRoot,
        publisher: first.publisher,
        keyId: first.keyId,
      }),
    /blocked by a durable lifecycle mutation/,
  );
  const pending = inspectLocalPluginPackagePublisherTrust({
    trustRoot,
    observedAtMs: 200,
  });
  assert.equal(pending.pendingRevocationCount, 1);
  assert.equal(pending.quarantinedLockCount, 1);
  assert.equal(pending.recoveryRequired, true);

  await assert.rejects(
    confirmLocalPluginPackagePublisherKeyRevocation({
      trustRoot,
      expectedGeneration: 2,
      mutationId: 'trust-revoke-v3',
      confirmedAtMs: 300,
      publisher: first.publisher,
      keyId: first.keyId,
      proposerSubjectId: 'owner-a',
      confirmerSubjectId: 'owner-a',
      authorizationMode: 'dual_control',
      reasonCode: 'confirmed_key_compromise',
      expectedImpactDigest: impact.impactDigest,
      confirmAuthorization() {},
    }),
    /distinct Owner/,
  );
  let authorizationFences = 0;
  const confirmation = {
    trustRoot,
    expectedGeneration: 2,
    mutationId: 'trust-revoke-v3',
    confirmedAtMs: 300,
    publisher: first.publisher,
    keyId: first.keyId,
    proposerSubjectId: 'owner-a',
    confirmerSubjectId: 'owner-b',
    authorizationMode: 'dual_control',
    reasonCode: 'confirmed_key_compromise',
    expectedImpactDigest: impact.impactDigest,
    confirmAuthorization() {
      authorizationFences += 1;
    },
  };
  await assert.rejects(
    confirmLocalPluginPackagePublisherKeyRevocation({
      ...confirmation,
      afterSnapshotPublished() {
        throw new Error('simulated revocation promotion failure');
      },
    }),
    /simulated revocation promotion failure/,
  );
  const recovered = await confirmLocalPluginPackagePublisherKeyRevocation(
    confirmation,
  );
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.generation, 3);
  assert.equal(recovered.keyCount, 1);
  assert.equal(recovered.quarantinedLockCount, 1);
  assert.equal(recovered.runtimeAction, 'restart_required');
  assert.equal(
    (await confirmLocalPluginPackagePublisherKeyRevocation(confirmation))
      .status,
    'existing',
  );
  assert.equal(authorizationFences, 3);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(trustRoot, 'current.json'), 'utf8'),
    ).keys.map((item) => item.keyId),
    ['release-2'],
  );
  assert.throws(
    () =>
      assertLocalPluginPackagePublisherKeyPublicationAllowed({
        trustRoot,
        publisher: first.publisher,
        keyId: first.keyId,
      }),
    /blocked by a durable lifecycle mutation/,
  );
});
