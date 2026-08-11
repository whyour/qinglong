import {
  MAX_MODEL_PROVIDER_CREDENTIAL_TEST_ALLOWLIST_ENTRIES,
  MAX_MODEL_PROVIDER_CREDENTIAL_TEST_DEADLINE_MS,
  MAX_MODEL_PROVIDER_CREDENTIAL_TEST_MODELS,
  MAX_MODEL_PROVIDER_CREDENTIAL_TEST_RESPONSE_BYTES,
  MODEL_PROVIDER_CREDENTIAL_TEST_ALLOWLIST_SCHEMA,
  MODEL_PROVIDER_CREDENTIAL_TEST_CONTROL_PATTERN,
  digest,
  exact,
  identifier,
  integer,
  invalid,
  sha256,
  type ModelProviderCredentialTestAllowlist,
  type ModelProviderCredentialTestEndpoint,
  type ModelProviderCredentialTestEndpointInput,
} from './contractProtocol';

const ENDPOINT_DIGEST_DOMAIN =
  'qinglong/model-provider-credential-test-endpoint-digest@v1\0';
const ALLOWLIST_DIGEST_DOMAIN =
  'qinglong/model-provider-credential-test-allowlist-digest@v1\0';

function canonicalBaseUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 1_024 ||
    MODEL_PROVIDER_CREDENTIAL_TEST_CONTROL_PATTERN.test(value)
  ) {
    invalid();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.hostname.length < 1 ||
    url.pathname.length < 1 ||
    !url.pathname.endsWith('/') ||
    url.toString() !== value
  ) {
    invalid();
  }
  return value;
}

function endpointSemantic(
  endpoint: Readonly<ModelProviderCredentialTestEndpointInput>,
): Readonly<ModelProviderCredentialTestEndpointInput> {
  return Object.freeze({
    provider: endpoint.provider,
    adapter: endpoint.adapter,
    baseUrl: endpoint.baseUrl,
    revision: endpoint.revision,
    deadlineMs: endpoint.deadlineMs,
    maxResponseBytes: endpoint.maxResponseBytes,
    maxModels: endpoint.maxModels,
    maxCostMicrousd: 0,
    retryLimit: 0,
  });
}

export function createModelProviderCredentialTestEndpoint(
  value: ModelProviderCredentialTestEndpointInput,
): Readonly<ModelProviderCredentialTestEndpoint> {
  exact(value, [
    'adapter',
    'baseUrl',
    'deadlineMs',
    'maxCostMicrousd',
    'maxModels',
    'maxResponseBytes',
    'provider',
    'retryLimit',
    'revision',
  ]);
  const semantic = endpointSemantic({
    provider: identifier(value.provider),
    adapter: value.adapter === 'openai-compatible' ? value.adapter : invalid(),
    baseUrl: canonicalBaseUrl(value.baseUrl),
    revision: identifier(value.revision),
    deadlineMs: integer(
      value.deadlineMs,
      1_000,
      MAX_MODEL_PROVIDER_CREDENTIAL_TEST_DEADLINE_MS,
    ),
    maxResponseBytes: integer(
      value.maxResponseBytes,
      1_024,
      MAX_MODEL_PROVIDER_CREDENTIAL_TEST_RESPONSE_BYTES,
    ),
    maxModels: integer(
      value.maxModels,
      1,
      MAX_MODEL_PROVIDER_CREDENTIAL_TEST_MODELS,
    ),
    maxCostMicrousd:
      value.maxCostMicrousd === 0 ? value.maxCostMicrousd : invalid(),
    retryLimit: value.retryLimit === 0 ? value.retryLimit : invalid(),
  });
  return Object.freeze({
    ...semantic,
    configDigest: sha256(ENDPOINT_DIGEST_DOMAIN, semantic),
  });
}

export function normalizeModelProviderCredentialTestEndpoint(
  value: ModelProviderCredentialTestEndpoint,
): Readonly<ModelProviderCredentialTestEndpoint> {
  exact(value, [
    'adapter',
    'baseUrl',
    'configDigest',
    'deadlineMs',
    'maxCostMicrousd',
    'maxModels',
    'maxResponseBytes',
    'provider',
    'retryLimit',
    'revision',
  ]);
  const normalized = createModelProviderCredentialTestEndpoint({
    provider: value.provider,
    adapter: value.adapter,
    baseUrl: value.baseUrl,
    revision: value.revision,
    deadlineMs: value.deadlineMs,
    maxResponseBytes: value.maxResponseBytes,
    maxModels: value.maxModels,
    maxCostMicrousd: value.maxCostMicrousd,
    retryLimit: value.retryLimit,
  });
  if (digest(value.configDigest) !== normalized.configDigest) invalid();
  return normalized;
}

function allowlistSemantic(
  revision: string,
  providers: readonly Readonly<ModelProviderCredentialTestEndpoint>[],
) {
  return Object.freeze({
    schema: MODEL_PROVIDER_CREDENTIAL_TEST_ALLOWLIST_SCHEMA,
    revision,
    providers,
  });
}

export function createModelProviderCredentialTestAllowlist(
  value: Readonly<{
    revision: string;
    providers: readonly ModelProviderCredentialTestEndpointInput[];
  }>,
): Readonly<ModelProviderCredentialTestAllowlist> {
  exact(value, ['providers', 'revision']);
  if (
    !Array.isArray(value.providers) ||
    value.providers.length < 1 ||
    value.providers.length >
      MAX_MODEL_PROVIDER_CREDENTIAL_TEST_ALLOWLIST_ENTRIES
  ) {
    invalid();
  }
  const providers = Object.freeze(
    value.providers
      .map(createModelProviderCredentialTestEndpoint)
      .sort((left, right) => left.provider.localeCompare(right.provider)),
  );
  if (
    providers.some(
      (provider, index) =>
        index > 0 && providers[index - 1]?.provider === provider.provider,
    )
  ) {
    invalid();
  }
  const semantic = allowlistSemantic(identifier(value.revision), providers);
  return Object.freeze({
    ...semantic,
    catalogDigest: sha256(ALLOWLIST_DIGEST_DOMAIN, semantic),
  });
}

export function normalizeModelProviderCredentialTestAllowlist(
  value: ModelProviderCredentialTestAllowlist,
): Readonly<ModelProviderCredentialTestAllowlist> {
  exact(value, ['catalogDigest', 'providers', 'revision', 'schema']);
  if (
    value.schema !== MODEL_PROVIDER_CREDENTIAL_TEST_ALLOWLIST_SCHEMA ||
    !Array.isArray(value.providers) ||
    value.providers.length < 1 ||
    value.providers.length >
      MAX_MODEL_PROVIDER_CREDENTIAL_TEST_ALLOWLIST_ENTRIES
  ) {
    invalid();
  }
  const providers = Object.freeze(
    value.providers.map(normalizeModelProviderCredentialTestEndpoint),
  );
  if (
    providers.some(
      (provider, index) =>
        (index > 0 &&
          providers[index - 1]!.provider.localeCompare(provider.provider) >=
            0) ||
        provider.configDigest !== value.providers[index]?.configDigest,
    )
  ) {
    invalid();
  }
  const semantic = allowlistSemantic(identifier(value.revision), providers);
  if (
    digest(value.catalogDigest) !== sha256(ALLOWLIST_DIGEST_DOMAIN, semantic)
  ) {
    invalid();
  }
  return Object.freeze({ ...semantic, catalogDigest: value.catalogDigest });
}

export function resolveModelProviderCredentialTestEndpoint(
  allowlistValue: ModelProviderCredentialTestAllowlist,
  providerValue: string,
): Readonly<ModelProviderCredentialTestEndpoint> {
  const allowlist =
    normalizeModelProviderCredentialTestAllowlist(allowlistValue);
  const provider = identifier(providerValue);
  const endpoint = allowlist.providers.find(
    (candidate) => candidate.provider === provider,
  );
  if (!endpoint) invalid();
  return endpoint;
}
