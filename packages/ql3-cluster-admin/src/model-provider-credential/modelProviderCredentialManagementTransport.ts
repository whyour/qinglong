import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import type { ModelProviderCredentialTestPlan } from '@qinglong/ai/model-provider-credential-test-connection';

import type {
  BindModelProviderCredentialRequest,
  ClusterModelProviderCredentialManagementService,
  ListModelProviderCredentialManagementAuditRequest,
  PlanModelProviderCredentialTestRequest,
  RevokeModelProviderCredentialRequest,
} from './modelProviderCredentialManagement';

const STRONG_CLUSTER_ASSURANCES = new Set(['multi_factor', 'hardware']);
const MAX_PRINCIPAL_AGE_MS = 5 * 60 * 1_000;

interface BindTransportRequest
  extends Omit<BindModelProviderCredentialRequest, 'principal'> {}

interface RevokeTransportRequest
  extends Omit<RevokeModelProviderCredentialRequest, 'principal'> {}

interface AuditTransportRequest
  extends Omit<
    ListModelProviderCredentialManagementAuditRequest,
    'principal'
  > {}

interface TestPlanTransportRequest
  extends Omit<PlanModelProviderCredentialTestRequest, 'principal'> {}

export type ClusterModelProviderCredentialManagementCommand =
  | Readonly<{
      schemaVersion: 1;
      operation: 'provider-credential.bind';
      request: BindTransportRequest;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'provider-credential.revoke';
      request: RevokeTransportRequest;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'provider-credential.audit.list';
      request: AuditTransportRequest;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'provider-credential.test.plan';
      request: TestPlanTransportRequest;
    }>;

export interface ClusterModelProviderCredentialManagementAuthentication {
  authenticate(): Promise<Readonly<SecurityPrincipal> | null>;
}

export interface ClusterModelProviderCredentialManagementTransport {
  execute(
    command: unknown,
    authentication: ClusterModelProviderCredentialManagementAuthentication,
  ): Promise<Readonly<ClusterModelProviderCredentialManagementTransportResult>>;
}

export type ClusterModelProviderCredentialManagementTransportResult =
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

export class ClusterModelProviderCredentialManagementTransportConfigurationError extends TypeError {
  readonly code =
    'CLUSTER_MODEL_PROVIDER_CREDENTIAL_TRANSPORT_CONFIGURATION_INVALID';

  constructor() {
    super(
      'Cluster model provider credential transport configuration is invalid',
    );
    this.name =
      'ClusterModelProviderCredentialManagementTransportConfigurationError';
  }
}

export class ClusterModelProviderCredentialManagementTransportRequestError extends TypeError {
  readonly code = 'CLUSTER_MODEL_PROVIDER_CREDENTIAL_TRANSPORT_REQUEST_INVALID';

  constructor() {
    super('Cluster model provider credential transport request is invalid');
    this.name = 'ClusterModelProviderCredentialManagementTransportRequestError';
  }
}

export class ClusterModelProviderCredentialManagementTransportAuthenticationError extends Error {
  readonly code =
    'CLUSTER_MODEL_PROVIDER_CREDENTIAL_TRANSPORT_AUTHENTICATION_REQUIRED';

  constructor() {
    super(
      'Cluster model provider credential transport requires a recent strong User',
    );
    this.name =
      'ClusterModelProviderCredentialManagementTransportAuthenticationError';
  }
}

export class ClusterModelProviderCredentialManagementTransportUnavailableError extends Error {
  readonly code = 'CLUSTER_MODEL_PROVIDER_CREDENTIAL_TRANSPORT_UNAVAILABLE';

  constructor() {
    super('Cluster model provider credential transport is unavailable');
    this.name =
      'ClusterModelProviderCredentialManagementTransportUnavailableError';
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function normalizeCommand(
  value: unknown,
): Readonly<ClusterModelProviderCredentialManagementCommand> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['operation', 'request', 'schemaVersion']) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    ((value as { operation?: unknown }).operation !==
      'provider-credential.bind' &&
      (value as { operation?: unknown }).operation !==
        'provider-credential.revoke' &&
      (value as { operation?: unknown }).operation !==
        'provider-credential.audit.list' &&
      (value as { operation?: unknown }).operation !==
        'provider-credential.test.plan') ||
    !(value as { request?: unknown }).request ||
    typeof (value as { request: unknown }).request !== 'object' ||
    Array.isArray((value as { request: unknown }).request)
  ) {
    throw new ClusterModelProviderCredentialManagementTransportRequestError();
  }
  const command = value as ClusterModelProviderCredentialManagementCommand;
  const common = [
    'expectedGeneration',
    'mutationId',
    'projectId',
    'provider',
    'requestId',
  ];
  if (command.operation === 'provider-credential.audit.list') {
    const auditKeys = ['limit', 'projectId', 'queryId', 'requestId'];
    if ('before' in command.request) auditKeys.push('before');
    if (!exactKeys(command.request, auditKeys)) {
      throw new ClusterModelProviderCredentialManagementTransportRequestError();
    }
    return command;
  }
  if (command.operation === 'provider-credential.test.plan') {
    if (
      !exactKeys(command.request, [
        'projectId',
        'provider',
        'requestId',
        'testId',
      ])
    ) {
      throw new ClusterModelProviderCredentialManagementTransportRequestError();
    }
    return command;
  }
  if (
    !exactKeys(
      command.request,
      command.operation === 'provider-credential.bind'
        ? [...common, 'revision', 'secretRef']
        : common,
    )
  ) {
    throw new ClusterModelProviderCredentialManagementTransportRequestError();
  }
  return command;
}

export function normalizeClusterModelProviderCredentialManagementCommand(
  value: unknown,
): Readonly<ClusterModelProviderCredentialManagementCommand> {
  return normalizeCommand(value);
}

function summary(
  transition: Readonly<{
    projectId: string;
    provider: string;
    generation: number;
    action: 'bind' | 'revoke';
    activeBindingRevision: string | null;
    activeBindingDigest: string | null;
    transitionDigest: string;
    changedAtMs: number;
  }>,
) {
  return Object.freeze({
    projectId: transition.projectId,
    provider: transition.provider,
    generation: transition.generation,
    action: transition.action,
    activeBindingRevision: transition.activeBindingRevision,
    activeBindingDigest: transition.activeBindingDigest,
    transitionDigest: transition.transitionDigest,
    changedAtMs: transition.changedAtMs,
  });
}

export function createClusterModelProviderCredentialManagementTransport(
  options: Readonly<{
    service: ClusterModelProviderCredentialManagementService;
    now?: () => number;
  }>,
): Readonly<ClusterModelProviderCredentialManagementTransport> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'service' && key !== 'now') ||
    !options.service ||
    typeof options.service.bind !== 'function' ||
    typeof options.service.revoke !== 'function' ||
    typeof options.service.listAudit !== 'function' ||
    typeof options.service.planTestConnection !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new ClusterModelProviderCredentialManagementTransportConfigurationError();
  }
  const now = options.now ?? Date.now;
  return Object.freeze({
    async execute(
      commandValue: unknown,
      authentication: ClusterModelProviderCredentialManagementAuthentication,
    ) {
      const command = normalizeCommand(commandValue);
      if (
        !authentication ||
        typeof authentication !== 'object' ||
        Array.isArray(authentication) ||
        !exactKeys(authentication, ['authenticate']) ||
        typeof authentication.authenticate !== 'function'
      ) {
        throw new ClusterModelProviderCredentialManagementTransportConfigurationError();
      }
      const observedAtMs = now();
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
        throw new ClusterModelProviderCredentialManagementTransportUnavailableError();
      }
      let candidate: Readonly<SecurityPrincipal> | null;
      try {
        candidate = await authentication.authenticate();
      } catch {
        throw new ClusterModelProviderCredentialManagementTransportUnavailableError();
      }
      let principal: Readonly<SecurityPrincipal>;
      try {
        principal = normalizeSecurityPrincipal(
          candidate as SecurityPrincipal,
          observedAtMs,
        );
      } catch {
        throw new ClusterModelProviderCredentialManagementTransportAuthenticationError();
      }
      if (
        principal.subject.type !== 'user' ||
        !STRONG_CLUSTER_ASSURANCES.has(principal.assurance) ||
        observedAtMs - principal.authenticatedAtMs > MAX_PRINCIPAL_AGE_MS
      ) {
        throw new ClusterModelProviderCredentialManagementTransportAuthenticationError();
      }
      if (command.operation === 'provider-credential.audit.list') {
        const audit = await options.service.listAudit({
          ...command.request,
          principal,
        });
        return Object.freeze({
          schemaVersion: 1 as const,
          operation: command.operation,
          audit,
        });
      }
      if (command.operation === 'provider-credential.test.plan') {
        const result = await options.service.planTestConnection({
          ...command.request,
          principal,
        });
        return Object.freeze({
          schemaVersion: 1 as const,
          operation: command.operation,
          status: result.status,
          plan: result.plan,
        });
      }
      const result =
        command.operation === 'provider-credential.bind'
          ? await options.service.bind({ ...command.request, principal })
          : await options.service.revoke({ ...command.request, principal });
      return Object.freeze({
        schemaVersion: 1 as const,
        operation: command.operation,
        status: result.status,
        credential: summary(result.transition),
      });
    },
  });
}
