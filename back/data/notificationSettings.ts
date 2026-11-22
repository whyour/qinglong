import { AuthDataType, SystemModel } from './system';
import type { NotificationInfo } from './notify';

// Keep the same lookup and missing-row semantics as UserService.getDb.
export async function readNotificationMode(): Promise<NotificationInfo> {
  const query = { type: AuthDataType.notification };
  const doc = await SystemModel.findOne({ where: { ...query } });
  if (!doc) {
    throw new Error(`${JSON.stringify(query)} not found`);
  }
  return (doc.get({ plain: true }).info || {}) as NotificationInfo;
}
