import path from 'node:path';

import {
  PrivateLocalCommandFileError,
  readPrivateLocalCommandFile,
} from './codecAuthority';
import {
  LocalPluginPackagePromptCommandConfigurationError,
  type LocalPluginPackagePromptCommand,
  type LocalPluginPackagePromptCommandOptions,
  type LocalPluginPackagePromptInspectCommandOptions,
  type LocalPluginPackagePromptOutputCommandOptions,
  type LocalPluginPackagePromptOutputIntent,
} from './contracts';

const MAX_PATH_BYTES = 4_096;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_PARAMETER_COUNT = 128;
const MAX_PARAMETER_VALUE_BYTES = 64 * 1_024;
const MIN_OUTPUT_RETENTION_MS = 60 * 60_000;
const MAX_OUTPUT_RETENTION_MS = 365 * 24 * 60 * 60_000;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESOURCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      `${label} must be an object`,
    );
  }
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      `${label} shape is invalid`,
    );
  }
}

function boundedPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

function descendant(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      `${label} must be a descendant of deploymentRoot`,
    );
  }
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      `${label} is invalid`,
    );
  }
  return value;
}

function normalizeOptions(
  value: unknown,
  operation: 'prompt.inspect' | 'prompt.execution.inspect',
): Readonly<LocalPluginPackagePromptInspectCommandOptions>;
function normalizeOptions(
  value: unknown,
  operation: 'prompt.execution.output.read',
): Readonly<LocalPluginPackagePromptOutputCommandOptions>;
function normalizeOptions(
  value: unknown,
  operation: 'prompt.execute',
): Readonly<LocalPluginPackagePromptCommandOptions>;
function normalizeOptions(
  value: unknown,
  operation:
    | 'prompt.inspect'
    | 'prompt.execution.inspect'
    | 'prompt.execution.output.read'
    | 'prompt.execute',
): Readonly<
  | LocalPluginPackagePromptCommandOptions
  | LocalPluginPackagePromptInspectCommandOptions
  | LocalPluginPackagePromptOutputCommandOptions
> {
  const execution = operation === 'prompt.execute';
  const outputRead = operation === 'prompt.execution.output.read';
  exactObject(
    value,
    [
      'credentialFilePath',
      'databasePath',
      'deploymentRoot',
      'ownerPepperKeyringDirectory',
      'profile',
      ...(execution ? ['providerAuthorityFilePath', 'secretKeyringPath'] : []),
      ...(outputRead ? ['promptOutputKeyringPath'] : []),
    ],
    ['busyTimeoutMs', ...(execution ? ['promptOutputKeyringPath'] : [])],
    'options',
  );
  const deploymentRoot = boundedPath(value.deploymentRoot, 'deploymentRoot');
  const basePaths = {
    databasePath: boundedPath(value.databasePath, 'databasePath'),
    ownerPepperKeyringDirectory: boundedPath(
      value.ownerPepperKeyringDirectory,
      'ownerPepperKeyringDirectory',
    ),
    credentialFilePath: boundedPath(
      value.credentialFilePath,
      'credentialFilePath',
    ),
  };
  const executionPaths = execution
    ? {
        secretKeyringPath: boundedPath(
          value.secretKeyringPath,
          'secretKeyringPath',
        ),
        providerAuthorityFilePath: boundedPath(
          value.providerAuthorityFilePath,
          'providerAuthorityFilePath',
        ),
      }
    : {};
  const outputPaths =
    value.promptOutputKeyringPath === undefined
      ? {}
      : {
          promptOutputKeyringPath: boundedPath(
            value.promptOutputKeyringPath,
            'promptOutputKeyringPath',
          ),
        };
  const paths = { ...basePaths, ...executionPaths, ...outputPaths };
  for (const [label, candidate] of Object.entries(paths)) {
    descendant(deploymentRoot, candidate, label);
  }
  if (value.profile !== 'edge' && value.profile !== 'standalone') {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      'profile must be edge or standalone',
    );
  }
  if (
    value.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(value.busyTimeoutMs) ||
      (value.busyTimeoutMs as number) < 100 ||
      (value.busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      'busyTimeoutMs is invalid',
    );
  }
  return Object.freeze({
    deploymentRoot,
    ...paths,
    profile: value.profile,
    ...(value.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: value.busyTimeoutMs as number }),
  });
}

function normalizeParameters(value: unknown): Readonly<Record<string, string>> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      'parameters must be a plain object',
    );
  }
  const entries = Object.entries(value);
  if (
    entries.length > MAX_PARAMETER_COUNT ||
    entries.some(
      ([key, candidate]) =>
        !RESOURCE_ID_PATTERN.test(key) ||
        typeof candidate !== 'string' ||
        Buffer.byteLength(candidate, 'utf8') > MAX_PARAMETER_VALUE_BYTES,
    )
  ) {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      'parameters are invalid or exceed the bounded input budget',
    );
  }
  return Object.freeze(Object.fromEntries(entries));
}

function normalizeOutputIntent(
  value: unknown,
): Readonly<LocalPluginPackagePromptOutputIntent> {
  exactObject(value, ['mode'], ['retentionPolicy'], 'output');
  if (value.mode === 'live_only') {
    exactObject(value, ['mode'], [], 'output');
    return Object.freeze({ mode: 'live_only' as const });
  }
  if (value.mode !== 'durable_artifact') {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      'output mode is invalid',
    );
  }
  exactObject(value, ['mode', 'retentionPolicy'], [], 'output');
  exactObject(
    value.retentionPolicy,
    ['retentionMs', 'revision'],
    [],
    'output.retentionPolicy',
  );
  if (
    !Number.isSafeInteger(value.retentionPolicy.retentionMs) ||
    (value.retentionPolicy.retentionMs as number) < MIN_OUTPUT_RETENTION_MS ||
    (value.retentionPolicy.retentionMs as number) > MAX_OUTPUT_RETENTION_MS
  ) {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      'output retention is invalid',
    );
  }
  return Object.freeze({
    mode: 'durable_artifact' as const,
    retentionPolicy: Object.freeze({
      revision: identity(
        value.retentionPolicy.revision,
        'output.retentionPolicy.revision',
      ),
      retentionMs: value.retentionPolicy.retentionMs as number,
    }),
  });
}

function normalizeCommand(
  value: unknown,
): Readonly<LocalPluginPackagePromptCommand> {
  exactObject(
    value,
    ['operation', 'options', 'request', 'schemaVersion'],
    [],
    'command',
  );
  if (
    value.schemaVersion !== 1 ||
    (value.operation !== 'prompt.inspect' &&
      value.operation !== 'prompt.execution.inspect' &&
      value.operation !== 'prompt.execution.output.read' &&
      value.operation !== 'prompt.execute')
  ) {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      'command version or operation is invalid',
    );
  }
  if (value.operation === 'prompt.inspect') {
    const options = normalizeOptions(value.options, 'prompt.inspect');
    exactObject(
      value.request,
      [
        'auditEventId',
        'failureAuditEventId',
        'packageName',
        'projectId',
        'requestId',
      ],
      [],
      'request',
    );
    if (
      typeof value.request.packageName !== 'string' ||
      !PACKAGE_NAME_PATTERN.test(value.request.packageName) ||
      typeof value.request.auditEventId !== 'string' ||
      !UUID_V4_PATTERN.test(value.request.auditEventId) ||
      typeof value.request.failureAuditEventId !== 'string' ||
      !UUID_V4_PATTERN.test(value.request.failureAuditEventId) ||
      value.request.auditEventId === value.request.failureAuditEventId
    ) {
      throw new LocalPluginPackagePromptCommandConfigurationError(
        'request value is invalid',
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      operation: 'prompt.inspect',
      options,
      request: Object.freeze({
        projectId: identity(value.request.projectId, 'projectId'),
        packageName: value.request.packageName,
        requestId: identity(value.request.requestId, 'requestId'),
        auditEventId: value.request.auditEventId,
        failureAuditEventId: value.request.failureAuditEventId,
      }),
    });
  }
  if (value.operation === 'prompt.execution.inspect') {
    const options = normalizeOptions(value.options, 'prompt.execution.inspect');
    exactObject(
      value.request,
      [
        'auditEventId',
        'executionRequestId',
        'failureAuditEventId',
        'packageName',
        'projectId',
        'promptId',
        'requestId',
      ],
      [],
      'request',
    );
    if (
      typeof value.request.packageName !== 'string' ||
      !PACKAGE_NAME_PATTERN.test(value.request.packageName) ||
      typeof value.request.promptId !== 'string' ||
      !RESOURCE_ID_PATTERN.test(value.request.promptId) ||
      typeof value.request.auditEventId !== 'string' ||
      !UUID_V4_PATTERN.test(value.request.auditEventId) ||
      typeof value.request.failureAuditEventId !== 'string' ||
      !UUID_V4_PATTERN.test(value.request.failureAuditEventId) ||
      value.request.auditEventId === value.request.failureAuditEventId
    ) {
      throw new LocalPluginPackagePromptCommandConfigurationError(
        'request value is invalid',
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      operation: 'prompt.execution.inspect',
      options,
      request: Object.freeze({
        projectId: identity(value.request.projectId, 'projectId'),
        packageName: value.request.packageName,
        promptId: value.request.promptId,
        executionRequestId: identity(
          value.request.executionRequestId,
          'executionRequestId',
        ),
        requestId: identity(value.request.requestId, 'requestId'),
        auditEventId: value.request.auditEventId,
        failureAuditEventId: value.request.failureAuditEventId,
      }),
    });
  }
  if (value.operation === 'prompt.execution.output.read') {
    const options = normalizeOptions(
      value.options,
      'prompt.execution.output.read',
    );
    exactObject(
      value.request,
      [
        'auditEventId',
        'executionRequestId',
        'failureAuditEventId',
        'packageName',
        'projectId',
        'promptId',
        'requestId',
      ],
      [],
      'request',
    );
    if (
      typeof value.request.packageName !== 'string' ||
      !PACKAGE_NAME_PATTERN.test(value.request.packageName) ||
      typeof value.request.promptId !== 'string' ||
      !RESOURCE_ID_PATTERN.test(value.request.promptId) ||
      typeof value.request.auditEventId !== 'string' ||
      !UUID_V4_PATTERN.test(value.request.auditEventId) ||
      typeof value.request.failureAuditEventId !== 'string' ||
      !UUID_V4_PATTERN.test(value.request.failureAuditEventId) ||
      value.request.auditEventId === value.request.failureAuditEventId
    ) {
      throw new LocalPluginPackagePromptCommandConfigurationError(
        'request value is invalid',
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      operation: 'prompt.execution.output.read',
      options,
      request: Object.freeze({
        projectId: identity(value.request.projectId, 'projectId'),
        packageName: value.request.packageName,
        promptId: value.request.promptId,
        executionRequestId: identity(
          value.request.executionRequestId,
          'executionRequestId',
        ),
        requestId: identity(value.request.requestId, 'requestId'),
        auditEventId: value.request.auditEventId,
        failureAuditEventId: value.request.failureAuditEventId,
      }),
    });
  }
  const options = normalizeOptions(value.options, 'prompt.execute');
  const hasTemperature =
    !!value.request &&
    typeof value.request === 'object' &&
    !Array.isArray(value.request) &&
    Object.hasOwn(value.request, 'temperature');
  exactObject(
    value.request,
    [
      'auditEventId',
      'failureAuditEventId',
      'maxOutputTokens',
      'model',
      'output',
      'packageName',
      'parameters',
      'projectId',
      'promptId',
      'provider',
      'requestId',
      'timeoutMs',
      'traceId',
    ],
    hasTemperature ? ['temperature'] : [],
    'request',
  );
  const request = value.request;
  if (
    typeof request.packageName !== 'string' ||
    !PACKAGE_NAME_PATTERN.test(request.packageName) ||
    typeof request.promptId !== 'string' ||
    !RESOURCE_ID_PATTERN.test(request.promptId) ||
    typeof request.auditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(request.auditEventId) ||
    typeof request.failureAuditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(request.failureAuditEventId) ||
    request.auditEventId === request.failureAuditEventId ||
    !Number.isSafeInteger(request.maxOutputTokens) ||
    (request.maxOutputTokens as number) < 1 ||
    (request.maxOutputTokens as number) > 1_000_000 ||
    !Number.isSafeInteger(request.timeoutMs) ||
    (request.timeoutMs as number) < 100 ||
    (request.timeoutMs as number) > MAX_TIMEOUT_MS ||
    (request.temperature !== undefined &&
      (typeof request.temperature !== 'number' ||
        !Number.isFinite(request.temperature) ||
        request.temperature < 0 ||
        request.temperature > 2))
  ) {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      'request value is invalid',
    );
  }
  const output = normalizeOutputIntent(request.output);
  if (
    output.mode === 'durable_artifact' &&
    options.promptOutputKeyringPath === undefined
  ) {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      'durable output requires promptOutputKeyringPath',
    );
  }
  if (
    output.mode === 'live_only' &&
    options.promptOutputKeyringPath !== undefined
  ) {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      'live-only output must not configure promptOutputKeyringPath',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: 'prompt.execute',
    options,
    request: Object.freeze({
      projectId: identity(request.projectId, 'projectId'),
      packageName: request.packageName,
      promptId: request.promptId,
      requestId: identity(request.requestId, 'requestId'),
      traceId: identity(request.traceId, 'traceId'),
      auditEventId: request.auditEventId,
      failureAuditEventId: request.failureAuditEventId,
      parameters: normalizeParameters(request.parameters),
      provider: identity(request.provider, 'provider'),
      model: identity(request.model, 'model'),
      maxOutputTokens: request.maxOutputTokens as number,
      ...(request.temperature === undefined
        ? {}
        : { temperature: request.temperature as number }),
      timeoutMs: request.timeoutMs as number,
      output,
    }),
  });
}

export function readCommandFile(
  candidatePath: string,
): Readonly<LocalPluginPackagePromptCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(candidatePath));
  } catch (error) {
    if (error instanceof LocalPluginPackagePromptCommandConfigurationError) {
      throw error;
    }
    throw new LocalPluginPackagePromptCommandConfigurationError(
      'command file cannot be read',
      error instanceof PrivateLocalCommandFileError ? error : undefined,
    );
  }
}
