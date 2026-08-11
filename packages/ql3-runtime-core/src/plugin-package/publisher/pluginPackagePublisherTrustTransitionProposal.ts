import { createHash } from 'node:crypto';

import {
  normalizeApprovedActionDispatchRecord,
  normalizeApprovedActionFence,
  type ApprovedActionDispatchRecord,
} from '../../approved-action/approvedAction';
import {
  createPluginPackagePublisherTrustOverlapAdditionSnapshot,
  createPluginPackagePublisherTrustRetirementSnapshot,
  normalizePluginPackagePublisherTrustSnapshot,
  type PluginPackagePublisherTrustSnapshot,
} from './pluginPackagePublisherTrust';
import { normalizeProjectPolicySubject } from '../../security/project-policy/projectPolicy';
import {
  type SecurityAuthenticationAssurance,
  type SecurityPolicyFence,
  type SecuritySubject,
} from '../../security/security';
import type { SecurityAuditRecord } from '../../security/audit/securityAudit';

export const PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_PROPOSAL_SCHEMA =
  'qinglong/plugin-package-publisher-trust-transition-proposal@v1' as const;
export const PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_RECEIPT_SCHEMA =
  'qinglong/plugin-package-publisher-trust-transition-receipt@v1' as const;
export const PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_PERMISSION =
  'package.manage' as const;
export const PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_ACTION_TYPES =
  Object.freeze({
    overlap_add: 'plugin_package.publisher_key.overlap_add',
    safe_retire: 'plugin_package.publisher_key.safe_retire',
  } as const);

export type PluginPackagePublisherTrustTransitionMode =
  keyof typeof PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_ACTION_TYPES;
export type PluginPackagePublisherTrustTransitionActionType =
  (typeof PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_ACTION_TYPES)[PluginPackagePublisherTrustTransitionMode];

export interface PluginPackagePublisherTrustTransitionActionInput {
  readonly authorityProjectId: string;
  readonly trustAuthorityId: string;
  readonly trustGeneration: number;
  readonly mode: PluginPackagePublisherTrustTransitionMode;
  readonly publisher: string;
  readonly keyId: string;
  readonly previousTrustDigest: string;
  readonly currentTrustDigest: string;
}

export interface PluginPackagePublisherTrustTransitionProposal {
  readonly schema: typeof PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_PROPOSAL_SCHEMA;
  readonly actionRef: string;
  readonly projectId: string;
  readonly actionType: PluginPackagePublisherTrustTransitionActionType;
  readonly permission: typeof PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_PERMISSION;
  readonly actionInput: Readonly<PluginPackagePublisherTrustTransitionActionInput>;
  readonly actionDigest: string;
  readonly previewDigest: string;
  readonly proposedBy: Readonly<SecuritySubject>;
  readonly proposerAssurance: Extract<
    SecurityAuthenticationAssurance,
    'multi_factor' | 'hardware'
  >;
  readonly proposalFence: Readonly<SecurityPolicyFence>;
  readonly createdAtMs: number;
  readonly proposalDigest: string;
}

export interface PluginPackagePublisherTrustTransitionReceipt {
  readonly schema: typeof PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_RECEIPT_SCHEMA;
  readonly mutationId: string;
  readonly proposalDigest: string;
  readonly trustAuthorityId: string;
  readonly previousGeneration: number;
  readonly currentGeneration: number;
  readonly mode: PluginPackagePublisherTrustTransitionMode;
  readonly publisher: string;
  readonly keyId: string;
  readonly previousTrustDigest: string;
  readonly currentTrustDigest: string;
  readonly proposer: Readonly<SecuritySubject>;
  readonly confirmer: Readonly<SecuritySubject>;
  readonly retirementMatchingInstallations: 0 | null;
  readonly executedAtMs: number;
  readonly receiptDigest: string;
}

export type CreatePluginPackagePublisherTrustTransitionProposalInput =
  Readonly<{
    actionRef: string;
    authorityProjectId: string;
    trustAuthorityId: string;
    trustGeneration: number;
    mode: PluginPackagePublisherTrustTransitionMode;
    trustSnapshot: PluginPackagePublisherTrustSnapshot;
    materialSnapshot?: PluginPackagePublisherTrustSnapshot;
    publisher: string;
    keyId: string;
    proposedBy: SecuritySubject;
    proposerAssurance: SecurityAuthenticationAssurance;
    proposalFence: SecurityPolicyFence;
    createdAtMs: number;
  }>;

export interface CreatePluginPackagePublisherTrustTransitionProposalCommand {
  readonly proposal: PluginPackagePublisherTrustTransitionProposal;
  readonly candidateSnapshot: PluginPackagePublisherTrustSnapshot;
  readonly audit: SecurityAuditRecord;
}

export interface CreatePluginPackagePublisherTrustTransitionProposalResult {
  readonly status: 'created' | 'existing';
  readonly proposal: Readonly<PluginPackagePublisherTrustTransitionProposal>;
}

export interface PluginPackagePublisherTrustTransitionProposalRepository {
  findProposalByActionRef(
    actionRef: string,
  ): Promise<Readonly<PluginPackagePublisherTrustTransitionProposal> | null>;
  createProposal(
    command: CreatePluginPackagePublisherTrustTransitionProposalCommand,
  ): Promise<
    Readonly<CreatePluginPackagePublisherTrustTransitionProposalResult>
  >;
}

export class InvalidPluginPackagePublisherTrustTransitionError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_INVALID';

  constructor(message: string) {
    super(`Plugin Package publisher trust transition is invalid: ${message}`);
    this.name = 'InvalidPluginPackagePublisherTrustTransitionError';
  }
}

export class PluginPackagePublisherTrustTransitionBindingConflictError extends Error {
  readonly code =
    'PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_BINDING_CONFLICT';

  constructor() {
    super(
      'Plugin Package publisher trust transition does not match its dispatch',
    );
    this.name =
      'PluginPackagePublisherTrustTransitionBindingConflictError';
  }
}

export class PluginPackagePublisherTrustTransitionConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_CONFLICT';

  constructor() {
    super(
      'Plugin Package publisher trust transition conflicts with durable authority',
    );
    this.name = 'PluginPackagePublisherTrustTransitionConflictError';
  }
}

export class PluginPackagePublisherTrustTransitionUnavailableError extends Error {
  readonly code =
    'PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super(
      'Plugin Package publisher trust transition authority is unavailable',
      options,
    );
    this.name = 'PluginPackagePublisherTrustTransitionUnavailableError';
  }
}

const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PUBLISHER_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function invalid(message: string): never {
  throw new InvalidPluginPackagePublisherTrustTransitionError(message);
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
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
      ({ get, set, enumerable }) =>
        get !== undefined || set !== undefined || enumerable !== true,
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

function mode(value: unknown): PluginPackagePublisherTrustTransitionMode {
  if (value !== 'overlap_add' && value !== 'safe_retire') {
    return invalid('mode is invalid');
  }
  return value;
}

function strongAssurance(
  value: unknown,
): 'multi_factor' | 'hardware' {
  if (value !== 'multi_factor' && value !== 'hardware') {
    return invalid('proposerAssurance must be multi_factor or hardware');
  }
  return value;
}

function userSubject(
  value: SecuritySubject,
  label: string,
): Readonly<SecuritySubject> {
  const normalized = normalizeProjectPolicySubject(value);
  if (normalized.type !== 'user') {
    return invalid(`${label} must be a User`);
  }
  return normalized;
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
  value: PluginPackagePublisherTrustTransitionActionInput,
): Readonly<PluginPackagePublisherTrustTransitionActionInput> {
  const record = dataRecord(value, 'action input');
  exactKeys(
    record,
    [
      'authorityProjectId',
      'trustAuthorityId',
      'trustGeneration',
      'mode',
      'publisher',
      'keyId',
      'previousTrustDigest',
      'currentTrustDigest',
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
    return invalid('transition must change the trust digest');
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
    mode: mode(value.mode),
    publisher: publisher(value.publisher),
    keyId: identifier(value.keyId, 'keyId'),
    previousTrustDigest,
    currentTrustDigest,
  });
}

export function pluginPackagePublisherTrustTransitionActionDigest(
  value: PluginPackagePublisherTrustTransitionActionInput,
): string {
  return contractDigest(
    'qinglong/plugin-package-publisher-trust-transition-action-digest@v1',
    normalizeActionInput(value),
  );
}

export function pluginPackagePublisherTrustTransitionPreviewDigest(
  value: PluginPackagePublisherTrustTransitionActionInput,
): string {
  return contractDigest(
    'qinglong/plugin-package-publisher-trust-transition-preview-digest@v1',
    normalizeActionInput(value),
  );
}

function withProposalDigest(
  value: Omit<
    PluginPackagePublisherTrustTransitionProposal,
    'proposalDigest'
  >,
): Readonly<PluginPackagePublisherTrustTransitionProposal> {
  const normalized = Object.freeze(value);
  return Object.freeze({
    ...normalized,
    proposalDigest: contractDigest(
      'qinglong/plugin-package-publisher-trust-transition-proposal-digest@v1',
      normalized,
    ),
  });
}

export function createPluginPackagePublisherTrustTransitionProposal(
  inputValue: CreatePluginPackagePublisherTrustTransitionProposalInput,
): Readonly<{
  proposal: Readonly<PluginPackagePublisherTrustTransitionProposal>;
  candidateSnapshot: Readonly<PluginPackagePublisherTrustSnapshot>;
}> {
  const input = dataRecord(inputValue, 'proposal input');
  const optional = Object.hasOwn(input, 'materialSnapshot')
    ? ['materialSnapshot']
    : [];
  exactKeys(
    input,
    [
      'actionRef',
      'authorityProjectId',
      'trustAuthorityId',
      'trustGeneration',
      'mode',
      'trustSnapshot',
      'publisher',
      'keyId',
      'proposedBy',
      'proposerAssurance',
      'proposalFence',
      'createdAtMs',
      ...optional,
    ],
    'proposal input',
  );
  const transitionMode = mode(inputValue.mode);
  const trustSnapshot = normalizePluginPackagePublisherTrustSnapshot(
    inputValue.trustSnapshot,
  );
  const candidateSnapshot =
    transitionMode === 'overlap_add'
      ? createPluginPackagePublisherTrustOverlapAdditionSnapshot(
          trustSnapshot,
          inputValue.materialSnapshot ??
            invalid('overlap addition requires materialSnapshot'),
          inputValue.publisher,
          inputValue.keyId,
          inputValue.createdAtMs,
        )
      : (() => {
          if (inputValue.materialSnapshot !== undefined) {
            return invalid('retirement cannot accept materialSnapshot');
          }
          return createPluginPackagePublisherTrustRetirementSnapshot(
            trustSnapshot,
            inputValue.publisher,
            inputValue.keyId,
            inputValue.createdAtMs,
          );
        })();
  const actionInput = normalizeActionInput({
    authorityProjectId: inputValue.authorityProjectId,
    trustAuthorityId: inputValue.trustAuthorityId,
    trustGeneration: inputValue.trustGeneration,
    mode: transitionMode,
    publisher: inputValue.publisher,
    keyId: inputValue.keyId,
    previousTrustDigest: trustSnapshot.snapshotDigest,
    currentTrustDigest: candidateSnapshot.snapshotDigest,
  });
  const proposal = withProposalDigest({
    schema: PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_PROPOSAL_SCHEMA,
    actionRef: actionRef(inputValue.actionRef),
    projectId: actionInput.authorityProjectId,
    actionType:
      PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_ACTION_TYPES[
        transitionMode
      ],
    permission: PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_PERMISSION,
    actionInput,
    actionDigest:
      pluginPackagePublisherTrustTransitionActionDigest(actionInput),
    previewDigest:
      pluginPackagePublisherTrustTransitionPreviewDigest(actionInput),
    proposedBy: userSubject(inputValue.proposedBy, 'proposedBy'),
    proposerAssurance: strongAssurance(inputValue.proposerAssurance),
    proposalFence: normalizeApprovedActionFence(inputValue.proposalFence),
    createdAtMs: timestamp(inputValue.createdAtMs, 'createdAtMs'),
  });
  return Object.freeze({ proposal, candidateSnapshot });
}

export function normalizePluginPackagePublisherTrustTransitionProposal(
  value: PluginPackagePublisherTrustTransitionProposal,
): Readonly<PluginPackagePublisherTrustTransitionProposal> {
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
  const actionInput = normalizeActionInput(value.actionInput);
  if (
    value.schema !==
      PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_PROPOSAL_SCHEMA ||
    value.permission !==
      PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_PERMISSION ||
    value.actionType !==
      PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_ACTION_TYPES[
        actionInput.mode
      ]
  ) {
    return invalid('schema or action authority is invalid');
  }
  const normalized = withProposalDigest({
    schema: PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_PROPOSAL_SCHEMA,
    actionRef: actionRef(value.actionRef),
    projectId: projectId(value.projectId),
    actionType: value.actionType,
    permission: PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_PERMISSION,
    actionInput,
    actionDigest:
      pluginPackagePublisherTrustTransitionActionDigest(actionInput),
    previewDigest:
      pluginPackagePublisherTrustTransitionPreviewDigest(actionInput),
    proposedBy: userSubject(value.proposedBy, 'proposedBy'),
    proposerAssurance: strongAssurance(value.proposerAssurance),
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

function withReceiptDigest(
  value: Omit<
    PluginPackagePublisherTrustTransitionReceipt,
    'receiptDigest'
  >,
): Readonly<PluginPackagePublisherTrustTransitionReceipt> {
  const normalized = Object.freeze(value);
  return Object.freeze({
    ...normalized,
    receiptDigest: contractDigest(
      'qinglong/plugin-package-publisher-trust-transition-receipt-digest@v1',
      normalized,
    ),
  });
}

export function normalizePluginPackagePublisherTrustTransitionReceipt(
  value: PluginPackagePublisherTrustTransitionReceipt,
): Readonly<PluginPackagePublisherTrustTransitionReceipt> {
  const record = dataRecord(value, 'transition receipt');
  exactKeys(
    record,
    [
      'schema',
      'mutationId',
      'proposalDigest',
      'trustAuthorityId',
      'previousGeneration',
      'currentGeneration',
      'mode',
      'publisher',
      'keyId',
      'previousTrustDigest',
      'currentTrustDigest',
      'proposer',
      'confirmer',
      'retirementMatchingInstallations',
      'executedAtMs',
      'receiptDigest',
    ],
    'transition receipt',
  );
  const transitionMode = mode(value.mode);
  if (
    value.schema !==
      PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_RECEIPT_SCHEMA ||
    (transitionMode === 'overlap_add' &&
      value.retirementMatchingInstallations !== null) ||
    (transitionMode === 'safe_retire' &&
      value.retirementMatchingInstallations !== 0)
  ) {
    return invalid('transition receipt mode or retirement proof is invalid');
  }
  const previousGeneration = positiveInteger(
    value.previousGeneration,
    'previousGeneration',
  );
  const normalized = withReceiptDigest({
    schema: PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_RECEIPT_SCHEMA,
    mutationId: identifier(value.mutationId, 'mutationId'),
    proposalDigest: digest(value.proposalDigest, 'proposalDigest'),
    trustAuthorityId: identifier(
      value.trustAuthorityId,
      'trustAuthorityId',
    ),
    previousGeneration,
    currentGeneration: positiveInteger(
      value.currentGeneration,
      'currentGeneration',
    ),
    mode: transitionMode,
    publisher: publisher(value.publisher),
    keyId: identifier(value.keyId, 'keyId'),
    previousTrustDigest: digest(
      value.previousTrustDigest,
      'previousTrustDigest',
    ),
    currentTrustDigest: digest(
      value.currentTrustDigest,
      'currentTrustDigest',
    ),
    proposer: userSubject(value.proposer, 'proposer'),
    confirmer: userSubject(value.confirmer, 'confirmer'),
    retirementMatchingInstallations:
      value.retirementMatchingInstallations,
    executedAtMs: timestamp(value.executedAtMs, 'executedAtMs'),
  });
  if (
    normalized.currentGeneration !== previousGeneration + 1 ||
    normalized.previousTrustDigest === normalized.currentTrustDigest ||
    sameSubject(normalized.proposer, normalized.confirmer) ||
    digest(value.receiptDigest, 'receiptDigest') !==
      normalized.receiptDigest
  ) {
    return invalid('transition receipt derived binding is invalid');
  }
  return normalized;
}

export function resolvePluginPackagePublisherTrustTransitionProposal(
  proposalValue: PluginPackagePublisherTrustTransitionProposal,
  dispatchValue: ApprovedActionDispatchRecord,
  executedAtMsValue: number,
  retirementMatchingInstallationsValue: 0 | null,
): Readonly<PluginPackagePublisherTrustTransitionReceipt> {
  const proposal =
    normalizePluginPackagePublisherTrustTransitionProposal(proposalValue);
  const dispatch = normalizeApprovedActionDispatchRecord(dispatchValue);
  const executedAtMs = timestamp(executedAtMsValue, 'executedAtMs');
  const action = proposal.actionInput;
  if (
    dispatch.projectId !== proposal.projectId ||
    dispatch.action.actionRef !== proposal.actionRef ||
    dispatch.action.actionType !== proposal.actionType ||
    dispatch.action.permission !== proposal.permission ||
    dispatch.action.actionDigest !== proposal.actionDigest ||
    dispatch.action.previewDigest !== proposal.previewDigest ||
    !sameSubject(dispatch.requestedBy, proposal.proposedBy) ||
    sameSubject(dispatch.requestedBy, dispatch.approvedBy) ||
    (dispatch.approvalAssurance !== 'multi_factor' &&
      dispatch.approvalAssurance !== 'hardware') ||
    dispatch.createdAtMs < proposal.createdAtMs ||
    executedAtMs < dispatch.createdAtMs ||
    executedAtMs >= dispatch.expiresAtMs ||
    (action.mode === 'overlap_add' &&
      retirementMatchingInstallationsValue !== null) ||
    (action.mode === 'safe_retire' &&
      retirementMatchingInstallationsValue !== 0)
  ) {
    throw new PluginPackagePublisherTrustTransitionBindingConflictError();
  }
  return normalizePluginPackagePublisherTrustTransitionReceipt(
    withReceiptDigest({
      schema: PLUGIN_PACKAGE_PUBLISHER_TRUST_TRANSITION_RECEIPT_SCHEMA,
      mutationId: dispatch.id,
      proposalDigest: proposal.proposalDigest,
      trustAuthorityId: action.trustAuthorityId,
      previousGeneration: action.trustGeneration,
      currentGeneration: action.trustGeneration + 1,
      mode: action.mode,
      publisher: action.publisher,
      keyId: action.keyId,
      previousTrustDigest: action.previousTrustDigest,
      currentTrustDigest: action.currentTrustDigest,
      proposer: proposal.proposedBy,
      confirmer: dispatch.approvedBy,
      retirementMatchingInstallations:
        retirementMatchingInstallationsValue,
      executedAtMs,
    }),
  );
}
