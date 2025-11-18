import { Service, Inject } from 'typedi';
import winston from 'winston';
import { FindOptions, Op } from 'sequelize';
import { SshKey, SshKeyModel, SshKeyStatus } from '../data/sshKey';
import SshKeyService from './sshKey';

@Service()
export default class GlobalSshKeyService {
  constructor(
    @Inject('logger') private logger: winston.Logger,
    private sshKeyService: SshKeyService,
  ) {}

  public async create(payloads: SshKey[]): Promise<SshKey[]> {
    const docs = await this.insert(payloads);
    await this.applyGlobalSshKeys();
    return docs;
  }

  public async insert(payloads: SshKey[]): Promise<SshKey[]> {
    const result: SshKey[] = [];
    for (const key of payloads) {
      const doc = await SshKeyModel.create(new SshKey(key), { returning: true });
      result.push(doc.get({ plain: true }));
    }
    return result;
  }

  public async update(payload: SshKey): Promise<SshKey> {
    const doc = await this.getDb({ id: payload.id });
    const key = new SshKey({ ...doc, ...payload });
    const newDoc = await this.updateDb(key);
    await this.applyGlobalSshKeys();
    return newDoc;
  }

  private async updateDb(payload: SshKey): Promise<SshKey> {
    await SshKeyModel.update({ ...payload }, { where: { id: payload.id } });
    return await this.getDb({ id: payload.id });
  }

  public async remove(ids: number[]) {
    const docs = await SshKeyModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      const key = doc.get({ plain: true });
      await this.sshKeyService.removeGlobalSSHKey(key.alias);
    }
    await SshKeyModel.destroy({ where: { id: ids } });
  }

  public async list(searchText: string = ''): Promise<SshKey[]> {
    let condition = {};
    if (searchText) {
      const encodeText = encodeURI(searchText);
      const reg = {
        [Op.or]: [
          { [Op.like]: `%${searchText}%` },
          { [Op.like]: `%${encodeText}%` },
        ],
      };

      condition = {
        [Op.or]: [
          {
            alias: reg,
          },
          {
            remarks: reg,
          },
        ],
      };
    }
    try {
      const result = await this.find(condition);
      return result;
    } catch (error) {
      throw error;
    }
  }

  private async find(query: any, sort: any = []): Promise<SshKey[]> {
    const docs = await SshKeyModel.findAll({
      where: { ...query },
      order: [['createdAt', 'DESC'], ...sort],
    });
    return docs.map((x) => x.get({ plain: true }));
  }

  public async getDb(query: FindOptions<SshKey>['where']): Promise<SshKey> {
    const doc: any = await SshKeyModel.findOne({ where: { ...query } });
    if (!doc) {
      throw new Error(`SshKey ${JSON.stringify(query)} not found`);
    }
    return doc.get({ plain: true });
  }

  public async disabled(ids: number[]) {
    const docs = await SshKeyModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      const key = doc.get({ plain: true });
      await this.sshKeyService.removeGlobalSSHKey(key.alias);
    }
    await SshKeyModel.update(
      { status: SshKeyStatus.disabled },
      { where: { id: ids } },
    );
  }

  public async enabled(ids: number[]) {
    await SshKeyModel.update(
      { status: SshKeyStatus.normal },
      { where: { id: ids } },
    );
    await this.applyGlobalSshKeys();
  }

  public async applyGlobalSshKeys() {
    const keys = await this.list();
    for (const key of keys) {
      if (key.status === SshKeyStatus.normal) {
        // For global SSH keys, we generate the key file
        // Git will automatically use keys from ~/.ssh with standard names
        await this.sshKeyService.addGlobalSSHKey(
          key.private_key,
          key.alias,
        );
      }
    }
  }
}
