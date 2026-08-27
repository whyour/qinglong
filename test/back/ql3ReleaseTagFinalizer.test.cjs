'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  PUBLICATION_PLAN_SCHEMA,
} = require('../../scripts/ql3-release-publication-closure-contract.cjs');
const {
  SCHEMA: DEPLOYMENT_READINESS_SCHEMA,
} = require('../../scripts/ql3-release-deployment-readiness-contract.cjs');
const {
  RELEASE_SET_SCHEMA,
} = require('../../scripts/ql3-release-set-contract.cjs');
const {
  MAX_INVENTORY_BYTES,
  auditReleaseTags,
  createRegctlAdapter,
  finalizeReleaseTags,
  parseArguments,
  runCli,
} = require('../../scripts/ql3-release-tag-finalizer.cjs');

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function publicationPlan() {
  const version = '3.0.0-alpha.0';
  const sourceRevision = 'a'.repeat(40);
  const repository = 'ghcr.io/qinglong-release/qinglong3-local-application';
  const operatorRepository =
    'ghcr.io/qinglong-release/qinglong3-local-operator';
  const imageDigest = `sha256:${'1'.repeat(64)}`;
  const operatorDigest = `sha256:${'9'.repeat(64)}`;
  const manifestDigest = `sha256:${'2'.repeat(64)}`;
  const unsigned = {
    schemaVersion: 1,
    schema: PUBLICATION_PLAN_SCHEMA,
    release: {
      version,
      sourceRevision,
      sourceRef: `refs/tags/v${version}`,
      scope: 'local',
    },
    releaseSet: {
      schema: RELEASE_SET_SCHEMA,
      releaseSetDigest: `sha256:${'3'.repeat(64)}`,
      contentDigest: `sha256:${'4'.repeat(64)}`,
    },
    catalog: {
      planDigest: `sha256:${'5'.repeat(64)}`,
      receiptDigest: `sha256:${'6'.repeat(64)}`,
      manifestDigest,
      immutableReference: `ghcr.io/qinglong-release/qinglong3-release-catalog@${manifestDigest}`,
    },
    deploymentReadiness: {
      schema: DEPLOYMENT_READINESS_SCHEMA,
      receiptDigest: `sha256:${'7'.repeat(64)}`,
      finalizerConsumptionDigest: `sha256:${'8'.repeat(64)}`,
      requiredDeploymentFamilies: ['local'],
    },
    requiredPrerequisites: {
      releaseSetProvenance: 'attested_before_catalog_publication',
      catalogSignature: 'verified_exact_workflow_identity',
      catalogProvenance: 'verified_source_tag_and_revision',
      catalogReceipt: 'attested_before_deployment_gates',
      deploymentReadiness: 'scope_exact_receipt_attested_before_tag_promotion',
    },
    promotionPolicy: {
      authority: 'verified_catalog_bound_deployments',
      inventory: 'bounded_exact_repository_tags',
      conflict: 'fail_closed_before_any_tag_mutation',
      recovery: 'reuse_exact_digest_only',
      finalVerification: 'all_tags_exact_digest',
      crossRepositoryAtomicity: false,
      registryTagCas: false,
    },
    images: [
      {
        name: 'local',
        registryRepository: repository,
        immutableReference: `${repository}@${imageDigest}`,
        digest: imageDigest,
        tags: [
          { kind: 'version', reference: `${repository}:${version}` },
          {
            kind: 'source',
            reference: `${repository}:sha-${sourceRevision}`,
          },
        ],
      },
      {
        name: 'local-operator',
        registryRepository: operatorRepository,
        immutableReference: `${operatorRepository}@${operatorDigest}`,
        digest: operatorDigest,
        tags: [
          {
            kind: 'version',
            reference: `${operatorRepository}:${version}`,
          },
          {
            kind: 'source',
            reference: `${operatorRepository}:sha-${sourceRevision}`,
          },
        ],
      },
    ],
  };
  return Object.freeze({
    ...unsigned,
    planDigest: sha256(JSON.stringify(unsigned)),
  });
}

function splitTag(reference) {
  const separator = reference.lastIndexOf(':');
  return [reference.slice(0, separator), reference.slice(separator + 1)];
}

class FakeRegistry {
  constructor(plan) {
    this.sources = new Map(
      plan.images.map((image) => [image.immutableReference, image.digest]),
    );
    this.repositories = new Map(
      plan.images.map((image) => [image.registryRepository, new Map()]),
    );
    this.calls = [];
    this.inventoryOverride = undefined;
    this.copyFailureAfterWrite = false;
    this.copyDrift = false;
  }

  resolveDigest(reference) {
    this.calls.push(['resolveDigest', reference]);
    if (reference.includes('@')) return this.sources.get(reference);
    const [repository, tag] = splitTag(reference);
    return this.repositories.get(repository)?.get(tag);
  }

  listTags(repository) {
    this.calls.push(['listTags', repository]);
    if (this.inventoryOverride !== undefined) return this.inventoryOverride;
    const tags = [...(this.repositories.get(repository)?.keys() ?? [])].sort();
    return tags.length === 0 ? '' : `${tags.join('\n')}\n`;
  }

  copyImage(source, target) {
    this.calls.push(['copyImage', source, target]);
    const [repository, tag] = splitTag(target);
    const digest = this.copyDrift
      ? `sha256:${'f'.repeat(64)}`
      : this.sources.get(source);
    this.repositories.get(repository).set(tag, digest);
    if (this.copyFailureAfterWrite) {
      this.copyFailureAfterWrite = false;
      throw new Error('simulated response loss');
    }
  }

  seed(reference, digest) {
    const [repository, tag] = splitTag(reference);
    this.repositories.get(repository).set(tag, digest);
  }

  copyCalls() {
    return this.calls.filter(([operation]) => operation === 'copyImage');
  }
}

function temporaryDirectory(t) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-release-tag-finalizer-')),
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeCanonical(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
}

test('finalizes every exact tag and audits the live terminal state', () => {
  const plan = publicationPlan();
  const registry = new FakeRegistry(plan);
  const observation = finalizeReleaseTags(plan, registry);
  assert.equal(registry.copyCalls().length, 4);
  assert.equal(observation.tags.length, 4);
  assert.equal(
    observation.tags.every(
      (tag) =>
        tag.digest ===
        plan.images.find((image) => image.name === tag.image)?.digest,
    ),
    true,
  );
  const copiesBeforeAudit = registry.copyCalls().length;
  assert.deepEqual(auditReleaseTags(plan, observation, registry), {
    schemaVersion: 1,
    planDigest: plan.planDigest,
    observationDigest: observation.observationDigest,
    tagCount: 4,
    allTagsExactDigest: true,
    registryMutation: false,
    compatible: true,
  });
  assert.equal(registry.copyCalls().length, copiesBeforeAudit);
});

test('validates the complete plan before any registry observation or mutation', () => {
  const plan = structuredClone(publicationPlan());
  plan.images[0].tags[0].reference =
    'ghcr.io/attacker/other-repository:3.0.0-alpha.0';
  const { planDigest: _discarded, ...unsigned } = plan;
  plan.planDigest = sha256(JSON.stringify(unsigned));
  const registry = new FakeRegistry(publicationPlan());
  assert.throws(
    () => finalizeReleaseTags(plan, registry),
    /publication plan tag is invalid/,
  );
  assert.deepEqual(registry.calls, []);
});

test('preflights every conflict before the first tag mutation', () => {
  const plan = publicationPlan();
  const registry = new FakeRegistry(plan);
  registry.seed(plan.images[0].tags[1].reference, `sha256:${'e'.repeat(64)}`);
  assert.throws(
    () => finalizeReleaseTags(plan, registry),
    /already points at another digest/,
  );
  assert.equal(registry.copyCalls().length, 0);
});

test('recovers copy response loss by reusing exact tags and only filling absence', () => {
  const plan = publicationPlan();
  const registry = new FakeRegistry(plan);
  registry.copyFailureAfterWrite = true;
  assert.throws(
    () => finalizeReleaseTags(plan, registry),
    /simulated response loss/,
  );
  assert.equal(registry.copyCalls().length, 1);
  const observation = finalizeReleaseTags(plan, registry);
  assert.equal(registry.copyCalls().length, 4);
  assert.equal(observation.tags.length, 4);
  assert.equal(
    registry.resolveDigest(plan.images[0].tags[0].reference),
    plan.images[0].digest,
  );
});

test('rejects malformed or unbounded inventory before mutation', () => {
  for (const inventory of [
    'duplicate\nduplicate\n',
    'not canonical',
    `${'x'.repeat(MAX_INVENTORY_BYTES + 1)}\n`,
  ]) {
    const plan = publicationPlan();
    const registry = new FakeRegistry(plan);
    registry.inventoryOverride = inventory;
    assert.throws(
      () => finalizeReleaseTags(plan, registry),
      /inventory is malformed|inventory is invalid or unbounded/,
    );
    assert.equal(registry.copyCalls().length, 0);
  }
});

test('fails terminal observation when a copy resolves to the wrong digest', () => {
  const plan = publicationPlan();
  const registry = new FakeRegistry(plan);
  registry.copyDrift = true;
  assert.throws(
    () => finalizeReleaseTags(plan, registry),
    /promoted tag does not resolve/,
  );
});

test('runs canonical private no-replace finalize and read-only audit stages', (t) => {
  const directory = temporaryDirectory(t);
  const plan = publicationPlan();
  const registry = new FakeRegistry(plan);
  const planPath = path.join(directory, 'plan.json');
  const observationPath = path.join(directory, 'observation.json');
  writeCanonical(planPath, plan);
  const output = { write() {} };
  const observation = runCli(
    [
      '--mode=finalize',
      `--plan=${planPath}`,
      '--regctl=/unused/injected-regctl',
      `--output=${observationPath}`,
    ],
    output,
    { registry },
  );
  assert.equal(fs.statSync(observationPath).mode & 0o777, 0o600);
  assert.equal(
    fs.readFileSync(observationPath, 'utf8'),
    `${JSON.stringify(observation)}\n`,
  );
  const audit = runCli(
    [
      '--mode=audit',
      `--plan=${planPath}`,
      '--regctl=/unused/injected-regctl',
      `--observation=${observationPath}`,
    ],
    output,
    { registry },
  );
  assert.equal(audit.compatible, true);
  assert.equal(audit.registryMutation, false);
  assert.throws(
    () =>
      runCli(
        [
          '--mode=finalize',
          `--plan=${planPath}`,
          '--regctl=/unused/injected-regctl',
          `--output=${observationPath}`,
        ],
        output,
        { registry },
      ),
    /output must be published once/,
  );
});

test('accepts only closed CLI modes and a hardened regctl executable', (t) => {
  assert.deepEqual(
    parseArguments([
      '--mode=finalize',
      '--plan=/private/plan.json',
      '--regctl=/private/regctl',
      '--output=/private/observation.json',
    ]),
    {
      mode: 'finalize',
      plan: '/private/plan.json',
      regctl: '/private/regctl',
      output: '/private/observation.json',
    },
  );
  for (const argv of [
    ['--mode=finalize', '--plan=/p', '--regctl=/r'],
    [
      '--mode=audit',
      '--plan=/p',
      '--regctl=/r',
      '--observation=/o',
      '--force=true',
    ],
    ['--mode=unknown', '--plan=/p', '--regctl=/r', '--output=/o'],
  ]) {
    assert.throws(() => parseArguments(argv), /usage/);
  }

  const directory = temporaryDirectory(t);
  const executable = path.join(directory, 'regctl');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const pinnedAdapter = createRegctlAdapter(executable);
  assert.equal(typeof pinnedAdapter.resolveDigest, 'function');
  fs.chmodSync(executable, 0o700);
  assert.throws(
    () => pinnedAdapter.resolveDigest('ghcr.io/example/image@sha256:digest'),
    /identity changed/,
  );
  fs.chmodSync(executable, 0o775);
  assert.throws(() => createRegctlAdapter(executable), /non-writable/);
  fs.chmodSync(executable, 0o755);
  const alias = path.join(directory, 'regctl-alias');
  fs.symlinkSync(executable, alias);
  assert.throws(() => createRegctlAdapter(alias), /non-writable/);
});
