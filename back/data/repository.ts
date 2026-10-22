import { database } from '.';
import { DatabaseClient } from './databaseClient';

export type RecordRow<T> = T & { id: number; createdAt: Date; updatedAt: Date };
export type Query = Record<string, any>;
export type ReadOptions = {
  fields?: string[];
  orderBy?: Record<string, string>[];
  limit?: number;
  offset?: number;
};

// A small IPC boundary with MikroORM's native query/operation names. No ORM
// entities or request identity maps escape the single database worker.
export class Repository<T> {
  constructor(
    private name: string,
    private client: () => DatabaseClient = () => database,
  ) {}
  find(where: Query = {}, options: ReadOptions = {}): Promise<RecordRow<T>[]> {
    return this.client().request('find', this.name, where, options);
  }
  findOne(
    where: Query,
    options: ReadOptions = {},
  ): Promise<RecordRow<T> | null> {
    return this.client().request('findOne', this.name, where, options);
  }
  count(where: Query = {}): Promise<number> {
    return this.client().request('count', this.name, where);
  }
  insert(data: Partial<T>): Promise<RecordRow<T>> {
    return this.client().request('insert', this.name, data);
  }
  nativeUpdate(where: Query, data: Partial<T>): Promise<number> {
    return this.client().request('nativeUpdate', this.name, where, data);
  }
  nativeDelete(where: Query): Promise<number> {
    return this.client().request('nativeDelete', this.name, where);
  }
  async insertMany(data: Partial<T>[]): Promise<RecordRow<T>[]> {
    return this.client().transaction(async () => {
      const rows = [];
      for (const item of data) rows.push(await this.insert(item));
      return rows;
    });
  }
  async getOrCreate(where: Query): Promise<RecordRow<T>> {
    return this.client().transaction(
      async () =>
        (await this.findOne(where)) || this.insert(where as Partial<T>),
    );
  }
}
