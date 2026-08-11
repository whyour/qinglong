/** Kubernetes-backed Worker credential delivery adapter boundary. */
import { createHash } from 'node:crypto';
import {
  WorkerCredentialDeliveryConflictError,
  WorkerCredentialDeliveryUnavailableError,
  normalizeWorkerCredentialDeliveryIntent,
  normalizeWorkerCredentialDeliveryRecord,
  workerCredentialDeliveryTokenDigest,
  type WorkerCredentialDeliveryIntent,
  type WorkerCredentialDeliveryRecord,
} from '@qinglong/runtime-core/worker-credential-delivery';
import type {
  WorkerCredentialStagedSecretInventoryAdapter,
  WorkerCredentialStagedSecretPage,
} from './workerCredentialDelivery';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN =
  /^ql3w_([A-Za-z0-9][A-Za-z0-9._:-]{0,63})_([A-Za-z0-9_-]{43})$/;
const DNS_LABEL =
  /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN =
  /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const DATA_KEY = /^[A-Za-z0-9._-]{1,253}$/;
const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+=-]{0,511}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const STAGE_TYPE = 'qinglong.io/worker-credential-stage-v1';
const TARGET_TYPE = 'Opaque';
const STAGE_TOKEN_KEY = 'credentialToken';
const STAGE_LABEL = 'qinglong.io/worker-credential-stage';
const TARGET_LABEL = 'qinglong.io/worker-credential-target';
const TARGET_PREPARED_VALUE = 'prepared-v3';
const TARGET_ACTIVE_VALUE = 'v3';
const TARGET_DIGEST_LABEL = 'qinglong.io/worker-credential-target-digest';
const INTENT_ANNOTATION = 'qinglong.io/worker-credential-intent';
const DELIVERY_ANNOTATION = 'qinglong.io/worker-credential-delivery-id';
const GENERATION_ANNOTATION = 'qinglong.io/worker-credential-generation';
const TOKEN_DIGEST_ANNOTATION = 'qinglong.io/worker-credential-token-digest';
const CREDENTIAL_ID_ANNOTATION = 'qinglong.io/worker-credential-id';
const PUBLICATION_DIGEST_ANNOTATION =
  'qinglong.io/worker-credential-publication-digest';
const KUBECTL_LAST_APPLIED_ANNOTATION =
  'kubectl.kubernetes.io/last-applied-configuration';
const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
const MANAGED_BY_VALUE = 'qinglong3';
const FIELD_MANAGER = 'qinglong-worker-credential-delivery';
const MAX_INTENT_BYTES = 4096;
const MAX_TOKEN_BYTES = 256;
export const MAX_WORKER_CREDENTIAL_KUBERNETES_STAGES = 128;
export const MAX_WORKER_CREDENTIAL_KUBERNETES_STAGE_PAGE_SIZE = 64;

const TARGET_DIGEST_DOMAIN = Buffer.from(
  'qinglong/worker-credential-kubernetes-target@v3\0',
  'utf8',
);
const PUBLICATION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/worker-credential-kubernetes-publication@v3\0',
  'utf8',
);

export interface WorkerCredentialKubernetesDeliveryAdapterOptions {
  /** Stable operator-reviewed identity for one Kubernetes API cluster. */
  readonly clusterIdentity: string;
  /** Dedicated namespace containing only immutable delivery stage Secrets. */
  readonly stageNamespace: string;
  /** Worker namespace containing the prepared target Secret and Deployment. */
  readonly namespace: string;
  /** Dedicated mutable Opaque Secret read by one Worker deployment. */
  readonly targetSecretName: string;
  /** Single-replica Recreate Deployment that projects the target Secret. */
  readonly targetDeploymentName: string;
  readonly targetDataKey?: string;
}

export interface WorkerCredentialKubernetesDeployment {
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly metadata?: Readonly<{
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    deletionTimestamp?: Date;
    labels?: Readonly<Record<string, string>>;
    annotations?: Readonly<Record<string, string>>;
    [key: string]: unknown;
  }>;
  readonly spec?: Readonly<{
    replicas?: number;
    strategy?: Readonly<{ type?: string; [key: string]: unknown }>;
    template?: Readonly<{
      metadata?: Readonly<{
        labels?: Readonly<Record<string, string>>;
        annotations?: Readonly<Record<string, string>>;
        [key: string]: unknown;
      }>;
      spec?: Readonly<{
        volumes?: readonly Readonly<{
          projected?: Readonly<{
            sources?: readonly Readonly<{
              secret?: Readonly<{
                name?: string;
                items?: readonly Readonly<{ key?: string; path?: string }>[];
              }>;
            }>[];
          }>;
        }>[];
        [key: string]: unknown;
      }>;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  }>;
  readonly [key: string]: unknown;
}

interface DeploymentWrite extends WorkerCredentialKubernetesDeployment {
  metadata: NonNullable<WorkerCredentialKubernetesDeployment['metadata']>;
  spec: NonNullable<WorkerCredentialKubernetesDeployment['spec']>;
}

export interface WorkerCredentialKubernetesDeploymentApi {
  readNamespacedDeployment(request: Readonly<{
    name: string;
    namespace: string;
  }>): Promise<WorkerCredentialKubernetesDeployment>;
  replaceNamespacedDeployment(request: Readonly<{
    name: string;
    namespace: string;
    body: DeploymentWrite;
    fieldManager: string;
    fieldValidation: 'Strict';
  }>): Promise<WorkerCredentialKubernetesDeployment>;
}

export interface WorkerCredentialKubernetesSecret {
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
    deletionTimestamp?: Date;
    finalizers?: readonly string[];
    ownerReferences?: readonly Readonly<Record<string, unknown>>[];
    labels?: Readonly<Record<string, string>>;
    annotations?: Readonly<Record<string, string>>;
  }>;
}

interface SecretWrite extends WorkerCredentialKubernetesSecret {
  metadata: NonNullable<WorkerCredentialKubernetesSecret['metadata']>;
  data: Readonly<Record<string, string>>;
}

export interface WorkerCredentialKubernetesSecretApi {
  readNamespacedSecret(request: Readonly<{
    name: string;
    namespace: string;
  }>): Promise<WorkerCredentialKubernetesSecret>;
  createNamespacedSecret(request: Readonly<{
    namespace: string;
    body: SecretWrite;
    fieldManager: string;
    fieldValidation: 'Strict';
  }>): Promise<WorkerCredentialKubernetesSecret>;
  replaceNamespacedSecret(request: Readonly<{
    name: string;
    namespace: string;
    body: SecretWrite;
    fieldManager: string;
    fieldValidation: 'Strict';
  }>): Promise<WorkerCredentialKubernetesSecret>;
  deleteNamespacedSecret(request: Readonly<{
    name: string;
    namespace: string;
    gracePeriodSeconds: 0;
    propagationPolicy: 'Background';
    body: Readonly<{
      apiVersion: 'v1';
      kind: 'DeleteOptions';
      gracePeriodSeconds: 0;
      preconditions: Readonly<{ uid: string; resourceVersion: string }>;
    }>;
  }>): Promise<unknown>;
  listNamespacedSecret(request: Readonly<{
    namespace: string;
    labelSelector: string;
    limit: number;
    resourceVersion: '0';
  }>): Promise<Readonly<{
    items: readonly WorkerCredentialKubernetesSecret[];
    metadata?: Readonly<{ _continue?: string }>;
  }>>;
}

interface ParsedToken {
  readonly credentialId: string;
  readonly tokenDigest: string;
  readonly material: Buffer;
}

interface StoredStage {
  readonly intent: Readonly<WorkerCredentialDeliveryIntent>;
  readonly token: Buffer;
  readonly uid: string;
  readonly resourceVersion: string;
}

interface StoredTarget {
  readonly kind: 'active';
  readonly secret: WorkerCredentialKubernetesSecret;
  readonly credentialId: string;
  readonly tokenDigest: string;
  readonly uid: string;
  readonly resourceVersion: string;
}

interface StoredPreparedTarget {
  readonly kind: 'prepared';
  readonly secret: WorkerCredentialKubernetesSecret;
  readonly uid: string;
  readonly resourceVersion: string;
}

type StoredTargetState = StoredPreparedTarget | StoredTarget;

interface StoredDeployment {
  readonly deployment: WorkerCredentialKubernetesDeployment;
  readonly uid: string;
  readonly resourceVersion: string;
}

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
    error instanceof WorkerCredentialDeliveryConflictError ||
    error instanceof WorkerCredentialDeliveryUnavailableError
  ) {
    throw error;
  }
  throw new WorkerCredentialDeliveryUnavailableError();
}

function boundedResourceId(value: unknown): string {
  if (typeof value !== 'string' || !RESOURCE_ID.test(value)) {
    throw new WorkerCredentialDeliveryUnavailableError();
  }
  return value;
}

function decodeCanonicalBase64(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new WorkerCredentialDeliveryUnavailableError();
  }
  const material = Buffer.from(value, 'base64');
  if (
    material.byteLength < 1 ||
    material.byteLength > MAX_TOKEN_BYTES ||
    material.toString('base64') !== value
  ) {
    material.fill(0);
    throw new WorkerCredentialDeliveryUnavailableError();
  }
  return material;
}

function parseToken(value: Buffer): ParsedToken {
  if (!Buffer.isBuffer(value) || value.byteLength > MAX_TOKEN_BYTES) {
    throw new WorkerCredentialDeliveryConflictError();
  }
  const text = value.toString('ascii');
  const match = TOKEN.exec(text);
  if (!match || Buffer.byteLength(text, 'ascii') !== value.byteLength) {
    throw new WorkerCredentialDeliveryConflictError();
  }
  return Object.freeze({
    credentialId: match[1]!,
    tokenDigest: workerCredentialDeliveryTokenDigest(value),
    material: value,
  });
}

function sameIntent(
  left: Readonly<WorkerCredentialDeliveryIntent>,
  right: Readonly<WorkerCredentialDeliveryIntent>,
): boolean {
  return left.deliveryId === right.deliveryId &&
    left.workerId === right.workerId &&
    left.credentialId === right.credentialId &&
    left.credentialVersion === right.credentialVersion &&
    left.previousCredentialId === right.previousCredentialId &&
    left.secretDigest === right.secretDigest &&
    left.tokenDigest === right.tokenDigest &&
    left.deploymentTargetDigest === right.deploymentTargetDigest &&
    left.deploymentGeneration === right.deploymentGeneration &&
    left.stagedAtMs === right.stagedAtMs;
}

function recordMatchesIntent(
  record: Readonly<WorkerCredentialDeliveryRecord>,
  intent: Readonly<WorkerCredentialDeliveryIntent>,
): boolean {
  return sameIntent(record, intent);
}

function stageName(deliveryId: string): string {
  if (!UUID_V4.test(deliveryId)) {
    throw new WorkerCredentialDeliveryConflictError();
  }
  return `ql3w-stage-${deliveryId.replaceAll('-', '')}`;
}

/**
 * Computes the immutable delivery target identity without acquiring a
 * Kubernetes client. Management planning uses the same digest that the
 * short-lived delivery adapter rechecks after approval consumption.
 */
export function workerCredentialKubernetesDeploymentTargetDigest(
  options: WorkerCredentialKubernetesDeliveryAdapterOptions,
): string {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) =>
      ![
        'clusterIdentity',
        'stageNamespace',
        'namespace',
        'targetSecretName',
        'targetDeploymentName',
        'targetDataKey',
      ].includes(key)) ||
    !SAFE_IDENTITY.test(options.clusterIdentity) ||
    !DNS_LABEL.test(options.stageNamespace) ||
    !DNS_LABEL.test(options.namespace) ||
    options.stageNamespace === options.namespace ||
    !DNS_SUBDOMAIN.test(options.targetSecretName) ||
    Buffer.byteLength(options.targetSecretName, 'utf8') > 253 ||
    !DNS_SUBDOMAIN.test(options.targetDeploymentName) ||
    Buffer.byteLength(options.targetDeploymentName, 'utf8') > 253 ||
    (options.targetDataKey !== undefined && !DATA_KEY.test(options.targetDataKey))
  ) {
    throw new TypeError('Worker credential Kubernetes delivery options are invalid');
  }
  return createHash('sha256')
    .update(TARGET_DIGEST_DOMAIN)
    .update(options.clusterIdentity, 'utf8')
    .update('\0', 'utf8')
    .update(options.stageNamespace, 'utf8')
    .update('\0', 'utf8')
    .update(options.namespace, 'utf8')
    .update('\0', 'utf8')
    .update(options.targetSecretName, 'utf8')
    .update('\0', 'utf8')
    .update(options.targetDataKey ?? 'credentialToken', 'utf8')
    .update('\0', 'utf8')
    .update(options.targetDeploymentName, 'utf8')
    .digest('hex');
}

/**
 * Short-lived Kubernetes Secret adapter. It owns no timer, watcher or cache;
 * all publication and deletion mutations are resourceVersion fenced.
 */
export class WorkerCredentialKubernetesDeliveryAdapter
  implements WorkerCredentialStagedSecretInventoryAdapter {
  readonly deploymentTargetDigest: string;
  private readonly targetDigestLabel: string;
  private readonly targetDataKey: string;

  constructor(
    private readonly api: WorkerCredentialKubernetesSecretApi,
    private readonly deploymentApi: WorkerCredentialKubernetesDeploymentApi,
    private readonly options: WorkerCredentialKubernetesDeliveryAdapterOptions,
  ) {
    if (
      !api ||
      typeof api.readNamespacedSecret !== 'function' ||
      typeof api.createNamespacedSecret !== 'function' ||
      typeof api.replaceNamespacedSecret !== 'function' ||
      typeof api.deleteNamespacedSecret !== 'function' ||
      typeof api.listNamespacedSecret !== 'function'
    ) {
      throw new TypeError('Worker credential Kubernetes Secret API is invalid');
    }
    if (
      !deploymentApi ||
      typeof deploymentApi.readNamespacedDeployment !== 'function' ||
      typeof deploymentApi.replaceNamespacedDeployment !== 'function'
    ) {
      throw new TypeError('Worker credential Kubernetes Deployment API is invalid');
    }
    this.deploymentTargetDigest =
      workerCredentialKubernetesDeploymentTargetDigest(options);
    this.targetDataKey = options.targetDataKey ?? 'credentialToken';
    this.targetDigestLabel = Buffer.from(
      this.deploymentTargetDigest,
      'hex',
    ).toString('base64url');
  }

  private normalizeIntent(
    value: Readonly<WorkerCredentialDeliveryIntent>,
  ): Readonly<WorkerCredentialDeliveryIntent> {
    const intent = normalizeWorkerCredentialDeliveryIntent(value);
    if (intent.deploymentTargetDigest !== this.deploymentTargetDigest) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    return intent;
  }

  private parseStage(
    secret: WorkerCredentialKubernetesSecret,
    expectedDeliveryId?: string,
  ): StoredStage {
    let token: Buffer | undefined;
    try {
      const metadata = secret?.metadata;
      const annotation = metadata?.annotations?.[INTENT_ANNOTATION];
      if (
        !metadata ||
        metadata.namespace !== this.options.stageNamespace ||
        typeof metadata.name !== 'string' ||
        metadata.name !== stageName(
          expectedDeliveryId ?? metadata.annotations?.[DELIVERY_ANNOTATION] ?? '',
        ) ||
        metadata.deletionTimestamp !== undefined ||
        (metadata.finalizers?.length ?? 0) !== 0 ||
        metadata.labels?.[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE ||
        metadata.labels?.[STAGE_LABEL] !== 'v1' ||
        secret.type !== STAGE_TYPE ||
        secret.immutable !== true ||
        secret.stringData !== undefined ||
        !secret.data ||
        Object.keys(secret.data).length !== 1 ||
        !Object.prototype.hasOwnProperty.call(secret.data, STAGE_TOKEN_KEY) ||
        typeof annotation !== 'string' ||
        Buffer.byteLength(annotation, 'utf8') > MAX_INTENT_BYTES
      ) {
        throw new WorkerCredentialDeliveryUnavailableError();
      }
      const intent = this.normalizeIntent(JSON.parse(annotation));
      if (
        metadata.annotations?.[DELIVERY_ANNOTATION] !== intent.deliveryId ||
        (expectedDeliveryId !== undefined && intent.deliveryId !== expectedDeliveryId)
      ) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      token = decodeCanonicalBase64(secret.data[STAGE_TOKEN_KEY]);
      const parsed = parseToken(token);
      if (
        parsed.credentialId !== intent.credentialId ||
        parsed.tokenDigest !== intent.tokenDigest
      ) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      const result = Object.freeze({
        intent,
        token,
        uid: boundedResourceId(metadata.uid),
        resourceVersion: boundedResourceId(metadata.resourceVersion),
      });
      token = undefined;
      return result;
    } catch (error) {
      return preserveDomainError(error);
    } finally {
      token?.fill(0);
    }
  }

  private parseTarget(secret: WorkerCredentialKubernetesSecret): StoredTarget {
    let token: Buffer | undefined;
    try {
      const metadata = secret?.metadata;
      if (
        !metadata ||
        metadata.name !== this.options.targetSecretName ||
        metadata.namespace !== this.options.namespace ||
        metadata.deletionTimestamp !== undefined ||
        metadata.labels?.[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE ||
        metadata.labels?.[TARGET_LABEL] !== TARGET_ACTIVE_VALUE ||
        metadata.labels?.[TARGET_DIGEST_LABEL] !== this.targetDigestLabel ||
        secret.type !== TARGET_TYPE ||
        secret.immutable === true ||
        secret.stringData !== undefined ||
        !secret.data ||
        Object.keys(secret.data).length !== 1 ||
        !Object.prototype.hasOwnProperty.call(secret.data, this.targetDataKey)
      ) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      token = decodeCanonicalBase64(secret.data[this.targetDataKey]);
      const parsed = parseToken(token);
      return Object.freeze({
        kind: 'active' as const,
        secret,
        credentialId: parsed.credentialId,
        tokenDigest: parsed.tokenDigest,
        uid: boundedResourceId(metadata.uid),
        resourceVersion: boundedResourceId(metadata.resourceVersion),
      });
    } catch (error) {
      return preserveDomainError(error);
    } finally {
      token?.fill(0);
    }
  }

  private parsePreparedTarget(
    secret: WorkerCredentialKubernetesSecret,
  ): StoredPreparedTarget {
    try {
      const metadata = secret?.metadata;
      const preparedAnnotations = Object.entries(metadata?.annotations ?? {});
      if (
        !metadata ||
        metadata.name !== this.options.targetSecretName ||
        metadata.namespace !== this.options.namespace ||
        metadata.deletionTimestamp !== undefined ||
        (metadata.finalizers?.length ?? 0) !== 0 ||
        (metadata.ownerReferences?.length ?? 0) !== 0 ||
        metadata.labels?.[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE ||
        metadata.labels?.[TARGET_LABEL] !== TARGET_PREPARED_VALUE ||
        metadata.labels?.[TARGET_DIGEST_LABEL] !== undefined ||
        secret.type !== TARGET_TYPE ||
        secret.immutable === true ||
        secret.stringData !== undefined ||
        Object.keys(secret.data ?? {}).length !== 0 ||
        preparedAnnotations.some(([key, value]) =>
          key !== KUBECTL_LAST_APPLIED_ANNOTATION ||
          typeof value !== 'string' ||
          Buffer.byteLength(value, 'utf8') > MAX_INTENT_BYTES)
      ) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      return Object.freeze({
        kind: 'prepared' as const,
        secret,
        uid: boundedResourceId(metadata.uid),
        resourceVersion: boundedResourceId(metadata.resourceVersion),
      });
    } catch (error) {
      return preserveDomainError(error);
    }
  }

  private async optionalStage(deliveryId: string): Promise<StoredStage | null> {
    try {
      return this.parseStage(await this.api.readNamespacedSecret({
        name: stageName(deliveryId),
        namespace: this.options.stageNamespace,
      }), deliveryId);
    } catch (error) {
      if (apiStatus(error) === 404) return null;
      return preserveDomainError(error);
    }
  }

  private async currentTarget(): Promise<StoredTargetState> {
    try {
      const secret = await this.api.readNamespacedSecret({
        name: this.options.targetSecretName,
        namespace: this.options.namespace,
      });
      return secret.metadata?.labels?.[TARGET_LABEL] === TARGET_PREPARED_VALUE
        ? this.parsePreparedTarget(secret)
        : this.parseTarget(secret);
    } catch (error) {
      return preserveDomainError(error);
    }
  }

  private async boundedStageSecrets(): Promise<
    readonly WorkerCredentialKubernetesSecret[]
  > {
    const result = await this.api.listNamespacedSecret({
      namespace: this.options.stageNamespace,
      labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${STAGE_LABEL}=v1`,
      limit: MAX_WORKER_CREDENTIAL_KUBERNETES_STAGES + 1,
      resourceVersion: '0',
    });
    if (
      !result ||
      !Array.isArray(result.items) ||
      result.items.length > MAX_WORKER_CREDENTIAL_KUBERNETES_STAGES ||
      (result.metadata?._continue?.length ?? 0) > 0
    ) {
      throw new WorkerCredentialDeliveryUnavailableError();
    }
    return result.items;
  }

  private publishedMatches(
    target: StoredTarget,
    delivery: Readonly<WorkerCredentialDeliveryRecord> | Readonly<WorkerCredentialDeliveryIntent>,
  ): boolean {
    const annotations = target.secret.metadata?.annotations;
    return target.credentialId === delivery.credentialId &&
      target.tokenDigest === delivery.tokenDigest &&
      annotations?.[DELIVERY_ANNOTATION] === delivery.deliveryId &&
      annotations?.[GENERATION_ANNOTATION] === delivery.deploymentGeneration &&
      annotations?.[TOKEN_DIGEST_ANNOTATION] === delivery.tokenDigest;
  }

  private publicationDigest(
    delivery: Readonly<WorkerCredentialDeliveryRecord>,
    target: StoredTarget,
  ): string {
    return createHash('sha256')
      .update(PUBLICATION_DIGEST_DOMAIN)
      .update(this.deploymentTargetDigest, 'utf8')
      .update('\0', 'utf8')
      .update(target.uid, 'utf8')
      .update('\0', 'utf8')
      .update(JSON.stringify({
        deliveryId: delivery.deliveryId,
        workerId: delivery.workerId,
        credentialId: delivery.credentialId,
        credentialVersion: delivery.credentialVersion,
        previousCredentialId: delivery.previousCredentialId,
        tokenDigest: delivery.tokenDigest,
        deploymentGeneration: delivery.deploymentGeneration,
      }), 'utf8')
      .digest('hex');
  }

  private parseDeployment(
    deployment: WorkerCredentialKubernetesDeployment,
  ): StoredDeployment {
    try {
      const metadata = deployment?.metadata;
      const spec = deployment?.spec;
      const template = spec?.template;
      const projectedSources = template?.spec?.volumes?.flatMap(
        (volume) => volume.projected?.sources ?? [],
      ) ?? [];
      const targetProjection = projectedSources.some((source) =>
        source.secret?.name === this.options.targetSecretName &&
        source.secret.items?.some((item) =>
          item.key === this.targetDataKey &&
          typeof item.path === 'string' &&
          item.path.length > 0));
      if (
        deployment.apiVersion !== 'apps/v1' ||
        deployment.kind !== 'Deployment' ||
        !metadata ||
        metadata.name !== this.options.targetDeploymentName ||
        metadata.namespace !== this.options.namespace ||
        metadata.deletionTimestamp !== undefined ||
        metadata.labels?.['app.kubernetes.io/component'] !== 'worker' ||
        spec?.replicas !== 1 ||
        spec.strategy?.type !== 'Recreate' ||
        template?.metadata?.labels?.['app.kubernetes.io/component'] !== 'worker' ||
        !targetProjection
      ) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      return Object.freeze({
        deployment,
        uid: boundedResourceId(metadata.uid),
        resourceVersion: boundedResourceId(metadata.resourceVersion),
      });
    } catch (error) {
      return preserveDomainError(error);
    }
  }

  private async currentDeployment(): Promise<StoredDeployment> {
    try {
      return this.parseDeployment(
        await this.deploymentApi.readNamespacedDeployment({
          name: this.options.targetDeploymentName,
          namespace: this.options.namespace,
        }),
      );
    } catch (error) {
      return preserveDomainError(error);
    }
  }

  private deploymentMatches(
    current: StoredDeployment,
    delivery: Readonly<WorkerCredentialDeliveryRecord>,
    publicationDigest: string,
  ): boolean {
    const annotations =
      current.deployment.spec?.template?.metadata?.annotations;
    return annotations?.[DELIVERY_ANNOTATION] === delivery.deliveryId &&
      annotations?.[CREDENTIAL_ID_ANNOTATION] === delivery.credentialId &&
      annotations?.[GENERATION_ANNOTATION] === delivery.deploymentGeneration &&
      annotations?.[TOKEN_DIGEST_ANNOTATION] === delivery.tokenDigest &&
      annotations?.[PUBLICATION_DIGEST_ANNOTATION] === publicationDigest;
  }

  private deploymentBody(
    current: StoredDeployment,
    delivery: Readonly<WorkerCredentialDeliveryRecord>,
    publicationDigest: string,
  ): DeploymentWrite {
    const deployment = current.deployment;
    const metadata = deployment.metadata!;
    const spec = deployment.spec!;
    const template = spec.template!;
    return {
      ...deployment,
      metadata: {
        ...metadata,
        resourceVersion: current.resourceVersion,
      },
      spec: {
        ...spec,
        template: {
          ...template,
          metadata: {
            ...(template.metadata ?? {}),
            annotations: {
              ...(template.metadata?.annotations ?? {}),
              [DELIVERY_ANNOTATION]: delivery.deliveryId,
              [CREDENTIAL_ID_ANNOTATION]: delivery.credentialId,
              [GENERATION_ANNOTATION]: delivery.deploymentGeneration,
              [TOKEN_DIGEST_ANNOTATION]: delivery.tokenDigest,
              [PUBLICATION_DIGEST_ANNOTATION]: publicationDigest,
            },
          },
        },
      },
    };
  }

  private assertDeploymentPredecessor(
    current: StoredDeployment,
    delivery: Readonly<WorkerCredentialDeliveryRecord>,
  ): void {
    const annotations =
      current.deployment.spec?.template?.metadata?.annotations ?? {};
    const currentCredentialId = annotations[CREDENTIAL_ID_ANNOTATION];
    if (currentCredentialId === delivery.credentialId) {
      if (
        annotations[DELIVERY_ANNOTATION] !== delivery.deliveryId ||
        annotations[GENERATION_ANNOTATION] !== delivery.deploymentGeneration ||
        annotations[TOKEN_DIGEST_ANNOTATION] !== delivery.tokenDigest
      ) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      return;
    }
    if (
      (delivery.previousCredentialId === null &&
        currentCredentialId !== undefined) ||
      (delivery.previousCredentialId !== null &&
        currentCredentialId !== delivery.previousCredentialId)
    ) {
      throw new WorkerCredentialDeliveryConflictError();
    }
  }

  private async ensureDeploymentRollout(
    delivery: Readonly<WorkerCredentialDeliveryRecord>,
    publicationDigest: string,
  ): Promise<void> {
    const current = await this.currentDeployment();
    if (this.deploymentMatches(current, delivery, publicationDigest)) return;
    this.assertDeploymentPredecessor(current, delivery);
    try {
      const written = this.parseDeployment(
        await this.deploymentApi.replaceNamespacedDeployment({
          name: this.options.targetDeploymentName,
          namespace: this.options.namespace,
          body: this.deploymentBody(current, delivery, publicationDigest),
          fieldManager: FIELD_MANAGER,
          fieldValidation: 'Strict',
        }),
      );
      if (!this.deploymentMatches(written, delivery, publicationDigest)) {
        throw new WorkerCredentialDeliveryConflictError();
      }
    } catch (error) {
      if (apiStatus(error) !== 409) return preserveDomainError(error);
      const winner = await this.currentDeployment();
      if (!this.deploymentMatches(winner, delivery, publicationDigest)) {
        throw new WorkerCredentialDeliveryConflictError();
      }
    }
  }

  private targetBody(
    delivery: Readonly<WorkerCredentialDeliveryRecord>,
    token: Buffer,
    current: StoredTargetState,
  ): SecretWrite {
    const metadata = current.secret.metadata;
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      type: TARGET_TYPE,
      metadata: {
        name: this.options.targetSecretName,
        namespace: this.options.namespace,
        resourceVersion: current.resourceVersion,
        ...(metadata?.finalizers ? { finalizers: [...metadata.finalizers] } : {}),
        ...(metadata?.ownerReferences
          ? { ownerReferences: [...metadata.ownerReferences] }
          : {}),
        labels: {
          ...(metadata?.labels ?? {}),
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [TARGET_LABEL]: TARGET_ACTIVE_VALUE,
          [TARGET_DIGEST_LABEL]: this.targetDigestLabel,
        },
        annotations: {
          ...(metadata?.annotations ?? {}),
          [DELIVERY_ANNOTATION]: delivery.deliveryId,
          [GENERATION_ANNOTATION]: delivery.deploymentGeneration,
          [TOKEN_DIGEST_ANNOTATION]: delivery.tokenDigest,
        },
      },
      data: { [this.targetDataKey]: token.toString('base64') },
    };
  }

  async inspect(
    deliveryId: string,
  ): Promise<Readonly<WorkerCredentialDeliveryIntent> | null> {
    const stage = await this.optionalStage(deliveryId);
    try {
      return stage?.intent ?? null;
    } finally {
      stage?.token.fill(0);
    }
  }

  async listStaged(
    options: Readonly<{ afterDeliveryId?: string; limit?: number }> = {},
  ): Promise<Readonly<WorkerCredentialStagedSecretPage>> {
    try {
      if (
        !options ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        Object.keys(options).some(
          (key) => key !== 'afterDeliveryId' && key !== 'limit',
        )
      ) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      const limit = options.limit ?? 16;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_WORKER_CREDENTIAL_KUBERNETES_STAGE_PAGE_SIZE ||
        (options.afterDeliveryId !== undefined &&
          !UUID_V4.test(options.afterDeliveryId))
      ) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      const items = await this.boundedStageSecrets();
      const stages: Readonly<WorkerCredentialDeliveryIntent>[] = [];
      for (const item of items) {
        const stage = this.parseStage(item);
        try {
          stages.push(stage.intent);
        } finally {
          stage.token.fill(0);
        }
      }
      stages.sort((left, right) => left.deliveryId.localeCompare(right.deliveryId));
      const filtered = stages.filter((stage) =>
        options.afterDeliveryId === undefined ||
        stage.deliveryId > options.afterDeliveryId);
      const selected = filtered.slice(0, limit);
      const truncated = filtered.length > limit;
      return Object.freeze({
        stages: Object.freeze(selected),
        truncated,
        ...(truncated
          ? { nextCursor: selected[selected.length - 1]!.deliveryId }
          : {}),
      });
    } catch (error) {
      return preserveDomainError(error);
    }
  }

  async stage(
    value: Readonly<WorkerCredentialDeliveryIntent>,
    token: Buffer,
  ): Promise<void> {
    const intent = this.normalizeIntent(value);
    const parsed = Buffer.isBuffer(token) ? parseToken(token) : null;
    if (
      !parsed ||
      parsed.credentialId !== intent.credentialId ||
      parsed.tokenDigest !== intent.tokenDigest
    ) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    const existing = await this.optionalStage(intent.deliveryId);
    if (existing) {
      try {
        if (!sameIntent(existing.intent, intent) || !existing.token.equals(token)) {
          throw new WorkerCredentialDeliveryConflictError();
        }
        return;
      } finally {
        existing.token.fill(0);
      }
    }
    if ((await this.boundedStageSecrets()).length >=
      MAX_WORKER_CREDENTIAL_KUBERNETES_STAGES) {
      throw new WorkerCredentialDeliveryUnavailableError();
    }
    const name = stageName(intent.deliveryId);
    const body: SecretWrite = {
      apiVersion: 'v1',
      kind: 'Secret',
      immutable: true,
      type: STAGE_TYPE,
      metadata: {
        name,
        namespace: this.options.stageNamespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [STAGE_LABEL]: 'v1',
        },
        annotations: {
          [DELIVERY_ANNOTATION]: intent.deliveryId,
          [INTENT_ANNOTATION]: JSON.stringify(intent),
        },
      },
      data: { [STAGE_TOKEN_KEY]: token.toString('base64') },
    };
    if (
      Buffer.byteLength(body.metadata!.annotations![INTENT_ANNOTATION]!, 'utf8') >
      MAX_INTENT_BYTES
    ) {
      throw new WorkerCredentialDeliveryUnavailableError();
    }
    try {
      const created = this.parseStage(await this.api.createNamespacedSecret({
        namespace: this.options.stageNamespace,
        body,
        fieldManager: FIELD_MANAGER,
        fieldValidation: 'Strict',
      }), intent.deliveryId);
      try {
        if (!sameIntent(created.intent, intent) || !created.token.equals(token)) {
          throw new WorkerCredentialDeliveryConflictError();
        }
      } finally {
        created.token.fill(0);
      }
    } catch (error) {
      if (apiStatus(error) !== 409) return preserveDomainError(error);
      const existing = await this.optionalStage(intent.deliveryId);
      if (!existing) throw new WorkerCredentialDeliveryUnavailableError();
      try {
        if (!sameIntent(existing.intent, intent) || !existing.token.equals(token)) {
          throw new WorkerCredentialDeliveryConflictError();
        }
      } finally {
        existing.token.fill(0);
      }
    }
  }

  async publish(
    value: Readonly<WorkerCredentialDeliveryRecord>,
  ): Promise<Readonly<{ publicationDigest: string }>> {
    const delivery = normalizeWorkerCredentialDeliveryRecord(value);
    if (
      delivery.state !== 'credential_committed' ||
      delivery.version !== 1 ||
      delivery.deploymentTargetDigest !== this.deploymentTargetDigest
    ) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    const stage = await this.optionalStage(delivery.deliveryId);
    if (!stage || !recordMatchesIntent(delivery, stage.intent)) {
      stage?.token.fill(0);
      throw new WorkerCredentialDeliveryConflictError();
    }
    try {
      this.assertDeploymentPredecessor(
        await this.currentDeployment(),
        delivery,
      );
      const current = await this.currentTarget();
      if (current.kind === 'active' && this.publishedMatches(current, delivery)) {
        const publicationDigest = this.publicationDigest(delivery, current);
        await this.ensureDeploymentRollout(delivery, publicationDigest);
        return Object.freeze({ publicationDigest });
      }
      if (
        (current.kind === 'active' &&
          current.credentialId === delivery.credentialId) ||
        (delivery.previousCredentialId === null && current.kind !== 'prepared') ||
        (delivery.previousCredentialId !== null &&
          (current.kind !== 'active' ||
            current.credentialId !== delivery.previousCredentialId))
      ) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      let written: StoredTarget;
      try {
        const body = this.targetBody(delivery, stage.token, current);
        const response = await this.api.replaceNamespacedSecret({
          name: this.options.targetSecretName,
          namespace: this.options.namespace,
          body,
          fieldManager: FIELD_MANAGER,
          fieldValidation: 'Strict',
        });
        written = this.parseTarget(response);
      } catch (error) {
        if (apiStatus(error) !== 409) return preserveDomainError(error);
        const winner = await this.currentTarget();
        if (winner.kind !== 'active' || !this.publishedMatches(winner, delivery)) {
          throw new WorkerCredentialDeliveryConflictError();
        }
        written = winner;
      }
      if (!this.publishedMatches(written, delivery)) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      const publicationDigest = this.publicationDigest(delivery, written);
      await this.ensureDeploymentRollout(delivery, publicationDigest);
      return Object.freeze({ publicationDigest });
    } finally {
      stage.token.fill(0);
    }
  }

  async discard(value: Readonly<WorkerCredentialDeliveryIntent>): Promise<void> {
    const intent = this.normalizeIntent(value);
    const stage = await this.optionalStage(intent.deliveryId);
    if (!stage) return;
    try {
      if (!sameIntent(stage.intent, intent)) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      const target = await this.currentTarget();
      if (
        target.kind === 'active' &&
        target.credentialId === intent.credentialId &&
        target.tokenDigest === intent.tokenDigest
      ) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      const body = {
        apiVersion: 'v1',
        kind: 'DeleteOptions',
        gracePeriodSeconds: 0,
        preconditions: {
          uid: stage.uid,
          resourceVersion: stage.resourceVersion,
        },
      } as const;
      try {
        await this.api.deleteNamespacedSecret({
          name: stageName(intent.deliveryId),
          namespace: this.options.stageNamespace,
          gracePeriodSeconds: 0,
          propagationPolicy: 'Background',
          body,
        });
      } catch (error) {
        if (apiStatus(error) === 409) {
          throw new WorkerCredentialDeliveryConflictError();
        }
        if (apiStatus(error) !== 404) return preserveDomainError(error);
      }
      const remaining = await this.optionalStage(intent.deliveryId);
      try {
        if (remaining) throw new WorkerCredentialDeliveryUnavailableError();
      } finally {
        remaining?.token.fill(0);
      }
    } finally {
      stage.token.fill(0);
    }
  }
}
