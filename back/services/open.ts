import { Service, Inject } from 'typedi';
import winston from 'winston';
import { createRandomString } from '../config/util';
import config from '../config';
import DataStore from 'nedb';
import { App } from '../data/open';
import { v4 as uuidV4 } from 'uuid';

@Service()
export default class OpenService {
  private appDb = new DataStore({ filename: config.appDbFile });
  constructor(@Inject('logger') private logger: winston.Logger) {
    this.appDb.loadDatabase((err) => {
      if (err) throw err;
    });
  }

  public getDb(): DataStore {
    return this.appDb;
  }

  public async findTokenByValue(token: string): Promise<App> {
    return new Promise((resolve) => {
      this.appDb.find(
        { tokens: { $elemMatch: { value: token } } },
        (err, docs) => {
          if (err) {
            this.logger.error(err);
          } else {
            resolve(docs[0]);
          }
        },
      );
    });
  }

  public async create(payload: App): Promise<App> {
    const tab = new App({ ...payload });
    tab.client_id = createRandomString(12, 12);
    tab.client_secret = createRandomString(24, 24);
    const docs = await this.insert([tab]);
    return { ...docs[0], tokens: [] };
  }

  public async insert(payloads: App[]): Promise<App[]> {
    return new Promise((resolve) => {
      this.appDb.insert(payloads, (err, docs) => {
        if (err) {
          this.logger.error(err);
        } else {
          resolve(docs);
        }
      });
    });
  }

  public async update(payload: App): Promise<App> {
    const { _id, client_id, client_secret, tokens, ...other } = payload;
    const doc = await this.get(_id);
    const tab = new App({ ...doc, ...other });
    const newDoc = await this.updateDb(tab);
    return { ...newDoc, tokens: [] };
  }

  private async updateDb(payload: App): Promise<App> {
    return new Promise((resolve) => {
      this.appDb.update(
        { _id: payload._id },
        payload,
        { returnUpdatedDocs: true },
        (err, num, doc, up) => {
          if (err) {
            this.logger.error(err);
          } else {
            resolve(doc);
          }
        },
      );
    });
  }

  public async remove(ids: string[]) {
    return new Promise((resolve: any) => {
      this.appDb.remove({ _id: { $in: ids } }, { multi: true }, async (err) => {
        resolve();
      });
    });
  }

  public async resetSecret(_id: string): Promise<App> {
    const doc = await this.get(_id);
    const tab = new App({ ...doc });
    tab.client_secret = createRandomString(24, 24);
    tab.tokens = [];
    const newDoc = await this.updateDb(tab);
    return newDoc;
  }

  public async list(
    searchText: string = '',
    sort: any = {},
    query: any = {},
  ): Promise<App[]> {
    let condition = { ...query };
    if (searchText) {
      const reg = new RegExp(searchText);
      condition = {
        $or: [
          {
            value: reg,
          },
          {
            name: reg,
          },
          {
            remarks: reg,
          },
        ],
      };
    }
    const newDocs = await this.find(condition, sort);
    return newDocs.map((x) => ({ ...x, tokens: [] }));
  }

  private async find(query: any, sort: any): Promise<App[]> {
    return new Promise((resolve) => {
      this.appDb
        .find(query)
        .sort({ ...sort })
        .exec((err, docs) => {
          resolve(docs);
        });
    });
  }

  public async get(_id: string): Promise<App> {
    return new Promise((resolve) => {
      this.appDb.find({ _id }).exec((err, docs) => {
        resolve(docs[0]);
      });
    });
  }

  public async authToken({
    client_id,
    client_secret,
  }: {
    client_id: string;
    client_secret: string;
  }): Promise<any> {
    const token = uuidV4();
    const expiration = Math.round(Date.now() / 1000) + 2592000; // 2592000 30天
    return new Promise((resolve) => {
      this.appDb.find({ client_id, client_secret }).exec((err, docs) => {
        if (docs && docs[0]) {
          this.appDb.update(
            { client_id, client_secret },
            { $push: { tokens: { value: token, expiration } } },
            {},
            (err, num, doc) => {
              resolve({
                code: 200,
                data: {
                  token,
                  token_type: 'Bearer',
                  expiration,
                },
              });
            },
          );
        } else {
          resolve({ code: 400, message: 'client_id或client_seret有误' });
        }
      });
    });
  }
}
