import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import type { LocalApplicationProfile } from '@qinglong/local-application';

import type {
  LocalApiAdmission,
  LocalApiAdmissionOperation,
  LocalApiAdmissionRequest,
} from '../admission/localApiAdmission';
import type { BoundedRunListInput } from '@qinglong/runtime-core/bounded-run-list-projection';
import type { BoundedRunEventListInput } from '@qinglong/runtime-core/bounded-run-event-list-projection';
import type { BoundedRunStepListInput } from '@qinglong/runtime-core/bounded-run-step-list-projection';
import type { BoundedTaskListInput } from '@qinglong/runtime-core/bounded-task-list-projection';
import { assertLocalSecretName } from '@qinglong/runtime-core/local-secret';
import {
  loadLocalConsoleAssets,
  type LocalConsoleAsset,
} from '../console/localConsoleAssets';
import type { LocalApiResponse } from './contract';

const MAX_HEADER_BYTES = 8 * 1_024;
const MAX_URL_BYTES = 512;
const MAX_RESPONSE_BYTES = 80 * 1_024;
const RUN_READ_ROUTE_PATTERN =
  /^\/api\/v3\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/runs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const RUN_LIST_ROUTE_PATTERN =
  /^\/api\/v3\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/runs$/;
const RUN_EVENT_LIST_ROUTE_PATTERN =
  /^\/api\/v3\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/runs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/events$/;
const RUN_STEP_LIST_ROUTE_PATTERN =
  /^\/api\/v3\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/runs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/steps$/;
const RUN_CANCELLATION_ROUTE_PATTERN =
  /^\/api\/v3\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/runs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/cancellation$/;
const RUN_ATTEMPT_LOG_READ_ROUTE_PATTERN =
  /^\/api\/v3\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/runs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/attempts\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/log$/;
const TASK_LIST_ROUTE_PATTERN =
  /^\/api\/v3\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/tasks$/;
const TASK_READ_ROUTE_PATTERN =
  /^\/api\/v3\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/tasks\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const TASK_START_ROUTE_PATTERN =
  /^\/api\/v3\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/tasks\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/runs$/;
const TASK_AUTHORING_ROUTE_PATTERN =
  /^\/api\/v3\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/tasks\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/authoring$/;
const TRIGGER_LIST_ROUTE_PATTERN =
  /^\/api\/v3\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/triggers$/;
const TRIGGER_READ_ROUTE_PATTERN =
  /^\/api\/v3\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/triggers\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const SECRET_ROUTE_PATTERN =
  /^\/api\/v3\/projects\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/secrets$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCAL_CONSOLE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

type LocalApiRouteResolution =
  | LocalApiAdmissionOperation
  | Readonly<{
      errorCode:
        | 'invalid_run_list_query'
        | 'invalid_run_event_list_query'
        | 'invalid_run_step_list_query'
        | 'invalid_run_log_read_query'
        | 'invalid_task_list_query'
        | 'invalid_trigger_list_query'
        | 'invalid_secret_list_query';
    }>;

export interface LocalApiHttpSurfaceOptions {
  readonly profile: LocalApplicationProfile;
  readonly host: '127.0.0.1' | '::1';
  readonly port: number;
  readonly admission: LocalApiAdmission;
  readonly randomUuid?: () => string;
}

export interface ActiveLocalApiHttpSurface {
  readonly host: '127.0.0.1' | '::1';
  readonly port: number;
  stopAndDrain(): Promise<'stopped' | 'timed_out'>;
}

function rawHeaderValues(
  request: IncomingMessage,
  name: string,
): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  return values;
}

function authorization(request: IncomingMessage): string | null {
  const values = rawHeaderValues(request, 'authorization');
  return values.length === 1 ? values[0]! : null;
}

function localPresence(request: IncomingMessage): string | null {
  const values = rawHeaderValues(request, 'x-qinglong-local-presence');
  if (values.length === 0) return null;
  if (values.length !== 1 || values[0]!.length > 160) {
    throw new TypeError('invalid_local_presence');
  }
  return values[0]!;
}

function taskAuthoringLease(request: IncomingMessage): string | null {
  const values = rawHeaderValues(request, 'x-qinglong-task-authoring-lease');
  if (values.length === 0) return null;
  if (values.length !== 1 || values[0]!.length > 160) {
    throw new TypeError('invalid_task_authoring_lease');
  }
  return values[0]!;
}

function hasRequestBody(request: IncomingMessage): boolean {
  const transferEncoding = rawHeaderValues(request, 'transfer-encoding');
  const contentLength = rawHeaderValues(request, 'content-length');
  return (
    transferEncoding.length !== 0 ||
    contentLength.length > 1 ||
    (contentLength.length === 1 && contentLength[0] !== '0')
  );
}

function jsonContentLength(
  request: IncomingMessage,
  maximumBodyBytes: number,
): number {
  const transferEncoding = rawHeaderValues(request, 'transfer-encoding');
  const contentLength = rawHeaderValues(request, 'content-length');
  const contentType = rawHeaderValues(request, 'content-type');
  if (
    transferEncoding.length !== 0 ||
    contentLength.length !== 1 ||
    contentType.length !== 1 ||
    contentType[0]!.trim().toLowerCase() !== 'application/json' ||
    !/^[1-9]\d*$/.test(contentLength[0]!)
  ) {
    throw new TypeError('invalid_request_body');
  }
  const length = Number(contentLength[0]);
  if (!Number.isSafeInteger(length) || length > maximumBodyBytes) {
    throw new RangeError('request_body_too_large');
  }
  return length;
}

function readJsonBody(
  request: IncomingMessage,
  expectedBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const aborted = () => fail(new Error('request_unavailable'));
    const cleanup = () => {
      signal.removeEventListener('abort', aborted);
      request.removeListener('data', data);
      request.removeListener('end', end);
      request.removeListener('error', fail);
    };
    const data = (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > expectedBytes) {
        fail(new TypeError('invalid_request_body'));
        return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      if (received !== expectedBytes) {
        reject(new TypeError('invalid_request_body'));
        return;
      }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.concat(chunks, received),
        );
        resolve(JSON.parse(text));
      } catch {
        reject(new TypeError('invalid_request_body'));
      }
    };
    signal.addEventListener('abort', aborted, { once: true });
    request.on('data', data);
    request.once('end', end);
    request.once('error', fail);
    if (signal.aborted) aborted();
  });
}

function parseRunListQuery(rawQuery: string | undefined): BoundedRunListInput {
  if (rawQuery === undefined) return Object.freeze({});
  if (rawQuery.length === 0) throw new TypeError();
  const values = new Map<string, string>();
  for (const field of rawQuery.split('&')) {
    const separator = field.indexOf('=');
    if (
      separator < 1 ||
      separator !== field.lastIndexOf('=') ||
      separator === field.length - 1
    ) {
      throw new TypeError();
    }
    const name = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (
      values.has(name) ||
      (name !== 'limit' &&
        name !== 'after_created_at_ms' &&
        name !== 'after_run_id')
    ) {
      throw new TypeError();
    }
    values.set(name, value);
  }
  const rawLimit = values.get('limit');
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (
    rawLimit !== undefined &&
    (!Number.isSafeInteger(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 64 ||
      String(limit) !== rawLimit)
  ) {
    throw new TypeError();
  }
  const rawCreatedAtMs = values.get('after_created_at_ms');
  const runId = values.get('after_run_id');
  if ((rawCreatedAtMs === undefined) !== (runId === undefined)) {
    throw new TypeError();
  }
  if (rawCreatedAtMs === undefined || runId === undefined) {
    return Object.freeze({ ...(limit === undefined ? {} : { limit }) });
  }
  const createdAtMs = Number(rawCreatedAtMs);
  if (
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 0 ||
    String(createdAtMs) !== rawCreatedAtMs ||
    !RUN_ID_PATTERN.test(runId)
  ) {
    throw new TypeError();
  }
  return Object.freeze({
    ...(limit === undefined ? {} : { limit }),
    after: Object.freeze({ createdAtMs, runId }),
  });
}

function parseRunEventListQuery(
  rawQuery: string | undefined,
): BoundedRunEventListInput {
  if (rawQuery === undefined) return Object.freeze({});
  if (rawQuery.length === 0) throw new TypeError();
  const values = new Map<string, string>();
  for (const field of rawQuery.split('&')) {
    const separator = field.indexOf('=');
    if (
      separator < 1 ||
      separator !== field.lastIndexOf('=') ||
      separator === field.length - 1
    ) {
      throw new TypeError();
    }
    const name = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (values.has(name) || (name !== 'limit' && name !== 'after_sequence')) {
      throw new TypeError();
    }
    values.set(name, value);
  }
  const rawLimit = values.get('limit');
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  const rawAfterSequence = values.get('after_sequence');
  const afterSequence =
    rawAfterSequence === undefined ? undefined : Number(rawAfterSequence);
  if (
    (rawLimit !== undefined &&
      (!Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 64 ||
        String(limit) !== rawLimit)) ||
    (rawAfterSequence !== undefined &&
      (!Number.isSafeInteger(afterSequence) ||
        Number(afterSequence) < 0 ||
        Number(afterSequence) > 2_147_483_647 ||
        String(afterSequence) !== rawAfterSequence))
  ) {
    throw new TypeError();
  }
  return Object.freeze({
    ...(afterSequence === undefined ? {} : { afterSequence }),
    ...(limit === undefined ? {} : { limit }),
  });
}

function parseRunStepListQuery(
  rawQuery: string | undefined,
): BoundedRunStepListInput {
  if (rawQuery === undefined) return Object.freeze({});
  if (rawQuery.length === 0) throw new TypeError();
  const values = new Map<string, string>();
  for (const field of rawQuery.split('&')) {
    const separator = field.indexOf('=');
    if (
      separator < 1 ||
      separator !== field.lastIndexOf('=') ||
      separator === field.length - 1
    ) {
      throw new TypeError();
    }
    const name = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (
      values.has(name) ||
      (name !== 'limit' &&
        name !== 'after_step_key' &&
        name !== 'after_step_run_id')
    ) {
      throw new TypeError();
    }
    values.set(name, value);
  }
  const rawLimit = values.get('limit');
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (
    rawLimit !== undefined &&
    (!Number.isSafeInteger(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 64 ||
      String(limit) !== rawLimit)
  ) {
    throw new TypeError();
  }
  const stepKey = values.get('after_step_key');
  const stepRunId = values.get('after_step_run_id');
  if ((stepKey === undefined) !== (stepRunId === undefined)) {
    throw new TypeError();
  }
  if (stepKey === undefined || stepRunId === undefined) {
    return Object.freeze({ ...(limit === undefined ? {} : { limit }) });
  }
  if (!RUN_ID_PATTERN.test(stepKey) || !RUN_ID_PATTERN.test(stepRunId)) {
    throw new TypeError();
  }
  return Object.freeze({
    ...(limit === undefined ? {} : { limit }),
    after: Object.freeze({ stepKey, stepRunId }),
  });
}

function parseTaskListQuery(
  rawQuery: string | undefined,
): BoundedTaskListInput {
  if (rawQuery === undefined) return Object.freeze({});
  if (rawQuery.length === 0) throw new TypeError();
  const values = new Map<string, string>();
  for (const field of rawQuery.split('&')) {
    const separator = field.indexOf('=');
    if (
      separator < 1 ||
      separator !== field.lastIndexOf('=') ||
      separator === field.length - 1
    ) {
      throw new TypeError();
    }
    const name = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (values.has(name) || (name !== 'limit' && name !== 'after_task_id')) {
      throw new TypeError();
    }
    values.set(name, value);
  }
  const rawLimit = values.get('limit');
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  const taskId = values.get('after_task_id');
  if (
    (rawLimit !== undefined &&
      (!Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 64 ||
        String(limit) !== rawLimit)) ||
    (taskId !== undefined && !TASK_ID_PATTERN.test(taskId))
  ) {
    throw new TypeError();
  }
  return Object.freeze({
    ...(limit === undefined ? {} : { limit }),
    ...(taskId === undefined ? {} : { after: Object.freeze({ taskId }) }),
  });
}

function parseTriggerListQuery(
  rawQuery: string | undefined,
  profile: LocalApplicationProfile,
): Readonly<{
  limit: number;
  after?: Readonly<{ readonly triggerId: string }>;
}> {
  if (rawQuery === undefined) {
    return Object.freeze({ limit: profile === 'edge' ? 16 : 32 });
  }
  if (rawQuery.length === 0) throw new TypeError();
  const values = new Map<string, string>();
  for (const field of rawQuery.split('&')) {
    const separator = field.indexOf('=');
    if (
      separator < 1 ||
      separator !== field.lastIndexOf('=') ||
      separator === field.length - 1
    ) {
      throw new TypeError();
    }
    const name = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (values.has(name) || (name !== 'limit' && name !== 'after_trigger_id')) {
      throw new TypeError();
    }
    values.set(name, value);
  }
  const rawLimit = values.get('limit');
  const limit =
    rawLimit === undefined ? (profile === 'edge' ? 16 : 32) : Number(rawLimit);
  const triggerId = values.get('after_trigger_id');
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 64 ||
    (rawLimit !== undefined && String(limit) !== rawLimit) ||
    (triggerId !== undefined && !TASK_ID_PATTERN.test(triggerId))
  ) {
    throw new TypeError();
  }
  return Object.freeze({
    limit,
    ...(triggerId === undefined ? {} : { after: Object.freeze({ triggerId }) }),
  });
}

function parseSecretListQuery(
  rawQuery: string | undefined,
  profile: LocalApplicationProfile,
): Readonly<{
  limit: number;
  after?: Readonly<{ readonly name: string }>;
}> {
  if (rawQuery === undefined) {
    return Object.freeze({ limit: profile === 'edge' ? 16 : 32 });
  }
  if (rawQuery.length === 0) throw new TypeError();
  const values = new Map<string, string>();
  for (const field of rawQuery.split('&')) {
    const separator = field.indexOf('=');
    if (
      separator < 1 ||
      separator !== field.lastIndexOf('=') ||
      separator === field.length - 1
    ) {
      throw new TypeError();
    }
    const name = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (values.has(name) || (name !== 'limit' && name !== 'after')) {
      throw new TypeError();
    }
    values.set(name, value);
  }
  const rawLimit = values.get('limit');
  const limit =
    rawLimit === undefined ? (profile === 'edge' ? 16 : 32) : Number(rawLimit);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 64 ||
    (rawLimit !== undefined && String(limit) !== rawLimit)
  ) {
    throw new TypeError();
  }
  const encoded = values.get('after');
  if (encoded === undefined) return Object.freeze({ limit });
  if (encoded.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new TypeError();
  }
  const bytes = Buffer.from(encoded, 'base64url');
  let name: string;
  try {
    if (bytes.toString('base64url') !== encoded) throw new TypeError();
    name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assertLocalSecretName(name);
  } finally {
    bytes.fill(0);
  }
  return Object.freeze({ limit, after: Object.freeze({ name }) });
}

function parseRunAttemptLogReadQuery(
  rawQuery: string | undefined,
  profile: LocalApplicationProfile,
): Readonly<{ offset: number; length: number }> {
  const defaultLength = profile === 'edge' ? 16 * 1024 : 32 * 1024;
  if (rawQuery === undefined) {
    return Object.freeze({ offset: 0, length: defaultLength });
  }
  if (rawQuery.length === 0) throw new TypeError();
  const values = new Map<string, string>();
  for (const field of rawQuery.split('&')) {
    const separator = field.indexOf('=');
    if (
      separator < 1 ||
      separator !== field.lastIndexOf('=') ||
      separator === field.length - 1
    ) {
      throw new TypeError();
    }
    const name = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (values.has(name) || (name !== 'offset' && name !== 'length')) {
      throw new TypeError();
    }
    values.set(name, value);
  }
  const rawOffset = values.get('offset');
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);
  const rawLength = values.get('length');
  const length = rawLength === undefined ? defaultLength : Number(rawLength);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (rawOffset !== undefined && String(offset) !== rawOffset) ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > 32 * 1024 ||
    (rawLength !== undefined && String(length) !== rawLength)
  ) {
    throw new TypeError();
  }
  return Object.freeze({ offset, length });
}

function route(
  request: IncomingMessage,
  profile: LocalApplicationProfile,
): LocalApiRouteResolution | null {
  const rawUrl = request.url;
  if (
    typeof rawUrl !== 'string' ||
    rawUrl.length < 1 ||
    Buffer.byteLength(rawUrl, 'utf8') > MAX_URL_BYTES ||
    rawUrl.includes('%') ||
    rawUrl.includes('#')
  ) {
    return null;
  }
  const separator = rawUrl.indexOf('?');
  if (separator !== rawUrl.lastIndexOf('?')) return null;
  const path = separator < 0 ? rawUrl : rawUrl.slice(0, separator);
  const rawQuery = separator < 0 ? undefined : rawUrl.slice(separator + 1);
  if (request.method === 'POST') {
    const taskAuthoringMatch = TASK_AUTHORING_ROUTE_PATTERN.exec(path);
    if (taskAuthoringMatch && rawQuery === undefined) {
      return Object.freeze({
        operationId: 'task.authoring',
        projectId: taskAuthoringMatch[1]!,
        taskId: taskAuthoringMatch[2]!,
      });
    }
    const taskStartMatch = TASK_START_ROUTE_PATTERN.exec(path);
    if (taskStartMatch && rawQuery === undefined) {
      return Object.freeze({
        operationId: 'task.start',
        projectId: taskStartMatch[1]!,
        taskId: taskStartMatch[2]!,
      });
    }
    const cancellationMatch = RUN_CANCELLATION_ROUTE_PATTERN.exec(path);
    return cancellationMatch && rawQuery === undefined
      ? Object.freeze({
          operationId: 'run.cancel',
          projectId: cancellationMatch[1]!,
          runId: cancellationMatch[2]!,
        })
      : null;
  }
  if (request.method === 'PUT') {
    const secretPutMatch = SECRET_ROUTE_PATTERN.exec(path);
    if (secretPutMatch && rawQuery === undefined) {
      return Object.freeze({
        operationId: 'secret.put',
        projectId: secretPutMatch[1]!,
      });
    }
    const triggerPutMatch = TRIGGER_READ_ROUTE_PATTERN.exec(path);
    if (triggerPutMatch && rawQuery === undefined) {
      return Object.freeze({
        operationId: 'trigger.put',
        projectId: triggerPutMatch[1]!,
        triggerId: triggerPutMatch[2]!,
      });
    }
    const taskPutMatch = TASK_READ_ROUTE_PATTERN.exec(path);
    return taskPutMatch && rawQuery === undefined
      ? Object.freeze({
          operationId: 'task.put',
          projectId: taskPutMatch[1]!,
          taskId: taskPutMatch[2]!,
        })
      : null;
  }
  if (request.method !== 'GET') return null;
  const secretListMatch = SECRET_ROUTE_PATTERN.exec(path);
  if (secretListMatch) {
    try {
      return Object.freeze({
        operationId: 'secret.list',
        projectId: secretListMatch[1]!,
        ...parseSecretListQuery(rawQuery, profile),
      });
    } catch {
      return Object.freeze({ errorCode: 'invalid_secret_list_query' });
    }
  }
  const triggerReadMatch = TRIGGER_READ_ROUTE_PATTERN.exec(path);
  if (triggerReadMatch) {
    return rawQuery === undefined
      ? Object.freeze({
          operationId: 'trigger.get',
          projectId: triggerReadMatch[1]!,
          triggerId: triggerReadMatch[2]!,
        })
      : null;
  }
  const triggerListMatch = TRIGGER_LIST_ROUTE_PATTERN.exec(path);
  if (triggerListMatch) {
    try {
      const input = parseTriggerListQuery(rawQuery, profile);
      return Object.freeze({
        operationId: 'trigger.list',
        projectId: triggerListMatch[1]!,
        ...input,
      });
    } catch {
      return Object.freeze({ errorCode: 'invalid_trigger_list_query' });
    }
  }
  const runAttemptLogReadMatch = RUN_ATTEMPT_LOG_READ_ROUTE_PATTERN.exec(path);
  if (runAttemptLogReadMatch) {
    try {
      return Object.freeze({
        operationId: 'run.log.read',
        projectId: runAttemptLogReadMatch[1]!,
        runId: runAttemptLogReadMatch[2]!,
        attemptId: runAttemptLogReadMatch[3]!,
        ...parseRunAttemptLogReadQuery(rawQuery, profile),
      });
    } catch {
      return Object.freeze({ errorCode: 'invalid_run_log_read_query' });
    }
  }
  const taskReadMatch = TASK_READ_ROUTE_PATTERN.exec(path);
  if (taskReadMatch) {
    return rawQuery === undefined
      ? Object.freeze({
          operationId: 'task.get',
          projectId: taskReadMatch[1]!,
          taskId: taskReadMatch[2]!,
        })
      : null;
  }
  const taskListMatch = TASK_LIST_ROUTE_PATTERN.exec(path);
  if (taskListMatch) {
    try {
      return Object.freeze({
        operationId: 'task.list',
        projectId: taskListMatch[1]!,
        input: parseTaskListQuery(rawQuery),
      });
    } catch {
      return Object.freeze({ errorCode: 'invalid_task_list_query' });
    }
  }
  const eventListMatch = RUN_EVENT_LIST_ROUTE_PATTERN.exec(path);
  if (eventListMatch) {
    try {
      return Object.freeze({
        operationId: 'run.events.list',
        projectId: eventListMatch[1]!,
        runId: eventListMatch[2]!,
        input: parseRunEventListQuery(rawQuery),
      });
    } catch {
      return Object.freeze({ errorCode: 'invalid_run_event_list_query' });
    }
  }
  const stepListMatch = RUN_STEP_LIST_ROUTE_PATTERN.exec(path);
  if (stepListMatch) {
    try {
      return Object.freeze({
        operationId: 'run.steps.list',
        projectId: stepListMatch[1]!,
        runId: stepListMatch[2]!,
        input: parseRunStepListQuery(rawQuery),
      });
    } catch {
      return Object.freeze({ errorCode: 'invalid_run_step_list_query' });
    }
  }
  const readMatch = RUN_READ_ROUTE_PATTERN.exec(path);
  if (readMatch) {
    return rawQuery === undefined
      ? Object.freeze({
          operationId: 'run.get',
          projectId: readMatch[1]!,
          runId: readMatch[2]!,
        })
      : null;
  }
  const listMatch = RUN_LIST_ROUTE_PATTERN.exec(path);
  if (!listMatch) return null;
  try {
    return Object.freeze({
      operationId: 'run.list',
      projectId: listMatch[1]!,
      input: parseRunListQuery(rawQuery),
    });
  } catch {
    return Object.freeze({ errorCode: 'invalid_run_list_query' });
  }
}

function send(
  response: ServerResponse,
  requestId: string,
  value: Readonly<LocalApiResponse>,
): void {
  if (response.destroyed || response.headersSent) return;
  let body: string;
  try {
    body = JSON.stringify(value.body);
  } catch {
    body = JSON.stringify({ code: 'response_unavailable' });
    value = Object.freeze({ statusCode: 503, body: Object.freeze({}) });
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    body = JSON.stringify({ code: 'response_unavailable' });
    value = Object.freeze({ statusCode: 503, body: Object.freeze({}) });
  }
  response.statusCode = value.statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-request-id', requestId);
  response.setHeader('content-length', Buffer.byteLength(body, 'utf8'));
  response.end(body);
}

function sendConsoleAsset(
  response: ServerResponse,
  requestId: string,
  asset: Readonly<LocalConsoleAsset>,
): void {
  if (response.destroyed || response.headersSent) return;
  response.statusCode = 200;
  response.setHeader('content-type', asset.contentType);
  response.setHeader('cache-control', 'no-store');
  response.setHeader(
    'content-security-policy',
    LOCAL_CONSOLE_CONTENT_SECURITY_POLICY,
  );
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader(
    'permissions-policy',
    'camera=(), geolocation=(), microphone=()',
  );
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('x-request-id', requestId);
  response.setHeader('etag', asset.etag);
  response.setHeader('content-length', asset.body.byteLength);
  response.end(asset.body);
}

function sendConsoleFavicon(response: ServerResponse, requestId: string): void {
  if (response.destroyed || response.headersSent) return;
  response.statusCode = 204;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-request-id', requestId);
  response.end();
}

function errorResponse(statusCode: number, code: string): LocalApiResponse {
  return Object.freeze({
    statusCode,
    body: Object.freeze({ code }),
  });
}

function validateOptions(options: LocalApiHttpSurfaceOptions): void {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    (options.profile !== 'edge' && options.profile !== 'standalone') ||
    (options.host !== '127.0.0.1' && options.host !== '::1') ||
    !Number.isSafeInteger(options.port) ||
    options.port < 1_024 ||
    options.port > 65_535 ||
    typeof options.admission?.prepare !== 'function' ||
    (options.randomUuid !== undefined &&
      typeof options.randomUuid !== 'function')
  ) {
    throw new TypeError('Local API HTTP surface options are invalid');
  }
}

export async function startLocalApiHttpSurface(
  options: LocalApiHttpSurfaceOptions,
): Promise<Readonly<ActiveLocalApiHttpSurface>> {
  validateOptions(options);
  const consoleAssets = loadLocalConsoleAssets();
  const uuid = options.randomUuid ?? randomUUID;
  const maxConcurrentRequests = options.profile === 'edge' ? 4 : 32;
  const drainTimeoutMs = options.profile === 'edge' ? 5_000 : 10_000;
  let accepting = true;
  const inFlight = new Set<Promise<void>>();
  const sockets = new Set<Socket>();

  const server = http.createServer(
    {
      maxHeaderSize: MAX_HEADER_BYTES,
      requestTimeout: 5_000,
      keepAlive: true,
    },
    (request, response) => {
      const requestId = `local:${uuid()}`;
      if (!accepting) {
        send(response, requestId, errorResponse(503, 'server_draining'));
        return;
      }
      if (inFlight.size >= maxConcurrentRequests) {
        send(response, requestId, errorResponse(503, 'server_overloaded'));
        return;
      }
      const consoleAsset =
        request.method === 'GET' && typeof request.url === 'string'
          ? consoleAssets.get(request.url)
          : undefined;
      if (consoleAsset) {
        if (hasRequestBody(request)) {
          send(response, requestId, errorResponse(400, 'invalid_request_body'));
          request.resume();
          return;
        }
        sendConsoleAsset(response, requestId, consoleAsset);
        return;
      }
      if (request.method === 'GET' && request.url === '/favicon.ico') {
        if (hasRequestBody(request)) {
          send(response, requestId, errorResponse(400, 'invalid_request_body'));
          request.resume();
          return;
        }
        sendConsoleFavicon(response, requestId);
        return;
      }
      const resolvedRoute = route(request, options.profile);
      if (!resolvedRoute) {
        send(response, requestId, errorResponse(404, 'route_not_found'));
        return;
      }
      if ('errorCode' in resolvedRoute) {
        send(response, requestId, errorResponse(400, resolvedRoute.errorCode));
        return;
      }
      const abort = new AbortController();
      request.once('aborted', () => abort.abort());
      response.once('close', () => {
        if (!response.writableFinished) abort.abort();
      });
      let presentedLocalPresence: string | null;
      try {
        presentedLocalPresence = localPresence(request);
      } catch {
        send(response, requestId, errorResponse(400, 'invalid_local_presence'));
        request.resume();
        return;
      }
      let presentedTaskAuthoringLease: string | null;
      try {
        presentedTaskAuthoringLease = taskAuthoringLease(request);
      } catch {
        send(
          response,
          requestId,
          errorResponse(400, 'invalid_task_authoring_lease'),
        );
        request.resume();
        return;
      }
      const admissionRequest: LocalApiAdmissionRequest = Object.freeze({
        requestId,
        operation: resolvedRoute,
        authorization: authorization(request),
        localPresence: presentedLocalPresence,
        taskAuthoringLease: presentedTaskAuthoringLease,
        signal: abort.signal,
      });
      let operation: Promise<void>;
      operation = options.admission
        .prepare(admissionRequest)
        .then(async (prepared) => {
          if (!('handle' in prepared)) {
            if (hasRequestBody(request)) {
              response.setHeader('connection', 'close');
            }
            send(response, requestId, prepared);
            return;
          }
          if (prepared.bodyMode === 'none') {
            if (hasRequestBody(request)) {
              send(
                response,
                requestId,
                errorResponse(400, 'invalid_request_body'),
              );
              request.resume();
              return;
            }
            send(response, requestId, await prepared.handle(null));
            return;
          }
          let body: unknown;
          try {
            const expectedBytes = jsonContentLength(
              request,
              prepared.maximumBodyBytes,
            );
            body = await readJsonBody(request, expectedBytes, abort.signal);
          } catch (error) {
            const code =
              error instanceof RangeError
                ? 'request_body_too_large'
                : error instanceof Error &&
                  error.message === 'request_unavailable'
                ? 'request_unavailable'
                : 'invalid_request_body';
            send(
              response,
              requestId,
              errorResponse(
                code === 'request_body_too_large'
                  ? 413
                  : code === 'request_unavailable'
                  ? 503
                  : 400,
                code,
              ),
            );
            return;
          }
          send(response, requestId, await prepared.handle(body));
        })
        .catch(() =>
          send(response, requestId, errorResponse(503, 'request_unavailable')),
        )
        .finally(() => {
          inFlight.delete(operation);
        });
      inFlight.add(operation);
    },
  );
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = maxConcurrentRequests * 2;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(options.port, options.host);
    });
  } catch (error) {
    accepting = false;
    for (const socket of sockets) socket.destroy();
    throw error;
  }

  let stopPromise: Promise<'stopped' | 'timed_out'> | undefined;
  return Object.freeze({
    host: options.host,
    port: options.port,
    stopAndDrain() {
      if (stopPromise) return stopPromise;
      accepting = false;
      stopPromise = (async () => {
        const closed = new Promise<void>((resolve, reject) => {
          server.close((error?: Error) => {
            if (error) reject(error);
            else resolve();
          });
          server.closeIdleConnections();
        });
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<'timed_out'>((resolve) => {
          timer = setTimeout(() => resolve('timed_out'), drainTimeoutMs);
        });
        const drained = Promise.allSettled([...inFlight]).then(
          () => 'stopped' as const,
        );
        const result = await Promise.race([drained, timeout]);
        if (timer) clearTimeout(timer);
        if (result === 'timed_out') {
          for (const socket of sockets) socket.destroy();
        }
        await closed;
        return result;
      })();
      return stopPromise;
    },
  });
}
