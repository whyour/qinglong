import { createHash, timingSafeEqual } from 'crypto';
import type { CompletionReceipt } from './completionReceipt';
import type { ExecutionContext } from './execution';

export const WORKER_COMPLETION_RECEIPT_TOKEN_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

const CALLBACK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export interface WorkerExecutionCompletionReceiptAuthentication {
  callbackSequence: number;
  tokenDigest: string;
}

export function createWorkerExecutionCompletionReceiptAuthentication(
  callback: ExecutionContext['completionCallback'],
): WorkerExecutionCompletionReceiptAuthentication | undefined {
  if (callback === undefined) return undefined;
  if (!CALLBACK_TOKEN_PATTERN.test(callback.token)) {
    throw new TypeError('Worker completion callback token is invalid');
  }
  if (
    !Number.isSafeInteger(callback.callbackSequence) ||
    callback.callbackSequence < 1
  ) {
    throw new TypeError(
      'Worker completion callback sequence must be a positive safe integer',
    );
  }
  return {
    callbackSequence: callback.callbackSequence,
    tokenDigest: createHash('sha256')
      .update(callback.token, 'utf8')
      .digest('hex'),
  };
}

export function matchesWorkerExecutionCompletionReceiptAuthentication(
  receipt: CompletionReceipt,
  expected: WorkerExecutionCompletionReceiptAuthentication,
): boolean {
  if (
    receipt.callbackSequence !== expected.callbackSequence ||
    !WORKER_COMPLETION_RECEIPT_TOKEN_DIGEST_PATTERN.test(expected.tokenDigest)
  ) {
    return false;
  }
  const actual = createHash('sha256').update(receipt.token, 'utf8').digest();
  const expectedBytes = Buffer.from(expected.tokenDigest, 'hex');
  return timingSafeEqual(actual, expectedBytes);
}
