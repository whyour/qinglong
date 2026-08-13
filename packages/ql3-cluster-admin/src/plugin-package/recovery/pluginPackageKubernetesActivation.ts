// Cluster Plugin Package recovery boundary; keep Kubernetes activation authority explicit.
import { createHash } from 'node:crypto';

import {
  PluginPackageActivationConflictError,
  PluginPackageActivationUnavailableError,
  normalizePluginPackageActivationIntent,
  type PluginPackageActivationIntent,
  type PluginPackageActivationObservation,
  type PluginPackageActivationPublisher,
} from '@qinglong/runtime-core/plugin-package-activation';
import type {
  PluginPackageResourceGeneration,
  PluginPackageResourceGenerationSource,
} from '@qinglong/runtime-core/plugin-package-resource-generation';
import {
  createPluginPackageActivationReceipt,
  normalizePluginPackageActivationReceipt,
  type PluginPackageActivationReceipt,
} from '@qinglong/runtime-core/plugin-package-install';
import type { PluginPackageSecretBindingRepository } from '@qinglong/runtime-core/plugin-package-secret-binding';
import type { PluginPackageSecretBindingTransitionReceiptRepository } from '@qinglong/runtime-core/plugin-package-secret-binding-transition-receipt';

import {
  createPluginPackageKubernetesSecretProjection,
  isPluginPackageKubernetesSecretName,
  normalizePluginPackageKubernetesSecretProjection,
  pluginPackageKubernetesProjectedSecretWorkloadVolume,
  type PluginPackageKubernetesActiveDeployment,
  type PluginPackageKubernetesProjectedSecretWorkloadVolume,
  type PluginPackageKubernetesSecretProjection,
  type PluginPackageKubernetesSecretProjectionAssignment,
  type PluginPackageKubernetesSecretProjectionItem,
} from '../secret-binding/pluginPackageKubernetesSecretProjection';

export {
  pluginPackageKubernetesProjectedSecretWorkloadVolume,
  type PluginPackageKubernetesActiveDeployment,
  type PluginPackageKubernetesProjectedSecretWorkloadVolume,
  type PluginPackageKubernetesSecretProjection,
  type PluginPackageKubernetesSecretProjectionAssignment,
  type PluginPackageKubernetesSecretProjectionItem,
};

const ACTIVE_POINTER_SCHEMA_V2 =
  'qinglong/plugin-package-kubernetes-active-pointer@v2';
const ACTIVE_POINTER_SCHEMA_V3 =
  'qinglong/plugin-package-kubernetes-active-pointer@v3';
const ACTIVE_POINTER_KEY = 'active.json';
const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
const MANAGED_BY_VALUE = 'qinglong3';
const ACTIVE_LABEL = 'qinglong.io/plugin-package-active';
const TARGET_LABEL = 'qinglong.io/plugin-package-target';
const INTENT_ANNOTATION = 'qinglong.io/plugin-package-intent';
const FIELD_MANAGER = 'qinglong-plugin-package-activation';
const MAX_ACTIVE_POINTER_BYTES = 512 * 1024;
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+=-]{0,511}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TARGET_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-kubernetes-target@v1\0',
  'utf8',
);

export interface ClusterPluginPackageStageEvidence {
  readonly lockDigest: string;
  readonly stageRef: string;
  readonly stageReceiptDigest: string;
  readonly stageEvidenceDigest: string;
  readonly contentDigest: string;
}

export interface ClusterPluginPackageStageEvidenceVerifier {
  verify(
    intent: Readonly<PluginPackageActivationIntent>,
  ): Promise<Readonly<ClusterPluginPackageStageEvidence>>;
}

export interface PluginPackageKubernetesActivationPublisherOptions {
  /** Stable operator-reviewed identity for one Kubernetes API cluster. */
  readonly clusterIdentity: string;
  readonly namespace: string;
  /** Explicit authoritative clock called only for a new publication attempt. */
  readonly now: () => number | Promise<number>;
  /**
   * Optional content-blind source used by the production recovery Job. When
   * configured, v3 pointers bind the exact projected Secret keys to the same
   * resourceVersion-fenced activation as the Package generation.
   */
  readonly secretProjection?: Readonly<{
    readonly sourceSecretName: string;
    readonly bindings: Pick<PluginPackageSecretBindingRepository, 'find'>;
    readonly transitions: Pick<
      PluginPackageSecretBindingTransitionReceiptRepository,
      'find'
    >;
  }>;
}

export interface PluginPackageKubernetesConfigMap {
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly immutable?: boolean;
  readonly data?: Readonly<Record<string, string>>;
  readonly binaryData?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<{
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    deletionTimestamp?: Date;
    finalizers?: readonly string[];
    ownerReferences?: readonly Readonly<Record<string, unknown>>[];
    labels?: Readonly<Record<string, string>>;
    annotations?: Readonly<Record<string, string>>;
  }>;
}

interface ConfigMapWrite extends PluginPackageKubernetesConfigMap {
  readonly metadata: NonNullable<PluginPackageKubernetesConfigMap['metadata']>;
  readonly data: Readonly<Record<string, string>>;
}

export interface PluginPackageKubernetesConfigMapApi {
  readNamespacedConfigMap(
    request: Readonly<{
      name: string;
      namespace: string;
    }>,
  ): Promise<PluginPackageKubernetesConfigMap>;
  createNamespacedConfigMap(
    request: Readonly<{
      namespace: string;
      body: ConfigMapWrite;
      fieldManager: string;
      fieldValidation: 'Strict';
    }>,
  ): Promise<PluginPackageKubernetesConfigMap>;
  replaceNamespacedConfigMap(
    request: Readonly<{
      name: string;
      namespace: string;
      body: ConfigMapWrite;
      fieldManager: string;
      fieldValidation: 'Strict';
    }>,
  ): Promise<PluginPackageKubernetesConfigMap>;
}

interface ActivePointerV2 {
  readonly schema: typeof ACTIVE_POINTER_SCHEMA_V2;
  readonly clusterIdentityDigest: string;
  readonly intent: Readonly<PluginPackageActivationIntent>;
  readonly receipt: Readonly<PluginPackageActivationReceipt>;
}

interface ActivePointerV3 {
  readonly schema: typeof ACTIVE_POINTER_SCHEMA_V3;
  readonly clusterIdentityDigest: string;
  readonly intent: Readonly<PluginPackageActivationIntent>;
  readonly receipt: Readonly<PluginPackageActivationReceipt>;
  readonly secretProjection: Readonly<PluginPackageKubernetesSecretProjection> | null;
}

type ActivePointer = ActivePointerV2 | ActivePointerV3;

type StoredPointer = ActivePointer & Readonly<{ resourceVersion: string }>;

function apiStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  if ('code' in error && typeof error.code === 'number') return error.code;
  if (
    'response' in error &&
    error.response &&
    typeof error.response === 'object' &&
    'statusCode' in error.response &&
    typeof error.response.statusCode === 'number'
  ) {
    return error.response.statusCode;
  }
  return null;
}

function preserveDomainError(error: unknown): never {
  if (
    error instanceof PluginPackageActivationConflictError ||
    error instanceof PluginPackageActivationUnavailableError
  ) {
    throw error;
  }
  throw new PluginPackageActivationUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

function dataRecord(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new PluginPackageActivationConflictError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    )
  ) {
    throw new PluginPackageActivationConflictError();
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new PluginPackageActivationConflictError();
  }
}

function boundedResourceId(value: unknown): string {
  if (typeof value !== 'string' || !RESOURCE_ID.test(value)) {
    throw new PluginPackageActivationUnavailableError();
  }
  return value;
}

function normalizeIntent(
  value: Readonly<PluginPackageActivationIntent>,
): Readonly<PluginPackageActivationIntent> {
  try {
    return normalizePluginPackageActivationIntent(value);
  } catch {
    throw new PluginPackageActivationConflictError();
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Short-lived Kubernetes ConfigMap publisher. It owns no timer, watcher,
 * database connection or cache; every replacement is resourceVersion fenced.
 */
export class PluginPackageKubernetesActivationPublisher
  implements
    PluginPackageActivationPublisher,
    PluginPackageResourceGenerationSource
{
  readonly #clusterIdentityDigest: string;

  constructor(
    private readonly api: PluginPackageKubernetesConfigMapApi,
    private readonly stageEvidence: ClusterPluginPackageStageEvidenceVerifier,
    private readonly options: PluginPackageKubernetesActivationPublisherOptions,
  ) {
    if (
      !api ||
      typeof api.readNamespacedConfigMap !== 'function' ||
      typeof api.createNamespacedConfigMap !== 'function' ||
      typeof api.replaceNamespacedConfigMap !== 'function'
    ) {
      throw new TypeError('Plugin Package Kubernetes ConfigMap API is invalid');
    }
    if (!stageEvidence || typeof stageEvidence.verify !== 'function') {
      throw new TypeError(
        'Plugin Package cluster stage evidence verifier is invalid',
      );
    }
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some(
        (key) =>
          key !== 'clusterIdentity' &&
          key !== 'namespace' &&
          key !== 'now' &&
          key !== 'secretProjection',
      ) ||
      !SAFE_IDENTITY.test(options.clusterIdentity) ||
      !DNS_LABEL.test(options.namespace) ||
      typeof options.now !== 'function' ||
      (options.secretProjection !== undefined &&
        (!options.secretProjection ||
          typeof options.secretProjection !== 'object' ||
          Array.isArray(options.secretProjection) ||
          Object.keys(options.secretProjection).sort().join(',') !==
            'bindings,sourceSecretName,transitions' ||
          !isPluginPackageKubernetesSecretName(
            options.secretProjection.sourceSecretName,
          ) ||
          !options.secretProjection.bindings ||
          typeof options.secretProjection.bindings.find !== 'function' ||
          !options.secretProjection.transitions ||
          typeof options.secretProjection.transitions.find !== 'function'))
    ) {
      throw new TypeError(
        'Plugin Package Kubernetes activation options are invalid',
      );
    }
    this.#clusterIdentityDigest = createHash('sha256')
      .update('qinglong/plugin-package-kubernetes-cluster@v1\0', 'utf8')
      .update(options.clusterIdentity, 'utf8')
      .digest('hex');
  }

  #targetDigest(
    identity: Readonly<
      Pick<PluginPackageActivationIntent, 'projectId' | 'packageName'>
    >,
  ): string {
    return createHash('sha256')
      .update(TARGET_DIGEST_DOMAIN)
      .update(this.#clusterIdentityDigest, 'utf8')
      .update('\0', 'utf8')
      .update(this.options.namespace, 'utf8')
      .update('\0', 'utf8')
      .update(identity.projectId, 'utf8')
      .update('\0', 'utf8')
      .update(identity.packageName, 'utf8')
      .digest('hex');
  }

  #name(
    identity: Readonly<
      Pick<PluginPackageActivationIntent, 'projectId' | 'packageName'>
    >,
  ): string {
    return `ql3p-${this.#targetDigest(identity).slice(0, 52)}`;
  }

  async #verifyStage(
    intent: Readonly<PluginPackageActivationIntent>,
  ): Promise<void> {
    let value: unknown;
    try {
      value = await this.stageEvidence.verify(intent);
    } catch (error) {
      return preserveDomainError(error);
    }
    const evidence = dataRecord(value);
    exactKeys(evidence, [
      'lockDigest',
      'stageRef',
      'stageReceiptDigest',
      'stageEvidenceDigest',
      'contentDigest',
    ]);
    if (
      evidence.lockDigest !== intent.lockDigest ||
      evidence.stageRef !== intent.stageRef ||
      evidence.stageReceiptDigest !== intent.stageReceiptDigest ||
      evidence.stageEvidenceDigest !== intent.stageEvidenceDigest ||
      evidence.contentDigest !== intent.contentDigest
    ) {
      throw new PluginPackageActivationConflictError();
    }
  }

  async #secretProjection(
    intent: Readonly<PluginPackageActivationIntent>,
  ): Promise<Readonly<PluginPackageKubernetesSecretProjection> | null> {
    const source = this.options.secretProjection;
    if (!source) return null;
    try {
      const generationDigest = intent.resourceGeneration.generationDigest;
      const [binding, transition] = await Promise.all([
        source.bindings.find(generationDigest),
        source.transitions.find(generationDigest),
      ]);
      if (
        binding &&
        (binding.target.installationId !== intent.installationId ||
          binding.target.projectId !== intent.projectId ||
          binding.target.packageName !== intent.packageName ||
          binding.target.lockDigest !== intent.lockDigest ||
          binding.target.generation !== intent.targetGeneration)
      ) {
        throw new PluginPackageActivationConflictError();
      }
      return createPluginPackageKubernetesSecretProjection(
        source.sourceSecretName,
        generationDigest,
        binding,
        transition,
      );
    } catch (error) {
      return preserveDomainError(error);
    }
  }

  #parsePointer(
    configMap: PluginPackageKubernetesConfigMap,
    expectedName: string,
  ): Readonly<StoredPointer> {
    try {
      const metadata = configMap?.metadata;
      if (
        configMap.apiVersion !== 'v1' ||
        configMap.kind !== 'ConfigMap' ||
        configMap.immutable === true ||
        configMap.binaryData !== undefined ||
        !metadata ||
        metadata.name !== expectedName ||
        metadata.namespace !== this.options.namespace ||
        metadata.deletionTimestamp !== undefined ||
        (metadata.finalizers?.length ?? 0) !== 0 ||
        (metadata.ownerReferences?.length ?? 0) !== 0 ||
        !configMap.data
      ) {
        throw new PluginPackageActivationConflictError();
      }
      const labels = dataRecord(metadata.labels);
      exactKeys(labels, [MANAGED_BY_LABEL, ACTIVE_LABEL, TARGET_LABEL]);
      const annotations = dataRecord(metadata.annotations);
      exactKeys(annotations, [INTENT_ANNOTATION]);
      const data = dataRecord(configMap.data);
      exactKeys(data, [ACTIVE_POINTER_KEY]);
      const serialized = data[ACTIVE_POINTER_KEY];
      if (
        labels[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE ||
        (labels[ACTIVE_LABEL] !== 'v2' && labels[ACTIVE_LABEL] !== 'v3') ||
        typeof serialized !== 'string' ||
        Buffer.byteLength(serialized, 'utf8') > MAX_ACTIVE_POINTER_BYTES
      ) {
        throw new PluginPackageActivationConflictError();
      }
      const pointer = dataRecord(JSON.parse(serialized));
      if (pointer.schema === ACTIVE_POINTER_SCHEMA_V2) {
        exactKeys(pointer, [
          'schema',
          'clusterIdentityDigest',
          'intent',
          'receipt',
        ]);
      } else if (pointer.schema === ACTIVE_POINTER_SCHEMA_V3) {
        exactKeys(pointer, [
          'schema',
          'clusterIdentityDigest',
          'intent',
          'receipt',
          'secretProjection',
        ]);
      } else {
        throw new PluginPackageActivationConflictError();
      }
      const intent = normalizeIntent(
        pointer.intent as PluginPackageActivationIntent,
      );
      const receipt = normalizePluginPackageActivationReceipt(pointer.receipt);
      const secretProjection =
        pointer.schema === ACTIVE_POINTER_SCHEMA_V3
          ? pointer.secretProjection === null
            ? null
            : normalizePluginPackageKubernetesSecretProjection(
                pointer.secretProjection,
              )
          : undefined;
      const normalized: ActivePointer =
        pointer.schema === ACTIVE_POINTER_SCHEMA_V3
          ? Object.freeze({
              schema: ACTIVE_POINTER_SCHEMA_V3,
              clusterIdentityDigest: this.#clusterIdentityDigest,
              intent,
              receipt,
              secretProjection: secretProjection!,
            })
          : Object.freeze({
              schema: ACTIVE_POINTER_SCHEMA_V2,
              clusterIdentityDigest: this.#clusterIdentityDigest,
              intent,
              receipt,
            });
      if (
        pointer.clusterIdentityDigest !== this.#clusterIdentityDigest ||
        this.#name(intent) !== expectedName ||
        labels[TARGET_LABEL] !==
          Buffer.from(this.#targetDigest(intent), 'hex').toString(
            'base64url',
          ) ||
        labels[ACTIVE_LABEL] !==
          (pointer.schema === ACTIVE_POINTER_SCHEMA_V3 ? 'v3' : 'v2') ||
        (secretProjection !== undefined &&
          secretProjection !== null &&
          secretProjection.generationDigest !==
            intent.resourceGeneration.generationDigest) ||
        annotations[INTENT_ANNOTATION] !== intent.intentDigest ||
        receipt.intentDigest !== intent.intentDigest ||
        receipt.generation !== intent.targetGeneration ||
        receipt.contentDigest !== intent.contentDigest ||
        `${JSON.stringify(normalized)}\n` !== serialized
      ) {
        throw new PluginPackageActivationConflictError();
      }
      boundedResourceId(metadata.uid);
      return Object.freeze({
        ...normalized,
        resourceVersion: boundedResourceId(metadata.resourceVersion),
      });
    } catch (error) {
      return preserveDomainError(error);
    }
  }

  async #optionalPointer(
    identity: Readonly<
      Pick<PluginPackageActivationIntent, 'projectId' | 'packageName'>
    >,
  ): Promise<Readonly<StoredPointer> | null> {
    const name = this.#name(identity);
    try {
      return this.#parsePointer(
        await this.api.readNamespacedConfigMap({
          name,
          namespace: this.options.namespace,
        }),
        name,
      );
    } catch (error) {
      if (apiStatus(error) === 404) return null;
      return preserveDomainError(error);
    }
  }

  async #observe(
    intent: Readonly<PluginPackageActivationIntent>,
  ): Promise<Readonly<PluginPackageActivationObservation>> {
    await this.#verifyStage(intent);
    const expectedProjection = await this.#secretProjection(intent);
    const pointer = await this.#optionalPointer(intent);
    if (!pointer) {
      if (intent.previousActiveLockDigest !== null) {
        throw new PluginPackageActivationConflictError();
      }
      return Object.freeze({ status: 'not_published' });
    }
    if (
      same(pointer.intent, intent) &&
      (pointer.schema === ACTIVE_POINTER_SCHEMA_V2
        ? expectedProjection === null
        : same(pointer.secretProjection, expectedProjection))
    ) {
      return Object.freeze({ status: 'published', receipt: pointer.receipt });
    }
    if (
      pointer.intent.projectId === intent.projectId &&
      pointer.intent.packageName === intent.packageName &&
      pointer.intent.lockDigest === intent.previousActiveLockDigest
    ) {
      return Object.freeze({ status: 'not_published' });
    }
    throw new PluginPackageActivationConflictError();
  }

  #body(
    intent: Readonly<PluginPackageActivationIntent>,
    receipt: Readonly<PluginPackageActivationReceipt>,
    current: Readonly<StoredPointer> | null,
    secretProjection: Readonly<PluginPackageKubernetesSecretProjection> | null,
  ): ConfigMapWrite {
    const targetDigest = this.#targetDigest(intent);
    const usesSecretProjection = secretProjection !== null;
    const pointer: Readonly<ActivePointer> = usesSecretProjection
      ? Object.freeze({
          schema: ACTIVE_POINTER_SCHEMA_V3,
          clusterIdentityDigest: this.#clusterIdentityDigest,
          intent,
          receipt,
          secretProjection,
        })
      : Object.freeze({
          schema: ACTIVE_POINTER_SCHEMA_V2,
          clusterIdentityDigest: this.#clusterIdentityDigest,
          intent,
          receipt,
        });
    const serialized = `${JSON.stringify(pointer)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_ACTIVE_POINTER_BYTES) {
      throw new PluginPackageActivationUnavailableError();
    }
    return Object.freeze({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      immutable: false,
      metadata: Object.freeze({
        name: this.#name(intent),
        namespace: this.options.namespace,
        ...(current ? { resourceVersion: current.resourceVersion } : {}),
        labels: Object.freeze({
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [ACTIVE_LABEL]: usesSecretProjection ? 'v3' : 'v2',
          [TARGET_LABEL]: Buffer.from(targetDigest, 'hex').toString(
            'base64url',
          ),
        }),
        annotations: Object.freeze({
          [INTENT_ANNOTATION]: intent.intentDigest,
        }),
      }),
      data: Object.freeze({ [ACTIVE_POINTER_KEY]: serialized }),
    });
  }

  async inspect(
    value: Readonly<PluginPackageActivationIntent>,
  ): Promise<Readonly<PluginPackageActivationObservation>> {
    try {
      return await this.#observe(normalizeIntent(value));
    } catch (error) {
      return preserveDomainError(error);
    }
  }

  async findActiveResourceGeneration(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageResourceGeneration> | null> {
    if (
      typeof projectId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId) ||
      typeof packageName !== 'string' ||
      !DNS_LABEL.test(packageName)
    ) {
      throw new TypeError('Plugin Package active resource identity is invalid');
    }
    try {
      return (
        (await this.#optionalPointer(Object.freeze({ projectId, packageName })))
          ?.intent.resourceGeneration ?? null
      );
    } catch (error) {
      return preserveDomainError(error);
    }
  }

  /**
   * Returns one parsed active deployment snapshot for a workload renderer.
   * It performs no Secret API call and exposes only projection keys, never
   * Secret material or reversible Secret references.
   */
  async findActiveDeployment(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageKubernetesActiveDeployment> | null> {
    if (
      typeof projectId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId) ||
      typeof packageName !== 'string' ||
      !DNS_LABEL.test(packageName)
    ) {
      throw new TypeError(
        'Plugin Package active deployment identity is invalid',
      );
    }
    try {
      const pointer = await this.#optionalPointer(
        Object.freeze({ projectId, packageName }),
      );
      if (!pointer) return null;
      return Object.freeze({
        resourceGeneration: pointer.intent.resourceGeneration,
        secretProjection:
          pointer.schema === ACTIVE_POINTER_SCHEMA_V3
            ? pointer.secretProjection
            : null,
      });
    } catch (error) {
      return preserveDomainError(error);
    }
  }

  async publish(
    value: Readonly<PluginPackageActivationIntent>,
  ): Promise<Readonly<PluginPackageActivationReceipt>> {
    const intent = normalizeIntent(value);
    try {
      const first = await this.#observe(intent);
      if (first.status === 'published') return first.receipt;
      const current = await this.#optionalPointer(intent);
      if (current && same(current.intent, intent)) {
        const expectedProjection = await this.#secretProjection(intent);
        if (
          (current.schema === ACTIVE_POINTER_SCHEMA_V2 &&
            expectedProjection === null) ||
          (current.schema === ACTIVE_POINTER_SCHEMA_V3 &&
            same(current.secretProjection, expectedProjection))
        ) {
          return current.receipt;
        }
        throw new PluginPackageActivationConflictError();
      }
      if (
        (!current && intent.previousActiveLockDigest !== null) ||
        (current &&
          (current.intent.projectId !== intent.projectId ||
            current.intent.packageName !== intent.packageName ||
            current.intent.lockDigest !== intent.previousActiveLockDigest))
      ) {
        throw new PluginPackageActivationConflictError();
      }
      const activatedAtMs = await this.options.now();
      if (!Number.isSafeInteger(activatedAtMs) || activatedAtMs < 0) {
        throw new PluginPackageActivationUnavailableError();
      }
      const receipt = createPluginPackageActivationReceipt({
        activationRef: `k8s-configmap:${this.#targetDigest(intent)}`,
        intentDigest: intent.intentDigest,
        generation: intent.targetGeneration,
        contentDigest: intent.contentDigest,
        activatedAtMs,
      });
      const secretProjection = await this.#secretProjection(intent);
      const body = this.#body(intent, receipt, current, secretProjection);
      try {
        if (current) {
          await this.api.replaceNamespacedConfigMap({
            name: this.#name(intent),
            namespace: this.options.namespace,
            body,
            fieldManager: FIELD_MANAGER,
            fieldValidation: 'Strict',
          });
        } else {
          await this.api.createNamespacedConfigMap({
            namespace: this.options.namespace,
            body,
            fieldManager: FIELD_MANAGER,
            fieldValidation: 'Strict',
          });
        }
      } catch (error) {
        if (apiStatus(error) !== 409) return preserveDomainError(error);
        const winner = await this.#observe(intent);
        if (winner.status === 'published') return winner.receipt;
        throw new PluginPackageActivationConflictError();
      }
      const final = await this.#observe(intent);
      if (final.status !== 'published') {
        throw new PluginPackageActivationUnavailableError();
      }
      return final.receipt;
    } catch (error) {
      return preserveDomainError(error);
    }
  }
}
