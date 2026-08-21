import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LocalDataDirectoryAdoptionConfigurationError } from '../contract';
import { sha256Text } from '../manifest';
import {
  optionalPrivateDirectory,
  readStablePrivateUtf8File,
  summarizePrivateTree,
  type PrivateTreeEvidence,
} from './files';

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SECRET_BYTES = 16 * 1024;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SAFE_UNQUOTED_PATTERN = /^[A-Za-z0-9_./:@%,+-]*$/;

export interface SecretImportDraft {
  readonly kind: 'environment' | 'ssh_private_key';
  readonly sourceName: string;
  readonly targetName: string;
  readonly value: string;
}

export interface ConfigTransformationModel {
  readonly schema: 'qinglong/legacy-config-transformation@v1';
  readonly exportedEnvironment: readonly Readonly<{
    environmentName: string;
    targetSecretName: string;
  }>[];
  readonly retiredSettings: readonly Readonly<{
    name: string;
    valueDigest: string;
  }>[];
  readonly omittedEmptyExports: number;
  readonly duplicateAssignments: number;
  readonly unsupportedLines: number;
  readonly unsupportedLineDigest: string;
  readonly disabledAssetEntries: number;
  readonly activation: 'disabled';
}

export interface ConfigTransformation {
  readonly source: Readonly<PrivateTreeEvidence> | null;
  readonly model: Readonly<ConfigTransformationModel>;
  readonly secrets: readonly Readonly<SecretImportDraft>[];
  readonly assessment: 'ready' | 'manual_required';
}

function literal(value: string): string | null {
  if (value.length === 0) return '';
  if (value.startsWith("'") && value.endsWith("'")) {
    const inner = value.slice(1, -1);
    return inner.includes("'") ? null : inner;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1);
    return /["`$\\]/.test(inner) ? null : inner;
  }
  return SAFE_UNQUOTED_PATTERN.test(value) ? value : null;
}

function targetSecretName(name: string): string {
  return `legacy-env-${sha256Text(name).slice(0, 32)}`;
}

function emptyModel(): Readonly<ConfigTransformationModel> {
  return Object.freeze({
    schema: 'qinglong/legacy-config-transformation@v1',
    exportedEnvironment: Object.freeze([]),
    retiredSettings: Object.freeze([]),
    omittedEmptyExports: 0,
    duplicateAssignments: 0,
    unsupportedLines: 0,
    unsupportedLineDigest: sha256Text(''),
    disabledAssetEntries: 0,
    activation: 'disabled',
  });
}

export function transformLegacyConfig(
  categoryRoot: string,
  uid: number,
): Readonly<ConfigTransformation> {
  if (
    !optionalPrivateDirectory(categoryRoot, uid, 'config transformation input')
  ) {
    return Object.freeze({
      source: null,
      model: emptyModel(),
      secrets: Object.freeze([]),
      assessment: 'ready',
    });
  }
  const source = summarizePrivateTree(categoryRoot, uid);
  const configPath = path.join(categoryRoot, 'config.sh');
  let configExists = false;
  try {
    const stat = fs.lstatSync(configPath);
    configExists = stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
  }
  if (!configExists) {
    const model = Object.freeze({
      ...emptyModel(),
      disabledAssetEntries: source.entries,
    });
    return Object.freeze({
      source,
      model,
      secrets: Object.freeze([]),
      assessment: source.entries === 0 ? 'ready' : 'manual_required',
    });
  }

  const content = readStablePrivateUtf8File(
    configPath,
    uid,
    MAX_CONFIG_BYTES,
    'legacy config.sh',
  );
  const recognized = new Map<
    string,
    { readonly exported: boolean; readonly value: string }
  >();
  const duplicates = new Set<string>();
  let unsupportedLines = 0;
  const unsupportedHash = crypto.createHash('sha256');
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.endsWith('\r')
      ? lines[index]!.slice(0, -1)
      : lines[index]!;
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    const match =
      /^(?:(export)[ \t]+)?([A-Za-z_][A-Za-z0-9_]{0,127})=(.*)$/.exec(line);
    const parsed = match ? literal(match[3]!) : null;
    if (!match || !NAME_PATTERN.test(match[2]!) || parsed === null) {
      unsupportedLines += 1;
      unsupportedHash.update(`${index + 1}:${sha256Text(line)}\n`, 'utf8');
      continue;
    }
    const name = match[2]!;
    if (recognized.has(name)) duplicates.add(name);
    recognized.set(name, { exported: match[1] === 'export', value: parsed });
  }

  const exportedEnvironment: Array<{
    environmentName: string;
    targetSecretName: string;
  }> = [];
  const retiredSettings: Array<{ name: string; valueDigest: string }> = [];
  const secrets: SecretImportDraft[] = [];
  let omittedEmptyExports = 0;
  for (const name of [...recognized.keys()].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  )) {
    const entry = recognized.get(name)!;
    if (duplicates.has(name)) continue;
    if (!entry.exported) {
      retiredSettings.push({ name, valueDigest: sha256Text(entry.value) });
      continue;
    }
    if (entry.value.length === 0) {
      omittedEmptyExports += 1;
      continue;
    }
    if (
      entry.value.includes('\0') ||
      Buffer.byteLength(entry.value, 'utf8') > MAX_SECRET_BYTES
    ) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'legacy exported environment value exceeds the Secret budget',
      );
    }
    const targetName = targetSecretName(name);
    exportedEnvironment.push({
      environmentName: name,
      targetSecretName: targetName,
    });
    secrets.push({
      kind: 'environment',
      sourceName: name,
      targetName,
      value: entry.value,
    });
  }
  const disabledAssetEntries = Math.max(0, source.entries - 1);
  const model = Object.freeze({
    schema: 'qinglong/legacy-config-transformation@v1' as const,
    exportedEnvironment: Object.freeze(exportedEnvironment),
    retiredSettings: Object.freeze(retiredSettings),
    omittedEmptyExports,
    duplicateAssignments: duplicates.size,
    unsupportedLines,
    unsupportedLineDigest: unsupportedHash.digest('hex'),
    disabledAssetEntries,
    activation: 'disabled' as const,
  });
  return Object.freeze({
    source,
    model,
    secrets: Object.freeze(secrets),
    assessment:
      duplicates.size > 0 || unsupportedLines > 0 || disabledAssetEntries > 0
        ? 'manual_required'
        : 'ready',
  });
}
