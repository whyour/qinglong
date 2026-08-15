import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, type PathLike } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

export interface ClusterCopilotConsoleAssets {
  readonly html: string;
  readonly css: string;
  readonly javascript: string;
}

export class ClusterCopilotConsoleAssetError extends Error {
  readonly code = 'QL3_CLUSTER_COPILOT_CONSOLE_ASSET_INVALID';

  constructor() {
    super('Cluster Copilot Console asset is invalid');
    this.name = 'ClusterCopilotConsoleAssetError';
  }
}

const ASSETS = Object.freeze([
  Object.freeze({
    name: 'index.html',
    field: 'html',
    maximumBytes: 32 * 1024,
    digest: 'ed8db5c26dec23e7a5237ef1cd4f5f9c3fc9f5a04a4751b7a3e0ed22dac54c42',
  }),
  Object.freeze({
    name: 'app.css',
    field: 'css',
    maximumBytes: 64 * 1024,
    digest: '54234cbba7e110de2f68fad2abd657c334b7e3e80c5d9b4f59bda7e122b4b62f',
  }),
  Object.freeze({
    name: 'app.js',
    field: 'javascript',
    maximumBytes: 32 * 1024,
    digest: '61811eac6a89b097b67823ccf49b0736af6494be7b187dbdcbecfc59adb3fce0',
  }),
] as const);

function invalid(): never {
  throw new ClusterCopilotConsoleAssetError();
}

function inside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent !== '' &&
    pathFromParent !== '..' &&
    !pathFromParent.startsWith('..' + sep) &&
    !isAbsolute(pathFromParent)
  );
}

function readAsset(
  assetRoot: string,
  name: string,
  maximumBytes: number,
  digest: string,
): string {
  const candidate = resolve(assetRoot, name);
  const status = lstatSync(candidate, { throwIfNoEntry: false });
  if (
    status === undefined ||
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.size < 1 ||
    status.size > maximumBytes
  ) {
    return invalid();
  }
  const canonicalRoot = realpathSync(assetRoot);
  const canonicalCandidate = realpathSync(candidate);
  if (
    !inside(canonicalRoot, canonicalCandidate) ||
    canonicalCandidate !== resolve(canonicalRoot, name)
  ) {
    return invalid();
  }
  let bytes: Buffer | undefined;
  try {
    bytes = readFileSync(candidate as PathLike);
    if (
      bytes.byteLength !== status.size ||
      createHash('sha256').update(bytes).digest('hex') !== digest ||
      bytes.includes(0)
    ) {
      return invalid();
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof ClusterCopilotConsoleAssetError) throw error;
    return invalid();
  } finally {
    bytes?.fill(0);
  }
}

export function loadClusterCopilotConsoleAssets(
  moduleDirectory: string,
): Readonly<ClusterCopilotConsoleAssets> {
  if (typeof moduleDirectory !== 'string' || !isAbsolute(moduleDirectory)) {
    return invalid();
  }
  const packageRoot = resolve(moduleDirectory, '..', '..');
  const assetRoot = resolve(packageRoot, 'assets', 'copilot-console');
  const packageStatus = lstatSync(packageRoot, { throwIfNoEntry: false });
  const assetStatus = lstatSync(assetRoot, { throwIfNoEntry: false });
  if (
    packageStatus === undefined ||
    !packageStatus.isDirectory() ||
    packageStatus.isSymbolicLink() ||
    assetStatus === undefined ||
    !assetStatus.isDirectory() ||
    assetStatus.isSymbolicLink() ||
    realpathSync(assetRoot) !==
      resolve(realpathSync(packageRoot), 'assets', 'copilot-console')
  ) {
    return invalid();
  }
  const result: Record<string, string> = {};
  for (const asset of ASSETS) {
    result[asset.field] = readAsset(
      assetRoot,
      asset.name,
      asset.maximumBytes,
      asset.digest,
    );
  }
  return Object.freeze({
    html: result.html!,
    css: result.css!,
    javascript: result.javascript!,
  });
}
