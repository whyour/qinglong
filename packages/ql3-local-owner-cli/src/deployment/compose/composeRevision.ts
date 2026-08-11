import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

import {
  currentIdentity,
  LocalDeploymentConfigurationError,
  normalizeLocalDeploymentComposeRevisionCommand,
  type LocalDeploymentComposeRevisionCommand,
  type LocalDeploymentComposeRevisionResult,
  type LocalDeploymentPrepareCommand,
} from '../foundation/contract';
import {
  preflightPublishedFile,
  publishExactFile,
  replaceExactFile,
  syncPublishedDirectory,
  validatePrivateDirectory,
} from '../foundation/files';
import { deploymentPaths } from '../foundation/render';

const SELECTION_SCHEMA = 'qinglong/local-compose-image-selection@v1';
const IMAGE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}@sha256:[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ComposeImageSelection {
  readonly generation: number;
  readonly previousGeneration: number;
  readonly rollbackTargetGeneration: number;
  readonly mutationId: string;
  readonly changedAtMs: number;
  readonly image: string;
}

function selectionContents(selection: Readonly<ComposeImageSelection>): string {
  return [
    'x-qinglong-image-selection:',
    `  schema: ${SELECTION_SCHEMA}`,
    `  generation: ${selection.generation}`,
    `  previous_generation: ${selection.previousGeneration}`,
    `  rollback_target_generation: ${selection.rollbackTargetGeneration}`,
    `  mutation_id: ${selection.mutationId}`,
    `  changed_at_ms: ${selection.changedAtMs}`,
    'services:',
    '  qinglong3:',
    `    image: ${selection.image}`,
    '    labels:',
    `      io.qinglong.deployment.generation: "${selection.generation}"`,
    `      io.qinglong.deployment.mutation: "${selection.mutationId}"`,
    '',
  ].join('\n');
}

function parseInteger(value: string | undefined, label: string): number {
  if (!value || !/^(0|[1-9][0-9]{0,5})$/.test(value)) {
    throw new LocalDeploymentConfigurationError(`${label} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 100_000) {
    throw new LocalDeploymentConfigurationError(`${label} is invalid`);
  }
  return parsed;
}

function parseSelection(
  contents: string,
  label: string,
): Readonly<ComposeImageSelection> {
  const match =
    /^x-qinglong-image-selection:\n  schema: qinglong\/local-compose-image-selection@v1\n  generation: (0|[1-9][0-9]{0,5})\n  previous_generation: (0|[1-9][0-9]{0,5})\n  rollback_target_generation: (0|[1-9][0-9]{0,5})\n  mutation_id: ([0-9a-f-]+)\n  changed_at_ms: ([0-9]+)\nservices:\n  qinglong3:\n    image: ([^\n]+)\n    labels:\n      io\.qinglong\.deployment\.generation: "([0-9]+)"\n      io\.qinglong\.deployment\.mutation: "([0-9a-f-]+)"\n$/.exec(
      contents,
    );
  if (!match) {
    throw new LocalDeploymentConfigurationError(`${label} shape is invalid`);
  }
  const generation = parseInteger(match[1], `${label} generation`);
  const previousGeneration = parseInteger(
    match[2],
    `${label} previous generation`,
  );
  const rollbackTargetGeneration = parseInteger(
    match[3],
    `${label} rollback target generation`,
  );
  const mutationId = match[4];
  const changedAtMs = Number(match[5]);
  const image = match[6];
  const labelGeneration = Number(match[7]);
  const labelMutationId = match[8];
  if (
    generation < 1 ||
    previousGeneration !== generation - 1 ||
    rollbackTargetGeneration >= generation ||
    !Number.isSafeInteger(changedAtMs) ||
    changedAtMs < 0 ||
    !mutationId ||
    !UUID_V4_PATTERN.test(mutationId) ||
    !image ||
    !IMAGE_PATTERN.test(image) ||
    image.includes('..') ||
    image.includes('//') ||
    labelGeneration !== generation ||
    labelMutationId !== mutationId
  ) {
    throw new LocalDeploymentConfigurationError(`${label} value is invalid`);
  }
  const selection = Object.freeze({
    generation,
    previousGeneration,
    rollbackTargetGeneration,
    mutationId,
    changedAtMs,
    image,
  });
  if (selectionContents(selection) !== contents) {
    throw new LocalDeploymentConfigurationError(`${label} is not canonical`);
  }
  return selection;
}

function readSelectionFile(
  filePath: string,
  uid: number,
  label: string,
): Readonly<{ contents: string; selection: Readonly<ComposeImageSelection> }> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new LocalDeploymentConfigurationError(`${label} is unavailable`, {
      cause: error,
    });
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.nlink !== 1 ||
    stat.size < 2 ||
    stat.size > 64 * 1024
  ) {
    throw new LocalDeploymentConfigurationError(`${label} identity is invalid`);
  }
  const contents = fs.readFileSync(filePath, 'utf8');
  return Object.freeze({
    contents,
    selection: parseSelection(contents, label),
  });
}

function revisionPath(root: string, generation: number): string {
  return path.join(root, `${generation}.yaml`);
}

function commandIntent(
  command: Readonly<LocalDeploymentComposeRevisionCommand>,
): string {
  return `${JSON.stringify(command, null, 2)}\n`;
}

function releaseLock(lockPath: string, intent: string, uid: number): void {
  preflightPublishedFile(lockPath, intent, 0o600, uid, 'compose revision lock');
  fs.unlinkSync(lockPath);
  syncPublishedDirectory(path.dirname(lockPath));
}

export function initialComposeImageSelection(
  command: Readonly<LocalDeploymentPrepareCommand>,
): string {
  if (command.options.service.kind !== 'compose') {
    throw new LocalDeploymentConfigurationError(
      'initial compose selection requires a compose service',
    );
  }
  return selectionContents({
    generation: 1,
    previousGeneration: 0,
    rollbackTargetGeneration: 0,
    mutationId: command.request.activateMutationId,
    changedAtMs: command.request.activatedAtMs,
    image: command.options.service.image,
  });
}

export function preflightActiveComposeImageSelection(
  selectionPath: string,
  revisionsRoot: string,
  initialContents: string,
  uid: number,
): 'absent' | 'existing' {
  if (!fs.existsSync(selectionPath)) return 'absent';
  const active = readSelectionFile(
    selectionPath,
    uid,
    'active compose selection',
  );
  if (active.selection.generation === 1) {
    if (active.contents !== initialContents) {
      throw new LocalDeploymentConfigurationError(
        'initial compose selection drifted',
      );
    }
    return 'existing';
  }
  const revision = readSelectionFile(
    revisionPath(revisionsRoot, active.selection.generation),
    uid,
    'active compose revision',
  );
  if (
    revision.selection.generation !== active.selection.generation ||
    revision.contents !== active.contents
  ) {
    throw new LocalDeploymentConfigurationError(
      'active compose selection is not backed by its immutable revision',
    );
  }
  return 'existing';
}

export function inspectActiveComposeImageSelection(
  selectionPath: string,
  revisionsRoot: string,
  uid: number,
): Readonly<ComposeImageSelection> {
  const active = readSelectionFile(
    selectionPath,
    uid,
    'active compose selection',
  );
  const revision = readSelectionFile(
    revisionPath(revisionsRoot, active.selection.generation),
    uid,
    'active compose revision',
  );
  if (
    revision.selection.generation !== active.selection.generation ||
    revision.contents !== active.contents
  ) {
    throw new LocalDeploymentConfigurationError(
      'active compose selection is not backed by its immutable revision',
    );
  }
  return active.selection;
}

export function inspectComposeImageSelectionGeneration(
  revisionsRoot: string,
  generation: number,
  uid: number,
): Readonly<ComposeImageSelection> {
  const revision = readSelectionFile(
    revisionPath(revisionsRoot, generation),
    uid,
    'compose revision',
  );
  if (revision.selection.generation !== generation) {
    throw new LocalDeploymentConfigurationError(
      'compose revision generation drifted',
    );
  }
  return revision.selection;
}

export async function switchLocalDeploymentComposeRevision(
  input: unknown,
  rolloutLockIntent?: string,
): Promise<Readonly<LocalDeploymentComposeRevisionResult>> {
  const command = normalizeLocalDeploymentComposeRevisionCommand(input);
  const identity = currentIdentity();
  const paths = deploymentPaths(command.options.deploymentRoot);
  validatePrivateDirectory(
    command.options.deploymentRoot,
    identity.uid,
    'deploymentRoot',
  );
  validatePrivateDirectory(
    paths.service,
    identity.uid,
    'serviceDescriptorRoot',
  );
  validatePrivateDirectory(
    paths.composeRevisions,
    identity.uid,
    'composeRevisionRoot',
  );
  if (fs.existsSync(paths.composeEvidenceCollectionLock)) {
    throw new LocalDeploymentConfigurationError(
      'compose revision is fenced by an evidence collection',
    );
  }
  if (fs.existsSync(paths.composeRolloutLock)) {
    if (rolloutLockIntent === undefined) {
      throw new LocalDeploymentConfigurationError(
        'compose revision is fenced by an in-flight rollout',
      );
    }
    preflightPublishedFile(
      paths.composeRolloutLock,
      rolloutLockIntent,
      0o600,
      identity.uid,
      'compose rollout lock',
    );
  }

  const observed = readSelectionFile(
    paths.composeSelection,
    identity.uid,
    'active compose selection',
  );
  const nextGeneration = command.request.expectedGeneration + 1;
  let image: string;
  let rollbackTargetGeneration = 0;
  if (command.operation === 'local.deployment.compose.upgrade') {
    image = command.request.image;
  } else {
    rollbackTargetGeneration = command.request.targetGeneration;
    const target = readSelectionFile(
      revisionPath(paths.composeRevisions, command.request.targetGeneration),
      identity.uid,
      'rollback target compose revision',
    );
    if (target.selection.generation !== command.request.targetGeneration) {
      throw new LocalDeploymentConfigurationError(
        'rollback target generation drifted',
      );
    }
    image = target.selection.image;
  }
  const nextContents = selectionContents({
    generation: nextGeneration,
    previousGeneration: command.request.expectedGeneration,
    rollbackTargetGeneration,
    mutationId: command.request.mutationId,
    changedAtMs: command.request.changedAtMs,
    image,
  });
  if (command.request.changedAtMs < observed.selection.changedAtMs) {
    throw new LocalDeploymentConfigurationError(
      'compose revision time precedes the active selection',
    );
  }
  const exactReplay =
    observed.selection.generation === nextGeneration &&
    observed.contents === nextContents;
  if (
    !exactReplay &&
    observed.selection.generation !== command.request.expectedGeneration
  ) {
    throw new LocalDeploymentConfigurationError(
      'active compose generation does not match expectedGeneration',
    );
  }

  const intent = commandIntent(command);
  publishExactFile(
    paths.composeRevisionLock,
    intent,
    0o600,
    identity.uid,
    'compose revision lock',
  );
  if (fs.existsSync(paths.composeEvidenceCollectionLock)) {
    releaseLock(paths.composeRevisionLock, intent, identity.uid);
    throw new LocalDeploymentConfigurationError(
      'compose revision is fenced by an evidence collection',
    );
  }
  const current = readSelectionFile(
    paths.composeSelection,
    identity.uid,
    'active compose selection',
  );
  if (
    current.contents !== observed.contents &&
    current.contents !== nextContents
  ) {
    throw new LocalDeploymentConfigurationError(
      'active compose selection changed while acquiring revision lock',
    );
  }
  const revisionStatus = publishExactFile(
    revisionPath(paths.composeRevisions, nextGeneration),
    nextContents,
    0o600,
    identity.uid,
    'compose revision',
  );
  const switchStatus =
    current.contents === nextContents
      ? ('existing' as const)
      : replaceExactFile(
          paths.composeSelection,
          observed.contents,
          nextContents,
          0o600,
          identity.uid,
          'active compose selection',
        );
  releaseLock(paths.composeRevisionLock, intent, identity.uid);

  return Object.freeze({
    schemaVersion: 1 as const,
    operation: command.operation,
    status:
      revisionStatus === 'existing' && switchStatus === 'existing'
        ? ('existing' as const)
        : ('prepared' as const),
    generation: nextGeneration,
    service: Object.freeze({ kind: 'compose' as const }),
  });
}

export function switchLocalDeploymentComposeRevisionCommandFile(
  filePath: string,
): Promise<Readonly<LocalDeploymentComposeRevisionResult>> {
  return switchLocalDeploymentComposeRevision(
    readPrivateLocalCommandFile(filePath),
  );
}
