import {
  ClusterPluginPackageManagementClientRequestError,
  executeClusterAuthenticatedManagementClient,
  type ClusterAuthenticatedManagementClientResult,
  type ClusterPluginPackageManagementClientConnectionOptions,
  type ClusterPluginPackageManagementClientPaths,
} from '../management-support/pluginPackageManagementClient';
import {
  normalizeClusterModelProviderCredentialManagementCommand,
  type ClusterModelProviderCredentialManagementCommand,
} from './modelProviderCredentialManagementTransport';
import {
  normalizeModelProviderCredentialTestPlan,
  type ModelProviderCredentialTestPlan,
} from '@qinglong/ai/model-provider-credential-test-connection';

const MANAGEMENT_PATH = '/api/v3/provider-credentials/management';
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ClusterModelProviderCredentialManagementClientPaths =
  ClusterPluginPackageManagementClientPaths;
export type ClusterModelProviderCredentialManagementClientConnectionOptions =
  ClusterPluginPackageManagementClientConnectionOptions;

export type ClusterModelProviderCredentialManagementClientTransportResult =
  | Readonly<{
      schemaVersion: 1;
      operation: 'provider-credential.bind' | 'provider-credential.revoke';
      status: 'created' | 'existing';
      credential: Readonly<{
        projectId: string;
        provider: string;
        generation: number;
        action: 'bind' | 'revoke';
        activeBindingRevision: string | null;
        activeBindingDigest: string | null;
        transitionDigest: string;
        changedAtMs: number;
      }>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'provider-credential.audit.list';
      audit: Readonly<{
        projectId: string;
        records: readonly Readonly<{
          eventId: string;
          requestId: string;
          operation: 'provider-credential.bind' | 'provider-credential.revoke';
          actor: Readonly<{ type: 'user'; id: string }>;
          fence: Readonly<{
            projectVersion: number;
            bindingVersion: number;
          }>;
          occurredAtMs: number;
        }>[];
        nextCursor: Readonly<{
          occurredAtMs: number;
          eventId: string;
        }> | null;
      }>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'provider-credential.test.plan';
      status: 'created' | 'existing';
      plan: Readonly<ModelProviderCredentialTestPlan>;
    }>;

export type ClusterModelProviderCredentialManagementClientResult =
  ClusterAuthenticatedManagementClientResult<ClusterModelProviderCredentialManagementClientTransportResult>;

function invalid(): never {
  throw new ClusterPluginPackageManagementClientRequestError();
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
  return record;
}

function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    CONTROL_PATTERN.test(value)
  ) {
    invalid();
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) invalid();
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) invalid();
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as number;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

export function validateClusterModelProviderCredentialManagementClientResult(
  value: unknown,
  command: Readonly<ClusterModelProviderCredentialManagementCommand>,
): Readonly<ClusterModelProviderCredentialManagementClientTransportResult> {
  if (command.operation === 'provider-credential.test.plan') {
    const envelope = exactRecord(value, [
      'operation',
      'plan',
      'schemaVersion',
      'status',
    ]);
    if (
      envelope.schemaVersion !== 1 ||
      envelope.operation !== command.operation ||
      (envelope.status !== 'created' && envelope.status !== 'existing')
    ) {
      invalid();
    }
    let plan: Readonly<ModelProviderCredentialTestPlan>;
    try {
      plan = normalizeModelProviderCredentialTestPlan(
        envelope.plan as ModelProviderCredentialTestPlan,
      );
    } catch {
      return invalid();
    }
    if (
      plan.testId !== command.request.testId ||
      plan.requestId !== command.request.requestId ||
      plan.projectId !== command.request.projectId ||
      plan.provider !== command.request.provider
    ) {
      invalid();
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      operation: command.operation,
      status: envelope.status,
      plan,
    });
  }
  if (command.operation === 'provider-credential.audit.list') {
    const envelope = exactRecord(value, [
      'schemaVersion',
      'operation',
      'audit',
    ]);
    if (
      envelope.schemaVersion !== 1 ||
      envelope.operation !== command.operation
    ) {
      invalid();
    }
    const audit = exactRecord(envelope.audit, [
      'projectId',
      'records',
      'nextCursor',
    ]);
    if (
      identifier(audit.projectId) !== command.request.projectId ||
      !Array.isArray(audit.records) ||
      audit.records.length > command.request.limit
    ) {
      invalid();
    }
    const records = audit.records.map((value) => {
      const record = exactRecord(value, [
        'actor',
        'eventId',
        'fence',
        'occurredAtMs',
        'operation',
        'requestId',
      ]);
      uuid(record.eventId);
      identifier(record.requestId);
      if (
        record.operation !== 'provider-credential.bind' &&
        record.operation !== 'provider-credential.revoke'
      ) {
        invalid();
      }
      const actor = exactRecord(record.actor, ['id', 'type']);
      if (actor.type !== 'user') invalid();
      identifier(actor.id);
      const fence = exactRecord(record.fence, [
        'bindingVersion',
        'projectVersion',
      ]);
      positiveInteger(fence.projectVersion);
      positiveInteger(fence.bindingVersion);
      nonNegativeInteger(record.occurredAtMs);
      return record;
    });
    if (audit.nextCursor !== null) {
      const cursor = exactRecord(audit.nextCursor, ['eventId', 'occurredAtMs']);
      uuid(cursor.eventId);
      nonNegativeInteger(cursor.occurredAtMs);
      const last = records.at(-1);
      if (
        records.length !== command.request.limit ||
        !last ||
        cursor.eventId !== last.eventId ||
        cursor.occurredAtMs !== last.occurredAtMs
      ) {
        invalid();
      }
    }
    return Object.freeze(
      envelope as unknown as ClusterModelProviderCredentialManagementClientTransportResult,
    );
  }
  const envelope = exactRecord(value, [
    'schemaVersion',
    'operation',
    'status',
    'credential',
  ]);
  if (
    envelope.schemaVersion !== 1 ||
    envelope.operation !== command.operation ||
    !['created', 'existing'].includes(String(envelope.status))
  ) {
    invalid();
  }
  const credential = exactRecord(envelope.credential, [
    'projectId',
    'provider',
    'generation',
    'action',
    'activeBindingRevision',
    'activeBindingDigest',
    'transitionDigest',
    'changedAtMs',
  ]);
  const expectedAction =
    command.operation === 'provider-credential.bind' ? 'bind' : 'revoke';
  if (
    identifier(credential.projectId) !== command.request.projectId ||
    identifier(credential.provider) !== command.request.provider ||
    !Number.isSafeInteger(credential.generation) ||
    (credential.generation as number) < 1 ||
    credential.action !== expectedAction ||
    !Number.isSafeInteger(credential.changedAtMs) ||
    (credential.changedAtMs as number) < 0
  ) {
    invalid();
  }
  digest(credential.transitionDigest);
  if (command.operation === 'provider-credential.bind') {
    if (
      identifier(credential.activeBindingRevision) !== command.request.revision
    ) {
      invalid();
    }
    digest(credential.activeBindingDigest);
  } else if (
    credential.activeBindingRevision !== null ||
    credential.activeBindingDigest !== null
  ) {
    invalid();
  }
  return Object.freeze(
    envelope as unknown as ClusterModelProviderCredentialManagementClientTransportResult,
  );
}

const PROTOCOL = Object.freeze({
  managementPath: MANAGEMENT_PATH,
  clientCertificate: 'required' as const,
  normalizeCommand: normalizeClusterModelProviderCredentialManagementCommand,
  validateResult: validateClusterModelProviderCredentialManagementClientResult,
});

export async function executeClusterModelProviderCredentialManagementClient(
  paths: ClusterModelProviderCredentialManagementClientPaths,
  connectionOptions?: ClusterModelProviderCredentialManagementClientConnectionOptions,
): Promise<Readonly<ClusterModelProviderCredentialManagementClientResult>> {
  return executeClusterAuthenticatedManagementClient(
    paths,
    PROTOCOL,
    connectionOptions,
  );
}
