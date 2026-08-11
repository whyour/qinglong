#!/usr/bin/env node

/** Offline Prompt Output external recovery verification CLI boundary. */
import {
  disposeClusterPromptOutputExternalRecoveryInput,
  readClusterPromptOutputExternalRecoveryCommand,
  readClusterPromptOutputExternalRecoveryInput,
  type ClusterPromptOutputExternalRecoveryInput,
} from './promptOutputExternalRecoveryInput';
import { runClusterPromptOutputExternalRecoveryVerifier } from './promptOutputExternalRecoveryVerifier';

const USAGE =
  'Usage: ql3-prompt-output-key-recovery-verify run --command-file /absolute/recovery.json';

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (
    argv.length !== 3 ||
    argv[0] !== 'run' ||
    argv[1] !== '--command-file' ||
    !argv[2]
  ) {
    process.stderr.write(
      `${JSON.stringify({
        code: 'QL3_PROMPT_OUTPUT_EXTERNAL_RECOVERY_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  let input: Readonly<ClusterPromptOutputExternalRecoveryInput> | undefined;
  try {
    const command = readClusterPromptOutputExternalRecoveryCommand(argv[2]);
    input = readClusterPromptOutputExternalRecoveryInput(command);
    const proof = runClusterPromptOutputExternalRecoveryVerifier(input);
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-prompt-output-external-recovery-verifier',
        event: 'recovery_verified',
        ...proof,
      })}\n`,
    );
  } catch (error) {
    const candidate = error as {
      readonly code?: unknown;
      readonly name?: unknown;
    };
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-prompt-output-external-recovery-verifier',
        event: 'recovery_rejected',
        name:
          typeof candidate.name === 'string'
            ? candidate.name.slice(0, 128)
            : 'Error',
        ...(typeof candidate.code === 'string'
          ? { code: candidate.code.slice(0, 128) }
          : {}),
      })}\n`,
    );
    process.exitCode = 1;
  } finally {
    if (input) disposeClusterPromptOutputExternalRecoveryInput(input);
  }
}

void main(process.argv.slice(2));
