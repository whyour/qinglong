import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { DeleteCronRequest, DeleteCronResponse } from '../protos/cron';
import { scheduleStacks } from './data';
import Logger from '../loaders/logger';

const delCron = (
  call: ServerUnaryCall<DeleteCronRequest, DeleteCronResponse>,
  callback: sendUnaryData<DeleteCronResponse>,
) => {
  for (const id of call.request.ids) {
    if (scheduleStacks.has(id)) {
      Logger.info(
        '[schedule][取消定时任务] 任务ID: %s',
        id,
      );
      // 过滤掉 nodeSchedule.scheduleJob() 对无效表达式返回的 null，
      // 否则对 null 调 cancel() 会让整个取消流程抛出 UNKNOWN 错误，
      // 进而导致 HTTP 端的 remove() 跳过 setCrontab()，造成 crontab.list 残留。
      scheduleStacks.get(id)?.filter((x) => x != null).forEach((x) => {
        try {
          x.cancel();
        } catch (error: any) {
          Logger.warn(
            '[schedule][取消任务失败] 任务ID: %s, 错误: %s',
            id,
            error?.message || error,
          );
        }
      });
      scheduleStacks.delete(id);
    }
  }

  callback(null, null);
};

export { delCron };
