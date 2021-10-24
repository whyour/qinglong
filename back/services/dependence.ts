import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import DataStore from 'nedb';
import {
  Dependence,
  InstallDependenceCommandTypes,
  DependenceStatus,
  DependenceTypes,
  unInstallDependenceCommandTypes,
} from '../data/dependence';
import _ from 'lodash';
import { spawn } from 'child_process';
import SockService from './sock';

@Service()
export default class DependenceService {
  private dependenceDb = new DataStore({ filename: config.dependenceDbFile });
  constructor(
    @Inject('logger') private logger: winston.Logger,
    private sockService: SockService,
  ) {
    this.dependenceDb.loadDatabase((err) => {
      if (err) throw err;
    });
  }

  public getDb(): DataStore {
    return this.dependenceDb;
  }

  public async create(payloads: Dependence[]): Promise<Dependence[]> {
    const tabs = payloads.map((x) => {
      const tab = new Dependence({ ...x, status: DependenceStatus.installing });
      return tab;
    });
    const docs = await this.insert(tabs);
    this.installOrUninstallDependencies(docs);
    return docs;
  }

  public async insert(payloads: Dependence[]): Promise<Dependence[]> {
    return new Promise((resolve) => {
      this.dependenceDb.insert(payloads, (err, docs) => {
        if (err) {
          this.logger.error(err);
        } else {
          resolve(docs);
        }
      });
    });
  }

  public async update(
    payload: Dependence & { _id: string },
  ): Promise<Dependence> {
    const { _id, ...other } = payload;
    const doc = await this.get(_id);
    const tab = new Dependence({
      ...doc,
      ...other,
      status: DependenceStatus.installing,
    });
    const newDoc = await this.updateDb(tab);
    this.installOrUninstallDependencies([newDoc]);
    return newDoc;
  }

  private async updateDb(payload: Dependence): Promise<Dependence> {
    return new Promise((resolve) => {
      this.dependenceDb.update(
        { _id: payload._id },
        payload,
        { returnUpdatedDocs: true },
        (err, num, doc) => {
          if (err) {
            this.logger.error(err);
          } else {
            resolve(doc as Dependence);
          }
        },
      );
    });
  }

  public async remove(ids: string[]) {
    return new Promise((resolve: any) => {
      this.dependenceDb.update(
        { _id: { $in: ids } },
        { $set: { status: DependenceStatus.removing, log: [] } },
        { multi: true, returnUpdatedDocs: true },
        async (err, num, docs: Dependence[]) => {
          this.installOrUninstallDependencies(docs, false);
          resolve(docs);
        },
      );
    });
  }

  public async removeDb(ids: string[]) {
    return new Promise((resolve: any) => {
      this.dependenceDb.remove(
        { _id: { $in: ids } },
        { multi: true },
        async (err) => {
          resolve();
        },
      );
    });
  }

  public async dependencies(
    { searchValue, type }: { searchValue: string; type: string },
    sort: any = { position: -1 },
    query: any = {},
  ): Promise<Dependence[]> {
    let condition = { ...query, type: DependenceTypes[type as any] };
    if (searchValue) {
      const reg = new RegExp(searchValue);
      condition = {
        ...condition,
        $or: [
          {
            name: reg,
          },
        ],
      };
    }
    const newDocs = await this.find(condition, sort);
    return newDocs;
  }

  public async reInstall(ids: string[]): Promise<Dependence[]> {
    return new Promise((resolve: any) => {
      this.dependenceDb.update(
        { _id: { $in: ids } },
        { $set: { status: DependenceStatus.installing, log: [] } },
        { multi: true, returnUpdatedDocs: true },
        async (err, num, docs: Dependence[]) => {
          this.installOrUninstallDependencies(docs);
          resolve(docs);
        },
      );
    });
  }

  private async find(query: any, sort: any): Promise<Dependence[]> {
    return new Promise((resolve) => {
      this.dependenceDb
        .find(query)
        .sort({ ...sort })
        .exec((err, docs) => {
          resolve(docs);
        });
    });
  }

  public async get(_id: string): Promise<Dependence> {
    return new Promise((resolve) => {
      this.dependenceDb.find({ _id }).exec((err, docs) => {
        resolve(docs[0]);
      });
    });
  }

  private async updateLog(ids: string[], log: string): Promise<void> {
    return new Promise((resolve) => {
      this.dependenceDb.update(
        { _id: { $in: ids } },
        { $push: { log } },
        { multi: true },
        (err, num, doc) => {
          if (err) {
            this.logger.error(err);
          } else {
            resolve();
          }
        },
      );
    });
  }

  public installOrUninstallDependencies(
    dependencies: Dependence[],
    isInstall: boolean = true,
  ) {
    if (dependencies.length === 0) {
      return;
    }
    const depNames = dependencies.map((x) => x.name).join(' ');
    const depRunCommand = (
      isInstall
        ? InstallDependenceCommandTypes
        : unInstallDependenceCommandTypes
    )[dependencies[0].type as any];
    const actionText = isInstall ? '安装' : '删除';
    const depIds = dependencies.map((x) => x._id) as string[];
    const cp = spawn(`${depRunCommand} ${depNames}`, { shell: '/bin/bash' });
    const startTime = Date.now();
    this.sockService.sendMessage({
      type: 'installDependence',
      message: `开始${actionText}依赖 ${depNames}，开始时间 ${new Date(
        startTime,
      ).toLocaleString()}`,
      references: depIds,
    });
    this.updateLog(
      depIds,
      `开始${actionText}依赖 ${depNames}，开始时间 ${new Date(
        startTime,
      ).toLocaleString()}\n`,
    );
    cp.stdout.on('data', (data) => {
      this.sockService.sendMessage({
        type: 'installDependence',
        message: data.toString(),
        references: depIds,
      });
      this.updateLog(depIds, data.toString());
    });

    cp.stderr.on('data', (data) => {
      this.sockService.sendMessage({
        type: 'installDependence',
        message: data.toString(),
        references: depIds,
      });
      this.updateLog(depIds, data.toString());
    });

    cp.on('error', (err) => {
      this.sockService.sendMessage({
        type: 'installDependence',
        message: JSON.stringify(err),
        references: depIds,
      });
      this.updateLog(depIds, JSON.stringify(err));
    });

    cp.on('close', (code) => {
      const endTime = Date.now();
      const isSucceed = code === 0;
      const resultText = isSucceed ? '成功' : '失败';

      this.sockService.sendMessage({
        type: 'installDependence',
        message: `依赖${actionText}${resultText}，结束时间 ${new Date(
          endTime,
        ).toLocaleString()}，耗时 ${(endTime - startTime) / 1000} 秒`,
        references: depIds,
      });
      this.updateLog(
        depIds,
        `依赖${actionText}${resultText}，结束时间 ${new Date(
          endTime,
        ).toLocaleString()}，耗时 ${(endTime - startTime) / 1000} 秒`,
      );

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
      this.dependenceDb.update(
        { _id: { $in: depIds } },
        {
          $set: { status },
          $unset: { pid: true },
        },
        { multi: true },
      );

      // 如果删除依赖成功，3秒后删除数据库记录
      if (isSucceed && !isInstall) {
        setTimeout(() => {
          this.removeDb(depIds);
        }, 5000);
      }
    });
  }
}
