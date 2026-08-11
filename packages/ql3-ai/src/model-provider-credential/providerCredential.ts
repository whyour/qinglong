import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { parseSecretRef } from '@qinglong/runtime-core/secret-reference';

// Core contract for the model-provider-credential bounded capability.
export const MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA =
  'qinglong/model-provider-credential-binding@v1';
export const MODEL_PROVIDER_CREDENTIAL_AUDIT_SCHEMA =
  'qinglong/model-provider-credential-audit@v1';
export const MODEL_PROVIDER_CREDENTIAL_OPERATIONS = [
  'list_models',
  'generate',
  'stream',
] as const;
export const MAX_MODEL_PROVIDER_AUTHORIZATION_BYTES = 4 * 1024;

const BEARER_PREFIX = 'Bearer ';
const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/;

export type ModelProviderCredentialOperation =
  (typeof MODEL_PROVIDER_CREDENTIAL_OPERATIONS)[number];

export interface ModelProviderCredentialBinding {
  readonly schema: typeof MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA;
  readonly projectId: string;
  readonly provider: string;
  readonly revision: string;
  readonly secretRef: string;
  readonly scheme: 'bearer';
}

export interface ModelProviderCredentialBindingLookup {
  readonly projectId: string;
  readonly provider: string;
}

export interface ModelProviderCredentialBindingSource {
  resolveModelProviderCredentialBinding(
    lookup: Readonly<ModelProviderCredentialBindingLookup>,
  ): Promise<Readonly<ModelProviderCredentialBinding> | null>;
}

export interface ModelProviderSecretMaterialRequest {
  readonly projectId: string;
  readonly secretRef: string;
  readonly signal?: AbortSignal;
}

export interface ModelProviderSecretMaterial {
  readonly secretRef: string;
  /**
   * Consumer-owned plaintext bytes. The consumer must call dispose exactly
   * once and must not retain a string or another copy beyond the operation.
   */
  readonly bytes: Uint8Array;
  dispose(): void | Promise<void>;
}

export interface ModelProviderSecretMaterialProvider {
  resolveProjectSecretMaterial(
    request: Readonly<ModelProviderSecretMaterialRequest>,
  ): Promise<Readonly<ModelProviderSecretMaterial> | null>;
}

export interface ModelProviderAuthorizationRequest {
  readonly operation: ModelProviderCredentialOperation;
  readonly provider: string;
  readonly projectId?: string;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

export interface ModelProviderAuthorizationLease {
  readonly value: string;
  dispose(): void | Promise<void>;
}

export interface ModelProviderAuthorizationProvider {
  authorizationHeader(
    request: Readonly<ModelProviderAuthorizationRequest>,
  ): Promise<Readonly<ModelProviderAuthorizationLease> | null>;
}

export interface ModelProviderCredentialAuditRecord {
  readonly schema: typeof MODEL_PROVIDER_CREDENTIAL_AUDIT_SCHEMA;
  readonly operation: ModelProviderCredentialOperation;
  readonly projectId: string;
  readonly provider: string;
  readonly requestId: string;
  readonly bindingRevision: string;
  readonly bindingDigest: string;
  readonly occurredAtMs: number;
}

export interface ModelProviderCredentialAuditSink {
  record(record: Readonly<ModelProviderCredentialAuditRecord>): Promise<void>;
}

export interface BoundModelProviderCredentialOptions {
  readonly bindings: ModelProviderCredentialBindingSource;
  readonly secrets: ModelProviderSecretMaterialProvider;
  readonly audit: ModelProviderCredentialAuditSink;
  readonly now?: () => number;
}

export class InvalidModelProviderCredentialBindingError extends TypeError {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_BINDING_INVALID';

  constructor(message: string) {
    super(`Model provider credential binding is invalid: ${message}`);
    this.name = 'InvalidModelProviderCredentialBindingError';
  }
}

export class ModelProviderCredentialUnavailableError extends Error {
  readonly code = 'MODEL_PROVIDER_CREDENTIAL_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('The model provider credential is unavailable', options);
    this.name = 'ModelProviderCredentialUnavailableError';
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidModelProviderCredentialBindingError(
      `${label} is not an object`,
    );
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string, maximumBytes = 128): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new InvalidModelProviderCredentialBindingError(`${label} is invalid`);
  }
  return value;
}

function providerIdentifier(value: unknown): string {
  const provider = identifier(value, 'provider');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(provider)) {
    throw new InvalidModelProviderCredentialBindingError('provider is invalid');
  }
  return provider;
}

function operation(value: unknown): ModelProviderCredentialOperation {
  if (
    typeof value !== 'string' ||
    !MODEL_PROVIDER_CREDENTIAL_OPERATIONS.includes(
      value as ModelProviderCredentialOperation,
    )
  ) {
    throw new InvalidModelProviderCredentialBindingError(
      'operation is invalid',
    );
  }
  return value as ModelProviderCredentialOperation;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ModelProviderCredentialUnavailableError();
  }
  return value as number;
}

export function normalizeModelProviderCredentialBinding(
  value: ModelProviderCredentialBinding,
): Readonly<ModelProviderCredentialBinding> {
  const binding = record(value, 'binding');
  if (
    !exactKeys(binding, [
      'projectId',
      'provider',
      'revision',
      'schema',
      'scheme',
      'secretRef',
    ]) ||
    binding.schema !== MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA ||
    binding.scheme !== 'bearer'
  ) {
    throw new InvalidModelProviderCredentialBindingError('shape is invalid');
  }
  const projectId = identifier(binding.projectId, 'projectId');
  const provider = providerIdentifier(binding.provider);
  const revision = identifier(binding.revision, 'revision');
  let secretRef: string;
  try {
    secretRef = identifier(binding.secretRef, 'secretRef', 512);
    if (parseSecretRef(secretRef).projectId !== projectId) {
      throw new InvalidModelProviderCredentialBindingError(
        'Secret belongs to another Project',
      );
    }
  } catch (error) {
    if (error instanceof InvalidModelProviderCredentialBindingError) {
      throw error;
    }
    throw new InvalidModelProviderCredentialBindingError(
      'secretRef is invalid',
    );
  }
  return Object.freeze({
    schema: MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
    projectId,
    provider,
    revision,
    secretRef,
    scheme: 'bearer',
  });
}

export function digestModelProviderCredentialBinding(
  value: ModelProviderCredentialBinding,
): string {
  const binding = normalizeModelProviderCredentialBinding(value);
  const hash = createHash('sha256');
  hash.update('qinglong/model-provider-credential-binding@v1\0', 'utf8');
  hash.update(binding.projectId, 'utf8');
  hash.update('\0', 'utf8');
  hash.update(binding.provider, 'utf8');
  hash.update('\0', 'utf8');
  hash.update(binding.revision, 'utf8');
  hash.update('\0', 'utf8');
  hash.update(binding.secretRef, 'utf8');
  hash.update('\0bearer', 'utf8');
  return `sha256:${hash.digest('hex')}`;
}

function normalizeAuthorizationRequest(
  value: Readonly<ModelProviderAuthorizationRequest>,
): Readonly<
  Required<Omit<ModelProviderAuthorizationRequest, 'signal'>> & {
    readonly signal?: AbortSignal;
  }
> {
  const request = record(value, 'authorization request');
  const expected = ['operation', 'projectId', 'provider', 'requestId'];
  if (request.signal !== undefined) expected.push('signal');
  if (
    !exactKeys(request, expected) ||
    request.projectId === undefined ||
    request.requestId === undefined ||
    (request.signal !== undefined &&
      typeof (request.signal as AbortSignal).aborted !== 'boolean')
  ) {
    throw new InvalidModelProviderCredentialBindingError(
      'authorization request is invalid',
    );
  }
  return Object.freeze({
    operation: operation(request.operation),
    provider: providerIdentifier(request.provider),
    projectId: identifier(request.projectId, 'projectId'),
    requestId: identifier(request.requestId, 'requestId'),
    ...(request.signal === undefined
      ? {}
      : { signal: request.signal as AbortSignal }),
  });
}

function normalizeMaterial(
  value: Readonly<ModelProviderSecretMaterial>,
  expectedSecretRef: string,
): Readonly<ModelProviderSecretMaterial> {
  const material = record(value, 'Secret material');
  if (
    !exactKeys(material, ['bytes', 'dispose', 'secretRef']) ||
    material.secretRef !== expectedSecretRef ||
    !(material.bytes instanceof Uint8Array) ||
    typeof material.dispose !== 'function'
  ) {
    throw new ModelProviderCredentialUnavailableError();
  }
  return value;
}

async function disposeMaterial(
  material: Readonly<ModelProviderSecretMaterial> | undefined,
): Promise<void> {
  if (!material || typeof material.dispose !== 'function') return;
  await material.dispose();
}

function bearerToken(bytes: Uint8Array): Buffer {
  const token = Buffer.from(bytes);
  if (
    token.length === 0 ||
    token.length >
      MAX_MODEL_PROVIDER_AUTHORIZATION_BYTES - BEARER_PREFIX.length ||
    token.some((byte) => byte > 0x7f)
  ) {
    token.fill(0);
    throw new ModelProviderCredentialUnavailableError();
  }
  const value = token.toString('ascii');
  if (
    !BEARER_TOKEN_PATTERN.test(value) ||
    Buffer.byteLength(value, 'ascii') !== token.length
  ) {
    token.fill(0);
    throw new ModelProviderCredentialUnavailableError();
  }
  return token;
}

/**
 * Per-invocation credential bridge. Bindings are metadata-only and are
 * re-resolved for every request, so an unversioned SecretRef rotates without a
 * watcher or cache. Plaintext is owned only by a short-lived authorization
 * lease and is wiped before the provider starts reading its response body.
 */
export class BoundModelProviderCredentialProvider
  implements ModelProviderAuthorizationProvider
{
  readonly #bindings: ModelProviderCredentialBindingSource;
  readonly #secrets: ModelProviderSecretMaterialProvider;
  readonly #audit: ModelProviderCredentialAuditSink;
  readonly #now: () => number;

  constructor(options: BoundModelProviderCredentialOptions) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      typeof options.bindings?.resolveModelProviderCredentialBinding !==
        'function' ||
      typeof options.secrets?.resolveProjectSecretMaterial !== 'function' ||
      typeof options.audit?.record !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function')
    ) {
      throw new InvalidModelProviderCredentialBindingError(
        'provider options are invalid',
      );
    }
    this.#bindings = options.bindings;
    this.#secrets = options.secrets;
    this.#audit = options.audit;
    this.#now = options.now ?? Date.now;
  }

  async authorizationHeader(
    request: Readonly<ModelProviderAuthorizationRequest>,
  ): Promise<Readonly<ModelProviderAuthorizationLease>> {
    let material: Readonly<ModelProviderSecretMaterial> | undefined;
    let token: Buffer | undefined;
    try {
      const normalizedRequest = normalizeAuthorizationRequest(request);
      if (normalizedRequest.signal?.aborted) {
        throw new ModelProviderCredentialUnavailableError();
      }
      const rawBinding =
        await this.#bindings.resolveModelProviderCredentialBinding(
          Object.freeze({
            projectId: normalizedRequest.projectId,
            provider: normalizedRequest.provider,
          }),
        );
      if (!rawBinding) throw new ModelProviderCredentialUnavailableError();
      const binding = normalizeModelProviderCredentialBinding(rawBinding);
      if (
        binding.projectId !== normalizedRequest.projectId ||
        binding.provider !== normalizedRequest.provider
      ) {
        throw new ModelProviderCredentialUnavailableError();
      }
      const bindingDigest = digestModelProviderCredentialBinding(binding);
      material =
        (await this.#secrets.resolveProjectSecretMaterial(
          Object.freeze({
            projectId: normalizedRequest.projectId,
            secretRef: binding.secretRef,
            ...(normalizedRequest.signal === undefined
              ? {}
              : { signal: normalizedRequest.signal }),
          }),
        )) ?? undefined;
      if (!material) throw new ModelProviderCredentialUnavailableError();
      const normalizedMaterial = normalizeMaterial(material, binding.secretRef);
      token = bearerToken(normalizedMaterial.bytes);
      await disposeMaterial(material);
      material = undefined;
      if (normalizedRequest.signal?.aborted) {
        throw new ModelProviderCredentialUnavailableError();
      }
      await this.#audit.record(
        Object.freeze({
          schema: MODEL_PROVIDER_CREDENTIAL_AUDIT_SCHEMA,
          operation: normalizedRequest.operation,
          projectId: normalizedRequest.projectId,
          provider: normalizedRequest.provider,
          requestId: normalizedRequest.requestId,
          bindingRevision: binding.revision,
          bindingDigest,
          occurredAtMs: timestamp(this.#now()),
        }),
      );
      const ownedToken = token;
      token = undefined;
      let disposed = false;
      return Object.freeze({
        get value(): string {
          if (disposed) throw new ModelProviderCredentialUnavailableError();
          return `${BEARER_PREFIX}${ownedToken.toString('ascii')}`;
        },
        dispose(): void {
          if (disposed) return;
          disposed = true;
          ownedToken.fill(0);
        },
      });
    } catch (cause) {
      token?.fill(0);
      try {
        await disposeMaterial(material);
      } catch {
        // The stable fail-closed error below intentionally hides provider data.
      }
      if (cause instanceof InvalidModelProviderCredentialBindingError) {
        throw cause;
      }
      throw new ModelProviderCredentialUnavailableError({
        cause: cause instanceof Error ? cause : undefined,
      });
    }
  }
}
