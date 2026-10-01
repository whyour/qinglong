import { Subscription } from '../data/subscription';
import isNil from 'lodash/isNil';
import { shellQuote } from '../shared/shellQuote';

export function formatUrl(doc: Subscription) {
  let url = doc.url;
  let host = '';
  if (doc.type === 'private-repo') {
    if (doc.pull_type === 'ssh-key') {
      host = doc.url!.replace(/.*\@([^\:]+)\:.*/, '$1');
      url = doc.url!.replace(host, doc.alias);
    } else {
      host = doc.url!.replace(/.*\:\/\/([^\/]+)\/.*/, '$1');
      const { username, password } = doc.pull_option as any;
      url = doc.url!.replace(host, `${username}:${password}@${host}`);
    }
  }
  return { url, host };
}

export function formatCommand(doc: Subscription, url?: string) {
  const args =
    doc.type === 'file'
      ? ['raw', url || formatUrl(doc).url, doc.proxy || '']
      : [
          'repo',
          url || formatUrl(doc).url,
          doc.whitelist || '',
          doc.blacklist || '',
          doc.dependences || '',
          doc.branch || '',
          doc.extensions || '',
          doc.proxy || '',
        ];
  args.push(
    String(isNil(doc.autoAddCron) ? true : Boolean(doc.autoAddCron)),
    String(isNil(doc.autoDelCron) ? true : Boolean(doc.autoDelCron)),
  );
  return `SUB_ID=${shellQuote(String(doc.id))} ql ${args
    .map((arg) => shellQuote(arg!))
    .join(' ')}`;
}
