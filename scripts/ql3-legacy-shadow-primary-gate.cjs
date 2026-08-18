#!/usr/bin/env node

require('ts-node/register/transpile-only');

const fs = require('node:fs');
const path = require('node:path');
const {
  createLegacyShadowPrimaryGateReceipt,
} = require('../back/runtime/domain/legacyShadowPrimaryGate');

const MAX_EVIDENCE_BYTES = 1024 * 1024;

function parseArguments(argv) {
  const options = { profile: 'edge' };
  for (const argument of argv) {
    if (argument === '--') continue;
    if (argument.startsWith('--profile=')) {
      options.profile = argument.slice('--profile='.length);
    } else if (argument.startsWith('--capture=')) {
      options.capturePath = path.resolve(argument.slice('--capture='.length));
    } else if (argument.startsWith('--terminal=')) {
      options.terminalPath = path.resolve(argument.slice('--terminal='.length));
    } else if (argument.startsWith('--resource=')) {
      options.resourcePath = path.resolve(argument.slice('--resource='.length));
    } else if (argument.startsWith('--output=')) {
      options.outputPath = path.resolve(argument.slice('--output='.length));
    } else if (argument.startsWith('--generated-at-ms=')) {
      const raw = argument.slice('--generated-at-ms='.length);
      if (!/^\d+$/u.test(raw)) {
        throw new TypeError('--generated-at-ms must be an integer');
      }
      options.generatedAtMs = Number(raw);
    } else {
      throw new TypeError(`Unsupported argument: ${argument}`);
    }
  }
  if (options.profile !== 'edge' && options.profile !== 'standalone') {
    throw new TypeError('--profile must be edge or standalone');
  }
  for (const name of [
    'capturePath',
    'terminalPath',
    'resourcePath',
    'outputPath',
  ]) {
    if (!options[name] || !path.isAbsolute(options[name])) {
      throw new TypeError(`--${name.replace('Path', '')} is required`);
    }
  }
  if (
    options.generatedAtMs !== undefined &&
    (!Number.isSafeInteger(options.generatedAtMs) || options.generatedAtMs < 0)
  ) {
    throw new TypeError('--generated-at-ms is invalid');
  }
  return options;
}

function readEvidence(sourcePath) {
  const descriptor = fs.openSync(
    sourcePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 2 ||
      stat.size > MAX_EVIDENCE_BYTES
    ) {
      throw new TypeError('Primary gate evidence file shape is invalid');
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count === 0) throw new Error('Primary gate evidence read stalled');
      offset += count;
    }
    return {
      value: JSON.parse(bytes.toString('utf8')),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeReceipt(outputPath, receipt) {
  const descriptor = fs.openSync(outputPath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(receipt)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function run(options) {
  const capture = readEvidence(options.capturePath);
  const terminal = readEvidence(options.terminalPath);
  const resource = readEvidence(options.resourcePath);
  const receipt = createLegacyShadowPrimaryGateReceipt({
    profile: options.profile,
    generatedAtMs: options.generatedAtMs ?? Date.now(),
    capture: capture.value,
    terminal: terminal.value,
    resource: resource.value,
  });
  if (receipt.assessment !== 'eligible') {
    const error = new Error(
      `Legacy Shadow Primary gate is ineligible: ${receipt.violations.join(
        ',',
      )}`,
    );
    error.code = 'QL3_PRIMARY_GATE_INELIGIBLE';
    throw error;
  }
  writeReceipt(options.outputPath, receipt);
  return receipt;
}

function main() {
  const receipt = run(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

module.exports = {
  MAX_EVIDENCE_BYTES,
  parseArguments,
  readEvidence,
  run,
  writeReceipt,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
