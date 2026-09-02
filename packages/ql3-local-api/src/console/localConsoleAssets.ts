import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

const MAX_LITE_ASSET_BYTES = 96 * 1_024;
const MAX_LITE_TOTAL_BYTES = 192 * 1_024;
const MAX_PANEL_FILES = 256;
const MAX_PANEL_TOTAL_BYTES = 13 * 1_024 * 1_024;
const MAX_PANEL_FILE_BYTES = 3 * 1_024 * 1_024;
const MAX_MANIFEST_BYTES = 128 * 1_024;
const PANEL_SCHEMA = 'qinglong/local-legacy-panel-assets@v1';
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const NO_STORE_CACHE = 'no-store';
const LITE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PANEL_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; worker-src 'none'; manifest-src 'none'";
const PANEL_CONTENT_TYPES = new Set([
  'text/css; charset=utf-8',
  'text/html; charset=utf-8',
  'text/javascript; charset=utf-8',
  'font/ttf',
  'font/woff',
  'font/woff2',
]);
const PANEL_SUPPORTED_ROUTES = Object.freeze(['/login', '/crontab', '/error']);

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

interface LocalConsoleAssetBase {
  readonly contentType: string;
  readonly etag: string;
  readonly byteLength: number;
  readonly cacheControl: string;
  readonly contentSecurityPolicy: string;
}

export type LocalConsoleAsset =
  | (LocalConsoleAssetBase &
      Readonly<{
        body: Buffer;
        filePath?: never;
      }>)
  | (LocalConsoleAssetBase &
      Readonly<{
        body?: never;
        filePath: string;
      }>);

export type LocalConsoleAssets = ReadonlyMap<string, LocalConsoleAsset>;

export class LocalConsoleAssetError extends Error {
  readonly code = 'QL3_LOCAL_CONSOLE_ASSET_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(`Local Console asset is invalid: ${message}`, options);
    this.name = 'LocalConsoleAssetError';
  }
}

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function canonicalDirectory(directory: string, label: string): string {
  const resolved = path.resolve(directory);
  try {
    const stat = lstatSync(resolved);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(resolved) !== resolved
    ) {
      throw new TypeError();
    }
  } catch (error) {
    throw new LocalConsoleAssetError(label, { cause: error });
  }
  return resolved;
}

function loadLiteAsset(
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
      stat.size > MAX_LITE_ASSET_BYTES ||
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
    byteLength: body.byteLength,
    cacheControl: NO_STORE_CACHE,
    contentSecurityPolicy: LITE_CONTENT_SECURITY_POLICY,
    body,
  });
}

function loadLiteAssets(root: string): LocalConsoleAssets {
  const canonicalRoot = canonicalDirectory(root, 'asset root');
  const assets = new Map<string, Readonly<LocalConsoleAsset>>();
  let totalBytes = 0;
  for (const definition of DEFINITIONS) {
    const asset = loadLiteAsset(canonicalRoot, definition);
    totalBytes += asset.byteLength;
    if (totalBytes > MAX_LITE_TOTAL_BYTES) {
      throw new LocalConsoleAssetError('asset set exceeds its byte budget');
    }
    assets.set(definition.requestPath, asset);
  }
  return assets;
}

function parsePanelManifest(root: string): Record<string, unknown> {
  const manifestPath = path.join(root, 'manifest.json');
  try {
    const stat = lstatSync(manifestPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 256 ||
      stat.size > MAX_MANIFEST_BYTES ||
      realpathSync(manifestPath) !== manifestPath
    ) {
      throw new TypeError();
    }
    const value: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError();
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new LocalConsoleAssetError('panel manifest', { cause: error });
  }
}

function panelDiskFiles(root: string): readonly string[] {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        throw new LocalConsoleAssetError('panel closure contains a symlink');
      }
      if (stat.isDirectory()) pending.push(target);
      else if (stat.isFile()) {
        result.push(path.relative(root, target).split(path.sep).join('/'));
      } else {
        throw new LocalConsoleAssetError(
          'panel closure contains a special file',
        );
      }
    }
  }
  return result.sort();
}

export function loadLocalConsolePanelAssets(
  directory: string,
): LocalConsoleAssets {
  const root = canonicalDirectory(directory, 'panel asset root');
  const manifest = parsePanelManifest(root);
  if (
    !exactKeys(manifest, [
      'schema',
      'source',
      'supportedRoutes',
      'fileCount',
      'totalBytes',
      'limits',
      'files',
    ]) ||
    manifest.schema !== PANEL_SCHEMA ||
    manifest.source !== 'qinglong-2.x-capability-gated-panel' ||
    JSON.stringify(manifest.supportedRoutes) !==
      JSON.stringify(PANEL_SUPPORTED_ROUTES) ||
    !exactKeys(manifest.limits, [
      'maxFiles',
      'maxTotalBytes',
      'maxFileBytes',
    ]) ||
    (manifest.limits as Record<string, unknown>).maxFiles !== MAX_PANEL_FILES ||
    (manifest.limits as Record<string, unknown>).maxTotalBytes !==
      MAX_PANEL_TOTAL_BYTES ||
    (manifest.limits as Record<string, unknown>).maxFileBytes !==
      MAX_PANEL_FILE_BYTES ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 4 ||
    manifest.files.length > MAX_PANEL_FILES
  ) {
    throw new LocalConsoleAssetError('panel manifest contract drifted');
  }
  const assets = new Map<string, LocalConsoleAsset>();
  const seenFiles = new Set<string>(['manifest.json']);
  let previousRequestPath = '';
  let totalBytes = 0;
  for (const raw of manifest.files) {
    if (
      !exactKeys(raw, [
        'requestPath',
        'file',
        'bytes',
        'sha256',
        'contentType',
        'cacheControl',
      ])
    ) {
      throw new LocalConsoleAssetError('panel asset entry shape drifted');
    }
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.requestPath !== 'string' ||
      !entry.requestPath.startsWith('/') ||
      entry.requestPath.includes('?') ||
      entry.requestPath <= previousRequestPath ||
      (entry.requestPath.startsWith('/api/') &&
        entry.requestPath !== '/api/env.js') ||
      typeof entry.file !== 'string' ||
      !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(entry.file) ||
      entry.file.split('/').includes('..') ||
      seenFiles.has(entry.file) ||
      !Number.isSafeInteger(entry.bytes) ||
      Number(entry.bytes) < 0 ||
      Number(entry.bytes) > MAX_PANEL_FILE_BYTES ||
      typeof entry.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
      typeof entry.contentType !== 'string' ||
      !PANEL_CONTENT_TYPES.has(entry.contentType) ||
      (entry.cacheControl !== NO_STORE_CACHE &&
        entry.cacheControl !== IMMUTABLE_CACHE)
    ) {
      throw new LocalConsoleAssetError('panel asset entry is invalid');
    }
    previousRequestPath = entry.requestPath;
    seenFiles.add(entry.file);
    const filePath = path.join(root, ...entry.file.split('/'));
    let body: Buffer;
    let stat;
    try {
      stat = lstatSync(filePath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== entry.bytes ||
        realpathSync(filePath) !== filePath
      ) {
        throw new TypeError();
      }
      body = readFileSync(filePath);
    } catch (error) {
      throw new LocalConsoleAssetError(`panel asset ${entry.file}`, {
        cause: error,
      });
    }
    if (
      body.byteLength !== entry.bytes ||
      createHash('sha256').update(body).digest('hex') !== entry.sha256
    ) {
      throw new LocalConsoleAssetError(`panel asset ${entry.file} drifted`);
    }
    totalBytes += body.byteLength;
    assets.set(
      entry.requestPath,
      Object.freeze({
        contentType: entry.contentType,
        etag: `"${entry.sha256}"`,
        byteLength: body.byteLength,
        cacheControl: entry.cacheControl,
        contentSecurityPolicy: PANEL_CONTENT_SECURITY_POLICY,
        filePath,
      }),
    );
  }
  if (
    manifest.fileCount !== assets.size ||
    manifest.totalBytes !== totalBytes ||
    totalBytes > MAX_PANEL_TOTAL_BYTES ||
    !assets.has('/') ||
    !assets.has('/api/env.js')
  ) {
    throw new LocalConsoleAssetError('panel asset closure drifted');
  }
  const diskFiles = panelDiskFiles(root);
  if (
    diskFiles.length !== seenFiles.size ||
    diskFiles.some((file) => !seenFiles.has(file))
  ) {
    throw new LocalConsoleAssetError('panel disk closure drifted');
  }
  const index = assets.get('/')!;
  for (const route of PANEL_SUPPORTED_ROUTES) assets.set(route, index);
  return assets;
}

export function loadLocalConsoleAssets(): LocalConsoleAssets {
  const assetsRoot = path.resolve(__dirname, '../../assets');
  const panelRoot = path.join(assetsRoot, 'panel');
  const liteAssets = loadLiteAssets(path.join(assetsRoot, 'console'));
  if (!existsSync(path.join(panelRoot, 'manifest.json'))) return liteAssets;
  const assets = new Map(loadLocalConsolePanelAssets(panelRoot));
  for (const requestPath of ['/console.css', '/console.js']) {
    if (assets.has(requestPath)) {
      throw new LocalConsoleAssetError(
        `panel conflicts with native Console asset ${requestPath}`,
      );
    }
    assets.set(requestPath, liteAssets.get(requestPath)!);
  }
  if (assets.has('/console')) {
    throw new LocalConsoleAssetError(
      'panel conflicts with native Console route /console',
    );
  }
  assets.set('/console', liteAssets.get('/')!);
  return assets;
}
