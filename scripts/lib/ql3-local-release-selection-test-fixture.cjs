'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function writeSyntheticLocalReleaseSelection(options) {
  const releaseSetDigest = sha256(`release-set:${options.image}`);
  const manifestDigest = sha256(`catalog-manifest:${options.image}`);
  const consumptionReportDigest = sha256(`catalog-report:${options.image}`);
  const unsigned = {
    schemaVersion: 1,
    schema: 'qinglong/local-compose-release-image@v2',
    release: {
      version: '3.0.0-alpha.0',
      sourceRevision: options.sourceRevision ?? '3'.repeat(40),
      sourceRef: 'refs/tags/v3.0.0-alpha.0',
      scope: 'local',
    },
    releaseSetDigest,
    catalog: {
      schema: 'qinglong/release-catalog-consumption-ceremony@v1',
      sourceRepository: 'example/qinglong',
      workflowIdentity:
        'https://github.com/example/qinglong/.github/workflows/ql3-image-release.yml@refs/tags/v3.0.0-alpha.0',
      immutableReference: `ghcr.io/example/qinglong3-release-catalog@${manifestDigest}`,
      manifestDigest,
      consumptionReportDigest,
      releaseSetDigest,
      discoveryTagAuthority: 'none',
    },
    deploymentFamily: 'local',
    service: {
      kind: 'compose',
      image: options.image,
      allowRootService: options.allowRootService,
    },
    verification: {
      releaseSet: 'standalone_structure_identity_and_self_digest',
      sourceRecordsReplayed: false,
      catalogConsumption: 'offline_reconstructed',
      externalToolResultsReplayed: false,
      networkAccess: false,
      deploymentMutation: false,
    },
  };
  const selectionDigest = sha256(JSON.stringify(unsigned));
  const filePath = path.join(
    options.directory,
    `synthetic-local-release-selection-${selectionDigest.slice(7)}.json`,
  );
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ ...unsigned, selectionDigest })}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  return Object.freeze({
    path: filePath,
    expectedSelectionDigest: selectionDigest,
  });
}

module.exports = { writeSyntheticLocalReleaseSelection };
