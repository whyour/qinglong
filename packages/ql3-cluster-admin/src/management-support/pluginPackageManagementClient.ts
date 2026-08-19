/** Shared one-shot authenticated client boundary for cluster management planes. */
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import { TextDecoder } from 'node:util';
import { parseSecretRef } from '@qinglong/runtime-core/secret-reference';
import {
  ClusterPluginPackageManagementClientConfigurationError,
  isReviewedClusterAuthenticatedManagementClientProtocol,
  prepareClusterAuthenticatedManagementClientConfiguration,
  readCanonicalFile,
  validateClusterAuthenticatedManagementClientConfiguration,
  type ClusterAuthenticatedManagementClientConfigurationSummary,
  type ClusterAuthenticatedManagementClientKind,
  type PreparedClusterAuthenticatedManagementClientConfiguration,
} from './managementClientConfiguration';

export {
  ClusterPluginPackageManagementClientConfigurationError,
  readCanonicalFile,
  validateClusterAuthenticatedManagementClientConfiguration,
};
export type {
  ClusterAuthenticatedManagementClientConfigurationSummary,
  ClusterAuthenticatedManagementClientKind,
};

import {
  normalizeClusterPluginPackageManagementCommand,
  type ClusterPluginPackageManagementCommand,
  type ClusterPluginPackageManagementTransportResult,
} from '../plugin-package/management/pluginPackageManagementTransport';

const MANAGEMENT_PATH = '/api/v3/plugin-packages/management';
const MAX_ASSERTION_BYTES = 16 * 1024;
const MAX_COMMAND_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ASSERTION_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

type JsonObject = Record<string, unknown>;

export interface ClusterPluginPackageManagementClientPaths {
  readonly configFile: string;
  readonly commandFile: string;
  readonly assertionFile: string;
}

export interface ClusterAuthenticatedManagementCommandExecution<Command> {
  readonly configFile: string;
  readonly assertionFile: string;
  readonly command: Command;
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
const SECRET_BINDING_PLAN_KEYS = Object.freeze([
  'actionRef',
  'projectId',
  'packageName',
  'installationId',
  'generation',
  'generationDigest',
  'lockDigest',
  'manifestDigest',
  'entries',
  'plannedAtMs',
  'expiresAtMs',
  'planDigest',
  'approvalPlanDigest',
]);
const SECRET_BINDING_TRANSITION_PLAN_KEYS = Object.freeze([
  'actionRef',
  'approvalPlanDigest',
  'plannedAtMs',
  'expiresAtMs',
  'kind',
  'transitionDigest',
  'projectId',
  'packageName',
  'previousInstallationId',
  'previousGeneration',
  'previousGenerationDigest',
  'previousActiveLockDigest',
  'previousAttemptGeneration',
  'nextInstallationId',
  'nextGeneration',
  'nextGenerationDigest',
  'nextLockDigest',
  'nextManifestDigest',
  'changes',
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

function validateSecretBindingPlanSummary(
  value: unknown,
  command: Readonly<
    Extract<
      ClusterPluginPackageManagementCommand,
      { readonly operation: `plugin-package.secret-binding.${string}` }
    >
  >,
): void {
  const summary = exactResponseObject(value, SECRET_BINDING_PLAN_KEYS);
  if (
    typeof summary.actionRef !== 'string' ||
    summary.actionRef.length < 1 ||
    summary.actionRef.length > 255 ||
    typeof summary.projectId !== 'string' ||
    summary.projectId.length < 1 ||
    summary.projectId.length > 128 ||
    typeof summary.packageName !== 'string' ||
    !PACKAGE_NAME_PATTERN.test(summary.packageName) ||
    typeof summary.installationId !== 'string' ||
    summary.installationId.length < 1 ||
    summary.installationId.length > 128 ||
    !Number.isSafeInteger(summary.generation) ||
    (summary.generation as number) < 1 ||
    !Number.isSafeInteger(summary.plannedAtMs) ||
    !Number.isSafeInteger(summary.expiresAtMs) ||
    (summary.expiresAtMs as number) <= (summary.plannedAtMs as number) ||
    !Array.isArray(summary.entries) ||
    summary.entries.length > 64 ||
    new Set(
      summary.entries.map((entry) =>
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as JsonObject).name
          : undefined,
      ),
    ).size !== summary.entries.length
  ) {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
  for (const key of [
    'generationDigest',
    'lockDigest',
    'manifestDigest',
    'planDigest',
    'approvalPlanDigest',
  ]) {
    if (
      typeof summary[key] !== 'string' ||
      !DIGEST_PATTERN.test(summary[key] as string)
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
  }
  for (const entryValue of summary.entries) {
    const entry = exactResponseObject(entryValue, [
      'name',
      'required',
      'secretRef',
    ]);
    if (
      typeof entry.name !== 'string' ||
      !/^[A-Z_][A-Z0-9_]{0,127}$/.test(entry.name) ||
      typeof entry.required !== 'boolean' ||
      (entry.secretRef !== null &&
        (typeof entry.secretRef !== 'string' ||
          entry.secretRef.length > 2_048 ||
          CONTROL_PATTERN.test(entry.secretRef))) ||
      (entry.required === true && entry.secretRef === null)
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
    if (entry.secretRef !== null) {
      try {
        const reference = parseSecretRef(entry.secretRef);
        if (
          reference.projectId !== summary.projectId ||
          typeof reference.version !== 'number' ||
          !Number.isSafeInteger(reference.version) ||
          reference.version < 1
        ) {
          throw new ClusterPluginPackageManagementClientRequestError();
        }
      } catch (error) {
        if (error instanceof ClusterPluginPackageManagementClientRequestError) {
          throw error;
        }
        throw new ClusterPluginPackageManagementClientRequestError();
      }
    }
  }
  if (
    summary.actionRef !== command.request.actionRef ||
    command.operation === 'plugin-package.secret-binding.plan' &&
    (summary.projectId !== command.request.projectId ||
      summary.packageName !== command.request.packageName ||
      summary.entries.length !== command.request.assignments.length ||
      command.request.assignments.some((assignment) => {
        const responseEntry = (summary.entries as JsonObject[]).find(
          (entry) => entry.name === assignment.name,
        );
        return !responseEntry || responseEntry.secretRef !== assignment.secretRef;
      }))
  ) {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
}

function validateSecretBindingTransitionPlanSummary(
  value: unknown,
  command: Readonly<ClusterPluginPackageManagementCommand>,
): void {
  const summary = exactResponseObject(
    value,
    SECRET_BINDING_TRANSITION_PLAN_KEYS,
  );
  const transitionRequest = command.request as { readonly actionRef: string };
  if (
    typeof summary.actionRef !== 'string' ||
    summary.actionRef !== transitionRequest.actionRef ||
    typeof summary.projectId !== 'string' ||
    typeof summary.packageName !== 'string' ||
    !PACKAGE_NAME_PATTERN.test(summary.packageName) ||
    typeof summary.previousInstallationId !== 'string' ||
    typeof summary.nextInstallationId !== 'string' ||
    !['carry-forward', 'rotate', 'rebind', 'revoke'].includes(
      String(summary.kind),
    ) ||
    !Number.isSafeInteger(summary.plannedAtMs) ||
    !Number.isSafeInteger(summary.expiresAtMs) ||
    (summary.expiresAtMs as number) <= (summary.plannedAtMs as number) ||
    !Number.isSafeInteger(summary.previousGeneration) ||
    !Number.isSafeInteger(summary.previousAttemptGeneration) ||
    !Number.isSafeInteger(summary.nextGeneration) ||
    (summary.previousGeneration as number) < 1 ||
    (summary.previousAttemptGeneration as number) <
      (summary.previousGeneration as number) ||
    (summary.nextGeneration as number) !==
      (summary.previousAttemptGeneration as number) + 1 ||
    !Array.isArray(summary.changes) ||
    summary.changes.length < 1 ||
    summary.changes.length > 64
  ) {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
  for (const key of [
    'approvalPlanDigest',
    'transitionDigest',
    'previousGenerationDigest',
    'previousActiveLockDigest',
    'nextGenerationDigest',
    'nextLockDigest',
    'nextManifestDigest',
  ]) {
    if (
      typeof summary[key] !== 'string' ||
      !DIGEST_PATTERN.test(summary[key] as string)
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
  }
  const nextEntries = new Map<string, string | null>();
  const changedNames = new Set<string>();
  for (const changeValue of summary.changes) {
    const change = exactResponseObject(changeValue, [
      'name',
      'requirement',
      'reference',
      'previous',
      'next',
    ]);
    if (
      typeof change.name !== 'string' ||
      !/^[A-Z_][A-Z0-9_]{0,127}$/.test(change.name) ||
      changedNames.has(change.name) ||
      !['added', 'removed', 'tightened', 'relaxed', 'unchanged'].includes(
        String(change.requirement),
      ) ||
      !['bound', 'revoked', 'rotated', 'rebound', 'unchanged'].includes(
        String(change.reference),
      )
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
    changedNames.add(change.name as string);
    for (const stateValue of [change.previous, change.next]) {
      if (stateValue === null) continue;
      const state = exactResponseObject(stateValue, ['required', 'secretRef']);
      if (
        typeof state.required !== 'boolean' ||
        (state.secretRef !== null && typeof state.secretRef !== 'string') ||
        (state.required && state.secretRef === null)
      ) {
        throw new ClusterPluginPackageManagementClientRequestError();
      }
      if (state.secretRef !== null) {
        try {
          const reference = parseSecretRef(state.secretRef as string);
          if (reference.projectId !== summary.projectId) {
            throw new ClusterPluginPackageManagementClientRequestError();
          }
        } catch (error) {
          if (error instanceof ClusterPluginPackageManagementClientRequestError) {
            throw error;
          }
          throw new ClusterPluginPackageManagementClientRequestError();
        }
      }
    }
    if (change.next !== null) {
      nextEntries.set(
        change.name as string,
        (change.next as JsonObject).secretRef as string | null,
      );
    }
  }
  if (
    command.operation === 'plugin-package.secret-binding.transition.plan' &&
    (summary.projectId !== command.request.projectId ||
      summary.packageName !== command.request.packageName ||
      nextEntries.size !== command.request.assignments.length ||
      command.request.assignments.some(
        (assignment) =>
          nextEntries.get(assignment.name) !== assignment.secretRef,
      ))
  ) {
    throw new ClusterPluginPackageManagementClientRequestError();
  }
}

function validateResult(
  value: unknown,
  command: Readonly<ClusterPluginPackageManagementCommand>,
): Readonly<ClusterPluginPackageManagementTransportResult> {
  if (command.operation === 'plugin-package.secret-binding.transition.plan') {
    const result = exactResponseObject(value, [
      'schemaVersion',
      'operation',
      'status',
      'plan',
    ]);
    if (
      result.schemaVersion !== 1 ||
      result.operation !== command.operation ||
      !['created', 'existing'].includes(String(result.status))
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
    validateSecretBindingTransitionPlanSummary(result.plan, command);
    return Object.freeze(
      result as unknown as ClusterPluginPackageManagementTransportResult,
    );
  }
  if (command.operation === 'plugin-package.secret-binding.transition.propose') {
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
    validateSecretBindingTransitionPlanSummary(result.plan, command);
    validateScalarSummary(result.approval, APPROVAL_KEYS);
    const plan = result.plan as JsonObject;
    const approval = result.approval as JsonObject;
    if (
      approval.id !== command.request.approvalRequestId ||
      approval.projectId !== plan.projectId ||
      approval.actionDigest !== plan.approvalPlanDigest ||
      approval.previewDigest !== plan.transitionDigest
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
    return Object.freeze(
      result as unknown as ClusterPluginPackageManagementTransportResult,
    );
  }
  if (command.operation === 'plugin-package.secret-binding.transition.inspect') {
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
      typeof result.stale !== 'boolean' ||
      (result.plan === null && result.approval === null)
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
    if (result.plan !== null) {
      validateSecretBindingTransitionPlanSummary(result.plan, command);
    }
    if (result.approval !== null) {
      validateScalarSummary(result.approval, APPROVAL_KEYS);
      if (
        (result.approval as JsonObject).id !== command.request.approvalRequestId
      ) {
        throw new ClusterPluginPackageManagementClientRequestError();
      }
    }
    if (result.plan !== null && result.approval !== null) {
      const plan = result.plan as JsonObject;
      const approval = result.approval as JsonObject;
      if (
        approval.projectId !== plan.projectId ||
        approval.actionDigest !== plan.approvalPlanDigest ||
        approval.previewDigest !== plan.transitionDigest
      ) {
        throw new ClusterPluginPackageManagementClientRequestError();
      }
    }
    return Object.freeze(
      result as unknown as ClusterPluginPackageManagementTransportResult,
    );
  }
  if (command.operation === 'plugin-package.secret-binding.plan') {
    const result = exactResponseObject(value, [
      'schemaVersion',
      'operation',
      'status',
      'plan',
    ]);
    if (
      result.schemaVersion !== 1 ||
      result.operation !== command.operation ||
      !['created', 'existing'].includes(String(result.status))
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
    validateSecretBindingPlanSummary(result.plan, command);
    return Object.freeze(
      result as unknown as ClusterPluginPackageManagementTransportResult,
    );
  }
  if (command.operation === 'plugin-package.secret-binding.propose') {
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
    validateSecretBindingPlanSummary(result.plan, command);
    validateScalarSummary(result.approval, APPROVAL_KEYS);
    const plan = result.plan as JsonObject;
    const approval = result.approval as JsonObject;
    if (
      approval.id !== command.request.approvalRequestId ||
      approval.projectId !== plan.projectId ||
      approval.actionDigest !== plan.approvalPlanDigest ||
      approval.previewDigest !== plan.planDigest
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
    return Object.freeze(
      result as unknown as ClusterPluginPackageManagementTransportResult,
    );
  }
  if (command.operation === 'plugin-package.secret-binding.inspect') {
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
      typeof result.stale !== 'boolean' ||
      result.plan === null && result.approval === null
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
    if (result.plan !== null) {
      validateSecretBindingPlanSummary(result.plan, command);
    }
    if (result.approval !== null) {
      validateScalarSummary(result.approval, APPROVAL_KEYS);
      if (
        (result.approval as JsonObject).id !==
        command.request.approvalRequestId
      ) {
        throw new ClusterPluginPackageManagementClientRequestError();
      }
    }
    if (result.plan !== null && result.approval !== null) {
      const plan = result.plan as JsonObject;
      const approval = result.approval as JsonObject;
      if (
        approval.id !== command.request.approvalRequestId ||
        approval.projectId !== plan.projectId ||
        approval.actionDigest !== plan.approvalPlanDigest ||
        approval.previewDigest !== plan.planDigest
      ) {
        throw new ClusterPluginPackageManagementClientRequestError();
      }
    }
    return Object.freeze(
      result as unknown as ClusterPluginPackageManagementTransportResult,
    );
  }
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
    if (
      (command.operation === 'plugin-package.secret-binding.decide' ||
        command.operation ===
          'plugin-package.secret-binding.transition.decide') &&
      (result.approval as JsonObject).id !== command.request.approvalRequestId
    ) {
      throw new ClusterPluginPackageManagementClientRequestError();
    }
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

export async function executeClusterAuthenticatedManagementClient<
  Command,
  Result,
>(
  execution:
    | ClusterPluginPackageManagementClientPaths
    | ClusterAuthenticatedManagementCommandExecution<Command>,
  protocol: ClusterAuthenticatedManagementClientProtocol<Command, Result>,
  connectionOptions?: ClusterPluginPackageManagementClientConnectionOptions,
): Promise<Readonly<ClusterAuthenticatedManagementClientResult<Result>>> {
  const inlineCommand =
    execution !== null &&
    typeof execution === 'object' &&
    !Array.isArray(execution) &&
    Object.hasOwn(execution, 'command');
  exactObject(
    execution,
    inlineCommand
      ? ['configFile', 'command', 'assertionFile']
      : ['configFile', 'commandFile', 'assertionFile'],
  );
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
    !isReviewedClusterAuthenticatedManagementClientProtocol(
      protocol.managementPath,
      protocol.clientCertificate,
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
      execution.configFile,
      protocol.managementPath,
      protocol.clientCertificate,
    );
    if (!inlineCommand) {
      commandBytes = readCanonicalFile(
        (execution as ClusterPluginPackageManagementClientPaths).commandFile,
        MAX_COMMAND_BYTES,
        'private',
      );
    }
    assertionBytes = readCanonicalFile(
      execution.assertionFile,
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
    const command = protocol.normalizeCommand(
      inlineCommand
        ? (execution as ClusterAuthenticatedManagementCommandExecution<Command>)
            .command
        : parseJson(commandBytes!),
    );
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
