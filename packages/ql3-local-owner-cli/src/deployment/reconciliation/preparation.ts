import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import { currentIdentity } from '../foundation/contract';
import { LocalDeploymentConfigurationError } from '../foundation/error';
import {
  ensurePrivateDirectory,
  preflightPublishedFile,
  publishExactFile,
  validatePrivateDirectory,
} from '../foundation/files';
import {
  advanceLocalCutoverInstanceHead,
  readLocalCutoverInstanceHead,
} from '../cutover/instanceLineage';
import { cutoverDigest } from '../cutover/targetEvidence';
import {
  normalizeLocalReconciliationCapturePrepareCommand,
  type LocalReconciliationCapturePrepareCommand,
  type LocalReconciliationCapturePrepareResult,
} from './contract';
import { proveLocalReconciliationStoppedState } from './stoppedProof';

const INTENT_SCHEMA = 'qinglong3-local-reconciliation-capture-intent';

interface LocalReconciliationCaptureIntent {
  readonly schema: typeof INTENT_SCHEMA;
  readonly schemaVersion: 1;
  readonly state: 'reconciliation_capture_prepared';
  readonly command: Readonly<LocalReconciliationCapturePrepareCommand>;
  readonly stoppedProofDigest: string;
  readonly reconciliationEvidenceDigest: string;
  readonly preparationDigest: string;
}

function configurationError(message: string): never {
  throw new LocalDeploymentConfigurationError(message);
}

export function localReconciliationCaptureDirectory(
  captureRoot: string,
  captureId: string,
): string {
  return path.join(captureRoot, captureId);
}

export function localReconciliationCaptureIntentPath(
  captureRoot: string,
  captureId: string,
): string {
  return path.join(
    localReconciliationCaptureDirectory(captureRoot, captureId),
    'intent.json',
  );
}

function intentContents(intent: Readonly<LocalReconciliationCaptureIntent>): string {
  return `${JSON.stringify(intent, null, 2)}\n`;
}

export function prepareLocalReconciliationCapture(
  input: unknown,
): Readonly<LocalReconciliationCapturePrepareResult> {
  const command = normalizeLocalReconciliationCapturePrepareCommand(input);
  const identity = currentIdentity();
  validatePrivateDirectory(
    command.options.deploymentRoot,
    identity.uid,
    'deploymentRoot',
  );
  validatePrivateDirectory(
    command.options.captureRoot,
    identity.uid,
    'captureRoot',
  );
  const head = readLocalCutoverInstanceHead(
    command.options.deploymentRoot,
    command.request.instanceId,
    identity.uid,
  );
  if (
    head.profile !== command.request.profile ||
    head.cutoverId !== command.request.cutoverId ||
    head.activationDigest !== command.request.expectedActivationDigest ||
    head.generation !== command.request.generation ||
    (head.state === 'target_stopped' &&
      (head.headDigest !== command.request.expectedHeadDigest ||
        head.sourceRecordDigest !==
          command.request.expectedStoppedRecordDigest)) ||
    (head.state !== 'target_stopped' &&
      head.state !== 'reconciliation_capture_prepared')
  ) {
    configurationError(
      'capture prepare lost the stopped instance head compare-and-swap',
    );
  }
  const proof = proveLocalReconciliationStoppedState(command, identity.uid);
  const payload = Object.freeze({
    schema: INTENT_SCHEMA,
    schemaVersion: 1 as const,
    state: 'reconciliation_capture_prepared' as const,
    command,
    stoppedProofDigest: proof.proofDigest,
    reconciliationEvidenceDigest: proof.reconciliationEvidenceDigest,
  });
  const intent: Readonly<LocalReconciliationCaptureIntent> = Object.freeze({
    ...payload,
    preparationDigest: cutoverDigest(payload),
  });
  if (
    head.state === 'reconciliation_capture_prepared' &&
    head.sourceRecordDigest !== intent.preparationDigest
  ) {
    configurationError('another capture owns the reconciliation fence');
  }
  const captureDirectory = localReconciliationCaptureDirectory(
    command.options.captureRoot,
    command.request.captureId,
  );
  ensurePrivateDirectory(captureDirectory, identity.uid, 'captureDirectory');
  ensurePrivateDirectory(
    path.join(captureDirectory, 'staging'),
    identity.uid,
    'captureStagingDirectory',
  );
  const intentPath = localReconciliationCaptureIntentPath(
    command.options.captureRoot,
    command.request.captureId,
  );
  const contents = intentContents(intent);
  preflightPublishedFile(
    intentPath,
    contents,
    0o600,
    identity.uid,
    'reconciliation capture intent',
  );
  const nextHead =
    head.state === 'reconciliation_capture_prepared'
      ? head
      : advanceLocalCutoverInstanceHead(
          {
            options: { deploymentRoot: command.options.deploymentRoot },
            request: {
              cutoverId: command.request.cutoverId,
              profile: command.request.profile,
              instanceId: command.request.instanceId,
              expectedActivationDigest:
                command.request.expectedActivationDigest,
              requestedAtMs: command.request.preparedAtMs,
            },
          },
          identity.uid,
          'reconciliation_capture_prepared',
          command.request.generation,
          intent.preparationDigest,
        );
  const status = publishExactFile(
    intentPath,
    contents,
    0o600,
    identity.uid,
    'reconciliation capture intent',
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status,
    state: 'reconciliation_capture_prepared' as const,
    captureId: command.request.captureId,
    preparationDigest: intent.preparationDigest,
    instanceHeadDigest: nextHead.headDigest,
  });
}

export function prepareLocalReconciliationCaptureCommandFile(
  filePath: string,
): Readonly<LocalReconciliationCapturePrepareResult> {
  return prepareLocalReconciliationCapture(readPrivateLocalCommandFile(filePath));
}
