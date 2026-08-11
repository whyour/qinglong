import type { ChildProcess } from 'child_process';
import type { LegacyExecutionObservation } from '../ports/legacyExecutionObserver';

export interface LegacyProcessObservationOptions {
  now?: () => number;
  logArtifactId?: string;
}

export function observeLegacyChildProcess(
  child: ChildProcess,
  observation: LegacyExecutionObservation,
  options: LegacyProcessObservationOptions = {},
): void {
  const now = options.now ?? Date.now;
  child.once('spawn', () => {
    const atMs = now();
    observation.spawned({
      atMs,
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      ...(child.pid === undefined
        ? {}
        : { executorHandle: `legacy-local:${child.pid}` }),
      ...(options.logArtifactId === undefined
        ? {}
        : { logArtifactId: options.logArtifactId }),
    });
    observation.running({ atMs });
  });
  child.on('error', () => {
    observation.startFailed({
      atMs: now(),
      errorCode: 'LEGACY_PROCESS_ERROR',
    });
  });
  child.once('exit', (exitCode, signal) => {
    observation.exited({
      atMs: now(),
      exitCode,
      ...(signal === null ? {} : { signal }),
    });
  });
}
