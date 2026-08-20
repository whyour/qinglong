import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, type PathLike } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

export interface ClusterCopilotConsoleAssets {
  readonly html: string;
  readonly css: string;
  readonly evidenceBundle: string;
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
    digest: '7e024103aaf03553995b09bfb9d6da5ba058ce77f7fff65c56b564017c79f28a',
  }),
  Object.freeze({
    name: 'app.css',
    field: 'css',
    maximumBytes: 64 * 1024,
    digest: 'ddfe85971df0b8acfaed8b4bb5f5bcdf679347106294987d928bbb82dc6610ec',
  }),
  Object.freeze({
    name: 'evidence-bundle.js',
    field: 'evidenceBundle',
    maximumBytes: 32 * 1024,
    digest: '83d17dfa815c175161b35c1aca5f270b15005a16cb79be41c2884b490f617783',
  }),
  Object.freeze({
    name: 'app.js',
    field: 'javascript',
    maximumBytes: 32 * 1024,
    digest: '224895776a1df1b4571a8cdb9ce8126861d0284e1fef801e6de3ef31ca96c931',
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
    evidenceBundle: result.evidenceBundle!,
    javascript: result.javascript!,
  });
}
