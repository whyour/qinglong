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
  GetDependenceCommandTypes,
  versionDependenceCommandTypes,
} from '../data/dependence';
import { spawn } from 'cross-spawn';
import SockService from './sock';
import { FindOptions, Op } from 'sequelize';
import { promiseExecSuccess } from '../config/util';
import dayjs from 'dayjs';
import taskLimit from '../shared/pLimit';

@Service()
export default class DependenceService {
  constructor(
    @Inject('logger') private logger: winston.Logger,
    private sockService: SockService,
  ) {}

  public async create(payloads: Dependence[]): Promise<Dependence[]> {
    const tabs = payloads.map((x) => {
      const tab = new Dependence({ ...x, status: DependenceStatus.queued });
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
      status: DependenceStatus.queued,
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
    const docs = await DependenceModel.findAll({ where: { id: ids } });
    const unInstalledDeps = docs.filter(
      (x) => x.status !== DependenceStatus.installed,
    );
    const installedDeps = docs.filter(
      (x) => x.status === DependenceStatus.installed,
    );
    await this.removeDb(unInstalledDeps.map((x) => x.id!));

    if (installedDeps.length) {
      await DependenceModel.update(
        { status: DependenceStatus.queued, log: [] },
        { where: { id: ids } },
      );

      this.installDependenceOneByOne(docs, false, force);
    }
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
      const encodeText = encodeURI(searchValue);
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

  public installDependenceOneByOne(
    docs: Dependence[],
    isInstall: boolean = true,
    force: boolean = false,
  ) {
    docs.forEach((dep) => {
      this.installOrUninstallDependency(dep, isInstall, force);
    });
  }

  public async reInstall(ids: number[]): Promise<Dependence[]> {
    await DependenceModel.update(
      { status: DependenceStatus.queued, log: [] },
      { where: { id: ids } },
    );

    const docs = await DependenceModel.findAll({ where: { id: ids } });
    this.installDependenceOneByOne(docs, true, true);
    return docs;
  }

  private async find(query: any, sort: any = []): Promise<Dependence[]> {
    const docs = await DependenceModel.findAll({
      where: { ...query },
      order: [...sort, ['createdAt', 'DESC']],
    });
    return docs;
  }

  public async getDb(
    query: FindOptions<Dependence>['where'],
  ): Promise<Dependence> {
    const doc: any = await DependenceModel.findOne({ where: { ...query } });
    return doc && (doc.get({ plain: true }) as Dependence);
  }

  private async updateLog(ids: number[], log: string): Promise<void> {
    taskLimit.updateDepLog(async () => {
      const docs = await DependenceModel.findAll({ where: { id: ids } });
      for (const doc of docs) {
        const newLog = doc?.log ? [...doc.log, log] : [log];
        await DependenceModel.update(
          { log: newLog },
          { where: { id: doc.id } },
        );
      }
      return null;
    });
  }

  public installOrUninstallDependency(
    dependency: Dependence,
    isInstall: boolean = true,
    force: boolean = false,
  ) {
    return taskLimit.runOneByOne(() => {
      return new Promise(async (resolve) => {
        const depIds = [dependency.id!];
        const status = isInstall
          ? DependenceStatus.installing
          : DependenceStatus.removing;
        await DependenceModel.update({ status }, { where: { id: depIds } });

        const socketMessageType = isInstall
          ? 'installDependence'
          : 'uninstallDependence';
        let depName = dependency.name.trim();
        const depRunCommand = (
          isInstall
            ? InstallDependenceCommandTypes
            : unInstallDependenceCommandTypes
        )[dependency.type];
        const actionText = isInstall ? '安装' : '删除';
        const startTime = dayjs();

        const message = `开始${actionText}依赖 ${depName}，开始时间 ${startTime.format(
          'YYYY-MM-DD HH:mm:ss',
        )}\n\n`;
        this.sockService.sendMessage({
          type: socketMessageType,
          message,
          references: depIds,
        });
        this.updateLog(depIds, message);

        // 判断是否已经安装过依赖
        if (isInstall && !force) {
          const getCommandPrefix = GetDependenceCommandTypes[dependency.type];
          const depVersionStr = versionDependenceCommandTypes[dependency.type];
          let depVersion = '';
          if (depName.includes(depVersionStr)) {
            const symbolRegx = new RegExp(
              `(.*)${depVersionStr}([0-9\\.\\-\\+a-zA-Z]*)`,
            );
            const [, _depName, _depVersion] = depName.match(symbolRegx) || [];
            if (_depVersion && _depName) {
              depName = _depName;
              depVersion = _depVersion;
            }
          }
          const isNodeDependence = dependency.type === DependenceTypes.nodejs;
          const isLinuxDependence = dependency.type === DependenceTypes.linux;
          const isPythonDependence =
            dependency.type === DependenceTypes.python3;
          const depInfo = (
            await promiseExecSuccess(
              isNodeDependence
                ? `${getCommandPrefix} | grep "${depName}" | head -1`
                : `${getCommandPrefix} ${depName}`,
            )
          )
            .replace(/\s{2,}/, ' ')
            .replace(/\s+$/, '');

          if (
            depInfo &&
            ((isNodeDependence && depInfo.split(' ')?.[0] === depName) ||
              (isLinuxDependence &&
                depInfo.toLocaleLowerCase().includes('installed')) ||
              isPythonDependence) &&
            (!depVersion || depInfo.includes(depVersion))
          ) {
            const endTime = dayjs();
            const _message = `检测到已经安装 ${depName}\n\n${depInfo}\n\n跳过安装\n\n依赖${actionText}成功，结束时间 ${endTime.format(
              'YYYY-MM-DD HH:mm:ss',
            )}，耗时 ${endTime.diff(startTime, 'second')} 秒`;
            this.sockService.sendMessage({
              type: socketMessageType,
              message: _message,
              references: depIds,
            });
            this.updateLog(depIds, _message);
            await DependenceModel.update(
              { status: DependenceStatus.installed },
              { where: { id: depIds } },
            );
            return resolve(null);
          }
        }

        const cp = spawn(`${depRunCommand} ${dependency.name.trim()}`, {
          shell: '/bin/bash',
        });

        cp.stdout.on('data', async (data) => {
          this.sockService.sendMessage({
            type: socketMessageType,
            message: data.toString(),
            references: depIds,
          });
          this.updateLog(depIds, data.toString());
        });

        cp.stderr.on('data', async (data) => {
          this.sockService.sendMessage({
            type: socketMessageType,
            message: data.toString(),
            references: depIds,
          });
          this.updateLog(depIds, data.toString());
        });

        cp.on('error', async (err) => {
          this.sockService.sendMessage({
            type: socketMessageType,
            message: JSON.stringify(err),
            references: depIds,
          });
          this.updateLog(depIds, JSON.stringify(err));
        });

        cp.on('exit', async (code) => {
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
          this.updateLog(depIds, message);

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
    });
  }
}
