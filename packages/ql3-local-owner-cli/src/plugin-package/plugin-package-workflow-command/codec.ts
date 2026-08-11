import path from 'node:path';

import {
  PrivateLocalCommandFileError,
  readPrivateLocalCommandFile,
} from './codecAuthority';
import {
  type CancelLocalPluginPackageWorkflowCommand,
  type InspectLocalPluginPackageWorkflowRunCommand,
  type ListLocalPluginPackageWorkflowRunEventsCommand,
  type ListLocalPluginPackageWorkflowRunsCommand,
  type ListLocalPluginPackageWorkflowStepRunsCommand,
  type LocalPluginPackageWorkflowCommand,
  LocalPluginPackageWorkflowCommandConfigurationError,
  type LocalPluginPackageWorkflowCommandOptions,
  type LocalPluginPackageWorkflowCommandRequestBase,
  type StartLocalPluginPackageWorkflowCommand,
} from './contracts';

const MAX_PATH_BYTES = 4_096;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPluginPackageWorkflowCommandConfigurationError(
      `${label} must be an object`,
    );
  }
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new LocalPluginPackageWorkflowCommandConfigurationError(
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
    throw new LocalPluginPackageWorkflowCommandConfigurationError(
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
    throw new LocalPluginPackageWorkflowCommandConfigurationError(
      `${label} must be a descendant of deploymentRoot`,
    );
  }
}

function normalizeOptions(
  value: unknown,
): Readonly<LocalPluginPackageWorkflowCommandOptions> {
  exactObject(
    value,
    [
      'credentialFilePath',
      'databasePath',
      'deploymentRoot',
      'ownerPepperKeyringDirectory',
      'profile',
    ],
    ['busyTimeoutMs'],
    'options',
  );
  const deploymentRoot = boundedPath(value.deploymentRoot, 'deploymentRoot');
  const databasePath = boundedPath(value.databasePath, 'databasePath');
  const ownerPepperKeyringDirectory = boundedPath(
    value.ownerPepperKeyringDirectory,
    'ownerPepperKeyringDirectory',
  );
  const credentialFilePath = boundedPath(
    value.credentialFilePath,
    'credentialFilePath',
  );
  descendant(deploymentRoot, databasePath, 'databasePath');
  descendant(
    deploymentRoot,
    ownerPepperKeyringDirectory,
    'ownerPepperKeyringDirectory',
  );
  descendant(deploymentRoot, credentialFilePath, 'credentialFilePath');
  if (value.profile !== 'edge' && value.profile !== 'standalone') {
    throw new LocalPluginPackageWorkflowCommandConfigurationError(
      'profile must be edge or standalone',
    );
  }
  if (
    value.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(value.busyTimeoutMs) ||
      (value.busyTimeoutMs as number) < 100 ||
      (value.busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalPluginPackageWorkflowCommandConfigurationError(
      'busyTimeoutMs is invalid',
    );
  }
  return Object.freeze({
    deploymentRoot,
    databasePath,
    profile: value.profile,
    ownerPepperKeyringDirectory,
    credentialFilePath,
    ...(value.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: value.busyTimeoutMs as number }),
  });
}

function normalizedRequestBase(
  value: Record<string, unknown>,
): LocalPluginPackageWorkflowCommandRequestBase {
  for (const key of ['projectId', 'packageName', 'requestId'] as const) {
    if (typeof value[key] !== 'string') {
      throw new LocalPluginPackageWorkflowCommandConfigurationError(
        `${key} is invalid`,
      );
    }
  }
  for (const key of ['auditEventId', 'failureAuditEventId'] as const) {
    if (typeof value[key] !== 'string' || !UUID_V4_PATTERN.test(value[key])) {
      throw new LocalPluginPackageWorkflowCommandConfigurationError(
        `${key} must be a UUID v4`,
      );
    }
  }
  if (value.auditEventId === value.failureAuditEventId) {
    throw new LocalPluginPackageWorkflowCommandConfigurationError(
      'audit identities must be distinct',
    );
  }
  return value as unknown as LocalPluginPackageWorkflowCommandRequestBase;
}

function normalizeCommand(
  value: unknown,
): Readonly<LocalPluginPackageWorkflowCommand> {
  exactObject(
    value,
    ['operation', 'options', 'request', 'schemaVersion'],
    [],
    'command',
  );
  if (
    value.schemaVersion !== 1 ||
    (value.operation !== 'workflow.inspect' &&
      value.operation !== 'workflow.run.inspect' &&
      value.operation !== 'workflow.run.list' &&
      value.operation !== 'workflow.step.list' &&
      value.operation !== 'workflow.event.list' &&
      value.operation !== 'workflow.start' &&
      value.operation !== 'workflow.cancel')
  ) {
    throw new LocalPluginPackageWorkflowCommandConfigurationError(
      'command version or operation is invalid',
    );
  }
  const options = normalizeOptions(value.options);
  if (value.operation === 'workflow.inspect') {
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
    return Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      options,
      request: normalizedRequestBase(value.request),
    });
  }
  if (value.operation === 'workflow.run.inspect') {
    exactObject(
      value.request,
      [
        'auditEventId',
        'failureAuditEventId',
        'packageName',
        'projectId',
        'requestId',
        'runId',
        'workflowId',
      ],
      [],
      'request',
    );
    return Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      options,
      request: normalizedRequestBase(
        value.request,
      ) as InspectLocalPluginPackageWorkflowRunCommand['request'],
    });
  }
  if (value.operation === 'workflow.run.list') {
    exactObject(
      value.request,
      [
        'after',
        'auditEventId',
        'failureAuditEventId',
        'limit',
        'packageName',
        'projectId',
        'requestId',
        'workflowId',
      ],
      [],
      'request',
    );
    if (
      !Number.isSafeInteger(value.request.limit) ||
      (value.request.limit as number) < 1 ||
      (value.request.limit as number) > 64
    ) {
      throw new LocalPluginPackageWorkflowCommandConfigurationError(
        'run list limit is invalid',
      );
    }
    if (value.request.after !== null) {
      exactObject(
        value.request.after,
        ['admittedAtMs', 'runId'],
        [],
        'request.after',
      );
      if (
        !Number.isSafeInteger(value.request.after.admittedAtMs) ||
        (value.request.after.admittedAtMs as number) < 0 ||
        typeof value.request.after.runId !== 'string' ||
        !UUID_V4_PATTERN.test(value.request.after.runId)
      ) {
        throw new LocalPluginPackageWorkflowCommandConfigurationError(
          'run list cursor is invalid',
        );
      }
    }
    return Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      options,
      request: normalizedRequestBase(
        value.request,
      ) as ListLocalPluginPackageWorkflowRunsCommand['request'],
    });
  }
  if (value.operation === 'workflow.step.list') {
    exactObject(
      value.request,
      [
        'after',
        'auditEventId',
        'failureAuditEventId',
        'limit',
        'packageName',
        'projectId',
        'requestId',
        'runId',
        'workflowId',
      ],
      [],
      'request',
    );
    if (
      !Number.isSafeInteger(value.request.limit) ||
      (value.request.limit as number) < 1 ||
      (value.request.limit as number) > 64
    ) {
      throw new LocalPluginPackageWorkflowCommandConfigurationError(
        'StepRun list limit is invalid',
      );
    }
    if (value.request.after !== null) {
      exactObject(value.request.after, ['id', 'stepKey'], [], 'request.after');
      if (
        typeof value.request.after.id !== 'string' ||
        typeof value.request.after.stepKey !== 'string'
      ) {
        throw new LocalPluginPackageWorkflowCommandConfigurationError(
          'StepRun list cursor is invalid',
        );
      }
    }
    return Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      options,
      request: normalizedRequestBase(
        value.request,
      ) as ListLocalPluginPackageWorkflowStepRunsCommand['request'],
    });
  }
  if (value.operation === 'workflow.event.list') {
    exactObject(
      value.request,
      [
        'afterSequence',
        'auditEventId',
        'failureAuditEventId',
        'limit',
        'packageName',
        'projectId',
        'requestId',
        'runId',
        'workflowId',
      ],
      [],
      'request',
    );
    if (
      !Number.isSafeInteger(value.request.limit) ||
      (value.request.limit as number) < 1 ||
      (value.request.limit as number) > 64 ||
      !Number.isSafeInteger(value.request.afterSequence) ||
      (value.request.afterSequence as number) < 0
    ) {
      throw new LocalPluginPackageWorkflowCommandConfigurationError(
        'RunEvent list page is invalid',
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      options,
      request: normalizedRequestBase(
        value.request,
      ) as ListLocalPluginPackageWorkflowRunEventsCommand['request'],
    });
  }
  if (value.operation === 'workflow.cancel') {
    exactObject(
      value.request,
      [
        'auditEventId',
        'failureAuditEventId',
        'mutationId',
        'packageName',
        'projectId',
        'requestId',
        'runEventId',
        'runId',
      ],
      [],
      'request',
    );
    return Object.freeze({
      schemaVersion: 1,
      operation: value.operation,
      options,
      request: normalizedRequestBase(
        value.request,
      ) as CancelLocalPluginPackageWorkflowCommand['request'],
    });
  }
  exactObject(
    value.request,
    [
      'auditEventId',
      'failureAuditEventId',
      'packageName',
      'planId',
      'projectId',
      'requestId',
      'runId',
      'stepRunIds',
      'workflowId',
    ],
    [],
    'request',
  );
  return Object.freeze({
    schemaVersion: 1,
    operation: value.operation,
    options,
    request: normalizedRequestBase(
      value.request,
    ) as StartLocalPluginPackageWorkflowCommand['request'],
  });
}

export function readCommandFile(
  candidatePath: string,
): Readonly<LocalPluginPackageWorkflowCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(candidatePath));
  } catch (error) {
    if (error instanceof LocalPluginPackageWorkflowCommandConfigurationError) {
      throw error;
    }
    if (error instanceof PrivateLocalCommandFileError) {
      throw new LocalPluginPackageWorkflowCommandConfigurationError(
        'command file cannot be read',
        error,
      );
    }
    throw new LocalPluginPackageWorkflowCommandConfigurationError(
      'command file cannot be read',
      error,
    );
  }
}
