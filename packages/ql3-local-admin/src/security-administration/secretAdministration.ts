import {
  LOCAL_SECRET_ALGORITHM,
  LocalSecretMutationConflictError,
  LocalSecretUnavailableError,
  LocalSecretVersionConflictError,
  assertLocalSecretExpectedVersion,
  assertLocalSecretMutationId,
  assertLocalSecretName,
  assertLocalSecretPlaintext,
  assertLocalSecretProjectId,
  createLocalSecretRef,
  type LocalSecretEnvelope,
  type LocalSecretKeyProvider,
  type PutEncryptedLocalSecretResult,
} from '@qinglong/runtime-core/local-secret';
import {
  LocalSecretAuthorizationFenceConflictError,
  type LocalSecretAdministrationMutation,
  type LocalSecretAdministrationRepository,
} from '@qinglong/runtime-core/local-secret-administration';
import {
  ProjectPolicyEngine,
  ProjectPolicyUnavailableError,
  type ProjectPolicyRepository,
} from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyDecision,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import {
  SecurityAuditUnavailableError,
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';
import {
  encryptLocalSecretEnvelope,
  localSecretPlaintextMatches,
  ownedLocalSecretKeyMaterial,
  type LocalSecretNonceFactory,
} from '@qinglong/local-secret';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STRONG_USER_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);

export interface LocalSecretAdministrationRequest {
  readonly projectId: string;
  readonly name: string;
  readonly plaintext: string;
  readonly mutationId: string;
  readonly requestId: string;
  readonly expectedCurrentVersion: number;
  readonly principal: SecurityPrincipal;
}

export interface LocalSecretAdministrationOptions {
  readonly now?: () => number;
  readonly nonceFactory?: LocalSecretNonceFactory;
}

export interface LocalSecretAdministrationService {
  put(
    request: LocalSecretAdministrationRequest,
  ): Promise<PutEncryptedLocalSecretResult>;
}

export class LocalSecretAdministrationConfigurationError extends TypeError {
  constructor(message: string) {
    super(`Local Secret administration configuration is invalid: ${message}`);
    this.name = 'LocalSecretAdministrationConfigurationError';
  }
}

export class LocalSecretAdministrationAuthenticationError extends Error {
  readonly code = 'LOCAL_SECRET_ADMINISTRATION_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Local Secret administration requires a strong principal');
    this.name = 'LocalSecretAdministrationAuthenticationError';
  }
}

export class LocalSecretAdministrationAuthorizationError extends Error {
  readonly code = 'LOCAL_SECRET_ADMINISTRATION_FORBIDDEN';

  constructor() {
    super('Local Secret administration is not authorized');
    this.name = 'LocalSecretAdministrationAuthorizationError';
  }
}

export class LocalSecretAdministrationUnavailableError extends Error {
  readonly code = 'LOCAL_SECRET_ADMINISTRATION_UNAVAILABLE';

  constructor() {
    super('Local Secret administration is unavailable');
    this.name = 'LocalSecretAdministrationUnavailableError';
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

function assertRequest(request: LocalSecretAdministrationRequest): void {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    !exactKeys(request, [
      'projectId',
      'name',
      'plaintext',
      'mutationId',
      'requestId',
      'expectedCurrentVersion',
      'principal',
    ])
  ) {
    throw new LocalSecretAdministrationConfigurationError(
      'request shape is invalid',
    );
  }
  try {
    assertLocalSecretProjectId(request.projectId);
    assertLocalSecretName(request.name);
    assertLocalSecretPlaintext(request.plaintext);
    assertLocalSecretMutationId(request.mutationId);
    assertLocalSecretExpectedVersion(request.expectedCurrentVersion);
  } catch {
    throw new LocalSecretAdministrationConfigurationError(
      'request value is invalid',
    );
  }
  if (
    !UUID_V4_PATTERN.test(request.mutationId) ||
    !REQUEST_ID_PATTERN.test(request.requestId)
  ) {
    throw new LocalSecretAdministrationConfigurationError(
      'request identity is invalid',
    );
  }
}

function administrationPrincipal(
  value: SecurityPrincipal,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  let principal: Readonly<SecurityPrincipal>;
  try {
    principal = normalizeSecurityPrincipal(value, nowMs);
  } catch {
    throw new LocalSecretAdministrationAuthenticationError();
  }
  const human =
    principal.subject.type === 'user' &&
    STRONG_USER_ASSURANCES.has(principal.assurance);
  const system =
    principal.subject.type === 'system' && principal.assurance === 'service';
  if (!human && !system) {
    throw new LocalSecretAdministrationAuthenticationError();
  }
  return principal;
}

function auditRecord(options: {
  readonly request: LocalSecretAdministrationRequest;
  readonly principal: Readonly<SecurityPrincipal> | null;
  readonly operationId: 'secret.create' | 'secret.manage' | 'secret.rotate';
  readonly outcome: SecurityAuditRecord['outcome'];
  readonly reasons: readonly string[];
  readonly fence: SecurityPolicyDecision['fence'];
  readonly occurredAtMs: number;
}): Readonly<SecurityAuditRecord> {
  return normalizeSecurityAuditRecord({
    eventId: options.request.mutationId,
    requestId: options.request.requestId,
    operationId: options.operationId,
    projectId: options.request.projectId,
    subject: options.principal?.subject ?? null,
    authenticationId: options.principal?.authenticationId ?? null,
    outcome: options.outcome,
    reasons: options.reasons,
    fence: options.fence,
    occurredAtMs: options.occurredAtMs,
  });
}

function sameAuditSemantic(
  left: Readonly<SecurityAuditRecord>,
  right: Readonly<SecurityAuditRecord>,
): boolean {
  const { occurredAtMs: _leftTime, ...leftSemantic } = left;
  const { occurredAtMs: _rightTime, ...rightSemantic } = right;
  return JSON.stringify(leftSemantic) === JSON.stringify(rightSemantic);
}

function result(
  status: PutEncryptedLocalSecretResult['status'],
  envelope: LocalSecretEnvelope,
): PutEncryptedLocalSecretResult {
  return Object.freeze({
    status,
    version: envelope.version,
    secretRef: createLocalSecretRef({
      projectId: envelope.projectId,
      name: envelope.name,
      version: envelope.version,
    }),
  });
}

async function matchesExisting(
  existing: Readonly<LocalSecretAdministrationMutation>,
  expectedAudit: Readonly<SecurityAuditRecord>,
  request: LocalSecretAdministrationRequest,
  keys: LocalSecretKeyProvider,
): Promise<boolean> {
  if (
    existing.envelope.version !== request.expectedCurrentVersion + 1 ||
    !sameAuditSemantic(existing.audit, expectedAudit)
  ) {
    return false;
  }
  const material = ownedLocalSecretKeyMaterial(
    await keys.resolve(existing.envelope.keyId),
    existing.envelope.keyId,
  );
  try {
    return localSecretPlaintextMatches(
      existing.envelope,
      material.key,
      request.plaintext,
    );
  } finally {
    material.key.fill(0);
  }
}

export function createLocalSecretAdministrationService(
  projectPolicy: ProjectPolicyRepository,
  mutations: LocalSecretAdministrationRepository,
  audit: SecurityAuditSink,
  keys: LocalSecretKeyProvider,
  options: LocalSecretAdministrationOptions = {},
): LocalSecretAdministrationService {
  if (
    !projectPolicy ||
    typeof projectPolicy.resolve !== 'function' ||
    typeof projectPolicy.append !== 'function'
  ) {
    throw new LocalSecretAdministrationConfigurationError(
      'Project Policy repository is invalid',
    );
  }
  if (
    !mutations ||
    typeof mutations.resolveLocalSecretAdministrationMutation !== 'function' ||
    typeof mutations.appendAuthorizedLocalSecretEnvelope !== 'function'
  ) {
    throw new LocalSecretAdministrationConfigurationError(
      'mutation repository is invalid',
    );
  }
  if (!audit || typeof audit.record !== 'function') {
    throw new LocalSecretAdministrationConfigurationError(
      'audit sink is invalid',
    );
  }
  if (
    !keys ||
    typeof keys.active !== 'function' ||
    typeof keys.resolve !== 'function'
  ) {
    throw new LocalSecretAdministrationConfigurationError(
      'key provider is invalid',
    );
  }
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(
      options,
      options.nonceFactory === undefined
        ? options.now === undefined
          ? []
          : ['now']
        : options.now === undefined
        ? ['nonceFactory']
        : ['now', 'nonceFactory'],
    ) ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.nonceFactory !== undefined &&
      typeof options.nonceFactory !== 'function')
  ) {
    throw new LocalSecretAdministrationConfigurationError(
      'options are invalid',
    );
  }
  const policy = new ProjectPolicyEngine(projectPolicy);
  const now = options.now ?? Date.now;

  return Object.freeze({
    async put(
      request: LocalSecretAdministrationRequest,
    ): Promise<PutEncryptedLocalSecretResult> {
      assertRequest(request);
      const nowMs = now();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new LocalSecretAdministrationConfigurationError(
          'clock is invalid',
        );
      }
      let principal: Readonly<SecurityPrincipal>;
      try {
        principal = administrationPrincipal(request.principal, nowMs);
      } catch (error) {
        try {
          await audit.record(
            auditRecord({
              request,
              principal: null,
              operationId: 'secret.manage',
              outcome: 'authentication_rejected',
              reasons: ['strong_authentication_required'],
              fence: null,
              occurredAtMs: nowMs,
            }),
          );
        } catch {
          throw new LocalSecretAdministrationUnavailableError();
        }
        throw error;
      }

      let decision: Readonly<SecurityPolicyDecision>;
      try {
        decision = await policy.authorize(
          principal,
          request.projectId,
          'secret.manage',
        );
      } catch (error) {
        if (!(error instanceof ProjectPolicyUnavailableError)) {
          throw new LocalSecretAdministrationUnavailableError();
        }
        try {
          await audit.record(
            auditRecord({
              request,
              principal,
              operationId: 'secret.manage',
              outcome: 'authorization_unavailable',
              reasons: ['policy_unavailable'],
              fence: null,
              occurredAtMs: nowMs,
            }),
          );
        } catch {
          throw new LocalSecretAdministrationUnavailableError();
        }
        throw new LocalSecretAdministrationUnavailableError();
      }

      if (decision.effect !== 'allow') {
        try {
          await audit.record(
            auditRecord({
              request,
              principal,
              operationId: 'secret.manage',
              outcome:
                decision.effect === 'require_approval'
                  ? 'approval_required'
                  : 'denied',
              reasons: decision.reasons,
              fence: decision.fence,
              occurredAtMs: nowMs,
            }),
          );
        } catch {
          throw new LocalSecretAdministrationUnavailableError();
        }
        throw new LocalSecretAdministrationAuthorizationError();
      }
      if (!decision.fence || decision.fence.bindingVersion === null) {
        throw new LocalSecretAdministrationUnavailableError();
      }

      const operationId =
        request.expectedCurrentVersion === 0
          ? ('secret.create' as const)
          : ('secret.rotate' as const);
      const allowedAudit = auditRecord({
        request,
        principal,
        operationId,
        outcome: 'allowed',
        reasons: decision.reasons,
        fence: decision.fence,
        occurredAtMs: nowMs,
      });

      try {
        const existing =
          await mutations.resolveLocalSecretAdministrationMutation(
            request.projectId,
            request.name,
            request.mutationId,
          );
        if (existing) {
          if (!(await matchesExisting(existing, allowedAudit, request, keys))) {
            throw new LocalSecretMutationConflictError();
          }
          return result('existing', existing.envelope);
        }

        const material = ownedLocalSecretKeyMaterial(await keys.active());
        try {
          const envelope = encryptLocalSecretEnvelope(
            {
              projectId: request.projectId,
              name: request.name,
              version: request.expectedCurrentVersion + 1,
              mutationId: request.mutationId,
              keyId: material.keyId,
              algorithm: LOCAL_SECRET_ALGORITHM,
              createdAtMs: nowMs,
            },
            request.plaintext,
            material.key,
            options.nonceFactory,
          );
          const appended = await mutations.appendAuthorizedLocalSecretEnvelope({
            expectedCurrentVersion: request.expectedCurrentVersion,
            envelope,
            subject: principal.subject,
            fence: decision.fence,
            audit: allowedAudit,
          });
          if (
            appended.status === 'existing' &&
            !(await matchesExisting(
              { envelope: appended.envelope, audit: appended.audit },
              allowedAudit,
              request,
              keys,
            ))
          ) {
            throw new LocalSecretMutationConflictError();
          }
          return result(appended.status, appended.envelope);
        } finally {
          material.key.fill(0);
        }
      } catch (error) {
        if (
          error instanceof LocalSecretVersionConflictError ||
          error instanceof LocalSecretMutationConflictError ||
          error instanceof LocalSecretAuthorizationFenceConflictError ||
          error instanceof LocalSecretUnavailableError
        ) {
          throw error;
        }
        if (error instanceof SecurityAuditUnavailableError) {
          throw new LocalSecretAdministrationUnavailableError();
        }
        throw new LocalSecretAdministrationUnavailableError();
      }
    },
  });
}
