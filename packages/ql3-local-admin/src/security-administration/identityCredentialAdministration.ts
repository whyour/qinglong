import {
  REVOKED_API_CREDENTIAL_DIGEST,
  type ApiCredentialAdministrationOperation,
} from '@qinglong/runtime-core/api-credential-administration';
import {
  assertApiCredentialId,
  assertApiCredentialPepperKeyId,
} from '@qinglong/runtime-core/api-credential';
import {
  IDENTITY_ADMINISTRATION_OPERATIONS,
  type IdentityAdministrationOperation,
} from '@qinglong/runtime-core/identity-administration';
import {
  type AppendAuthorizedLocalApiCredentialResult,
  type AppendAuthorizedLocalCredentialDeliveryAcknowledgementResult,
  type AppendAuthorizedLocalIdentityResult,
  type InspectAuthorizedLocalApiCredentialResult,
  type InspectAuthorizedLocalIdentityResult,
  type LocalIdentityCredentialAdministrationRepository,
} from '@qinglong/runtime-core/local-identity-credential-administration';
import {
  ProjectPolicyEngine,
  assertProjectPolicyProjectId,
  normalizeProjectPolicySubject,
  type ProjectPolicyRepository,
} from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyFence,
  type SecurityPrincipal,
  type SecuritySubject,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_VERSION = 2_147_483_647;
const MAX_CREDENTIAL_LIFETIME_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const STRONG_USER_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);

interface BaseAdministrationRequest {
  readonly projectId: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly principal: SecurityPrincipal;
}

interface BaseInspectionRequest {
  readonly projectId: string;
  readonly auditEventId: string;
  readonly requestId: string;
  readonly principal: SecurityPrincipal;
}

export interface LocalIdentityAdministrationRequest
  extends BaseAdministrationRequest {
  readonly operation: IdentityAdministrationOperation;
  readonly target: SecuritySubject;
  readonly expectedCurrentVersion: number;
}

export interface LocalApiCredentialAdministrationRequest
  extends BaseAdministrationRequest {
  readonly operation: ApiCredentialAdministrationOperation;
  readonly credentialId: string;
  readonly target: SecuritySubject;
  readonly expectedCurrentVersion: number;
  readonly pepperKeyId: string;
  readonly secretDigest?: string;
  readonly deliveryDigest?: string;
  readonly notBeforeAtMs?: number;
  readonly expiresAtMs?: number;
}

export interface LocalCredentialDeliveryAcknowledgementRequest
  extends BaseAdministrationRequest {
  readonly credentialMutationId: string;
  readonly expectedDeliveryDigest: string;
}

export interface LocalIdentityInspectionRequest extends BaseInspectionRequest {
  readonly target: SecuritySubject;
}

export interface LocalApiCredentialInspectionRequest
  extends BaseInspectionRequest {
  readonly credentialId: string;
}

export interface LocalIdentityCredentialAdministrationService {
  inspectIdentity(
    request: LocalIdentityInspectionRequest,
  ): Promise<InspectAuthorizedLocalIdentityResult>;
  inspectCredential(
    request: LocalApiCredentialInspectionRequest,
  ): Promise<InspectAuthorizedLocalApiCredentialResult>;
  changeIdentity(
    request: LocalIdentityAdministrationRequest,
  ): Promise<AppendAuthorizedLocalIdentityResult>;
  changeCredential(
    request: LocalApiCredentialAdministrationRequest,
  ): Promise<AppendAuthorizedLocalApiCredentialResult>;
  acknowledgeCredentialDelivery(
    request: LocalCredentialDeliveryAcknowledgementRequest,
  ): Promise<AppendAuthorizedLocalCredentialDeliveryAcknowledgementResult>;
}

export class LocalIdentityCredentialAdministrationConfigurationError extends TypeError {
  readonly code = 'LOCAL_IDENTITY_CREDENTIAL_ADMINISTRATION_INVALID';

  constructor(message: string) {
    super(`Local Identity credential administration is invalid: ${message}`);
    this.name = 'LocalIdentityCredentialAdministrationConfigurationError';
  }
}

export class LocalIdentityCredentialAdministrationAuthenticationError extends Error {
  readonly code =
    'LOCAL_IDENTITY_CREDENTIAL_ADMINISTRATION_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Local Identity credential administration requires a strong User');
    this.name = 'LocalIdentityCredentialAdministrationAuthenticationError';
  }
}

export class LocalIdentityCredentialAdministrationAuthorizationError extends Error {
  readonly code = 'LOCAL_IDENTITY_CREDENTIAL_ADMINISTRATION_FORBIDDEN';

  constructor() {
    super('Local Identity credential administration is not authorized');
    this.name = 'LocalIdentityCredentialAdministrationAuthorizationError';
  }
}

export class LocalIdentityCredentialAdministrationServiceUnavailableError extends Error {
  readonly code =
    'LOCAL_IDENTITY_CREDENTIAL_ADMINISTRATION_SERVICE_UNAVAILABLE';

  constructor() {
    super('Local Identity credential administration service is unavailable');
    this.name = 'LocalIdentityCredentialAdministrationServiceUnavailableError';
  }
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalIdentityCredentialAdministrationConfigurationError(
      `${label} must be an object`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new LocalIdentityCredentialAdministrationConfigurationError(
      `${label} shape is invalid`,
    );
  }
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalIdentityCredentialAdministrationConfigurationError(
      'clock is invalid',
    );
  }
  return value;
}

function common(
  request: BaseAdministrationRequest,
  nowMs: number,
): Readonly<BaseAdministrationRequest> {
  try {
    assertProjectPolicyProjectId(request.projectId);
  } catch {
    throw new LocalIdentityCredentialAdministrationConfigurationError(
      'projectId is invalid',
    );
  }
  if (
    typeof request.mutationId !== 'string' ||
    !UUID_V4_PATTERN.test(request.mutationId) ||
    typeof request.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(request.requestId)
  ) {
    throw new LocalIdentityCredentialAdministrationConfigurationError(
      'mutationId or requestId is invalid',
    );
  }
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(request.principal, nowMs);
  } catch {
    throw new LocalIdentityCredentialAdministrationAuthenticationError();
  }
  if (
    principal.subject.type !== 'user' ||
    !STRONG_USER_ASSURANCES.has(principal.assurance)
  ) {
    throw new LocalIdentityCredentialAdministrationAuthenticationError();
  }
  return Object.freeze({ ...request, principal });
}

function inspectionCommon(
  request: BaseInspectionRequest,
  nowMs: number,
): Readonly<BaseInspectionRequest> {
  try {
    assertProjectPolicyProjectId(request.projectId);
  } catch {
    throw new LocalIdentityCredentialAdministrationConfigurationError(
      'projectId is invalid',
    );
  }
  if (
    typeof request.auditEventId !== 'string' ||
    !UUID_V4_PATTERN.test(request.auditEventId) ||
    typeof request.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(request.requestId)
  ) {
    throw new LocalIdentityCredentialAdministrationConfigurationError(
      'auditEventId or requestId is invalid',
    );
  }
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(request.principal, nowMs);
  } catch {
    throw new LocalIdentityCredentialAdministrationAuthenticationError();
  }
  if (
    principal.subject.type !== 'user' ||
    !STRONG_USER_ASSURANCES.has(principal.assurance)
  ) {
    throw new LocalIdentityCredentialAdministrationAuthenticationError();
  }
  return Object.freeze({ ...request, principal });
}

function expectedVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_VERSION) {
    throw new LocalIdentityCredentialAdministrationConfigurationError(
      'expectedCurrentVersion is invalid',
    );
  }
  return value;
}

function target(value: SecuritySubject): Readonly<SecuritySubject> {
  let normalized: Readonly<SecuritySubject>;
  try {
    normalized = normalizeProjectPolicySubject(value);
  } catch {
    throw new LocalIdentityCredentialAdministrationConfigurationError(
      'target is invalid',
    );
  }
  if (
    normalized.type !== 'user' &&
    normalized.type !== 'api_app' &&
    normalized.type !== 'mcp_client' &&
    normalized.type !== 'agent'
  ) {
    throw new LocalIdentityCredentialAdministrationConfigurationError(
      'target type is not locally administrable',
    );
  }
  return normalized;
}

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function audit(options: {
  readonly eventId: string;
  readonly requestId: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly outcome: SecurityAuditRecord['outcome'];
  readonly reasons: readonly string[];
  readonly fence: SecurityPolicyFence | null;
  readonly occurredAtMs: number;
}): Readonly<SecurityAuditRecord> {
  return normalizeSecurityAuditRecord({
    eventId: options.eventId,
    requestId: options.requestId,
    operationId: options.operationId,
    projectId: options.projectId,
    subject: options.principal.subject,
    authenticationId: options.principal.authenticationId,
    outcome: options.outcome,
    reasons: options.reasons,
    fence: options.fence,
    occurredAtMs: options.occurredAtMs,
  });
}

export function createLocalIdentityCredentialAdministrationService(
  projectPolicy: ProjectPolicyRepository,
  repository: LocalIdentityCredentialAdministrationRepository,
  options: { readonly now?: () => number } = {},
): LocalIdentityCredentialAdministrationService {
  if (
    !projectPolicy ||
    typeof projectPolicy.resolve !== 'function' ||
    !repository ||
    typeof repository.resolveAuthorityProjectId !== 'function' ||
    typeof repository.resolveIdentity !== 'function' ||
    typeof repository.resolveIdentityMutation !== 'function' ||
    typeof repository.appendAuthorizedIdentity !== 'function' ||
    typeof repository.inspectAuthorizedIdentity !== 'function' ||
    typeof repository.resolveCredentialMutation !== 'function' ||
    typeof repository.appendAuthorizedCredential !== 'function' ||
    typeof repository.inspectAuthorizedCredential !== 'function' ||
    typeof repository.resolveDeliveryAcknowledgement !== 'function' ||
    typeof repository.appendAuthorizedDeliveryAcknowledgement !== 'function' ||
    typeof repository.record !== 'function' ||
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'now') ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new LocalIdentityCredentialAdministrationConfigurationError(
      'dependencies are invalid',
    );
  }
  const now = options.now ?? Date.now;
  const policy = new ProjectPolicyEngine(projectPolicy);

  async function authorize(
    request: Readonly<BaseAdministrationRequest | BaseInspectionRequest>,
    eventId: string,
    operationId: string,
    occurredAtMs: number,
  ): Promise<Readonly<SecurityPolicyFence>> {
    let decision;
    try {
      decision = await policy.authorize(
        request.principal,
        request.projectId,
        'project.manage',
      );
    } catch {
      try {
        await repository.record(
          audit({
            eventId,
            requestId: request.requestId,
            operationId,
            projectId: request.projectId,
            principal: request.principal,
            outcome: 'authorization_unavailable',
            reasons: ['policy_unavailable'],
            fence: null,
            occurredAtMs,
          }),
        );
      } catch {
        throw new LocalIdentityCredentialAdministrationServiceUnavailableError();
      }
      throw new LocalIdentityCredentialAdministrationServiceUnavailableError();
    }
    if (decision.effect !== 'allow' || !decision.fence?.bindingVersion) {
      try {
        await repository.record(
          audit({
            eventId,
            requestId: request.requestId,
            operationId,
            projectId: request.projectId,
            principal: request.principal,
            outcome:
              decision.effect === 'require_approval'
                ? 'approval_required'
                : 'denied',
            reasons: decision.reasons,
            fence: decision.fence,
            occurredAtMs,
          }),
        );
      } catch {
        throw new LocalIdentityCredentialAdministrationServiceUnavailableError();
      }
      throw new LocalIdentityCredentialAdministrationAuthorizationError();
    }
    let authorityProjectId: string | null;
    try {
      authorityProjectId = await repository.resolveAuthorityProjectId();
      if (authorityProjectId !== null) {
        assertProjectPolicyProjectId(authorityProjectId);
      }
    } catch {
      try {
        await repository.record(
          audit({
            eventId,
            requestId: request.requestId,
            operationId,
            projectId: request.projectId,
            principal: request.principal,
            outcome: 'authorization_unavailable',
            reasons: ['instance_authority_project_unavailable'],
            fence: decision.fence,
            occurredAtMs,
          }),
        );
      } catch {
        throw new LocalIdentityCredentialAdministrationServiceUnavailableError();
      }
      throw new LocalIdentityCredentialAdministrationServiceUnavailableError();
    }
    if (authorityProjectId !== request.projectId) {
      try {
        await repository.record(
          audit({
            eventId,
            requestId: request.requestId,
            operationId,
            projectId: request.projectId,
            principal: request.principal,
            outcome: 'denied',
            reasons: ['instance_authority_project_required'],
            fence: decision.fence,
            occurredAtMs,
          }),
        );
      } catch {
        throw new LocalIdentityCredentialAdministrationServiceUnavailableError();
      }
      throw new LocalIdentityCredentialAdministrationAuthorizationError();
    }
    return decision.fence;
  }

  return Object.freeze({
    async inspectIdentity(input: LocalIdentityInspectionRequest) {
      exactObject(
        input,
        ['projectId', 'target', 'auditEventId', 'requestId', 'principal'],
        'identity inspection request',
      );
      const occurredAtMs = safeNow(now);
      const request = inspectionCommon(input, occurredAtMs);
      const subject = target(input.target);
      const operationId = 'identity.inspect';
      const fence = await authorize(
        request,
        request.auditEventId,
        operationId,
        occurredAtMs,
      );
      return repository.inspectAuthorizedIdentity({
        target: subject,
        authorization: {
          projectId: request.projectId,
          actor: request.principal.subject,
          fence,
        },
        audit: audit({
          eventId: request.auditEventId,
          requestId: request.requestId,
          operationId,
          projectId: request.projectId,
          principal: request.principal,
          outcome: 'allowed',
          reasons: ['owner_identity_inspect'],
          fence,
          occurredAtMs,
        }),
      });
    },

    async inspectCredential(input: LocalApiCredentialInspectionRequest) {
      exactObject(
        input,
        ['projectId', 'credentialId', 'auditEventId', 'requestId', 'principal'],
        'credential inspection request',
      );
      const occurredAtMs = safeNow(now);
      const request = inspectionCommon(input, occurredAtMs);
      try {
        assertApiCredentialId(input.credentialId);
      } catch {
        throw new LocalIdentityCredentialAdministrationConfigurationError(
          'credentialId is invalid',
        );
      }
      const operationId = 'credential.inspect';
      const fence = await authorize(
        request,
        request.auditEventId,
        operationId,
        occurredAtMs,
      );
      return repository.inspectAuthorizedCredential({
        credentialId: input.credentialId,
        authorization: {
          projectId: request.projectId,
          actor: request.principal.subject,
          fence,
        },
        audit: audit({
          eventId: request.auditEventId,
          requestId: request.requestId,
          operationId,
          projectId: request.projectId,
          principal: request.principal,
          outcome: 'allowed',
          reasons: ['owner_credential_inspect'],
          fence,
          occurredAtMs,
        }),
      });
    },

    async changeIdentity(input: LocalIdentityAdministrationRequest) {
      exactObject(
        input,
        [
          'projectId',
          'operation',
          'target',
          'expectedCurrentVersion',
          'mutationId',
          'requestId',
          'principal',
        ],
        'identity request',
      );
      const occurredAtMs = safeNow(now);
      const request = common(input, occurredAtMs);
      if (!IDENTITY_ADMINISTRATION_OPERATIONS.includes(input.operation)) {
        throw new LocalIdentityCredentialAdministrationConfigurationError(
          'identity operation is invalid',
        );
      }
      const currentVersion = expectedVersion(input.expectedCurrentVersion);
      const subject = target(input.target);
      const operationId = `identity.${input.operation}`;
      const fence = await authorize(
        request,
        request.mutationId,
        operationId,
        occurredAtMs,
      );
      const replay = await repository.resolveIdentityMutation(
        request.mutationId,
      );
      const mutationTime = replay?.mutation.createdAtMs ?? occurredAtMs;
      return repository.appendAuthorizedIdentity({
        expectedCurrentVersion: currentVersion,
        mutation: {
          mutationId: request.mutationId,
          operation: input.operation,
          subject,
          subjectVersion: currentVersion + 1,
          expectedPreviousVersion: currentVersion,
          status: input.operation === 'disable' ? 'disabled' : 'active',
          changedBy: request.principal.subject,
          createdAtMs: mutationTime,
        },
        authorization: {
          projectId: request.projectId,
          actor: request.principal.subject,
          fence,
        },
        audit: audit({
          eventId: request.mutationId,
          requestId: request.requestId,
          operationId,
          projectId: request.projectId,
          principal: request.principal,
          outcome: 'allowed',
          reasons: ['owner_identity_admin'],
          fence,
          occurredAtMs: mutationTime,
        }),
      });
    },

    async changeCredential(input: LocalApiCredentialAdministrationRequest) {
      const active = input.operation !== 'revoke';
      exactObject(
        input,
        [
          'projectId',
          'operation',
          'credentialId',
          'target',
          'expectedCurrentVersion',
          'pepperKeyId',
          ...(active
            ? ['secretDigest', 'deliveryDigest', 'notBeforeAtMs', 'expiresAtMs']
            : []),
          'mutationId',
          'requestId',
          'principal',
        ],
        'credential request',
      );
      const occurredAtMs = safeNow(now);
      const request = common(input, occurredAtMs);
      if (
        input.operation !== 'issue' &&
        input.operation !== 'rotate' &&
        input.operation !== 'revoke'
      ) {
        throw new LocalIdentityCredentialAdministrationConfigurationError(
          'credential operation is invalid',
        );
      }
      try {
        assertApiCredentialId(input.credentialId);
        assertApiCredentialPepperKeyId(input.pepperKeyId);
      } catch {
        throw new LocalIdentityCredentialAdministrationConfigurationError(
          'credentialId or pepperKeyId is invalid',
        );
      }
      const currentVersion = expectedVersion(input.expectedCurrentVersion);
      const subject = target(input.target);
      let secretDigest = REVOKED_API_CREDENTIAL_DIGEST;
      let deliveryDigest: string | null = null;
      let notBeforeAtMs = occurredAtMs;
      let expiresAtMs = occurredAtMs + 1;
      if (active) {
        if (
          typeof input.secretDigest !== 'string' ||
          !DIGEST_PATTERN.test(input.secretDigest) ||
          typeof input.deliveryDigest !== 'string' ||
          !DIGEST_PATTERN.test(input.deliveryDigest) ||
          !Number.isSafeInteger(input.notBeforeAtMs) ||
          !Number.isSafeInteger(input.expiresAtMs) ||
          (input.expiresAtMs as number) <= (input.notBeforeAtMs as number)
        ) {
          throw new LocalIdentityCredentialAdministrationConfigurationError(
            'credential material or lifetime is invalid',
          );
        }
        secretDigest = input.secretDigest;
        deliveryDigest = input.deliveryDigest;
        notBeforeAtMs = input.notBeforeAtMs as number;
        expiresAtMs = input.expiresAtMs as number;
      }
      const operationId = `credential.${input.operation}`;
      const fence = await authorize(
        request,
        request.mutationId,
        operationId,
        occurredAtMs,
      );
      const replay = await repository.resolveCredentialMutation(
        request.mutationId,
      );
      const mutationTime = replay?.mutation.createdAtMs ?? occurredAtMs;
      if (
        active &&
        (notBeforeAtMs < mutationTime ||
          expiresAtMs - mutationTime > MAX_CREDENTIAL_LIFETIME_MS)
      ) {
        throw new LocalIdentityCredentialAdministrationConfigurationError(
          'credential material or lifetime is invalid',
        );
      }
      if (
        replay &&
        (replay.mutation.operation !== input.operation ||
          replay.mutation.credentialId !== input.credentialId ||
          replay.mutation.expectedPreviousVersion !== currentVersion ||
          !sameSubject(replay.credential.subject, subject) ||
          replay.credential.pepperKeyId !== input.pepperKeyId ||
          (active &&
            (replay.credential.secretDigest !== secretDigest ||
              replay.delivery?.digest !== deliveryDigest ||
              replay.credential.notBeforeAtMs !== notBeforeAtMs ||
              replay.credential.expiresAtMs !== expiresAtMs)))
      ) {
        throw new LocalIdentityCredentialAdministrationConfigurationError(
          'credential replay conflicts with request',
        );
      }
      const identity = replay
        ? null
        : await repository.resolveIdentity(subject);
      if (!replay && (!identity || (active && identity.status !== 'active'))) {
        throw new LocalIdentityCredentialAdministrationConfigurationError(
          'target Identity is unavailable',
        );
      }
      if (replay && !active) {
        secretDigest = replay.credential.secretDigest;
        notBeforeAtMs = replay.credential.notBeforeAtMs;
        expiresAtMs = replay.credential.expiresAtMs;
      }
      return repository.appendAuthorizedCredential({
        expectedCurrentVersion: currentVersion,
        credential: {
          credentialId: input.credentialId,
          version: currentVersion + 1,
          pepperKeyId: input.pepperKeyId,
          state: active ? 'active' : 'revoked',
          subject,
          subjectStatus: replay?.credential.subjectStatus ?? identity!.status,
          secretDigest,
          createdAtMs: mutationTime,
          notBeforeAtMs,
          expiresAtMs,
        },
        mutation: {
          mutationId: request.mutationId,
          operation: input.operation,
          credentialId: input.credentialId,
          credentialVersion: currentVersion + 1,
          expectedPreviousVersion: currentVersion,
          changedBy: request.principal.subject,
          createdAtMs: mutationTime,
        },
        authorization: {
          projectId: request.projectId,
          actor: request.principal.subject,
          fence,
        },
        delivery:
          deliveryDigest === null
            ? null
            : Object.freeze({ digest: deliveryDigest }),
        audit: audit({
          eventId: request.mutationId,
          requestId: request.requestId,
          operationId,
          projectId: request.projectId,
          principal: request.principal,
          outcome: 'allowed',
          reasons: ['owner_credential_admin'],
          fence,
          occurredAtMs: mutationTime,
        }),
      });
    },

    async acknowledgeCredentialDelivery(
      input: LocalCredentialDeliveryAcknowledgementRequest,
    ) {
      exactObject(
        input,
        [
          'projectId',
          'credentialMutationId',
          'expectedDeliveryDigest',
          'mutationId',
          'requestId',
          'principal',
        ],
        'delivery acknowledgement request',
      );
      const occurredAtMs = safeNow(now);
      const request = common(input, occurredAtMs);
      if (
        !UUID_V4_PATTERN.test(input.credentialMutationId) ||
        input.credentialMutationId === request.mutationId ||
        !DIGEST_PATTERN.test(input.expectedDeliveryDigest)
      ) {
        throw new LocalIdentityCredentialAdministrationConfigurationError(
          'delivery acknowledgement value is invalid',
        );
      }
      const operationId = 'credential.delivery.acknowledge';
      const fence = await authorize(
        request,
        request.mutationId,
        operationId,
        occurredAtMs,
      );
      const existing = await repository.resolveDeliveryAcknowledgement(
        input.credentialMutationId,
      );
      const acknowledgementTime = existing?.acknowledgedAtMs ?? occurredAtMs;
      return repository.appendAuthorizedDeliveryAcknowledgement({
        acknowledgement: {
          credentialMutationId: input.credentialMutationId,
          acknowledgementMutationId: request.mutationId,
          projectId: request.projectId,
          deliveryDigest: input.expectedDeliveryDigest,
          acknowledgedBy: request.principal.subject,
          acknowledgedAtMs: acknowledgementTime,
        },
        authorization: {
          projectId: request.projectId,
          actor: request.principal.subject,
          fence,
        },
        audit: audit({
          eventId: request.mutationId,
          requestId: request.requestId,
          operationId,
          projectId: request.projectId,
          principal: request.principal,
          outcome: 'allowed',
          reasons: ['owner_credential_delivery_acknowledged'],
          fence,
          occurredAtMs: acknowledgementTime,
        }),
      });
    },
  });
}
