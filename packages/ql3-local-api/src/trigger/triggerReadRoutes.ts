import {
  InvalidTriggerError,
  TriggerUnavailableError,
  type TriggerRecord,
  type TriggerSource,
} from '@qinglong/runtime-core/trigger';

import type { LocalApiResponse } from '../transport/contract';

export interface LocalApiTriggerListRequest {
  readonly projectId: string;
  readonly limit: number;
  readonly after?: Readonly<{ readonly triggerId: string }>;
}

export interface LocalApiTriggerReadRequest {
  readonly projectId: string;
  readonly triggerId: string;
}

export interface LocalApiTriggerListRoute {
  handle(
    request: Readonly<LocalApiTriggerListRequest>,
  ): Promise<LocalApiResponse>;
}

export interface LocalApiTriggerReadRoute {
  handle(
    request: Readonly<LocalApiTriggerReadRequest>,
  ): Promise<LocalApiResponse>;
}

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): LocalApiResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function summary(trigger: Readonly<TriggerRecord>) {
  return Object.freeze({
    triggerId: trigger.triggerId,
    revision: trigger.revision,
    taskId: trigger.taskId,
    taskRevision: trigger.taskRevision,
    specSchema: trigger.spec.schema,
    enabled: trigger.enabled,
    contentDigest: trigger.contentDigest,
    createdAtMs: trigger.createdAtMs,
    updatedAtMs: trigger.updatedAtMs,
  });
}

function detail(trigger: Readonly<TriggerRecord>) {
  return Object.freeze({
    ...summary(trigger),
    projectId: trigger.projectId,
    taskContentDigest: trigger.taskContentDigest,
    spec: trigger.spec,
  });
}

function unavailable(error: unknown): LocalApiResponse | null {
  return error instanceof InvalidTriggerError ||
    error instanceof TriggerUnavailableError
    ? response(503, { code: 'trigger_query_unavailable' })
    : null;
}

export function createLocalApiTriggerListRoute(
  triggers: Pick<TriggerSource, 'listTriggers'>,
): Readonly<LocalApiTriggerListRoute> {
  if (!triggers || typeof triggers.listTriggers !== 'function') {
    throw new TypeError('Local API Trigger list repository is invalid');
  }
  return Object.freeze({
    async handle(request: Readonly<LocalApiTriggerListRequest>) {
      try {
        const page = await triggers.listTriggers({
          projectId: request.projectId,
          limit: request.limit,
          ...(request.after ? { after: request.after } : {}),
        });
        return response(200, {
          triggers: Object.freeze(page.triggers.map(summary)),
          truncated: page.truncated,
          next: page.next ?? null,
        });
      } catch (error) {
        const mapped = unavailable(error);
        if (mapped) return mapped;
        throw error;
      }
    },
  });
}

export function createLocalApiTriggerReadRoute(
  triggers: Pick<TriggerSource, 'findCurrentTrigger'>,
): Readonly<LocalApiTriggerReadRoute> {
  if (!triggers || typeof triggers.findCurrentTrigger !== 'function') {
    throw new TypeError('Local API Trigger read repository is invalid');
  }
  return Object.freeze({
    async handle(request: Readonly<LocalApiTriggerReadRequest>) {
      try {
        const trigger = await triggers.findCurrentTrigger(
          request.projectId,
          request.triggerId,
        );
        return trigger
          ? response(200, { trigger: detail(trigger) })
          : response(404, { code: 'trigger_not_found' });
      } catch (error) {
        const mapped = unavailable(error);
        if (mapped) return mapped;
        throw error;
      }
    },
  });
}
