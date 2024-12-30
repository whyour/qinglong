import { Service, Inject } from 'typedi';
import winston from 'winston';
import { createRandomString } from '../config/util';
import { App, AppModel } from '../data/open';
import { v4 as uuidV4 } from 'uuid';
import sequelize, { Op } from 'sequelize';
import { shareStore } from '../shared/store';

@Service()
export default class OpenService {
  constructor(@Inject('logger') private logger: winston.Logger) {}

  public async findApps(): Promise<App[] | null> {
    const docs = await this.find({});
    return docs;
  }

  public async create(payload: App): Promise<App> {
    const tab = { ...payload };
    tab.client_id = createRandomString(12, 12);
    tab.client_secret = createRandomString(24, 24);
    const doc = await this.insert(tab);
    return { ...doc, tokens: [] };
  }

  public async insert(payload: App): Promise<App> {
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
    await AppModel.update(payload, { where: { id: payload.id } });
    const apps = await this.find({});
    await shareStore.updateApps(apps);
    return apps?.find((x) => x.id === payload.id) as App;
  }

  public async getDb(query: Record<string, any>): Promise<App> {
    const doc = await AppModel.findOne({ where: query });
    if (!doc) {
      throw new Error(`App ${JSON.stringify(query)} not found`);
    }
    return doc.get({ plain: true });
  }

  public async remove(ids: number[]) {
    await AppModel.destroy({ where: { id: ids } });
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

  public async authToken({
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
      return {
        code: 200,
        data: {
          token,
          token_type: 'Bearer',
          expiration,
        },
      };
    } else {
      return { code: 400, message: 'client_id或client_seret有误' };
    }
  }

  public async generateSystemToken(): Promise<{
    value: string;
    expiration: number;
  }> {
    let systemApp = (await AppModel.findOne({
      where: { name: 'system' },
    })) as App;
    if (!systemApp) {
      systemApp = await this.create({
        name: 'system',
        scopes: ['crons', 'system'],
      } as App);
    }
    const { data } = await this.authToken({
      client_id: systemApp.client_id,
      client_secret: systemApp.client_secret,
    });
    return {
      ...data,
      value: data.token,
    };
  }
}
