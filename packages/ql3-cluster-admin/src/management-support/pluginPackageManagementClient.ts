/** Shared one-shot authenticated client boundary for cluster management planes. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import { TextDecoder } from 'node:util';
import { createPrivateKey, X509Certificate } from 'node:crypto';

import {
  normalizeClusterPluginPackageManagementCommand,
  type ClusterPluginPackageManagementCommand,
  type ClusterPluginPackageManagementTransportResult,
} from '../plugin-package/management/pluginPackageManagementTransport';

const MANAGEMENT_PATH = '/api/v3/plugin-packages/management';
export type ClusterAuthenticatedManagementClientKind =
  | 'package'
  | 'worker-credential'
  | 'automation'
  | 'approval'
  | 'model-credential'
  | 'run';

const MANAGEMENT_CLIENT_POLICIES: Readonly<
  Record<
    ClusterAuthenticatedManagementClientKind,
    Readonly<{
      managementPath: string;
      clientCertificate: 'forbidden' | 'required';
    }>
  >
> = Object.freeze({
  package: Object.freeze({
    managementPath: MANAGEMENT_PATH,
    clientCertificate: 'forbidden',
  }),
  'worker-credential': Object.freeze({
    managementPath: '/api/v3/worker-credentials/management',
    clientCertificate: 'required',
  }),
  automation: Object.freeze({
    managementPath: '/api/v3/automations/management',
    clientCertificate: 'required',
  }),
  approval: Object.freeze({
    managementPath: '/api/v3/approvals/management',
    clientCertificate: 'required',
  }),
  'model-credential': Object.freeze({
    managementPath: '/api/v3/provider-credentials/management',
    clientCertificate: 'required',
  }),
  run: Object.freeze({
    managementPath: '/api/v3/runs/management',
    clientCertificate: 'required',
  }),
});
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_ASSERTION_BYTES = 16 * 1024;
const MAX_COMMAND_BYTES = 256 * 1024;
const MAX_CA_BYTES = 256 * 1024;
const MAX_CLIENT_CERTIFICATE_BYTES = 256 * 1024;
const MAX_CLIENT_PRIVATE_KEY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_NAME_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const ASSERTION_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

type JsonObject = Record<string, unknown>;

export interface ClusterPluginPackageManagementClientPaths {
  readonly configFile: string;
  readonly commandFile: string;
  readonly assertionFile: string;
}

export interface ClusterPluginPackageManagementClientResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly result: Readonly<ClusterPluginPackageManagementTransportResult>;
}

export interface ClusterAuthenticatedManagementClientResult<Result> {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly result: Readonly<Result>;
}

export interface ClusterAuthenticatedManagementClientProtocol<Command, Result> {
  readonly managementPath: string;
  readonly clientCertificate: 'forbidden' | 'required';
  normalizeCommand(value: unknown): Readonly<Command>;
  validateResult(value: unknown, command: Readonly<Command>): Readonly<Result>;
}

export interface ClusterPluginPackageManagementClientConnectionTarget {
  readonly hostname: string;
  readonly port: number;
}

export interface ClusterPluginPackageManagementClientRawConnection {
  readonly stream: Duplex;
  close(): void | Promise<void>;
}

export interface ClusterPluginPackageManagementClientConnectionOptions {
  connect(
    target: Readonly<ClusterPluginPackageManagementClientConnectionTarget>,
  ): Promise<ClusterPluginPackageManagementClientRawConnection>;
}

export class ClusterPluginPackageManagementClientConfigurationError extends TypeError {
  readonly code = 'QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_CONFIG_INVALID';

  constructor() {
    super('Plugin Package management client configuration is invalid');
    this.name = 'ClusterPluginPackageManagementClientConfigurationError';
  }
}

export class ClusterPluginPackageManagementClientRequestError extends Error {
  readonly code = 'QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_REQUEST_FAILED';

  constructor(readonly cause?: unknown) {
    super('Plugin Package management client request failed');
    this.name = 'ClusterPluginPackageManagementClientRequestError';
  }
}

export class ClusterPluginPackageManagementClientRemoteError extends Error {
  readonly code = 'QL3_PLUGIN_PACKAGE_MANAGEMENT_CLIENT_REMOTE_REJECTED';

  constructor(
    readonly statusCode: number,
    readonly responseCode: string,
    readonly requestId: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super('Plugin Package management server rejected the request');
    this.name = 'ClusterPluginPackageManagementClientRemoteError';
  }
}

function configurationFailure(): ClusterPluginPackageManagementClientConfigurationError {
  return new ClusterPluginPackageManagementClientConfigurationError();
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configurationFailure();
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw configurationFailure();
  }
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') throw configurationFailure();
  const uid = process.getuid();
  if (!Number.isSafeInteger(uid) || uid < 0) throw configurationFailure();
  return uid;
}

export function readCanonicalFile(
  filePath: string,
  maximumBytes: number,
  mode: 'private' | 'public-integrity',
): Buffer {
  if (
    typeof filePath !== 'string' ||
    !isAbsolute(filePath) ||
    filePath.length > 4_096 ||
    CONTROL_PATTERN.test(filePath)
  ) {
    throw configurationFailure();
  }
  let before;
  try {
    before = lstatSync(filePath);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size < 1 ||
      before.size > maximumBytes ||
      realpathSync(filePath) !== filePath
    ) {
      throw configurationFailure();
    }
  } catch (error) {
    if (
      error instanceof ClusterPluginPackageManagementClientConfigurationError
    ) {
      throw error;
    }
    throw configurationFailure();
  }
  const uid = currentUid();
  const permissions = before.mode & 0o777;
  if (
    (mode === 'private' && (before.uid !== uid || permissions !== 0o600)) ||
    (mode === 'public-integrity' && before.uid !== uid && before.uid !== 0) ||
    (mode === 'public-integrity' && (permissions & 0o022) !== 0)
  ) {
    throw configurationFailure();
  }

  let descriptor = -1;
  let bytes: Buffer | undefined;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY |
        ((constants as unknown as Readonly<Record<string, number>>).O_CLOEXEC ??
          0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.uid !== before.uid ||
      opened.mode !== before.mode ||
      opened.size !== before.size
    ) {
      throw configurationFailure();
    }
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count < 1) throw configurationFailure();
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.uid !== opened.uid ||
      after.mode !== opened.mode ||
      after.size !== opened.size
    ) {
      throw configurationFailure();
    }
    return bytes;
  } catch (error) {
    bytes?.fill(0);
    if (
      error instanceof ClusterPluginPackageManagementClientConfigurationError
    ) {
      throw error;
    }
    throw configurationFailure();
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw configurationFailure();
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (
      error instanceof ClusterPluginPackageManagementClientConfigurationError
    ) {
      throw error;
    }
    throw configurationFailure();
  }
}

function boundedString(value: unknown, maximum = 1_024): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    CONTROL_PATTERN.test(value)
  ) {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
  return value;
}

function exactResponseObject(
  value: unknown,
  expectedKeys: readonly string[],
): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
  return value as JsonObject;
}

const APPROVAL_KEYS = Object.freeze([
  'id',
  'projectId',
  'version',
  'state',
  'risk',
  'decisionMode',
  'requestedAtMs',
  'expiresAtMs',
  'decision',
  'decisionReasonCode',
  'decidedAtMs',
  'dispatchId',
  'consumedAtMs',
  'actionDigest',
  'previewDigest',
]);
const INSTALL_PROPOSAL_KEYS = Object.freeze([
  'actionRef',
  'projectId',
  'packageName',
  'packageVersion',
  'operation',
  'sourceKind',
  'architecture',
  'deploymentProfile',
  'targetGeneration',
  'actionDigest',
  'previewDigest',
  'proposalDigest',
  'createdAtMs',
]);
const INSTALLATION_SUMMARY_KEYS = Object.freeze([
  'installationId',
  'projectId',
  'packageName',
  'packageVersion',
  'operation',
  'state',
  'targetGeneration',
  'activeLockDigest',
  'previousActiveLockDigest',
  'recoveryAction',
  'availability',
  'quarantineReason',
  'quarantineAuthorizationMode',
  'quarantineEventDigest',
  'quarantinedAtMs',
  'withdrawalStatus',
  'withdrawalReceiptDigest',
  'withdrawalCommittedAtMs',
  'failureReason',
  'failedFrom',
  'failedAtMs',
  'version',
  'createdAtMs',
  'updatedAtMs',
  'recordDigest',
]);
const REVOCATION_PROPOSAL_KEYS = Object.freeze([
  'actionRef',
  'projectId',
  'trustAuthorityId',
  'trustGeneration',
  'publisher',
  'keyId',
  'previousTrustDigest',
  'currentTrustDigest',
  'authorizationMode',
  'reasonCode',
  'actionDigest',
  'previewDigest',
  'proposalDigest',
  'createdAtMs',
]);
const TRANSITION_PROPOSAL_KEYS = Object.freeze([
  'actionRef',
  'projectId',
  'trustAuthorityId',
  'trustGeneration',
  'mode',
  'publisher',
  'keyId',
  'previousTrustDigest',
  'currentTrustDigest',
  'actionDigest',
  'previewDigest',
  'proposalDigest',
  'createdAtMs',
]);
const LIFECYCLE_PLAN_KEYS = Object.freeze([
  'actionRef',
  'planDigest',
  'plannedAtMs',
  'expiresAtMs',
  'action',
  'projectId',
  'packageName',
  'installationId',
  'lockDigest',
  'installVersion',
  'installRecordDigest',
  'expected',
  'generationDigest',
  'materializedRevisionDigest',
  'currentToolSnapshotDigest',
  'taskIds',
  'resourceCounts',
  'referenceGraphDigest',
  'blockingReferences',
  'impactDigest',
]);

function validateScalarSummary(value: unknown, keys: readonly string[]): void {
  const record = exactResponseObject(value, keys);
  for (const entry of Object.values(record)) {
    if (
      entry !== null &&
      !(
        typeof entry === 'string' &&
        entry.length <= 2_048 &&
        !CONTROL_PATTERN.test(entry)
      ) &&
      !(typeof entry === 'number' && Number.isSafeInteger(entry))
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
  }
}

function validateInstallationSummary(
  value: unknown,
  projectId: string,
  packageName?: string,
): JsonObject {
  validateScalarSummary(value, INSTALLATION_SUMMARY_KEYS);
  const summary = value as JsonObject;
  if (
    summary.projectId !== projectId ||
    typeof summary.packageName !== 'string' ||
    !PACKAGE_NAME_PATTERN.test(summary.packageName) ||
    (packageName !== undefined && summary.packageName !== packageName) ||
    !['queued', 'staged', 'activating', 'active', 'failed'].includes(
      String(summary.state),
    ) ||
    !['active', 'not_active', 'quarantined'].includes(
      String(summary.availability),
    )
  ) {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
  const quarantineValues = [
    summary.quarantineReason,
    summary.quarantineAuthorizationMode,
    summary.quarantineEventDigest,
    summary.quarantinedAtMs,
    summary.withdrawalStatus,
    summary.withdrawalReceiptDigest,
    summary.withdrawalCommittedAtMs,
  ];
  if (
    summary.availability === 'quarantined'
      ? quarantineValues.some((entry) => entry === null)
      : quarantineValues.some((entry) => entry !== null) ||
        summary.availability !==
          (summary.state === 'active' ? 'active' : 'not_active')
  ) {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
  const failureValues = [
    summary.failureReason,
    summary.failedFrom,
    summary.failedAtMs,
  ];
  if (
    summary.state === 'failed'
      ? failureValues.some((entry) => entry === null)
      : failureValues.some((entry) => entry !== null)
  ) {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
  return summary;
}

function validateLifecyclePlanSummary(value: unknown): void {
  const summary = exactResponseObject(value, LIFECYCLE_PLAN_KEYS);
  const expected = exactResponseObject(summary.expected, [
    'version',
    'disposition',
    'eventDigest',
  ]);
  const resourceCounts = exactResponseObject(summary.resourceCounts, [
    'tasks',
    'tools',
    'workflows',
    'prompts',
  ]);
  if (
    typeof summary.actionRef !== 'string' ||
    summary.actionRef.length < 1 ||
    summary.actionRef.length > 255 ||
    !['disable', 'enable', 'uninstall'].includes(String(summary.action)) ||
    typeof summary.projectId !== 'string' ||
    summary.projectId.length < 1 ||
    summary.projectId.length > 128 ||
    typeof summary.packageName !== 'string' ||
    !PACKAGE_NAME_PATTERN.test(summary.packageName) ||
    typeof summary.installationId !== 'string' ||
    summary.installationId.length < 1 ||
    summary.installationId.length > 128 ||
    !Number.isSafeInteger(summary.plannedAtMs) ||
    !Number.isSafeInteger(summary.expiresAtMs) ||
    (summary.expiresAtMs as number) <= (summary.plannedAtMs as number) ||
    !Number.isSafeInteger(summary.installVersion) ||
    !Number.isSafeInteger(expected.version) ||
    !['active', 'disabled', 'uninstalled'].includes(
      String(expected.disposition),
    ) ||
    (expected.eventDigest !== null &&
      (typeof expected.eventDigest !== 'string' ||
        !DIGEST_PATTERN.test(expected.eventDigest))) ||
    Object.values(resourceCounts).some(
      (count) =>
        !Number.isSafeInteger(count) ||
        (count as number) < 0 ||
        (count as number) > 256,
    ) ||
    !Array.isArray(summary.taskIds) ||
    summary.taskIds.length > 128 ||
    summary.taskIds.some(
      (taskId) =>
        typeof taskId !== 'string' ||
        taskId.length < 1 ||
        taskId.length > 128 ||
        CONTROL_PATTERN.test(taskId),
    ) ||
    !Array.isArray(summary.blockingReferences) ||
    summary.blockingReferences.length > 128
  ) {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
  for (const key of [
    'planDigest',
    'lockDigest',
    'installRecordDigest',
    'generationDigest',
    'materializedRevisionDigest',
    'currentToolSnapshotDigest',
    'referenceGraphDigest',
    'impactDigest',
  ]) {
    if (
      typeof summary[key] !== 'string' ||
      !DIGEST_PATTERN.test(summary[key] as string)
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
  }
  for (const reference of summary.blockingReferences) {
    const item = exactResponseObject(reference, [
      'kind',
      'ownerId',
      'referenceDigest',
    ]);
    if (
      ![
        'execution_recovery',
        'prompt',
        'publication_recovery',
        'secret_binding',
        'tool',
        'workflow',
      ].includes(String(item.kind)) ||
      typeof item.ownerId !== 'string' ||
      item.ownerId.length < 1 ||
      item.ownerId.length > 128 ||
      CONTROL_PATTERN.test(item.ownerId) ||
      typeof item.referenceDigest !== 'string' ||
      !DIGEST_PATTERN.test(item.referenceDigest)
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
  }
}

function validateResult(
  value: unknown,
  command: Readonly<ClusterPluginPackageManagementCommand>,
): Readonly<ClusterPluginPackageManagementTransportResult> {
  if (command.operation === 'plugin-package.installation.inspect') {
    const result = exactResponseObject(value, [
      'schemaVersion',
      'operation',
      'installation',
    ]);
    if (result.schemaVersion !== 1 || result.operation !== command.operation) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
    if (result.installation !== null) {
      validateInstallationSummary(
        result.installation,
        command.request.projectId,
        command.request.packageName,
      );
    }
    return Object.freeze(
      result as unknown as ClusterPluginPackageManagementTransportResult,
    );
  }
  if (command.operation === 'plugin-package.installation.list') {
    const result = exactResponseObject(value, [
      'schemaVersion',
      'operation',
      'installations',
      'truncated',
      'next',
    ]);
    if (
      result.schemaVersion !== 1 ||
      result.operation !== command.operation ||
      !Array.isArray(result.installations) ||
      result.installations.length > command.request.limit ||
      typeof result.truncated !== 'boolean'
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
    let previousPackageName = command.request.after?.packageName ?? null;
    for (const installation of result.installations) {
      const summary = validateInstallationSummary(
        installation,
        command.request.projectId,
      );
      if (
        previousPackageName !== null &&
        String(summary.packageName) <= previousPackageName
      ) {
        throw new ClusterPluginPackageManagementClientRequestError();
      }
      previousPackageName = String(summary.packageName);
    }
    if (result.next !== null) {
      const next = exactResponseObject(result.next, ['packageName']);
      if (
        typeof next.packageName !== 'string' ||
        !PACKAGE_NAME_PATTERN.test(next.packageName) ||
        result.truncated !== true ||
        next.packageName !== previousPackageName
      ) {
        throw new ClusterPluginPackageManagementClientRequestError();
      }
    } else if (result.truncated === true) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
    return Object.freeze(
      result as unknown as ClusterPluginPackageManagementTransportResult,
    );
  }
  if (command.operation === 'plugin-package.lifecycle.propose') {
    const result = exactResponseObject(value, [
      'schemaVersion',
      'operation',
      'approvalStatus',
      'plan',
      'approval',
    ]);
    if (
      result.schemaVersion !== 1 ||
      result.operation !== command.operation ||
      !['created', 'existing'].includes(String(result.approvalStatus))
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
    validateLifecyclePlanSummary(result.plan);
    validateScalarSummary(result.approval, APPROVAL_KEYS);
    return Object.freeze(
      result as unknown as ClusterPluginPackageManagementTransportResult,
    );
  }
  if (command.operation === 'plugin-package.lifecycle.inspect') {
    const result = exactResponseObject(value, [
      'schemaVersion',
      'operation',
      'plan',
      'approval',
      'stale',
    ]);
    if (
      result.schemaVersion !== 1 ||
      result.operation !== command.operation ||
      typeof result.stale !== 'boolean'
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
    if (result.plan !== null) validateLifecyclePlanSummary(result.plan);
    if (result.approval !== null) {
      validateScalarSummary(result.approval, APPROVAL_KEYS);
    }
    return Object.freeze(
      result as unknown as ClusterPluginPackageManagementTransportResult,
    );
  }
  const kind = command.operation.endsWith('.propose')
    ? 'propose'
    : command.operation.endsWith('.decide')
    ? 'decide'
    : 'inspect';
  const result = exactResponseObject(
    value,
    kind === 'propose'
      ? [
          'schemaVersion',
          'operation',
          'proposalStatus',
          'approvalStatus',
          'proposal',
          'approval',
        ]
      : kind === 'decide'
      ? ['schemaVersion', 'operation', 'status', 'approval']
      : ['schemaVersion', 'operation', 'proposal', 'approval'],
  );
  if (result.schemaVersion !== 1 || result.operation !== command.operation) {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
  if (kind === 'propose') {
    if (
      !['created', 'existing'].includes(String(result.proposalStatus)) ||
      !['created', 'existing'].includes(String(result.approvalStatus))
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
  } else if (
    kind === 'decide' &&
    !['decided', 'existing'].includes(String(result.status))
  ) {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
  if (result.approval !== null) {
    validateScalarSummary(result.approval, APPROVAL_KEYS);
  } else if (kind !== 'inspect') {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
  if (result.proposal !== null && result.proposal !== undefined) {
    validateScalarSummary(
      result.proposal,
      command.operation.startsWith('plugin-package.publisher-trust-transition.')
        ? TRANSITION_PROPOSAL_KEYS
        : command.operation.startsWith('plugin-package.publisher-revocation.')
        ? REVOCATION_PROPOSAL_KEYS
        : INSTALL_PROPOSAL_KEYS,
    );
  } else if (kind === 'propose') {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
  return Object.freeze(
    result as unknown as ClusterPluginPackageManagementTransportResult,
  );
}

function retryAfterSeconds(
  value: string | string[] | undefined,
): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,3}$/.test(value)) {
    return null;
  }
  const seconds = Number(value);
  return seconds <= 3_600 ? seconds : null;
}

function rawHeaderCount(rawHeaders: readonly string[], name: string): number {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

export interface ClusterAuthenticatedManagementClientConfigurationSummary {
  readonly schemaVersion: 1;
  readonly managementPath: string;
  readonly transport: 'https';
  readonly clientCertificate: 'forbidden' | 'required';
}

interface PreparedClusterAuthenticatedManagementClientConfiguration {
  readonly endpoint: URL;
  readonly servername: string;
  readonly port: number;
  readonly requestTimeoutMs: number;
  readonly caBytes: Buffer;
  readonly clientCertificateBytes?: Buffer;
  readonly clientPrivateKeyBytes?: Buffer;
  dispose(): void;
}

function prepareClusterAuthenticatedManagementClientConfiguration(
  configFile: string,
  managementPath: string,
  clientCertificate: 'forbidden' | 'required',
): PreparedClusterAuthenticatedManagementClientConfiguration {
  if (
    !Object.values(MANAGEMENT_CLIENT_POLICIES).some(
      (policy) =>
        policy.managementPath === managementPath &&
        policy.clientCertificate === clientCertificate,
    )
  ) {
    throw configurationFailure();
  }
  let configBytes: Buffer | undefined;
  let caBytes: Buffer | undefined;
  let clientCertificateBytes: Buffer | undefined;
  let clientPrivateKeyBytes: Buffer | undefined;
  try {
    configBytes = readCanonicalFile(configFile, MAX_CONFIG_BYTES, 'private');
    const config = parseJson(configBytes);
    exactObject(
      config,
      clientCertificate === 'required'
        ? [
            'schemaVersion',
            'endpoint',
            'servername',
            'caFile',
            'clientCertificateFile',
            'clientPrivateKeyFile',
            'requestTimeoutMs',
          ]
        : [
            'schemaVersion',
            'endpoint',
            'servername',
            'caFile',
            'requestTimeoutMs',
          ],
    );
    if (
      config.schemaVersion !== 1 ||
      typeof config.endpoint !== 'string' ||
      typeof config.servername !== 'string' ||
      !DNS_NAME_PATTERN.test(config.servername) ||
      isIP(config.servername) !== 0 ||
      typeof config.caFile !== 'string' ||
      (clientCertificate === 'required' &&
        (typeof config.clientCertificateFile !== 'string' ||
          typeof config.clientPrivateKeyFile !== 'string')) ||
      !Number.isSafeInteger(config.requestTimeoutMs) ||
      (config.requestTimeoutMs as number) < 1_000 ||
      (config.requestTimeoutMs as number) > 30_000
    ) {
      throw configurationFailure();
    }
    const servername = config.servername;
    const requestTimeoutMs = config.requestTimeoutMs as number;
    let endpoint: URL;
    try {
      endpoint = new URL(config.endpoint);
    } catch {
      throw configurationFailure();
    }
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username !== '' ||
      endpoint.password !== '' ||
      endpoint.search !== '' ||
      endpoint.hash !== '' ||
      endpoint.pathname !== managementPath ||
      endpoint.hostname !== servername ||
      isIP(endpoint.hostname) !== 0
    ) {
      throw configurationFailure();
    }
    const port = endpoint.port === '' ? 443 : Number(endpoint.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw configurationFailure();
    }
    caBytes = readCanonicalFile(
      config.caFile as string,
      MAX_CA_BYTES,
      'public-integrity',
    );
    try {
      new X509Certificate(caBytes);
    } catch {
      throw configurationFailure();
    }
    if (clientCertificate === 'required') {
      clientCertificateBytes = readCanonicalFile(
        config.clientCertificateFile as string,
        MAX_CLIENT_CERTIFICATE_BYTES,
        'public-integrity',
      );
      clientPrivateKeyBytes = readCanonicalFile(
        config.clientPrivateKeyFile as string,
        MAX_CLIENT_PRIVATE_KEY_BYTES,
        'private',
      );
      try {
        const certificate = new X509Certificate(clientCertificateBytes);
        const privateKey = createPrivateKey(clientPrivateKeyBytes);
        if (!certificate.checkPrivateKey(privateKey)) {
          throw configurationFailure();
        }
      } catch (error) {
        if (
          error instanceof
          ClusterPluginPackageManagementClientConfigurationError
        ) {
          throw error;
        }
        throw configurationFailure();
      }
    }
    let disposed = false;
    return Object.freeze({
      endpoint,
      servername,
      port,
      requestTimeoutMs,
      caBytes,
      ...(clientCertificateBytes === undefined
        ? {}
        : {
            clientCertificateBytes,
            clientPrivateKeyBytes: clientPrivateKeyBytes!,
          }),
      dispose() {
        if (disposed) return;
        disposed = true;
        caBytes?.fill(0);
        clientCertificateBytes?.fill(0);
        clientPrivateKeyBytes?.fill(0);
      },
    });
  } catch (error) {
    caBytes?.fill(0);
    clientCertificateBytes?.fill(0);
    clientPrivateKeyBytes?.fill(0);
    if (
      error instanceof ClusterPluginPackageManagementClientConfigurationError
    ) {
      throw error;
    }
    throw configurationFailure();
  } finally {
    configBytes?.fill(0);
  }
}

export function validateClusterAuthenticatedManagementClientConfiguration(
  configFile: string,
  kind: ClusterAuthenticatedManagementClientKind,
): Readonly<ClusterAuthenticatedManagementClientConfigurationSummary> {
  const policy = MANAGEMENT_CLIENT_POLICIES[kind];
  if (policy === undefined) throw configurationFailure();
  const prepared = prepareClusterAuthenticatedManagementClientConfiguration(
    configFile,
    policy.managementPath,
    policy.clientCertificate,
  );
  try {
    return Object.freeze({
      schemaVersion: 1,
      managementPath: policy.managementPath,
      transport: 'https',
      clientCertificate: policy.clientCertificate,
    });
  } finally {
    prepared.dispose();
  }
}

export async function executeClusterAuthenticatedManagementClient<
  Command,
  Result,
>(
  paths: ClusterPluginPackageManagementClientPaths,
  protocol: ClusterAuthenticatedManagementClientProtocol<Command, Result>,
  connectionOptions?: ClusterPluginPackageManagementClientConnectionOptions,
): Promise<Readonly<ClusterAuthenticatedManagementClientResult<Result>>> {
  exactObject(paths, ['configFile', 'commandFile', 'assertionFile']);
  if (
    !protocol ||
    typeof protocol !== 'object' ||
    Array.isArray(protocol) ||
    Object.keys(protocol).length !== 4 ||
    Object.keys(protocol).some(
      (key) =>
        ![
          'managementPath',
          'clientCertificate',
          'normalizeCommand',
          'validateResult',
        ].includes(key),
    ) ||
    !Object.values(MANAGEMENT_CLIENT_POLICIES).some(
      (policy) =>
        policy.managementPath === protocol.managementPath &&
        policy.clientCertificate === protocol.clientCertificate,
    ) ||
    typeof protocol.normalizeCommand !== 'function' ||
    typeof protocol.validateResult !== 'function' ||
    (connectionOptions !== undefined &&
      (!connectionOptions ||
        typeof connectionOptions !== 'object' ||
        Array.isArray(connectionOptions) ||
        Object.keys(connectionOptions).length !== 1 ||
        typeof connectionOptions.connect !== 'function'))
  ) {
    throw configurationFailure();
  }
  let commandBytes: Buffer | undefined;
  let assertionBytes: Buffer | undefined;
  let prepared:
    | PreparedClusterAuthenticatedManagementClientConfiguration
    | undefined;
  try {
    prepared = prepareClusterAuthenticatedManagementClientConfiguration(
      paths.configFile,
      protocol.managementPath,
      protocol.clientCertificate,
    );
    commandBytes = readCanonicalFile(
      paths.commandFile,
      MAX_COMMAND_BYTES,
      'private',
    );
    assertionBytes = readCanonicalFile(
      paths.assertionFile,
      MAX_ASSERTION_BYTES,
      'private',
    );
    const {
      endpoint,
      servername,
      port,
      requestTimeoutMs,
      caBytes,
      clientCertificateBytes,
      clientPrivateKeyBytes,
    } = prepared;
    const command = protocol.normalizeCommand(parseJson(commandBytes));
    const assertion = assertionBytes.toString('ascii');
    if (
      assertionBytes.some((byte) => byte > 0x7f) ||
      !ASSERTION_PATTERN.test(assertion)
    ) {
      throw configurationFailure();
    }
    const body = Buffer.from(JSON.stringify(command));
    if (body.length < 2 || body.length > MAX_COMMAND_BYTES) {
      body.fill(0);
      throw configurationFailure();
    }

    let rawConnection:
      | ClusterPluginPackageManagementClientRawConnection
      | undefined;
    let connectionAgent: HttpsAgent | undefined;
    try {
      if (connectionOptions) {
        rawConnection = await connectionOptions.connect(
          Object.freeze({ hostname: endpoint.hostname, port }),
        );
        if (
          !rawConnection ||
          typeof rawConnection !== 'object' ||
          !(rawConnection.stream instanceof Duplex) ||
          typeof rawConnection.close !== 'function'
        ) {
          throw new ClusterPluginPackageManagementClientRequestError();
        }
      }
      const establishedConnection = rawConnection;
      if (establishedConnection) {
        connectionAgent = new HttpsAgent({
          keepAlive: false,
          maxSockets: 1,
          maxFreeSockets: 0,
        });
        connectionAgent.createConnection = (_options, callback) => {
          const socket = tlsConnect({
            socket: establishedConnection.stream,
            ca: caBytes,
            ...(clientCertificateBytes === undefined
              ? {}
              : {
                  cert: clientCertificateBytes,
                  key: clientPrivateKeyBytes,
                }),
            servername,
            minVersion: 'TLSv1.3',
            maxVersion: 'TLSv1.3',
            rejectUnauthorized: true,
          });
          if (callback) {
            let reported = false;
            socket.once('secureConnect', () => {
              if (reported) return;
              reported = true;
              callback(null, socket);
            });
            socket.once('error', (error) => {
              if (reported) return;
              reported = true;
              callback(error, socket);
            });
          }
          return socket;
        };
      }
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (
          error: unknown,
          result?: Readonly<ClusterAuthenticatedManagementClientResult<Result>>,
        ) => {
          if (settled) return;
          settled = true;
          body.fill(0);
          if (error) reject(error);
          else resolve(result!);
        };
        const request = httpsRequest(
          {
            protocol: 'https:',
            hostname: endpoint.hostname,
            port,
            path: protocol.managementPath,
            method: 'POST',
            servername,
            ca: caBytes,
            ...(clientCertificateBytes === undefined
              ? {}
              : {
                  cert: clientCertificateBytes,
                  key: clientPrivateKeyBytes,
                }),
            minVersion: 'TLSv1.3',
            maxVersion: 'TLSv1.3',
            rejectUnauthorized: true,
            agent: connectionAgent ?? false,
            headers: {
              accept: 'application/json',
              'accept-encoding': 'identity',
              authorization: `Bearer ${assertion}`,
              connection: 'close',
              'content-type': 'application/json',
              'content-length': String(body.length),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let length = 0;
            const clearChunks = () => {
              for (const chunk of chunks) chunk.fill(0);
            };
            response.once('aborted', () => {
              clearChunks();
              finish(new ClusterPluginPackageManagementClientRequestError());
            });
            response.once('error', (error) => {
              clearChunks();
              finish(
                new ClusterPluginPackageManagementClientRequestError(error),
              );
            });
            response.on('data', (chunk: Buffer | string) => {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              length += bytes.length;
              if (length > MAX_RESPONSE_BYTES) {
                const error =
                  new ClusterPluginPackageManagementClientRequestError();
                bytes.fill(0);
                clearChunks();
                response.destroy();
                request.destroy(error);
                finish(error);
                return;
              }
              chunks.push(bytes);
            });
            response.once('end', () => {
              try {
                if (
                  rawHeaderCount(response.rawHeaders, 'content-type') !== 1 ||
                  response.headers['content-type'] !==
                    'application/json; charset=utf-8' ||
                  response.headers['content-encoding'] !== undefined ||
                  rawHeaderCount(response.rawHeaders, 'content-length') > 1 ||
                  (response.headers['content-length'] !== undefined &&
                    (!/^(?:0|[1-9][0-9]*)$/.test(
                      response.headers['content-length'],
                    ) ||
                      Number(response.headers['content-length']) !== length))
                ) {
                  throw new ClusterPluginPackageManagementClientRequestError();
                }
                const bytes = Buffer.concat(chunks, length);
                let envelope: unknown;
                try {
                  envelope = JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
                  );
                } finally {
                  bytes.fill(0);
                  clearChunks();
                }
                const statusCode = response.statusCode ?? 0;
                if (statusCode === 200) {
                  const record = exactResponseObject(envelope, [
                    'schemaVersion',
                    'requestId',
                    'result',
                  ]);
                  const requestId = boundedString(record.requestId, 128);
                  if (record.schemaVersion !== 1) {
                    throw new ClusterPluginPackageManagementClientRequestError();
                  }
                  finish(
                    undefined,
                    Object.freeze({
                      schemaVersion: 1,
                      requestId,
                      result: protocol.validateResult(record.result, command),
                    }),
                  );
                  return;
                }
                const record = exactResponseObject(envelope, [
                  'schemaVersion',
                  'requestId',
                  'error',
                ]);
                const error = exactResponseObject(record.error, ['code']);
                if (
                  record.schemaVersion !== 1 ||
                  statusCode < 400 ||
                  statusCode > 599
                ) {
                  throw new ClusterPluginPackageManagementClientRequestError();
                }
                finish(
                  new ClusterPluginPackageManagementClientRemoteError(
                    statusCode,
                    boundedString(error.code, 128),
                    boundedString(record.requestId, 128),
                    retryAfterSeconds(response.headers['retry-after']),
                  ),
                );
              } catch (error) {
                finish(
                  error instanceof
                    ClusterPluginPackageManagementClientRemoteError ||
                    error instanceof
                      ClusterPluginPackageManagementClientRequestError
                    ? error
                    : new ClusterPluginPackageManagementClientRequestError(
                        error,
                      ),
                );
              }
            });
          },
        );
        request.setTimeout(requestTimeoutMs, () => {
          request.destroy(
            new ClusterPluginPackageManagementClientRequestError(),
          );
        });
        request.once('error', (error) => {
          finish(
            error instanceof ClusterPluginPackageManagementClientRequestError
              ? error
              : new ClusterPluginPackageManagementClientRequestError(error),
          );
        });
        request.end(body);
      });
    } catch (error) {
      if (
        error instanceof ClusterPluginPackageManagementClientRemoteError ||
        error instanceof ClusterPluginPackageManagementClientRequestError
      ) {
        throw error;
      }
      throw new ClusterPluginPackageManagementClientRequestError(error);
    } finally {
      connectionAgent?.destroy();
      try {
        await rawConnection?.close();
      } catch {
        // Resource cleanup cannot replace the already observed command outcome.
      }
    }
  } finally {
    commandBytes?.fill(0);
    assertionBytes?.fill(0);
    prepared?.dispose();
  }
}

const PLUGIN_PACKAGE_MANAGEMENT_CLIENT_PROTOCOL = Object.freeze({
  managementPath: MANAGEMENT_PATH,
  clientCertificate: 'forbidden' as const,
  normalizeCommand: normalizeClusterPluginPackageManagementCommand,
  validateResult,
});

export async function executeClusterPluginPackageManagementClient(
  paths: ClusterPluginPackageManagementClientPaths,
  connectionOptions?: ClusterPluginPackageManagementClientConnectionOptions,
): Promise<Readonly<ClusterPluginPackageManagementClientResult>> {
  return executeClusterAuthenticatedManagementClient(
    paths,
    PLUGIN_PACKAGE_MANAGEMENT_CLIENT_PROTOCOL,
    connectionOptions,
  );
}
