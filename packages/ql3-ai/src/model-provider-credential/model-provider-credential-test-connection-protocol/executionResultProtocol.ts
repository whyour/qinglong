import {
  MAX_MODEL_PROVIDER_CREDENTIAL_TEST_DEADLINE_MS,
  MAX_MODEL_PROVIDER_CREDENTIAL_TEST_MODELS,
  MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTION_SCHEMA,
  MODEL_PROVIDER_CREDENTIAL_TEST_RESULT_SCHEMA,
  digest,
  exact,
  integer,
  invalid,
  sha256,
  uuid,
  type ModelProviderCredentialTestExecution,
  type ModelProviderCredentialTestOutcome,
  type ModelProviderCredentialTestResult,
} from './contractProtocol';

const EXECUTION_DIGEST_DOMAIN =
  'qinglong/model-provider-credential-test-execution-digest@v1\0';
const RESULT_DIGEST_DOMAIN =
  'qinglong/model-provider-credential-test-result-digest@v1\0';

function executionSemantic(
  value: Omit<ModelProviderCredentialTestExecution, 'executionDigest'>,
) {
  return Object.freeze({
    schema: MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTION_SCHEMA,
    executionId: value.executionId,
    testId: value.testId,
    planDigest: value.planDigest,
    startedAtMs: value.startedAtMs,
  });
}

export function createModelProviderCredentialTestExecution(
  value: Readonly<{
    executionId: string;
    testId: string;
    planDigest: string;
    startedAtMs: number;
  }>,
): Readonly<ModelProviderCredentialTestExecution> {
  exact(value, ['executionId', 'planDigest', 'startedAtMs', 'testId']);
  const semantic = executionSemantic({
    schema: MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTION_SCHEMA,
    executionId: uuid(value.executionId),
    testId: uuid(value.testId),
    planDigest: digest(value.planDigest),
    startedAtMs: integer(value.startedAtMs, 0, Number.MAX_SAFE_INTEGER),
  });
  return Object.freeze({
    ...semantic,
    executionDigest: sha256(EXECUTION_DIGEST_DOMAIN, semantic),
  });
}

export function normalizeModelProviderCredentialTestExecution(
  value: ModelProviderCredentialTestExecution,
): Readonly<ModelProviderCredentialTestExecution> {
  exact(value, [
    'executionDigest',
    'executionId',
    'planDigest',
    'schema',
    'startedAtMs',
    'testId',
  ]);
  if (value.schema !== MODEL_PROVIDER_CREDENTIAL_TEST_EXECUTION_SCHEMA) {
    invalid();
  }
  const normalized = createModelProviderCredentialTestExecution({
    executionId: value.executionId,
    testId: value.testId,
    planDigest: value.planDigest,
    startedAtMs: value.startedAtMs,
  });
  if (digest(value.executionDigest) !== normalized.executionDigest) invalid();
  return normalized;
}

function resultSemantic(
  value: Omit<ModelProviderCredentialTestResult, 'resultDigest'>,
) {
  return Object.freeze({
    schema: MODEL_PROVIDER_CREDENTIAL_TEST_RESULT_SCHEMA,
    executionId: value.executionId,
    testId: value.testId,
    planDigest: value.planDigest,
    outcome: value.outcome,
    modelCount: value.modelCount,
    durationMs: value.durationMs,
    completedAtMs: value.completedAtMs,
  });
}

export function createModelProviderCredentialTestResult(
  value: Readonly<{
    executionId: string;
    testId: string;
    planDigest: string;
    outcome: ModelProviderCredentialTestOutcome;
    modelCount: number | null;
    durationMs: number;
    completedAtMs: number;
  }>,
): Readonly<ModelProviderCredentialTestResult> {
  exact(value, [
    'completedAtMs',
    'durationMs',
    'executionId',
    'modelCount',
    'outcome',
    'planDigest',
    'testId',
  ]);
  const outcome =
    value.outcome === 'reachable' || value.outcome === 'unreachable'
      ? value.outcome
      : invalid();
  const modelCount =
    value.modelCount === null
      ? null
      : integer(value.modelCount, 0, MAX_MODEL_PROVIDER_CREDENTIAL_TEST_MODELS);
  if (
    (outcome === 'reachable' && modelCount === null) ||
    (outcome === 'unreachable' && modelCount !== null)
  ) {
    invalid();
  }
  const semantic = resultSemantic({
    schema: MODEL_PROVIDER_CREDENTIAL_TEST_RESULT_SCHEMA,
    executionId: uuid(value.executionId),
    testId: uuid(value.testId),
    planDigest: digest(value.planDigest),
    outcome,
    modelCount,
    durationMs: integer(
      value.durationMs,
      0,
      MAX_MODEL_PROVIDER_CREDENTIAL_TEST_DEADLINE_MS,
    ),
    completedAtMs: integer(value.completedAtMs, 0, Number.MAX_SAFE_INTEGER),
  });
  return Object.freeze({
    ...semantic,
    resultDigest: sha256(RESULT_DIGEST_DOMAIN, semantic),
  });
}

export function normalizeModelProviderCredentialTestResult(
  value: ModelProviderCredentialTestResult,
): Readonly<ModelProviderCredentialTestResult> {
  exact(value, [
    'completedAtMs',
    'durationMs',
    'executionId',
    'modelCount',
    'outcome',
    'planDigest',
    'resultDigest',
    'schema',
    'testId',
  ]);
  if (value.schema !== MODEL_PROVIDER_CREDENTIAL_TEST_RESULT_SCHEMA) invalid();
  const normalized = createModelProviderCredentialTestResult({
    executionId: value.executionId,
    testId: value.testId,
    planDigest: value.planDigest,
    outcome: value.outcome,
    modelCount: value.modelCount,
    durationMs: value.durationMs,
    completedAtMs: value.completedAtMs,
  });
  if (digest(value.resultDigest) !== normalized.resultDigest) invalid();
  return normalized;
}
