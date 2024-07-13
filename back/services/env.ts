import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import * as fs from 'fs/promises';
import {
  Env,
  EnvModel,
  EnvStatus,
  initPosition,
  maxPosition,
  minPosition,
  stepPosition,
} from '../data/env';
import groupBy from 'lodash/groupBy';
import { FindOptions, Op } from 'sequelize';

@Service()
export default class EnvService {
  constructor(@Inject('logger') private logger: winston.Logger) {}

  public async create(payloads: Env[]): Promise<Env[]> {
    const envs = await this.envs();
    let position = initPosition;
    if (
      envs &&
      envs.length > 0 &&
      typeof envs[envs.length - 1].position === 'number'
    ) {
      position = envs[envs.length - 1].position!;
    }
    const tabs = payloads.map((x) => {
      position = position - stepPosition;
      const tab = new Env({ ...x, position });
      return tab;
    });
    const docs = await this.insert(tabs);
    await this.set_envs();
    await this.checkPosition(tabs[tabs.length - 1].position!);
    return docs;
  }

  public async insert(payloads: Env[]): Promise<Env[]> {
    const result = [];
    for (const env of payloads) {
      const doc = await EnvModel.create(env, { returning: true });
      result.push(doc);
    }
    return result;
  }

  public async update(payload: Env): Promise<Env> {
    const doc = await this.getDb({ id: payload.id });
    const tab = new Env({ ...doc, ...payload });
    const newDoc = await this.updateDb(tab);
    await this.set_envs();
    return newDoc;
  }

  private async updateDb(payload: Env): Promise<Env> {
    await EnvModel.update({ ...payload }, { where: { id: payload.id } });
    return await this.getDb({ id: payload.id });
  }

  public async remove(ids: string[]) {
    await EnvModel.destroy({ where: { id: ids } });
    await this.set_envs();
  }

  public async move(
    id: number,
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
        ? envs[0].position! + stepPosition
        : envs[toIndex].position! - stepPosition;
    } else {
      targetPosition = isUpward
        ? (envs[toIndex].position! + envs[toIndex - 1].position!) / 2
        : (envs[toIndex].position! + envs[toIndex + 1].position!) / 2;
    }

    const newDoc = await this.update({
      id,
      position: this.getPrecisionPosition(targetPosition),
    });

    await this.checkPosition(targetPosition, envs[toIndex].position!);
    return newDoc;
  }

  private async checkPosition(position: number, edge: number = 0) {
    const precisionPosition = parseFloat(position.toPrecision(16));
    if (
      precisionPosition < minPosition ||
      precisionPosition > maxPosition ||
      Math.abs(precisionPosition - edge) < minPosition
    ) {
      const envs = await this.envs();
      let position = initPosition;
      for (const env of envs) {
        position = position - stepPosition;
        await this.updateDb({ id: env.id, position });
      }
    }
  }

  private getPrecisionPosition(position: number): number {
    return parseFloat(position.toPrecision(16));
  }

  public async envs(searchText: string = '', query: any = {}): Promise<Env[]> {
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
        [Op.or]: [
          {
            name: reg,
          },
          {
            value: reg,
          },
          {
            remarks: reg,
          },
        ],
      };
    }
    try {
      const result = await this.find(condition, [
        ['position', 'DESC'],
        ['createdAt', 'ASC'],
      ]);
      return result as any;
    } catch (error) {
      throw error;
    }
  }

  private async find(query: any, sort: any = []): Promise<Env[]> {
    const docs = await EnvModel.findAll({
      where: { ...query },
      order: [...sort],
    });
    return docs;
  }

  public async getDb(query: FindOptions<Env>['where']): Promise<Env> {
    const doc: any = await EnvModel.findOne({ where: { ...query } });
    if (!doc) {
      throw new Error(`Env ${JSON.stringify(query)} not found`);
    }
    return doc.get({ plain: true });
  }

  public async disabled(ids: string[]) {
    await EnvModel.update(
      { status: EnvStatus.disabled },
      { where: { id: ids } },
    );
    await this.set_envs();
  }

  public async enabled(ids: string[]) {
    await EnvModel.update({ status: EnvStatus.normal }, { where: { id: ids } });
    await this.set_envs();
  }

  public async updateNames({ ids, name }: { ids: string[]; name: string }) {
    await EnvModel.update({ name }, { where: { id: ids } });
    await this.set_envs();
  }

  public async set_envs() {
    const envs = await this.envs('', {
      name: { [Op.not]: null },
      status: EnvStatus.normal,
    });
    const groups = groupBy(envs, 'name');
    let env_string = '';
    let js_env_string = '';
    let py_env_string = 'import os\n';
    for (const key in groups) {
      if (Object.prototype.hasOwnProperty.call(groups, key)) {
        const group = groups[key];

        // 忽略不符合bash要求的环境变量名称
        if (/^[a-zA-Z_][0-9a-zA-Z_]*$/.test(key)) {
          let value = group
            .map((x) => x.value)
            .join('&')
            .replace(/'/g, "'\\''")
            .trim();
          env_string += `export ${key}='${value}'\n`;
          const _env_value = `${group
            .map((x) => x.value)
            .join('&')
            .replace(/\\/g, '\\\\')}`;
          js_env_string += `process.env.${key}=\`${_env_value.replace(
            /\`/g,
            '\\`',
          )}\`;\n`;
          py_env_string += `os.environ['${key}']='''${_env_value.replace(
            /\'/g,
            "\\'",
          )}'''\n`;
        }
      }
    }
    await fs.writeFile(config.envFile, env_string);
    await fs.writeFile(config.jsEnvFile, js_env_string);
    await fs.writeFile(config.pyEnvFile, py_env_string);
  }
}
