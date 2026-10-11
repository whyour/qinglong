import { fork } from 'child_process';

// Keep one-off startup dependencies out of the long-lived cluster primary.
export function runStartupProcess(entrypoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = fork(entrypoint, [], { stdio: 'inherit' });
    let interrupted: NodeJS.Signals | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = (signal: NodeJS.Signals) => {
      if (interrupted) return;
      interrupted = signal;
      child.kill(signal);
      killTimer = setTimeout(() => child.kill('SIGKILL'), 8000);
      killTimer.unref();
    };
    const onSigterm = () => terminate('SIGTERM');
    const onSigint = () => terminate('SIGINT');
    const onExit = () => child.kill('SIGKILL');
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('exit', onExit);
    };

    process.once('SIGTERM', onSigterm);
    process.once('SIGINT', onSigint);
    process.once('exit', onExit);
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, signal) => {
      cleanup();
      if (code === 0 && !interrupted) {
        resolve();
      } else {
        reject(
          new Error(
            `Startup process failed (${interrupted || signal || code})`,
          ),
        );
      }
    });
  });
}
