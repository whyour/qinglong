#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createPublicationTagObservation,
  validatePublicationPlan,
  validateTagObservation,
} = require('./ql3-release-publication-closure-contract.cjs');

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_INVENTORY_BYTES = 1024 * 1024;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;

class QingLong3ReleaseTagFinalizerError extends Error {
  constructor(message) {
    super(`QingLong 3 release tag finalizer failed: ${message}`);
    this.name = 'QingLong3ReleaseTagFinalizerError';
  }
}

function fail(message) {
  throw new QingLong3ReleaseTagFinalizerError(message);
}

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function currentUid() {
  if (typeof process.getuid !== 'function') {
    fail('a POSIX current user is required');
  }
  return process.getuid();
}

function resolveCanonicalAbsolute(input, label) {
  if (
    typeof input !== 'string' ||
    !path.isAbsolute(input) ||
    path.resolve(input) !== input
  ) {
    fail(`${label} path must be canonical and absolute`);
  }
  return input;
}

function validatePrivateParent(parent, label) {
  const uid = currentUid();
  const stat = fs.lstatSync(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700 ||
    fs.realpathSync(parent) !== parent
  ) {
    fail(`${label} parent must be a canonical current-user 0700 directory`);
  }
}

function readPrivateCanonicalJson(filePath, label) {
  const resolved = resolveCanonicalAbsolute(filePath, label);
  validatePrivateParent(path.dirname(resolved), label);
  let descriptor;
  let before;
  let after;
  let bytes;
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.uid !== currentUid() ||
      (before.mode & 0o777) !== 0o600 ||
      before.nlink !== 1 ||
      before.size < 2 ||
      before.size > MAX_JSON_BYTES ||
      fs.realpathSync(resolved) !== resolved
    ) {
      fail(`${label} must be a bounded current-user 0600 regular file`);
    }
    bytes = fs.readFileSync(descriptor);
    after = fs.fstatSync(descriptor);
  } catch (error) {
    if (error instanceof QingLong3ReleaseTagFinalizerError) throw error;
    fail(`${label} cannot be read through a stable descriptor`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    bytes.byteLength !== before.size
  ) {
    fail(`${label} changed while being read`);
  }
  const contents = bytes.toString('utf8');
  if (!Buffer.from(contents, 'utf8').equals(bytes)) {
    fail(`${label} must contain valid UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    fail(`${label} must contain valid JSON`);
  }
  if (canonicalJson(value) !== contents) {
    fail(`${label} must use canonical JSON encoding`);
  }
  return value;
}

function writePrivateNoReplace(filePath, value) {
  const resolved = resolveCanonicalAbsolute(filePath, 'output');
  validatePrivateParent(path.dirname(resolved), 'output');
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, 'wx', 0o600);
    fs.writeFileSync(descriptor, canonicalJson(value));
    fs.fsyncSync(descriptor);
  } catch {
    fail('output must be published once as a private regular file');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validateRegistryAdapter(registry) {
  if (
    registry === null ||
    typeof registry !== 'object' ||
    typeof registry.resolveDigest !== 'function' ||
    typeof registry.listTags !== 'function' ||
    typeof registry.copyImage !== 'function'
  ) {
    fail('registry adapter is incomplete');
  }
  return registry;
}

function parseTagInventory(contents) {
  if (
    typeof contents !== 'string' ||
    Buffer.byteLength(contents, 'utf8') > MAX_INVENTORY_BYTES ||
    (contents.length > 0 && !contents.endsWith('\n'))
  ) {
    fail('release tag inventory is invalid or unbounded');
  }
  const tags = contents.length === 0 ? [] : contents.slice(0, -1).split('\n');
  if (
    tags.some((tag) => !TAG_PATTERN.test(tag)) ||
    new Set(tags).size !== tags.length
  ) {
    fail('release tag inventory is malformed');
  }
  return Object.freeze([...tags]);
}

function tagName(image, tag) {
  return tag.reference.slice(image.registryRepository.length + 1);
}

function preflightReleaseTags(plan, registryInput) {
  validatePublicationPlan(plan);
  const registry = validateRegistryAdapter(registryInput);
  const states = [];
  for (const image of plan.images) {
    const sourceDigest = registry.resolveDigest(image.immutableReference);
    if (sourceDigest !== image.digest) {
      fail('source digest drifted before promotion');
    }
    const inventory = new Set(
      parseTagInventory(registry.listTags(image.registryRepository)),
    );
    for (const tag of image.tags) {
      const present = inventory.has(tagName(image, tag));
      if (present && registry.resolveDigest(tag.reference) !== image.digest) {
        fail('release tag already points at another digest');
      }
      states.push(Object.freeze({ image, tag, present }));
    }
  }
  return Object.freeze(states);
}

function observeExactTags(plan, states, registry) {
  const observedTags = [];
  for (const state of states) {
    const digest = registry.resolveDigest(state.tag.reference);
    if (digest !== state.image.digest) {
      fail('promoted tag does not resolve to the release-set digest');
    }
    observedTags.push({
      image: state.image.name,
      kind: state.tag.kind,
      reference: state.tag.reference,
      digest,
    });
  }
  return createPublicationTagObservation(plan, observedTags);
}

function finalizeReleaseTags(plan, registryInput) {
  validatePublicationPlan(plan);
  const registry = validateRegistryAdapter(registryInput);
  const states = preflightReleaseTags(plan, registry);
  for (const state of states) {
    if (!state.present) {
      registry.copyImage(state.image.immutableReference, state.tag.reference);
    }
  }
  return observeExactTags(plan, states, registry);
}

function auditReleaseTags(plan, observation, registryInput) {
  validatePublicationPlan(plan);
  validateTagObservation(plan, observation);
  const registry = validateRegistryAdapter(registryInput);
  const states = preflightReleaseTags(plan, registry);
  if (states.some((state) => !state.present)) {
    fail('publication audit found an absent final tag');
  }
  const observed = observeExactTags(plan, states, registry);
  if (JSON.stringify(observed) !== JSON.stringify(observation)) {
    fail('publication observation differs from live registry state');
  }
  return Object.freeze({
    schemaVersion: 1,
    planDigest: plan.planDigest,
    observationDigest: observation.observationDigest,
    tagCount: observation.tags.length,
    allTagsExactDigest: true,
    registryMutation: false,
    compatible: true,
  });
}

function resolveRegctlExecutable(input) {
  const resolved = resolveCanonicalAbsolute(input, 'regctl');
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== currentUid() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o111) === 0 ||
    (stat.mode & 0o022) !== 0 ||
    fs.realpathSync(resolved) !== resolved
  ) {
    fail('regctl must be a canonical current-user non-writable executable');
  }
  return Object.freeze({
    path: resolved,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    uid: stat.uid,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
}

function revalidateRegctlExecutable(identity) {
  const stat = fs.lstatSync(identity.path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(identity.path) !== identity.path ||
    stat.dev !== identity.dev ||
    stat.ino !== identity.ino ||
    stat.size !== identity.size ||
    stat.uid !== identity.uid ||
    stat.mode !== identity.mode ||
    stat.mtimeMs !== identity.mtimeMs ||
    stat.ctimeMs !== identity.ctimeMs
  ) {
    fail('regctl executable identity changed during finalization');
  }
}

function createRegctlAdapter(regctlInput) {
  const identity = resolveRegctlExecutable(regctlInput);
  const run = (operation, args, timeout = 30_000) => {
    revalidateRegctlExecutable(identity);
    const result = spawnSync(identity.path, args, {
      encoding: 'utf8',
      maxBuffer: MAX_INVENTORY_BYTES,
      timeout,
      killSignal: 'SIGKILL',
    });
    revalidateRegctlExecutable(identity);
    if (result.error || result.status !== 0) {
      fail(`registry command failed during ${operation}`);
    }
    return result.stdout;
  };
  return Object.freeze({
    resolveDigest(reference) {
      return run('digest resolution', ['image', 'digest', reference]).trim();
    },
    listTags(repository) {
      return run('bounded tag inventory', [
        'tag',
        'ls',
        repository,
        '--format',
        '{{ range .Tags }}{{ println . }}{{ end }}',
      ]);
    },
    copyImage(source, target) {
      run('tag promotion', ['image', 'copy', source, target], 120_000);
    },
  });
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const separator = argument.indexOf('=');
    if (
      !argument.startsWith('--') ||
      separator < 3 ||
      separator === argument.length - 1
    ) {
      fail('arguments must use --name=value');
    }
    const key = argument.slice(2, separator);
    if (Object.hasOwn(values, key)) fail('arguments must be unique');
    values[key] = argument.slice(separator + 1);
  }
  const expected =
    values.mode === 'finalize'
      ? ['mode', 'output', 'plan', 'regctl']
      : values.mode === 'audit'
      ? ['mode', 'observation', 'plan', 'regctl']
      : [];
  if (
    expected.length === 0 ||
    JSON.stringify(Object.keys(values).sort()) !==
      JSON.stringify([...expected].sort())
  ) {
    fail(
      'usage: --mode=finalize --plan=/absolute/plan.json --regctl=/absolute/regctl --output=/absolute/observation.json or --mode=audit --plan=/absolute/plan.json --regctl=/absolute/regctl --observation=/absolute/observation.json',
    );
  }
  return Object.freeze(values);
}

function runCli(argv, output = process.stdout, dependencies = {}) {
  const options = parseArguments(argv);
  const plan = readPrivateCanonicalJson(options.plan, 'publication plan');
  validatePublicationPlan(plan);
  const registry = dependencies.registry ?? createRegctlAdapter(options.regctl);
  if (options.mode === 'finalize') {
    const observation = finalizeReleaseTags(plan, registry);
    writePrivateNoReplace(options.output, observation);
    output.write(canonicalJson(observation));
    return observation;
  }
  const observation = readPrivateCanonicalJson(
    options.observation,
    'tag observation',
  );
  const audit = auditReleaseTags(plan, observation, registry);
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
          : 'release tag finalization failed'
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  MAX_INVENTORY_BYTES,
  QingLong3ReleaseTagFinalizerError,
  auditReleaseTags,
  createRegctlAdapter,
  finalizeReleaseTags,
  parseArguments,
  parseTagInventory,
  preflightReleaseTags,
  revalidateRegctlExecutable,
  runCli,
});
