import fs from 'node:fs';
import path from 'node:path';

import { LocalDataDirectoryAdoptionConfigurationError } from '../contract';
import { sortedNames, syncDirectory } from '../filesystem';
import { sha256Text } from '../manifest';
import type { ConfigTransformation, SecretImportDraft } from './config';
import {
  readStablePrivateUtf8File,
  summarizePrivateTree,
  writePrivateJson,
  type PrivateTreeEvidence,
} from './files';
import type { KeyvTransformation } from './keyv';
import type { SshTransformation } from './ssh';

const MAX_MODEL_FILE_BYTES = 1024 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SECRET_FILE_PATTERN = /^secret-values\/[0-9a-f]{64}\.json$/;

export interface TransformationSourceEvidence extends PrivateTreeEvidence {
  readonly name: 'config' | 'keyv' | 'ssh';
  readonly present: boolean;
  readonly assessment: 'ready' | 'manual_required';
}

export interface TransformationModelEvidence extends PrivateTreeEvidence {
  readonly environmentSecrets: number;
  readonly sshSecrets: number;
  readonly manualCategories: number;
}

export interface LocalDataDirectoryTransformationManifestPayload {
  readonly schemaVersion: 1;
  readonly kind: 'qinglong3-legacy-data-directory-transformation';
  readonly state: 'prepared';
  readonly profile: 'edge' | 'standalone';
  readonly createdAtMs: number;
  readonly projectIdDigest: string;
  readonly sourceStageManifestDigest: string;
  readonly transformationRootPathDigest: string;
  readonly assessment: 'ready' | 'manual_required';
  readonly sources: readonly TransformationSourceEvidence[];
  readonly model: Readonly<TransformationModelEvidence>;
}

export interface LocalDataDirectoryTransformationManifest
  extends LocalDataDirectoryTransformationManifestPayload {
  readonly transformationDigest: string;
}

interface SecretImportEntry {
  readonly kind: SecretImportDraft['kind'];
  readonly sourceName: string;
  readonly targetName: string;
  readonly expectedCurrentVersion: 0;
  readonly valueFile: string;
  readonly valueDigest: string;
}

export interface VerifiedTransformationSecret extends SecretImportEntry {
  readonly plaintext: string;
}

export interface VerifiedTransformationModel {
  readonly model: Readonly<{
    schema: 'qinglong/legacy-data-directory-applied-model@v1';
    activation: 'disabled';
    config: Readonly<Record<string, unknown>>;
    keyv: Readonly<Record<string, unknown>>;
    ssh: Readonly<Record<string, unknown>>;
    manualReview: Readonly<Record<string, unknown>>;
  }>;
  readonly secrets: readonly Readonly<VerifiedTransformationSecret>[];
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function emptyEvidence(): Readonly<PrivateTreeEvidence> {
  return Object.freeze({
    entries: 0,
    directories: 0,
    files: 0,
    bytes: 0,
    digest: sha256Text(''),
  });
}

function sourceEvidence(
  name: TransformationSourceEvidence['name'],
  transformation:
    | Readonly<ConfigTransformation>
    | Readonly<KeyvTransformation>
    | Readonly<SshTransformation>,
): Readonly<TransformationSourceEvidence> {
  return Object.freeze({
    name,
    present: transformation.source !== null,
    ...(transformation.source ?? emptyEvidence()),
    assessment: transformation.assessment,
  });
}

function secretId(entry: Readonly<SecretImportDraft>): string {
  return sha256Text(`${entry.kind}\0${entry.sourceName}\0${entry.targetName}`);
}

export function writeTransformationModel(options: {
  readonly modelRoot: string;
  readonly uid: number;
  readonly projectId: string;
  readonly profile: 'edge' | 'standalone';
  readonly config: Readonly<ConfigTransformation>;
  readonly keyv: Readonly<KeyvTransformation>;
  readonly ssh: Readonly<SshTransformation>;
}): Readonly<{
  sources: readonly TransformationSourceEvidence[];
  model: Readonly<TransformationModelEvidence>;
  assessment: 'ready' | 'manual_required';
}> {
  fs.mkdirSync(options.modelRoot, { mode: 0o700 });
  const secretRoot = path.join(options.modelRoot, 'secret-values');
  fs.mkdirSync(secretRoot, { mode: 0o700 });
  const drafts = [...options.config.secrets, ...options.ssh.secrets].sort(
    (left, right) =>
      Buffer.compare(
        Buffer.from(`${left.kind}\0${left.sourceName}`, 'utf8'),
        Buffer.from(`${right.kind}\0${right.sourceName}`, 'utf8'),
      ),
  );
  const maximumSecrets = options.profile === 'edge' ? 128 : 512;
  if (drafts.length > maximumSecrets) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'transformation Secret count exceeds the Profile budget',
    );
  }
  const targets = new Set<string>();
  const files = new Set<string>();
  const imports: SecretImportEntry[] = [];
  for (const draft of drafts) {
    const id = secretId(draft);
    const relative = `secret-values/${id}.json`;
    if (targets.has(draft.targetName) || files.has(relative)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'transformation Secret identity collides',
      );
    }
    targets.add(draft.targetName);
    files.add(relative);
    writePrivateJson(path.join(options.modelRoot, relative), {
      schemaVersion: 1,
      kind: 'qinglong3-local-secret-value',
      value: draft.value,
    });
    imports.push({
      kind: draft.kind,
      sourceName: draft.sourceName,
      targetName: draft.targetName,
      expectedCurrentVersion: 0,
      valueFile: relative,
      valueDigest: sha256Text(draft.value),
    });
  }
  syncDirectory(secretRoot);
  writePrivateJson(
    path.join(options.modelRoot, 'config.json'),
    options.config.model,
  );
  writePrivateJson(
    path.join(options.modelRoot, 'keyv.json'),
    options.keyv.model,
  );
  writePrivateJson(path.join(options.modelRoot, 'ssh.json'), options.ssh.model);
  writePrivateJson(path.join(options.modelRoot, 'secret-imports.json'), {
    schema: 'qinglong/local-secret-import-plan@v1',
    projectId: options.projectId,
    state: 'prepared',
    imports,
  });
  const sources = Object.freeze([
    sourceEvidence('config', options.config),
    sourceEvidence('keyv', options.keyv),
    sourceEvidence('ssh', options.ssh),
  ]);
  const manualCategories = sources.filter(
    ({ assessment }) => assessment === 'manual_required',
  ).length;
  writePrivateJson(path.join(options.modelRoot, 'manual-review.json'), {
    schema: 'qinglong/legacy-data-directory-manual-review@v1',
    required: manualCategories > 0,
    categories: sources.map(({ name, present, assessment, ...evidence }) => ({
      name,
      present,
      assessment,
      evidence,
    })),
    activation: 'disabled',
  });
  syncDirectory(options.modelRoot);
  const tree = summarizePrivateTree(options.modelRoot, options.uid);
  const environmentSecrets = imports.filter(
    ({ kind }) => kind === 'environment',
  ).length;
  const sshSecrets = imports.length - environmentSecrets;
  return Object.freeze({
    sources,
    model: Object.freeze({
      ...tree,
      environmentSecrets,
      sshSecrets,
      manualCategories,
    }),
    assessment: manualCategories > 0 ? 'manual_required' : 'ready',
  });
}

function readJson(filePath: string, uid: number): unknown {
  try {
    return JSON.parse(
      readStablePrivateUtf8File(
        filePath,
        uid,
        MAX_MODEL_FILE_BYTES,
        'transformation model file',
      ),
    );
  } catch (error) {
    if (error instanceof LocalDataDirectoryAdoptionConfigurationError) {
      throw error;
    }
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'transformation model JSON is invalid',
      error,
    );
  }
}

function assertSchemaFile(
  filePath: string,
  uid: number,
  schema: string,
): Record<string, unknown> {
  const value = readJson(filePath, uid);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { readonly schema?: unknown }).schema !== schema ||
    (value as { readonly activation?: unknown }).activation !== 'disabled'
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'transformation target model schema is invalid',
    );
  }
  return value as Record<string, unknown>;
}

export function verifyTransformationModel(options: {
  readonly modelRoot: string;
  readonly uid: number;
  readonly projectId: string;
  readonly profile: 'edge' | 'standalone';
  readonly expected: Readonly<TransformationModelEvidence>;
}): Readonly<VerifiedTransformationModel> {
  if (
    JSON.stringify(sortedNames(options.modelRoot)) !==
    JSON.stringify(
      [
        'config.json',
        'keyv.json',
        'manual-review.json',
        'secret-imports.json',
        'secret-values',
        'ssh.json',
      ].sort(),
    )
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'transformation model root contains unexpected entries',
    );
  }
  const config = assertSchemaFile(
    path.join(options.modelRoot, 'config.json'),
    options.uid,
    'qinglong/legacy-config-transformation@v1',
  );
  const keyv = assertSchemaFile(
    path.join(options.modelRoot, 'keyv.json'),
    options.uid,
    'qinglong/legacy-keyv-transformation@v1',
  );
  const ssh = assertSchemaFile(
    path.join(options.modelRoot, 'ssh.json'),
    options.uid,
    'qinglong/legacy-ssh-transformation@v1',
  );
  const manual = assertSchemaFile(
    path.join(options.modelRoot, 'manual-review.json'),
    options.uid,
    'qinglong/legacy-data-directory-manual-review@v1',
  );
  if (
    !exactKeys(manual, ['activation', 'categories', 'required', 'schema']) ||
    typeof manual.required !== 'boolean' ||
    !Array.isArray(manual.categories) ||
    manual.categories.length !== 3
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'manual-review model is invalid',
    );
  }
  const plan = readJson(
    path.join(options.modelRoot, 'secret-imports.json'),
    options.uid,
  );
  if (
    !plan ||
    typeof plan !== 'object' ||
    Array.isArray(plan) ||
    !exactKeys(plan, ['imports', 'projectId', 'schema', 'state'])
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'Secret import plan shape is invalid',
    );
  }
  const candidate = plan as Record<string, unknown>;
  const maximumSecrets = options.profile === 'edge' ? 128 : 512;
  if (
    candidate.schema !== 'qinglong/local-secret-import-plan@v1' ||
    candidate.projectId !== options.projectId ||
    candidate.state !== 'prepared' ||
    !Array.isArray(candidate.imports) ||
    candidate.imports.length > maximumSecrets
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'Secret import plan value is invalid',
    );
  }
  const expectedFiles: string[] = [];
  const targets = new Set<string>();
  const secrets: VerifiedTransformationSecret[] = [];
  let environmentSecrets = 0;
  let sshSecrets = 0;
  for (const value of candidate.imports) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !exactKeys(value, [
        'expectedCurrentVersion',
        'kind',
        'sourceName',
        'targetName',
        'valueDigest',
        'valueFile',
      ])
    ) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'Secret import entry shape is invalid',
      );
    }
    const entry = value as Record<string, unknown>;
    if (
      (entry.kind !== 'environment' && entry.kind !== 'ssh_private_key') ||
      typeof entry.sourceName !== 'string' ||
      entry.sourceName.length < 1 ||
      Buffer.byteLength(entry.sourceName, 'utf8') > 255 ||
      /[\u0000-\u001f\u007f]/.test(entry.sourceName) ||
      typeof entry.targetName !== 'string' ||
      entry.targetName.length < 1 ||
      Buffer.byteLength(entry.targetName, 'utf8') > 128 ||
      /[\u0000-\u001f\u007f]/.test(entry.targetName) ||
      entry.expectedCurrentVersion !== 0 ||
      typeof entry.valueFile !== 'string' ||
      !SECRET_FILE_PATTERN.test(entry.valueFile) ||
      typeof entry.valueDigest !== 'string' ||
      !DIGEST_PATTERN.test(entry.valueDigest) ||
      targets.has(entry.targetName)
    ) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'Secret import entry value is invalid',
      );
    }
    targets.add(entry.targetName);
    expectedFiles.push(path.basename(entry.valueFile));
    const secret = readJson(
      path.join(options.modelRoot, entry.valueFile),
      options.uid,
    );
    if (
      !secret ||
      typeof secret !== 'object' ||
      Array.isArray(secret) ||
      !exactKeys(secret, ['kind', 'schemaVersion', 'value'])
    ) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'Secret value file shape is invalid',
      );
    }
    const secretValue = secret as Record<string, unknown>;
    if (
      secretValue.schemaVersion !== 1 ||
      secretValue.kind !== 'qinglong3-local-secret-value' ||
      typeof secretValue.value !== 'string' ||
      secretValue.value.includes('\0') ||
      Buffer.byteLength(secretValue.value, 'utf8') > 16 * 1024 ||
      sha256Text(secretValue.value) !== entry.valueDigest
    ) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'Secret value file is invalid',
      );
    }
    if (entry.kind === 'environment') environmentSecrets += 1;
    else sshSecrets += 1;
    secrets.push(
      Object.freeze({
        kind: entry.kind,
        sourceName: entry.sourceName,
        targetName: entry.targetName,
        expectedCurrentVersion: 0,
        valueFile: entry.valueFile,
        valueDigest: entry.valueDigest,
        plaintext: secretValue.value,
      }) as Readonly<VerifiedTransformationSecret>,
    );
  }
  expectedFiles.sort();
  if (
    JSON.stringify(
      sortedNames(path.join(options.modelRoot, 'secret-values')),
    ) !== JSON.stringify(expectedFiles)
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'Secret value file set is invalid',
    );
  }
  const actual = summarizePrivateTree(options.modelRoot, options.uid);
  if (
    JSON.stringify({
      ...actual,
      environmentSecrets,
      sshSecrets,
      manualCategories: (manual.categories as unknown[]).filter(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          (entry as { readonly assessment?: unknown }).assessment ===
            'manual_required',
      ).length,
    }) !== JSON.stringify(options.expected)
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'transformation model no longer matches the manifest',
    );
  }
  return Object.freeze({
    model: Object.freeze({
      schema: 'qinglong/legacy-data-directory-applied-model@v1' as const,
      activation: 'disabled' as const,
      config: Object.freeze(config),
      keyv: Object.freeze(keyv),
      ssh: Object.freeze(ssh),
      manualReview: Object.freeze(manual),
    }),
    secrets: Object.freeze(secrets),
  });
}
