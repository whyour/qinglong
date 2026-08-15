#!/usr/bin/env node

/** Offline, read-only Cluster Console evidence verification entrypoint. */
import {
  ClusterConsoleEvidenceVerificationError,
  verifyClusterConsoleEvidenceBundleFile,
} from './evidenceVerifier';

const USAGE =
  'Usage: ql3-copilot-evidence-verify --bundle=/absolute/evidence.json';

function failure(code: string, message: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    component: 'qinglong3-cluster-console-evidence-verifier',
    code,
    message,
  });
}

function main(argv: readonly string[]): void {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (
    argv.length !== 1 ||
    !argv[0]?.startsWith('--bundle=') ||
    argv[0] === '--bundle='
  ) {
    process.stderr.write(
      `${failure(
        'QL3_CLUSTER_CONSOLE_EVIDENCE_VERIFIER_USAGE_INVALID',
        USAGE,
      )}\n`,
    );
    process.exitCode = 64;
    return;
  }
  try {
    const result = verifyClusterConsoleEvidenceBundleFile(
      argv[0].slice('--bundle='.length),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof ClusterConsoleEvidenceVerificationError
        ? error.code
        : 'QL3_CLUSTER_CONSOLE_EVIDENCE_VERIFICATION_INVALID';
    process.stderr.write(
      `${failure(
        code,
        'Cluster Console evidence bundle verification failed',
      )}\n`,
    );
    process.exitCode = 65;
  }
}

main(process.argv.slice(2));
