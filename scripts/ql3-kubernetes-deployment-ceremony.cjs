#!/usr/bin/env node

'use strict';

const {
  QingLong3KubernetesDeploymentCeremonyError,
  canonicalJson,
  executeCommand,
} = require('./lib/ql3-kubernetes-deployment-ceremony.cjs');

function commandFile(argv) {
  if (argv.length !== 1) throw new Error('arguments are invalid');
  const match = /^--command-file=(.+)$/u.exec(argv[0]);
  if (!match) throw new Error('arguments are invalid');
  return match[1];
}

function lowSensitivityFailure() {
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-kubernetes-deployment-ceremony',
    code: 'QL3_KUBERNETES_DEPLOYMENT_CEREMONY_FAILED',
    message: 'QingLong 3 Kubernetes deployment ceremony failed',
  });
}

function runCli(argv, output = process.stdout, errorOutput = process.stderr) {
  try {
    const result = executeCommand(commandFile(argv));
    output.write(canonicalJson(result));
    return result;
  } catch (error) {
    errorOutput.write(canonicalJson(lowSensitivityFailure()));
    if (
      !(error instanceof QingLong3KubernetesDeploymentCeremonyError) &&
      process.env.QL3_DEBUG_DEPLOYMENT_CEREMONY === 'true'
    ) {
      errorOutput.write(
        `${error instanceof Error ? error.message : 'error'}\n`,
      );
    }
    process.exitCode = 1;
    return undefined;
  }
}

if (require.main === module) runCli(process.argv.slice(2));

module.exports = Object.freeze({ commandFile, runCli });
