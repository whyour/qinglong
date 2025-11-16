import { createWriteStream, WriteStream } from 'fs';
import { EventEmitter } from 'events';

/**
 * Manages write streams for log files to improve performance by avoiding repeated file opens
 */
export class LogStreamManager extends EventEmitter {
  private streams: Map<string, WriteStream> = new Map();
  private pendingWrites: Map<string, Promise<void>> = new Map();

  /**
   * Write data to a log file using a managed stream
   * @param filePath - Absolute path to the log file
   * @param data - Data to write to the log file
   */
  async write(filePath: string, data: string): Promise<void> {
    // Wait for any pending writes to this file to complete
    const pending = this.pendingWrites.get(filePath);
    if (pending) {
      await pending;
    }

    // Create a new promise for this write operation
    const writePromise = new Promise<void>((resolve, reject) => {
      let stream = this.streams.get(filePath);

      if (!stream) {
        // Create a new write stream if one doesn't exist
        stream = createWriteStream(filePath, { flags: 'a' });
        this.streams.set(filePath, stream);

        // Handle stream errors
        stream.on('error', (error) => {
          this.emit('error', { filePath, error });
          // Remove the stream from the map on error
          this.streams.delete(filePath);
          reject(error);
        });
      }

      // Write the data
      const canContinue = stream.write(data, 'utf8', (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });

      // Handle backpressure
      if (!canContinue) {
        stream.once('drain', () => {
          // Stream is ready for more data
        });
      }
    });

    this.pendingWrites.set(filePath, writePromise);

    try {
      await writePromise;
    } finally {
      this.pendingWrites.delete(filePath);
    }
  }

  /**
   * Close the stream for a specific file path
   * @param filePath - Absolute path to the log file
   */
  async closeStream(filePath: string): Promise<void> {
    // Wait for any pending writes to complete
    const pending = this.pendingWrites.get(filePath);
    if (pending) {
      await pending.catch(() => {
        // Ignore errors on pending writes during close
      });
    }

    const stream = this.streams.get(filePath);
    if (stream) {
      return new Promise<void>((resolve) => {
        stream.end(() => {
          this.streams.delete(filePath);
          resolve();
        });
      });
    }
  }

  /**
   * Close all open streams
   */
  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.streams.keys()).map((filePath) =>
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
