#!/usr/bin/env node
import { main } from '../compatibility/main';
import {
  withCommandCancellation,
  cancellableOperation,
  interruptedCode,
} from '../internal/runtime/cancellation';

void withCommandCancellation(async (signal) => {
  try {
    return await cancellableOperation(signal, () =>
      main(process.argv.slice(2), 'local', signal),
    );
  } catch (error) {
    const code = interruptedCode(signal);
    if (code !== undefined) return code;
    throw error;
  }
}).then((code) => {
  process.exitCode = code;
});
