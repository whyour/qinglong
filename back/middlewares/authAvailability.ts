import type { RequestHandler } from 'express';
import { t } from '../shared/i18n';

// Express 4 does not forward rejected async middleware promises itself.
export function withAuthAvailability(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve()
      .then(() => handler(req, res, next))
      .catch(() => {
        res.setHeader('Retry-After', '1');
        next(
          Object.assign(new Error(t('认证服务暂时不可用，请稍后重试')), {
            status: 503,
          }),
        );
      });
  };
}
