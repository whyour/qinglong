#!/usr/bin/env node

/** One-shot Prompt Output key rotation CLI boundary. */
import { openPromptOutputKubernetesSecretAuthority } from './promptOutputKubernetesSecretAuthority';
import { runClusterPromptOutputKeyRotationProcess } from './promptOutputKeyRotationProcess';
import {
  readClusterPromptOutputKeyRotationCommand,
  readClusterPromptOutputKeyRotationMaterial,
} from './promptOutputKeyRotationInput';
import { loadPromptOutputPostgresMaintenanceConnection } from './promptOutputPostgresMaintenanceConnection';

const USAGE =
  'Usage: ql3-prompt-output-key-rotate run --command-file /absolute/rotation.json';

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
        code: 'QL3_PROMPT_OUTPUT_KEY_ROTATION_CLI_USAGE_INVALID',
        message: USAGE,
      })}\n`,
    );
    process.exitCode = 64;
    return;
  }
  let authority:
    | Awaited<ReturnType<typeof openPromptOutputKubernetesSecretAuthority>>
    | undefined;
  let material: Buffer | undefined;
  try {
    const command = readClusterPromptOutputKeyRotationCommand(argv[2]);
    authority = await openPromptOutputKubernetesSecretAuthority(
      command.kubernetes,
    );
    material = readClusterPromptOutputKeyRotationMaterial(
      command.stagedMaterialFile,
    );
    const result = await runClusterPromptOutputKeyRotationProcess({
      database: {
        connection: loadPromptOutputPostgresMaintenanceConnection(process.env),
        pool: {
          applicationName: 'qinglong3-prompt-output-key-rotation',
          maxConnections: 1,
        },
      },
      request: {
        ...command.request,
        expectedSecretUid: command.kubernetes.expectedSecretUid,
      },
      material,
      materials: authority.materials,
    });
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-prompt-output-key-rotation',
        event: 'key_rotation_completed',
        status: result.status,
        rotationId: result.rotationId,
        requestId: result.requestId,
        mutationId: result.mutationId,
        preparationDigest: result.preparationDigest,
        completionDigest: result.completionDigest,
        generation: result.generation,
        previousActiveKeyId: result.previousActiveKeyId,
        activeKeyId: result.activeKeyId,
        catalogDigest: result.catalogDigest,
        materialProof: result.materialProof,
        completedAtMs: result.completedAtMs,
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
        component: 'qinglong3-prompt-output-key-rotation',
        event: 'key_rotation_failed',
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
    material?.fill(0);
    authority?.dispose();
  }
}

void main(process.argv.slice(2));
