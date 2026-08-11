import { Buffer } from 'node:buffer';

import { normalizeProjectPolicySubject } from '@qinglong/runtime-core/project-policy';
import { normalizePluginPackageAutomationPublication } from '@qinglong/runtime-core/plugin-package-automation-publication';
import {
  normalizePluginPackagePromptResource,
  type PluginPackagePromptResource,
} from '@qinglong/runtime-core/plugin-package-resource-materialization';

import {
  MAX_MODEL_INPUT_BYTES,
  MAX_MODEL_INVOCATION_MS,
  MAX_MODEL_MESSAGE_BYTES,
  MAX_MODEL_OUTPUT_TOKENS,
} from '../../model-gateway/model';
import {
  normalizePluginPackagePromptOutputArtifactRetentionPolicy,
  pluginPackagePromptOutputArtifactRetentionPolicyDigest,
} from '../../prompt-output/pluginPackagePromptOutputArtifact';
import {
  MAX_PLUGIN_PACKAGE_PROMPT_EXECUTION_PLAN_BYTES,
  MAX_PLUGIN_PACKAGE_PROMPT_PARAMETER_VALUE_BYTES,
  PLUGIN_PACKAGE_PROMPT_EXECUTION_PLAN_SCHEMA,
  type PluginPackagePromptExecutionPlan,
  type PluginPackagePromptExecutionPlanTarget,
  type PluginPackagePromptOutputIntent,
  type PreparePluginPackagePromptExecutionInput,
  type PreparePluginPackagePromptOutputIntent,
  type PreparedPluginPackagePromptExecution,
} from './contracts';
import {
  dataRecord,
  digest,
  exactKeys,
  hash,
  identity,
  invalid,
  nullableTemperature,
  packageName,
  positiveInteger,
  sha256,
  timestamp,
} from './validation';

const PLAN_DIGEST_DOMAIN =
  'qinglong/plugin-package-prompt-execution-plan-digest@v1\0';
const PROMPT_DIGEST_DOMAIN =
  'qinglong/plugin-package-prompt-definition-digest@v1\0';
const PARAMETER_DIGEST_DOMAIN =
  'qinglong/plugin-package-prompt-parameter-digest@v1\0';
const REQUEST_DIGEST_DOMAIN =
  'qinglong/plugin-package-prompt-model-request-digest@v1\0';
const IDENTITY_DOMAIN =
  'qinglong/plugin-package-prompt-execution-identity@v1\0';

function executionIdentity(
  prefix: 'ppi' | 'ppr' | 'pps',
  value: Readonly<{
    requestId: string;
    projectId: string;
    publicationDigest: string;
    promptId: string;
  }>,
): string {
  const valueDigest = hash(IDENTITY_DOMAIN, { prefix, ...value });
  return `${prefix}:${valueDigest.slice(0, 32)}`;
}

export function pluginPackagePromptDefinitionDigest(
  value: PluginPackagePromptResource,
): string {
  return hash(
    PROMPT_DIGEST_DOMAIN,
    normalizePluginPackagePromptResource(value),
  );
}

function canonicalParameters(
  prompt: Readonly<PluginPackagePromptResource>,
  value: Readonly<Record<string, string>>,
): Readonly<{
  entries: readonly Readonly<[string, string | null]>[];
  replacements: ReadonlyMap<string, string>;
}> {
  const parameters = dataRecord(value, 'Prompt parameters');
  const declared = new Map(
    prompt.parameters.map((parameter) => [parameter.name, parameter] as const),
  );
  if (Object.keys(parameters).some((name) => !declared.has(name))) {
    return invalid('Prompt parameters contain an undeclared name');
  }
  const entries: [string, string | null][] = [];
  const replacements = new Map<string, string>();
  for (const parameter of prompt.parameters) {
    const raw = parameters[parameter.name];
    if (raw === undefined) {
      if (parameter.required) {
        return invalid(`Prompt parameter ${parameter.name} is required`);
      }
      entries.push([parameter.name, null]);
      replacements.set(parameter.name, '');
      continue;
    }
    if (
      typeof raw !== 'string' ||
      Buffer.byteLength(raw, 'utf8') >
        MAX_PLUGIN_PACKAGE_PROMPT_PARAMETER_VALUE_BYTES
    ) {
      return invalid(`Prompt parameter ${parameter.name} is invalid`);
    }
    entries.push([parameter.name, raw]);
    replacements.set(parameter.name, raw);
  }
  return Object.freeze({
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    replacements,
  });
}

function renderPrompt(
  prompt: Readonly<PluginPackagePromptResource>,
  replacements: ReadonlyMap<string, string>,
): string {
  const rendered = prompt.template.replace(
    /\{\{([A-Za-z][A-Za-z0-9_.-]{0,63})\}\}/g,
    (_match, name: string) => replacements.get(name) ?? '',
  );
  const bytes = Buffer.byteLength(rendered, 'utf8');
  if (bytes > MAX_MODEL_MESSAGE_BYTES || bytes > MAX_MODEL_INPUT_BYTES) {
    return invalid('rendered Prompt exceeds the model input budget');
  }
  return rendered;
}

function planFields(
  value: Omit<PluginPackagePromptExecutionPlan, 'planDigest'>,
): object {
  return {
    schema: value.schema,
    requestId: value.requestId,
    invocationId: value.invocationId,
    runId: value.runId,
    stepRunId: value.stepRunId,
    traceId: value.traceId,
    requestedBySubject: value.requestedBySubject,
    policyFence: value.policyFence,
    target: value.target,
    provider: value.provider,
    model: value.model,
    maxOutputTokens: value.maxOutputTokens,
    temperature: value.temperature,
    parameterDigest: value.parameterDigest,
    modelRequestDigest: value.modelRequestDigest,
    inputBytes: value.inputBytes,
    ...(value.output === undefined ? {} : { output: value.output }),
    deadlineAtMs: value.deadlineAtMs,
    plannedAtMs: value.plannedAtMs,
  };
}

function normalizeOutputIntent(
  value: PluginPackagePromptOutputIntent,
): Readonly<PluginPackagePromptOutputIntent> {
  const output = dataRecord(value, 'Prompt output intent');
  if (value.mode === 'live_only') {
    exactKeys(output, ['mode'], [], 'Prompt output intent');
    return Object.freeze({ mode: 'live_only' as const });
  }
  if (value.mode !== 'durable_artifact') {
    return invalid('Prompt output mode is invalid');
  }
  exactKeys(
    output,
    ['mode', 'retentionPolicy', 'retentionPolicyDigest'],
    [],
    'Prompt output intent',
  );
  const retentionPolicy =
    normalizePluginPackagePromptOutputArtifactRetentionPolicy(
      value.retentionPolicy,
    );
  const retentionPolicyDigest = digest(
    value.retentionPolicyDigest,
    'retentionPolicyDigest',
  );
  if (
    retentionPolicyDigest !==
    pluginPackagePromptOutputArtifactRetentionPolicyDigest(retentionPolicy)
  ) {
    return invalid('Prompt output retention policy digest is invalid');
  }
  return Object.freeze({
    mode: 'durable_artifact' as const,
    retentionPolicy,
    retentionPolicyDigest,
  });
}

function prepareOutputIntent(
  value: PreparePluginPackagePromptOutputIntent | undefined,
): Readonly<PluginPackagePromptOutputIntent> {
  if (value === undefined || value.mode === 'live_only') {
    if (value !== undefined) {
      exactKeys(
        dataRecord(value, 'Prompt output intent'),
        ['mode'],
        [],
        'Prompt output intent',
      );
    }
    return Object.freeze({ mode: 'live_only' as const });
  }
  if (value.mode !== 'durable_artifact') {
    return invalid('Prompt output mode is invalid');
  }
  exactKeys(
    dataRecord(value, 'Prompt output intent'),
    ['mode', 'retentionPolicy'],
    [],
    'Prompt output intent',
  );
  const retentionPolicy =
    normalizePluginPackagePromptOutputArtifactRetentionPolicy(
      value.retentionPolicy,
    );
  return Object.freeze({
    mode: 'durable_artifact' as const,
    retentionPolicy,
    retentionPolicyDigest:
      pluginPackagePromptOutputArtifactRetentionPolicyDigest(retentionPolicy),
  });
}

export function pluginPackagePromptExecutionPlanDigest(
  value: Omit<PluginPackagePromptExecutionPlan, 'planDigest'>,
): string {
  return hash(PLAN_DIGEST_DOMAIN, planFields(value));
}

function normalizeTarget(
  value: PluginPackagePromptExecutionPlanTarget,
): Readonly<PluginPackagePromptExecutionPlanTarget> {
  const target = dataRecord(value, 'Prompt target');
  exactKeys(
    target,
    [
      'projectId',
      'packageName',
      'installationId',
      'lockDigest',
      'generation',
      'generationDigest',
      'materializedRevisionDigest',
      'publicationDigest',
      'promptId',
      'promptDefinitionDigest',
    ],
    [],
    'Prompt target',
  );
  return Object.freeze({
    projectId: identity(value.projectId, 'projectId'),
    packageName: packageName(value.packageName),
    installationId: identity(value.installationId, 'installationId'),
    lockDigest: digest(value.lockDigest, 'lockDigest'),
    generation: positiveInteger(value.generation, 2_147_483_647, 'generation'),
    generationDigest: digest(value.generationDigest, 'generationDigest'),
    materializedRevisionDigest: digest(
      value.materializedRevisionDigest,
      'materializedRevisionDigest',
    ),
    publicationDigest: digest(value.publicationDigest, 'publicationDigest'),
    promptId: identity(value.promptId, 'promptId'),
    promptDefinitionDigest: digest(
      value.promptDefinitionDigest,
      'promptDefinitionDigest',
    ),
  });
}

export function normalizePluginPackagePromptExecutionPlan(
  value: PluginPackagePromptExecutionPlan,
): Readonly<PluginPackagePromptExecutionPlan> {
  const plan = dataRecord(value, 'Prompt execution plan');
  exactKeys(
    plan,
    [
      'schema',
      'requestId',
      'invocationId',
      'runId',
      'stepRunId',
      'traceId',
      'requestedBySubject',
      'policyFence',
      'target',
      'provider',
      'model',
      'maxOutputTokens',
      'temperature',
      'parameterDigest',
      'modelRequestDigest',
      'inputBytes',
      'deadlineAtMs',
      'plannedAtMs',
      'planDigest',
    ],
    ['output'],
    'Prompt execution plan',
  );
  if (value.schema !== PLUGIN_PACKAGE_PROMPT_EXECUTION_PLAN_SCHEMA) {
    return invalid('schema is unsupported');
  }
  const target = normalizeTarget(value.target);
  const requestId = identity(value.requestId, 'requestId');
  const identityInput = Object.freeze({
    requestId,
    projectId: target.projectId,
    publicationDigest: target.publicationDigest,
    promptId: target.promptId,
  });
  const fence = dataRecord(value.policyFence, 'Prompt execution policy fence');
  exactKeys(
    fence,
    ['projectVersion', 'bindingVersion'],
    [],
    'Prompt execution policy fence',
  );
  const policyFence = Object.freeze({
    projectVersion: positiveInteger(
      value.policyFence.projectVersion,
      2_147_483_647,
      'policyFence.projectVersion',
    ),
    bindingVersion: positiveInteger(
      value.policyFence.bindingVersion,
      2_147_483_647,
      'policyFence.bindingVersion',
    ),
  });
  const normalized = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_EXECUTION_PLAN_SCHEMA,
    requestId,
    invocationId: identity(value.invocationId, 'invocationId'),
    runId: identity(value.runId, 'runId'),
    stepRunId: identity(value.stepRunId, 'stepRunId'),
    traceId: identity(value.traceId, 'traceId'),
    requestedBySubject: normalizeProjectPolicySubject(value.requestedBySubject),
    policyFence,
    target,
    provider: identity(value.provider, 'provider'),
    model: identity(value.model, 'model'),
    maxOutputTokens: positiveInteger(
      value.maxOutputTokens,
      MAX_MODEL_OUTPUT_TOKENS,
      'maxOutputTokens',
    ),
    temperature: nullableTemperature(value.temperature),
    parameterDigest: digest(value.parameterDigest, 'parameterDigest'),
    modelRequestDigest: sha256(value.modelRequestDigest, 'modelRequestDigest'),
    inputBytes: positiveInteger(
      value.inputBytes,
      MAX_MODEL_INPUT_BYTES,
      'inputBytes',
    ),
    ...(value.output === undefined
      ? {}
      : { output: normalizeOutputIntent(value.output) }),
    deadlineAtMs: timestamp(value.deadlineAtMs, 'deadlineAtMs'),
    plannedAtMs: timestamp(value.plannedAtMs, 'plannedAtMs'),
    planDigest: digest(value.planDigest, 'planDigest'),
  });
  if (
    normalized.invocationId !== executionIdentity('ppi', identityInput) ||
    normalized.runId !== executionIdentity('ppr', identityInput) ||
    normalized.stepRunId !== executionIdentity('pps', identityInput) ||
    normalized.deadlineAtMs <= normalized.plannedAtMs ||
    normalized.deadlineAtMs - normalized.plannedAtMs >
      MAX_MODEL_INVOCATION_MS ||
    pluginPackagePromptExecutionPlanDigest(normalized) !==
      normalized.planDigest ||
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
      MAX_PLUGIN_PACKAGE_PROMPT_EXECUTION_PLAN_BYTES
  ) {
    return invalid('identity, deadline, digest, or size is invalid');
  }
  return normalized;
}

export function preparePluginPackagePromptExecution(
  input: PreparePluginPackagePromptExecutionInput,
): Readonly<PreparedPluginPackagePromptExecution> {
  const source = dataRecord(input, 'Prompt execution input');
  exactKeys(
    source,
    [
      'publication',
      'expectedPublicationDigest',
      'promptId',
      'requestId',
      'traceId',
      'requestedBySubject',
      'policyFence',
      'parameters',
      'provider',
      'model',
      'maxOutputTokens',
      'deadlineAtMs',
      'plannedAtMs',
    ],
    ['output', 'signal', 'temperature'],
    'Prompt execution input',
  );
  const publication = normalizePluginPackageAutomationPublication(
    input.publication,
  );
  const expectedPublicationDigest = digest(
    input.expectedPublicationDigest,
    'expectedPublicationDigest',
  );
  const promptId = identity(input.promptId, 'promptId');
  if (
    publication.publicationDigest !== expectedPublicationDigest ||
    publication.state !== 'active'
  ) {
    return invalid('publication is not the expected active generation');
  }
  const prompt = publication.definitions.prompts.find(
    (candidate) => candidate.id === promptId,
  );
  if (!prompt) return invalid('Prompt is not published');
  const parameters = canonicalParameters(prompt, input.parameters);
  const rendered = renderPrompt(prompt, parameters.replacements);
  const provider = identity(input.provider, 'provider');
  const model = identity(input.model, 'model');
  const maxOutputTokens = positiveInteger(
    input.maxOutputTokens,
    MAX_MODEL_OUTPUT_TOKENS,
    'maxOutputTokens',
  );
  const temperature =
    input.temperature === undefined
      ? null
      : nullableTemperature(input.temperature);
  const request = Object.freeze({
    provider,
    model,
    messages: Object.freeze([
      Object.freeze({ role: 'user' as const, content: rendered }),
    ]),
    maxOutputTokens,
    ...(temperature === null ? {} : { temperature }),
  });
  const requestId = identity(input.requestId, 'requestId');
  if (
    input.signal !== undefined &&
    (typeof input.signal !== 'object' ||
      typeof input.signal.aborted !== 'boolean' ||
      typeof input.signal.addEventListener !== 'function')
  ) {
    return invalid('signal is invalid');
  }
  const identityInput = Object.freeze({
    requestId,
    projectId: publication.target.projectId,
    publicationDigest: publication.publicationDigest,
    promptId,
  });
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_EXECUTION_PLAN_SCHEMA,
    requestId,
    invocationId: executionIdentity('ppi', identityInput),
    runId: executionIdentity('ppr', identityInput),
    stepRunId: executionIdentity('pps', identityInput),
    traceId: identity(input.traceId, 'traceId'),
    requestedBySubject: normalizeProjectPolicySubject(input.requestedBySubject),
    policyFence: Object.freeze({
      projectVersion: positiveInteger(
        input.policyFence.projectVersion,
        2_147_483_647,
        'policyFence.projectVersion',
      ),
      bindingVersion: positiveInteger(
        input.policyFence.bindingVersion,
        2_147_483_647,
        'policyFence.bindingVersion',
      ),
    }),
    target: Object.freeze({
      ...publication.target,
      publicationDigest: publication.publicationDigest,
      promptId,
      promptDefinitionDigest: pluginPackagePromptDefinitionDigest(prompt),
    }),
    provider,
    model,
    maxOutputTokens,
    temperature,
    parameterDigest: hash(PARAMETER_DIGEST_DOMAIN, parameters.entries),
    modelRequestDigest: `sha256:${hash(REQUEST_DIGEST_DOMAIN, request)}`,
    inputBytes: Buffer.byteLength(rendered, 'utf8'),
    output: prepareOutputIntent(input.output),
    deadlineAtMs: timestamp(input.deadlineAtMs, 'deadlineAtMs'),
    plannedAtMs: timestamp(input.plannedAtMs, 'plannedAtMs'),
  });
  const plan = normalizePluginPackagePromptExecutionPlan({
    ...unsigned,
    planDigest: pluginPackagePromptExecutionPlanDigest(unsigned),
  });
  return Object.freeze({
    plan,
    request,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}
