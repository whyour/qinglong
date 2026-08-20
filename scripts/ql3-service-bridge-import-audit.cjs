#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

class QingLong3ServiceBridgeImportAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QingLong3ServiceBridgeImportAuditError';
  }
}

function main() {
  const root = path.resolve(__dirname, '..');
  const packageRoot = path.join(root, 'packages/ql3-local-owner-cli');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  const expectedBin = 'dist/deployment/service-manager/serviceBridgeCli.js';
  if (manifest.bin?.['ql3-service-bridge'] !== expectedBin) {
    throw new QingLong3ServiceBridgeImportAuditError(
      'ql3-service-bridge binary entry drifted',
    );
  }
  const entries = [
    'dist/deployment/service-manager/serviceBridge.js',
    'dist/deployment/service-manager/legacy-rollback/bridge.js',
  ];
  for (const relativeEntry of entries) {
    const entry = path.join(packageRoot, relativeEntry);
    if (!fs.existsSync(entry)) {
      throw new QingLong3ServiceBridgeImportAuditError(
        `${relativeEntry} must be built before import audit`,
      );
    }
    require(entry);
  }
  const loaded = Object.keys(require.cache)
    .map((filePath) => path.resolve(filePath))
    .filter(
      (filePath) =>
        filePath.startsWith(path.join(root, 'packages') + path.sep) &&
        filePath.endsWith('.js'),
    )
    .map((filePath) => path.relative(root, filePath))
    .sort();
  const findings = [];
  for (const file of loaded) {
    const allowed =
      file.startsWith(
        'packages/ql3-local-owner-cli/dist/deployment/service-manager/',
      ) ||
      file ===
        'packages/ql3-local-owner-cli/dist/deployment/foundation/error.js' ||
      file ===
        'packages/ql3-local-owner-cli/dist/deployment/foundation/contract.js' ||
      file.startsWith('packages/ql3-local-command-file/dist/');
    if (!allowed) findings.push({ code: 'FORBIDDEN_BRIDGE_IMPORT', file });
  }
  const source = fs.readFileSync(
    path.join(
      packageRoot,
      'src/deployment/service-manager/serviceBridgeCli.ts',
    ),
    'utf8',
  );
  if (!source.includes("from './serviceBridge'")) {
    findings.push({
      code: 'BRIDGE_CLI_ENTRY_DRIFT',
      file: 'packages/ql3-local-owner-cli/src/deployment/service-manager/serviceBridgeCli.ts',
    });
  }
  if (!source.includes("from './legacy-rollback/bridge'")) {
    findings.push({
      code: 'LEGACY_ROLLBACK_BRIDGE_CLI_ENTRY_DRIFT',
      file: 'packages/ql3-local-owner-cli/src/deployment/service-manager/serviceBridgeCli.ts',
    });
  }
  const report = {
    schemaVersion: 2,
    compatible: findings.length === 0,
    binary: expectedBin,
    loaded,
    findings,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (findings.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      code: 'QL3_SERVICE_BRIDGE_IMPORT_AUDIT_FAILED',
      name: error?.name ?? 'Error',
      message: error?.message ?? 'service bridge import audit failed',
    })}\n`,
  );
  process.exitCode = 1;
}
