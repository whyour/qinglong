import { Subscription } from '../data/subscription';
import isNil from 'lodash/isNil';
import { shellEscape } from '../shared/security';

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
  let command = `SUB_ID=${doc.id} ql `;
  let _url = url || formatUrl(doc).url;
  const {
    type,
    whitelist,
    blacklist,
    dependences,
    branch,
    extensions,
    proxy,
    autoAddCron,
    autoDelCron,
  } = doc;
  const addCron = isNil(autoAddCron) ? true : Boolean(autoAddCron);
  const delCron = isNil(autoDelCron) ? true : Boolean(autoDelCron);
  // Every user-controlled value is single-quote escaped so it can never break
  // out of the shell command passed to spawn(command, { shell: '/bin/bash' }).
  if (type === 'file') {
    command += `raw ${shellEscape(_url)} ${shellEscape(
      proxy || '',
    )} "${addCron}" "${delCron}"`;
  } else {
    command += `repo ${shellEscape(_url)} ${shellEscape(
      whitelist || '',
    )} ${shellEscape(blacklist || '')} ${shellEscape(
      dependences || '',
    )} ${shellEscape(branch || '')} ${shellEscape(extensions || '')} ${shellEscape(
      proxy || '',
    )} "${addCron}" "${delCron}"`;
  }
  return command;
}
