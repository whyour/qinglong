import { EventEmitter } from 'events';
import { database } from '.';
import { DatabaseClient } from './databaseClient';

// Keep the existing Keyv serialization and namespace. Only its SQLite transport
// changes; old cached authentication records remain readable in either version.
export class CacheStore extends EventEmitter {
  readonly opts = { dialect: 'sqlite' };
  namespace?: string;
  constructor(private client: () => DatabaseClient = () => database) {
    super();
  }
  get(key: string): Promise<string | undefined> {
    return this.client().request('cache', 'get', key);
  }
  async set(key: string, value: string) {
    return this.client().request('cache', 'set', key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.client().request('cache', 'delete', key);
  }
  async clear(): Promise<void> {
    throw new Error('Clearing all authentication namespaces is not supported');
  }
  async disconnect(): Promise<void> {
    /* The shared database client owns the worker. */
  }
}
