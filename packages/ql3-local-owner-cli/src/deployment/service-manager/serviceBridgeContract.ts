import crypto from 'node:crypto';
import path from 'node:path';

import { LocalDeploymentConfigurationError } from '../foundation/error';

const MAX_PATH_BYTES = 4_096;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CUTOVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_TARGET_GENERATION = 15;

export type LocalServiceManagerKind = 'systemd' | 'openrc';
export type LocalServiceManagerAction =
  | 'install-enable-start'
  | 'start'
  | 'restart'
  | 'stop';

export type LocalServiceManagerIntentLineage =
  | Readonly<{ mode: 'fresh' }>
  | Readonly<{
      mode: 'adopted';
      cutoverId: string;
      generation: number;
      expectedActivationDigest: string;
      previousRecordDigest: string;
    }>;

export interface LocalServiceManagerIntent {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-local-service-manager-intent';
  readonly actionId: string;
  readonly action: LocalServiceManagerAction;
  readonly profile: 'edge' | 'standalone';
  readonly instanceId: string;
  readonly service: Readonly<{
    kind: LocalServiceManagerKind;
    name: 'qinglong3';
    uid: number;
    gid: number;
    allowRootService: boolean;
  }>;
  readonly deployment: Readonly<{
    root: string;
    applicationConfigPath: string;
    applicationConfigSha256: string;
  }>;
  readonly descriptor: Readonly<{
    sourcePath: string;
    destinationPath: string;
    sha256: string;
    sourceMode: number;
    destinationMode: number;
  }>;
  readonly lineage: LocalServiceManagerIntentLineage;
  readonly outcomePath: string;
  readonly requestedAtMs: number;
  readonly intentDigest: string;
}

export type LocalServiceBridgeManager =
  | Readonly<{
      kind: 'systemd';
      executable: string;
    }>
  | Readonly<{
      kind: 'openrc';
      serviceExecutable: string;
      updateExecutable: string;
    }>;

export interface LocalServiceBridgeCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.deployment.service-manager.execute';
  readonly options: Readonly<{
    controllerRoot: string;
    allowRootController: true;
    manager: LocalServiceBridgeManager;
  }>;
  readonly request: Readonly<{
    intentPath: string;
    expectedIntentDigest: string;
  }>;
}

export function localServiceManagerIntentPath(
  deploymentRoot: string,
  actionId: string,
): string {
  return path.join(
    deploymentRoot,
    'service',
    'service-manager-intents',
    `${actionId}.json`,
  );
}

export function localServiceManagerOutcomePath(
  deploymentRoot: string,
  actionId: string,
): string {
  return path.join(
    deploymentRoot,
    'service',
    'service-manager-outcomes',
    `${actionId}.json`,
  );
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    configurationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    configurationError(`${label} shape is invalid`);
  }
}

function safeAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value ||
    value.includes('\0') ||
    value.includes('//') ||
    !SAFE_PATH_PATTERN.test(value) ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    configurationError(`${label} must be a supervisor-safe absolute path`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, maximum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    configurationError(`${label} is invalid`);
  }
  return value as number;
}

function normalizedLineage(value: unknown): LocalServiceManagerIntentLineage {
  const lineage = object(value, 'lineage');
  if (lineage.mode === 'fresh') {
    exact(lineage, ['mode'], 'lineage');
    return Object.freeze({ mode: 'fresh' as const });
  }
  exact(
    lineage,
    [
      'cutoverId',
      'expectedActivationDigest',
      'generation',
      'mode',
      'previousRecordDigest',
    ],
    'lineage',
  );
  if (
    lineage.mode !== 'adopted' ||
    typeof lineage.cutoverId !== 'string' ||
    !CUTOVER_ID_PATTERN.test(lineage.cutoverId) ||
    !Number.isSafeInteger(lineage.generation) ||
    (lineage.generation as number) < 1 ||
    (lineage.generation as number) > MAX_TARGET_GENERATION ||
    typeof lineage.expectedActivationDigest !== 'string' ||
    !DIGEST_PATTERN.test(lineage.expectedActivationDigest) ||
    typeof lineage.previousRecordDigest !== 'string' ||
    !DIGEST_PATTERN.test(lineage.previousRecordDigest)
  ) {
    configurationError('adopted lineage is invalid');
  }
  return Object.freeze({
    mode: 'adopted' as const,
    cutoverId: lineage.cutoverId,
    generation: lineage.generation as number,
    expectedActivationDigest: lineage.expectedActivationDigest,
    previousRecordDigest: lineage.previousRecordDigest,
  });
}

export function localServiceManagerIntentDigest(
  value: Omit<LocalServiceManagerIntent, 'intentDigest'>,
): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

export function normalizeLocalServiceManagerIntent(
  value: unknown,
): Readonly<LocalServiceManagerIntent> {
  const intent = object(value, 'service manager intent');
  exact(
    intent,
    [
      'action',
      'actionId',
      'deployment',
      'descriptor',
      'instanceId',
      'intentDigest',
      'kind',
      'lineage',
      'outcomePath',
      'profile',
      'requestedAtMs',
      'schemaVersion',
      'service',
    ],
    'service manager intent',
  );
  const service = object(intent.service, 'service');
  exact(service, ['allowRootService', 'gid', 'kind', 'name', 'uid'], 'service');
  if (
    (service.kind !== 'systemd' && service.kind !== 'openrc') ||
    service.name !== 'qinglong3' ||
    typeof service.allowRootService !== 'boolean'
  ) {
    configurationError('service identity is invalid');
  }
  const uid = safeInteger(service.uid, 'service uid', 0x7fffffff);
  const gid = safeInteger(service.gid, 'service gid', 0x7fffffff);
  if ((uid === 0) !== service.allowRootService) {
    configurationError('allowRootService does not match the service uid');
  }
  const deployment = object(intent.deployment, 'deployment');
  exact(
    deployment,
    ['applicationConfigPath', 'applicationConfigSha256', 'root'],
    'deployment',
  );
  const root = safeAbsolutePath(deployment.root, 'deployment root');
  const applicationConfigPath = safeAbsolutePath(
    deployment.applicationConfigPath,
    'application config path',
  );
  const descriptor = object(intent.descriptor, 'descriptor');
  exact(
    descriptor,
    [
      'destinationMode',
      'destinationPath',
      'sha256',
      'sourceMode',
      'sourcePath',
    ],
    'descriptor',
  );
  const sourcePath = safeAbsolutePath(
    descriptor.sourcePath,
    'descriptor source',
  );
  const destinationPath = safeAbsolutePath(
    descriptor.destinationPath,
    'descriptor destination',
  );
  const expectedSource = path.join(
    root,
    'service',
    service.kind === 'systemd' ? 'qinglong3.service' : 'qinglong3.openrc',
  );
  const expectedDestination =
    service.kind === 'systemd'
      ? '/etc/systemd/system/qinglong3.service'
      : '/etc/init.d/qinglong3';
  const expectedSourceMode = service.kind === 'systemd' ? 0o600 : 0o700;
  const expectedDestinationMode = service.kind === 'systemd' ? 0o644 : 0o755;
  const lineage = normalizedLineage(intent.lineage);
  if (
    intent.schemaVersion !== 1 ||
    intent.kind !== 'qinglong3-local-service-manager-intent' ||
    typeof intent.actionId !== 'string' ||
    !UUID_V4_PATTERN.test(intent.actionId) ||
    (intent.action !== 'install-enable-start' &&
      intent.action !== 'start' &&
      intent.action !== 'restart' &&
      intent.action !== 'stop') ||
    (intent.profile !== 'edge' && intent.profile !== 'standalone') ||
    typeof intent.instanceId !== 'string' ||
    !INSTANCE_ID_PATTERN.test(intent.instanceId) ||
    applicationConfigPath !== path.join(root, 'local-application.json') ||
    typeof deployment.applicationConfigSha256 !== 'string' ||
    !DIGEST_PATTERN.test(deployment.applicationConfigSha256) ||
    sourcePath !== expectedSource ||
    destinationPath !== expectedDestination ||
    descriptor.sourceMode !== expectedSourceMode ||
    descriptor.destinationMode !== expectedDestinationMode ||
    typeof descriptor.sha256 !== 'string' ||
    !DIGEST_PATTERN.test(descriptor.sha256) ||
    typeof intent.outcomePath !== 'string' ||
    safeAbsolutePath(intent.outcomePath, 'outcome path') !==
      path.join(
        root,
        'service',
        'service-manager-outcomes',
        `${intent.actionId}.json`,
      ) ||
    !Number.isSafeInteger(intent.requestedAtMs) ||
    (intent.requestedAtMs as number) < 0 ||
    typeof intent.intentDigest !== 'string' ||
    !DIGEST_PATTERN.test(intent.intentDigest)
  ) {
    configurationError('service manager intent binding is invalid');
  }
  if (
    lineage.mode === 'adopted' &&
    ((lineage.generation === 1 &&
      intent.action !== 'install-enable-start' &&
      intent.action !== 'start' &&
      intent.action !== 'stop') ||
      (lineage.generation >= 2 &&
        intent.action !== 'restart' &&
        intent.action !== 'stop'))
  ) {
    configurationError(
      'service manager action does not match the adopted generation',
    );
  }
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'qinglong3-local-service-manager-intent' as const,
    actionId: intent.actionId,
    action: intent.action,
    profile: intent.profile,
    instanceId: intent.instanceId,
    service: Object.freeze({
      kind: service.kind,
      name: 'qinglong3' as const,
      uid,
      gid,
      allowRootService: service.allowRootService,
    }),
    deployment: Object.freeze({
      root,
      applicationConfigPath,
      applicationConfigSha256: deployment.applicationConfigSha256,
    }),
    descriptor: Object.freeze({
      sourcePath,
      destinationPath,
      sha256: descriptor.sha256,
      sourceMode: expectedSourceMode,
      destinationMode: expectedDestinationMode,
    }),
    lineage,
    outcomePath: intent.outcomePath,
    requestedAtMs: intent.requestedAtMs as number,
  });
  if (localServiceManagerIntentDigest(payload) !== intent.intentDigest) {
    configurationError('service manager intent digest is invalid');
  }
  return Object.freeze({ ...payload, intentDigest: intent.intentDigest });
}

function normalizedManager(value: unknown): LocalServiceBridgeManager {
  const manager = object(value, 'manager');
  if (manager.kind === 'systemd') {
    exact(manager, ['executable', 'kind'], 'manager');
    return Object.freeze({
      kind: 'systemd' as const,
      executable: safeAbsolutePath(manager.executable, 'systemd executable'),
    });
  }
  exact(manager, ['kind', 'serviceExecutable', 'updateExecutable'], 'manager');
  if (manager.kind !== 'openrc') configurationError('manager kind is invalid');
  return Object.freeze({
    kind: 'openrc' as const,
    serviceExecutable: safeAbsolutePath(
      manager.serviceExecutable,
      'OpenRC service executable',
    ),
    updateExecutable: safeAbsolutePath(
      manager.updateExecutable,
      'OpenRC update executable',
    ),
  });
}

export function normalizeLocalServiceBridgeCommand(
  value: unknown,
): Readonly<LocalServiceBridgeCommand> {
  const command = object(value, 'service bridge command');
  exact(
    command,
    ['operation', 'options', 'request', 'schemaVersion'],
    'command',
  );
  const options = object(command.options, 'options');
  exact(
    options,
    ['allowRootController', 'controllerRoot', 'manager'],
    'options',
  );
  const request = object(command.request, 'request');
  exact(request, ['expectedIntentDigest', 'intentPath'], 'request');
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.deployment.service-manager.execute' ||
    options.allowRootController !== true ||
    typeof request.expectedIntentDigest !== 'string' ||
    !DIGEST_PATTERN.test(request.expectedIntentDigest)
  ) {
    configurationError('service bridge command binding is invalid');
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.deployment.service-manager.execute' as const,
    options: Object.freeze({
      controllerRoot: safeAbsolutePath(
        options.controllerRoot,
        'controller root',
      ),
      allowRootController: true as const,
      manager: normalizedManager(options.manager),
    }),
    request: Object.freeze({
      intentPath: safeAbsolutePath(request.intentPath, 'intent path'),
      expectedIntentDigest: request.expectedIntentDigest,
    }),
  });
}
