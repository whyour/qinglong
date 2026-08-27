import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const MAX_ASSET_BYTES = 96 * 1_024;
const MAX_TOTAL_BYTES = 192 * 1_024;

const DEFINITIONS = Object.freeze([
  Object.freeze({
    requestPath: '/',
    file: 'index.html',
    contentType: 'text/html; charset=utf-8',
  }),
  Object.freeze({
    requestPath: '/console.css',
    file: 'console.css',
    contentType: 'text/css; charset=utf-8',
  }),
  Object.freeze({
    requestPath: '/console.js',
    file: 'console.js',
    contentType: 'text/javascript; charset=utf-8',
  }),
]);

export interface LocalConsoleAsset {
  readonly contentType: string;
  readonly etag: string;
  readonly body: Buffer;
}

export type LocalConsoleAssets = ReadonlyMap<string, LocalConsoleAsset>;

export class LocalConsoleAssetError extends Error {
  readonly code = 'QL3_LOCAL_CONSOLE_ASSET_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(`Local Console asset is invalid: ${message}`, options);
    this.name = 'LocalConsoleAssetError';
  }
}

function loadAsset(
  root: string,
  definition: (typeof DEFINITIONS)[number],
): Readonly<LocalConsoleAsset> {
  const filePath = path.join(root, definition.file);
  let stat;
  let body: Buffer;
  try {
    stat = lstatSync(filePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 2 ||
      stat.size > MAX_ASSET_BYTES ||
      realpathSync(filePath) !== filePath
    ) {
      throw new TypeError('asset identity is incompatible');
    }
    body = readFileSync(filePath);
  } catch (error) {
    throw new LocalConsoleAssetError(definition.file, { cause: error });
  }
  if (body.byteLength !== stat.size) {
    throw new LocalConsoleAssetError(
      `${definition.file} changed while loading`,
    );
  }
  return Object.freeze({
    contentType: definition.contentType,
    etag: `"${createHash('sha256').update(body).digest('hex')}"`,
    body,
  });
}

export function loadLocalConsoleAssets(): LocalConsoleAssets {
  const root = path.resolve(__dirname, '../../assets/console');
  let canonicalRoot: string;
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError();
    canonicalRoot = realpathSync(root);
  } catch (error) {
    throw new LocalConsoleAssetError('asset root', { cause: error });
  }
  const assets = new Map<string, Readonly<LocalConsoleAsset>>();
  let totalBytes = 0;
  for (const definition of DEFINITIONS) {
    const asset = loadAsset(canonicalRoot, definition);
    totalBytes += asset.body.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new LocalConsoleAssetError('asset set exceeds its byte budget');
    }
    assets.set(definition.requestPath, asset);
  }
  return assets;
}
