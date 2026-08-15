import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  realpathSync,
  type PathLike,
} from 'node:fs';
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
    digest: 'f9fa959f30b92c6b000eecb744ce1d0a7fce822c62b3e17dcf10d4d579a072ac',
  }),
  Object.freeze({
    name: 'app.css',
    field: 'css',
    maximumBytes: 64 * 1024,
    digest: '200c3405e1e12329fcfb50509b31b19f1567a91552865f039ce0c2de1530032c',
  }),
  Object.freeze({
    name: 'app.js',
    field: 'javascript',
    maximumBytes: 32 * 1024,
    digest: 'd60913e725e767d9fa2cb65d60c0eae6d75d219f4bec8aad166bed8b6507fe02',
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
