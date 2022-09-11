import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import {
  Dependence,
  InstallDependenceCommandTypes,
  DependenceStatus,
  DependenceTypes,
  unInstallDependenceCommandTypes,
  DependenceModel,
} from '../data/dependence';
import _ from 'lodash';
import { spawn } from 'child_process';
import SockService from './sock';
import { Op } from 'sequelize';
import { concurrentRun } from '../config/util';
import dayjs from 'dayjs';

@Service()
export default class DependenceService {
  constructor(
    @Inject('logger') private logger: winston.Logger,
    private sockService: SockService,
  ) {}

  public async create(payloads: Dependence[]): Promise<Dependence[]> {
    const tabs = payloads.map((x) => {
      const tab = new Dependence({ ...x, status: DependenceStatus.installing });
      return tab;
    });
    const docs = await this.insert(tabs);
    this.installDependenceOneByOne(docs);
    return docs;
  }

  public async insert(payloads: Dependence[]): Promise<Dependence[]> {
    const docs = await DependenceModel.bulkCreate(payloads);
    return docs;
  }

  public async update(
    payload: Dependence & { id: string },
  ): Promise<Dependence> {
    const { id, ...other } = payload;
    const doc = await this.getDb({ id });
    const tab = new Dependence({
      ...doc,
      ...other,
      status: DependenceStatus.installing,
    });
    const newDoc = await this.updateDb(tab);
    this.installDependenceOneByOne([newDoc]);
    return newDoc;
  }

  private async updateDb(payload: Dependence): Promise<Dependence> {
    await DependenceModel.update(payload, { where: { id: payload.id } });
    return await this.getDb({ id: payload.id });
  }

  public async remove(ids: number[], force = false): Promise<Dependence[]> {
    await DependenceModel.update(
      { status: DependenceStatus.removing, log: [] },
      { where: { id: ids } },
    );
    const docs = await DependenceModel.findAll({ where: { id: ids } });
    this.installDependenceOneByOne(docs, false, force);
    return docs;
  }

  public async removeDb(ids: number[]) {
    await DependenceModel.destroy({ where: { id: ids } });
  }

  public async dependencies(
    { searchValue, type }: { searchValue: string; type: string },
    sort: any = { position: -1 },
    query: any = {},
  ): Promise<Dependence[]> {
    let condition = { ...query, type: DependenceTypes[type as any] };
    if (searchValue) {
      const encodeText = encodeURIComponent(searchValue);
      const reg = {
        [Op.or]: [
          { [Op.like]: `%${searchValue}%` },
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
      return result as any;
    } catch (error) {
      throw error;
    }
  }

  private installDependenceOneByOne(
    docs: Dependence[],
    isInstall: boolean = true,
    force: boolean = false,
  ) {
    concurrentRun(
      docs.map(
        (dep) => async () =>
          await this.installOrUninstallDependencies([dep], isInstall, force),
      ),
      1,
    );
  }

  public async reInstall(ids: number[]): Promise<Dependence[]> {
    await DependenceModel.update(
      { status: DependenceStatus.installing, log: [] },
      { where: { id: ids } },
    );

    const docs = await DependenceModel.findAll({ where: { id: ids } });
    this.installDependenceOneByOne(docs);
    return docs;
  }

  private async find(query: any, sort: any = []): Promise<Dependence[]> {
    const docs = await DependenceModel.findAll({
      where: { ...query },
      order: [...sort, ['createdAt', 'DESC']],
    });
    return docs;
  }

  public async getDb(query: any): Promise<Dependence> {
    const doc: any = await DependenceModel.findOne({ where: { ...query } });
    return doc && (doc.get({ plain: true }) as Dependence);
  }

  private async updateLog(ids: number[], log: string): Promise<void> {
    const doc = await DependenceModel.findOne({ where: { id: ids } });
    const newLog = doc?.log ? [...doc.log, log] : [log];
    await DependenceModel.update({ log: newLog }, { where: { id: ids } });
  }

  public installOrUninstallDependencies(
    dependencies: Dependence[],
    isInstall: boolean = true,
    force: boolean = false,
  ) {
    return new Promise(async (resolve) => {
      if (dependencies.length === 0) {
        resolve(null);
        return;
      }
      const socketMessageType = !force
        ? 'installDependence'
        : 'uninstallDependence';
      const depNames = dependencies.map((x) => x.name).join(' ');
      const depRunCommand = (
        isInstall
          ? InstallDependenceCommandTypes
          : unInstallDependenceCommandTypes
      )[dependencies[0].type as any];
      const actionText = isInstall ? '安装' : '删除';
      const depIds = dependencies.map((x) => x.id) as number[];
      const startTime = dayjs();

      const message = `开始${actionText}依赖 ${depNames}，开始时间 ${startTime.format(
        'YYYY-MM-DD HH:mm:ss',
      )}\n\n`;
      this.sockService.sendMessage({
        type: socketMessageType,
        message,
        references: depIds,
      });
      await this.updateLog(depIds, message);

      const cp = spawn(`${depRunCommand} ${depNames}`, { shell: '/bin/bash' });

      cp.stdout.on('data', async (data) => {
        this.sockService.sendMessage({
          type: socketMessageType,
          message: data.toString(),
          references: depIds,
        });
        await this.updateLog(depIds, data.toString());
      });

      cp.stderr.on('data', async (data) => {
        this.sockService.sendMessage({
          type: socketMessageType,
          message: data.toString(),
          references: depIds,
        });
        await this.updateLog(depIds, data.toString());
      });

      cp.on('error', async (err) => {
        this.sockService.sendMessage({
          type: socketMessageType,
          message: JSON.stringify(err),
          references: depIds,
        });
        await this.updateLog(depIds, JSON.stringify(err));
        resolve(null);
      });

      cp.on('close', async (code) => {
        const endTime = dayjs();
        const isSucceed = code === 0;
        const resultText = isSucceed ? '成功' : '失败';

        const message = `\n依赖${actionText}${resultText}，结束时间 ${endTime.format(
          'YYYY-MM-DD HH:mm:ss',
        )}，耗时 ${endTime.diff(startTime, 'second')} 秒`;
        this.sockService.sendMessage({
          type: socketMessageType,
          message,
          references: depIds,
        });
        await this.updateLog(depIds, message);

        let status = null;
        if (isSucceed) {
          status = isInstall
            ? DependenceStatus.installed
            : DependenceStatus.removed;
        } else {
          status = isInstall
            ? DependenceStatus.installFailed
            : DependenceStatus.removeFailed;
        }
        await DependenceModel.update({ status }, { where: { id: depIds } });

        // 如果删除依赖成功或者强制删除
        if ((isSucceed || force) && !isInstall) {
          this.removeDb(depIds);
        }

        resolve(null);
      });
    });
  }
}
