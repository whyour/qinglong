import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LocalDataDirectoryAdoptionConfigurationError } from '../contract';
import { sortedNames } from '../filesystem';
import { sha256Text } from '../manifest';
import {
  optionalPrivateDirectory,
  readStablePrivateUtf8File,
  summarizePrivateTree,
  type PrivateTreeEvidence,
} from './files';
import type { SecretImportDraft } from './config';

const MAX_KEY_BYTES = 16 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_ALIAS_BYTES = 128;
const KEY_KINDS = new Set([
  'OPENSSH PRIVATE KEY',
  'RSA PRIVATE KEY',
  'EC PRIVATE KEY',
  'PRIVATE KEY',
]);

export interface SshTransformationModel {
  readonly schema: 'qinglong/legacy-ssh-transformation@v1';
  readonly bindings: readonly Readonly<{
    alias: string;
    legacyHostPattern: string;
    targetSecretName: string;
    legacyConfigDigest: string;
    legacyProxyCommandPresent: boolean;
    legacyHostKeyBypassPresent: boolean;
    hostKeyPolicy: 'operator_verification_required';
    activation: 'disabled';
  }>[];
  readonly manualEntries: number;
  readonly manualEntryDigest: string;
  readonly activation: 'disabled';
}

export interface SshTransformation {
  readonly source: Readonly<PrivateTreeEvidence> | null;
  readonly model: Readonly<SshTransformationModel>;
  readonly secrets: readonly Readonly<SecretImportDraft>[];
  readonly assessment: 'ready' | 'manual_required';
}

function targetSecretName(alias: string): string {
  return `legacy-ssh-${sha256Text(alias).slice(0, 32)}`;
}

function privateKey(value: string): boolean {
  if (value.includes('\0')) return false;
  const lines = value.trimEnd().split('\n');
  if (lines.length < 3) return false;
  const begin = /^-----BEGIN ([A-Z0-9 ]+)-----$/.exec(lines[0]!);
  const end = /^-----END ([A-Z0-9 ]+)-----$/.exec(lines.at(-1)!);
  return !!begin && !!end && begin[1] === end[1] && KEY_KINDS.has(begin[1]!);
}

function configBinding(
  value: string,
  alias: string,
): Readonly<{
  hostPattern: string;
  proxyCommandPresent: boolean;
  hostKeyBypassPresent: boolean;
}> | null {
  if (
    value.includes('\0') ||
    /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  const lines = value.split(/\r?\n/);
  const hosts = lines
    .map((line) => /^Host[ \t]+([^\s]+)[ \t]*$/.exec(line)?.[1])
    .filter((entry): entry is string => entry !== undefined);
  const identities = lines
    .map((line) => /^[ \t]+IdentityFile[ \t]+(.+?)[ \t]*$/.exec(line)?.[1])
    .filter((entry): entry is string => entry !== undefined);
  if (
    hosts.length !== 1 ||
    identities.length !== 1 ||
    Buffer.byteLength(hosts[0]!, 'utf8') > 255 ||
    path.basename(identities[0]!) !== alias
  ) {
    return null;
  }
  return Object.freeze({
    hostPattern: hosts[0]!,
    proxyCommandPresent: lines.some((line) =>
      /^[ \t]+ProxyCommand[ \t]+/.test(line),
    ),
    hostKeyBypassPresent: lines.some((line) =>
      /^[ \t]+StrictHostKeyChecking[ \t]+no[ \t]*$/i.test(line),
    ),
  });
}

function emptyModel(): Readonly<SshTransformationModel> {
  return Object.freeze({
    schema: 'qinglong/legacy-ssh-transformation@v1',
    bindings: Object.freeze([]),
    manualEntries: 0,
    manualEntryDigest: sha256Text(''),
    activation: 'disabled',
  });
}

export function transformLegacySsh(
  categoryRoot: string,
  uid: number,
): Readonly<SshTransformation> {
  if (
    !optionalPrivateDirectory(categoryRoot, uid, 'SSH transformation input')
  ) {
    return Object.freeze({
      source: null,
      model: emptyModel(),
      secrets: Object.freeze([]),
      assessment: 'ready',
    });
  }
  const source = summarizePrivateTree(categoryRoot, uid);
  const names = sortedNames(categoryRoot);
  const nameSet = new Set(names);
  const consumed = new Set<string>();
  const bindings: Array<{
    alias: string;
    legacyHostPattern: string;
    targetSecretName: string;
    legacyConfigDigest: string;
    legacyProxyCommandPresent: boolean;
    legacyHostKeyBypassPresent: boolean;
    hostKeyPolicy: 'operator_verification_required';
    activation: 'disabled';
  }> = [];
  const secrets: SecretImportDraft[] = [];
  const manualHash = crypto.createHash('sha256');
  for (const configName of names.filter((name) => name.endsWith('.config'))) {
    const alias = configName.slice(0, -'.config'.length);
    if (
      alias.length === 0 ||
      Buffer.byteLength(alias, 'utf8') > MAX_ALIAS_BYTES ||
      /[\u0000-\u001f\u007f]/.test(alias) ||
      !nameSet.has(alias)
    ) {
      continue;
    }
    const keyPath = path.join(categoryRoot, alias);
    const configPath = path.join(categoryRoot, configName);
    let key: string;
    let config: string;
    try {
      key = readStablePrivateUtf8File(
        keyPath,
        uid,
        MAX_KEY_BYTES,
        'legacy SSH private key',
      );
      config = readStablePrivateUtf8File(
        configPath,
        uid,
        MAX_CONFIG_BYTES,
        'legacy SSH config',
      );
    } catch {
      continue;
    }
    const parsed = configBinding(config, alias);
    if (!privateKey(key) || !parsed) continue;
    const secretName = targetSecretName(alias);
    bindings.push({
      alias,
      legacyHostPattern: parsed.hostPattern,
      targetSecretName: secretName,
      legacyConfigDigest: sha256Text(config),
      legacyProxyCommandPresent: parsed.proxyCommandPresent,
      legacyHostKeyBypassPresent: parsed.hostKeyBypassPresent,
      hostKeyPolicy: 'operator_verification_required',
      activation: 'disabled',
    });
    secrets.push({
      kind: 'ssh_private_key',
      sourceName: alias,
      targetName: secretName,
      value: key,
    });
    consumed.add(alias);
    consumed.add(configName);
  }
  for (const name of names) {
    if (consumed.has(name)) continue;
    const entryPath = path.join(categoryRoot, name);
    const stat = fs.lstatSync(entryPath, { bigint: true });
    manualHash.update(
      `${sha256Text(name)}:${stat.isDirectory() ? 'directory' : 'file'}\n`,
      'utf8',
    );
  }
  const after = summarizePrivateTree(categoryRoot, uid);
  if (JSON.stringify(after) !== JSON.stringify(source)) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'SSH transformation input changed while reading',
    );
  }
  const manualEntries = Math.max(0, source.entries - consumed.size);
  const model = Object.freeze({
    schema: 'qinglong/legacy-ssh-transformation@v1' as const,
    bindings: Object.freeze(bindings),
    manualEntries,
    manualEntryDigest: manualHash.digest('hex'),
    activation: 'disabled' as const,
  });
  return Object.freeze({
    source,
    model,
    secrets: Object.freeze(secrets),
    assessment: manualEntries > 0 ? 'manual_required' : 'ready',
  });
}
