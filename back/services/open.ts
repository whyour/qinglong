import { Service, Inject } from 'typedi';
import winston from 'winston';
import { createRandomString } from '../config/util';
import { App, AppModel } from '../data/open';
import { v4 as uuidV4 } from 'uuid';
import sequelize, { Op } from 'sequelize';
import { shareStore } from '../shared/store';
import { t } from '../shared/i18n';
import { lock } from 'proper-lockfile';
import path from 'path';
import os from 'os';
import { writeFile, rename, rm, stat, chmod } from 'fs/promises';
import config from '../config';

@Service()
export default class OpenService {
  constructor(@Inject('logger') private logger: winston.Logger) {}

  // Every database mutation and full authentication-cache publication shares
  // this cross-process lock. Lock a separate marker, not token.json itself.
  private async withAppsLock<T>(operation: () => Promise<T>): Promise<T> {
    const target = path.join(config.configPath, '.apps-state');
    const release = await lock(target, {
      realpath: false,
      stale: 10_000,
      retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 3000 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  public async initializeSystemApp(): Promise<void> {
    await this.withAppsLock(async () => {
      const doc = await AppModel.findOne({ where: { name: 'system' } });
      const app = doc?.get({ plain: true });
      if (!app) {
        await this.insert({
          name: 'system',
          scopes: ['crons', 'system', 'dashboard'],
          client_id: createRandomString(12, 12),
          client_secret: createRandomString(24, 24),
        });
      } else if (!app.scopes.includes('dashboard')) {
        await AppModel.update(
          { scopes: [...app.scopes, 'dashboard'] },
          { where: { id: app.id } },
        );
      }
      await shareStore.updateApps(await this.find({}));
    });
  }

  public async refreshApps(): Promise<void> {
    await this.withAppsLock(async () => {
      await shareStore.updateApps(await this.find({}));
    });
  }

  public async findApps(): Promise<App[] | null> {
    const docs = await this.find({});
    return docs;
  }

  public async create(payload: App): Promise<App> {
    return this.withAppsLock(async () => {
      const tab = { ...payload };
      tab.client_id = createRandomString(12, 12);
      tab.client_secret = createRandomString(24, 24);
      const doc = await this.insert(tab);
      const apps = await this.find({});
      await shareStore.updateApps(apps);
      return { ...doc, tokens: [] };
    });
  }

  private async insert(payload: App): Promise<App> {
    const doc = await AppModel.create(payload, { returning: true });
    return doc.get({ plain: true });
  }

  public async update(payload: App): Promise<App> {
    const newDoc = await this.updateDb({
      name: payload.name,
      scopes: payload.scopes,
      id: payload.id,
    } as App);
    return { ...newDoc, tokens: [] };
  }

  private async updateDb(payload: Partial<App>): Promise<App> {
    return this.withAppsLock(async () => {
      await AppModel.update(payload, { where: { id: payload.id } });
      const apps = await this.find({});
      await shareStore.updateApps(apps);
      return apps?.find((x) => x.id === payload.id) as App;
    });
  }

  public async getDb(query: Record<string, any>): Promise<App> {
    const doc = await AppModel.findOne({ where: query });
    if (!doc) {
      throw new Error(`App ${JSON.stringify(query)} not found`);
    }
    return doc.get({ plain: true });
  }

  public async remove(ids: number[]) {
    return this.withAppsLock(async () => {
      await AppModel.destroy({ where: { id: ids } });
      const apps = await this.find({});
      await shareStore.updateApps(apps);
    });
  }

  public async resetSecret(id: number): Promise<App> {
    const tab: Partial<App> = {
      client_secret: createRandomString(24, 24),
      tokens: [],
      id,
    };
    // const doc = await this.get(id);
    // const tab = new App({ ...doc });
    // tab.client_secret = createRandomString(24, 24);
    // tab.tokens = [];
    // const newDoc = await this.updateDb(tab);
    // return newDoc;
    const newDoc = await this.updateDb(tab);
    return newDoc;
  }

  public async list(
    searchText: string = '',
    sort: any = {},
    query: Record<string, any> = {},
  ): Promise<App[]> {
    let condition = { ...query };
    if (searchText) {
      const encodeText = encodeURI(searchText);
      const reg = {
        [Op.or]: [
          { [Op.like]: `%${searchText}%` },
          { [Op.like]: `%${encodeText}%` },
        ],
      };

      condition = {
        ...condition,
        name: reg,
      };
    }
    try {
      const result = await this.find(condition);
      return result
        .filter((x) => x.name !== 'system')
        .map((x) => ({ ...x, tokens: [] }));
    } catch (error) {
      throw error;
    }
  }

  private async find(query: Record<string, any>, sort?: any): Promise<App[]> {
    const docs = await AppModel.findAll({ where: { ...query } });
    return docs.map((x) => x.get({ plain: true }));
  }

  public async authToken(credentials: {
    client_id: string;
    client_secret: string;
  }): Promise<any> {
    return this.withAppsLock(() => this.issueToken(credentials));
  }

  // Caller holds withAppsLock through database update and cache publication.
  private async issueToken({
    client_id,
    client_secret,
  }: {
    client_id: string;
    client_secret: string;
  }): Promise<any> {
    let token = uuidV4();
    const expiration = Math.round(Date.now() / 1000) + 2592000; // 2592000 30天
    const doc = await AppModel.findOne({ where: { client_id, client_secret } });
    if (doc) {
      const timestamp = Math.round(Date.now() / 1000);
      const invalidTokens = (doc.tokens || []).filter(
        (x) => x.expiration >= timestamp,
      );
      let tokens = invalidTokens;
      if (invalidTokens.length >= 5) {
        tokens = [
          ...invalidTokens.slice(0, 4),
          { ...invalidTokens[4], expiration },
        ];
        token = invalidTokens[4].value;
      } else {
        tokens = [...invalidTokens, { value: token, expiration }];
      }
      await AppModel.update(
        { tokens },
        { where: { client_id, client_secret } },
      );
      const apps = await this.find({});
      await shareStore.updateApps(apps);
      return {
        code: 200,
        data: {
          token,
          token_type: 'Bearer',
          expiration,
        },
      };
    } else {
      return { code: 400, message: t('client_id 或 client_seret 有误') };
    }
  }

  public async generateSystemToken(renew = false): Promise<{
    value: string;
    expiration: number;
  }> {
    return this.withAppsLock(async () => {
      // Read after acquiring the lock; a concurrent issuer may have renewed.
      const systemApp = await this.getDb({ name: 'system' });
      const now = Math.round(Date.now() / 1000);
      let appToken = systemApp.tokens
        ?.filter((token) => token.expiration > now)
        .sort((left, right) => right.expiration - left.expiration)[0];
      if (renew || !appToken) {
        const { data } = await this.issueToken({
          client_id: systemApp.client_id,
          client_secret: systemApp.client_secret,
        });
        appToken = { value: data.token, expiration: data.expiration };
      } else {
        // Recover a prior database commit whose cache publication failed.
        await shareStore.updateApps(await this.find({}));
      }
      const tokenFile = path.join(config.configPath, 'token.json');
      const temporaryFile = `${tokenFile}.${process.pid}.tmp`;
      const mode = await stat(tokenFile).then(
        (file) => file.mode & 0o777,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return 0o600;
          throw error;
        },
      );
      try {
        await writeFile(temporaryFile, `${JSON.stringify(appToken)}${os.EOL}`, {
          mode,
        });
        await chmod(temporaryFile, mode);
        // Shell readers see a complete old or new document, never a partial one.
        await rename(temporaryFile, tokenFile);
      } finally {
        await rm(temporaryFile, { force: true });
      }
      return appToken;
    });
  }
}
