import { v4 as uuid } from 'uuid';
import { message } from 'antd';
import intl from 'react-intl-universal';
import config from '@/utils/config';
import { request } from '@/utils/http';

// One confirmation owns one operation, including retries after a lost response.
export function createStopRequest(ids: readonly (string | number)[]) {
  const targets = [...ids];
  const headers = { 'Idempotency-Key': uuid() };
  return async () => {
    try {
      const result = await request.put(
        `${config.apiPrefix}crons/stop`,
        targets,
        { headers, retryInPlace: true },
      );
      if (result.code !== 200) throw new Error(result.message);
      return result;
    } catch (error) {
      message.error(intl.get('停止请求未确认，可重试本次操作'));
      throw error;
    }
  };
}
