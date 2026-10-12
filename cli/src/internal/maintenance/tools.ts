import path from 'node:path';
import type { LocalContext } from '../runtime/context';
import { checkedProcess } from '../runtime/process';

// Preserve the installation's configured global prefix, without resolving new
// registry packages or replacing the user's persisted script dependencies.
export async function installRuntimeTools(context: LocalContext): Promise<void> {
  const options = { cwd: context.root, env: context.env };
  const result = await checkedProcess('npm', ['prefix', '--global'], {
    ...options,
    capture: true,
  });
  const prefix = result.stdout.trim();
  if (!path.isAbsolute(prefix) || prefix.includes('\n'))
    throw new Error('npm returned an invalid global prefix.');
  await checkedProcess(
    process.execPath,
    [
      path.join(context.root, 'scripts/install-runtime-tools.cjs'),
      '--archive',
      path.join(context.root, 'static/runtime-tools.tgz'),
      '--proof',
      path.join(context.root, 'static/runtime-tools-proof.json'),
      '--prefix',
      prefix,
    ],
    options,
  );
  context.env.PATH = [path.join(prefix, 'bin'), context.env.PATH]
    .filter(Boolean)
    .join(path.delimiter);
  context.env.NODE_PATH = [
    path.join(prefix, 'lib/node_modules'),
    context.env.NODE_PATH,
  ]
    .filter(Boolean)
    .join(path.delimiter);
}
