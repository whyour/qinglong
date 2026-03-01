import { Service, Inject } from 'typedi';
import winston from 'winston';
import { Scenario, ScenarioModel } from '../data/scenario';
import { FindOptions, Op } from 'sequelize';

@Service()
export default class ScenarioService {
  constructor(@Inject('logger') private logger: winston.Logger) {}

  public async create(payload: Scenario): Promise<Scenario> {
    const scenario = new Scenario(payload);
    const doc = await this.insert(scenario);
    return doc;
  }

  public async insert(payload: Scenario): Promise<Scenario> {
    const result = await ScenarioModel.create(payload, { returning: true });
    return result.get({ plain: true });
  }

  public async update(payload: Scenario): Promise<Scenario> {
    const doc = await this.getDb({ id: payload.id });
    const scenario = new Scenario({ ...doc, ...payload });
    const newDoc = await this.updateDb(scenario);
    return newDoc;
  }

  public async updateDb(payload: Scenario): Promise<Scenario> {
    await ScenarioModel.update(payload, { where: { id: payload.id } });
    return await this.getDb({ id: payload.id });
  }

  public async remove(ids: number[]) {
    await ScenarioModel.destroy({ where: { id: ids } });
  }

  public async list(
    searchText?: string,
    page?: number,
    size?: number,
  ): Promise<{ data: Scenario[]; total: number }> {
    const where: any = {};
    if (searchText) {
      where[Op.or] = [
        { name: { [Op.like]: `%${searchText}%` } },
        { description: { [Op.like]: `%${searchText}%` } },
      ];
    }

    const count = await ScenarioModel.count({ where });
    const data = await ScenarioModel.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: size,
      offset: page && size ? (page - 1) * size : undefined,
    });

    return {
      data: data.map((item) => item.get({ plain: true })),
      total: count,
    };
  }

  public async getDb(
    query: FindOptions<Scenario>['where'],
  ): Promise<Scenario> {
    const doc: any = await ScenarioModel.findOne({ where: { ...query } });
    if (!doc) {
      throw new Error(`Scenario ${JSON.stringify(query)} not found`);
    }
    return doc.get({ plain: true });
  }

  public async disabled(ids: number[]) {
    await ScenarioModel.update({ status: 0 }, { where: { id: ids } });
  }

  public async enabled(ids: number[]) {
    await ScenarioModel.update({ status: 1 }, { where: { id: ids } });
  }
}
