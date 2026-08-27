#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  RELEASE_SET_SCHEMA,
  inspectReleaseSet,
} = require('./ql3-release-set-contract.cjs');
const {
  auditCatalogPlan,
  auditCatalogReceipt,
} = require('./ql3-release-catalog-contract.cjs');
const {
  SCHEMA: DEPLOYMENT_READINESS_SCHEMA,
  validateDeploymentReadinessReceipt,
} = require('./ql3-release-deployment-readiness-contract.cjs');

const PUBLICATION_PLAN_SCHEMA = 'qinglong/release-publication-plan@v2';
const TAG_OBSERVATION_SCHEMA =
  'qinglong/release-publication-tag-observation@v1';
const CLOSURE_RECEIPT_SCHEMA =
  'qinglong/release-publication-closure-receipt@v2';
const MAX_JSON_BYTES = 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/u;
const REGISTRY_REPOSITORY_PATTERN =
  /^ghcr\.io\/[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]{1,100}$/u;
const REQUIRED_PREREQUISITES = Object.freeze({
  releaseSetProvenance: 'attested_before_catalog_publication',
  catalogSignature: 'verified_exact_workflow_identity',
  catalogProvenance: 'verified_source_tag_and_revision',
  catalogReceipt: 'attested_before_deployment_gates',
  deploymentReadiness: 'scope_exact_receipt_attested_before_tag_promotion',
});
const PROMOTION_POLICY = Object.freeze({
  authority: 'verified_catalog_bound_deployments',
  inventory: 'bounded_exact_repository_tags',
  conflict: 'fail_closed_before_any_tag_mutation',
  recovery: 'reuse_exact_digest_only',
  finalVerification: 'all_tags_exact_digest',
  crossRepositoryAtomicity: false,
  registryTagCas: false,
});
const CLOSURE_VERIFICATION = Object.freeze({
  authority: 'verified_catalog_bound_deployments',
  catalogReadyBeforeTagMutation: true,
  deploymentReadyBeforeTagMutation: true,
  allTagsExactDigest: true,
  inventory: 'bounded_exact_repository_tags',
  conflict: 'fail_closed_before_any_tag_mutation',
  recovery: 'reuse_exact_digest_only',
  crossRepositoryAtomicity: false,
  registryTagCas: false,
});

class QingLong3ReleasePublicationClosureError extends Error {
  constructor(message) {
    super(`QingLong 3 release publication closure failed: ${message}`);
    this.name = 'QingLong3ReleasePublicationClosureError';
  }
}

function fail(message) {
  throw new QingLong3ReleasePublicationClosureError(message);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected)
  );
}

function resolveCanonicalAbsolute(input, label) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    fail(`${label} path must be absolute`);
  }
  const resolved = path.resolve(input);
  if (resolved !== input) fail(`${label} path must be normalized`);
  return resolved;
}

function readBoundedFile(filePath, label) {
  const resolved = resolveCanonicalAbsolute(filePath, label);
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > MAX_JSON_BYTES ||
    fs.realpathSync(resolved) !== resolved ||
    fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved)
  ) {
    fail(`${label} must be one bounded canonical regular file`);
  }
  return { contents: fs.readFileSync(resolved, 'utf8'), resolved };
}

function parseJson(contents, label, requireCanonical = true) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    fail(`${label} must contain valid JSON`);
  }
  if (requireCanonical && canonicalJson(value) !== contents) {
    fail(`${label} must use canonical JSON encoding`);
  }
  return value;
}

function readCanonicalJson(filePath, label) {
  return parseJson(readBoundedFile(filePath, label).contents, label);
}

function writeNoReplace(filePath, value) {
  const resolved = resolveCanonicalAbsolute(filePath, 'output');
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    fs.realpathSync(parent) !== parent
  ) {
    fail('output parent must be one canonical directory');
  }
  const descriptor = fs.openSync(resolved, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, canonicalJson(value));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateIdentityOptions(options) {
  for (const key of [
    'version',
    'sourceRevision',
    'sourceRef',
    'releaseScope',
    'repositoryOwner',
    'sourceRepository',
  ]) {
    if (typeof options[key] !== 'string' || options[key].length === 0) {
      fail('release identity options are incomplete');
    }
  }
}

function createPublicationPlan(
  releaseSet,
  catalogPlan,
  catalogReceipt,
  deploymentReadiness,
  catalogManifestContents,
  catalogManifestDigest,
  options,
) {
  validateIdentityOptions(options);
  inspectReleaseSet(releaseSet, options);
  auditCatalogPlan(catalogPlan, releaseSet, options);
  auditCatalogReceipt(
    catalogReceipt,
    catalogPlan,
    catalogManifestContents,
    catalogManifestDigest,
  );
  validateDeploymentReadinessReceipt(deploymentReadiness, {
    release: releaseSet.release,
    sourceRepository: options.sourceRepository,
    releaseSetDigest: releaseSet.releaseSetDigest,
    catalogManifestDigest,
    immutableReference: catalogReceipt.catalog.immutableReference,
  });
  const images = releaseSet.images.map((image) => {
    const registryRepository = image.reference.slice(
      0,
      image.reference.lastIndexOf('@'),
    );
    return {
      name: image.name,
      registryRepository,
      immutableReference: image.reference,
      digest: image.digest,
      tags: [
        { kind: 'version', reference: image.versionTag },
        { kind: 'source', reference: image.sourceTag },
      ],
    };
  });
  const unsigned = {
    schemaVersion: 1,
    schema: PUBLICATION_PLAN_SCHEMA,
    release: { ...releaseSet.release },
    releaseSet: {
      schema: RELEASE_SET_SCHEMA,
      releaseSetDigest: releaseSet.releaseSetDigest,
      contentDigest: sha256(canonicalJson(releaseSet)),
    },
    catalog: {
      planDigest: catalogPlan.planDigest,
      receiptDigest: catalogReceipt.receiptDigest,
      manifestDigest: catalogManifestDigest,
      immutableReference: catalogReceipt.catalog.immutableReference,
    },
    deploymentReadiness: {
      schema: DEPLOYMENT_READINESS_SCHEMA,
      receiptDigest: deploymentReadiness.receiptDigest,
      finalizerConsumptionDigest:
        deploymentReadiness.catalog.finalizerConsumptionDigest,
      requiredDeploymentFamilies: [
        ...deploymentReadiness.requiredDeploymentFamilies,
      ],
    },
    requiredPrerequisites: { ...REQUIRED_PREREQUISITES },
    promotionPolicy: { ...PROMOTION_POLICY },
    images,
  };
  return Object.freeze({
    ...unsigned,
    planDigest: sha256(JSON.stringify(unsigned)),
  });
}

function validatePublicationPlan(plan) {
  if (
    !exactKeys(plan, [
      'schemaVersion',
      'schema',
      'release',
      'releaseSet',
      'catalog',
      'deploymentReadiness',
      'requiredPrerequisites',
      'promotionPolicy',
      'images',
      'planDigest',
    ]) ||
    plan.schemaVersion !== 1 ||
    plan.schema !== PUBLICATION_PLAN_SCHEMA ||
    !DIGEST_PATTERN.test(plan.planDigest || '') ||
    !exactKeys(plan.release, [
      'version',
      'sourceRevision',
      'sourceRef',
      'scope',
    ]) ||
    typeof plan.release.version !== 'string' ||
    plan.release.version.length < 1 ||
    plan.release.version.length > 64 ||
    !SOURCE_REVISION_PATTERN.test(plan.release.sourceRevision || '') ||
    plan.release.sourceRef !== `refs/tags/v${plan.release.version}` ||
    !['local', 'cluster', 'all'].includes(plan.release.scope) ||
    !exactKeys(plan.releaseSet, [
      'schema',
      'releaseSetDigest',
      'contentDigest',
    ]) ||
    plan.releaseSet.schema !== RELEASE_SET_SCHEMA ||
    !DIGEST_PATTERN.test(plan.releaseSet.releaseSetDigest || '') ||
    !DIGEST_PATTERN.test(plan.releaseSet.contentDigest || '') ||
    !exactKeys(plan.catalog, [
      'planDigest',
      'receiptDigest',
      'manifestDigest',
      'immutableReference',
    ]) ||
    !DIGEST_PATTERN.test(plan.catalog.planDigest || '') ||
    !DIGEST_PATTERN.test(plan.catalog.receiptDigest || '') ||
    !DIGEST_PATTERN.test(plan.catalog.manifestDigest || '') ||
    typeof plan.catalog.immutableReference !== 'string' ||
    !plan.catalog.immutableReference.endsWith(
      `@${plan.catalog.manifestDigest}`,
    ) ||
    !exactKeys(plan.deploymentReadiness, [
      'schema',
      'receiptDigest',
      'finalizerConsumptionDigest',
      'requiredDeploymentFamilies',
    ]) ||
    plan.deploymentReadiness.schema !== DEPLOYMENT_READINESS_SCHEMA ||
    !DIGEST_PATTERN.test(plan.deploymentReadiness.receiptDigest || '') ||
    !DIGEST_PATTERN.test(
      plan.deploymentReadiness.finalizerConsumptionDigest || '',
    ) ||
    JSON.stringify(plan.deploymentReadiness.requiredDeploymentFamilies) !==
      JSON.stringify(
        plan.release.scope === 'local'
          ? ['local']
          : plan.release.scope === 'cluster'
          ? ['cluster']
          : ['local', 'cluster'],
      ) ||
    JSON.stringify(plan.requiredPrerequisites) !==
      JSON.stringify(REQUIRED_PREREQUISITES) ||
    JSON.stringify(plan.promotionPolicy) !== JSON.stringify(PROMOTION_POLICY) ||
    !Array.isArray(plan.images) ||
    plan.images.length !==
      (plan.release.scope === 'local'
        ? 2
        : plan.release.scope === 'cluster'
        ? 4
        : 6)
  ) {
    fail('publication plan shape is invalid');
  }
  const { planDigest, ...unsigned } = plan;
  if (planDigest !== sha256(JSON.stringify(unsigned))) {
    fail('publication plan digest is invalid');
  }
  const references = [];
  const names = [];
  const repositories = [];
  for (const image of plan.images) {
    if (
      !exactKeys(image, [
        'name',
        'registryRepository',
        'immutableReference',
        'digest',
        'tags',
      ]) ||
      !/^[a-z][a-z0-9-]{0,31}$/u.test(image.name || '') ||
      !REGISTRY_REPOSITORY_PATTERN.test(image.registryRepository || '') ||
      image.immutableReference !==
        `${image.registryRepository}@${image.digest}` ||
      !DIGEST_PATTERN.test(image.digest || '') ||
      !Array.isArray(image.tags) ||
      image.tags.length !== 2
    ) {
      fail('publication plan image is invalid');
    }
    names.push(image.name);
    repositories.push(image.registryRepository);
    for (let index = 0; index < image.tags.length; index += 1) {
      const tag = image.tags[index];
      const kind = index === 0 ? 'version' : 'source';
      const expectedReference =
        kind === 'version'
          ? `${image.registryRepository}:${plan.release.version}`
          : `${image.registryRepository}:sha-${plan.release.sourceRevision}`;
      if (
        !exactKeys(tag, ['kind', 'reference']) ||
        tag.kind !== kind ||
        tag.reference !== expectedReference
      ) {
        fail('publication plan tag is invalid');
      }
      references.push(tag.reference);
    }
  }
  if (
    new Set(references).size !== references.length ||
    new Set(names).size !== names.length ||
    new Set(repositories).size !== repositories.length
  ) {
    fail('publication plan contains duplicate images or tags');
  }
  return plan;
}

function expectedObservedTags(plan) {
  return plan.images.flatMap((image) =>
    image.tags.map((tag) => ({
      image: image.name,
      kind: tag.kind,
      reference: tag.reference,
      digest: image.digest,
    })),
  );
}

function createPublicationTagObservation(plan, observedTags) {
  validatePublicationPlan(plan);
  if (
    !Array.isArray(observedTags) ||
    JSON.stringify(observedTags) !== JSON.stringify(expectedObservedTags(plan))
  ) {
    fail('publication tag observations differ from the exact plan');
  }
  const unsigned = {
    schemaVersion: 1,
    schema: TAG_OBSERVATION_SCHEMA,
    planDigest: plan.planDigest,
    tags: observedTags.map((entry) => ({ ...entry })),
  };
  return Object.freeze({
    ...unsigned,
    observationDigest: sha256(JSON.stringify(unsigned)),
  });
}

function validateTagObservation(plan, observation) {
  if (
    !exactKeys(observation, [
      'schemaVersion',
      'schema',
      'planDigest',
      'tags',
      'observationDigest',
    ]) ||
    observation.schemaVersion !== 1 ||
    observation.schema !== TAG_OBSERVATION_SCHEMA ||
    observation.planDigest !== plan.planDigest ||
    !DIGEST_PATTERN.test(observation.observationDigest || '')
  ) {
    fail('publication tag observation shape is invalid');
  }
  const expected = createPublicationTagObservation(plan, observation.tags);
  if (JSON.stringify(observation) !== JSON.stringify(expected)) {
    fail('publication tag observation digest is invalid');
  }
  return observation;
}

function createClosureReceipt(plan, observation) {
  validatePublicationPlan(plan);
  validateTagObservation(plan, observation);
  const unsigned = {
    schemaVersion: 1,
    schema: CLOSURE_RECEIPT_SCHEMA,
    release: { ...plan.release },
    planDigest: plan.planDigest,
    releaseSet: { ...plan.releaseSet },
    catalog: { ...plan.catalog },
    deploymentReadiness: {
      ...plan.deploymentReadiness,
      requiredDeploymentFamilies: [
        ...plan.deploymentReadiness.requiredDeploymentFamilies,
      ],
    },
    tagObservationDigest: observation.observationDigest,
    publishedTags: observation.tags.map((entry) => ({ ...entry })),
    verification: { ...CLOSURE_VERIFICATION },
  };
  return Object.freeze({
    ...unsigned,
    receiptDigest: sha256(JSON.stringify(unsigned)),
  });
}

function auditClosureReceipt(actual, plan, observation) {
  const expected = createClosureReceipt(plan, observation);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('publication closure receipt differs from the verified final tags');
  }
  return Object.freeze({
    compatible: true,
    releaseSetDigest: actual.releaseSet.releaseSetDigest,
    releaseScope: actual.release.scope,
    catalogManifestDigest: actual.catalog.manifestDigest,
    deploymentReadinessReceiptDigest: actual.deploymentReadiness.receiptDigest,
    publishedTagCount: actual.publishedTags.length,
    allTagsExactDigest: actual.verification.allTagsExactDigest,
    registryTagCas: actual.verification.registryTagCas,
  });
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
  const identity = [
    'release-scope',
    'repository-owner',
    'source-ref',
    'source-repository',
    'source-revision',
    'version',
  ];
  const expected =
    values.mode === 'plan'
      ? [
          'catalog-manifest',
          'catalog-manifest-digest',
          'catalog-plan',
          'catalog-receipt',
          'deployment-readiness',
          'mode',
          'output',
          'release-set',
          ...identity,
        ]
      : values.mode === 'close'
      ? ['mode', 'observations', 'output', 'plan']
      : values.mode === 'audit'
      ? ['mode', 'observations', 'plan', 'receipt']
      : [];
  if (
    expected.length === 0 ||
    JSON.stringify(Object.keys(values).sort()) !==
      JSON.stringify(expected.sort())
  ) {
    fail('arguments are invalid');
  }
  return Object.freeze({
    mode: values.mode,
    output: values.output,
    plan: values.plan,
    observations: values.observations,
    receipt: values.receipt,
    releaseSet: values['release-set'],
    catalogPlan: values['catalog-plan'],
    catalogReceipt: values['catalog-receipt'],
    deploymentReadiness: values['deployment-readiness'],
    catalogManifest: values['catalog-manifest'],
    catalogManifestDigest: values['catalog-manifest-digest'],
    version: values.version,
    sourceRevision: values['source-revision'],
    sourceRef: values['source-ref'],
    releaseScope: values['release-scope'],
    repositoryOwner: values['repository-owner'],
    sourceRepository: values['source-repository'],
  });
}

function runCli(argv, output = process.stdout) {
  const options = parseArguments(argv);
  if (options.mode === 'plan') {
    const releaseSet = readCanonicalJson(options.releaseSet, 'release set');
    const catalogPlan = readCanonicalJson(options.catalogPlan, 'catalog plan');
    const catalogReceipt = readCanonicalJson(
      options.catalogReceipt,
      'catalog receipt',
    );
    const deploymentReadiness = readCanonicalJson(
      options.deploymentReadiness,
      'deployment readiness receipt',
    );
    const manifest = readBoundedFile(
      options.catalogManifest,
      'catalog manifest',
    ).contents;
    const plan = createPublicationPlan(
      releaseSet,
      catalogPlan,
      catalogReceipt,
      deploymentReadiness,
      manifest,
      options.catalogManifestDigest,
      options,
    );
    writeNoReplace(options.output, plan);
    output.write(canonicalJson(plan));
    return plan;
  }
  const plan = readCanonicalJson(options.plan, 'publication plan');
  const observation = readCanonicalJson(
    options.observations,
    'tag observations',
  );
  if (options.mode === 'close') {
    const receipt = createClosureReceipt(plan, observation);
    writeNoReplace(options.output, receipt);
    output.write(canonicalJson(receipt));
    return receipt;
  }
  const receipt = readCanonicalJson(options.receipt, 'closure receipt');
  const audit = auditClosureReceipt(receipt, plan, observation);
  output.write(canonicalJson(audit));
  return audit;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error
          ? error.message
          : 'release publication closure failed'
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  CLOSURE_RECEIPT_SCHEMA,
  PUBLICATION_PLAN_SCHEMA,
  TAG_OBSERVATION_SCHEMA,
  QingLong3ReleasePublicationClosureError,
  auditClosureReceipt,
  createClosureReceipt,
  createPublicationPlan,
  createPublicationTagObservation,
  parseArguments,
  runCli,
  validatePublicationPlan,
  validateTagObservation,
});
