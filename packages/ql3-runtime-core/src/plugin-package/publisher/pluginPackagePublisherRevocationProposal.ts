import { createHash } from 'node:crypto';

import {
  normalizeApprovedActionDispatchRecord,
  normalizeApprovedActionFence,
  type ApprovedActionDispatchRecord,
} from '../../approved-action/approvedAction';
import {
  createPluginPackagePublisherRevocationReceipt,
  type PluginPackagePublisherRevocationAuthorizationMode,
  type PluginPackagePublisherRevocationReason,
  type PluginPackagePublisherRevocationReceipt,
} from './pluginPackagePublisherProvenance';
import {
  normalizePluginPackagePublisherTrustSnapshot,
  pluginPackagePublisherTrustRevokedDigest,
  type PluginPackagePublisherTrustSnapshot,
} from './pluginPackagePublisherTrust';
import { normalizeProjectPolicySubject } from '../../security/project-policy/projectPolicy';
import {
  SECURITY_AUTHENTICATION_ASSURANCES,
  type SecurityAuthenticationAssurance,
  type SecurityPolicyFence,
  type SecuritySubject,
} from '../../security/security';
import type { SecurityAuditRecord } from '../../security/audit/securityAudit';

export const PLUGIN_PACKAGE_PUBLISHER_REVOCATION_PROPOSAL_SCHEMA =
  'qinglong/plugin-package-publisher-key-revocation-proposal@v1' as const;
export const PLUGIN_PACKAGE_PUBLISHER_REVOCATION_ACTION_TYPE =
  'plugin_package.publisher_key.revoke' as const;
export const PLUGIN_PACKAGE_PUBLISHER_REVOCATION_PERMISSION =
  'package.manage' as const;

export interface PluginPackagePublisherRevocationActionInput {
  readonly authorityProjectId: string;
  readonly trustAuthorityId: string;
  readonly trustGeneration: number;
  readonly publisher: string;
  readonly keyId: string;
  readonly previousTrustDigest: string;
  readonly currentTrustDigest: string;
  readonly authorizationMode: PluginPackagePublisherRevocationAuthorizationMode;
  readonly reasonCode: PluginPackagePublisherRevocationReason;
}

export interface PluginPackagePublisherRevocationProposal {
  readonly schema: typeof PLUGIN_PACKAGE_PUBLISHER_REVOCATION_PROPOSAL_SCHEMA;
  readonly actionRef: string;
  readonly projectId: string;
  readonly actionType: typeof PLUGIN_PACKAGE_PUBLISHER_REVOCATION_ACTION_TYPE;
  readonly permission: typeof PLUGIN_PACKAGE_PUBLISHER_REVOCATION_PERMISSION;
  readonly actionInput: Readonly<PluginPackagePublisherRevocationActionInput>;
  readonly actionDigest: string;
  readonly previewDigest: string;
  readonly proposedBy: Readonly<SecuritySubject>;
  readonly proposerAssurance: SecurityAuthenticationAssurance;
  readonly proposalFence: Readonly<SecurityPolicyFence>;
  readonly createdAtMs: number;
  readonly proposalDigest: string;
}

export interface CreatePluginPackagePublisherRevocationProposalInput {
  readonly actionRef: string;
  readonly authorityProjectId: string;
  readonly trustAuthorityId: string;
  readonly trustGeneration: number;
  readonly trustSnapshot: PluginPackagePublisherTrustSnapshot;
  readonly publisher: string;
  readonly keyId: string;
  readonly authorizationMode: PluginPackagePublisherRevocationAuthorizationMode;
  readonly reasonCode: PluginPackagePublisherRevocationReason;
  readonly proposedBy: SecuritySubject;
  readonly proposerAssurance: SecurityAuthenticationAssurance;
  readonly proposalFence: SecurityPolicyFence;
  readonly createdAtMs: number;
}

export interface CreatePluginPackagePublisherRevocationProposalCommand {
  readonly proposal: PluginPackagePublisherRevocationProposal;
  readonly audit: SecurityAuditRecord;
}

export interface CreatePluginPackagePublisherRevocationProposalResult {
  readonly status: 'created' | 'existing';
  readonly proposal: Readonly<PluginPackagePublisherRevocationProposal>;
}

export interface PluginPackagePublisherRevocationProposalRepository {
  findProposalByActionRef(
    actionRef: string,
  ): Promise<Readonly<PluginPackagePublisherRevocationProposal> | null>;
  createProposal(
    command: CreatePluginPackagePublisherRevocationProposalCommand,
  ): Promise<
    Readonly<CreatePluginPackagePublisherRevocationProposalResult>
  >;
}

export class InvalidPluginPackagePublisherRevocationProposalError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_PUBLISHER_REVOCATION_PROPOSAL_INVALID';

  constructor(message: string) {
    super(
      `Plugin Package publisher revocation proposal is invalid: ${message}`,
    );
    this.name =
      'InvalidPluginPackagePublisherRevocationProposalError';
  }
}

export class PluginPackagePublisherRevocationProposalBindingConflictError extends Error {
  readonly code =
    'PLUGIN_PACKAGE_PUBLISHER_REVOCATION_PROPOSAL_BINDING_CONFLICT';

  constructor() {
    super(
      'Plugin Package publisher revocation proposal does not match its dispatch',
    );
    this.name =
      'PluginPackagePublisherRevocationProposalBindingConflictError';
  }
}

export class PluginPackagePublisherRevocationProposalConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PUBLISHER_REVOCATION_PROPOSAL_CONFLICT';

  constructor() {
    super(
      'Plugin Package publisher revocation proposal conflicts with durable authority',
    );
    this.name =
      'PluginPackagePublisherRevocationProposalConflictError';
  }
}

export class PluginPackagePublisherRevocationProposalUnavailableError extends Error {
  readonly code =
    'PLUGIN_PACKAGE_PUBLISHER_REVOCATION_PROPOSAL_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super(
      'Plugin Package publisher revocation proposal authority is unavailable',
      options,
    );
    this.name =
      'PluginPackagePublisherRevocationProposalUnavailableError';
  }
}

const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PUBLISHER_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function invalid(message: string): never {
  throw new InvalidPluginPackagePublisherRevocationProposalError(message);
}

function dataRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    )
  ) {
    return invalid(`${label} must contain enumerable data properties`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(value);
  const canonical = [...expected].sort();
  if (
    actual.some((key) => typeof key !== 'string') ||
    actual.length !== canonical.length ||
    actual
      .map(String)
      .sort()
      .some((key, index) => key !== canonical[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function actionRef(value: unknown): string {
  if (typeof value !== 'string' || !ACTION_REF_PATTERN.test(value)) {
    return invalid('actionRef is invalid');
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function publisher(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 253 ||
    !PUBLISHER_PATTERN.test(value)
  ) {
    return invalid('publisher is invalid');
  }
  return value;
}

function projectId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    value.includes('\0')
  ) {
    return invalid('authorityProjectId is invalid');
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function authorizationMode(
  value: unknown,
): PluginPackagePublisherRevocationAuthorizationMode {
  if (value !== 'dual_control' && value !== 'break_glass') {
    return invalid('authorizationMode is invalid');
  }
  return value;
}

function reasonCode(
  value: unknown,
): PluginPackagePublisherRevocationReason {
  if (
    value !== 'suspected_key_compromise' &&
    value !== 'confirmed_key_compromise'
  ) {
    return invalid('reasonCode is invalid');
  }
  return value;
}

function assurance(value: unknown): SecurityAuthenticationAssurance {
  if (
    typeof value !== 'string' ||
    !SECURITY_AUTHENTICATION_ASSURANCES.includes(
      value as SecurityAuthenticationAssurance,
    )
  ) {
    return invalid('proposerAssurance is invalid');
  }
  return value as SecurityAuthenticationAssurance;
}

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

function contractDigest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(JSON.stringify(value))
    .digest('hex');
}

function normalizeActionInput(
  value: PluginPackagePublisherRevocationActionInput,
): Readonly<PluginPackagePublisherRevocationActionInput> {
  const record = dataRecord(value, 'action input');
  exactKeys(
    record,
    [
      'authorityProjectId',
      'trustAuthorityId',
      'trustGeneration',
      'publisher',
      'keyId',
      'previousTrustDigest',
      'currentTrustDigest',
      'authorizationMode',
      'reasonCode',
    ],
    'action input',
  );
  const previousTrustDigest = digest(
    value.previousTrustDigest,
    'previousTrustDigest',
  );
  const currentTrustDigest = digest(
    value.currentTrustDigest,
    'currentTrustDigest',
  );
  if (previousTrustDigest === currentTrustDigest) {
    return invalid('revocation must change the trust digest');
  }
  return Object.freeze({
    authorityProjectId: projectId(value.authorityProjectId),
    trustAuthorityId: identifier(
      value.trustAuthorityId,
      'trustAuthorityId',
    ),
    trustGeneration: positiveInteger(
      value.trustGeneration,
      'trustGeneration',
    ),
    publisher: publisher(value.publisher),
    keyId: identifier(value.keyId, 'keyId'),
    previousTrustDigest,
    currentTrustDigest,
    authorizationMode: authorizationMode(value.authorizationMode),
    reasonCode: reasonCode(value.reasonCode),
  });
}

export function pluginPackagePublisherRevocationActionDigest(
  value: PluginPackagePublisherRevocationActionInput,
): string {
  return contractDigest(
    'qinglong/plugin-package-publisher-key-revocation-action-digest@v1',
    normalizeActionInput(value),
  );
}

export function pluginPackagePublisherRevocationPreviewDigest(
  value: PluginPackagePublisherRevocationActionInput,
): string {
  const input = normalizeActionInput(value);
  return contractDigest(
    'qinglong/plugin-package-publisher-key-revocation-preview-digest@v1',
    {
      authorityProjectId: input.authorityProjectId,
      trustAuthorityId: input.trustAuthorityId,
      trustGeneration: input.trustGeneration,
      publisher: input.publisher,
      keyId: input.keyId,
      previousTrustDigest: input.previousTrustDigest,
      currentTrustDigest: input.currentTrustDigest,
      authorizationMode: input.authorizationMode,
      reasonCode: input.reasonCode,
    },
  );
}

function withProposalDigest(
  value: Omit<
    PluginPackagePublisherRevocationProposal,
    'proposalDigest'
  >,
): Readonly<PluginPackagePublisherRevocationProposal> {
  const normalized = Object.freeze(value);
  return Object.freeze({
    ...normalized,
    proposalDigest: contractDigest(
      'qinglong/plugin-package-publisher-key-revocation-proposal-digest@v1',
      normalized,
    ),
  });
}

export function createPluginPackagePublisherRevocationProposal(
  inputValue: CreatePluginPackagePublisherRevocationProposalInput,
): Readonly<PluginPackagePublisherRevocationProposal> {
  const input = dataRecord(inputValue, 'proposal input');
  exactKeys(
    input,
    [
      'actionRef',
      'authorityProjectId',
      'trustAuthorityId',
      'trustGeneration',
      'trustSnapshot',
      'publisher',
      'keyId',
      'authorizationMode',
      'reasonCode',
      'proposedBy',
      'proposerAssurance',
      'proposalFence',
      'createdAtMs',
    ],
    'proposal input',
  );
  const trustSnapshot = normalizePluginPackagePublisherTrustSnapshot(
    inputValue.trustSnapshot,
  );
  const actionInput = normalizeActionInput({
    authorityProjectId: inputValue.authorityProjectId,
    trustAuthorityId: inputValue.trustAuthorityId,
    trustGeneration: inputValue.trustGeneration,
    publisher: inputValue.publisher,
    keyId: inputValue.keyId,
    previousTrustDigest: trustSnapshot.snapshotDigest,
    currentTrustDigest: pluginPackagePublisherTrustRevokedDigest(
      trustSnapshot,
      inputValue.publisher,
      inputValue.keyId,
    ),
    authorizationMode: inputValue.authorizationMode,
    reasonCode: inputValue.reasonCode,
  });
  const proposerAssurance = assurance(inputValue.proposerAssurance);
  if (
    actionInput.authorizationMode === 'break_glass' &&
    proposerAssurance !== 'hardware'
  ) {
    return invalid('break-glass proposer must use hardware assurance');
  }
  const proposedBy = normalizeProjectPolicySubject(inputValue.proposedBy);
  return withProposalDigest({
    schema: PLUGIN_PACKAGE_PUBLISHER_REVOCATION_PROPOSAL_SCHEMA,
    actionRef: actionRef(inputValue.actionRef),
    projectId: actionInput.authorityProjectId,
    actionType: PLUGIN_PACKAGE_PUBLISHER_REVOCATION_ACTION_TYPE,
    permission: PLUGIN_PACKAGE_PUBLISHER_REVOCATION_PERMISSION,
    actionInput,
    actionDigest:
      pluginPackagePublisherRevocationActionDigest(actionInput),
    previewDigest:
      pluginPackagePublisherRevocationPreviewDigest(actionInput),
    proposedBy,
    proposerAssurance,
    proposalFence: normalizeApprovedActionFence(
      inputValue.proposalFence,
    ),
    createdAtMs: timestamp(inputValue.createdAtMs, 'createdAtMs'),
  });
}

export function normalizePluginPackagePublisherRevocationProposal(
  value: PluginPackagePublisherRevocationProposal,
): Readonly<PluginPackagePublisherRevocationProposal> {
  const record = dataRecord(value, 'proposal');
  exactKeys(
    record,
    [
      'schema',
      'actionRef',
      'projectId',
      'actionType',
      'permission',
      'actionInput',
      'actionDigest',
      'previewDigest',
      'proposedBy',
      'proposerAssurance',
      'proposalFence',
      'createdAtMs',
      'proposalDigest',
    ],
    'proposal',
  );
  if (
    value.schema !==
      PLUGIN_PACKAGE_PUBLISHER_REVOCATION_PROPOSAL_SCHEMA ||
    value.actionType !==
      PLUGIN_PACKAGE_PUBLISHER_REVOCATION_ACTION_TYPE ||
    value.permission !==
      PLUGIN_PACKAGE_PUBLISHER_REVOCATION_PERMISSION
  ) {
    return invalid('schema or action authority is invalid');
  }
  const actionInput = normalizeActionInput(value.actionInput);
  const proposedBy = normalizeProjectPolicySubject(value.proposedBy);
  const proposerAssurance = assurance(value.proposerAssurance);
  if (
    actionInput.authorizationMode === 'break_glass' &&
    proposerAssurance !== 'hardware'
  ) {
    return invalid('break-glass proposer must use hardware assurance');
  }
  const normalized = withProposalDigest({
    schema: PLUGIN_PACKAGE_PUBLISHER_REVOCATION_PROPOSAL_SCHEMA,
    actionRef: actionRef(value.actionRef),
    projectId: projectId(value.projectId),
    actionType: PLUGIN_PACKAGE_PUBLISHER_REVOCATION_ACTION_TYPE,
    permission: PLUGIN_PACKAGE_PUBLISHER_REVOCATION_PERMISSION,
    actionInput,
    actionDigest:
      pluginPackagePublisherRevocationActionDigest(actionInput),
    previewDigest:
      pluginPackagePublisherRevocationPreviewDigest(actionInput),
    proposedBy,
    proposerAssurance,
    proposalFence: normalizeApprovedActionFence(value.proposalFence),
    createdAtMs: timestamp(value.createdAtMs, 'createdAtMs'),
  });
  if (
    normalized.projectId !== actionInput.authorityProjectId ||
    digest(value.actionDigest, 'actionDigest') !==
      normalized.actionDigest ||
    digest(value.previewDigest, 'previewDigest') !==
      normalized.previewDigest ||
    digest(value.proposalDigest, 'proposalDigest') !==
      normalized.proposalDigest
  ) {
    return invalid('proposal digest or derived binding is invalid');
  }
  return normalized;
}

export function resolvePluginPackagePublisherRevocationProposal(
  proposalValue: PluginPackagePublisherRevocationProposal,
  dispatchValue: ApprovedActionDispatchRecord,
  revokedAtMsValue: number,
): Readonly<PluginPackagePublisherRevocationReceipt> {
  const proposal =
    normalizePluginPackagePublisherRevocationProposal(proposalValue);
  const dispatch = normalizeApprovedActionDispatchRecord(dispatchValue);
  const revokedAtMs = timestamp(revokedAtMsValue, 'revokedAtMs');
  const action = proposal.actionInput;
  if (
    dispatch.projectId !== proposal.projectId ||
    dispatch.action.actionRef !== proposal.actionRef ||
    dispatch.action.actionType !== proposal.actionType ||
    dispatch.action.permission !== proposal.permission ||
    dispatch.action.actionDigest !== proposal.actionDigest ||
    dispatch.action.previewDigest !== proposal.previewDigest ||
    !sameSubject(dispatch.requestedBy, proposal.proposedBy) ||
    dispatch.createdAtMs < proposal.createdAtMs ||
    revokedAtMs < dispatch.createdAtMs ||
    revokedAtMs >= dispatch.expiresAtMs ||
    (action.authorizationMode === 'dual_control' &&
      sameSubject(dispatch.requestedBy, dispatch.approvedBy)) ||
    (action.authorizationMode === 'break_glass' &&
      (proposal.proposerAssurance !== 'hardware' ||
        dispatch.approvalAssurance !== 'hardware'))
  ) {
    throw new PluginPackagePublisherRevocationProposalBindingConflictError();
  }
  return createPluginPackagePublisherRevocationReceipt({
    mutationId: dispatch.id,
    publisher: action.publisher,
    keyId: action.keyId,
    previousTrustDigest: action.previousTrustDigest,
    currentTrustDigest: action.currentTrustDigest,
    proposer: proposal.proposedBy,
    confirmer: dispatch.approvedBy,
    authorizationMode: action.authorizationMode,
    reasonCode: action.reasonCode,
    revokedAtMs,
  });
}
