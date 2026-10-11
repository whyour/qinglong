import path from 'node:path';
import type { LocalContext } from '../runtime/context';
import { runProcess } from '../runtime/process';

export async function taskDependencyEnvironment(
  context: LocalContext,
): Promise<NodeJS.ProcessEnv> {
  const env = { ...context.env };
  env.PREV_NODE_PATH = env.NODE_PATH || '';
  const paths = [env.NODE_PATH, context.paths.dir_dep].filter(Boolean);
  // pnpm is optional for task execution. Bound both probe time and captured output.
  try {
    const result = await runProcess('pnpm', ['root', '-g'], {
      cwd: context.root,
      env,
      capture: true,
      output: () => {},
      timeoutMs: 5000,
      graceMs: 100,
      maxCaptureBytes: 65536,
    });
    const global = result.stdout.trim();
    if (
      result.code === 0 &&
      global &&
      path.isAbsolute(global) &&
      !/[\r\n\0]/.test(global)
    ) {
      env.QL_NODE_GLOBAL_PATH = global;
      paths.push(global);
    } else delete env.QL_NODE_GLOBAL_PATH;
  } catch {
    delete env.QL_NODE_GLOBAL_PATH;
  }
  env.NODE_PATH = paths.join(path.delimiter);
  return env;
}
