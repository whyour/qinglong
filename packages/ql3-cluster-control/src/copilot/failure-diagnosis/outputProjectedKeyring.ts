import { Buffer } from 'node:buffer';

import { PrivateProjectedFileReader } from '../../security/privateProjectedFile';
import {
  MAX_CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_KEYRING_BYTES,
  canonicalClusterCopilotFailureDiagnosisOutputKeyringManifest,
  parseClusterCopilotFailureDiagnosisOutputKeyringManifest,
  resolveClusterCopilotFailureDiagnosisOutputKeyringMaterial,
  summarizeClusterCopilotFailureDiagnosisOutputKeyringManifest,
  type ClusterCopilotFailureDiagnosisOutputKeyMaterial,
  type ClusterCopilotFailureDiagnosisOutputKeyringManifest,
  type ClusterCopilotFailureDiagnosisOutputKeyringSummary,
} from './outputKeyringManifest';

const DATA_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

export {
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_KEYRING_MANIFEST_SCHEMA,
  MAX_CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_KEYRING_BYTES,
  MAX_CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_PROJECTED_KEYS,
  InvalidClusterCopilotFailureDiagnosisOutputKeyringManifestError,
  canonicalClusterCopilotFailureDiagnosisOutputKeyringManifest,
  normalizeClusterCopilotFailureDiagnosisOutputKeyringManifest,
  parseClusterCopilotFailureDiagnosisOutputKeyringManifest,
  resolveClusterCopilotFailureDiagnosisOutputKeyringMaterial,
  summarizeClusterCopilotFailureDiagnosisOutputKeyringManifest,
  type ClusterCopilotFailureDiagnosisOutputKeyringManifest,
  type ClusterCopilotFailureDiagnosisOutputKeyringSummary,
} from './outputKeyringManifest';

export interface ClusterCopilotFailureDiagnosisOutputProjectedKeyringOptions {
  readonly rootDirectory: string;
  readonly dataFileName?: string;
}

export interface ClusterCopilotFailureDiagnosisOutputKeyProvider {
  active(): Promise<ClusterCopilotFailureDiagnosisOutputKeyMaterial>;
  resolve(
    keyId: string,
  ): Promise<ClusterCopilotFailureDiagnosisOutputKeyMaterial | null>;
}

export class ClusterCopilotFailureDiagnosisOutputProjectedKeyringUnavailableError extends Error {
  readonly code =
    'QL3_CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_PROJECTED_KEYRING_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super(
      'Projected Cluster Copilot failure diagnosis output keyring is unavailable',
      options,
    );
    this.name =
      'ClusterCopilotFailureDiagnosisOutputProjectedKeyringUnavailableError';
  }
}

function unavailable(
  cause?: unknown,
): ClusterCopilotFailureDiagnosisOutputProjectedKeyringUnavailableError {
  return new ClusterCopilotFailureDiagnosisOutputProjectedKeyringUnavailableError(
    { cause: cause instanceof Error ? cause : undefined },
  );
}

function dataFileName(value: unknown): string {
  if (typeof value !== 'string' || !DATA_FILE_NAME.test(value)) {
    throw unavailable();
  }
  return value;
}

async function readManifest(
  reader: PrivateProjectedFileReader,
  fileName: string,
): Promise<Readonly<ClusterCopilotFailureDiagnosisOutputKeyringManifest>> {
  let bytes: Buffer | undefined;
  let canonical: Buffer | undefined;
  try {
    bytes = await reader.read(fileName);
    const manifest =
      parseClusterCopilotFailureDiagnosisOutputKeyringManifest(bytes);
    canonical =
      canonicalClusterCopilotFailureDiagnosisOutputKeyringManifest(manifest);
    if (!canonical.equals(bytes)) throw unavailable();
    return manifest;
  } catch (cause) {
    throw cause instanceof
      ClusterCopilotFailureDiagnosisOutputProjectedKeyringUnavailableError
      ? cause
      : unavailable(cause);
  } finally {
    bytes?.fill(0);
    canonical?.fill(0);
  }
}

/** Read-only, no-cache Copilot diagnosis output key authority. */
export class ClusterCopilotFailureDiagnosisOutputProjectedKeyring
  implements ClusterCopilotFailureDiagnosisOutputKeyProvider
{
  readonly #reader: PrivateProjectedFileReader;
  readonly #dataFileName: string;

  constructor(
    options: ClusterCopilotFailureDiagnosisOutputProjectedKeyringOptions,
  ) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw unavailable();
    }
    try {
      this.#reader = new PrivateProjectedFileReader({
        rootDirectory: options.rootDirectory,
        minimumBytes: 1,
        maximumBytes:
          MAX_CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_KEYRING_BYTES,
        access: 'read_only_keyring',
      });
      this.#dataFileName = dataFileName(options.dataFileName ?? 'keyring.json');
    } catch (cause) {
      throw unavailable(cause);
    }
  }

  async verify(): Promise<
    Readonly<ClusterCopilotFailureDiagnosisOutputKeyringSummary>
  > {
    return summarizeClusterCopilotFailureDiagnosisOutputKeyringManifest(
      await readManifest(this.#reader, this.#dataFileName),
    );
  }

  async active(): Promise<ClusterCopilotFailureDiagnosisOutputKeyMaterial> {
    try {
      const manifest = await readManifest(this.#reader, this.#dataFileName);
      const material =
        resolveClusterCopilotFailureDiagnosisOutputKeyringMaterial(
          manifest,
          manifest.activeKeyId,
        );
      if (!material) throw unavailable();
      return material;
    } catch (cause) {
      throw cause instanceof
        ClusterCopilotFailureDiagnosisOutputProjectedKeyringUnavailableError
        ? cause
        : unavailable(cause);
    }
  }

  async resolve(
    keyId: string,
  ): Promise<ClusterCopilotFailureDiagnosisOutputKeyMaterial | null> {
    try {
      return resolveClusterCopilotFailureDiagnosisOutputKeyringMaterial(
        await readManifest(this.#reader, this.#dataFileName),
        keyId,
      );
    } catch (cause) {
      throw cause instanceof
        ClusterCopilotFailureDiagnosisOutputProjectedKeyringUnavailableError
        ? cause
        : unavailable(cause);
    }
  }
}

export async function createClusterCopilotFailureDiagnosisOutputProjectedKeyring(
  options: ClusterCopilotFailureDiagnosisOutputProjectedKeyringOptions,
): Promise<
  Readonly<ClusterCopilotFailureDiagnosisOutputProjectedKeyring>
> {
  const provider =
    new ClusterCopilotFailureDiagnosisOutputProjectedKeyring(options);
  await provider.verify();
  return provider;
}
