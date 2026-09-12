import { ChildProcessWithoutNullStreams } from 'child_process';
import { Readable } from 'stream';

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Attach immediately after spawn, before awaiting database or user callbacks. */
export function observeChildProcess(
  child: ChildProcessWithoutNullStreams,
  callbacks: {
    onStart?: () => Promise<void>;
    onStdout?: (message: string) => Promise<void>;
    onStderr?: (message: string) => Promise<void>;
  } = {},
) {
  let failure: Error | undefined;
  const recordError = (error: unknown) => {
    failure ??= asError(error);
  };
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    // Keep the listener through close: errors can occur after a successful spawn.
    child.on('error', (error) => {
      recordError(error);
      reject(error);
    });
  });
  const closed = new Promise<ProcessResult>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const started = spawned.then(async () => {
    await callbacks.onStart?.();
    return child.pid;
  });
  // The caller can ask only for completion, without an unhandled start rejection.
  const ready = started.catch(recordError);

  const consume = async (
    stream: Readable,
    callback?: (message: string) => Promise<void>,
  ) => {
    // StringDecoder in Readable preserves UTF-8 characters split across chunks.
    stream.setEncoding('utf8');
    let callbackFailed = false;
    try {
      for await (const chunk of stream) {
        await ready;
        if (!callbackFailed && callback) {
          try {
            await callback(String(chunk));
          } catch (error) {
            recordError(error);
            callbackFailed = true;
          }
        }
        // Even if a log sink fails, drain the pipe so the child can finish.
      }
    } catch (error) {
      recordError(error);
    }
  };
  const output = Promise.all([
    consume(child.stdout, callbacks.onStdout),
    consume(child.stderr, callbacks.onStderr),
  ]);
  const completed = Promise.all([closed, ready, output]).then(([result]) => ({
    ...result,
    error: failure,
  }));
  return { started, completed };
}
