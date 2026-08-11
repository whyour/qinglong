/** ResourceVersion-fenced Prompt Output Kubernetes keyring boundary. */
import { Buffer } from 'node:buffer';

import {
  canonicalPluginPackagePromptOutputKeyringManifest,
  inspectPluginPackagePromptOutputKeyringManifest,
  parsePluginPackagePromptOutputKeyringManifest,
  pluginPackagePromptOutputKeyringCatalogDigest,
  retirePluginPackagePromptOutputKeyringManifest,
  rotatePluginPackagePromptOutputKeyringManifest,
  type PluginPackagePromptOutputKeyringManifest,
  type PluginPackagePromptOutputKeyringRotationMutation,
} from '@qinglong/ai/plugin-package-prompt-output-keyring-manifest';
import {
  InvalidPluginPackagePromptOutputKeyRetirementError,
  PluginPackagePromptOutputKeyRetirementConflictError,
  PluginPackagePromptOutputKeyRetirementUnavailableError,
  type PluginPackagePromptOutputKeyMaterialState,
  type PluginPackagePromptOutputKeyRetirementMaterialAuthority,
  type PluginPackagePromptOutputKeyRetirementPreparation,
} from '@qinglong/ai/plugin-package-prompt-output-key-retirement';

const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const DATA_KEY = /^[A-Za-z0-9._-]{1,253}$/;
const UID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESOURCE_VERSION = /^[1-9][0-9]{0,31}$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const FIELD_MANAGER = 'qinglong-prompt-output-key-retirement';
const ROTATION_FIELD_MANAGER = 'qinglong-prompt-output-key-rotation';
const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
const MANAGED_BY_VALUE = 'qinglong3';
const KEYRING_LABEL = 'qinglong.io/prompt-output-keyring';
const KEYRING_LABEL_VALUE = 'v1';
const GENERATION_ANNOTATION = 'qinglong.io/prompt-output-keyring-generation';
const CATALOG_DIGEST_ANNOTATION =
  'qinglong.io/prompt-output-keyring-catalog-digest';
const LAST_APPLIED_ANNOTATION =
  'kubectl.kubernetes.io/last-applied-configuration';
const MAX_SECRET_DATA_BYTES = 384 * 1024;

export interface ClusterPromptOutputKubernetesSecretKeyringOptions {
  readonly namespace: string;
  readonly secretName: string;
  readonly expectedSecretUid: string;
  readonly dataKey?: string;
}

export interface ClusterPromptOutputKubernetesSecret {
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly type?: string;
  readonly immutable?: boolean;
  readonly stringData?: Readonly<Record<string, string>>;
  readonly data?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<{
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    deletionTimestamp?: Date | string;
    labels?: Readonly<Record<string, string>>;
    annotations?: Readonly<Record<string, string>>;
    [key: string]: unknown;
  }>;
  readonly [key: string]: unknown;
}

interface ClusterPromptOutputKubernetesSecretWrite
  extends ClusterPromptOutputKubernetesSecret {
  readonly apiVersion: 'v1';
  readonly kind: 'Secret';
  readonly type: 'Opaque';
  readonly immutable: false;
  readonly metadata: NonNullable<
    ClusterPromptOutputKubernetesSecret['metadata']
  >;
  readonly data: Readonly<Record<string, string>>;
}

export interface ClusterPromptOutputKubernetesSecretApi {
  readNamespacedSecret(
    request: Readonly<{
      name: string;
      namespace: string;
    }>,
  ): Promise<ClusterPromptOutputKubernetesSecret>;
  replaceNamespacedSecret(
    request: Readonly<{
      name: string;
      namespace: string;
      body: ClusterPromptOutputKubernetesSecretWrite;
      fieldManager: typeof FIELD_MANAGER | typeof ROTATION_FIELD_MANAGER;
      fieldValidation: 'Strict';
    }>,
  ): Promise<ClusterPromptOutputKubernetesSecret>;
}

interface StoredKeyring {
  readonly secret: ClusterPromptOutputKubernetesSecret;
  readonly manifest: Readonly<PluginPackagePromptOutputKeyringManifest>;
  readonly resourceVersion: string;
}

function unavailable(
  cause?: unknown,
): PluginPackagePromptOutputKeyRetirementUnavailableError {
  return new PluginPackagePromptOutputKeyRetirementUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function apiStatus(cause: unknown): number | null {
  if (!cause || typeof cause !== 'object') return null;
  if ('code' in cause && typeof cause.code === 'number') return cause.code;
  if (
    'response' in cause &&
    cause.response &&
    typeof cause.response === 'object' &&
    'statusCode' in cause.response &&
    typeof cause.response.statusCode === 'number'
  ) {
    return cause.response.statusCode;
  }
  return null;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function option(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new InvalidPluginPackagePromptOutputKeyRetirementError(
      `${label} is invalid`,
    );
  }
  return value;
}

function sameAbsentState(
  left: Readonly<{
    state: 'absent';
    keyId: string;
    catalogDigest: string;
    absenceProof: string;
  }>,
  right: PluginPackagePromptOutputKeyMaterialState,
): boolean {
  return (
    right.state === 'absent' &&
    right.keyId === left.keyId &&
    right.catalogDigest === left.catalogDigest &&
    right.absenceProof === left.absenceProof
  );
}

/**
 * Short-lived, resourceVersion-fenced adapter for one dedicated mutable Secret.
 * It owns no timer, watcher, cache, Secret creation, or runtime key resolution.
 */
export class ClusterPromptOutputKubernetesSecretKeyring
  implements PluginPackagePromptOutputKeyRetirementMaterialAuthority
{
  readonly #namespace: string;
  readonly #secretName: string;
  readonly #expectedSecretUid: string;
  readonly #dataKey: string;

  constructor(
    private readonly api: ClusterPromptOutputKubernetesSecretApi,
    options: ClusterPromptOutputKubernetesSecretKeyringOptions,
  ) {
    if (
      !api ||
      typeof api !== 'object' ||
      typeof api.readNamespacedSecret !== 'function' ||
      typeof api.replaceNamespacedSecret !== 'function' ||
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options)
    ) {
      throw new InvalidPluginPackagePromptOutputKeyRetirementError(
        'Kubernetes Secret keyring options are invalid',
      );
    }
    this.#namespace = option(options.namespace, DNS_LABEL, 'namespace');
    this.#secretName = option(options.secretName, DNS_SUBDOMAIN, 'secretName');
    this.#expectedSecretUid = option(
      options.expectedSecretUid,
      UID,
      'expectedSecretUid',
    );
    this.#dataKey = option(
      options.dataKey ?? 'keyring.json',
      DATA_KEY,
      'dataKey',
    );
  }

  async inspect(
    keyId: string,
  ): Promise<PluginPackagePromptOutputKeyMaterialState> {
    return inspectPluginPackagePromptOutputKeyringManifest(
      (await this.#read()).manifest,
      keyId,
    );
  }

  async retire(
    command: Readonly<{
      preparation: Readonly<PluginPackagePromptOutputKeyRetirementPreparation>;
    }>,
  ): Promise<
    Readonly<{
      state: 'absent';
      keyId: string;
      catalogDigest: string;
      absenceProof: string;
    }>
  > {
    const current = await this.#read();
    const mutation = retirePluginPackagePromptOutputKeyringManifest(
      current.manifest,
      command.preparation,
    );
    if (!mutation.changed) return mutation.state;
    try {
      const written = this.#parse(
        await this.api.replaceNamespacedSecret({
          name: this.#secretName,
          namespace: this.#namespace,
          body: this.#body(current, mutation.manifest),
          fieldManager: FIELD_MANAGER,
          fieldValidation: 'Strict',
        }),
      );
      const state = inspectPluginPackagePromptOutputKeyringManifest(
        written.manifest,
        mutation.state.keyId,
      );
      if (!sameAbsentState(mutation.state, state)) {
        throw new PluginPackagePromptOutputKeyRetirementConflictError();
      }
      return mutation.state;
    } catch (cause) {
      const status = apiStatus(cause);
      if (status !== 409 && status !== null) {
        if (
          cause instanceof
            PluginPackagePromptOutputKeyRetirementConflictError ||
          cause instanceof
            PluginPackagePromptOutputKeyRetirementUnavailableError
        ) {
          throw cause;
        }
        throw unavailable(cause);
      }
      try {
        const winner = retirePluginPackagePromptOutputKeyringManifest(
          (await this.#read()).manifest,
          command.preparation,
        );
        if (!winner.changed && sameAbsentState(mutation.state, winner.state)) {
          return winner.state;
        }
      } catch (replayCause) {
        if (status === null) throw unavailable(cause);
        throw replayCause;
      }
      if (status === null) throw unavailable(cause);
      throw new PluginPackagePromptOutputKeyRetirementConflictError();
    }
  }

  async rotate(
    command: Readonly<{
      expectedActiveKeyId: string;
      expectedCatalogDigest: string;
      newKeyId: string;
      material: Uint8Array;
    }>,
  ): Promise<
    Readonly<PluginPackagePromptOutputKeyringRotationMutation['state']>
  > {
    const current = await this.#read();
    const mutation = rotatePluginPackagePromptOutputKeyringManifest(
      current.manifest,
      command,
    );
    if (!mutation.changed) return mutation.state;
    try {
      const written = this.#parse(
        await this.api.replaceNamespacedSecret({
          name: this.#secretName,
          namespace: this.#namespace,
          body: this.#body(current, mutation.manifest),
          fieldManager: ROTATION_FIELD_MANAGER,
          fieldValidation: 'Strict',
        }),
      );
      const winner = rotatePluginPackagePromptOutputKeyringManifest(
        written.manifest,
        command,
      );
      if (winner.changed) {
        throw new PluginPackagePromptOutputKeyRetirementConflictError();
      }
      return winner.state;
    } catch (cause) {
      const status = apiStatus(cause);
      if (status !== 409 && status !== null) {
        if (
          cause instanceof
            PluginPackagePromptOutputKeyRetirementConflictError ||
          cause instanceof
            PluginPackagePromptOutputKeyRetirementUnavailableError
        ) {
          throw cause;
        }
        throw unavailable(cause);
      }
      try {
        const winner = rotatePluginPackagePromptOutputKeyringManifest(
          (await this.#read()).manifest,
          command,
        );
        if (!winner.changed) return winner.state;
      } catch (replayCause) {
        if (status === null) throw unavailable(cause);
        throw replayCause;
      }
      if (status === null) throw unavailable(cause);
      throw new PluginPackagePromptOutputKeyRetirementConflictError();
    }
  }

  async #read(): Promise<StoredKeyring> {
    try {
      return this.#parse(
        await this.api.readNamespacedSecret({
          name: this.#secretName,
          namespace: this.#namespace,
        }),
      );
    } catch (cause) {
      if (
        cause instanceof PluginPackagePromptOutputKeyRetirementConflictError ||
        cause instanceof PluginPackagePromptOutputKeyRetirementUnavailableError
      ) {
        throw cause;
      }
      throw unavailable(cause);
    }
  }

  #parse(secret: ClusterPromptOutputKubernetesSecret): StoredKeyring {
    const metadata = secret?.metadata;
    const data = secret?.data;
    const encoded = data?.[this.#dataKey];
    let bytes: Buffer | undefined;
    let canonical: Buffer | undefined;
    try {
      if (
        secret.apiVersion !== 'v1' ||
        secret.kind !== 'Secret' ||
        secret.type !== 'Opaque' ||
        secret.immutable !== false ||
        secret.stringData !== undefined ||
        !metadata ||
        metadata.name !== this.#secretName ||
        metadata.namespace !== this.#namespace ||
        metadata.uid !== this.#expectedSecretUid ||
        typeof metadata.resourceVersion !== 'string' ||
        !RESOURCE_VERSION.test(metadata.resourceVersion) ||
        metadata.deletionTimestamp !== undefined ||
        metadata.labels?.[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE ||
        metadata.labels?.[KEYRING_LABEL] !== KEYRING_LABEL_VALUE ||
        metadata.annotations?.[LAST_APPLIED_ANNOTATION] !== undefined ||
        !data ||
        !exactKeys(data, [this.#dataKey]) ||
        typeof encoded !== 'string' ||
        encoded.length < 1 ||
        encoded.length > MAX_SECRET_DATA_BYTES ||
        !BASE64.test(encoded)
      ) {
        throw unavailable();
      }
      bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) throw unavailable();
      const manifest = parsePluginPackagePromptOutputKeyringManifest(bytes);
      canonical = canonicalPluginPackagePromptOutputKeyringManifest(manifest);
      if (
        !bytes.equals(canonical) ||
        metadata.annotations?.[GENERATION_ANNOTATION] !==
          String(manifest.generation) ||
        metadata.annotations?.[CATALOG_DIGEST_ANNOTATION] !==
          pluginPackagePromptOutputKeyringCatalogDigest(manifest)
      ) {
        throw unavailable();
      }
      return Object.freeze({
        secret,
        manifest,
        resourceVersion: metadata.resourceVersion,
      });
    } catch (cause) {
      throw cause instanceof
        PluginPackagePromptOutputKeyRetirementUnavailableError
        ? cause
        : unavailable(cause);
    } finally {
      bytes?.fill(0);
      canonical?.fill(0);
    }
  }

  #body(
    current: StoredKeyring,
    manifest: Readonly<PluginPackagePromptOutputKeyringManifest>,
  ): ClusterPromptOutputKubernetesSecretWrite {
    const bytes = canonicalPluginPackagePromptOutputKeyringManifest(manifest);
    const { stringData: _ignoredStringData, ...secretWithoutStringData } =
      current.secret;
    try {
      return Object.freeze({
        ...secretWithoutStringData,
        apiVersion: 'v1' as const,
        kind: 'Secret' as const,
        type: 'Opaque' as const,
        immutable: false as const,
        metadata: Object.freeze({
          ...current.secret.metadata,
          name: this.#secretName,
          namespace: this.#namespace,
          uid: this.#expectedSecretUid,
          resourceVersion: current.resourceVersion,
          labels: Object.freeze({
            ...current.secret.metadata?.labels,
            [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
            [KEYRING_LABEL]: KEYRING_LABEL_VALUE,
          }),
          annotations: Object.freeze({
            ...current.secret.metadata?.annotations,
            [GENERATION_ANNOTATION]: String(manifest.generation),
            [CATALOG_DIGEST_ANNOTATION]:
              pluginPackagePromptOutputKeyringCatalogDigest(manifest),
          }),
        }),
        data: Object.freeze({ [this.#dataKey]: bytes.toString('base64') }),
      });
    } finally {
      bytes.fill(0);
    }
  }
}

export const clusterPromptOutputKubernetesSecretKeyringMetadata = Object.freeze(
  {
    fieldManager: FIELD_MANAGER,
    rotationFieldManager: ROTATION_FIELD_MANAGER,
    managedByLabel: MANAGED_BY_LABEL,
    managedByValue: MANAGED_BY_VALUE,
    keyringLabel: KEYRING_LABEL,
    keyringLabelValue: KEYRING_LABEL_VALUE,
    generationAnnotation: GENERATION_ANNOTATION,
    catalogDigestAnnotation: CATALOG_DIGEST_ANNOTATION,
  },
);
