import {
  BUILT_IN_CRON_TRIGGER_SPEC_SCHEMA,
  createBuiltInTriggerSpecSemanticRegistry,
  normalizeTriggerRecord,
  type TriggerSource,
} from '@qinglong/runtime-core/trigger';
import {
  normalizeTaskDefinitionRecord,
  type TaskDefinitionSource,
} from '@qinglong/runtime-core/task-definition';

import type { LocalApiResponse } from '../transport/contract';

const MAX_PANEL_PAGE_SIZE = 64;

export interface PanelCronListRequest {
  readonly projectId: string;
  readonly page: number;
  readonly size: number;
  readonly maximumRows: number;
}

export interface PanelCronListRoute {
  handle(request: Readonly<PanelCronListRequest>): Promise<LocalApiResponse>;
}

export interface PanelCronListSources {
  readonly tasks: Pick<TaskDefinitionSource, 'findTaskDefinitionRevision'>;
  readonly triggers: Pick<TriggerSource, 'listTriggers'>;
}

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): LocalApiResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function validRequest(request: Readonly<PanelCronListRequest>): boolean {
  return (
    typeof request.projectId === 'string' &&
    request.projectId.length > 0 &&
    Buffer.byteLength(request.projectId, 'utf8') <= 128 &&
    Number.isSafeInteger(request.page) &&
    request.page >= 1 &&
    Number.isSafeInteger(request.size) &&
    request.size >= 1 &&
    request.size <= MAX_PANEL_PAGE_SIZE &&
    Number.isSafeInteger(request.maximumRows) &&
    request.maximumRows >= 1 &&
    request.maximumRows <= 256 &&
    (request.page - 1) * request.size < request.maximumRows
  );
}

export function createPanelCronListRoute(
  sources: Readonly<PanelCronListSources>,
): Readonly<PanelCronListRoute> {
  if (
    !sources ||
    typeof sources !== 'object' ||
    Array.isArray(sources) ||
    typeof sources.tasks?.findTaskDefinitionRevision !== 'function' ||
    typeof sources.triggers?.listTriggers !== 'function'
  ) {
    throw new TypeError('Panel Cron list sources are invalid');
  }
  const semantics = createBuiltInTriggerSpecSemanticRegistry();
  return Object.freeze({
    async handle(request: Readonly<PanelCronListRequest>) {
      if (!validRequest(request)) {
        return response(400, { code: 400, message: '参数错误' });
      }
      try {
        const scanLimit = Math.min(
          request.page * request.size,
          request.maximumRows,
        );
        const page = await sources.triggers.listTriggers({
          projectId: request.projectId,
          limit: scanLimit,
        });
        if (
          !page ||
          !Array.isArray(page.triggers) ||
          page.triggers.length > scanLimit ||
          typeof page.truncated !== 'boolean' ||
          page.truncated !== Boolean(page.next)
        ) {
          throw new TypeError('Trigger page is unavailable');
        }
        const start = (request.page - 1) * request.size;
        const selected = page.triggers.slice(start, scanLimit);
        const data: Record<string, unknown>[] = [];
        for (const rawTrigger of selected) {
          const trigger = normalizeTriggerRecord(rawTrigger);
          if (
            trigger.projectId !== request.projectId ||
            trigger.spec.schema !== BUILT_IN_CRON_TRIGGER_SPEC_SCHEMA
          ) {
            throw new TypeError('Trigger cannot be projected as a Cron');
          }
          const spec = semantics.normalize({
            projectId: trigger.projectId,
            triggerId: trigger.triggerId,
            taskId: trigger.taskId,
            taskRevision: trigger.taskRevision,
            spec: trigger.spec,
          });
          const rawTask = await sources.tasks.findTaskDefinitionRevision(
            request.projectId,
            trigger.taskId,
            trigger.taskRevision,
          );
          if (!rawTask) throw new TypeError('Pinned Task is unavailable');
          const task = normalizeTaskDefinitionRecord(rawTask);
          if (
            task.projectId !== request.projectId ||
            task.taskId !== trigger.taskId ||
            task.revision !== trigger.taskRevision ||
            task.contentDigest !== trigger.taskContentDigest
          ) {
            throw new TypeError('Pinned Task identity is detached');
          }
          const disabled = !task.enabled || !trigger.enabled;
          data.push(
            Object.freeze({
              id: trigger.triggerId,
              name: task.name,
              command: `ql3:${task.kind}:${task.taskId}@${task.revision}`,
              schedule: spec.config.expression,
              extra_schedules: Object.freeze([]),
              status: disabled ? 2 : 1,
              isDisabled: disabled ? 1 : 0,
              isPinned: 0,
              createdAt: new Date(trigger.createdAtMs).toISOString(),
              updatedAt: new Date(trigger.updatedAtMs).toISOString(),
              ql3: Object.freeze({
                projectId: request.projectId,
                taskId: task.taskId,
                taskRevision: task.revision,
                triggerId: trigger.triggerId,
                triggerRevision: trigger.revision,
                timezone: spec.config.timezone,
                misfirePolicy: spec.config.misfirePolicy,
                readOnly: true,
              }),
            }),
          );
        }
        return response(200, {
          code: 200,
          data: Object.freeze({
            data: Object.freeze(data),
            total: Math.min(
              request.maximumRows,
              page.triggers.length + (page.truncated ? 1 : 0),
            ),
          }),
        });
      } catch {
        return response(503, {
          code: 503,
          message: 'QL3 面板兼容视图暂不可用',
        });
      }
    },
  });
}
