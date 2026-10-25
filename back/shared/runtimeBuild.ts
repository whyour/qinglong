import { readFileSync } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';

function read(filename: string): Buffer | undefined {
  try {
    return readFileSync(filename);
  } catch {
    return undefined;
  }
}

function manifest(): { sourceCommit?: string } {
  try {
    const value = JSON.parse(
      read(path.resolve(__dirname, '../../build-info.json'))?.toString() ||
        '{}',
    );
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

// Capture before serving requests. Reading the installed files on each request
// would let an old process claim the identity of a newly copied build.
const backend = read(path.resolve(__dirname, '../app.js'));
const root = process.env.QL_DIR || path.resolve(__dirname, '../../..');
const version = read(path.join(root, 'version.yaml'))
  ?.toString()
  .match(/^\uFEFF?version:\s*["']?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)/m)?.[1];

export const runtimeBuild = Object.freeze({
  instanceId: randomUUID(),
  parentPid: process.ppid,
  version,
  sourceCommit: manifest().sourceCommit,
  backendSha256: backend
    ? createHash('sha256').update(backend).digest('hex')
    : undefined,
});
