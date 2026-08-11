import { ExecutorStopError } from '../../domain/executorErrors';

export interface ProcessTerminationRequest {
  pid: number;
  processGroup: boolean;
  graceMs: number;
  closed: Promise<void>;
}

export interface ProcessTerminationResult {
  alreadyExited: boolean;
  termSignalSent: boolean;
  killSignalSent: boolean;
}

export interface ProcessTerminator {
  terminate(
    request: ProcessTerminationRequest,
  ): Promise<ProcessTerminationResult>;
}

export type ProcessSignalSender = (pid: number, signal: NodeJS.Signals) => void;

function isNoSuchProcessError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
}

async function exitsWithin(closed: Promise<void>, timeoutMs: number) {
  if (timeoutMs === 0) return false;

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class PosixProcessTerminator implements ProcessTerminator {
  constructor(
    private readonly sendSignal: ProcessSignalSender = process.kill,
  ) {}

  async terminate(
    request: ProcessTerminationRequest,
  ): Promise<ProcessTerminationResult> {
    const targetPid = request.processGroup ? -request.pid : request.pid;
    try {
      this.sendSignal(targetPid, 'SIGTERM');
    } catch (error) {
      if (isNoSuchProcessError(error)) {
        return {
          alreadyExited: true,
          termSignalSent: false,
          killSignalSent: false,
        };
      }
      throw new ExecutorStopError(error);
    }

    if (await exitsWithin(request.closed, request.graceMs)) {
      return {
        alreadyExited: false,
        termSignalSent: true,
        killSignalSent: false,
      };
    }

    try {
      this.sendSignal(targetPid, 'SIGKILL');
      return {
        alreadyExited: false,
        termSignalSent: true,
        killSignalSent: true,
      };
    } catch (error) {
      if (isNoSuchProcessError(error)) {
        return {
          alreadyExited: false,
          termSignalSent: true,
          killSignalSent: false,
        };
      }
      throw new ExecutorStopError(error);
    }
  }
}
