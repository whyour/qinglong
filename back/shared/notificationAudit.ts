import { Query, QuerySpec, orderBy } from '../data/queries';
import {
  SystemModel,
  AuthDataType,
  NotifyStatus,
  NotifyLogInfo,
} from '../data/system';
// Both backend sends and script reports use the same bounded, best-effort sink.
export async function persistNotificationAudit(
  info: NotifyLogInfo,
): Promise<void> {
  try {
    await SystemModel.insert({
      type: AuthDataType.notifyLog,
      info: {
        timestamp: Date.now(),
        title: String(info.title || '').slice(0, 512),
        content: String(info.content || '').slice(0, 8192),
        status:
          info.status === NotifyStatus.success
            ? NotifyStatus.success
            : NotifyStatus.fail,
        notifyType: String(info.notifyType || '').slice(0, 64),
        source: info.source === 'script' ? 'script' : 'system',
        scriptName: String(info.scriptName || '').slice(0, 512),
        taskId: /^\d+$/.test(info.taskId || '') ? info.taskId : undefined,
      },
    });
    const oldest = await SystemModel.find(
      { type: AuthDataType.notifyLog },
      {
        fields: ['id'],
        orderBy: orderBy([['id', 'DESC']]),
        offset: 200,
        limit: 1,
      },
    );
    if (oldest[0]?.id) {
      await SystemModel.nativeDelete({
        type: AuthDataType.notifyLog,
        id: { ['$lte']: oldest[0].id },
      });
    }
  } catch (error) {
    console.error('Failed to persist notification audit log');
  }
}
