export const COMPLETION_RECEIPT_SCHEMA_VERSION = 1;
export const MAX_COMPLETION_RECEIPT_BYTES = 4 * 1024;

const RECEIPT_KEYS = [
  'schemaVersion',
  'runId',
  'attemptId',
  'callbackSequence',
  'token',
  'startedAtMs',
  'finishedAtMs',
  'exitCode',
] as const;
const RECEIPT_KEY_SET = new Set<string>(RECEIPT_KEYS);
const PORTABLE_LOCAL_EXECUTION_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export interface CompletionReceipt {
  schemaVersion: typeof COMPLETION_RECEIPT_SCHEMA_VERSION;
  runId: string;
  attemptId: string;
  callbackSequence: number;
  token: string;
  startedAtMs: number;
  finishedAtMs: number;
  exitCode: number;
}

export class InvalidCompletionReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCompletionReceiptError';
  }
}

function invalid(message: string): never {
  throw new InvalidCompletionReceiptError(message);
}

function skipWhitespace(value: string, from: number): number {
  let index = from;
  while (/\s/.test(value[index] ?? '')) index += 1;
  return index;
}

function stringEnd(value: string, from: number): number {
  if (value[from] !== '"') invalid('Completion receipt key is not a string');
  for (let index = from + 1; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += 1;
      continue;
    }
    if (value[index] === '"') return index + 1;
  }
  return invalid('Completion receipt contains an unterminated string');
}

/** JSON.parse silently accepts duplicate keys, so reject them before parsing. */
function assertUniqueFlatObjectKeys(value: string): void {
  let index = skipWhitespace(value, 0);
  if (value[index] !== '{') invalid('Completion receipt must be a JSON object');
  index = skipWhitespace(value, index + 1);
  const keys = new Set<string>();
  if (value[index] === '}') return;

  while (index < value.length) {
    const keyStart = index;
    const keyEnd = stringEnd(value, keyStart);
    let key: string;
    try {
      key = JSON.parse(value.slice(keyStart, keyEnd));
    } catch {
      return invalid('Completion receipt contains an invalid key');
    }
    if (keys.has(key)) invalid('Completion receipt contains a duplicate key');
    keys.add(key);

    index = skipWhitespace(value, keyEnd);
    if (value[index] !== ':') invalid('Completion receipt key has no value');
    index = skipWhitespace(value, index + 1);
    if (value[index] === '"') {
      index = stringEnd(value, index);
    } else {
      if (value[index] === '{' || value[index] === '[') {
        invalid('Completion receipt values must be scalar');
      }
      const valueStart = index;
      while (
        index < value.length &&
        value[index] !== ',' &&
        value[index] !== '}'
      ) {
        index += 1;
      }
      if (value.slice(valueStart, index).trim().length === 0) {
        invalid('Completion receipt contains an empty value');
      }
    }

    index = skipWhitespace(value, index);
    if (value[index] === '}') return;
    if (value[index] !== ',')
      invalid('Completion receipt is not a flat object');
    index = skipWhitespace(value, index + 1);
  }
  invalid('Completion receipt object is incomplete');
}

export function assertCompletionReceiptId(
  value: string,
  field: 'runId' | 'attemptId',
): void {
  if (!PORTABLE_LOCAL_EXECUTION_ID.test(value)) {
    invalid(`${field} must be a bounded portable execution ID`);
  }
}

function assertSafeTimestamp(
  value: unknown,
  field: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${field} must be a non-negative safe integer`);
  }
}

export function validateCompletionReceipt(
  candidate: unknown,
): CompletionReceipt {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    invalid('Completion receipt must be an object');
  }
  const record = candidate as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== RECEIPT_KEYS.length ||
    keys.some((key) => !RECEIPT_KEY_SET.has(key)) ||
    RECEIPT_KEYS.some((key) => !Object.hasOwn(record, key))
  ) {
    invalid('Completion receipt fields do not match schema version 1');
  }
  if (record.schemaVersion !== COMPLETION_RECEIPT_SCHEMA_VERSION) {
    invalid('Completion receipt schema version is unsupported');
  }
  if (typeof record.runId !== 'string') invalid('runId must be a string');
  if (typeof record.attemptId !== 'string') {
    invalid('attemptId must be a string');
  }
  assertCompletionReceiptId(record.runId, 'runId');
  assertCompletionReceiptId(record.attemptId, 'attemptId');
  if (
    !Number.isSafeInteger(record.callbackSequence) ||
    (record.callbackSequence as number) < 1
  ) {
    invalid('callbackSequence must be a positive safe integer');
  }
  if (typeof record.token !== 'string' || !TOKEN_PATTERN.test(record.token)) {
    invalid('token must be a bounded base64url value');
  }
  assertSafeTimestamp(record.startedAtMs, 'startedAtMs');
  assertSafeTimestamp(record.finishedAtMs, 'finishedAtMs');
  if (record.finishedAtMs < record.startedAtMs) {
    invalid('finishedAtMs must not be before startedAtMs');
  }
  if (
    !Number.isInteger(record.exitCode) ||
    (record.exitCode as number) < 0 ||
    (record.exitCode as number) > 255
  ) {
    invalid('exitCode must be an integer between 0 and 255');
  }
  return {
    schemaVersion: COMPLETION_RECEIPT_SCHEMA_VERSION,
    runId: record.runId,
    attemptId: record.attemptId,
    callbackSequence: record.callbackSequence as number,
    token: record.token,
    startedAtMs: record.startedAtMs,
    finishedAtMs: record.finishedAtMs,
    exitCode: record.exitCode as number,
  };
}

export function serializeCompletionReceipt(receipt: CompletionReceipt): string {
  const value = validateCompletionReceipt(receipt);
  const serialized = JSON.stringify({
    schemaVersion: value.schemaVersion,
    runId: value.runId,
    attemptId: value.attemptId,
    callbackSequence: value.callbackSequence,
    token: value.token,
    startedAtMs: value.startedAtMs,
    finishedAtMs: value.finishedAtMs,
    exitCode: value.exitCode,
  });
  if (Buffer.byteLength(serialized, 'utf8') > MAX_COMPLETION_RECEIPT_BYTES) {
    invalid('Completion receipt exceeds the byte limit');
  }
  return serialized;
}

export function parseCompletionReceipt(
  input: string | Uint8Array,
): CompletionReceipt {
  const bytes =
    typeof input === 'string' ? Buffer.from(input) : Buffer.from(input);
  if (bytes.length === 0 || bytes.length > MAX_COMPLETION_RECEIPT_BYTES) {
    invalid('Completion receipt size is outside the allowed range');
  }
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes)) {
    invalid('Completion receipt must be valid UTF-8');
  }
  assertUniqueFlatObjectKeys(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid('Completion receipt is not valid JSON');
  }
  return validateCompletionReceipt(parsed);
}
