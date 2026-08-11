/** Private Prompt Output external recovery input authority boundary. */
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';

import type { PluginPackagePromptOutputArtifact } from '@qinglong/ai/plugin-package-prompt-output-artifact';
import type {
  PluginPackagePromptOutputDurableKeyFact,
  PluginPackagePromptOutputExternalCustodyReceipt,
} from '@qinglong/ai/plugin-package-prompt-output-external-custody';
import {
  openPluginPackagePromptOutputExternalCustodyBundle,
  type OpenPluginPackagePromptOutputExternalCustodyBundle,
  type PluginPackagePromptOutputExternalCustodyBundle,
} from '@qinglong/ai/plugin-package-prompt-output-external-custody-bundle';
import type { PluginPackagePromptOutputExternalRecoveryAuthorization } from '@qinglong/ai/plugin-package-prompt-output-external-recovery-authorization';

const MAX_COMMAND_FILE_BYTES = 16 * 1024;
const MAX_JSON_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_CUSTODY_BUNDLE_BYTES = 128 * 1024;
const MAX_PUBLIC_KEY_BYTES = 8 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export interface ClusterPromptOutputExternalRecoveryCommand {
  readonly schemaVersion: 1;
  readonly operation: 'cluster.prompt-output-key.verify-recovery';
  readonly authorizationFile: string;
  readonly custodyBundleFile: string;
  readonly recoveredMaterialFile: string;
  readonly durableKeyFactFile: string;
  readonly artifactFile: string;
  readonly custodyPublicKeyFile: string;
  readonly approverPublicKeyFiles: readonly [
    Readonly<{ userId: string; filePath: string }>,
    Readonly<{ userId: string; filePath: string }>,
  ];
}

export interface ClusterPromptOutputExternalRecoveryInput {
  readonly authorization: PluginPackagePromptOutputExternalRecoveryAuthorization;
  readonly receipt: PluginPackagePromptOutputExternalCustodyReceipt;
  readonly wrappedMaterial: Buffer;
  readonly material: Buffer;
  readonly durableKeyFact: Readonly<PluginPackagePromptOutputDurableKeyFact>;
  readonly artifact: PluginPackagePromptOutputArtifact;
  readonly custodyPublicKey: Buffer;
  readonly approverPublicKeys: readonly [
    Readonly<{ userId: string; publicKey: Buffer }>,
    Readonly<{ userId: string; publicKey: Buffer }>,
  ];
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    keys.length === canonical.length &&
    keys.every((key, index) => key === canonical[index])
  );
}

function absolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function stableReadOnlyFile(
  filePathValue: string,
  options: Readonly<{
    label: string;
    minimumBytes: number;
    maximumBytes: number;
    privateFile: boolean;
  }>,
): Buffer {
  const filePath = absolutePath(filePathValue, `${options.label} path`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < options.minimumBytes ||
      before.size > options.maximumBytes ||
      (before.mode & 0o222) !== 0 ||
      (before.mode & 0o111) !== 0 ||
      (before.mode & 0o440) === 0 ||
      (options.privateFile && (before.mode & 0o007) !== 0)
    ) {
      throw new TypeError(`${options.label} is unavailable`);
    }
    const value = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      value.byteLength !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      value.fill(0);
      throw new TypeError(`${options.label} changed during read`);
    }
    return value;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function jsonFile(filePath: string, label: string): unknown {
  const bytes = stableReadOnlyFile(filePath, {
    label,
    minimumBytes: 2,
    maximumBytes: MAX_JSON_INPUT_BYTES,
    privateFile: true,
  });
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } finally {
    bytes.fill(0);
  }
}

export function readClusterPromptOutputExternalRecoveryCommand(
  filePathValue: string,
): Readonly<ClusterPromptOutputExternalRecoveryCommand> {
  const bytes = stableReadOnlyFile(filePathValue, {
    label: 'Recovery command file',
    minimumBytes: 2,
    maximumBytes: MAX_COMMAND_FILE_BYTES,
    privateFile: false,
  });
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !exactKeys(value, [
        'approverPublicKeyFiles',
        'artifactFile',
        'authorizationFile',
        'custodyBundleFile',
        'custodyPublicKeyFile',
        'durableKeyFactFile',
        'operation',
        'recoveredMaterialFile',
        'schemaVersion',
      ])
    ) {
      throw new TypeError('Recovery command shape is invalid');
    }
    const candidate = value as Record<string, unknown>;
    if (
      candidate.schemaVersion !== 1 ||
      candidate.operation !== 'cluster.prompt-output-key.verify-recovery' ||
      !Array.isArray(candidate.approverPublicKeyFiles) ||
      candidate.approverPublicKeyFiles.length !== 2
    ) {
      throw new TypeError('Recovery command value is invalid');
    }
    const approvers = candidate.approverPublicKeyFiles
      .map((entry, index) => {
        if (
          !entry ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          !exactKeys(entry, ['filePath', 'userId'])
        ) {
          throw new TypeError(`Approver public key ${index} is invalid`);
        }
        const item = entry as Record<string, unknown>;
        if (typeof item.userId !== 'string' || !ID_PATTERN.test(item.userId)) {
          throw new TypeError(`Approver public key ${index} user is invalid`);
        }
        return Object.freeze({
          userId: item.userId,
          filePath: absolutePath(
            item.filePath,
            `Approver public key ${index} file`,
          ),
        });
      })
      .sort((left, right) => left.userId.localeCompare(right.userId));
    if (approvers[0]!.userId === approvers[1]!.userId) {
      throw new TypeError('Approver public key users must be distinct');
    }
    return Object.freeze({
      schemaVersion: 1,
      operation: 'cluster.prompt-output-key.verify-recovery',
      authorizationFile: absolutePath(
        candidate.authorizationFile,
        'Authorization file',
      ),
      custodyBundleFile: absolutePath(
        candidate.custodyBundleFile,
        'Custody bundle file',
      ),
      recoveredMaterialFile: absolutePath(
        candidate.recoveredMaterialFile,
        'Recovered material file',
      ),
      durableKeyFactFile: absolutePath(
        candidate.durableKeyFactFile,
        'Durable key fact file',
      ),
      artifactFile: absolutePath(candidate.artifactFile, 'Artifact file'),
      custodyPublicKeyFile: absolutePath(
        candidate.custodyPublicKeyFile,
        'Custody public key file',
      ),
      approverPublicKeyFiles: approvers as unknown as readonly [
        Readonly<{ userId: string; filePath: string }>,
        Readonly<{ userId: string; filePath: string }>,
      ],
    });
  } finally {
    bytes.fill(0);
  }
}

export function readClusterPromptOutputExternalRecoveryInput(
  command: Readonly<ClusterPromptOutputExternalRecoveryCommand>,
): Readonly<ClusterPromptOutputExternalRecoveryInput> {
  let custodyBundle:
    | Readonly<OpenPluginPackagePromptOutputExternalCustodyBundle>
    | undefined;
  let material: Buffer | undefined;
  let custodyPublicKey: Buffer | undefined;
  const approverPublicKeys: Buffer[] = [];
  try {
    material = stableReadOnlyFile(command.recoveredMaterialFile, {
      label: 'Recovered material',
      minimumBytes: 32,
      maximumBytes: 32,
      privateFile: true,
    });
    custodyPublicKey = stableReadOnlyFile(command.custodyPublicKeyFile, {
      label: 'Custody public key',
      minimumBytes: 32,
      maximumBytes: MAX_PUBLIC_KEY_BYTES,
      privateFile: true,
    });
    const custodyBundleBytes = stableReadOnlyFile(command.custodyBundleFile, {
      label: 'Custody bundle',
      minimumBytes: 2,
      maximumBytes: MAX_CUSTODY_BUNDLE_BYTES,
      privateFile: true,
    });
    try {
      custodyBundle = openPluginPackagePromptOutputExternalCustodyBundle(
        JSON.parse(
          custodyBundleBytes.toString('utf8'),
        ) as PluginPackagePromptOutputExternalCustodyBundle,
        custodyPublicKey,
      );
    } finally {
      custodyBundleBytes.fill(0);
    }
    const approvers = command.approverPublicKeyFiles.map((entry) => {
      const publicKey = stableReadOnlyFile(entry.filePath, {
        label: `Approver ${entry.userId} public key`,
        minimumBytes: 32,
        maximumBytes: MAX_PUBLIC_KEY_BYTES,
        privateFile: true,
      });
      approverPublicKeys.push(publicKey);
      return Object.freeze({ userId: entry.userId, publicKey });
    }) as unknown as readonly [
      Readonly<{ userId: string; publicKey: Buffer }>,
      Readonly<{ userId: string; publicKey: Buffer }>,
    ];
    return Object.freeze({
      authorization: jsonFile(
        command.authorizationFile,
        'Recovery authorization',
      ) as PluginPackagePromptOutputExternalRecoveryAuthorization,
      receipt: custodyBundle.receipt,
      wrappedMaterial: custodyBundle.wrappedMaterial,
      material,
      durableKeyFact: jsonFile(
        command.durableKeyFactFile,
        'Durable key fact',
      ) as PluginPackagePromptOutputDurableKeyFact,
      artifact: jsonFile(
        command.artifactFile,
        'Prompt output Artifact',
      ) as PluginPackagePromptOutputArtifact,
      custodyPublicKey,
      approverPublicKeys: approvers,
    });
  } catch (cause) {
    custodyBundle?.wrappedMaterial.fill(0);
    material?.fill(0);
    custodyPublicKey?.fill(0);
    approverPublicKeys.forEach((publicKey) => publicKey.fill(0));
    throw cause;
  }
}

export function disposeClusterPromptOutputExternalRecoveryInput(
  value: Readonly<ClusterPromptOutputExternalRecoveryInput>,
): void {
  value.wrappedMaterial.fill(0);
  value.material.fill(0);
  value.custodyPublicKey.fill(0);
  value.approverPublicKeys.forEach(({ publicKey }) => publicKey.fill(0));
}
