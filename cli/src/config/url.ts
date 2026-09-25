import { translate } from '../i18n';
import { fail } from '../errors';

export function panelUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(translate(process.env, '请输入有效的面板 URL。'), 2);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail(
      translate(
        process.env,
        '请使用不含凭据、查询参数或片段的 HTTP(S) 面板 URL。',
      ),
      2,
    );
  }
  if (
    url.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  ) {
    fail(
      translate(process.env, '远程认证需要 HTTPS；HTTP 仅允许回环地址。'),
      2,
    );
  }
  return url.href.replace(/\/+$/, '');
}
