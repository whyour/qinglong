import { AuthInfo } from '../data/system';
import { App } from '../data/open';
import Keyv from 'keyv';
import KeyvSqlite from '@keyv/sqlite';
import config from '../config';
import path from 'path';

export enum EKeyv {
  'apps' = 'apps',
  'authInfo' = 'authInfo',
  'lang' = 'lang',
}

export interface IKeyvStore {
  apps: App[];
  authInfo: AuthInfo;
  lang: string;
}

const keyvSqlite = new KeyvSqlite(path.join(config.dbPath, 'keyv.sqlite'));
export const keyvStore = new Keyv<IKeyvStore>({ store: keyvSqlite });

export const shareStore = {
  getAuthInfo() {
    return keyvStore.get<IKeyvStore['authInfo']>(EKeyv.authInfo);
  },
  updateAuthInfo(value: IKeyvStore['authInfo']) {
    return keyvStore.set<IKeyvStore['authInfo']>(EKeyv.authInfo, value);
  },
  getApps() {
    return keyvStore.get<IKeyvStore['apps']>(EKeyv.apps);
  },
  updateApps(apps: App[]) {
    return keyvStore.set<IKeyvStore['apps']>(EKeyv.apps, apps);
  },
  getLang() {
    return keyvStore.get<IKeyvStore['lang']>(EKeyv.lang);
  },
  setLang(value: IKeyvStore['lang']) {
    return keyvStore.set<IKeyvStore['lang']>(EKeyv.lang, value);
  },
};
