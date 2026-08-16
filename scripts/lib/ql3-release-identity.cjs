'use strict';

const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');

const RELEASE_IDENTITY_PATH = 'ql3-release.json';
const RELEASE_IDENTITY_SCHEMA = 'qinglong/release-identity@v1';
const MAX_RELEASE_IDENTITY_BYTES = 4096;
const VERSION_PATTERN =
  /^3\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/u;

class QingLong3ReleaseIdentityError extends Error {
  constructor(message) {
    super(`QingLong 3 release identity failed: ${message}`);
    this.name = 'QingLong3ReleaseIdentityError';
  }
}

function fail(message) {
  throw new QingLong3ReleaseIdentityError(message);
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected)
  );
}

function normalizeReleaseIdentity(value) {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'schema',
      'product',
      'version',
      'node',
      'workspacePackageCount',
      'legacyRootPackageExcluded',
    ]) ||
    value.schemaVersion !== 1 ||
    value.schema !== RELEASE_IDENTITY_SCHEMA ||
    value.product !== 'qinglong3' ||
    typeof value.version !== 'string' ||
    !VERSION_PATTERN.test(value.version) ||
    semver.valid(value.version) !== value.version ||
    !exactKeys(value.node, ['version', 'engine']) ||
    value.node.version !== '24.18.0' ||
    value.node.engine !== '>=24.18.0 <25' ||
    value.workspacePackageCount !== 18 ||
    value.legacyRootPackageExcluded !== true
  ) {
    fail('identity shape or value is incompatible');
  }
  return Object.freeze({
    ...value,
    node: Object.freeze({ ...value.node }),
  });
}

function readReleaseIdentity(root) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const filePath = path.join(resolvedRoot, RELEASE_IDENTITY_PATH);
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > MAX_RELEASE_IDENTITY_BYTES ||
    fs.realpathSync(filePath) !== filePath
  ) {
    fail('identity file must be one bounded canonical regular file');
  }
  const contents = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    fail('identity file must contain valid JSON');
  }
  const identity = normalizeReleaseIdentity(parsed);
  if (`${JSON.stringify(identity, null, 2)}\n` !== contents) {
    fail('identity file must use exact canonical JSON encoding');
  }
  return identity;
}

module.exports = Object.freeze({
  MAX_RELEASE_IDENTITY_BYTES,
  RELEASE_IDENTITY_PATH,
  RELEASE_IDENTITY_SCHEMA,
  VERSION_PATTERN,
  QingLong3ReleaseIdentityError,
  normalizeReleaseIdentity,
  readReleaseIdentity,
});
