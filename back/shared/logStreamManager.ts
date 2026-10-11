import { createWriteStream, WriteStream } from 'fs';
import { EventEmitter } from 'events';
import path from 'path';
import config from '../config';
import { resolveFileAccess } from './fileAccess';

/**
 * Manages write streams for log files to improve performance by avoiding repeated file opens
 */
export class LogStreamManager extends EventEmitter {
  private streams: Map<string, WriteStream> = new Map();
  private pendingWrites: Map<string, Promise<void>> = new Map();

  private closingStreams = new Map<string, Promise<void>>();
  private closedStreams = new WeakSet<WriteStream>();
  private streamErrors = new Map<string, Error>();

  constructor(private readonly logRoot = config.logPath) {
    super();
  }

  /** Register each write synchronously, so concurrent callers cannot lose the tail. */
  async write(filePath: string, data: string): Promise<void> {
    if (this.closingStreams.has(filePath)) {
      throw new Error(`Log stream is closing: ${filePath}`);
    }
    const previous = this.pendingWrites.get(filePath) || Promise.resolve();
    const pending = previous.then(
      () =>
        new Promise<void>((resolve, reject) => {
          const failure = this.streamErrors.get(filePath);
          if (failure) return reject(failure);
          let stream = this.streams.get(filePath);
          if (!stream) {
            // Validate only when opening: subsequent chunks reuse the same descriptor.
            const root = path.resolve(this.logRoot);
            const target = path.resolve(filePath);
            if (
              !target.startsWith(root + path.sep) ||
              !resolveFileAccess(root, [target])
            ) {
              return reject(new Error('Log path is outside the log directory'));
            }
            stream = createWriteStream(target, { flags: 'a' });
            this.streams.set(filePath, stream);
            const current = stream;
            stream.once('close', () => this.closedStreams.add(current));
            stream.on('error', (error) => {
              this.streamErrors.set(filePath, error);
              // EventEmitter's unobserved "error" event would crash the caller.
              if (this.listenerCount('error') > 0)
                this.emit('error', { filePath, error });
            });
          }
          stream.write(data, 'utf8', (error) =>
            error ? reject(error) : resolve(),
          );
        }),
    );
    this.pendingWrites.set(filePath, pending);
    // Keep the tail until close, including failures; never reopen a failed log mid-run.
    return pending;
  }

  async closeStream(filePath: string): Promise<void> {
    const closing = this.closingStreams.get(filePath);
    if (closing) return closing;
    const pending = this.pendingWrites.get(filePath);
    const result = (async () => {
      let failure: unknown;
      try {
        await pending;
      } catch (error) {
        failure = error;
      }
      const stream = this.streams.get(filePath);
      try {
        if (stream && !this.closedStreams.has(stream)) {
          await new Promise<void>((resolve) => {
            stream.once('close', resolve);
            if (failure || stream.destroyed) stream.destroy();
            else stream.end();
          });
        }
        failure ||= this.streamErrors.get(filePath);
        if (failure) throw failure;
      } finally {
        this.streams.delete(filePath);
        this.pendingWrites.delete(filePath);
        this.streamErrors.delete(filePath);
      }
    })();
    this.closingStreams.set(filePath, result);
    try {
      await result;
    } finally {
      this.closingStreams.delete(filePath);
    }
  }

  /**
   * Close all open streams
   */
  async closeAll(): Promise<void> {
    const paths = new Set([
      ...this.streams.keys(),
      ...this.pendingWrites.keys(),
    ]);
    const closePromises = Array.from(paths).map((filePath) =>
      this.closeStream(filePath),
    );
    await Promise.all(closePromises);
  }

  /**
   * Get the number of open streams
   */
  getOpenStreamCount(): number {
    return this.streams.size;
  }
}

// Export a singleton instance for shared use
export const logStreamManager = new LogStreamManager();
