import { AsyncLocalStorage } from 'node:async_hooks';

type Sink = (chunk: Buffer) => void;
const storage = new AsyncLocalStorage<Sink>();

export function operationOutput(chunk: Buffer): void {
  const sink = storage.getStore();
  if (sink) sink(chunk);
  else process.stderr.write(chunk);
}

export function withOperationOutput<T>(
  sink: Sink,
  operation: () => Promise<T>,
): Promise<T> {
  return storage.run(sink, operation);
}
