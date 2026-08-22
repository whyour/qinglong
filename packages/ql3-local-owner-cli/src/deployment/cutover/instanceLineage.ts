import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { LocalDeploymentConfigurationError } from '../foundation/contract';
import {
  ensurePrivateDirectory,
  preflightPublishedFile,
  publishExactFile,
  replaceExactFile,
  validatePrivateDirectory,
} from '../foundation/files';
import { cutoverDigest } from './targetEvidence';

const HEAD_SCHEMA = 'qinglong3-local-cutover-instance-head';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ZERO_DIGEST = '0'.repeat(64);
const MAX_INSTANCES = 64;

export type LocalCutoverInstanceHeadState =
  | 'legacy_stop_requested'
  | 'legacy_stopped'
  | 'target_active'
  | 'target_stopped'
  | 'reconciliation_capture_prepared'
  | 'reconciliation_captured'
  | 'reconciliation_plan_prepared'
  | 'reconciliation_planned'
  | 'reconciliation_review_prepared'
  | 'reconciliation_reviewed'
  | 'reconciliation_application_prepared'
  | 'reconciliation_application_planned'
  | 'reconciliation_automation_planned'
  | 'reconciliation_automation_decision_prepared'
  | 'reconciliation_automation_reviewed'
  | 'rollback_prepared'
  | 'legacy_restart_requested'
  | 'legacy_running'
  | 'legacy_ready'
  | 'manual_required'
  | 'resolution_authorized';

export interface LocalCutoverIdentity {
  readonly options: Readonly<{ deploymentRoot: string }>;
  readonly request: Readonly<{
    cutoverId: string;
    profile: 'edge' | 'standalone';
    instanceId: string;
    expectedActivationDigest: string;
    requestedAtMs: number;
  }>;
}

export interface LocalCutoverInstanceHead {
  readonly schema: typeof HEAD_SCHEMA;
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly instanceId: string;
  readonly profile: 'edge' | 'standalone';
  readonly cutoverId: string;
  readonly activationDigest: string;
  readonly state: LocalCutoverInstanceHeadState;
  readonly generation: number;
  readonly previousHeadDigest: string;
  readonly sourceRecordDigest: string;
  readonly updatedAtMs: number;
  readonly headDigest: string;
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

function contents(head: Readonly<LocalCutoverInstanceHead>): string {
  return `${JSON.stringify(head, null, 2)}\n`;
}

function record(
  identity: Readonly<LocalCutoverIdentity>,
  revision: number,
  state: LocalCutoverInstanceHeadState,
  generation: number,
  previousHeadDigest: string,
  sourceRecordDigest: string,
): Readonly<LocalCutoverInstanceHead> {
  const payload = Object.freeze({
    schema: HEAD_SCHEMA,
    schemaVersion: 1 as const,
    revision,
    instanceId: identity.request.instanceId,
    profile: identity.request.profile,
    cutoverId: identity.request.cutoverId,
    activationDigest: identity.request.expectedActivationDigest,
    state,
    generation,
    previousHeadDigest,
    sourceRecordDigest,
    updatedAtMs: identity.request.requestedAtMs,
  });
  return Object.freeze({ ...payload, headDigest: cutoverDigest(payload) });
}

function parseHead(value: unknown): Readonly<LocalCutoverInstanceHead> {
  const head = object(value, 'cutover instance head');
  exact(
    head,
    [
      'activationDigest',
      'cutoverId',
      'generation',
      'headDigest',
      'instanceId',
      'previousHeadDigest',
      'profile',
      'revision',
      'schema',
      'schemaVersion',
      'sourceRecordDigest',
      'state',
      'updatedAtMs',
    ],
    'cutover instance head',
  );
  const { headDigest, ...payload } = head;
  if (
    head.schema !== HEAD_SCHEMA ||
    head.schemaVersion !== 1 ||
    !Number.isSafeInteger(head.revision) ||
    (head.revision as number) < 1 ||
    typeof head.instanceId !== 'string' ||
    (head.profile !== 'edge' && head.profile !== 'standalone') ||
    typeof head.cutoverId !== 'string' ||
    typeof head.activationDigest !== 'string' ||
    !DIGEST_PATTERN.test(head.activationDigest) ||
    (head.state !== 'legacy_stop_requested' &&
      head.state !== 'legacy_stopped' &&
      head.state !== 'target_active' &&
      head.state !== 'target_stopped' &&
      head.state !== 'reconciliation_capture_prepared' &&
      head.state !== 'reconciliation_captured' &&
      head.state !== 'reconciliation_plan_prepared' &&
      head.state !== 'reconciliation_planned' &&
      head.state !== 'reconciliation_review_prepared' &&
      head.state !== 'reconciliation_reviewed' &&
      head.state !== 'reconciliation_application_prepared' &&
      head.state !== 'reconciliation_application_planned' &&
      head.state !== 'reconciliation_automation_planned' &&
      head.state !== 'reconciliation_automation_decision_prepared' &&
      head.state !== 'reconciliation_automation_reviewed' &&
      head.state !== 'rollback_prepared' &&
      head.state !== 'legacy_restart_requested' &&
      head.state !== 'legacy_running' &&
      head.state !== 'legacy_ready' &&
      head.state !== 'manual_required' &&
      head.state !== 'resolution_authorized') ||
    !Number.isSafeInteger(head.generation) ||
    (head.generation as number) < 0 ||
    typeof head.previousHeadDigest !== 'string' ||
    !DIGEST_PATTERN.test(head.previousHeadDigest) ||
    typeof head.sourceRecordDigest !== 'string' ||
    !DIGEST_PATTERN.test(head.sourceRecordDigest) ||
    !Number.isSafeInteger(head.updatedAtMs) ||
    (head.updatedAtMs as number) < 0 ||
    typeof headDigest !== 'string' ||
    !DIGEST_PATTERN.test(headDigest) ||
    cutoverDigest(payload) !== headDigest
  ) {
    configurationError('cutover instance head drifted');
  }
  return head as unknown as Readonly<LocalCutoverInstanceHead>;
}

export function localCutoverInstanceDirectory(
  deploymentRoot: string,
  instanceId: string,
): string {
  return path.join(deploymentRoot, 'service', 'cutover-instances', instanceId);
}

export function localCutoverInstanceHeadPath(
  deploymentRoot: string,
  instanceId: string,
): string {
  return path.join(
    localCutoverInstanceDirectory(deploymentRoot, instanceId),
    'head.json',
  );
}

function ensureInstanceDirectory(
  identity: Readonly<LocalCutoverIdentity>,
  uid: number,
): string {
  const serviceRoot = path.join(identity.options.deploymentRoot, 'service');
  validatePrivateDirectory(
    identity.options.deploymentRoot,
    uid,
    'deploymentRoot',
  );
  validatePrivateDirectory(serviceRoot, uid, 'serviceDescriptorRoot');
  const root = path.join(serviceRoot, 'cutover-instances');
  ensurePrivateDirectory(root, uid, 'cutoverInstanceRoot');
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      configurationError('cutover instance catalog contains drift');
    }
  }
  const directory = localCutoverInstanceDirectory(
    identity.options.deploymentRoot,
    identity.request.instanceId,
  );
  if (entries.length >= MAX_INSTANCES && !fs.existsSync(directory)) {
    configurationError('cutover instance retention limit is reached');
  }
  ensurePrivateDirectory(directory, uid, 'cutoverInstanceDirectory');
  return directory;
}

export function readLocalCutoverInstanceHead(
  deploymentRoot: string,
  instanceId: string,
  uid: number,
): Readonly<LocalCutoverInstanceHead> {
  const directory = localCutoverInstanceDirectory(deploymentRoot, instanceId);
  validatePrivateDirectory(directory, uid, 'cutoverInstanceDirectory');
  return parseHead(
    readPrivateLocalCommandFile(
      localCutoverInstanceHeadPath(deploymentRoot, instanceId),
    ),
  );
}

function replaceHead(
  identity: Readonly<LocalCutoverIdentity>,
  uid: number,
  current: Readonly<LocalCutoverInstanceHead>,
  next: Readonly<LocalCutoverInstanceHead>,
): 'prepared' | 'existing' {
  return replaceExactFile(
    localCutoverInstanceHeadPath(
      identity.options.deploymentRoot,
      identity.request.instanceId,
    ),
    contents(current),
    contents(next),
    0o600,
    uid,
    'cutover instance head',
  );
}

export function claimLocalCutoverInstance(
  identity: Readonly<LocalCutoverIdentity>,
  uid: number,
  intentDigest: string,
): Readonly<LocalCutoverInstanceHead> {
  ensureInstanceDirectory(identity, uid);
  const headPath = localCutoverInstanceHeadPath(
    identity.options.deploymentRoot,
    identity.request.instanceId,
  );
  if (!fs.existsSync(headPath)) {
    const initial = record(
      identity,
      1,
      'legacy_stop_requested',
      0,
      ZERO_DIGEST,
      intentDigest,
    );
    const serialized = contents(initial);
    preflightPublishedFile(
      headPath,
      serialized,
      0o600,
      uid,
      'cutover instance head',
    );
    publishExactFile(headPath, serialized, 0o600, uid, 'cutover instance head');
  }
  const current = readLocalCutoverInstanceHead(
    identity.options.deploymentRoot,
    identity.request.instanceId,
    uid,
  );
  if (
    current.profile !== identity.request.profile ||
    current.cutoverId !== identity.request.cutoverId ||
    current.activationDigest !== identity.request.expectedActivationDigest
  ) {
    configurationError(
      'another cutover owns the instance; an explicit manual resolution is required',
    );
  }
  if (current.state !== 'resolution_authorized') return current;
  const next = record(
    identity,
    current.revision + 1,
    'legacy_stop_requested',
    0,
    current.headDigest,
    intentDigest,
  );
  replaceHead(identity, uid, current, next);
  return next;
}

export function advanceLocalCutoverInstanceHead(
  identity: Readonly<LocalCutoverIdentity>,
  uid: number,
  state:
    | 'legacy_stopped'
    | 'target_active'
    | 'target_stopped'
    | 'reconciliation_capture_prepared'
    | 'reconciliation_captured'
    | 'reconciliation_plan_prepared'
    | 'reconciliation_planned'
    | 'reconciliation_review_prepared'
    | 'reconciliation_reviewed'
    | 'reconciliation_application_prepared'
    | 'reconciliation_application_planned'
    | 'reconciliation_automation_planned'
    | 'reconciliation_automation_decision_prepared'
    | 'reconciliation_automation_reviewed'
    | 'rollback_prepared'
    | 'legacy_restart_requested'
    | 'legacy_running'
    | 'legacy_ready'
    | 'manual_required',
  generation: number,
  sourceRecordDigest: string,
): Readonly<LocalCutoverInstanceHead> {
  const current = readLocalCutoverInstanceHead(
    identity.options.deploymentRoot,
    identity.request.instanceId,
    uid,
  );
  if (
    current.profile !== identity.request.profile ||
    current.cutoverId !== identity.request.cutoverId ||
    current.activationDigest !== identity.request.expectedActivationDigest
  ) {
    configurationError('cutover instance head does not match the command');
  }
  if (
    current.state === state &&
    current.generation === generation &&
    current.sourceRecordDigest === sourceRecordDigest
  ) {
    return current;
  }
  if (
    current.state === 'target_active' &&
    state === 'target_active' &&
    current.generation > generation
  ) {
    return current;
  }
  if (
    state === 'target_stopped' &&
    current.generation === generation &&
    (current.state === 'rollback_prepared' ||
      current.state === 'reconciliation_capture_prepared' ||
      current.state === 'reconciliation_captured' ||
      current.state === 'reconciliation_plan_prepared' ||
      current.state === 'reconciliation_planned' ||
      current.state === 'reconciliation_review_prepared' ||
      current.state === 'reconciliation_reviewed' ||
      current.state === 'reconciliation_application_prepared' ||
      current.state === 'reconciliation_application_planned' ||
      current.state === 'reconciliation_automation_planned' ||
      current.state === 'reconciliation_automation_decision_prepared' ||
      current.state === 'reconciliation_automation_reviewed' ||
      current.state === 'legacy_restart_requested' ||
      current.state === 'legacy_running' ||
      current.state === 'legacy_ready')
  ) {
    return current;
  }
  if (current.state === 'manual_required') {
    configurationError('manual-required cutover instance head is terminal');
  }
  const allowed =
    (state === 'legacy_stopped' && current.state === 'legacy_stop_requested') ||
    (state === 'target_active' &&
      (current.state === 'legacy_stopped' ||
        current.state === 'target_active')) ||
    (state === 'target_stopped' && current.state === 'target_active') ||
    (state === 'reconciliation_capture_prepared' &&
      current.state === 'target_stopped') ||
    (state === 'reconciliation_captured' &&
      current.state === 'reconciliation_capture_prepared') ||
    (state === 'reconciliation_plan_prepared' &&
      current.state === 'reconciliation_captured') ||
    (state === 'reconciliation_planned' &&
      current.state === 'reconciliation_plan_prepared') ||
    (state === 'reconciliation_review_prepared' &&
      current.state === 'reconciliation_planned') ||
    (state === 'reconciliation_reviewed' &&
      current.state === 'reconciliation_review_prepared') ||
    (state === 'reconciliation_application_prepared' &&
      current.state === 'reconciliation_reviewed') ||
    (state === 'reconciliation_application_planned' &&
      current.state === 'reconciliation_application_prepared') ||
    (state === 'reconciliation_automation_planned' &&
      current.state === 'reconciliation_application_planned') ||
    (state === 'reconciliation_automation_decision_prepared' &&
      current.state === 'reconciliation_automation_planned') ||
    (state === 'reconciliation_automation_reviewed' &&
      current.state === 'reconciliation_automation_decision_prepared') ||
    (state === 'rollback_prepared' && current.state === 'target_stopped') ||
    (state === 'legacy_restart_requested' &&
      current.state === 'rollback_prepared') ||
    (state === 'legacy_running' &&
      current.state === 'legacy_restart_requested') ||
    (state === 'legacy_ready' && current.state === 'legacy_running') ||
    (state === 'manual_required' &&
      (current.state === 'legacy_stopped' ||
        current.state === 'target_active' ||
        current.state === 'rollback_prepared' ||
        current.state === 'legacy_restart_requested'));
  if (!allowed)
    configurationError('cutover instance head transition is invalid');
  const next = record(
    identity,
    current.revision + 1,
    state,
    generation,
    current.headDigest,
    sourceRecordDigest,
  );
  replaceHead(identity, uid, current, next);
  return next;
}

export function assertLocalCutoverTargetHead(
  identity: Readonly<LocalCutoverIdentity>,
  uid: number,
): Readonly<LocalCutoverInstanceHead> {
  const head = readLocalCutoverInstanceHead(
    identity.options.deploymentRoot,
    identity.request.instanceId,
    uid,
  );
  if (
    head.profile !== identity.request.profile ||
    head.cutoverId !== identity.request.cutoverId ||
    head.activationDigest !== identity.request.expectedActivationDigest ||
    (head.state !== 'legacy_stopped' &&
      head.state !== 'target_active' &&
      head.state !== 'manual_required')
  ) {
    configurationError(
      'target command is not bound to the instance lineage head',
    );
  }
  return head;
}

export function authorizeResolvedLocalCutoverInstance(
  currentIdentity: Readonly<LocalCutoverIdentity>,
  nextIdentity: Readonly<LocalCutoverIdentity>,
  uid: number,
  expectedHeadDigest: string,
  resolutionDigest: string,
): Readonly<LocalCutoverInstanceHead> {
  const current = readLocalCutoverInstanceHead(
    currentIdentity.options.deploymentRoot,
    currentIdentity.request.instanceId,
    uid,
  );
  if (
    current.headDigest !== expectedHeadDigest ||
    current.state !== 'manual_required' ||
    current.profile !== currentIdentity.request.profile ||
    current.cutoverId !== currentIdentity.request.cutoverId ||
    current.activationDigest !==
      currentIdentity.request.expectedActivationDigest
  ) {
    configurationError(
      'manual resolution lost the instance head compare-and-swap',
    );
  }
  const next = record(
    nextIdentity,
    current.revision + 1,
    'resolution_authorized',
    0,
    current.headDigest,
    resolutionDigest,
  );
  replaceHead(nextIdentity, uid, current, next);
  return next;
}
