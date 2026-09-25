import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  nodePreloadSource,
  pythonPreloadSource,
  esmLoaderSource,
} from './preloadSource';

// Keep runtime adapters private to an execution; generated panel modules remain
// live links so account/config updates retain the panel's existing semantics.
export async function prepareLanguagePreload(source: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-language-'));
  try {
    for (const name of await fs.readdir(source)) {
      if (
        [
          'sitecustomize.js',
          'sitecustomize.py',
          'esm-loader.mjs',
          '__pycache__',
        ].includes(name)
      )
        continue;
      await fs.symlink(path.join(source, name), path.join(directory, name));
    }
    await fs.writeFile(
      path.join(directory, 'sitecustomize.js'),
      nodePreloadSource,
    );
    await fs.writeFile(
      path.join(directory, 'sitecustomize.py'),
      pythonPreloadSource,
    );
    await fs.writeFile(path.join(directory, 'esm-loader.mjs'), esmLoaderSource);
    return directory;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
