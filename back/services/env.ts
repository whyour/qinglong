import { Service, Inject } from 'typedi';
import winston from 'winston';
import { getFileContentByName } from '../config/util';
import config from '../config';
import * as fs from 'fs';
import DataStore from 'nedb';
import { Env, EnvStatus, initEnvPosition } from '../data/env';
import _ from 'lodash';

@Service()
export default class EnvService {
  private envDb = new DataStore({ filename: config.envDbFile });
  constructor(@Inject('logger') private logger: winston.Logger) {
    this.envDb.loadDatabase((err) => {
      if (err) throw err;
    });
  }

  public getDb(): DataStore {
    return this.envDb;
  }

  public async create(payloads: Env[]): Promise<Env[]> {
    const envs = await this.envs();
    let position = initEnvPosition;
    if (envs && envs.length > 0 && envs[envs.length - 1].position) {
      position = envs[envs.length - 1].position as number;
    }
    const tabs = payloads.map((x) => {
      position = position / 2;
      const tab = new Env({ ...x, position });
      return tab;
    });
    const docs = await this.insert(tabs);
    await this.set_envs();
    return docs;
  }

  public async insert(payloads: Env[]): Promise<Env[]> {
    return new Promise((resolve) => {
      this.envDb.insert(payloads, (err, docs) => {
        if (err) {
          this.logger.error(err);
        } else {
          resolve(docs);
        }
      });
    });
  }

  public async update(payload: Env): Promise<Env> {
    const { _id, ...other } = payload;
    const doc = await this.get(_id);
    const tab = new Env({ ...doc, ...other });
    const newDoc = await this.updateDb(tab);
    await this.set_envs();
    return newDoc;
  }

  private async updateDb(payload: Env): Promise<Env> {
    return new Promise((resolve) => {
      this.envDb.update(
        { _id: payload._id },
        payload,
        { returnUpdatedDocs: true },
        (err, num, doc) => {
          if (err) {
            this.logger.error(err);
          } else {
            resolve(doc as Env);
          }
        },
      );
    });
  }

  public async remove(ids: string[]) {
    return new Promise((resolve: any) => {
      this.envDb.remove({ _id: { $in: ids } }, { multi: true }, async (err) => {
        await this.set_envs();
        resolve();
      });
    });
  }

  public async move(
    _id: string,
    {
      fromIndex,
      toIndex,
    }: {
      fromIndex: number;
      toIndex: number;
    },
  ): Promise<Env> {
    let targetPosition: number;
    const isUpward = fromIndex > toIndex;
    const envs = await this.envs();
    if (toIndex === 0 || toIndex === envs.length - 1) {
      targetPosition = isUpward
        ? envs[0].position * 2
        : envs[toIndex].position / 2;
    } else {
      targetPosition = isUpward
        ? (envs[toIndex].position + envs[toIndex - 1].position) / 2
        : (envs[toIndex].position + envs[toIndex + 1].position) / 2;
    }
    const newDoc = await this.update({
      _id,
      position: targetPosition,
    });
    return newDoc;
  }

  public async envs(
    searchText: string = '',
    sort: any = { position: -1 },
    query: any = {},
  ): Promise<Env[]> {
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
    return newDocs;
  }

  private async find(query: any, sort: any): Promise<Env[]> {
    return new Promise((resolve) => {
      this.envDb
        .find(query)
        .sort({ ...sort })
        .exec((err, docs) => {
          resolve(docs);
        });
    });
  }

  public async get(_id: string): Promise<Env> {
    return new Promise((resolve) => {
      this.envDb.find({ _id }).exec((err, docs) => {
        resolve(docs[0]);
      });
    });
  }

  public async getBySort(sort: any): Promise<Env> {
    return new Promise((resolve) => {
      this.envDb
        .find({})
        .sort({ ...sort })
        .limit(1)
        .exec((err, docs) => {
          resolve(docs[0]);
        });
    });
  }

  public async disabled(ids: string[]) {
    return new Promise((resolve: any) => {
      this.envDb.update(
        { _id: { $in: ids } },
        { $set: { status: EnvStatus.disabled } },
        { multi: true },
        async (err) => {
          await this.set_envs();
          resolve();
        },
      );
    });
  }

  public async enabled(ids: string[]) {
    return new Promise((resolve: any) => {
      this.envDb.update(
        { _id: { $in: ids } },
        { $set: { status: EnvStatus.normal } },
        { multi: true },
        async (err, num) => {
          await this.set_envs();
          resolve();
        },
      );
    });
  }

  public async updateNames({ ids, name }: { ids: string[]; name: string }) {
    return new Promise((resolve: any) => {
      this.envDb.update(
        { _id: { $in: ids } },
        { $set: { name } },
        { multi: true },
        async (err, num) => {
          await this.set_envs();
          resolve();
        },
      );
    });
  }

  public async set_envs() {
    const envs = await this.envs(
      '',
      { position: -1 },
      { name: { $exists: true } },
    );
    const groups = _.groupBy(envs, 'name');
    let env_string = '';
    for (const key in groups) {
      if (Object.prototype.hasOwnProperty.call(groups, key)) {
        const group = groups[key];

        // 忽略不符合bash要求的环境变量名称
        if (/^[a-zA-Z_][0-9a-zA-Z_]+$/.test(key)) {
          env_string += `export ${key}="${_(group)
            .filter((x) => x.status !== EnvStatus.disabled)
            .map('value')
            .join('&')
            .replace(/ /g, '')}"\n`;
        }
      }
    }
    fs.writeFileSync(config.envFile, env_string);
  }
}
